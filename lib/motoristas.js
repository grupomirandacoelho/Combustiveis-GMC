// Área do motorista: login pelo usuário de 6 números (os 6 primeiros do CPF; o CPF não fica guardado desde 12/11/2026),
// senha inicial = o próprio usuário, trocável pelo motorista (tabela motoristas_acesso). Sessão própria (cookie
// "sessao_motorista", tabela sessoes_motoristas) e busca do motorista no cadastro (chave "cadastros" do KV).
import { sha256, lerCookie } from './auth.js';
import { lerCadastros } from './cadastros-fonte.js';

export const COOKIE_MOTORISTA = 'sessao_motorista';
const DURACAO = 60 * 60 * 24 * 90;        // 90 dias (era 30; usuário, 27/11/2026): o motorista abre no celular e não precisa entrar toda hora
const agora = () => Math.floor(Date.now() / 1000);
export const soNumeros = (v) => String(v ?? '').replace(/\D/g, '');
// o que um motorista digita no campo usuário: os 6 números, ou o CPF inteiro por costume ("000.000.000-00"): aí vale só
// o começo e o resto é descartado (não é guardado nem comparado)
export function usuarioMotorista(v) {
  const t = String(v ?? '').trim();
  if (!/^[\d.\-\s]+$/.test(t)) return null;
  const d = soNumeros(t);
  return d.length === 6 || d.length === 11 ? d.slice(0, 6) : null;
}
// motorista de teste (CPF fictício): a área dele mostra, só na tela, os abastecimentos de um motorista real (espelho);
// nome, unidade e senhas continuam os do teste e nada muda na planilha (pedido do usuário, 06/11/2026)
export const ESPELHO_TESTE = { '111444': 'ELIVELTON DOS SANTOS CONCEICAO' };
export const chaveNome = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

// motorista do cadastro pelo usuário (6 números) -> {nome, unidade, situacao, senhas: {ticket, truckpag, veloe}} ou null
// (as senhas só vão para o próprio motorista, em /api/motorista/dados)
export async function motoristaDoCadastro(env, usuario) {
  const c = await lerCadastros(env).catch(() => null);
  const m = c && Array.isArray(c.motoristas) ? c.motoristas.find((x) => soNumeros(x.usuario).padStart(6, '0') === usuario) : null;
  const s = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
  return m ? { nome: String(m.nome || '').trim(), unidade: m.unidade || null, situacao: m.situacao || null,
    senhas: { ticket: s(m.senhaTicket), truckpag: s(m.senhaTruckpag), veloe: s(m.senhaVeloe) } } : null;
}

function cookie(request, valor, maxAge) {
  const seguro = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE_MOTORISTA}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${seguro}`;
}

export async function criarSessaoMotorista(db, request, usuario, nome) {
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
  await db.prepare('INSERT INTO sessoes_motoristas (token_hash, usuario, nome, expira_em) VALUES (?, ?, ?, ?)').bind(await sha256(token), usuario, nome, agora() + DURACAO).run();
  await db.prepare('DELETE FROM sessoes_motoristas WHERE expira_em < ?').bind(agora()).run();
  return cookie(request, token, DURACAO);
}

export async function motoristaDaSessao(db, request) {
  const token = lerCookie(request, COOKIE_MOTORISTA);
  if (!token) return null;
  return db.prepare('SELECT usuario, nome FROM sessoes_motoristas WHERE token_hash = ? AND expira_em > ?').bind(await sha256(token), agora()).first();
}

export async function encerrarSessaoMotorista(db, request) {
  const token = lerCookie(request, COOKIE_MOTORISTA);
  if (token) await db.prepare('DELETE FROM sessoes_motoristas WHERE token_hash = ?').bind(await sha256(token)).run();
  return cookie(request, '', 0);
}