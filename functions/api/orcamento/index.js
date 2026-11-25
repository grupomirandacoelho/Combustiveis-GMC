import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode } from '../../../lib/permissoes.js';
import { rpc, temBanco } from '../../../lib/supabase.js';

// Orçamento da frota (Real x Orçado). 15.3, item 6 (25/11/2026; pedido do usuário "Pode seguir com o upload do orçamento"; decisão:
// o orçamento continua sendo preenchido no Excel e é enviado pelo portal). O navegador lê a planilha Banco_Orçamento_Despesas_Frota
// (abas Base_Metas e BD_UND, public/gestao/lib/orcamento.js) e manda as linhas. Um envio por ano (usuário, 25/11/2026): o banco só
// acrescenta os anos que ainda não estão no portal; ano que já está não é substituído (gestao_orcamento_importar).
// GET  /api/orcamento   -> {podeEnviar, envio: {arquivo, usuario, em, anos}, atualizadoEm, anos: [anos já no portal]}
// POST /api/orcamento   {arquivo, metas: [{unidade, natureza, data: 'AAAA-MM-DD', valor}], unidades: [{unidade, inf_adicional, centro_de_custo}]}

const LIMITE_METAS = 20000, LIMITE_UNIDADES = 500;
const texto = (v, max) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max));
const dataValida = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(new Date(d + 'T00:00:00Z').getTime()) &&
  new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d && d >= '2000-01-01' && d <= '2100-12-31';

// corpo recebido -> {arquivo, metas, unidades} ou {erro}
export function validarOrcamento(corpo) {
  const arquivo = texto(corpo && corpo.arquivo, 120) || 'orçamento.xlsx';
  const metasIn = corpo && Array.isArray(corpo.metas) ? corpo.metas : null;
  const undIn = corpo && Array.isArray(corpo.unidades) ? corpo.unidades : null;
  if (!metasIn || !metasIn.length) return { erro: 'A planilha não tem linhas na aba Base_Metas.' };
  if (!undIn || !undIn.length) return { erro: 'A planilha não tem linhas na aba BD_UND.' };
  if (metasIn.length > LIMITE_METAS) return { erro: 'Linhas demais na aba Base_Metas (máximo ' + LIMITE_METAS + ').' };
  if (undIn.length > LIMITE_UNIDADES) return { erro: 'Linhas demais na aba BD_UND (máximo ' + LIMITE_UNIDADES + ').' };
  const metas = [];
  for (const [i, m] of metasIn.entries()) {
    const l = { unidade: texto(m.unidade, 100), natureza: texto(m.natureza, 100), data: texto(m.data, 10), valor: Number(m.valor) };
    if (!l.unidade || !l.natureza || !dataValida(l.data) || !Number.isFinite(l.valor) || Math.abs(l.valor) > 1e12) {
      return { erro: 'Linha ' + (i + 2) + ' da aba Base_Metas incompleta ou com valor inválido.' };
    }
    metas.push(l);
  }
  const unidades = undIn.map((u) => ({ unidade: texto(u.unidade, 100), inf_adicional: texto(u.inf_adicional, 200) || null,
    centro_de_custo: texto(u.centro_de_custo, 100) || null })).filter((u) => u.unidade);
  if (!unidades.length) return { erro: 'A aba BD_UND não tem nenhuma unidade.' };
  return { arquivo, metas, unidades };
}

export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  if (!pode(u, 'real-orcado')) return json({ erro: 'Seu acesso não inclui o Real x Orçado.' }, 403);
  const info = temBanco(env) ? await rpc(env, 'gestao_orcamento_info', {}, { ms: 8000 }) : null;
  return json({ podeEnviar: pode(u, 'real-orcado-editar') && temBanco(env), envio: info ? info.envio : null, atualizadoEm: info ? info.atualizadoEm : null,
    anos: info && Array.isArray(info.anos) ? info.anos : [] });
}

export async function onRequestPost({ request, env }) {
  const origem = request.headers.get('Origin');
  if (origem && origem !== new URL(request.url).origin) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  if (!pode(u, 'real-orcado-editar')) return json({ erro: 'Seu acesso não permite enviar o orçamento.' }, 403);
  if (!temBanco(env)) return json({ erro: 'Banco de dados não configurado.' }, 503);
  if (Number(request.headers.get('Content-Length') || 0) > 6_000_000) return json({ erro: 'Planilha grande demais.' }, 413);
  let corpo;
  try { corpo = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const v = validarOrcamento(corpo);
  if (v.erro) return json({ erro: v.erro }, 400);
  const r = await rpc(env, 'gestao_orcamento_importar', { p_arquivo: v.arquivo, p_usuario: u.nome, p_metas: v.metas, p_unidades: v.unidades }, { ms: 30000 });
  if (!r) return json({ erro: 'O banco não respondeu. Nada foi gravado; tente de novo em alguns minutos.' }, 502);
  if (!r.ok) return json({ erro: r.erro || 'Nada foi gravado.' }, 400);
  return json({ ok: true, metas: r.metas, unidades: r.unidades, anosNovos: r.anosNovos || [], anosJaExistentes: r.anosJaExistentes || [] }, 201);
}
