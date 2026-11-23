// Migração 100% nuvem, 15.2 passo 3 (19/11/2026): os pedidos das filas (lotes e correções) são aplicados também direto no banco, na
// ordem em que foram pedidos, sem aplicar duas vezes, e o que falha por banco fora do ar fica para a próxima rodada. D1 e banco simulados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ordenarPedidos, aplicarPendentes } from '../../lib/aplicar-banco.js';

// D1 falso: só o que o aplicador usa (filas em memória)
function d1Falso({ lotes = [], alteracoes = [] } = {}) {
  const t = { consolidador_lotes: lotes, alteracoes_base_copia: alteracoes };
  const tabela = (sql) => (sql.includes('consolidador_lotes') ? 'consolidador_lotes' : 'alteracoes_base_copia');
  const inseridas = [];
  return {
    t, inseridas,
    async batch(stmts) { for (const st of stmts) inseridas.push(st.args); return []; },
    prepare(sql) {
      let args = [];
      const st = {
        get args() { return args; },
        bind(...a) { args = a; return st; },
        async first() {
          if (/FROM usuarios/.test(sql)) return { id: 1 };
          if (sql.includes("LIKE 'aplicando:%'")) {
            return Object.values(t).flat().some((r) => String(r.banco_aplicado_em || '').startsWith('aplicando:')) ? { 1: 1 } : null;
          }
          throw new Error('first não esperado: ' + sql);
        },
        async all() {
          const lim = args[0];
          const rs = t[tabela(sql)].filter((r) => r.banco_aplicado_em == null && r.estado !== 'erro').sort((x, y) => x.id - y.id).slice(0, lim);
          return { results: rs.map((r) => ({ ...r })) };
        },
        async run() {
          const linhas = t[tabela(sql)];
          let changes = 0;
          if (sql.includes("LIKE 'aplicando:%' AND banco_aplicado_em < ?")) {
            for (const r of linhas) if (String(r.banco_aplicado_em || '').startsWith('aplicando:') && r.banco_aplicado_em < args[0]) { r.banco_aplicado_em = null; changes++; }
          } else if (sql.includes('banco_mensagem = ?')) {          // marcar
            const [msg, id, marca] = args;
            const r = linhas.find((x) => x.id === id && x.banco_aplicado_em === marca);
            if (r) { r.banco_aplicado_em = '2026-11-19T12:00:00Z'; r.banco_mensagem = msg; changes = 1; }
          } else if (sql.includes('banco_aplicado_em = NULL')) {    // liberar
            const [id, marca] = args;
            const r = linhas.find((x) => x.id === id && x.banco_aplicado_em === marca);
            if (r) { r.banco_aplicado_em = null; changes = 1; }
          } else {                                                    // reservar
            const [marca, id] = args;
            const r = linhas.find((x) => x.id === id && x.banco_aplicado_em == null);
            if (r) { r.banco_aplicado_em = marca; changes = 1; }
          }
          return { meta: { changes } };
        },
      };
      return st;
    },
  };
}
async function comBanco(responder, fn) {
  const original = globalThis.fetch, chamadas = [];
  globalThis.fetch = async (url, op) => {
    const f = String(url).split('/rpc/')[1], corpo = JSON.parse(op.body);
    chamadas.push([f, corpo]);
    const r = responder(f, corpo);
    return r === null ? new Response('fora', { status: 503 }) : new Response(JSON.stringify(r), { status: 200 });
  };
  try { await fn(chamadas); } finally { globalThis.fetch = original; }
}
const ENV = (DB) => ({ SUPABASE_URL: 'https://banco.exemplo', SUPABASE_KEY: 'chave', DB });
const lote = (id, criado_em, extra = {}) => ({ id, criado_em, linhas: JSON.stringify([['CONSOLIDADOR', id]]), estado: 'pendente', banco_aplicado_em: null, ...extra });
const alt = (id, criado_em, extra = {}) => ({ id, criado_em, acao: 'editar', linha: 10, placa: 'ABC1D23', data: 46000.5, celulas: '{"R":120}', tanque: null,
  estado: 'pendente', banco_aplicado_em: null, ...extra });

