// 15.4 (27/11/2026, pedido do usuário: desligar o vigia depois das comparações): chave KV "vigia-desligado" = nenhum computador
// recebe o plantão, nem o principal nem o reserva; o sinal continua anotado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { onRequestPost, CHAVE_DESLIGADO } from '../../functions/api/sync/plantao.js';

function ambiente(kv) {
  const sql = [];
  const DB = { prepare: (q) => ({ bind: (...a) => ({ run: async () => { sql.push([q, a]); return { meta: { changes: 1 } }; },
    first: async () => ({ maquina: 'Kemigas', desde: 1, renovado: 1 }), all: async () => ({ results: [{ maquina: 'Kemigas', prioridade: 1 }] }) }),
    run: async () => { sql.push([q, []]); return { meta: { changes: 1 } }; }, first: async () => ({ maquina: 'Kemigas', desde: 1, renovado: 1 }) }) };
  return { sql, env: { DB, DADOS: { get: async (k) => kv[k] ?? null }, SYNC_TOKEN: 't' } };
}
const pedido = (corpo) => new Request('https://x/api/sync/plantao', { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });

test('com a chave vigia-desligado ninguém fica de plantão e o plantão é esvaziado', async () => {
  const { sql, env } = ambiente({ [CHAVE_DESLIGADO]: '1' });
  for (const [maquina, prioridade] of [['Kemigas', 1], ['LAPTOP', 2]]) {
    const r = await (await onRequestPost({ request: pedido({ maquina, prioridade }), env })).json();
    assert.equal(r.ativo, false, maquina);
    assert.equal(r.desligado, true);
  }
  assert.ok(sql.some(([q]) => /INSERT INTO vigias/.test(q)), 'o sinal continua anotado');
  assert.ok(sql.some(([q]) => /UPDATE plantao SET maquina = NULL/.test(q)));
});

test('o vigia não manda mais os reajustes e reajustes.json saiu da lista de arquivos', () => {
  const s = fs.readFileSync(new URL('../../scripts/sincronizar.mjs', import.meta.url), 'utf8');
  const volta = s.slice(s.indexOf("if (process.argv.includes('--vigiar'))"), s.indexOf("} else if (process.argv.includes('--reajustes'))"));
  assert.doesNotMatch(volta, /processarReajustes\(/);
  assert.doesNotMatch(fs.readFileSync(new URL('../../functions/gestao/dados/[arquivo].js', import.meta.url), 'utf8'), /'reajustes\.json'/);
});

test('vigia desligado: o pedido que já está no banco fecha como aplicada (ok) ou erro (erro do banco), em todas as filas', async () => {
  const { fecharNoBanco, FILAS } = await import('../../lib/aplicar-banco.js');
  const sql = [];
  const DB = { prepare: (q) => ({ run: async () => { sql.push(q); return { meta: { changes: 1 } }; } }) };
  assert.deepEqual(await fecharNoBanco({ DB, DADOS: { get: async () => null } }), { fechados: 0, desligado: false });
  assert.equal(sql.length, 0, 'com o vigia ligado não mexe em nada');
  const r = await fecharNoBanco({ DB, DADOS: { get: async (k) => (k === 'vigia-desligado' ? '1' : null) } });
  assert.equal(r.desligado, true);
  assert.equal(sql.length, FILAS.length * 2);
  assert.equal(FILAS.length, 7);
  for (const q of sql) {
    assert.match(q, /WHERE estado IN \('pendente', 'aguardando'\)/);   // usa o índice (estado, id)
    assert.match(q, /banco_aplicado_em IS NOT NULL AND NOT \(banco_aplicado_em >= 'aplicando:'/);   // nunca o que está sendo aplicado agora
  }
  assert.ok(sql.some((q) => /SET estado = 'aplicada', aplicada_em/.test(q) && /NOT LIKE 'erro%'/.test(q)));
  assert.ok(sql.some((q) => /SET estado = 'erro', mensagem = banco_mensagem/.test(q)));
});
