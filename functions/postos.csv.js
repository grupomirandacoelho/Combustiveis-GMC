// /postos.csv: lista dos postos dos motoristas. Vem do Workers KV (publicada pelo vigia a partir da planilha de negociações) ou, com a
// chave KV "postos-fonte" = "banco", do banco (lib/postos-fonte.js; 15.3, 25/11/2026).
// Desde 26/11/2026 (pedido do usuário: os postos autorizados saem da tela inicial e ficam só no login dos motoristas) a lista só vai
// para quem está conectado: motorista (área /motorista/) ou equipe de gestão (Postos dos motoristas, Preço postos externos). O
// arquivo estático public/postos.csv, que antes servia de reserva, saiu do site.
import { lerPostos } from '../lib/postos-fonte.js';
import { usuarioDaSessao, json } from '../lib/auth.js';
import { motoristaDaSessao } from '../lib/motoristas.js';

export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u && !(await motoristaDaSessao(env.DB, request))) return json({ erro: 'Entre para ver os postos autorizados.' }, 401);
  const l = await lerPostos(env);
  if (!l) return json({ erro: 'A lista de postos ainda não foi publicada.' }, 503);
  return new Response('﻿' + l.csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-cache' },
  });
}
