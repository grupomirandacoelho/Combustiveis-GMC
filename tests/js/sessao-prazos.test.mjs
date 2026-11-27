// Tempo conectado (27/11/2026, pedido do usuário): motorista 90 dias; gestão com "Manter conectado" 30 dias (sem marcar: 2 h).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarSessao } from '../../lib/auth.js';
import { criarSessaoMotorista } from '../../lib/motoristas.js';

function banco() {
  const gravados = [];
  return { gravados, prepare: (q) => ({ bind: (...a) => ({ run: async () => { gravados.push([q, a]); return {}; } }) }) };
}
const pedido = new Request('https://portal.exemplo/api/login', { method: 'POST' });
const DIA = 86400;

test('gestão: "Manter conectado" vale 30 dias (cookie e servidor); sem marcar, 2 h e cookie de sessão', async () => {
  const db = banco(), antes = Math.floor(Date.now() / 1000);
  const cookie = await criarSessao(db, pedido, 1, true);
  assert.match(cookie, new RegExp('Max-Age=' + 30 * DIA + '(;|$)'));
  const expira = db.gravados.find(([q]) => /INSERT INTO sessoes/.test(q))[1][2];
  assert.ok(Math.abs(expira - antes - 30 * DIA) <= 2);
  const db2 = banco();
  assert.doesNotMatch(await criarSessao(db2, pedido, 1, false), /Max-Age/);
  assert.ok(Math.abs(db2.gravados.find(([q]) => /INSERT INTO sessoes/.test(q))[1][2] - antes - 2 * 3600) <= 2);
});

test('motorista: 90 dias (cookie e servidor)', async () => {
  const db = banco(), antes = Math.floor(Date.now() / 1000);
  const cookie = await criarSessaoMotorista(db, pedido, '111444', 'MOTORISTA TESTE');
  assert.match(cookie, new RegExp('Max-Age=' + 90 * DIA + '(;|$)'));
  const expira = db.gravados.find(([q]) => /INSERT INTO sessoes_motoristas/.test(q))[1][3];
  assert.ok(Math.abs(expira - antes - 90 * DIA) <= 2);
});
