import { tokenSyncValido, json } from '../../../../lib/auth.js';

// O vigia informa o resultado de cada lote do Consolidador: aplicada (com as linhas da Base_copia), aguardando
// (planilha aberta no Excel) ou erro.
export async function onRequestPost({ request, env }) {
  if (!tokenSyncValido(request, env)) return json({ erro: 'Não autorizado.' }, 401);
  let corpo;
  try { corpo = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const itens = (Array.isArray(corpo.itens) ? corpo.itens.slice(0, 50) : [])
    .filter((i) => Number.isInteger(i.id) && ['aplicada', 'aguardando', 'erro'].includes(i.estado));
  const agora = new Date().toISOString().slice(0, 19) + 'Z';
  const int = (v) => (Number.isInteger(v) ? v : null);
  const stmts = itens.map((i) => {
    let msg = i.mensagem ? String(i.mensagem).slice(0, 300) : null;
    if (i.estado === 'aplicada' && !msg) {
      msg = (i.gravadas || 0) + ' abastecimento(s) gravado(s)' + (i.ignoradas ? '; ' + i.ignoradas + ' já estavam nos abastecimentos' : '') + '.';
    }
    return env.DB.prepare('UPDATE consolidador_lotes SET estado = ?, mensagem = ?, aplicada_em = ?, linha_inicial = ?, linha_final = ? WHERE id = ?')
      .bind(i.estado, msg, i.estado === 'aplicada' ? agora : null, int(i.linha_inicial), int(i.linha_final), i.id);
  });
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, atualizados: stmts.length });
}
