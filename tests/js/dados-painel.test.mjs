// Dados dos painéis vindos do banco (19/11/2026): junta a parte dos abastecimentos (banco) com o que ainda vem das planilhas
// (KV abastecimentos-extras), guarda por versão e cai para a planilha quando o banco não tem os dados. Banco e KV simulados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { juntarJson, abastecimentosDoBanco, fonteBanco } from '../../lib/dados-painel.js';

test('juntarJson: une dois objetos sem transformar o texto', () => {
  assert.deepEqual(JSON.parse(juntarJson('{"linhas":2,"col":{"data":[1,2]}}', '{"locais":{},"orcamento":null}')),
    { linhas: 2, col: { data: [1, 2] }, locais: {}, orcamento: null });
  assert.equal(juntarJson('{"a":1}', '{}'), '{"a":1}');
  assert.throws(() => juntarJson('[1]', '{}'));
});

function kvFalso(inicial = {}) {
  const m = new Map(Object.entries(inicial).map(([k, v]) => [k, { value: v, metadata: null }]));
  return {
    m,
    async get(k, tipo) { const x = m.get(k); if (!x) return null; return tipo === 'json' ? JSON.parse(x.value) : x.value; },
    async getWithMetadata(k) { const x = m.get(k); return x ? { value: x.value, metadata: x.metadata } : { value: null, metadata: null }; },
    async put(k, v, op = {}) { m.set(k, { value: v, metadata: op.metadata || null }); },
  };
}
async function comBanco(respostas, fn) {
  const original = globalThis.fetch, chamadas = [];
  globalThis.fetch = async (url) => {
    const f = String(url).split('/rpc/')[1]; chamadas.push(f);
    const r = respostas[f];
    return r === undefined ? new Response('erro', { status: 500 }) : new Response(typeof r === 'string' ? r : JSON.stringify(r), { status: 200 });
  };
  try { await fn(chamadas); } finally { globalThis.fetch = original; }
}
const ENV = (kv) => ({ SUPABASE_URL: 'https://banco.exemplo', SUPABASE_KEY: 'chave', DADOS: kv });

test('abastecimentosDoBanco: monta, guarda por versão e reaproveita enquanto a versão não muda', async () => {
  const kv = kvFalso({ versao: '{"versao":"20261119080000"}', 'abastecimentos-extras': '{"locais":{"POSTO X":[1,2]}}', 'abastecimentos-fonte': 'banco' });
  const env = ENV(kv);
  await comBanco({ gestao_dados_painel_versao: { versao: '20261119084624' }, gestao_dados_painel: '{"linhas":1,"col":{"data":[20411]}}' }, async (chamadas) => {
    assert.equal(await fonteBanco(env), true);
    const a = await abastecimentosDoBanco(env);
    assert.equal(a.etag, '"b20261119084624-20261119080000"');
    assert.deepEqual(JSON.parse(a.corpo), { linhas: 1, col: { data: [20411] }, locais: { 'POSTO X': [1, 2] } });
    const b = await abastecimentosDoBanco(env);   // mesma versão: vem do KV, sem buscar o arquivo no banco de novo
    assert.equal(b.etag, a.etag);
    assert.equal(chamadas.filter((c) => c === 'gestao_dados_painel').length, 1);
  });
});

test('sem dados no banco (ou chave desligada): devolve null e o portal usa a planilha', async () => {
  const kv = kvFalso({ versao: '{"versao":"1"}', 'abastecimentos-extras': '{}' });
  await comBanco({}, async () => {
    assert.equal(await abastecimentosDoBanco(ENV(kv)), null);
    assert.equal(await fonteBanco(ENV(kv)), false);              // chave não está em "banco"
    assert.equal(await fonteBanco({ DADOS: kv }), false);        // sem banco configurado
  });
});

