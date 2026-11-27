// Mapa de calor (27/11/2026): ao sair da tela, chamadas atrasadas (setTimeout de 60 ms, ResizeObserver, recarga dos dados) rodavam com
// o mapa já fora da página: "Cannot read properties of null (reading 'clientHeight')". Todas param depois do desmontar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const js = fs.readFileSync(new URL('../../public/gestao/mapas/mapa-calor.js', import.meta.url), 'utf8');

test('enquadrar não lê o mapa depois de sair da tela', () => {
  assert.match(js, /const caixa = el\('mc-mapa'\);\n\s*if \(parado \|\| mexeu \|\| !limites \|\| !caixa \|\| !caixa\.clientHeight\) return;/);
  assert.doesNotMatch(js, /!el\('mc-mapa'\)\.clientHeight/);
});
test('ResizeObserver, recarga dos dados e o setTimeout inicial respeitam o desmontar', () => {
  assert.match(js, /new ResizeObserver\(\(\) => \{ if \(parado\) return;/);
  assert.match(js, /carregarDados\(\)\.then\(\(d\) => \{ if \(parado\) return;/);
  assert.match(js, /const tEnquadrar = setTimeout\(enquadrar, 60\);/);
  assert.match(js, /clearTimeout\(tEnquadrar\)/);
});