test('ordenarPedidos: intercala lotes e correções pela hora do pedido', () => {
  const o = ordenarPedidos([lote(1, '2026-11-19 10:00:00'), lote(2, '2026-11-19 10:05:00')], [alt(7, '2026-11-19 10:02:00'), alt(8, '2026-11-19 10:05:00')]);
  assert.deepEqual(o.map((p) => p.tipo + p.id), ['lote1', 'alteracao7', 'lote2', 'alteracao8']);
});

test('aplica na ordem, chama as funções certas e marca cada pedido com o resultado', async () => {
  const DB = d1Falso({ lotes: [lote(1, '2026-11-19 10:00:00')], alteracoes: [alt(7, '2026-11-19 10:01:00'), alt(8, '2026-11-19 10:02:00', { acao: 'excluir', celulas: '{}', tanque: 'arla' })] });
  await comBanco((f, c) => (f === 'gestao_aplicar_lote' ? { ok: true, inseridas: 1, ignoradas: 0 }
    : c.p_acao === 'excluir' ? { ok: true, acao: 'excluir' } : { ok: true, acao: 'editar' }), async (chamadas) => {
    const r = await aplicarPendentes(ENV(DB));
    assert.equal(r.aplicados, 3);
    assert.deepEqual(chamadas.map((c) => c[0]), ['gestao_aplicar_lote', 'gestao_aplicar_alteracao', 'gestao_aplicar_alteracao']);
    assert.deepEqual(chamadas[0][1], { p_linhas: [['CONSOLIDADOR', 1]] });
    assert.deepEqual(chamadas[1][1], { p_acao: 'editar', p_linha: 10, p_placa: 'ABC1D23', p_data: 46000.5, p_celulas: { R: 120 }, p_tanque: null });
    assert.equal(chamadas[2][1].p_tanque, 'arla');
  });
  assert.equal(DB.t.consolidador_lotes[0].banco_mensagem, 'inseridas 1, já estavam 0');
  assert.equal(DB.t.alteracoes_base_copia[0].banco_mensagem, 'corrigido no banco');
  assert.equal(DB.t.alteracoes_base_copia[1].banco_mensagem, 'excluído no banco');
  await comBanco(() => { throw new Error('não deveria chamar'); }, async () => {
    assert.equal((await aplicarPendentes(ENV(DB))).aplicados, 0);       // nada de novo: não reaplica
  });
});

test('banco fora do ar: para sem marcar e tenta de novo depois, na mesma ordem', async () => {
  const DB = d1Falso({ lotes: [lote(1, '2026-11-19 10:00:00')], alteracoes: [alt(7, '2026-11-19 10:01:00')] });
  await comBanco(() => null, async (chamadas) => {
    const r = await aplicarPendentes(ENV(DB));
    assert.equal(r.parou, true);
    assert.equal(chamadas.length, 1);                                    // não pulou para a correção seguinte
  });
  assert.equal(DB.t.consolidador_lotes[0].banco_aplicado_em, null);
  await comBanco(() => ({ ok: true, inseridas: 0, ignoradas: 1, acao: 'editar' }), async () => {
    assert.equal((await aplicarPendentes(ENV(DB))).aplicados, 2);
  });
});

test('erro do pedido (linha não encontrada, JSON quebrado) fica registrado e não trava a fila; anteriores e erros da planilha ficam de fora', async () => {
  const DB = d1Falso({
    lotes: [lote(1, '2026-11-19 09:00:00', { banco_aplicado_em: 'anterior' }), lote(2, '2026-11-19 09:30:00', { estado: 'erro' }), lote(3, '2026-11-19 10:00:00', { linhas: '{quebrado' })],
    alteracoes: [alt(7, '2026-11-19 10:01:00'), alt(8, '2026-11-19 10:02:00')],
  });
  let primeira = true;
  await comBanco(() => {
    if (primeira) { primeira = false; return { ok: false, erro: 'abastecimento não encontrado no banco (placa ABC1D23)' }; }
    return { ok: true, acao: 'editar' };
  }, async (chamadas) => {
    const r = await aplicarPendentes(ENV(DB));
    assert.deepEqual([r.aplicados, r.erros], [1, 2]);
    assert.equal(chamadas.length, 2);                                    // o lote quebrado nem chega ao banco
  });
  assert.equal(DB.t.consolidador_lotes[0].banco_aplicado_em, 'anterior');
  assert.equal(DB.t.consolidador_lotes[1].banco_aplicado_em, null);
  assert.equal(DB.t.consolidador_lotes[2].banco_mensagem, 'erro: linhas do lote inválidas');
  assert.match(DB.t.alteracoes_base_copia[0].banco_mensagem, /^erro: abastecimento não encontrado/);
  assert.equal(DB.t.alteracoes_base_copia[1].banco_mensagem, 'corrigido no banco');
});

