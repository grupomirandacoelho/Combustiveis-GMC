// Troca rápida de tela (27/11/2026, erros do console "Cannot read properties of null" em Operação por motorista, Divisão por cartão,
// Média geral, Preço x ANP): a tela que sai não pode mais desenhar nem mexer no endereço.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ler = (p) => fs.readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

test('roteador: área nova a cada navegação e só a montagem mais recente vale', () => {
  const g = ler('public/gestao/gestao.js');
  assert.match(g, /const vez = \+\+navegacao;/);
  assert.match(g, /if \(vez === navegacao\) desmontar = /);
  assert.match(g, /const velha = \$\('pagina'\), pagina = velha\.cloneNode\(false\);\n\s*velha\.replaceWith\(pagina\);\n\s*ligarPagina\(pagina\);/);
  assert.match(g, /function ligarPagina\(el\) \{ iniciarToqueLongo\(el\); iniciarAcoesLinha\(el\); \}/);
});

test('trocarEndereco só mexe no endereço se a página aberta ainda é a da tela', async () => {
  globalThis.location = { hash: '#/inicio' };
  const chamadas = [];
  globalThis.history = { replaceState: (a, b, novo) => { chamadas.push(novo); globalThis.location.hash = novo; } };
  const { trocarEndereco } = await import('../../public/gestao/lib/filtros.js');
  trocarEndereco('#/despesas', '#/despesas?periodo=mes');
  assert.deepEqual(chamadas, [], 'saiu da tela: não troca');
  globalThis.location.hash = '#/despesas';
  trocarEndereco('#/despesas', '#/despesas?periodo=mes');
  assert.deepEqual(chamadas, ['#/despesas?periodo=mes']);
  trocarEndereco('#/despesas', '#/despesas?periodo=mes');
  assert.equal(chamadas.length, 1, 'mesmo endereço: não troca de novo');
});

test('nenhuma tela troca o endereço direto (passa pelo trocarEndereco)', () => {
  for (const p of ['dashboards/contratos-anp.js', 'dashboards/evolucao-placas.js', 'dashboards/media-geral.js', 'dashboards/preco-anp.js',
    'dashboards/preco-postos.js', 'dashboards/preco-refinaria.js', 'dashboards/prime-resultado.js', 'dashboards/real-orcado.js',
    'paginas/programa-prime.js', 'paginas/abastecimentos.js']) {
    assert.doesNotMatch(ler('public/gestao/' + p), /history\.replaceState/, p);
  }
});

test('Operação por motorista e Divisão por cartão param o que é atrasado ao sair', () => {
  const om = ler('public/gestao/dashboards/operacao-motorista.js'), dc = ler('public/gestao/dashboards/divisao-cartoes.js');
  assert.match(om, /const box = el\('om-evolucao'\);\n\s*if \(!box\) return;/);
  assert.match(om, /parado = true; clearTimeout\(tRedim\); clearTimeout\(tRolar\);/);
  assert.match(dc, /if \(!matriz \|\| !lista\) return;/);
  assert.match(dc, /desmontar\(\) \{ parado = true; clearTimeout\(tRedim\); clearTimeout\(tBusca\);/);
});
