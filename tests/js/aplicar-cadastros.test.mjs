// 15.3 item 1 passo 2 (25/11/2026): fila de placas e motoristas aplicada no banco (lib/aplicar-cadastros.js). Roda num SQLite de
// verdade com todas as migrações do D1, por um adaptador com a mesma API do D1 (prepare/bind/run/first/all).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { aplicarCadastrosPendentes, aplicarCartoesPendentes, aplicarBombaPendentes } from '../../lib/aplicar-cadastros.js';

const PASTA = new URL('../../migrations/', import.meta.url);
function d1() {
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(PASTA).filter((n) => n.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(f, PASTA), 'utf8'));
  db.exec('PRAGMA foreign_keys = OFF');
  const prep = (sql) => {
    let args = [];
    const st = {
      bind(...a) { args = a; return st; },
      async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
    };
    return st;
  };
  return { db, DB: { prepare: prep } };
}
const env = (DB) => ({ DB, SUPABASE_URL: 'https://x', SUPABASE_KEY: 'k' });
const pedir = (db, id, tipo, acao, chave, dados, estado = 'pendente') => db.prepare(
  `INSERT INTO alteracoes_cadastros (id, usuario_id, usuario_nome, tipo, acao, chave, dados, estado) VALUES (?, 1, 'x', ?, ?, ?, ?, ?)`)
  .run(id, tipo, acao, chave, JSON.stringify(dados), estado);
const estado = (db) => db.prepare('SELECT id, banco_aplicado_em, banco_mensagem FROM alteracoes_cadastros ORDER BY id').all()
  .map((r) => [r.id, r.banco_aplicado_em === null ? null : r.banco_aplicado_em.startsWith('20') ? 'ok' : r.banco_aplicado_em, r.banco_mensagem]);

test('aplica na ordem, anota a linha ou o erro de cada pedido e pula os de antes e os recusados pela planilha', async () => {
  const { db, DB } = d1();
  pedir(db, 1, 'placas', 'editar', 'AAA1A11', { meta: 3 });
  db.exec("UPDATE alteracoes_cadastros SET banco_aplicado_em = 'anterior'");   // pedido de antes da migração 0031
  pedir(db, 2, 'placas', 'adicionar', 'BBB2B22', { placa: 'BBB2B22' });
  pedir(db, 3, 'motoristas', 'editar', '000001', { situacao: 'DESLIGADO' });
  pedir(db, 4, 'placas', 'editar', 'CCC3C33', { meta: 1 }, 'erro');
  pedir(db, 5, 'motoristas', 'editar', '999999', { nome: 'X' });
  const chamadas = [];
  const rpcFn = async (_e, f, a) => {
    if (f === 'gestao_sincronizar_cartoes') return { gravado: true };   // depois das placas (virada de 25/11)
    chamadas.push([f, a.p_tipo, a.p_acao, a.p_chave]);
    return a.p_chave === '999999' ? { ok: false, erro: '999999 não está mais no cadastro' } : { ok: true, linha: 10 + chamadas.length };
  };
  const r = await aplicarCadastrosPendentes(env(DB), { rpcFn });
  assert.deepEqual(r, { aplicados: 2, erros: 1, parou: false });
  assert.deepEqual(chamadas.map((c) => c[3]), ['BBB2B22', '000001', '999999']);
  assert.equal(chamadas[0][0], 'gestao_aplicar_cadastro');
  assert.deepEqual(estado(db), [[1, 'anterior', null], [2, 'ok', 'linha 11'], [3, 'ok', 'linha 12'], [4, null, null],
    [5, 'ok', 'erro: 999999 não está mais no cadastro']]);
  // nada pendente: segunda rodada não chama o banco
  assert.deepEqual(await aplicarCadastrosPendentes(env(DB), { rpcFn }), { aplicados: 0, erros: 0, parou: false });
  assert.equal(chamadas.length, 3);
});

test('banco fora do ar: para sem marcar e tenta de novo depois, na mesma ordem', async () => {
  const { db, DB } = d1();
  pedir(db, 1, 'placas', 'editar', 'AAA1A11', { meta: 3 });
  pedir(db, 2, 'placas', 'editar', 'BBB2B22', { meta: 4 });
  const r = await aplicarCadastrosPendentes(env(DB), { rpcFn: async () => null });
  assert.equal(r.parou, true);
  assert.deepEqual(estado(db), [[1, null, null], [2, null, null]]);
  const ordem = [];
  await aplicarCadastrosPendentes(env(DB), { rpcFn: async (_e, f, a) => { if (f === 'gestao_aplicar_cadastro') ordem.push(a.p_chave); return { ok: true, linha: 1 }; } });
  assert.deepEqual(ordem, ['AAA1A11', 'BBB2B22']);
});

