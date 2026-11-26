# Kit: transformar o site em aplicativo (PWA) + notificações no celular (Web Push) + central de notificações

> **Para o assistente que receber este arquivo:** isto é uma especificação com código de referência, tirada de um projeto onde
> tudo isto já funciona em produção (Android e iPhone). **Não copie às cegas.** Antes de escrever qualquer coisa:
>
> 1. Leia o projeto atual e descubra: linguagem/framework do front, onde roda o back-end (Node, Cloudflare Workers/Pages,
>    Deno/Supabase Edge Functions, Vercel, PHP etc.), qual banco usa, como funciona o login/sessão, como as rotas de API são
>    escritas, se já existe service worker/manifest, e como o projeto roda tarefas agendadas (cron).
> 2. Mostre ao usuário um plano curto de **onde** cada peça vai entrar naquele projeto e **o que** precisa ser decidido por ele
>    (ver "Perguntas para o usuário" no fim). Só então implemente.
> 3. Adapte nomes, estilo de código, idioma da interface, cores e estrutura de pastas ao projeto. As regras de negócio dos
>    avisos (o que dispara uma notificação) **são do outro projeto** e devem ser definidas com o usuário.
> 4. **Nunca** escreva chaves privadas, senhas ou tokens em arquivos do repositório nem os mostre no chat. A chave privada VAPID
>    vai só para os segredos/variáveis de ambiente do servidor.

---

## 1. O que vai ser entregue

| Parte | O que faz |
|---|---|
| **PWA (aplicativo)** | `manifest.json` + ícones + metatags + service worker. O usuário instala pelo navegador ("Instalar app" no Android/Chrome, "Adicionar à Tela de Início" no iPhone/Safari) e o site abre em tela cheia, com ícone próprio, como um app. |
| **Web Push** | O celular recebe notificações **mesmo com o app fechado**. Sem Firebase e sem biblioteca: só WebCrypto (padrões VAPID RFC 8292 + cifragem aes128gcm RFC 8291), que funciona em Node 18+, Cloudflare Workers, Deno e navegadores. |
| **Inscrição por aparelho** | Botão "Ativar neste aparelho", "Enviar teste" e "Desativar"; lista dos aparelhos do usuário; limpeza automática de aparelhos que cancelaram. |
| **Central de notificações (sino)** | Regras configuráveis (tipo de aviso, condição, mensagem com variáveis, nível, para quem, de quanto em quanto tempo repete, se vai também para o celular). O mesmo motor de regras roda no navegador (sino) e no servidor (envio para o celular). |
| **Envio agendado** | Tarefa a cada X minutos que avalia as regras marcadas "celular", decide o que mandar para quem (sem repetir antes da hora) e envia. |

Fluxo:

```
[Navegador/App] --(1) pede permissão + pushManager.subscribe(chave pública VAPID)--> [Serviço de push do Google/Apple/Mozilla]
[Navegador/App] --(2) POST /api/push {inscrever, endpoint, p256dh, auth}--> [Seu servidor] --> tabela push_inscricoes
[Tarefa agendada] --(3) avalia regras --> cifra a mensagem para cada aparelho --> POST no endpoint com JWT VAPID
[Serviço de push] --(4)--> [Service worker do aparelho] --> showNotification() --> toque abre a tela certa
```

---

## 2. Requisitos e limitações (importante explicar ao usuário)

- **HTTPS obrigatório** (localhost é exceção para testes).
- **iPhone/iPad:** só recebe push com **iOS 16.4 ou mais novo** e **com o site adicionado à Tela de Início** e aberto pelo ícone.
  No Safari comum não existe `PushManager`. O pedido de permissão **tem que sair de um toque do usuário** (clique no botão),
  nunca automático ao abrir a página.
- **Android:** funciona no Chrome (instalado ou não), mas a recomendação é deixar a ativação **só dentro do app instalado**
  (foi o que o usuário original pediu: no navegador do celular aparece só a explicação de como instalar; no computador o bloco
  nem aparece). Isso evita o pedido de permissão em cima do conteúdo no navegador.
- **Ícone pequeno da barra do Android (`badge`)**: o Android usa só a **silhueta** (canal alfa) dessa imagem. Se for um PNG opaco
  (ex.: o ícone do app com fundo), aparece **um quadrado branco**. Use um PNG **96×96, desenho branco em fundo transparente**
  (o símbolo/logo da marca, sem fundo).
