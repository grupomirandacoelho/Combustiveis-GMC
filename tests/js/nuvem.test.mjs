// Passo 4 da migração (19/11/2026): rotinas do vigia nas Edge Functions do Supabase. As funções usam cópias dos módulos do
// portal/vigia (supabase/functions/_shared); se a original mudar e a cópia não, a nuvem rodaria uma regra velha.
// Corrigir com: node scripts/nuvem_publicar.mjs --copiar
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPIAS, ajustarImports } from '../../scripts/nuvem_publicar.mjs';
import { acharNaBase, itensExclusao, serial } from '../../lib/nuvem/estornos.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('cópias em supabase/functions/_shared iguais às originais', () => {
  for (const [destino, origem] of Object.entries(COPIAS)) {
    assert.equal(fs.readFileSync(path.join(RAIZ, 'supabase/functions/_shared', destino), 'utf8'),
      ajustarImports(fs.readFileSync(path.join(RAIZ, origem), 'utf8')), `${destino} desatualizada: rode node scripts/nuvem_publicar.mjs --copiar`);
  }
});

// lista colunar mínima: 3 abastecimentos TruckPag da mesma placa e cadeia (diesel)
const s = (q) => serial(q);
const lista = {
  dic: { placa: ['ABC1D23'], forma: ['TRUCKPAG'], fuel: ['DIESEL S-10 COMUM'] },
  col: { linha: [10, 11, 12], placa: [0, 0, 0], forma: [0, 0, 0], fuel: [0, 0, 0],
    dt: [s('2026-11-10 08:00:00'), s('2026-11-11 08:00:00'), s('2026-11-12 08:00:00')],
    litros: [100, 50, 80], hodo: [1000, 1300, 1700], km: [null, 300, 400], kml: [null, 6, 5] },
};

test('estorno: acha a linha (segundo exato), exclui e refaz o km do seguinte', () => {
  const est = [{ transacao_id: 1, transacao_data: '2026-11-11 08:00:02', litragem: 50, quilometragem: 1300, veiculo_placa: 'ABC1D23' }];
  const r = acharNaBase(lista, est, []);
  assert.deepEqual(r.indices, [1]);
  const itens = itensExclusao(lista, r.indices);
  assert.deepEqual(itens[0], { acao: 'excluir', linha: 11, placa: 'ABC1D23', data: lista.col.dt[1], celulas: {}, antes: {} });
  assert.deepEqual(itens[1].celulas, { R: 700, S: 8.75 });     // seguinte passa a contar do anterior: 1700 - 1000
});

test('estorno refeito na hora (transação aprovada igual): não exclui a linha que ficou', () => {
  const est = [{ transacao_id: 1, transacao_data: '2026-11-11 08:00:00', litragem: 50, quilometragem: 1300, veiculo_placa: 'ABC1D23' }];
  const apr = [{ transacao_id: 2, transacao_data: '2026-11-11 08:00:03', litragem: 50, quilometragem: 1300, veiculo_placa: 'ABC1D23' }];
  const r = acharNaBase(lista, est, apr);
  assert.deepEqual([r.indices, r.semLinha.length, r.refeitas.length], [[], 0, 1]);   // desde 26/11: reconhecida como refeita
});

// caso RND0H44 (12/11/2026): lançada duas vezes (08:30:18 e 08:30:40, mesmo hodômetro e litros); o portal tem uma linha só (a das
// 08:30:18, a importação junta por placa + minuto + litros). A TruckPag cancelou uma: em nenhum dos dois casos a linha pode sair.
const umaLinha = {
  dic: { placa: ['RND0H44'], forma: ['TRUCKPAG'], fuel: ['DIESEL S-10 COMUM'] },
  col: { linha: [62587], placa: [0], forma: [0], fuel: [0], dt: [s('2026-11-12 08:30:18')], litros: [216.661], hodo: [466191], km: [300], kml: [1.4] },
};
const tr = (id, hora) => ({ transacao_id: id, transacao_data: '2026-11-12 ' + hora, litragem: 216.66, quilometragem: 466191, veiculo_placa: 'RND0H44' });
test('estorno de uma de duas transações iguais: cancelou a original (mesmo segundo da linha) -> a linha fica (refeita)', () => {
  const r = acharNaBase(umaLinha, [tr(30715483, '08:30:18')], [tr(30793500, '08:30:40')]);
  assert.deepEqual([r.indices, r.refeitas.length, r.semLinha.length, r.ambiguos.length], [[], 1, 0, 0]);
});
test('estorno de uma de duas transações iguais: cancelou a cópia -> a linha fica', () => {
  const r = acharNaBase(umaLinha, [tr(30793500, '08:30:40')], [tr(30715483, '08:30:18')]);
  assert.deepEqual(r.indices, []);
});
test('portal com mais linhas que as válidas (duas linhas, uma cancelada): ainda exclui a da cancelada', () => {
  const duas = { dic: umaLinha.dic, col: { linha: [1, 2], placa: [0, 0], forma: [0, 0], fuel: [0, 0], dt: [s('2026-11-12 08:30:18'), s('2026-11-12 08:31:30')],
    litros: [216.66, 216.66], hodo: [466191, 466191], km: [300, 0], kml: [1.4, 0] } };
  const r = acharNaBase(duas, [tr(1, '08:30:18')], [tr(2, '08:31:30')]);
  assert.deepEqual(r.indices, [0]);
});
