// 15.3 item 1 (25/11/2026): lista de placas e motoristas da planilha (KV "cadastros") ou do banco (KV "cadastros-fonte" = "banco").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerCadastros, lerCartoes, limparCacheCadastros } from '../../lib/cadastros-fonte.js';

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

test('cartões frota: chave própria ("cartoes-fonte"), lista do banco ou do KV "cartoes"', async () => {
  limparCacheCadastros();
  const kv = (fonte) => ({ DADOS: { get: async (k, t) => (k === 'cartoes-fonte' ? fonte : k === 'cartoes' && t === 'json' ? { cartoes: [{ placa: 'KV' }] } : null) } });
  const rpcFn = async (_e, f) => (f === 'gestao_cartoes_lista' ? { cartoes: [{ placa: 'BANCO' }] } : null);
  assert.equal((await lerCartoes(kv(null), { rpcFn })).cartoes[0].placa, 'KV');
  assert.equal((await lerCartoes(kv('banco'), { rpcFn })).cartoes[0].placa, 'BANCO');
  limparCacheCadastros();
  assert.equal((await lerCartoes(kv('banco'), { rpcFn: async () => ({ cartoes: [] }) })).fonte, 'planilha');
});

// 15.3 itens 4 e 5 (25/11/2026): lista dos postos dos motoristas do banco ("postos-fonte" = "banco") ou do KV
test('lista dos postos: do banco (CSV e contagem) com a chave ligada; banco fora do ar ou lista vazia, do KV', async () => {
  const { lerPostos, limparCachePostos } = await import('../../lib/postos-fonte.js');
  const CSV = 'Unidade;Posto;Cidade;Status;Cartao;Latitude;Longitude;Aviso;Negociado;Tipo\nSalvador;POSTO A;SALVADOR - BA;OK;TICKET;-12.9;-38.5;;2026-11-25;POLO\n';
  const kv = (fonte) => ({ DADOS: { get: async (k, t) => (k === 'postos-fonte' ? fonte : k === 'postos' ? 'Unidade;Posto;KV\nx\n'
    : k === 'postos-info' && t === 'json' ? { atualizadoEm: 'kv', postos: 1 } : null) } });
  const original = globalThis.fetch;
  const resp = { gestao_postos_csv: JSON.stringify(CSV), gestao_postos_info: JSON.stringify({ versao: 'v', atualizadoEm: '2026-11-25T12:00:00Z' }) };
  globalThis.fetch = async (url) => new Response(resp[String(url).split('/rpc/')[1]] ?? 'erro', { status: resp[String(url).split('/rpc/')[1]] ? 200 : 500 });
  try {
    const env = (f) => ({ ...kv(f), SUPABASE_URL: 'https://b', SUPABASE_KEY: 'k' });
    limparCachePostos();
    assert.equal((await lerPostos(env(null))).fonte, 'planilha');
    const b = await lerPostos(env('banco'));
    assert.equal(b.fonte, 'banco'); assert.equal(b.csv, CSV); assert.deepEqual(b.info, { atualizadoEm: '2026-11-25T12:00:00Z', postos: 1 });
    limparCachePostos();
    resp.gestao_postos_csv = JSON.stringify('Unidade;Posto;Cidade\n');   // só o cabeçalho: não serve
    assert.equal((await lerPostos(env('banco'))).fonte, 'planilha');
  } finally { globalThis.fetch = original; }
});
