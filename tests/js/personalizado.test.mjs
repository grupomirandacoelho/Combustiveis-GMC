// Aviso personalizado (26/11/2026): o usuário monta o aviso. Fontes: mudanças nos Postos dos motoristas e números dos abastecimentos;
// "separar por unidade": cada pessoa recebe só as unidades dela (Gerenciar acessos > Unidades). Dados fictícios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIPOS } from '../../public/gestao/lib/notificacao.js';
import { unidadeDe, daUnidade } from '../../public/gestao/lib/unidades.js';
import { recebe } from '../../public/gestao/lib/destino-notificacao.js';
import { planejar } from '../../lib/nuvem/push.js';
import { validarCampos, unidadesDe } from '../../lib/usuarios.js';

const agoraIso = (h) => new Date(Date.now() - h * 3600e3).toISOString().slice(0, 19) + 'Z';
const mud = (id, acao, unidade, h, extra = {}) => ({ id, acao, criado_em: agoraIso(h), usuario_nome: 'Fulano',
  dados: { unidade, posto: 'POSTO ' + id, cidade: 'CIDADE - BA', plataforma: 'TRUCKPAG', valor: 6.29, status: acao === 'bloquear' ? 'POSTO BLOQUEADO' : 'POSTO AUTORIZADO', ...extra } });
const MUDANCAS = [mud(1, 'bloquear', 'TEIXEIRA', 2), mud(2, 'autorizar', 'SERRA', 3), mud(3, 'editar', 'JEQUIE', 1, { rodada: true }),
  mud(4, 'adicionar', 'TEIXEIRA', 30), mud(5, 'editar', 'TEIXEIRA', 1, { plataforma: 'TICKETLOG' })];
const regraPostos = (cond, extra = {}) => ({ id: 9, nome: 'Postos', tipo: 'personalizado', ativa: true, nivel: 'alerta', repetir: 'diaria',
  mensagem: 'Posto {posto} foi {acao} em {unidade} por {quem}. Cartão {cartao}, valor {valor}.', condicao: { fonte: 'postos', horas: 24, ...cond }, ...extra });

test('unidades: código a partir do centro de custo, do nome e da sigla GV', () => {
  assert.equal(unidadeDe('RAJA LOG JEQUIE'), 'JEQUIE');
  assert.equal(unidadeDe('Jequié'), 'JEQUIE');
  assert.equal(unidadeDe('KEMIGAS GV'), 'GOVERNADOR VALADARES');
  assert.equal(unidadeDe('X'), '');
  assert.equal(daUnidade('RAJA LOG TEIXEIRA', ['TEIXEIRA']), true);
  assert.equal(daUnidade('SERRA', ['TEIXEIRA']), false);
  assert.equal(daUnidade('SERRA', []), true);   // sem unidade no cadastro = todas
});

test('mudanças nos postos: filtra ação, unidade, cartão e janela de horas; "preço da rodada" separado da edição', () => {
  const ctx = { contexto: { alteracoesPostos: MUDANCAS } };
  const tudo = TIPOS.personalizado.avaliar(regraPostos({ acoes: [] }), ctx);
  assert.deepEqual(tudo.map((o) => o.chave), ['r9:p1', 'r9:p2', 'r9:p3', 'r9:p5']);   // a 4 tem 30 h (fora das 24 h)
  const bloq = TIPOS.personalizado.avaliar(regraPostos({ acoes: ['autorizar', 'bloquear'], unidades_postos: ['TEIXEIRA'] }), ctx);
  assert.deepEqual(bloq.map((o) => [o.chave, o.unidade]), [['r9:p1', 'TEIXEIRA']]);
  assert.equal(bloq[0].texto, 'Posto POSTO 1 foi bloqueado em Teixeira por Fulano. Cartão TruckPag, valor R$ 6,290.');
  assert.deepEqual(bloq[0].acao, { rotulo: 'Ver os postos', href: '#/postos-motoristas' });
  const ed = TIPOS.personalizado.avaliar(regraPostos({ acoes: ['editar'] }), ctx);
  assert.deepEqual(ed.map((o) => o.chave), ['r9:p5']);   // a 3 é da Rodada de preços (ação "rodada")
  const rod = TIPOS.personalizado.avaliar(regraPostos({ acoes: ['rodada'] }), ctx);
  assert.match(rod[0].texto, /atualizado na rodada de preços/);
  assert.deepEqual(TIPOS.personalizado.avaliar(regraPostos({ cartoes: ['TICKETLOG'] }), ctx).map((o) => o.chave), ['r9:p5']);
  assert.equal(TIPOS.personalizado.avaliar(regraPostos({}), { contexto: {} }), null);   // sem as mudanças: não dá para verificar
});

