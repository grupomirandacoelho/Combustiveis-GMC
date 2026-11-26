// Dados publicados (26/11/2026): os dashboards ficam só com o que foi publicado (sem as transações das APIs de hoje); as telas de
// operação (Estoque etc.) usam decodificar(..., {tempoReal: true}) e continuam descontando as saídas de hoje. Dados fictícios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodificar } from '../../public/gestao/lib/dados.js';

const arquivo = (n, extra = {}) => ({
  versao: '1', geradoEm: '2026-11-26T08:00:00', linhas: n, veiculos: {},
  dic: { placa: ['AAA1A11'], motorista: ['FULANO'], combustivel: ['DIESEL S-10 COMUM'], fornecedor: ['POSTO INT RAJA'], cidade: ['JEQUIE - BA'], cc: ['RAJA'],
    tipo_estab: ['POSTO INTERNO'], cartao: ['TRUCKPAG'] },
  col: { data: Array(n).fill(20417), seg: Array(n).fill(3600), placa: Array(n).fill(0), motorista: Array(n).fill(0), combustivel: Array(n).fill(0),
    litros: Array(n).fill(100), vl_litro: Array(n).fill(6), hodometro: Array(n).fill(1000), km: Array(n).fill(200), despesa: Array(n).fill(600),
    fornecedor: Array(n).fill(0), cidade: Array(n).fill(0), cc: Array(n).fill(0), campanha: Array(n).fill(null), tipo_estab: Array(n).fill(0), cartao: Array(n).fill(0) },
  ...extra,
});
const tempoReal = () => ({ ...arquivo(1), versao: 'tr', col: { ...arquivo(1).col, data: [20418], litros: [139.197] } });

test('publicado: dashboards sem o tempo real; operação com', () => {
  const pub = arquivo(1, { publicadoAte: '2026-11-25' });
  assert.equal(decodificar(pub, tempoReal()).linhas.length, 1);
  const op = decodificar(pub, tempoReal(), { tempoReal: true });
  assert.equal(op.linhas.length, 2);
  assert.equal(op.linhas[1].tempoReal, true);
  assert.equal(op.linhas[1].litros, 139.197);
});

test('sem publicação: tudo como antes (tempo real entra nos dois)', () => {
  assert.equal(decodificar(arquivo(1), tempoReal()).linhas.length, 2);
  assert.equal(decodificar(arquivo(1), tempoReal(), { tempoReal: true }).linhas.length, 2);
});
