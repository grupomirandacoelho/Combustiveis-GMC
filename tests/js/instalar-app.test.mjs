// Opção de instalar o aplicativo (27/11/2026, pedido do usuário) na tela de login e na área do motorista.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ler = (p) => fs.readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

test('login e área do motorista carregam a faixa de instalar', () => {
  assert.match(ler('public/index.html'), /<script src="\/instalar\.js"><\/script>\n<script src="\/app\.js"><\/script>/);
  const m = ler('public/motorista/index.html');
  assert.match(m, /<script src="\/instalar\.js"><\/script>/);
  assert.match(m, /<link rel="manifest" href="\/manifest\.json">/);   // sem manifest o celular não oferece a instalação
  assert.match(m, /<link rel="apple-touch-icon" href="\/icon-192\.png">/);
});

test('faixa: Android pelo pedido do navegador, iPhone com o passo a passo, some se já instalado e por 7 dias ao fechar', () => {
  const s = ler('public/instalar.js');
  assert.match(s, /addEventListener\('beforeinstallprompt', function \(e\) \{ e\.preventDefault\(\); pedido = e; mostrar\(\); \}\)/);
  assert.match(s, /Adicionar à Tela de Início/);
  assert.match(s, /if \(instalado\) return;/);
  assert.match(s, /SETE_DIAS = 7 \* 864e5/);
  assert.match(s, /navigator\.serviceWorker\.register\('\/sw\.js'\)/);
});

test('service worker guarda o instalar.js (versão nova do cache)', () => {
  const sw = ler('public/sw.js');
  assert.match(sw, /'\/instalar\.js',/);
  assert.match(sw, /postos-autorizados-v(2[2-9]|[3-9]\d)/);
});