- Cada aparelho tem sua inscrição (endpoint). Um usuário pode ter vários aparelhos (limite sugerido: 10).
- O serviço de push responde **404 ou 410** quando a inscrição acabou (app desinstalado, permissão revogada): apague a inscrição.
- Mudou o service worker? **Troque a versão do cache** (`CACHE_NAME`) para os aparelhos pegarem a versão nova; o usuário pode
  precisar fechar e abrir o app uma vez.

---

## 3. PWA

### 3.1 `manifest.json` (na raiz pública)

```json
{
  "id": "/",
  "name": "Nome completo do app",
  "short_name": "Nome curto",
  "description": "Uma frase sobre o app",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#161616",
  "theme_color": "#161616",
  "orientation": "portrait",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" }
  ]
}
```

- Se o projeto tiver duas áreas (ex.: área do cliente e área administrativa), pode haver dois manifests com `id` e `start_url`
  diferentes (ex.: `/manifest-admin.json` com `"start_url": "/admin/"`), cada página apontando para o seu.
- Cores: use as do projeto.
- Ícones: 192 e 512 px, PNG. Opcional: um 512 com `"purpose": "maskable"` (desenho com margem de segurança de ~20%).

### 3.2 No `<head>` de cada página que pode virar app

```html
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#161616">
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon-192.png">
<link rel="apple-touch-icon" href="/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Nome curto">
```

### 3.3 Registrar o service worker (em um JS carregado em todas as páginas)

```js
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
```

O arquivo `sw.js` precisa ficar **na raiz** (escopo `/`) para controlar o site todo.

### 3.4 `sw.js` (cache + push + clique)

Adapte `SHELL_FILES` (só arquivos estáticos que existem; um que falta quebra a instalação), as rotas que **não** podem ir para o
cache (API, áreas logadas, páginas que dependem da sessão) e a URL padrão do clique.

```js
const CACHE_NAME = 'app-v1';   // troque a cada mudança no sw.js ou nos arquivos do shell
const SHELL_FILES = ['/manifest.json', '/icon-192.png', '/icon-512.png' /* , '/app.css', '/app.js' ... */];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((ns) => Promise.all(ns.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') /* || url.pathname.startsWith('/admin') */) return;   // nunca do cache
  if (url.pathname.endsWith('.png') || url.pathname.endsWith('manifest.json')) {            // quase nunca mudam
    event.respondWith(caches.match(req).then((c) => c || fetch(req)));
    return;
  }
  // resto: rede primeiro; sem internet, o que ficou salvo
  event.respondWith(fetch(req).then((resp) => {
    if (resp.ok) { const copia = resp.clone(); caches.open(CACHE_NAME).then((c) => c.put(url.pathname, copia)); }
    return resp;
  }).catch(() => caches.match(url.pathname)));
});

// Push: conteúdo {titulo, texto, url, tag, nivel}. tag = identifica a ocorrência (o mesmo aviso substitui o anterior, não empilha)
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { texto: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.titulo || 'Nome do app', {
    body: d.texto || '',
    icon: '/icon-192.png',
    badge: '/badge-96.png',            // branco + transparente (senão vira quadrado branco no Android)
    tag: d.tag || undefined,
    renotify: !!d.tag,
    requireInteraction: d.nivel === 'critico',
    data: { url: d.url || '/' },
  }));
});

// Toque: abre a tela do aviso, reaproveitando uma janela do app já aberta
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const alvo = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  if (alvo.origin !== self.location.origin) return;   // nunca abrir site de fora
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
    for (const j of janelas) {
      if ('focus' in j) return j.focus().then((f) => (f && 'navigate' in f ? f.navigate(alvo.href) : f));
    }
    return self.clients.openWindow(alvo.href);
  }));
});
```

---

## 4. Chaves VAPID (uma vez, por ambiente)

Gere com a função `gerarVapid()` do arquivo da seção 5 (rode num script local com Node 18+) e guarde:

- `VAPID_PUBLICA`: texto base64url (65 bytes). Pode ir para o navegador.
- `VAPID_PRIVADA`: JWK em texto JSON. **Segredo.** Só nas variáveis de ambiente/segredos do servidor e da tarefa agendada.
- `VAPID_ASSUNTO` (opcional): `https://seu-dominio` ou `mailto:contato@...` (identifica quem envia; usado no JWT).

Script de exemplo (rodar localmente, gravar a saída num arquivo **fora do repositório** e cadastrar como segredo):

