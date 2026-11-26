// Notificações no celular (lib/nuvem/push.js, 26/11/2026): quem recebe, quando repete e o que vai na mensagem. Usa o mesmo motor do
// sino (public/gestao/lib/notificacao.js). Dados fictícios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planejar, deveEnviar, precisa, urlDoAviso } from '../../lib/nuvem/push.js';

const H = 3600e3;
const ms = (iso) => Date.parse(iso);   // horários em UTC (Salvador = UTC-3)
const estoque = (id, extra = {}) => ({ id, nome: 'Estoque baixo', tipo: 'estoque-baixo', ativa: true, nivel: 'critico', repetir: 'diaria',
  condicao: { base_ids: [], tanque: 'diesel', limite: 2000, unidade: 'litros' }, mensagem: '{tanque} da base {base}: {volume} L', ...extra });
const estoques = [{ base_id: 1, base: 'JEQUIE', tanque: 'diesel', volume: 1500, capacidade: 15000, pct: 0.1 },
  { base_id: 2, base: 'ILHEUS', tanque: 'diesel', volume: 9000, capacidade: 15000, pct: 0.6 }];
const ap = (id, usuario_id) => ({ id, usuario_id, endpoint: 'https://fcm.googleapis.com/fcm/send/' + id, p256dh: 'x', auth: 'y' });

test('push: manda para todos os aparelhos de quem recebe e vê a base; texto igual ao do sino', () => {
  const r = planejar({ regras: [estoque(3)], estoques, agora: ms('2026-11-26T12:00:00Z'),
    usuarios: [{ id: 7, recebe: [3], pode: { estoque: true }, bases: null }, { id: 8, recebe: [3], pode: { estoque: true }, bases: [2] },
      { id: 9, recebe: [], pode: { estoque: true }, bases: null }],
    inscricoes: [ap(1, 7), ap(2, 7), ap(3, 8), ap(4, 9)] });
  assert.deepEqual(r.envios.map((e) => e.inscricao.id), [1, 2]);   // 8 só vê ILHEUS (sem alerta); 9 não recebe a regra
  assert.deepEqual(r.envios[0].mensagem, { titulo: 'Estoque baixo', texto: 'Diesel S10 da base JEQUIE: 1.500 L', url: '/gestao/#/bomba-estoque',
    tag: 'r3:1:diesel', nivel: 'critico' });
  assert.equal(r.envios[0].urgencia, 'high');
  assert.deepEqual(r.estado, { '7|r3:1:diesel': ms('2026-11-26T12:00:00Z') });
});

test('push: não repete na mesma rodada nem no mesmo dia; repete no dia seguinte; esquece o que parou de valer', () => {
  const base = { regras: [estoque(3)], usuarios: [{ id: 7, recebe: [3], pode: { estoque: true }, bases: null }], inscricoes: [ap(1, 7)] };
  const a = planejar({ ...base, estoques, agora: ms('2026-11-26T12:00:00Z') });
  const b = planejar({ ...base, estoques, estado: a.estado, agora: ms('2026-11-26T23:00:00Z') });   // 20h em Salvador: mesmo dia
  assert.equal(b.envios.length, 0);
  assert.deepEqual(b.estado, a.estado);
  const c = planejar({ ...base, estoques, estado: b.estado, agora: ms('2026-11-27T03:30:00Z') });   // 00:30 do dia 27 em Salvador
  assert.equal(c.envios.length, 1);
  const d = planejar({ ...base, estoques: [{ ...estoques[0], volume: 5000 }], estado: c.estado, agora: ms('2026-11-27T04:00:00Z') });
  assert.deepEqual([d.envios.length, d.estado], [0, {}]);   // reabasteceu: esquece; se voltar, avisa de novo
});

test('push: repetir horas:N e sessao', () => {
  const t = ms('2026-11-26T12:00:00Z');
  assert.equal(deveEnviar(0, 'sessao', t), true);
  assert.equal(deveEnviar(t, 'sessao', t + 99 * H), false);
  assert.equal(deveEnviar(t, 'horas:4', t + 3 * H), false);
  assert.equal(deveEnviar(t, 'horas:4', t + 4 * H), true);
  assert.equal(deveEnviar(t, 'diaria', t + 2 * H), false);
});

test('push: sem acesso ao que a regra verifica, não recebe; comunicado no dia de hoje em Salvador vale para todos', () => {
  // o motor do sino usa o relógio de verdade: o comunicado é de hoje (dia de Salvador) e de amanhã
  const hoje = new Date(Date.now() - 3 * H).toISOString().slice(0, 10), amanha = new Date(Date.now() + 21 * H).toISOString().slice(0, 10);
  const comunicado = (id, dia) => ({ id, nome: 'Comunicado', tipo: 'comunicado', ativa: true, nivel: 'info', repetir: 'sessao', mensagem: 'Reunião {de}',
    condicao: { de: dia, ate: dia } });
  const usuarios = [{ id: 7, recebe: [3, 5, 6], pode: { estoque: false }, bases: null }];
  const r = planejar({ regras: [estoque(3), comunicado(5, hoje), comunicado(6, amanha)], usuarios, inscricoes: [ap(1, 7)], estoques });
  const [a, m, d] = hoje.split('-');
  assert.deepEqual(r.envios.map((e) => [e.chave, e.mensagem.texto, e.mensagem.url, e.urgencia]), [['r5:' + hoje, 'Reunião ' + d + '/' + m + '/' + a, '/gestao/#/', 'normal']]);
});

test('push: só carrega o que as regras usam', () => {
  assert.deepEqual(precisa([{ tipo: 'comunicado' }]), { estoque: false, dados: false, cartoes: false });
  assert.deepEqual(precisa([{ tipo: 'falta-cartao', condicao: { cc: null } }]), { estoque: false, dados: false, cartoes: true });
  assert.deepEqual(precisa([{ tipo: 'preco-alto', condicao: {} }]), { estoque: false, dados: true, cartoes: false });
  assert.equal(urlDoAviso({ regra: { tipo: 'preco-alto' }, acao: { href: '#/mapa-calor?de=x' } }), '/gestao/#/mapa-calor?de=x');
});

test('push: "aparece uma vez só" (nunca) manda uma vez e não manda de novo nem se a ocorrência sumir e voltar', () => {
  const base = { regras: [estoque(3, { repetir: 'nunca' })], usuarios: [{ id: 7, recebe: [3], pode: { estoque: true }, bases: null }], inscricoes: [ap(1, 7)] };
  const t = ms('2026-11-26T12:00:00Z');
  const a = planejar({ ...base, estoques, agora: t });
  assert.equal(a.envios.length, 1);
  const b = planejar({ ...base, estoques, estado: a.estado, agora: t + 48 * H });   // dois dias depois, ainda valendo
  assert.equal(b.envios.length, 0);
  const sumiu = planejar({ ...base, estoques: [{ ...estoques[0], volume: 5000 }], estado: b.estado, agora: t + 49 * H });
  assert.deepEqual(sumiu.estado, a.estado);   // guardado mesmo sem valer agora
  const voltou = planejar({ ...base, estoques, estado: sumiu.estado, agora: t + 50 * H });
  assert.equal(voltou.envios.length, 0);
  assert.equal(deveEnviar(t, 'nunca', t + 999 * H), false);
});
