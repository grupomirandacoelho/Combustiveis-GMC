// 15.3 item 6 (25/11/2026): envio do orçamento pela tela Real x Orçado. Leitura da planilha no navegador (public/gestao/lib/orcamento.js,
// mesmas regras do importar_base.ler_orcamento) e validação no servidor (functions/api/orcamento/index.js). Dados fictícios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerOrcamento, numero, data } from '../../public/gestao/lib/orcamento.js';
import { validarOrcamento } from '../../functions/api/orcamento/index.js';

test('números e datas como o vigia lê do Excel', () => {
  assert.equal(numero(1234.5), 1234.5);
  assert.equal(numero('1.234,56'), 1234.56);
  assert.equal(numero('R$ 1.234,5'), 1234.5);
  assert.equal(numero('1234.5'), 1234.5);
  assert.equal(numero(''), null); assert.equal(numero('abc'), null); assert.equal(numero(true), null);
  assert.equal(data(new Date(2026, 0, 1)), '2026-01-01');
  assert.equal(data(46023), '2026-01-01');   // número de série do Excel
  assert.equal(data('01/02/2026'), '2026-02-01');
  assert.equal(data('2026-03-01'), '2026-03-01');
  assert.equal(data('31/02/2026'), null); assert.equal(data('x'), null);
});

test('abas Base_Metas e BD_UND -> linhas, unidades, linhas incompletas e resumo', () => {
  const o = lerOrcamento({
    baseMetas: [['Unidade', 'Natureza', 'Data', 'Valor'], ['Unidade A', 'arla', new Date(2026, 0, 1), 100.5], [null, null, null, null],
      ['Unidade B', 'KM', '01/02/2026', '2.000'], ['Unidade B', 'ARLA', null, 10], ['Unidade A', 'ARLA', '2026-03-01', '1,5']],
    bdUnd: [['UNIDADE', 'INF ADICIONAL', 'Centro de Custo'], ['Unidade A', 'RAJA A', '0206001'], ['', 'X', ''], ['Unidade B', '', null]],
  });
  assert.deepEqual(o.metas, [{ unidade: 'Unidade A', natureza: 'ARLA', data: '2026-01-01', valor: 100.5 },
    { unidade: 'Unidade B', natureza: 'KM', data: '2026-02-01', valor: 2 },
    { unidade: 'Unidade A', natureza: 'ARLA', data: '2026-03-01', valor: 1.5 }]);
  assert.deepEqual(o.unidades, [{ unidade: 'Unidade A', inf_adicional: 'RAJA A', centro_de_custo: '0206001' },
    { unidade: 'Unidade B', inf_adicional: null, centro_de_custo: null }]);
  assert.deepEqual(o.ignoradas, [5]);   // linha 5 da aba (sem data); a linha em branco não conta
  assert.deepEqual(o.resumo, { linhas: 3, unidades: 2, mesInicio: '2026-01', mesFim: '2026-03', porNatureza: { ARLA: 102, KM: 2 } });
});

test('planilha errada: aba ou coluna faltando', () => {
  assert.match(lerOrcamento({ baseMetas: null, bdUnd: [['UNIDADE', 'INF ADICIONAL']] }).erro, /Base_Metas/);
  assert.match(lerOrcamento({ baseMetas: [['Unidade', 'Natureza', 'Data']], bdUnd: [['UNIDADE', 'INF ADICIONAL']] }).erro, /Valor/);
  assert.match(lerOrcamento({ baseMetas: [['Unidade', 'Natureza', 'Data', 'Valor']], bdUnd: [['UNIDADE']] }).erro, /INF ADICIONAL/);
});

test('servidor confere de novo o que chega', () => {
  const ok = validarOrcamento({ arquivo: ' orc.xlsx ', metas: [{ unidade: 'A', natureza: 'ARLA', data: '2026-01-01', valor: 1 }],
    unidades: [{ unidade: 'A', inf_adicional: 'RAJA A' }, { unidade: '' }] });
  assert.deepEqual(ok, { arquivo: 'orc.xlsx', metas: [{ unidade: 'A', natureza: 'ARLA', data: '2026-01-01', valor: 1 }],
    unidades: [{ unidade: 'A', inf_adicional: 'RAJA A', centro_de_custo: null }] });
  assert.match(validarOrcamento({ metas: [], unidades: [{ unidade: 'A' }] }).erro, /Base_Metas/);
  assert.match(validarOrcamento({ metas: [{ unidade: 'A', natureza: 'X', data: '2026-02-30', valor: 1 }], unidades: [{ unidade: 'A' }] }).erro, /Linha 2/);
  assert.match(validarOrcamento({ metas: [{ unidade: 'A', natureza: 'X', data: '2026-02-01', valor: 'abc' }], unidades: [{ unidade: 'A' }] }).erro, /Linha 2/);
});