```js
// gerar-vapid.mjs  ->  node gerar-vapid.mjs > %LOCALAPPDATA%\MeuApp\vapid.json   (ou ~/.config/meuapp/vapid.json)
import { gerarVapid } from './webpush.js';
console.log(JSON.stringify(await gerarVapid()));
```

Trocar a chave invalida as inscrições antigas (o cliente da seção 7 detecta e refaz a inscrição automaticamente).

---

## 5. Biblioteca de envio `webpush.js` (servidor; sem dependências)

Funciona igual em Node 18+, Cloudflare Workers/Pages Functions, Deno/Supabase Edge Functions e Bun. Se o back-end for em outra
linguagem (PHP, Python, Java...), use a biblioteca Web Push consolidada daquela linguagem (ex.: `minishlink/web-push` no PHP,
`pywebpush` no Python) com as mesmas chaves, e mantenha o resto desta especificação.

```js
// Web Push sem biblioteca: VAPID (RFC 8292, JWT ES256) + conteúdo cifrado (RFC 8291, aes128gcm). Só WebCrypto.
const te = new TextEncoder();
export function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function deB64url(txt) {
  const s = String(txt).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function juntar(...partes) {
  const out = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of partes) { out.set(p, i); i += p.length; }
  return out;
}
async function hmac(chave, dados) {
  const k = await crypto.subtle.importKey('raw', chave, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, dados));
}

// par de chaves novo: {publica (base64url, vai para o navegador), privada (JWK em texto, SEGREDO)}
export async function gerarVapid() {
  const par = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { publica: b64url(await crypto.subtle.exportKey('raw', par.publicKey)),
    privada: JSON.stringify(await crypto.subtle.exportKey('jwk', par.privateKey)) };
}

// cabeçalho Authorization para o serviço de push do endpoint. vapid = {publica, privada, assunto}
export async function cabecalhoVapid(endpoint, vapid, agoraS = Math.floor(Date.now() / 1000)) {
  const jwk = typeof vapid.privada === 'string' ? JSON.parse(vapid.privada) : vapid.privada;
  const chave = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const cab = b64url(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const corpo = b64url(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: agoraS + 12 * 3600, sub: vapid.assunto })));
  const assinatura = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, chave, te.encode(cab + '.' + corpo));
  return 'vapid t=' + cab + '.' + corpo + '.' + b64url(assinatura) + ', k=' + vapid.publica;
}

// cifra o texto para uma inscrição {p256dh, auth}. opcoes.sal/opcoes.par só em testes
export async function cifrar(texto, inscricao, opcoes = {}) {
  const uaPublica = deB64url(inscricao.p256dh), auth = deB64url(inscricao.auth);
  const par = opcoes.par || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublica = new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey));
  const ua = await crypto.subtle.importKey('raw', uaPublica, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const segredo = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, par.privateKey, 256));
  const prkChave = await hmac(auth, segredo);
  const ikm = await hmac(prkChave, juntar(te.encode('WebPush: info\0'), uaPublica, asPublica, new Uint8Array([1])));
  const sal = opcoes.sal || crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(sal, ikm);
  const cek = (await hmac(prk, juntar(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, juntar(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const k = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, juntar(te.encode(texto), new Uint8Array([2]))));
  return juntar(sal, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPublica.length]), asPublica, cifrado);
}

// envia {titulo, texto, url, tag, nivel} para {endpoint, p256dh, auth} -> {status, ok, expirada}
// expirada (404/410) = o aparelho cancelou: quem chamou apaga a inscrição
export async function enviarPush(inscricao, mensagem, vapid, { ttl = 24 * 3600, urgencia = 'normal', fetchFn = fetch } = {}) {
  const corpo = await cifrar(JSON.stringify(mensagem), inscricao);
  const r = await fetchFn(inscricao.endpoint, {
    method: 'POST',
    headers: { Authorization: await cabecalhoVapid(inscricao.endpoint, vapid), 'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: urgencia },
    body: corpo,
  });
  return { status: r.status, ok: r.status >= 200 && r.status < 300, expirada: r.status === 404 || r.status === 410 };
}

// só aceitar endpoints dos serviços de push dos navegadores (evita o servidor ser usado para fazer POST em qualquer lugar)
export const SERVICOS_PUSH = /^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)\//i;
export const endpointValido = (e) => typeof e === 'string' && e.length <= 1000 && SERVICOS_PUSH.test(e);
```

