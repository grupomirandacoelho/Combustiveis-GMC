// Migração 15.3, item 1, passo 2 (25/11/2026; plano em docs/MIGRACAO-15-3.md): aplica no banco (Supabase, public.placas e
// public.motoristas, função gestao_aplicar_cadastro) os pedidos da fila alteracoes_cadastros (Cadastro > Placas/Motoristas e os
// números devolvidos pelas APIs dos cartões), na ordem em que foram pedidos. O "estado" da fila continua sendo o da planilha (o
// vigia segue gravando como cópia); aqui só banco_aplicado_em / banco_mensagem. Mesmo jeito do lib/aplicar-banco.js: reserva
// ('aplicando:<hora>') antes de aplicar, banco fora do ar para sem marcar, erro do próprio pedido fica anotado e a fila segue.
// Chamado depois de cada gravação na fila (context.waitUntil) e pela varredura (/api/sync/banco/aplicar, pg_cron a cada 2 min).
import { rpc, temBanco } from './supabase.js';
import { RESERVADO } from './aplicar-banco.js';

export const LIMITE_CADASTROS = 30;

export async function aplicarCadastrosPendentes(env, { limite = LIMITE_CADASTROS, rpcFn = rpc } = {}) {
  if (!temBanco(env) || !env.DB) return { aplicados: 0, erros: 0, semBanco: true };
  const velha = 'aplicando:' + new Date(Date.now() - 5 * 60000).toISOString();
  await env.DB.prepare(`UPDATE alteracoes_cadastros SET banco_aplicado_em = NULL WHERE ${RESERVADO} AND banco_aplicado_em < ?`).bind(velha).run();
  const ocupado = await env.DB.prepare(`SELECT 1 FROM alteracoes_cadastros WHERE ${RESERVADO} LIMIT 1`).first();
  if (ocupado) return { aplicados: 0, erros: 0, parou: true, ocupado: true };
  const { results } = await env.DB.prepare(`SELECT id, tipo, acao, chave, dados FROM alteracoes_cadastros
    WHERE banco_aplicado_em IS NULL AND estado <> 'erro' ORDER BY id LIMIT ?`).bind(limite).all();
  let aplicados = 0, erros = 0, parou = false;
  for (const p of results || []) {
    const marca = 'aplicando:' + new Date().toISOString();
    const res = await env.DB.prepare('UPDATE alteracoes_cadastros SET banco_aplicado_em = ? WHERE id = ? AND banco_aplicado_em IS NULL').bind(marca, p.id).run();
    if (!(res.meta && res.meta.changes === 1)) { parou = true; break; }   // outra rodada pegou: ela segue na ordem
    let dados;
    try { dados = JSON.parse(p.dados || '{}'); } catch { dados = null; }
    const r = dados && typeof dados === 'object' ? await rpcFn(env, 'gestao_aplicar_cadastro',
      { p_tipo: p.tipo, p_acao: p.acao, p_chave: String(p.chave ?? ''), p_dados: dados }) : { ok: false, erro: 'dados do pedido inválidos' };
    if (r == null) {   // banco fora do ar: libera e tenta na próxima varredura, na mesma ordem
      await env.DB.prepare('UPDATE alteracoes_cadastros SET banco_aplicado_em = NULL WHERE id = ? AND banco_aplicado_em = ?').bind(p.id, marca).run();
      parou = true;
      break;
    }
    const msg = r.ok ? 'linha ' + r.linha : 'erro: ' + String(r.erro || 'desconhecido');
    await env.DB.prepare(`UPDATE alteracoes_cadastros SET banco_aplicado_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), banco_mensagem = ?
      WHERE id = ? AND banco_aplicado_em = ?`).bind(msg.slice(0, 300), p.id, marca).run();
    if (r.ok) aplicados++; else erros++;
  }
  return { aplicados, erros, parou };
}

export function aplicarCadastrosDepois(context) {
  const t = aplicarCadastrosPendentes(context.env).catch((e) => console.error('cadastros no banco: ' + (e && e.message)));
  if (context.waitUntil) context.waitUntil(t);
  return t;
}
