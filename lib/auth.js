// Autenticação da gestão: senhas com PBKDF2 e sessões guardadas no D1.
// O navegador recebe só um token aleatório (cookie HttpOnly); no banco fica o hash dele.

export const COOKIE = 'sessao';
const DURACAO_SESSAO = 60 * 60 * 2;      // 2 horas (e some ao fechar o navegador)
const DURACAO_MANTER = 60 * 60 * 48;     // "Mantenha conectado": 48 horas, depois precisa entrar de novo
const ITERACOES = 100000;                // máximo aceito pelo PBKDF2 dos Workers
const MAX_FALHAS = 5;                    // por conta, naquele aparelho
const MAX_FALHAS_APARELHO = 20;          // por aparelho (IP), somando todas as contas
const BLOQUEIO = 60 * 15;                // 15 minutos
// com a senha provisória (trocar_senha = 1) as APIs ficam fechadas até a troca; só estas continuam abertas
const LIVRES_SEM_TROCAR = ['/api/me', '/api/trocar-senha', '/api/logout'];

const enc = new TextEncoder();

function b64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}
function deB64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}
function agora() { return Math.floor(Date.now() / 1000); }

async function pbkdf2(senha, sal, iteracoes) {
  const chave = await crypto.subtle.importKey('raw', enc.encode(senha), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: iteracoes }, chave, 256);
}

// formato: pbkdf2$<iterações>$<sal base64>$<hash base64>
export async function gerarHashSenha(senha) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(senha, sal, ITERACOES);
  return `pbkdf2$${ITERACOES}$${b64(sal)}$${b64(hash)}`;
}

export async function conferirSenha(senha, guardado) {
  const [tipo, it, sal, hash] = String(guardado || '').split('$');
  if (tipo !== 'pbkdf2' || !it || !sal || !hash) return false;
  const calculado = new Uint8Array(await pbkdf2(senha, deB64(sal), Number(it)));
  const esperado = deB64(hash);
  if (calculado.length !== esperado.length) return false;
  let dif = 0;
  for (let i = 0; i < calculado.length; i++) dif |= calculado[i] ^ esperado[i];
  return dif === 0;
}

export async function sha256(texto) {
  return b64(await crypto.subtle.digest('SHA-256', enc.encode(texto)));
}

export function lerCookie(request, nome) {
  const cab = request.headers.get('Cookie') || '';
  for (const parte of cab.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return v.join('=');
  }
  return null;
}

// maxAge null = cookie de sessão (o navegador apaga ao fechar)
function cookieSessao(request, valor, maxAge) {
  const seguro = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  const validade = maxAge === null ? '' : `; Max-Age=${maxAge}`;
  return `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Strict${validade}${seguro}`;
}

// manter = "Mantenha conectado": cookie persistente de 48 h; senão, some ao fechar o navegador (máx. 2 h).
// O prazo vale no servidor (expira_em): passou dele, a sessão não serve mais, mesmo que o cookie exista.
export async function criarSessao(db, request, usuarioId, manter = false) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
  const duracao = manter ? DURACAO_MANTER : DURACAO_SESSAO;
  await db.prepare('INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?, ?, ?)')
    .bind(await sha256(token), usuarioId, agora() + duracao).run();
  // limpeza oportunista de sessões vencidas
  await db.prepare('DELETE FROM sessoes WHERE expira_em < ?').bind(agora()).run();
  return cookieSessao(request, token, manter ? DURACAO_MANTER : null);
}

export async function encerrarSessao(db, request) {
  const token = lerCookie(request, COOKIE);
  if (token) await db.prepare('DELETE FROM sessoes WHERE token_hash = ?').bind(await sha256(token)).run();
  return cookieSessao(request, '', 0);
}

// senha provisória legível, sem caracteres ambíguos (0/O, 1/l); a pessoa troca no primeiro acesso
export function senhaProvisoria(tamanho = 10) {
  const alfabeto = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(tamanho)), (b) => alfabeto[b % alfabeto.length]).join('');
}