Mensagem: mantenha o JSON pequeno (o limite prático é ~3 KB depois de cifrado). `urgencia`: `'high'` para avisos críticos,
`'normal'` no resto. `ttl`: quanto tempo o serviço guarda a mensagem se o aparelho estiver desligado (12–24 h é bom).

---

## 6. Banco e API de inscrição

### 6.1 Tabela (adapte ao banco do projeto: SQLite/D1, Postgres, MySQL...)

```sql
CREATE TABLE push_inscricoes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,   -- Postgres: bigserial / identity
  usuario_id    INTEGER NOT NULL REFERENCES usuarios(id),
  endpoint      TEXT NOT NULL UNIQUE,                -- endereço do serviço de push do navegador
  p256dh        TEXT NOT NULL,                       -- chave pública do aparelho
  auth          TEXT NOT NULL,                       -- segredo de autenticação do aparelho
  aparelho      TEXT,                                -- descrição curta ("iPhone", "Android · Chrome")
  criado_em     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ultimo_envio  TEXT
);
CREATE INDEX idx_push_inscricoes_usuario ON push_inscricoes (usuario_id);
```

Se o projeto espelha tabelas para outro banco/BI, **não espelhe esta** (são chaves do aparelho).
Se usar Supabase/Postgres com RLS: tabela sem acesso público; só o servidor (service role) lê e grava.

### 6.2 Rota `/api/push` (exige usuário logado; use o mecanismo de sessão do projeto)

| Método | Corpo | Resposta |
|---|---|---|
| `GET` | — | `{chave: VAPID_PUBLICA ou null, aparelhos: [{id, aparelho, criado_em, ultimo_envio, endpoint}]}` (só os do usuário) |
| `POST` | `{acao:'inscrever', inscricao: <subscription.toJSON()>, aparelho}` | `{ok:true}` |
| `POST` | `{acao:'cancelar', endpoint}` | `{ok:true}` (só apaga se for do usuário) |
| `POST` | `{acao:'testar', endpoint?}` | manda "Teste de notificação" para este aparelho (ou todos do usuário) |

Regras:

- Recusar `POST` com cabeçalho `Origin` diferente do próprio site (403).
- Validar: `endpointValido(endpoint)`; `p256dh` base64url com 80–100 caracteres; `auth` base64url com 16–30 caracteres;
  `aparelho` limpo (só letras, números, espaço e `·().,-`, até 60 caracteres).
- Limite de aparelhos por usuário (ex.: 10), sem contar o próprio endpoint que está sendo reinscrito.
- `inscrever` é *upsert* pelo `endpoint`: o mesmo aparelho passa para o último usuário que ativou nele.
- `testar`: se o envio der `expirada`, apagar a inscrição; se der certo, gravar `ultimo_envio`. Sem nenhum envio aceito,
  responder erro pedindo para desativar e ativar de novo.
- Se `VAPID_PUBLICA`/`VAPID_PRIVADA` não estiverem configuradas, `GET` devolve `chave: null` (a interface esconde o bloco) e
  `testar` responde 503.

Exemplo (estilo Cloudflare Pages Functions + D1; troque `usuarioDaSessao`, `json` e `env.DB` pelos do projeto):

