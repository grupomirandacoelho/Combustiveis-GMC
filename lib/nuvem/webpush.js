// Envio de notificação push (Web Push) sem biblioteca: só WebCrypto, que existe no portal (Cloudflare), na nuvem (Deno, Supabase)
// e no Node (testes). 26/11/2026, pedido do usuário: notificações no celular para a equipe de gestão.
//  - VAPID (RFC 8292): o servidor se identifica com um JWT ES256 assinado pela chave privada; o navegador só aceita push de quem
//    tem a chave pública usada na inscrição (applicationServerKey).
//  - Conteúdo cifrado (RFC 8291, aes128gcm): só o aparelho inscrito consegue ler (chaves p256dh e auth da inscrição).
// Copiado para supabase/functions/_shared pelo scripts/nuvem_publicar.mjs.

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
  const total = partes.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const p of partes) { out.set(p, i); i += p.length; }
  return out;
}
async function hmac(chave, dados) {
  const k = await crypto.subtle.importKey('raw', chave, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, dados));
}

// par de chaves VAPID novo: {publica (base64url, 65 bytes, vai para o navegador), privada (JWK em texto, segredo)}
export async function gerarVapid() {
  const par = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publica = b64url(await crypto.subtle.exportKey('raw', par.publicKey));
  return { publica, privada: JSON.stringify(await crypto.subtle.exportKey('jwk', par.privateKey)) };
}

// cabeçalho Authorization do VAPID para o serviço de push do endpoint (Google, Apple, Mozilla...)
export async function cabecalhoVapid(endpoint, vapid, agoraS = Math.floor(Date.now() / 1000)) {
  const jwk = typeof vapid.privada === 'string' ? JSON.parse(vapid.privada) : vapid.privada;
  const chave = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const cab = b64url(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const corpo = b64url(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: agoraS + 12 * 3600, sub: vapid.assunto })));
  const assinatura = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, chave, te.encode(cab + '.' + corpo));
  return 'vapid t=' + cab + '.' + corpo + '.' + b64url(assinatura) + ', k=' + vapid.publica;
}

// cifra o texto para uma inscrição {p256dh, auth} (RFC 8291). opcoes.sal/opcoes.par só nos testes.
export async function cifrar(texto, inscricao, opcoes = {}) {
  const uaPublica = deB64url(inscricao.p256dh), auth = deB64url(inscricao.auth);
  const par = opcoes.par || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublica = new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey));
  const ua = await crypto.subtle.importKey('raw', uaPublica, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const segredo = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, par.privateKey, 256));
  // IKM = HKDF(auth, segredo ECDH, "WebPush: info" || 0 || chave do aparelho || chave do servidor)
  const prkChave = await hmac(auth, segredo);
  const ikm = await hmac(prkChave, juntar(te.encode('WebPush: info\0'), uaPublica, asPublica, new Uint8Array([1])));
  const sal = opcoes.sal || crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(sal, ikm);
  const cek = (await hmac(prk, juntar(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, juntar(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const k = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  // um registro só: o conteúdo + o delimitador 0x02 (último registro)
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, juntar(te.encode(texto), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);   // tamanho do registro: 4096
  return juntar(sal, rs, new Uint8Array([asPublica.length]), asPublica, cifrado);
}

// envia {titulo, texto, url, tag, nivel} para uma inscrição {endpoint, p256dh, auth}. -> {status, ok, expirada}
// expirada = o aparelho cancelou a inscrição (404/410): quem chamou apaga a inscrição.
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

// endpoints aceitos: só os serviços de push dos navegadores (a inscrição vem do navegador do usuário; nunca mandar para outro lugar)
export const SERVICOS_PUSH = /^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)\//i;
export const endpointValido = (e) => typeof e === 'string' && e.length <= 1000 && SERVICOS_PUSH.test(e);
