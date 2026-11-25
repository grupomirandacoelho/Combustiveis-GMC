// Cartão "Contratos x ANP" do Início (25/11/2026): contratos do portal e a mesma regra do painel (ANP da última semana ÷ ANP da semana
// da data do contrato − 1; acima/abaixo de ±5%). Antes lia a planilha de reajustes (preço do contrato), que saiu. Dados fictícios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compararContratos } from '../../public/gestao/paginas/inicio.js';

const dia = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / 864e5);
// semanas (domingos) de 01/03/2026 e 22/11/2026; BA sobe 10%, GO fica igual, SP sem pesquisa na última semana (vale a anterior)
const p1 = dia('2026-03-01'), p2 = dia('2026-11-22'), p2a = p2 - 7;
const anp = { locais: { estado: [['BA'], ['GO'], ['SP']] },
  series: { semanal: { estado: { p: [p1, p2, p1, p2, p1, p2a], l: [0, 0, 1, 1, 2, 2], v: [6000, 6600, 6000, 6000, 6000, 5500] } } } };

test('conta acima e abaixo de 5% pela ANP da semana do contrato, com contratos ativos do portal', () => {
  const contratos = [
    { uf: 'BA', data_contrato: '2026-03-04', ativo: true },    // semana de 01/03: +10% -> acima
    { uf: 'GO', data_contrato: '2026-03-02', ativo: true },    // 0% -> dentro
    { uf: 'SP', data_contrato: '2026-03-07', ativo: true },    // −8,3% (semana anterior) -> abaixo
    { uf: 'BA', data_contrato: '2026-03-04', ativo: false },   // inativo: fora
    { uf: 'MG', data_contrato: '2026-03-04', ativo: true },    // sem ANP: conta no total, não no "com"
  ];
  assert.deepEqual(compararContratos(anp, contratos), { total: 4, com: 3, acima: 1, abaixo: 1, semana: p2 });
});
