// Busca de coordenadas no OpenStreetMap na nuvem (lib/nuvem/geo.js, 25/11/2026): as regras do scripts/geocodificar_postos.py.
// (A paridade com o Python foi conferida nos 173 postos candidatos: nome limpo e nota iguais.) Dados fictícios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nomeLimpo, nota, escolher, podeTentar, processar, POR_RODADA } from '../../lib/nuvem/geo.js';

test('nome limpo e nota como o vigia', () => {
  assert.equal(nomeLimpo('POSTO FERRARI REDE HG'), 'POSTO FERRARI');
  assert.equal(nomeLimpo('DP LEME - REDE DOM PEDRO | SP-RODOVIA'), 'DP LEME');
  assert.equal(nomeLimpo('Auto Posto São João Ltda'), 'AUTO POSTO SAO JOAO');
  const [n, comuns] = nota('POSTO FERRARI', 'Posto Ferrari', 'JEQUIE');
  assert.equal(n, 1); assert.deepEqual(comuns, ['FERRARI']);
  assert.equal(nota('POSTO JEQUIE', 'Posto Jequié', 'JEQUIE')[0], 0);   // a palavra da cidade não conta
});

const sede = [-13.857, -40.083];
const p = { chave: 'POSTO FERRARI', nome: 'POSTO FERRARI', cidade: 'JEQUIE', uf: 'BA', sede };
const lugar = (nome, tipo = 'fuel', lat = -13.86, lon = -40.08, categoria = 'amenity') => ({ nome, tipo, lat, lon, categoria });

test('só é seguro com nome quase igual, palavra própria de 4+ letras, perto da cidade e sem outro parecido longe', () => {
  assert.equal(escolher(p, 'POSTO FERRARI', [lugar('Posto Ferrari')], sede).seguro, true);
  // o mesmo posto como estacionamento a menos de 300 m não conta como "outro"
  assert.equal(escolher(p, 'POSTO FERRARI', [lugar('Posto Ferrari'), lugar('Estacionamento Posto Ferrari', 'parking', -13.861)], sede).seguro, true);
  assert.equal(escolher(p, 'POSTO FERRARI', [lugar('Posto Ferrari'), lugar('Ferrari Combustíveis', 'fuel', -13.95)], sede).resultado, 'ambiguo');
  assert.equal(escolher(p, 'POSTO FERRARI', [lugar('Posto Ferrari', 'fuel', -15.5, -41)], sede).resultado, 'sem_match');   // a mais de 30 km
  assert.equal(escolher(p, 'POSTO FERRARI', [lugar('Posto Ferrari', 'restaurant')], sede).resultado, 'sem_match');
  assert.equal(escolher({ ...p, nome: 'POSTO BR' }, 'POSTO BR', [lugar('Posto BR')], sede).seguro, false);   // "BR" tem menos de 4 letras
});

test('tenta de novo depois de 30 dias, ou já se o gravado se perdeu', () => {
  assert.equal(podeTentar(null, '2026-11-25'), true);
  assert.equal(podeTentar({ tentado: '2026-11-01', resultado: 'sem_match' }, '2026-11-25'), false);
  assert.equal(podeTentar({ tentado: '2026-10-20', resultado: 'sem_match' }, '2026-11-25'), true);
  assert.equal(podeTentar({ tentado: '2026-11-24', resultado: 'gravado' }, '2026-11-25'), true);
});

function io(ligado, respostas, estado = {}) {
  const gravado = { estado: null, locais: [] }, urls = [];
  return { gravado, urls, obj: { ligado, hoje: '2026-11-25',
    candidatos: async () => [p, { chave: 'SEM CIDADE', nome: 'SEM CIDADE', cidade: 'X', uf: 'BA', sede: null },
      ...Array.from({ length: 20 }, (_, i) => ({ chave: 'P' + i, nome: 'POSTO NADA ' + i, cidade: 'JEQUIE', uf: 'BA', sede }))],
    ler: async (_n, padrao) => estado || padrao, gravar: async (n, v) => { gravado[n] = v; },
    esperar: async () => {},
    buscarJson: async (url) => { urls.push(url); const r = respostas(url); if (r instanceof Error) throw r; return r; },
    gravarLocal: async (l) => { gravado.locais.push(l); return true; } } };
}
const nominatim = (url) => (decodeURIComponent(url).includes('FERRARI')
  ? [{ place_id: 1, lat: '-13.86', lon: '-40.08', name: 'Posto Ferrari', category: 'amenity', type: 'fuel' }] : []);

test('simulação: anota o seguro, não grava a coordenada nem o estado; no máximo 15 postos por rodada', async () => {
  const t = io(false, nominatim);
  const r = await processar(t.obj);
  assert.equal(r.seguros.length, 1); assert.equal(r.seguros[0].mapa, 'Posto Ferrari');
  assert.deepEqual(t.gravado.locais, []); assert.equal(t.gravado.estado, null);
  assert.equal(r.tentados, POR_RODADA - 1);   // o sem cidade não consulta
});

test('ligada: grava a coordenada e o estado; para no "muitas consultas" sem marcar o posto', async () => {
  const t = io(true, nominatim);
  const r = await processar(t.obj);
  assert.deepEqual(t.gravado.locais, [{ nome: 'POSTO FERRARI', cidade: 'JEQUIE', uf: 'BA', lat: -13.86, lon: -40.08 }]);
  assert.equal(t.gravado.estado['POSTO FERRARI'].resultado, 'gravado');
  assert.equal(t.gravado.estado['SEM CIDADE'].resultado, 'sem_cidade');
  assert.equal(r.gravados.length, 1);
  const t2 = io(true, () => Object.assign(new Error('HTTP 429'), { status: 429 }));
  const r2 = await processar(t2.obj);
  assert.match(r2.aviso, /429/); assert.equal(t2.gravado.estado['POSTO FERRARI'], undefined);
});
