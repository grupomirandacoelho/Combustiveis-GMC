// Fechamento abastecimentos (Programa PRIME) > Ranking: colunas Litros economizados e Valor economizado (26/11/2026, pedido do usuário)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const js = fs.readFileSync(new URL('../../public/gestao/paginas/programa-prime.js', import.meta.url), 'utf8');

test('ranking: as duas colunas novas, ordenáveis, entre % da meta e os prêmios', () => {
  const cab = js.slice(js.indexOf("th('ranking', 'pos'"), js.indexOf("th('ranking', 'total'"));
  const ordem = ['pct', 'econL', 'econR', 'premioSS'].map((c) => cab.indexOf("th('ranking', '" + c + "'"));
  assert.ok(ordem.every((i) => i >= 0), 'cabeçalhos');
  assert.deepEqual([...ordem].sort((a, b) => a - b), ordem, 'ordem das colunas');
  assert.match(js, /th\('ranking', 'econL', 'Litros economizados', true\)/);
  assert.match(js, /th\('ranking', 'econR', 'Valor economizado', true\)/);
  assert.match(js, /econL: litrosEcon, econR: valorEcon/);   // ordenação por coluna
  assert.match(js, /'<tr class="pr-det"><td colspan="11">'/);   // detalhe do motorista ocupa a linha toda
});

test('ranking: mesma conta do Resultado PRIME (litros pela meta − litros; × preço médio do diesel da unidade no mês)', () => {
  assert.match(js, /const litrosEcon = \(r\) => \(r\.litrosMeta \? r\.litrosMeta - \(r\.litros \|\| 0\) : null\);/);
  assert.match(js, /pm = a && a\.l \? a\.v \/ a\.l : pr\.geral/);
  assert.match(js, /a\.v \+= x\.despesa \|\| 0; a\.l \+= x\.litros;/);
});
