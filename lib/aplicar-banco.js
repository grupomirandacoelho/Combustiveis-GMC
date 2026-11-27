// Migração 100% nuvem, etapa 15.2 passo 3 (19/11/2026; plano em docs/MIGRACAO-PASSO3.md): aplica no banco (Supabase,
// public.base_transacoes) os pedidos das filas do D1 que ainda não estão lá — lotes (consolidador_lotes: Consolidador, D-1 das APIs,
// Inclusão da bomba interna, "Incluir" da Conferência) e correções/exclusões (alteracoes_base_copia: Editar abastecimentos, Rateio das
// NFs, estornos, recálculo do KM, "Aplicar o do cartão"). Na ordem em que foram pedidos (uma correção pode ser de uma linha que um lote
// acabou de inserir). O "estado" da fila continua sendo o da planilha (o vigia segue gravando a Base_copia como cópia de segurança);
// aqui só banco_aplicado_em / banco_mensagem. Pedidos de antes da integração foram marcados 'anterior' e nunca são reaplicados.
// Chamado depois de cada gravação na fila (context.waitUntil) e de tempos em tempos (/api/sync/banco/aplicar).
import { rpc, temBanco } from './supabase.js';

export const LIMITE = 50;   // pedidos por rodada

// pedidos pendentes das duas filas, intercalados pela hora do pedido (empate: lote antes; dentro da mesma fila, pelo id)
export function ordenarPedidos(lotes, alteracoes) {
  return [...lotes.map((l) => ({ ...l, tipo: 'lote' })), ...alteracoes.map((a) => ({ ...a, tipo: 'alteracao' }))]
    .sort((x, y) => String(x.criado_em || '').localeCompare(String(y.criado_em || ''))
      || (x.tipo === y.tipo ? x.id - y.id : x.tipo === 'lote' ? -1 : 1));
}

// reserva o pedido antes de aplicar ('aplicando:<hora>'), para duas rodadas ao mesmo tempo (duas gravações seguidas) nunca aplicarem
// o mesmo pedido duas vezes — uma exclusão repetida poderia achar outra linha. Reserva com mais de 5 min = rodada que caiu: libera.
async function reservar(env, tabela, id, marca) {
  const r = await env.DB.prepare(`UPDATE ${tabela} SET banco_aplicado_em = ? WHERE id = ? AND banco_aplicado_em IS NULL`).bind(marca, id).run();
  return (r.meta && r.meta.changes) === 1;
}
async function liberar(env, tabela, id, marca) {
  await env.DB.prepare(`UPDATE ${tabela} SET banco_aplicado_em = NULL WHERE id = ? AND banco_aplicado_em = ?`).bind(id, marca).run();
}
async function marcar(env, tabela, id, marca, mensagem) {
  await env.DB.prepare(`UPDATE ${tabela} SET banco_aplicado_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), banco_mensagem = ?
    WHERE id = ? AND banco_aplicado_em = ?`).bind(String(mensagem).slice(0, 300), id, marca).run();
}
// pedido reservado ('aplicando:<hora>') como faixa, não LIKE: assim o SQLite usa o índice de banco_aplicado_em (0029) e não lê a
// tabela inteira a cada varredura (24/11/2026: a varredura de 2 em 2 min com LIKE leu 6,1 milhões de linhas num dia e estourou o
// limite diário do D1, derrubando o portal das 17:50 às 21:00)
export const RESERVADO = "banco_aplicado_em >= 'aplicando:' AND banco_aplicado_em < 'aplicando;'";
async function liberarAntigas(env) {
  const limite = 'aplicando:' + new Date(Date.now() - 5 * 60000).toISOString();
  for (const t of ['consolidador_lotes', 'alteracoes_base_copia']) {
    await env.DB.prepare(`UPDATE ${t} SET banco_aplicado_em = NULL WHERE ${RESERVADO} AND banco_aplicado_em < ?`).bind(limite).run();
  }
}

function lerJson(texto, padrao) {
  if (texto == null || texto === '') return padrao;
  try { return JSON.parse(texto); } catch { return undefined; }
}