```js
import { enviarPush, endpointValido } from '../lib/webpush.js';
const MAX_APARELHOS = 10;
const b64ok = (s, min, max) => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s) && s.length >= min && s.length <= max;
const vapidDo = (env, origem) => (env.VAPID_PUBLICA && env.VAPID_PRIVADA
  ? { publica: env.VAPID_PUBLICA, privada: env.VAPID_PRIVADA, assunto: env.VAPID_ASSUNTO || origem } : null);

export function validarInscricao(d) {
  const i = d && d.inscricao, k = i && i.keys;
  if (!i || !endpointValido(i.endpoint)) return { erro: 'Inscrição do aparelho inválida.' };
  if (!k || !b64ok(k.p256dh, 80, 100) || !b64ok(k.auth, 16, 30)) return { erro: 'Chaves do aparelho inválidas.' };
  const aparelho = String((d && d.aparelho) || '').replace(/[^\p{L}\p{N} ·().,-]/gu, '').trim().slice(0, 60) || null;
  return { valor: { endpoint: i.endpoint, p256dh: k.p256dh, auth: k.auth, aparelho } };
}

export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  const { results } = await env.DB.prepare('SELECT id, aparelho, criado_em, ultimo_envio, endpoint FROM push_inscricoes WHERE usuario_id = ? ORDER BY id').bind(u.id).all();
  return json({ chave: env.VAPID_PUBLICA || null, aparelhos: results });
}

export async function onRequestPost({ request, env }) {
  const origem = new URL(request.url).origin, o = request.headers.get('Origin');
  if (o && o !== origem) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  let d; try { d = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }

  if (d.acao === 'inscrever') {
    const v = validarInscricao(d);
    if (v.erro) return json({ erro: v.erro }, 400);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_inscricoes WHERE usuario_id = ? AND endpoint <> ?').bind(u.id, v.valor.endpoint).first();
    if (n && n.n >= MAX_APARELHOS) return json({ erro: 'Limite de ' + MAX_APARELHOS + ' aparelhos. Desative um aparelho antigo antes.' }, 400);
    await env.DB.prepare(`INSERT INTO push_inscricoes (usuario_id, endpoint, p256dh, auth, aparelho) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET usuario_id = excluded.usuario_id, p256dh = excluded.p256dh, auth = excluded.auth, aparelho = excluded.aparelho`)
      .bind(u.id, v.valor.endpoint, v.valor.p256dh, v.valor.auth, v.valor.aparelho).run();
    return json({ ok: true });
  }
  if (d.acao === 'cancelar') {
    if (typeof d.endpoint !== 'string') return json({ erro: 'Aparelho inválido.' }, 400);
    await env.DB.prepare('DELETE FROM push_inscricoes WHERE usuario_id = ? AND endpoint = ?').bind(u.id, d.endpoint).run();
    return json({ ok: true });
  }
  if (d.acao === 'testar') {
    const vapid = vapidDo(env, origem);
    if (!vapid) return json({ erro: 'As notificações no celular ainda não foram configuradas no servidor.' }, 503);
    const { results } = typeof d.endpoint === 'string'
      ? await env.DB.prepare('SELECT id, endpoint, p256dh, auth FROM push_inscricoes WHERE usuario_id = ? AND endpoint = ?').bind(u.id, d.endpoint).all()
      : await env.DB.prepare('SELECT id, endpoint, p256dh, auth FROM push_inscricoes WHERE usuario_id = ?').bind(u.id).all();
    if (!results.length) return json({ erro: 'Este aparelho não está com as notificações ativadas.' }, 404);
    const msg = { titulo: 'Teste de notificação', texto: 'Tudo certo: este aparelho recebe as notificações.', url: '/', tag: 'teste', nivel: 'info' };
    let enviados = 0;
    for (const i of results) {
      const r = await enviarPush(i, msg, vapid, { ttl: 600 }).catch(() => ({ ok: false, expirada: false }));
      if (r.ok) { enviados++; await env.DB.prepare('UPDATE push_inscricoes SET ultimo_envio = CURRENT_TIMESTAMP WHERE id = ?').bind(i.id).run(); }
      else if (r.expirada) await env.DB.prepare('DELETE FROM push_inscricoes WHERE id = ?').bind(i.id).run();
    }
    return enviados ? json({ ok: true, enviados }) : json({ erro: 'O serviço de notificações do aparelho não aceitou o envio. Desative e ative de novo neste aparelho.' }, 502);
  }
  return json({ erro: 'Ação desconhecida.' }, 400);
}
```

---

## 7. Cliente: bloco "No celular" (ativar / testar / desativar)

Onde colocar: dentro da central de notificações (o sino), ou numa tela de "Minha conta". Comportamento:

- **Fora do app instalado:** no celular, mostrar só como instalar (iPhone: Safari → Compartilhar → *Adicionar à Tela de Início*;
  Android: Chrome → menu ⋮ → *Instalar app*), depois "abra pelo ícone e ative aqui". No computador, esconder o bloco.
- **Dentro do app:** "Ativar neste aparelho" → depois "Enviar teste" e "Desativar"; listar os outros aparelhos ativos do usuário.
- Permissão negada: explicar como liberar nas configurações do aparelho.
- Servidor sem chave VAPID: esconder o bloco.