// passo 2: lista do Editar abastecimentos e histórico do Consolidador (sem juntar nada; cada um com a sua chave)
test('geradoDoBanco: busca pela versão, guarda e reaproveita; chave por arquivo', async () => {
  const { geradoDoBanco, usaBanco, GERADOS } = await import('../../lib/dados-painel.js');
  assert.deepEqual(GERADOS, { 'base-copia.json': 'base-copia', 'consolidacao.json': 'consolidacao' });
  const kv = kvFalso({ 'base-copia-fonte': 'banco' });
  const env = ENV(kv);
  await comBanco({ gestao_dados_gerados_versao: { versao: '20261119092429' }, gestao_dados_gerados: '{"linhas":2,"col":{"linha":[2,3]}}' }, async (chamadas) => {
    assert.equal(await usaBanco(env, 'base-copia'), true);
    assert.equal(await usaBanco(env, 'consolidacao'), false);
    const a = await geradoDoBanco(env, 'base-copia');
    assert.equal(a.etag, '"b20261119092429"');
    assert.deepEqual(JSON.parse(a.corpo).col.linha, [2, 3]);
    await geradoDoBanco(env, 'base-copia');
    assert.equal(chamadas.filter((c) => c === 'gestao_dados_gerados').length, 1);
  });
});

// 15.3 item 3 (25/11/2026): preços e fornecedores da bomba interna do banco ("bomba-fonte" = "banco")
test('extras do banco: a bomba interna troca as chaves do KV e a versão dela entra no etag', async () => {
  const kv = kvFalso({ versao: '{"versao":"V"}', 'abastecimentos-fonte': 'banco', 'bomba-fonte': 'banco',
    'abastecimentos-extras': '{"locais":{"P":[1,2]},"negociacao":{"velha":1},"fornecedoresBomba":[["VELHO"]]}' });
  const env = ENV(kv);
  await comBanco({ gestao_dados_painel_versao: { versao: '7' }, gestao_dados_painel: '{"linhas":1}', gestao_bomba_versao: '"abcdef0123456789"',   // a API devolve texto como string JSON
    gestao_bomba_extras: { negociacao: { dic: {}, col: { preco: [5.1] } }, fornecedoresBomba: [['NOVO', 'ARLA', 'SP', true, null]] } }, async () => {
    const a = await abastecimentosDoBanco(env);
    assert.equal(a.etag, '"b7-V-abcdef012345"');
    assert.deepEqual(JSON.parse(a.corpo), { linhas: 1, locais: { P: [1, 2] }, negociacao: { dic: {}, col: { preco: [5.1] } },
      fornecedoresBomba: [['NOVO', 'ARLA', 'SP', true, null]] });
  });
  // chave desligada: fica a do KV e o etag não muda de formato
  kv.m.delete('bomba-fonte'); kv.m.delete('abastecimentos-nuvem');
  await comBanco({ gestao_dados_painel_versao: { versao: '7' }, gestao_dados_painel: '{"linhas":1}' }, async () => {
    const a = await abastecimentosDoBanco(env);
    assert.equal(a.etag, '"b7-V"');
    assert.deepEqual(JSON.parse(a.corpo).fornecedoresBomba, [['VELHO']]);
  });
});

test('cadastro dos fornecedores da bomba: do banco com a chave ligada, senão do KV', async () => {
  const { cadastroFornecedores } = await import('../../lib/bomba.js');
  const DB = { prepare: () => ({ all: async () => ({ results: [] }) }) };
  const kv = kvFalso({ 'fornecedores-bomba': JSON.stringify({ fornecedores: [['KV', 'DIESEL', 'SP', true, null]] }) });
  await comBanco({ gestao_bomba_fornecedores_lista: [['BANCO', 'ARLA', 'BA', false, '12345678000199']] }, async () => {
    assert.equal((await cadastroFornecedores({ ...ENV(kv), DB }))[0].fornecedor, 'KV');
    kv.m.set('bomba-fonte', { value: 'banco', metadata: null });
    const l = await cadastroFornecedores({ ...ENV(kv), DB });
    assert.deepEqual(l, [{ fornecedor: 'BANCO', produto: 'ARLA', unidade: 'BA', ativo: false, cnpj: '12345678000199' }]);
  });
});