// Recálculo do KM (23/11/2026, passo 4: sai do vigia): depois que um lote entra no banco, o banco diz qual abastecimento seguinte
// de cada linha inserida ainda tem o km antigo (gestao_km_seguintes, mesma regra do scripts/km_recalcular.mjs) e as correções vão
// para a fila como "Recálculo do KM (automático)": a próxima rodada aplica no banco e o vigia ainda grava na planilha de reserva.
// Só com o interruptor da nuvem ligado (nuvem_rotinas 'km-recalcular'); senão quem faz é o vigia, como antes.
export async function recalcularKm(env, ids) {
  try {
    if ((await rpc(env, 'gestao_nuvem_modo', { p_nome: 'km-recalcular' })) !== 'ligado') return 0;
    const itens = await rpc(env, 'gestao_km_seguintes', { p_ids: ids }, { ms: 20000 });
    if (!Array.isArray(itens) || !itens.length) return 0;
    const u = await env.DB.prepare('SELECT id FROM usuarios ORDER BY id LIMIT 1').first();
    if (!u) return 0;
    await env.DB.batch(itens.map((i) => env.DB.prepare(`INSERT INTO alteracoes_base_copia (usuario_id, usuario_nome, linha, placa, data, acao, celulas, antes, tanque)
      VALUES (?, 'Recálculo do KM (automático)', ?, ?, ?, 'editar', ?, ?, ?)`)
      .bind(u.id, i.linha, String(i.placa || '').slice(0, 10), i.data, JSON.stringify(i.celulas), JSON.stringify(i.antes || {}), i.tanque || null)));
    return itens.length;
  } catch (e) {
    console.error('recálculo do km: ' + (e && e.message));
    return 0;
  }
}

// aplica até LIMITE pedidos; devolve {aplicados, erros, restantes}. Banco fora do ar (rpc null): para e tenta na próxima rodada sem
// marcar, para manter a ordem. Erro do próprio pedido (linha não encontrada, JSON inválido): marca com a mensagem e segue.
export async function aplicarPendentes(env, { limite = LIMITE } = {}) {
  if (!temBanco(env) || !env.DB) return { aplicados: 0, erros: 0, semBanco: true };
  await liberarAntigas(env);
  // outra rodada em andamento: ela aplica na ordem; esta não pula na frente
  const ocupado = await env.DB.prepare(`SELECT 1 FROM consolidador_lotes WHERE ${RESERVADO}
    UNION ALL SELECT 1 FROM alteracoes_base_copia WHERE ${RESERVADO} LIMIT 1`).first();
  if (ocupado) return { aplicados: 0, erros: 0, pendentes: 0, parou: true, ocupado: true };
  const [l, a] = await Promise.all([
    env.DB.prepare(`SELECT id, criado_em, linhas FROM consolidador_lotes
      WHERE banco_aplicado_em IS NULL AND estado <> 'erro' ORDER BY id LIMIT ?`).bind(limite).all(),
    env.DB.prepare(`SELECT id, criado_em, acao, linha, placa, data, celulas, tanque FROM alteracoes_base_copia
      WHERE banco_aplicado_em IS NULL AND estado <> 'erro' ORDER BY id LIMIT ?`).bind(limite).all(),
  ]);
  const pedidos = ordenarPedidos(l.results || [], a.results || []).slice(0, limite);
  let aplicados = 0, erros = 0, parou = false;
  for (const p of pedidos) {
    const tabela = p.tipo === 'lote' ? 'consolidador_lotes' : 'alteracoes_base_copia';
    const marca = 'aplicando:' + new Date().toISOString();
    // outra rodada já pegou este pedido: ela segue na ordem; esta para aqui
    if (!(await reservar(env, tabela, p.id, marca))) { parou = true; break; }
    let r, args, funcao;
    if (p.tipo === 'lote') {
      const linhas = lerJson(p.linhas, []);
      if (!Array.isArray(linhas)) { await marcar(env, tabela, p.id, marca, 'erro: linhas do lote inválidas'); erros++; continue; }
      funcao = 'gestao_aplicar_lote'; args = { p_linhas: linhas };
    } else {
      const celulas = lerJson(p.celulas, {});
      if (celulas === undefined || celulas === null || typeof celulas !== 'object' || Array.isArray(celulas)) {
        await marcar(env, tabela, p.id, marca, 'erro: células inválidas'); erros++; continue;
      }
      funcao = 'gestao_aplicar_alteracao';
      args = { p_acao: p.acao === 'excluir' ? 'excluir' : 'editar', p_linha: p.linha ?? null, p_placa: p.placa ?? null, p_data: p.data ?? null,
        p_celulas: celulas, p_tanque: p.tanque || null };
    }
    try { r = await rpc(env, funcao, args, { ms: 25000 }); } catch { r = null; }
    if (!r) { await liberar(env, tabela, p.id, marca); parou = true; break; }   // banco fora do ar: tenta depois, na mesma ordem
    // lote inserido: o km do abastecimento seguinte de cada linha pode precisar ser refeito (no lugar do km_recalcular do vigia)
    const km = p.tipo === 'lote' && r.ok && Array.isArray(r.ids) && r.ids.length ? await recalcularKm(env, r.ids) : 0;
    const msg = !r.ok ? 'erro: ' + (r.erro || '?')
      : p.tipo === 'lote' ? `inseridas ${r.inseridas || 0}, já estavam ${r.ignoradas || 0}` + (km ? `; km refeito em ${km} seguinte(s)` : '')
      : r.acao === 'excluir' ? 'excluído no banco' : 'corrigido no banco';
    await marcar(env, tabela, p.id, marca, msg);
    if (r.ok) aplicados++; else erros++;
  }
  return { aplicados, erros, pendentes: pedidos.length - aplicados - erros, parou };
}