```js
const iOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const instalado = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
const movel = () => iOS() || /Android|Mobile/i.test(navigator.userAgent);
const suporte = () => ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) ? 'ok'
  : (iOS() && !instalado() ? 'ios-instalar' : 'nao');
const deB64url = (t) => { const s = t.replace(/-/g, '+').replace(/_/g, '/'), b = atob(s + '='.repeat((4 - (s.length % 4)) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };

export function descreverAparelho(ua = navigator.userAgent) {
  const so = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Aparelho';
  const nav = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return nav && !/^(iPhone|iPad)$/.test(so) ? so + ' · ' + nav : so;
}
async function api(corpo) {
  const r = await fetch('/api/push', { method: corpo ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: corpo ? { 'Content-Type': 'application/json' } : undefined, body: corpo ? JSON.stringify(corpo) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Não foi possível falar com o servidor (' + r.status + ').');
  return j;
}
const inscricaoAtual = async () => { const reg = await navigator.serviceWorker.getRegistration('/'); return reg ? reg.pushManager.getSubscription() : null; };

// CHAMAR DIRETO DO CLIQUE (o iPhone só pede permissão a partir de um toque)
export async function ativar(chavePublica) {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'As notificações foram bloqueadas. Libere nas configurações do aparelho e tente de novo.' : 'Permissão não concedida.');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && sub.options && sub.options.applicationServerKey) {   // inscrição feita com outra chave: refaz
    const atual = new Uint8Array(sub.options.applicationServerKey), nova = deB64url(chavePublica);
    if (atual.length !== nova.length || atual.some((b, i) => b !== nova[i])) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: deB64url(chavePublica) });
  await api({ acao: 'inscrever', inscricao: sub.toJSON(), aparelho: descreverAparelho() });
}
export async function desativar() {
  const sub = await inscricaoAtual();
  if (!sub) return;
  await api({ acao: 'cancelar', endpoint: sub.endpoint });
  await sub.unsubscribe().catch(() => {});
}
export async function testar() {
  const sub = await inscricaoAtual();
  if (!sub) throw new Error('Este aparelho não está com as notificações ativadas.');
  await api({ acao: 'testar', endpoint: sub.endpoint });
}
// estado para desenhar o bloco: ativo = a inscrição deste navegador está no servidor e a permissão foi dada
export async function estado() {
  const s = suporte();
  if (s !== 'ok') return { suporte: s, instalado: instalado(), movel: movel() };
  const [srv, sub] = await Promise.all([api(), inscricaoAtual().catch(() => null)]);
  const ativo = !!(sub && srv.aparelhos.some((a) => a.endpoint === sub.endpoint)) && Notification.permission === 'granted';
  return { suporte: s, instalado: instalado(), movel: movel(), chave: srv.chave, permissao: Notification.permission, ativo,
    aparelhos: srv.aparelhos, endpoint: sub ? sub.endpoint : null };
}
```

Desenhe a interface com os componentes e o estilo do projeto (botão principal "Ativar neste aparelho", botão comum
"Enviar teste", link "Desativar", mensagem de status com `role="status"`).

---

## 8. Central de notificações (sino) e regras

Modelo que funcionou bem. Adapte os **tipos** ao negócio do outro projeto (pergunte ao usuário quais avisos ele quer).

### 8.1 Tabela de regras

```sql
CREATE TABLE notificacoes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nome           TEXT NOT NULL,                 -- título que aparece na notificação
  tipo           TEXT NOT NULL,                 -- chave de TIPOS (ex.: 'estoque-baixo', 'comunicado', 'personalizado')
  condicao       TEXT NOT NULL DEFAULT '{}',    -- JSON com os campos do tipo (limite, itens escolhidos...)
  mensagem       TEXT NOT NULL,                 -- texto com variáveis: "Estoque de {item} em {qtd}"
  nivel          TEXT NOT NULL DEFAULT 'info',  -- info | alerta | critico
  destinatarios  TEXT NOT NULL DEFAULT '{"modo":"todos"}',
  repetir        TEXT NOT NULL DEFAULT 'diaria',-- sessao | diaria | horas:N | nunca
  celular        INTEGER NOT NULL DEFAULT 0,    -- 1 = também manda para o celular (Web Push)
  ativa          INTEGER NOT NULL DEFAULT 1,
  criado_em      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### 8.2 Motor de regras compartilhado (um arquivo JS usado pelo navegador **e** pelo servidor)

```js
// cada tipo descreve: campos do formulário, variáveis da mensagem, exemplo para a prévia, link da tela e como avaliar
export const TIPOS = {
  'comunicado': {
    rotulo: 'Comunicado',
    campos: [{ id: 'ate', tipo: 'data', rotulo: 'Mostrar até' }],
    variaveis: [], mensagem: 'Escreva o comunicado', exemplo: {},
    acao: { href: '#/', rotulo: 'Abrir' },
    avaliar: (cond, ctx) => (!cond.ate || ctx.hoje <= cond.ate ? [{ chave: 'unico', vars: {} }] : []),
  },
  // 'estoque-baixo': { campos: [{id:'limite', tipo:'numero'}], variaveis: ['item','qtd'], avaliar: (cond, ctx) => ctx.estoques.filter(...).map(e => ({ chave: e.id, vars: {...} })) },
};
export const montarTexto = (modelo, vars) => modelo.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));

