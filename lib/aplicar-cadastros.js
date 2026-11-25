// Migração 15.3 (25/11/2026; plano em docs/MIGRACAO-15-3.md): aplica no banco (Supabase) os pedidos das filas das planilhas de
// cadastro, na ordem em que foram pedidos:
//   alteracoes_cadastros (placas e motoristas, e os números devolvidos pelas APIs dos cartões) -> gestao_aplicar_cadastro  (item 1)
//   alteracoes_cartoes   (controle dos cartões frota)                                         -> gestao_aplicar_cartao    (item 2)
//   alteracoes_bomba     (Preço bomba interna: negociações e fornecedores)                    -> gestao_aplicar_bomba     (item 3)
// O "estado" da fila continua sendo o da planilha (o vigia segue gravando como cópia); aqui só banco_aplicado_em / banco_mensagem.
// Mesmo jeito do lib/aplicar-banco.js: reserva ('aplicando:<hora>') antes de aplicar, banco fora do ar para sem marcar (tenta de
// novo na mesma ordem), erro do próprio pedido fica anotado e a fila segue. Chamado depois de cada gravação na fila
// (context.waitUntil) e pela varredura (/api/sync/banco/aplicar, pg_cron a cada 2 min).
import { rpc, temBanco } from './supabase.js';
import { RESERVADO } from './aplicar-banco.js';

export const LIMITE_CADASTROS = 30;

export const FILAS = {
  cadastros: { tabela: 'alteracoes_cadastros', colunas: 'id, tipo, acao, chave, dados', funcao: 'gestao_aplicar_cadastro',
    args: (p, dados) => ({ p_tipo: p.tipo, p_acao: p.acao, p_chave: String(p.chave ?? ''), p_dados: dados }),
    // virada de 25/11/2026: placa mudou no banco -> o controle dos cartões segue o cadastro (placa com motor entra, desabilitada sai),
    // como o vigia fazia na planilha (planilha_cartoes.py sincronizar)
    depois: async (env, aplicadosOk, rpcFn) => {
      if (aplicadosOk.some((p) => p.tipo === 'placas')) await rpcFn(env, 'gestao_sincronizar_cartoes', { p_gravar: true });
    } },
  cartoes: { tabela: 'alteracoes_cartoes', colunas: 'id, acao, chave, dados', funcao: 'gestao_aplicar_cartao',
    args: (p, dados) => ({ p_acao: p.acao, p_chave: String(p.chave ?? ''), p_dados: dados }) },
  bomba: { tabela: 'alteracoes_bomba', colunas: 'id, tipo, dados', funcao: 'gestao_aplicar_bomba',
    args: (p, dados) => ({ p_tipo: p.tipo, p_dados: dados }) },
};

export async function aplicarFila(env, nome, { limite = LIMITE_CADASTROS, rpcFn = rpc } = {}) {
  if (!temBanco(env) || !env.DB) return { aplicados: 0, erros: 0, semBanco: true };
  const { tabela, colunas, funcao, args, depois } = FILAS[nome];
  const velha = 'aplicando:' + new Date(Date.now() - 5 * 60000).toISOString();
  await env.DB.prepare(`UPDATE ${tabela} SET banco_aplicado_em = NULL WHERE ${RESERVADO} AND banco_aplicado_em < ?`).bind(velha).run();
  const ocupado = await env.DB.prepare(`SELECT 1 FROM ${tabela} WHERE ${RESERVADO} LIMIT 1`).first();
  if (ocupado) return { aplicados: 0, erros: 0, parou: true, ocupado: true };
  const { results } = await env.DB.prepare(`SELECT ${colunas} FROM ${tabela}
    WHERE banco_aplicado_em IS NULL AND estado <> 'erro' ORDER BY id LIMIT ?`).bind(limite).all();
  let aplicados = 0, erros = 0, parou = false;
  const ok = [];
  for (const p of results || []) {
    const marca = 'aplicando:' + new Date().toISOString();
    const res = await env.DB.prepare(`UPDATE ${tabela} SET banco_aplicado_em = ? WHERE id = ? AND banco_aplicado_em IS NULL`).bind(marca, p.id).run();
    if (!(res.meta && res.meta.changes === 1)) { parou = true; break; }   // outra rodada pegou: ela segue na ordem
    let dados;
    try { dados = JSON.parse(p.dados || '{}'); } catch { dados = null; }
    const r = dados && typeof dados === 'object' ? await rpcFn(env, funcao, args(p, dados)) : { ok: false, erro: 'dados do pedido inválidos' };
    if (r == null) {   // banco fora do ar: libera e tenta na próxima varredura, na mesma ordem
      await env.DB.prepare(`UPDATE ${tabela} SET banco_aplicado_em = NULL WHERE id = ? AND banco_aplicado_em = ?`).bind(p.id, marca).run();
      parou = true;
      break;
    }
    const msg = r.ok ? 'linha ' + r.linha : 'erro: ' + String(r.erro || 'desconhecido');
    await env.DB.prepare(`UPDATE ${tabela} SET banco_aplicado_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), banco_mensagem = ?
      WHERE id = ? AND banco_aplicado_em = ?`).bind(msg.slice(0, 300), p.id, marca).run();
    if (r.ok) { aplicados++; ok.push(p); } else erros++;
  }
  if (depois && ok.length) {
    try { await depois(env, ok, rpcFn); } catch (e) { console.error(nome + ' (depois): ' + (e && e.message)); }
  }
  return { aplicados, erros, parou };
}

export const aplicarCadastrosPendentes = (env, opcoes) => aplicarFila(env, 'cadastros', opcoes);
export const aplicarCartoesPendentes = (env, opcoes) => aplicarFila(env, 'cartoes', opcoes);
export const aplicarBombaPendentes = (env, opcoes) => aplicarFila(env, 'bomba', opcoes);

// depois de gravar na fila: aplica em segundo plano (nome = 'cadastros' ou 'cartoes')
export function aplicarCadastrosDepois(context, nome = 'cadastros') {
  const t = aplicarFila(context.env, nome).catch((e) => console.error(nome + ' no banco: ' + (e && e.message)));
  if (context.waitUntil) context.waitUntil(t);
  return t;
}
