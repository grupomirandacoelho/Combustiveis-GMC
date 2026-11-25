-- Virada da bomba interna (15.3 item 3, 25/11/2026; teste do usuário aprovado: 3 preços lançados, banco = planilha): o banco é a
-- origem dos preços e fornecedores, e a repetição diária do preço do Arla (que o vigia fazia na planilha de hora em hora,
-- scripts/planilha_bomba.py arla) passa a rodar aqui, de hora em hora. O vigia segue fazendo o mesmo na planilha, como cópia.
select cron.unschedule('bomba-repetir-arla') where exists (select 1 from cron.job where jobname = 'bomba-repetir-arla');
select cron.schedule('bomba-repetir-arla', '7 * * * *', 'select public.gestao_bomba_repetir_arla()');
