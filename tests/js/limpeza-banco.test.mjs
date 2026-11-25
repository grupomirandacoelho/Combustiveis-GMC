// Limpeza do histórico das rotinas agendadas no Supabase (25/11/2026): banco do plano gratuito tem 500 MB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('rotina diária apaga só o histórico do pg_cron com mais de 7 dias', () => {
  const sql = fs.readFileSync(new URL('../../supabase/migrations/20261125120000_gestao_limpar_historico_cron.sql', import.meta.url), 'utf8');
  assert.match(sql, /cron\.schedule\('limpar-historico-cron', '17 3 \* \* \*'/);
  assert.match(sql, /delete from cron\.job_run_details where end_time < now\(\) - interval '7 days'/);
  assert.doesNotMatch(sql, /drop |truncate /i);   // não apaga tabela nenhuma
});
