// Identidade visual do Grupo Miranda Coelho (18/11/2026): cores da marca nos tokens, logos e ícones nos lugares certos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ler = (p) => fs.readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const existe = (p) => fs.existsSync(new URL('../../' + p, import.meta.url));
const CSS = ['public/gestao/gestao.css', 'public/app.css'];
const PAGINAS = ['public/index.html', 'public/motorista/index.html', 'public/gestao/senha/index.html', 'public/gestao/index.html'];

test('tokens: laranja, preto e cinza da marca; o verde antigo não é mais a cor principal', () => {
  for (const p of CSS) {
    const t = ler(p);
    assert.match(t, /--gmc-laranja:#F6A42B;/, p);
    assert.match(t, /--gmc-preto:#4B4B4D;/, p);
    assert.match(t, /--gmc-cinza:#97989A;/, p);
    assert.match(t, /--primaria:var\(--gmc-laranja\)/, p);
    assert.doesNotMatch(t, /--verde\b|--placa:#/i, p);
    assert.match(t, /--sobre-primaria:#161616/, p);   // texto escuro sobre o laranja (contraste)
  }
  // no tema claro o texto na cor da marca é um laranja escuro (o F6A42B sobre branco não tem contraste)
  assert.match(ler('public/gestao/gestao.css'), /\[data-theme="light"\][\s\S]*--primaria-texto:#9E5A00;/);
});

test('nenhum CSS usa token apagado (--verde, --sobre-verde, --placa-escura, --sobre-placa)', () => {
  for (const p of [...CSS, 'public/motorista/motorista.css', ...PAGINAS]) {
    assert.doesNotMatch(ler(p), /var\(--(verde|verde-escuro|verde-suave|sobre-verde|placa-escura|sobre-placa)\)/, p);
  }
});

test('logos: com o nome no lugar da antiga; símbolo no menu recolhido; ícone do app e do site', () => {
  for (const f of ['logo-grupo.png', 'logo-grupo-negativo.png', 'logo-simbolo.png', 'logo-simbolo-negativo.png', 'icon-192.png', 'icon-512.png']) {
    assert.ok(existe('public/' + f), f);
  }
  assert.ok(!existe('public/logo-mark.png'), 'logo antiga apagada');
  for (const p of PAGINAS) {
    const t = ler(p);
    assert.doesNotMatch(t, /logo-mark\.png/, p);
    assert.match(t, /logo-grupo(-negativo)?\.png/, p);
    assert.match(t, /rel="icon" href="\/?icon-192\.png"/, p);
  }
  const g = ler('public/gestao/index.html');
  assert.match(g, /lateral-simbolo so-escuro" src="\/logo-simbolo-negativo\.png"/);
  assert.match(g, /class="so-claro" src="\/logo-grupo\.png"/);
  const m = JSON.parse(ler('public/manifest.json'));
  assert.deepEqual(m.icons.map((i) => i.src), ['icon-192.png', 'icon-512.png']);
  const sw = ler('public/sw.js');
  assert.match(sw, /postos-autorizados-v(1[7-9]|[2-9][0-9])/);
  assert.match(sw, /'\/logo-grupo-negativo\.png'/);
});