// -> [{regra, chave: 'r<id>:<ocorrência>', titulo, texto, acao}]
export function avaliar(regras, ctx) {
  const out = [];
  for (const r of regras) {
    const t = TIPOS[r.tipo];
    if (!t || !r.ativa) continue;
    for (const o of t.avaliar(r.condicao || {}, ctx) || []) {
      out.push({ regra: r, chave: 'r' + r.id + ':' + o.chave, titulo: r.nome, texto: montarTexto(r.mensagem, o.vars || {}), acao: o.acao || t.acao });
    }
  }
  return out;
}
```

- **Sino (navegador):** busca as regras que valem para o usuário (`GET /api/notificacoes`), avalia com os dados que a tela já
  tem, mostra a lista com contador. Ao fechar no X, guarda no `localStorage` quando fechou, por chave da ocorrência, e
  respeita `repetir`: `sessao` = volta na próxima sessão; `diaria` = volta no dia seguinte; `horas:N` = depois de N horas;
  `nunca` = aparece uma vez só.
- **Tela "Configurar notificações"** (só administrador): lista das regras com "Para quem" e "Recebem agora"; formulário com tipo,
  campos do tipo, mensagem com botões das variáveis (`{item}`), nível, para quem, repetir, caixa **"Enviar também para o
  celular"** e prévia ao vivo de como a notificação vai aparecer.
- **Tipo "personalizado"** (recomendado): o próprio usuário monta um aviso novo escolhendo a fonte de dados, a condição e a
  mensagem, sem precisar de programação a cada aviso novo.

### 8.3 Para quem (`destinatarios`)

```js
// {modo:'todos'} | {modo:'telas', telas:[...]} (quem tem acesso a alguma tela) | {modo:'funcoes', funcoes:[ids]} | {modo:'usuarios', ids:[...]}
export function recebe(permissoes, usuarioId, regra, funcaoId = null) {
  const d = regra.destinatarios || { modo: 'todos' };
  if (d.modo === 'usuarios') return (d.ids || []).includes(usuarioId);
  if (d.modo === 'funcoes') return funcaoId !== null && (d.funcoes || []).includes(funcaoId);
  if (d.modo === 'telas') return (d.telas || []).some((t) => permissoes.includes(t));
  return true;
}
```

Na interface, "Por função" e "Personalizado (escolher as pessoas)" funcionam bem como **lista com busca** (caixa de marcar
por linha, nome + detalhe, contador de marcados). Se o projeto não tiver telas/funções, use só `todos` e `usuarios`.
Se houver separação por unidade/filial, guarde as unidades no usuário e filtre as ocorrências pela unidade dele.

### 8.4 Envio agendado para o celular (a cada 10 min)

Rode onde o projeto já roda tarefas: Cron Trigger (Cloudflare), `pg_cron` + Edge Function (Supabase), Vercel Cron, cron do
servidor, GitHub Actions etc.

```js
// estado = {'<usuarioId>|<chave>': ms do último envio}, guardado no banco (uma linha JSON numa tabela de cache serve)
export function deveEnviar(ultimo, repetir, agora) {
  if (!ultimo) return true;
  if (repetir === 'sessao' || repetir === 'nunca') return false;
  const dia = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);   // fuso do projeto (aqui UTC-3)
  if (repetir === 'diaria' || !repetir) return dia(ultimo) !== dia(agora);
  return agora - ultimo >= (Number(String(repetir).split(':')[1]) || 24) * 3600e3;
}

