// Cadastro de motoristas e placas nos cartões (passo 4, 23/11/2026): regras em lib/nuvem/cadastros-cartoes.js, usadas pelo vigia e pela
// nuvem. APIs dos cartões e portal simulados (dados fictícios); confere cada chamada que sairia para a Ticket e a TruckPag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarNovos, editarTruckpag, processarPlacas, ehTeste } from '../../lib/nuvem/cadastros-cartoes.js';

function ambiente({ chaves, novos = [], edicoes = [], placas = [], lista = [], estado = {} }) {
  const chamadas = [], portal = [], logs = [], gravado = {};
  const resposta = (status, corpo) => new Response(JSON.stringify(corpo), { status });
  return {
    chamadas, portal, logs, gravado,
    io: {
      log: (m) => logs.push(m), agora: () => Date.UTC(2026, 10, 23, 12), chaves,
      ticket: { host: 'https://ticket.exemplo', basic: 'x' }, truckpag: { hosts: ['https://api.prd.truckpag.exemplo'], token: 'y' },
      motoristas: async () => lista,
      ler: async (n, p) => (n in estado ? estado[n] : p), gravar: async (n, v) => { gravado[n] = v; },
      async api(metodo, rota, corpo) {
        if (metodo === 'GET' && rota.includes('novos-motoristas')) return { motoristas: novos };
        if (metodo === 'GET' && rota.includes('editados-motoristas')) return { edicoes };
        if (metodo === 'GET' && rota.includes('editados-placas')) return { edicoes: placas };
        portal.push({ rota, corpo }); return {};
      },
      async fetchCartao(url, op = {}) {
        const metodo = op.method || 'GET';
        chamadas.push([metodo, url.replace(/^https:\/\/[^/]+/, ''), op.body ? JSON.parse(op.body) : null]);
        if (url.includes('/ebs/motorista/245364/4/')) return resposta(200, { sucesso: false });                    // não existe na Ticket
        if (metodo === 'POST' && url.includes('/ebs/motorista')) return resposta(200, { sucesso: true, codigoEntidade: 777 });
        if (metodo === 'POST' && url.includes('/motorista')) return resposta(201, { data: { id: 555 } });
        if (metodo === 'PUT' && url.includes('/motorista/')) return resposta(200, {});
        if (url.includes('centro-de-custo')) return resposta(200, { data: [{ id: 9, nome: 'RAJA SALVADOR' }] });
        if (metodo === 'GET' && url.endsWith('/veiculo')) return resposta(200, { data: [{ placa: 'ABC-1D23', veiculo_id: 42, centro_de_custo_id: 3, centro_de_custo_nome: 'RAJA JEQUIE' }] });
        if (metodo === 'PUT' && url.includes('/veiculo/42')) return resposta(200, { data: { centro_de_custo_id: 9 } });
        return resposta(404, {});
      },
    },
  };
}
const motorista = { nome: 'JOAO DA SILVA', usuario: '123456', senhaTicket: '4321', senhaTruckpag: '12', matricula: 10 };

test('motorista novo: cadastra na Ticket e na TruckPag, devolve os códigos ao portal e apaga os dados pessoais', async () => {
  const A = ambiente({ chaves: { criar: true }, lista: [motorista],
    novos: [{ id: 1, dados: { nome: 'JOAO DA SILVA', usuario: '123456' }, pessoais: { cpf: '111.222.333-44', dataNascimento: '01/02/1980' } }] });
  await criarNovos(A.io);
  assert.deepEqual(A.chamadas.map((c) => c[0] + ' ' + c[1].split('?')[0]), [
    'GET /ticketlog-servicos/ebs/motorista/245364/4/11122233344', 'POST /ticketlog-servicos/ebs/motorista', 'POST /api/integracao-clientes/motorista']);
  assert.equal(A.chamadas[1][2].senha, '4321');
  assert.equal(A.chamadas[2][2].motorista_senha, 12);
  assert.deepEqual(A.portal, [{ rota: '/api/sync/cadastros/cartoes', corpo: { itens: [{ usuario: '123456', dados: { codigoTicket: 777, idTruckpag: 555 } }], limpar: [1] } }]);
  assert.deepEqual(A.gravado['motoristas-novos'], {});
});

test('motorista de teste nunca vai para os cartões; desligado não faz nada', async () => {
  assert.equal(ehTeste({ usuario: '111444' }), true);
  const A = ambiente({ chaves: { criar: true }, novos: [{ id: 2, dados: { nome: 'MOTORISTA TESTE', usuario: '111444' } }] });
  await criarNovos(A.io);
  assert.equal(A.chamadas.length, 0);
  assert.deepEqual(A.portal[0].corpo, { itens: [], limpar: [2] });
  const B = ambiente({ chaves: {}, novos: [{ id: 3, dados: motorista }] });
  await criarNovos(B.io);
  assert.equal(B.chamadas.length + B.portal.length, 0);
});

test('edição de senha TruckPag com CPF e nascimento: PUT na TruckPag pelo ID do cadastro', async () => {
  const A = ambiente({ chaves: { editar: true }, estado: { 'motoristas-edicao': { desde: '2026-11-20T00:00:00Z' } },
    lista: [{ ...motorista, idTruckpag: 555 }],
    edicoes: [{ id: 9, chave: '123456', aplicada_em: '2026-11-23T10:00:00Z', dados: { senhaTruckpag: '12' }, pessoais: { cpf: '11122233344', dataNascimento: '01/02/1980' } }] });
  await editarTruckpag(A.io);
  assert.deepEqual(A.chamadas.map((c) => c[0] + ' ' + c[1]), ['PUT /api/integracao-clientes/motorista/555']);
  assert.equal(A.chamadas[0][2].motorista_data_nascimento, '1980-02-01');
  assert.deepEqual(A.gravado['motoristas-edicao'], { desde: '2026-11-23T10:00:00Z' });
  assert.deepEqual(A.portal[0].corpo, { itens: [], limpar: [9] });
});

test('placa com unidade nova: troca o centro de custo do veículo na TruckPag', async () => {
  const A = ambiente({ chaves: { placasUnidade: true }, estado: { placas: { desde: '2026-11-20T00:00:00Z' } },
    placas: [{ chave: 'ABC1D23', aplicada_em: '2026-11-23T11:00:00Z', dados: { placa: 'ABC1D23', unidade: 'RAJA SALVADOR' } }] });
  await processarPlacas(A.io);
  const put = A.chamadas.find((c) => c[0] === 'PUT');
  assert.deepEqual(put, ['PUT', '/api/integracao-clientes/veiculo/42', { centro_custo_id: 9 }]);
  assert.match(A.logs[0], /ABC1D23: RAJA JEQUIE -> RAJA SALVADOR/);
  assert.deepEqual(A.gravado.placas, { desde: '2026-11-23T11:00:00Z' });
});
