// Limite diário do D1 (5 milhões de linhas lidas; estourou em 23/11 e 24/11/2026 e o portal respondeu 500 até a meia-noite UTC):
// as consultas chamadas a cada poucos segundos/minutos (vigia, nuvem, pg_cron) precisam usar índice. Aplica todas as migrações num
// SQLite de verdade e confere o plano de cada uma (nada de SCAN da tabela inteira).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const PASTA = new URL('../../migrations/', import.meta.url);
function banco() {
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(PASTA).filter((n) => n.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(f, PASTA), 'utf8'));
  return db;
}

// consultas frequentes, como estão em functions/api/sync/cadastros/*.js
const FREQUENTES = {
  'limpeza dos dados pessoais (cadastros/pendentes, a cada 10 s)':
    "UPDATE alteracoes_cadastros SET pessoais = NULL WHERE pessoais IS NOT NULL AND criado_em < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')",
  'motoristas novos para os cartões':
    "SELECT id, criado_em, aplicada_em, dados, pessoais FROM alteracoes_cadastros WHERE tipo = 'motoristas' AND acao = 'adicionar' AND estado = 'aplicada' AND sem_cartoes = 0 AND pessoais IS NOT NULL ORDER BY id",
  'motoristas editados':
    "SELECT id, aplicada_em, chave, dados, pessoais FROM alteracoes_cadastros WHERE tipo = 'motoristas' AND acao = 'editar' AND estado = 'aplicada' AND aplicada_em > ? AND usuario_nome NOT LIKE 'APIs dos cartões%' ORDER BY id LIMIT ?",
  'fila dos cadastros para o banco (varredura a cada 2 min, lib/aplicar-cadastros.js)':
    "SELECT id, tipo, acao, chave, dados FROM alteracoes_cadastros WHERE banco_aplicado_em IS NULL AND estado <> 'erro' ORDER BY id LIMIT ?",
  'reserva da fila dos cadastros':
    "SELECT 1 FROM alteracoes_cadastros WHERE banco_aplicado_em >= 'aplicando:' AND banco_aplicado_em < 'aplicando;' LIMIT 1",
  'fila dos cartões frota para o banco':
    "SELECT id, acao, chave, dados FROM alteracoes_cartoes WHERE banco_aplicado_em IS NULL AND estado <> 'erro' ORDER BY id LIMIT ?",
  'placas editadas':
    "SELECT id, aplicada_em, acao, chave, dados FROM alteracoes_cadastros WHERE tipo = 'placas' AND acao IN ('editar', 'adicionar') AND estado = 'aplicada' AND aplicada_em > ? AND usuario_nome NOT LIKE 'APIs dos cartões%' ORDER BY aplicada_em, id LIMIT ?",
};

test('migrações aplicam do zero num SQLite e as consultas frequentes dos cadastros usam índice', () => {
  const db = banco();
  for (const [nome, sql] of Object.entries(FREQUENTES)) {
    const plano = db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => r.detail).join(' | ');
    assert.match(plano, /USING (COVERING )?INDEX/, nome + ': ' + plano);
    assert.doesNotMatch(plano, /SCAN alteracoes_(cadastros|cartoes)(?! USING)/, nome + ': ' + plano);
  }
});

test('a limpeza continua apagando só os dados pessoais com mais de 7 dias', () => {
  const db = banco();
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`INSERT INTO alteracoes_cadastros (id, usuario_id, usuario_nome, tipo, acao, chave, dados, pessoais, criado_em)
    VALUES (1, 1, 'x', 'motoristas', 'adicionar', '111444', '{}', 'p', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-8 days')),
           (2, 1, 'x', 'motoristas', 'adicionar', '111444', '{}', 'p', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 days'))`);
  db.exec(FREQUENTES['limpeza dos dados pessoais (cadastros/pendentes, a cada 10 s)']);
  assert.deepEqual(db.prepare('SELECT id, pessoais FROM alteracoes_cadastros ORDER BY id').all().map((r) => [r.id, r.pessoais]), [[1, null], [2, 'p']]);
});