// Vigia desligado (15.4, 27/11/2026): ninguém mais grava as planilhas nem marca os pedidos como 'aplicada'. Várias partes do portal
// esperam esse estado (cadastro nos cartões: novos e editados com estado 'aplicada'; listas "aguardando"; rateio da bomba), então o
// pedido que já está no banco fecha aqui: banco ok -> 'aplicada' (aplicada_em = agora); banco com erro -> 'erro' com a mensagem do
// banco. Só com a chave KV "vigia-desligado"; usa os índices (estado, id), então lê só os pedidos em aberto.
export const FILAS = ['consolidador_lotes', 'alteracoes_base_copia', 'alteracoes_cadastros', 'alteracoes_cartoes', 'alteracoes_bomba', 'alteracoes_postos', 'alteracoes_locais'];
const NO_BANCO = "banco_aplicado_em IS NOT NULL AND NOT (" + RESERVADO + ")";
export async function fecharNoBanco(env) {
  if (!env.DADOS || !(await env.DADOS.get('vigia-desligado'))) return { fechados: 0, desligado: false };
  let fechados = 0;
  for (const t of FILAS) {
    const ok = await env.DB.prepare(`UPDATE ${t} SET estado = 'aplicada', aplicada_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
      mensagem = coalesce(banco_mensagem, 'no banco') WHERE estado IN ('pendente', 'aguardando') AND ${NO_BANCO}
      AND (banco_mensagem IS NULL OR banco_mensagem NOT LIKE 'erro%')`).run();
    const er = await env.DB.prepare(`UPDATE ${t} SET estado = 'erro', mensagem = banco_mensagem
      WHERE estado IN ('pendente', 'aguardando') AND ${NO_BANCO} AND banco_mensagem LIKE 'erro%'`).run();
    fechados += (ok.meta.changes || 0) + (er.meta.changes || 0);
  }
  return { fechados, desligado: true };
}

// para as rotas: aplica em segundo plano depois de responder (nunca derruba a gravação na fila)
export function aplicarDepois(context) {
  const t = aplicarPendentes(context.env).then(() => fecharNoBanco(context.env)).catch((e) => console.error('aplicar no banco: ' + (e && e.message)));
  if (context.waitUntil) context.waitUntil(t);
  return t;
}