test('números dos abastecimentos: litros por placa ontem maior que o limite, com a unidade da placa', () => {
  const ontem = Math.floor((Date.now() - 3 * 3600e3) / 864e5) - 1;
  const l = (placa, litros, cc, dia = ontem) => ({ dia, seg: 3600, placa, motorista: 'M', combustivel: 'DIESEL S-10', litros, despesa: litros * 6, km: litros * 2,
    cc, fornecedor: 'POSTO X', tipoEstab: 'POSTO DE COMBUSTIVEL', cartao: 'TRUCKPAG', meta: 2.5, litrosMeta: litros * 2 / 2.5 });
  const dados = { linhas: [l('AAA1A11', 300, 'RAJA LOG JEQUIE'), l('AAA1A11', 200, 'RAJA LOG JEQUIE'), l('BBB2B22', 100, 'RAJA LOG SERRA'), l('CCC3C33', 900, 'RAJA LOG SERRA', ontem - 5)] };
  const r = { id: 4, tipo: 'personalizado', mensagem: '{grupo}: {valor} ({limite}) {periodo}', condicao: { fonte: 'abastecimentos', medida: 'litros', agrupar: 'placa',
    operador: '>', valor: 150, periodo: 'ontem', combustivel: 'diesel', cartao: 'todos', estab: 'todos', ccs: [] } };
  const out = TIPOS.personalizado.avaliar(r, { dados });
  assert.deepEqual(out.map((o) => [o.onde, o.unidade, o.texto]), [['AAA1A11', 'RAJA LOG JEQUIE', 'AAA1A11: 500 L (maior que 150) ontem']]);
  const pct = TIPOS.personalizado.avaliar({ ...r, condicao: { ...r.condicao, medida: 'pct_meta', operador: '<', valor: 90 } }, { dados });
  // km/L 2 com meta 2,5 = 80% da meta: abaixo de 90% nas duas placas de ontem
  assert.deepEqual(pct.map((o) => o.texto), ['AAA1A11: 80,00% (menor que 90,00%) ontem', 'BBB2B22: 80,00% (menor que 90,00%) ontem']);
});

test('separar por unidade: o encarregado de Teixeira recebe só Teixeira no celular; quem não tem unidade recebe tudo', () => {
  const r = regraPostos({ acoes: ['autorizar', 'bloquear'], por_unidade: true });
  const ap = (id, usuario_id) => ({ id, usuario_id, endpoint: 'https://fcm.googleapis.com/x' + id, p256dh: 'a', auth: 'b' });
  const p = planejar({ regras: [r], comum: { alteracoesPostos: MUDANCAS },
    usuarios: [{ id: 1, recebe: [9], pode: {}, unidades: ['TEIXEIRA'] }, { id: 2, recebe: [9], pode: {}, unidades: [] }],
    inscricoes: [ap(1, 1), ap(2, 2)] });
  assert.deepEqual(p.envios.map((e) => [e.usuario_id, e.chave]), [[1, 'r9:p1'], [2, 'r9:p1'], [2, 'r9:p2']]);
});

test('quem recebe: postos para qualquer login; abastecimentos só para quem vê os dados', () => {
  const rp = regraPostos({}, { destinatarios: { modo: 'todos' } });
  const ra = { ...rp, condicao: { fonte: 'abastecimentos' } };
  assert.equal(recebe([], 7, rp, ['media-geral']), true);
  assert.equal(recebe([], 7, ra, ['media-geral']), false);
  assert.equal(recebe(['media-geral'], 7, ra, ['media-geral']), true);
});

test('unidades do login: só códigos da lista; vazio = todas', () => {
  assert.deepEqual(validarCampos({ unidades: ['TEIXEIRA', 'JEQUIE', 'TEIXEIRA'] }, false).dados.unidades, ['JEQUIE', 'TEIXEIRA']);
  assert.equal(validarCampos({ unidades: [] }, false).dados.unidades, null);
  assert.ok(validarCampos({ unidades: ['MARTE'] }, false).erros.length);
  assert.deepEqual(unidadesDe({ unidades: '["SERRA","X"]' }), ['SERRA']);
});

test('para quem por função: recebe quem tem uma das funções; administrador e acesso personalizado (sem função) não', async () => {
  const { limparDestinatarios } = await import('../../public/gestao/lib/destino-notificacao.js');
  const r = regraPostos({}, { destinatarios: { modo: 'funcoes', funcoes: [3, 5] } });
  assert.equal(recebe([], 1, r, [], 3), true);
  assert.equal(recebe([], 1, r, [], 4), false);
  assert.equal(recebe([], 1, r, [], null), false);
  assert.deepEqual(limparDestinatarios({ modo: 'funcoes', funcoes: ['3', 3, 'x', 5] }, []), { valor: { modo: 'funcoes', funcoes: [3, 5] } });
  assert.ok(limparDestinatarios({ modo: 'funcoes', funcoes: [] }, []).erro);
});
