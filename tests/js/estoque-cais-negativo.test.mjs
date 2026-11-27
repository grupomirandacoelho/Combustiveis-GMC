// Estoque dos cais (27/11/2026, usuário): o cais fica na Petrobras; quando acaba a nossa litragem eles usam a deles e abatem na
// próxima nota, então a medição pode ser negativa, mas só nos cais.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ler = (p) => fs.readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

test('servidor aceita medição negativa (limite largo) e a tela só deixa negativo nos cais', () => {
  assert.match(ler('functions/api/bomba/bases.js'), /if \(!\(inicial >= -1_000_000 && inicial <= 1_000_000\)\)/);
  const tela = ler('public/gestao/paginas/bomba-estoque.js');
  assert.match(tela, /if \(negativo && !postosCais\.has\(String\(f\.posto\.value \|\| ''\)\.trim\(\)\.toUpperCase\(\)\)\)/);
  assert.match(tela, /O estoque na medição só pode ficar negativo nos cais\./);
});

test('leitura do número do formulário aceita o sinal de menos', () => {
  const lerNum = (s) => { const t = String(s ?? '').trim().replace(/\./g, '').replace(',', '.'); return t === '' ? null : Number(t); };
  assert.equal(lerNum('-2.161,10'), -2161.1);
  assert.match(ler('public/gestao/paginas/bomba-estoque.js'), /const lerNum = \(s\) => \{ const t = String\(s \?\? ''\)\.trim\(\)\.replace\(\/\\.\/g, ''\)\.replace\(',', '\.'\); return t === '' \? null : Number\(t\); \};/);
});
