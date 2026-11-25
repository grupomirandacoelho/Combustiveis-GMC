import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode } from '../../../lib/permissoes.js';
import { rpc, temBanco } from '../../../lib/supabase.js';

// Orçamentos da frota (Real x Orçado), ano a ano. 15.3, item 6 (25/11/2026; pedidos do usuário "Pode seguir com o upload do
// orçamento" e "inclui um Botão pequeno no lado direito dos filtros escrito 'Orçamentos' e nele podendo alterar o orçamento de cada
// ano incluído ... excluir ou incluir"). O orçamento continua no Excel (Banco_Orçamento_Despesas_Frota): o navegador lê as abas
// Base_Metas e BD_UND (public/gestao/lib/orcamento.js) e manda só as linhas do ano escolhido.
// GET  /api/orcamento   -> {podeEditar, anos: [{ano, linhas, unidades, meses, combustivel, arla, km, arquivo, usuario, em}]}
// POST /api/orcamento   {acao: 'incluir'|'alterar', ano, arquivo, metas: [{unidade, natureza, data, valor}], unidades: [...]}
//                       {acao: 'excluir', ano}

const LIMITE_METAS = 20000, LIMITE_UNIDADES = 500;
const texto = (v, max) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max));
const dataValida = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(new Date(d + 'T00:00:00Z').getTime()) &&
  new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d && d >= '2000-01-01' && d <= '2100-12-31';

// corpo recebido -> {acao, ano, arquivo, metas, unidades} ou {erro}; incluir/alterar: só as linhas do ano
export function validarOrcamento(corpo) {
  const acao = String((corpo && corpo.acao) || '');
  const ano = Number(corpo && corpo.ano);
  if (!['incluir', 'alterar', 'excluir'].includes(acao)) return { erro: 'Ação inválida.' };
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) return { erro: 'Ano inválido.' };
  if (acao === 'excluir') return { acao, ano, arquivo: null, metas: null, unidades: null };
  const arquivo = texto(corpo.arquivo, 120) || 'orçamento.xlsx';
  const metasIn = Array.isArray(corpo.metas) ? corpo.metas : null;
  const undIn = Array.isArray(corpo.unidades) ? corpo.unidades : [];
  if (!metasIn || !metasIn.length) return { erro: 'A planilha não tem linhas na aba Base_Metas.' };
  if (metasIn.length > LIMITE_METAS) return { erro: 'Linhas demais na aba Base_Metas (máximo ' + LIMITE_METAS + ').' };
  if (undIn.length > LIMITE_UNIDADES) return { erro: 'Linhas demais na aba BD_UND (máximo ' + LIMITE_UNIDADES + ').' };
  const metas = [];
  for (const [i, m] of metasIn.entries()) {
    const l = { unidade: texto(m.unidade, 100), natureza: texto(m.natureza, 100), data: texto(m.data, 10), valor: Number(m.valor) };
    if (!l.unidade || !l.natureza || !dataValida(l.data) || !Number.isFinite(l.valor) || Math.abs(l.valor) > 1e12) {
      return { erro: 'Linha ' + (i + 2) + ' da aba Base_Metas incompleta ou com valor inválido.' };
    }
    if (Number(l.data.slice(0, 4)) === ano) metas.push(l);
  }
  if (!metas.length) return { erro: 'A planilha não tem linhas de ' + ano + ' na aba Base_Metas.' };
  const unidades = undIn.map((u) => ({ unidade: texto(u.unidade, 100), inf_adicional: texto(u.inf_adicional, 200) || null,
    centro_de_custo: texto(u.centro_de_custo, 100) || null })).filter((u) => u.unidade);
  return { acao, ano, arquivo, metas, unidades };
}

export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  if (!pode(u, 'real-orcado')) return json({ erro: 'Seu acesso não inclui o Real x Orçado.' }, 403);
  if (!temBanco(env)) return json({ podeEditar: false, anos: [], erro: 'Banco de dados não configurado.' });
  const anos = await rpc(env, 'gestao_orcamento_anos', {}, { ms: 10000 });
  if (!Array.isArray(anos)) return json({ erro: 'O banco não respondeu. Tente de novo em alguns minutos.' }, 502);
  return json({ podeEditar: pode(u, 'real-orcado-editar'), anos });
}

export async function onRequestPost({ request, env }) {
  const origem = request.headers.get('Origin');
  if (origem && origem !== new URL(request.url).origin) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  if (!pode(u, 'real-orcado-editar')) return json({ erro: 'Seu acesso não permite alterar os orçamentos.' }, 403);
  if (!temBanco(env)) return json({ erro: 'Banco de dados não configurado.' }, 503);
  if (Number(request.headers.get('Content-Length') || 0) > 6_000_000) return json({ erro: 'Planilha grande demais.' }, 413);
  let corpo;
  try { corpo = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const v = validarOrcamento(corpo);
  if (v.erro) return json({ erro: v.erro }, 400);
  const r = await rpc(env, 'gestao_orcamento_ano', { p_acao: v.acao, p_ano: v.ano, p_arquivo: v.arquivo, p_usuario: u.nome,
    p_metas: v.metas, p_unidades: v.unidades }, { ms: 30000 });
  if (!r) return json({ erro: 'O banco não respondeu. Nada foi gravado; tente de novo em alguns minutos.' }, 502);
  if (!r.ok) return json({ erro: r.erro || 'Nada foi gravado.' }, 400);
  return json({ ok: true, acao: v.acao, ano: v.ano, metas: r.metas || 0, unidades: r.unidades || 0 }, 201);
}
