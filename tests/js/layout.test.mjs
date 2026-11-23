// Varredura de layout (18/11/2026): valor em texto na faixa de apoio (htmlApoio) quebra linha em vez de estourar o cartão
// (Preço x ANP: "a do estado de cada abastecimento" criava rolagem lateral na página). Dados fictícios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlApoio, valorTexto } from '../../public/gestao/lib/filtros.js';

test('valorTexto: só o que não tem algarismo é texto', () => {
  assert.equal(valorTexto('a do estado de cada abastecimento'), true);
  assert.equal(valorTexto('Sem registro'), true);
  for (const n of ['R$ 2.762.027,00', '7,022', '1.437 de 1.437', '—', '', null, 12]) assert.equal(valorTexto(n), false, String(n));
});

test('htmlApoio: texto recebe apoio-texto (quebra linha); número continua sem quebrar', () => {
  const h = htmlApoio([{ rot: 'Média da ANP usada', val: 'a do estado de cada abastecimento' }, { rot: 'Valor pago', val: 'R$ 10,00' }]);
  assert.match(h, /<span class="num apoio-texto">a do estado de cada abastecimento<\/span>/);
  assert.match(h, /<span class="num">R\$ 10,00<\/span>/);
});

// Divisão por cartão > Dia a dia com % (18/11/2026): % inteiro nas colunas estreitas
test('pctCurto: % inteiro; abaixo de meio por cento vira "<1%"', async () => {
  const { pctCurto } = await import('../../public/gestao/dashboards/divisao-cartoes.js');
  assert.equal(pctCurto(0.634), '63%');
  assert.equal(pctCurto(1), '100%');
  assert.equal(pctCurto(0.003), '<1%');
  assert.equal(pctCurto(0), '0%');
});

// Preço bomba interna (23/11/2026): "Lançar negociação" e "Adicionar fornecedor" só com as praças (com negociação ou fornecedor),
// não com o cadastro inteiro de unidades do portal
test('pracasDoLancamento: praças com negociação ou fornecedor; sem as descontinuadas; em ordem de nome', async () => {
  const { pracasDoLancamento } = await import('../../public/gestao/dashboards/preco-fornecedor.js');
  const cad = [{ u: 'BELEM' }, { u: 'GV' }, { u: 'NOVA' }];
  assert.deepEqual(pracasDoLancamento(['SP', 'JEQUIE'], cad, 'SP'), ['BELEM', 'JEQUIE', 'NOVA', 'SP']);
  assert.ok(!pracasDoLancamento([], cad, null).includes('GV'));
  assert.ok(!pracasDoLancamento(['SP'], [], 'SP').includes('RAJA JEQUIE'));
});