test('outra rodada em andamento: não aplica; reserva esquecida há mais de 5 min é liberada', async () => {
  const { db, DB } = d1();
  pedir(db, 1, 'placas', 'editar', 'AAA1A11', { meta: 3 });
  db.prepare('UPDATE alteracoes_cadastros SET banco_aplicado_em = ? WHERE id = 1').run('aplicando:' + new Date().toISOString());
  let n = 0;
  const rpcFn = async () => { n++; return { ok: true, linha: 1 }; };
  assert.equal((await aplicarCadastrosPendentes(env(DB), { rpcFn })).ocupado, true);
  assert.equal(n, 0);
  db.prepare('UPDATE alteracoes_cadastros SET banco_aplicado_em = ? WHERE id = 1').run('aplicando:2026-01-01T00:00:00.000Z');
  assert.equal((await aplicarCadastrosPendentes(env(DB), { rpcFn })).aplicados, 1);
});

test('sem banco configurado: não faz nada', async () => {
  const { DB } = d1();
  assert.equal((await aplicarCadastrosPendentes({ DB })).semBanco, true);
});

test('cartões frota: fila própria (alteracoes_cartoes) com gestao_aplicar_cartao; os de antes ficam de fora', async () => {
  const { db, DB } = d1();
  const pedirCartao = (id, acao, chave, dados) => db.prepare(
    `INSERT INTO alteracoes_cartoes (id, usuario_id, usuario_nome, acao, chave, dados) VALUES (?, 1, 'x', ?, ?, ?)`).run(id, acao, chave, JSON.stringify(dados));
  pedirCartao(1, 'editar', 'AAA1A11', { ticket: 'ATIVO' });
  db.exec("UPDATE alteracoes_cartoes SET banco_aplicado_em = 'anterior'");
  pedirCartao(2, 'adicionar', 'BBB2B22', { truckpag: 'SEM CARTÃO' });
  pedir(db, 3, 'placas', 'editar', 'CCC3C33', { meta: 1 });   // a fila dos cadastros não entra nesta rodada
  const chamadas = [];
  const r = await aplicarCartoesPendentes(env(DB), { rpcFn: async (_e, f, a) => { chamadas.push([f, a]); return { ok: true, linha: 7 }; } });
  assert.deepEqual(r, { aplicados: 1, erros: 0, parou: false });
  assert.deepEqual(chamadas, [['gestao_aplicar_cartao', { p_acao: 'adicionar', p_chave: 'BBB2B22', p_dados: { truckpag: 'SEM CARTÃO' } }]]);
  assert.deepEqual(db.prepare('SELECT banco_mensagem FROM alteracoes_cartoes ORDER BY id').all().map((x) => x.banco_mensagem), [null, 'linha 7']);
  assert.equal(db.prepare('SELECT banco_aplicado_em FROM alteracoes_cadastros WHERE id = 3').get().banco_aplicado_em, null);
});

test('placa alterada no banco: o controle dos cartões segue o cadastro (gestao_sincronizar_cartoes); só motorista não chama', async () => {
  const { db, DB } = d1();
  pedir(db, 1, 'motoristas', 'editar', '000001', { situacao: 'DESLIGADO' });
  const chamadas = [];
  const rpcFn = async (_e, f, a) => { chamadas.push([f, a.p_gravar]); return { ok: true, linha: 1 }; };
  await aplicarCadastrosPendentes(env(DB), { rpcFn });
  assert.deepEqual(chamadas.map((c) => c[0]), ['gestao_aplicar_cadastro']);
  pedir(db, 2, 'placas', 'editar', 'AAA1A11', { situacao: 'VENDIDO' });
  await aplicarCadastrosPendentes(env(DB), { rpcFn });
  assert.deepEqual(chamadas.slice(1), [['gestao_aplicar_cadastro', undefined], ['gestao_sincronizar_cartoes', true]]);
});

test('preço bomba interna: fila própria (alteracoes_bomba) com gestao_aplicar_bomba, na ordem', async () => {
  const { db, DB } = d1();
  const pedirBomba = (id, tipo, dados) => db.prepare(
    `INSERT INTO alteracoes_bomba (id, usuario_id, usuario_nome, tipo, dados) VALUES (?, 1, 'x', ?, ?)`).run(id, tipo, JSON.stringify(dados));
  pedirBomba(1, 'negociacao', { data: '2026-11-01', fornecedor: 'A', produto: 'DIESEL', unidade: 'SP', preco: 5 });
  db.exec("UPDATE alteracoes_bomba SET banco_aplicado_em = 'anterior'");
  pedirBomba(2, 'negociacao', { data: '2026-11-25', fornecedor: 'A', produto: 'DIESEL', unidade: 'SP', preco: 5.3 });
  pedirBomba(3, 'fornecedor', { fornecedor: 'B', produto: 'ARLA', unidades: ['SP'], ativo: true });
  const chamadas = [];
  const r = await aplicarBombaPendentes(env(DB), { rpcFn: async (_e, f, a) => { chamadas.push([f, a.p_tipo]); return { ok: true, linha: a.p_tipo === 'fornecedor' ? null : 9 }; } });
  assert.deepEqual(r, { aplicados: 2, erros: 0, parou: false });
  assert.deepEqual(chamadas, [['gestao_aplicar_bomba', 'negociacao'], ['gestao_aplicar_bomba', 'fornecedor']]);
  assert.deepEqual(db.prepare('SELECT banco_mensagem FROM alteracoes_bomba ORDER BY id').all().map((x) => x.banco_mensagem), [null, 'linha 9', 'linha null']);
});
