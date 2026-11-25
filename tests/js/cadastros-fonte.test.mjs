// 15.3 item 1 (25/11/2026): lista de placas e motoristas da planilha (KV "cadastros") ou do banco (KV "cadastros-fonte" = "banco").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerCadastros, limparCacheCadastros } from '../../lib/cadastros-fonte.js';

const PLANILHA = { placas: [{ linha: 2, placa: 'AAA1A11' }], motoristas: [{ linha: 2, nome: 'X', usuario: '000001' }], atualizadoEm: 'p' };
const BANCO = { placas: [{ linha: 2, placa: 'BBB2B22' }], motoristas: [{ linha: 2, nome: 'Y', usuario: '000002' }], atualizadoEm: 'b' };
const env = (fonte) => ({ DADOS: { get: async (k, t) => (k === 'cadastros-fonte' ? fonte : k === 'cadastros' && t === 'json' ? PLANILHA : null) } });

test('sem a chave: lista da planilha, sem chamar o banco', async () => {
  limparCacheCadastros();
  let chamou = 0;
  const c = await lerCadastros(env(null), { rpcFn: async () => { chamou++; return BANCO; } });
  assert.equal(c.fonte, 'planilha'); assert.equal(c.placas[0].placa, 'AAA1A11'); assert.equal(chamou, 0);
});

test('com "banco": lista do banco, guardada por 20 s', async () => {
  limparCacheCadastros();
  let chamou = 0, t = 1000;
  const op = { rpcFn: async (_e, f) => { chamou++; assert.equal(f, 'gestao_cadastros_lista'); return BANCO; }, agora: () => t };
  assert.equal((await lerCadastros(env('banco'), op)).motoristas[0].nome, 'Y');
  t += 10_000; await lerCadastros(env('banco'), op); assert.equal(chamou, 1);
  t += 15_000; await lerCadastros(env('banco'), op); assert.equal(chamou, 2);
});

test('banco fora do ar ou lista vazia: volta para a planilha', async () => {
  for (const resposta of [null, { placas: [], motoristas: [] }]) {
    limparCacheCadastros();
    const c = await lerCadastros(env('banco'), { rpcFn: async () => resposta });
    assert.equal(c.fonte, 'planilha');
  }
});