test('extras do banco: negociações e coordenadas dos postos ("postos-fonte"), versão vinda como {versao}', async () => {
  const kv = kvFalso({ versao: '{"versao":"V"}', 'abastecimentos-fonte': 'banco', 'postos-fonte': 'banco',
    'abastecimentos-extras': '{"negPostos":{"velho":1},"locais":{"A":[1,2]},"locaisSuspeitos":[],"orcamento":null}' });
  await comBanco({ gestao_dados_painel_versao: { versao: '7' }, gestao_dados_painel: '{"linhas":1}',
    gestao_postos_info: { versao: '0123456789abcdef', atualizadoEm: 'x' },
    gestao_postos_extras: { negPostos: { dic: {}, col: {}, limites: {} }, locais: { B: [3, 4] }, locaisSuspeitos: [{ nome: 'C' }] } }, async () => {
    const a = await abastecimentosDoBanco(ENV(kv));
    assert.equal(a.etag, '"b7-V-0123456789ab"');
    assert.deepEqual(JSON.parse(a.corpo), { linhas: 1, negPostos: { dic: {}, col: {}, limites: {} }, locais: { B: [3, 4] },
      locaisSuspeitos: [{ nome: 'C' }], orcamento: null });
  });
});

// 25/11/2026: o aviso "Atualizar: dados novos" (/api/dados/versao) usa a mesma versão do ETag do arquivo; com todas as partes no
// banco, a carga do vigia (KV "versao") não entra (senão cada Base salva acendia o aviso sem nada novo nos painéis)
test('versaoDoBanco: mesma do etag do arquivo; sem a versão do vigia quando todas as partes vêm do banco', async () => {
  const { versaoDoBanco } = await import('../../lib/dados-painel.js');
  const { versaoDoEtag } = await import('../../functions/api/dados/versao.js');
  const kv = kvFalso({ versao: '{"versao":"VIGIA"}', 'abastecimentos-fonte': 'banco', 'bomba-fonte': 'banco', 'postos-fonte': 'banco',
    'orcamento-fonte': 'banco', 'abastecimentos-extras': '{"negociacao":null,"fornecedoresBomba":null,"negPostos":null,"locais":{},"locaisSuspeitos":[],"orcamento":null}' });
  const respostas = { gestao_dados_painel_versao: { versao: '7', geradoEm: '2026-11-25T17:42:00+00:00' }, gestao_dados_painel: '{"linhas":1}',
    gestao_bomba_versao: '"aaaaaaaaaaaaaaaa"', gestao_postos_info: { versao: 'bbbbbbbbbbbbbbbb' }, gestao_orcamento_info: { versao: 'cccccccccccccccc' },
    gestao_bomba_extras: { negociacao: 1, fornecedoresBomba: [] }, gestao_postos_extras: { negPostos: 2, locais: {}, locaisSuspeitos: [] },
    gestao_orcamento_extras: { orcamento: 3 } };
  await comBanco(respostas, async () => {
    const v = await versaoDoBanco(ENV(kv));
    assert.equal(v.etag, '"b7-aaaaaaaaaaaa-bbbbbbbbbbbb-cccccccccccc"');
    assert.equal((await abastecimentosDoBanco(ENV(kv))).etag, v.etag);
    assert.equal(versaoDoEtag(v.etag), 'b7-aaaaaaaaaaaa-bbbbbbbbbbbb-cccccccccccc');
    assert.equal(versaoDoEtag('W/' + v.etag), versaoDoEtag(v.etag));   // a Cloudflare pode enfraquecer o ETag ao comprimir
  });
  // uma parte sem versão (banco lento): ela fica com a planilha e a versão do vigia volta a contar
  delete respostas.gestao_orcamento_info;
  await comBanco(respostas, async () => {
    assert.equal((await versaoDoBanco(ENV(kv))).etag, '"b7-VIGIA-aaaaaaaaaaaa-bbbbbbbbbbbb"');
  });
});
