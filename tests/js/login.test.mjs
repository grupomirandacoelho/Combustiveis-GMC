// Tela de login (26/11/2026, protótipo prototipos/login-v2): a página inicial é só o login (e o aviso de cartão, sem login); os
// postos autorizados ficam só com sessão (/postos.csv); quem já está conectado vai direto para a área dele.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { onRequestGet as postosCsv } from '../../functions/postos.csv.js';
import { onRequestGet as inicio } from '../../functions/index.js';

const ler = (p) => fs.readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

test('página inicial: login + aviso de cartão, sem a lista de postos', () => {
  const html = ler('public/index.html'), js = ler('public/app.js');
  for (const id of ['form', 'usuario', 'senha', 'manter', 'btn-esqueci', 'btn-entrar', 'btn-cartao', 'dialog-cartao', 'form-cartao']) {
    assert.match(html, new RegExp('id="' + id + '"'), id);
  }
  assert.doesNotMatch(html, /lista-unidades|tela-postos|busca-geral/);
  assert.doesNotMatch(js, /postos\.csv/);
  assert.match(js, /fetch\('\/api\/login'/);
  assert.match(js, /\/api\/alerta-cartao/);
  assert.ok(!fs.existsSync(new URL('../../public/postos.csv', import.meta.url)), 'o postos.csv estático não pode ir para o site');
  const sw = ler('public/sw.js'), shell = sw.slice(sw.indexOf('SHELL_FILES = ['), sw.indexOf('];', sw.indexOf('SHELL_FILES = [')));
  assert.doesNotMatch(shell, /postos\.csv|'\/',/);   // nem a lista nem a página inicial no cache de instalação
});

const semSessao = () => new Request('https://exemplo.dev/postos.csv');
const envSemBanco = { DB: { prepare() { throw new Error('não deveria consultar sem cookie'); } } };

test('/postos.csv sem login: 401', async () => {
  const r = await postosCsv({ request: semSessao(), env: envSemBanco });
  assert.equal(r.status, 401);
});

test('/ sem login: mostra a página de login (next)', async () => {
  let chamou = false;
  const r = await inicio({ request: new Request('https://exemplo.dev/'), env: envSemBanco, next: async () => { chamou = true; return new Response('login'); } });
  assert.equal(chamou, true);
  assert.equal(await r.text(), 'login');
});
