-- Limpeza do histórico das rotinas agendadas (25/11/2026, pedido do usuário: não deixar o banco crescer à toa; plano gratuito = 500 MB).
-- cron.job_run_details guarda uma linha por execução (as rotinas rodam a cada 2 e 5 min: ~1.000 linhas por dia) e nunca era limpo.
-- Todo dia às 03:17 (UTC) apaga o que tem mais de 7 dias. Só registro de execução: nada do portal lê esta tabela.
select cron.schedule('limpar-historico-cron', '17 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
