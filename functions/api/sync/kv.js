import { tokenSyncValido, json } from '../../../lib/auth.js';

// Passo 4 da migração (19/11/2026): as rotinas na nuvem (Edge Functions do Supabase) publicam aqui o que o vigia mandava ao KV pelo
// wrangler, nas mesmas chaves que o portal já lê. Só as chaves da lista; o token é o de sincronização.
// POST {chave, valor} -> {ok}
const CHAVES = new Set(['tempo-real', 'tempo-real-versao', 'bomba-rateio', 'conferencia-cartoes', 'conciliacao-nfs',   // + Conferência e Conciliação (23/11/2026)
  'anp', 'anp-versao', 'petrobras', 'petrobras-versao']);   // ANP e Petrobras pelo GitHub Actions (25/11/2026; scripts/publicar_precos.py)

export async function onRequestPost({ request, env }) {
  if (!tokenSyncValido(request, env)) return json({ erro: 'Não autorizado.' }, 401);
  let d;
  try { d = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  if (!CHAVES.has(d.chave) || !d.valor || typeof d.valor !== 'object') return json({ erro: 'Chave ou valor fora da lista.' }, 400);
  await env.DADOS.put(d.chave, JSON.stringify(d.valor));
  return json({ ok: true });
}