export function planejar({ regras, usuarios, inscricoes, ctxDe, estado = {}, agora = Date.now() }) {
  const porUsuario = new Map();
  for (const i of inscricoes) (porUsuario.get(i.usuario_id) || porUsuario.set(i.usuario_id, []).get(i.usuario_id)).push(i);
  const envios = [], novo = {};
  for (const u of usuarios) {
    const aparelhos = porUsuario.get(u.id);
    if (!aparelhos) continue;
    const minhas = regras.filter((r) => r.celular && recebe(u.permissoes, u.id, r, u.funcao_id));
    for (const o of avaliar(minhas, ctxDe(u))) {
      const k = u.id + '|' + o.chave, ultimo = estado[k] || 0;
      if (!deveEnviar(ultimo, o.regra.repetir, agora)) { novo[k] = ultimo; continue; }
      novo[k] = agora;
      const mensagem = { titulo: o.titulo, texto: o.texto, url: '/' + (o.acao && o.acao.href || ''), tag: o.chave, nivel: o.regra.nivel };
      for (const inscricao of aparelhos) envios.push({ inscricao, mensagem, urgencia: o.regra.nivel === 'critico' ? 'high' : 'normal' });
    }
  }
  // 'nunca': guardar o que já foi enviado mesmo depois que a ocorrência some (até 90 dias), senão volta a ser enviado
  for (const [k, ms] of Object.entries(estado)) {
    if (k in novo || agora - ms >= 90 * 864e5) continue;
    const chave = k.slice(k.indexOf('|') + 1), r = regras.find((x) => chave.startsWith('r' + x.id + ':'));
    if (r && r.repetir === 'nunca') novo[k] = ms;
  }
  return { envios, estado: novo };
}
```

A tarefa: carrega regras com `celular = 1` e ativas, usuários e inscrições, os dados que as regras usam (só o necessário),
roda `planejar`, envia com `enviarPush` (no máximo ~300 por rodada, por segurança), apaga as inscrições `expirada`, grava
`ultimo_envio` e o novo `estado`. Tenha um modo **simular** (só registra o que mandaria) para o primeiro teste.

O `ctxDe(u)` monta os dados que aquele usuário pode ver (respeite as permissões dele: quem não tem acesso a um dado não deve
receber aviso sobre ele).

---

## 9. Segurança (checklist)

- [ ] Chave privada VAPID só em segredo do servidor; nunca no front, no repositório, em log ou no chat.
- [ ] `/api/push` exige sessão; `cancelar`/`testar` só mexem nas inscrições do próprio usuário.
- [ ] `endpointValido` no servidor (lista dos serviços de push) antes de gravar.
- [ ] Recusar `Origin` de outro site nos `POST`.
- [ ] Limite de aparelhos por usuário e de envios por rodada.
- [ ] O clique da notificação só abre URLs do próprio site.
- [ ] Texto da notificação sem dados sensíveis (aparece na tela bloqueada).
- [ ] Notificações de dados respeitam as permissões de quem recebe.

## 10. Testes sugeridos

- Unitários de `webpush.js`: `b64url`/`deB64url` ida e volta; `cifrar` com `sal` e `par` fixos gera o tamanho esperado
  (16 + 4 + 1 + 65 + texto + 1 + 16 bytes); `cabecalhoVapid` gera JWT de 3 partes e `aud` = origem do endpoint;
  `enviarPush` com `fetchFn` falso devolve `expirada` em 404/410.
- `validarInscricao`: recusa endpoint de domínio qualquer, chaves fora do formato, limpa o nome do aparelho.
- `deveEnviar` / `planejar`: cada opção de `repetir`, `nunca` não reenvia quando a ocorrência volta, usuário sem aparelho
  não gera envio, regra sem `celular` não vai para o celular.
- Teste manual: Android (Chrome, app instalado) e iPhone (iOS 16.4+, Tela de Início): ativar → "Enviar teste" chega com o app
  fechado → tocar abre a tela certa → ícone da barra no Android é a silhueta da logo (não um quadrado) → desativar e confirmar
  que não chega mais.

## 11. Perguntas para o usuário (antes de implementar)

1. Quais avisos o app deve mandar (o que dispara cada um, para quem, com que frequência)? Começar por um grupo de usuários
   (ex.: só a equipe administrativa) e depois ampliar?
2. As notificações devem ativar **só no app instalado** (recomendado) ou também no navegador?
3. Quais páginas viram app (todas, só a área logada, duas áreas com ícones separados)? Nome curto e cores do ícone.
4. Existe um PNG do símbolo/logo **sem fundo** para o ícone da barra do Android (`badge-96.png`) e ícones 192/512?
5. Onde rodar a tarefa agendada (o que o projeto já usa)?
6. Em qual domínio (HTTPS) o app vai rodar, para o `VAPID_ASSUNTO`?
