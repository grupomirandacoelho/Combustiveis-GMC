import { usuarioDaSessao, comSeguranca } from '../lib/auth.js';
import { motoristaDaSessao } from '../lib/motoristas.js';

// Tela inicial (/) = tela de login desde 26/11/2026 (public/index.html, protótipo prototipos/login-v2). Quem já está conectado
// não vê o login: vai direto para a área dele (gestão: /gestao/, que manda para "Trocar senha" se for o caso; motorista: /motorista/).
export async function onRequestGet({ request, env, next }) {
  const [u, m] = await Promise.all([usuarioDaSessao(env.DB, request).catch(() => null), motoristaDaSessao(env.DB, request).catch(() => null)]);
  if (u || m) return new Response(null, { status: 302, headers: { Location: u ? '/gestao/' : '/motorista/', 'Cache-Control': 'no-store' } });
  const resp = await next();
  const r = new Response(resp.body, resp);
  r.headers.set('Cache-Control', 'no-cache');
  return comSeguranca(r);
}