test('outra rodada em andamento: não aplica nada (nem pula na frente); reserva esquecida há mais de 5 min é liberada', async () => {
  const recente = 'aplicando:' + new Date().toISOString();
  const DB = d1Falso({ lotes: [lote(1, '2026-11-19 10:00:00', { banco_aplicado_em: recente })], alteracoes: [alt(7, '2026-11-19 10:01:00')] });
  await comBanco(() => ({ ok: true, acao: 'editar' }), async (chamadas) => {
    const r = await aplicarPendentes(ENV(DB));
    assert.equal(r.ocupado, true);
    assert.equal(chamadas.length, 0);
  });
  DB.t.consolidador_lotes[0].banco_aplicado_em = 'aplicando:2026-01-01T00:00:00.000Z';
  await comBanco(() => ({ ok: true, inseridas: 1, ignoradas: 0, acao: 'editar' }), async () => {
    assert.equal((await aplicarPendentes(ENV(DB))).aplicados, 2);
  });
});

test('sem banco configurado: não faz nada', async () => {
  assert.equal((await aplicarPendentes({ DB: d1Falso() })).semBanco, true);
});

// Recálculo do KM (23/11/2026, passo 4): lote aplicado no banco -> correções do abastecimento seguinte na fila (só com o
// interruptor 'km-recalcular' ligado), com o tanque para a planilha de reserva
test('lote inserido com o recálculo ligado: correções do km do seguinte vão para a fila', async () => {
  const DB = d1Falso({ lotes: [lote(1, '2026-11-23 10:00:00')] });
  const item = { linha: 63100, placa: 'ABC1D23', data: 46349.5, tanque: 'diesel', celulas: { R: 300, S: 3 }, antes: { R: 500, S: 5 } };
  await comBanco((f) => (f === 'gestao_aplicar_lote' ? { ok: true, inseridas: 1, ignoradas: 0, ids: [77] }
    : f === 'gestao_nuvem_modo' ? 'ligado' : f === 'gestao_km_seguintes' ? [item] : null), async (chamadas) => {
    assert.equal((await aplicarPendentes(ENV(DB))).aplicados, 1);
    assert.deepEqual(chamadas.map((c) => c[0]), ['gestao_aplicar_lote', 'gestao_nuvem_modo', 'gestao_km_seguintes']);
    assert.deepEqual(chamadas[2][1], { p_ids: [77] });
  });
  assert.equal(DB.inseridas.length, 1);
  assert.deepEqual(DB.inseridas[0], [1, 63100, 'ABC1D23', 46349.5, '{"R":300,"S":3}', '{"R":500,"S":5}', 'diesel']);
  assert.equal(DB.t.consolidador_lotes[0].banco_mensagem, 'inseridas 1, já estavam 0; km refeito em 1 seguinte(s)');
});

test('recálculo desligado na nuvem: nada vai para a fila (o vigia faz)', async () => {
  const DB = d1Falso({ lotes: [lote(1, '2026-11-23 10:00:00')] });
  await comBanco((f) => (f === 'gestao_aplicar_lote' ? { ok: true, inseridas: 1, ignoradas: 0, ids: [77] } : f === 'gestao_nuvem_modo' ? 'desligado' : null), async (chamadas) => {
    await aplicarPendentes(ENV(DB));
    assert.deepEqual(chamadas.map((c) => c[0]), ['gestao_aplicar_lote', 'gestao_nuvem_modo']);
  });
  assert.equal(DB.inseridas.length, 0);
});
