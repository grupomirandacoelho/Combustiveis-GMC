import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode } from '../../../lib/permissoes.js';

// Fiscal/Financeiro > Conciliação de NFs: a lista montada pelo vigia (scripts/conciliacao_nfs.mjs, KV "conciliacao-nfs"):
// cada nota fiscal de serviço (NFS) do cartão com as notas fiscais dos postos daquela fatura.
// GET /api/fiscal/conciliacao -> {geradoEm, nfs: [{cartao, numero, dataEmissao, vencimento, valor, valorCompras, notas: [...]}]}
export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  if (!pode(u, 'fiscal-conciliacao')) return json({ erro: 'Seu acesso não inclui a conciliação de NFs.' }, 403);
  const d = await env.DADOS.get('conciliacao-nfs', 'json').catch(() => null);
  if (!d) return json({ erro: 'A conciliação ainda não foi feita (roda a cada 6 horas). Tente mais tarde.' }, 503);
  return json(d);
}