// Devolve { id, usuario, nome, papel, trocar_senha, permissoes, funcao_id, funcao_permissoes } ou null.
// Login com função recebe as permissões da função (lib/permissoes.js permissoesDe).
export async function usuarioDaSessao(db, request) {
  const token = lerCookie(request, COOKIE);
  if (!token) return null;
  const u = await db.prepare(
    `SELECT u.id, u.usuario, u.nome, u.papel, u.trocar_senha, u.permissoes, u.funcao_id, f.permissoes AS funcao_permissoes, u.bomba_bases, u.unidades
       FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id LEFT JOIN funcoes f ON f.id = u.funcao_id
      WHERE s.token_hash = ? AND s.expira_em > ? AND u.ativo = 1`
  ).bind(await sha256(token), agora()).first();
  // senha provisória: nas APIs vale como sem sessão (as páginas mandam para "Trocar senha" no _middleware da gestão)
  if (u && u.trocar_senha === 1) {
    const caminho = new URL(request.url).pathname;
    if (caminho.startsWith('/api/') && !LIVRES_SEM_TROCAR.includes(caminho)) return null;
  }
  return u;
}

// ---- limite de tentativas ----
// Duas contagens: a conta naquele aparelho (5 erros) e o aparelho em qualquer conta (20 erros). Errar a senha de
// propósito num aparelho não trava a conta para a pessoa em outro aparelho. O IP só fica como hash com segredo.
export async function chavesTentativas(request, env, conta) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const h = ip ? (await sha256('login|' + (env.SYNC_TOKEN || '') + '|' + ip)).slice(0, 32) : 'sem-ip';
  return { conta: conta + '|' + h, aparelho: 'ip:' + h };
}
export async function bloqueioLogin(db, chaves) {
  return Math.max(await estaBloqueado(db, chaves.conta), await estaBloqueado(db, chaves.aparelho));
}
export async function falhaLogin(db, chaves) {
  await registrarFalha(db, chaves.conta);
  await registrarFalha(db, chaves.aparelho, MAX_FALHAS_APARELHO);
}
export async function estaBloqueado(db, usuario) {
  const r = await db.prepare('SELECT bloqueado_ate FROM tentativas_login WHERE usuario = ?').bind(usuario).first();
  return r && r.bloqueado_ate > agora() ? r.bloqueado_ate - agora() : 0;
}

export async function registrarFalha(db, usuario, max = MAX_FALHAS) {
  await db.prepare(
    `INSERT INTO tentativas_login (usuario, falhas, bloqueado_ate) VALUES (?1, 1, 0)
     ON CONFLICT(usuario) DO UPDATE SET
       falhas = CASE WHEN bloqueado_ate > 0 AND bloqueado_ate <= ?2 THEN 1 ELSE falhas + 1 END,
       bloqueado_ate = CASE WHEN (CASE WHEN bloqueado_ate > 0 AND bloqueado_ate <= ?2 THEN 1 ELSE falhas + 1 END) >= ?3
                            THEN ?2 + ?4 ELSE 0 END`
  ).bind(usuario, agora(), max, BLOQUEIO).run();
}

// apaga as tentativas da conta (a chave sozinha e as dela em cada aparelho: "conta|aparelho")
export async function limparFalhas(db, usuario) {
  await db.prepare("DELETE FROM tentativas_login WHERE usuario = ?1 OR substr(usuario, 1, length(?1) + 1) = ?1 || '|'").bind(usuario).run();
}

// Token do vigia (computador da sincronização): "Authorization: Bearer <SYNC_TOKEN>", comparação em tempo constante
export function tokenSyncValido(request, env) {
  const esperado = (env.SYNC_TOKEN || '').trim();   // o segredo pode ter sido gravado com quebra de linha no fim
  const recebido = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!esperado || recebido.length !== esperado.length) return false;
  let dif = 0;
  for (let i = 0; i < esperado.length; i++) dif |= esperado.charCodeAt(i) ^ recebido.charCodeAt(i);
  return dif === 0;
}

// os mesmos do public/_headers (que só vale para os arquivos estáticos): HTTPS sempre, sem abrir dentro de outro site
export const CABECALHOS_SEGURANCA = {
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};
export function comSeguranca(r) {
  for (const [k, v] of Object.entries(CABECALHOS_SEGURANCA)) r.headers.set(k, v);
  return r;
}

export function json(dados, status = 200, extras = {}) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CABECALHOS_SEGURANCA, ...extras }
  });
}
