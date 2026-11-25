-- 25/11/2026 (15.4; pedido do usuário "Pode rodar" para deixar mais leve a rotina dos painéis): o agendamento 'gestao-dados-painel'
-- rodava a cada 2 minutos e, mesmo sem nada novo, lia as 63 mil linhas dos abastecimentos para calcular a assinatura (md5 de tudo,
-- ~1 s com o banco folgado e até 55 s nas horas de pico; 3 h de banco por dia e 78 falhas por tempo esgotado em 24 h). Agora um
-- contador é somado por gatilhos (uma vez por comando, não por linha) quando muda algo que os arquivos usam (base_transacoes,
-- gestao.veiculos, gestao.unidades); o agendamento só chama os geradores quando o contador andou. Uma vez por dia confere tudo de
-- qualquer jeito (segurança, com as mesmas assinaturas de antes). Os geradores e os arquivos não mudam.
create table if not exists public.painel_mudancas (
  id           smallint primary key default 1 check (id = 1),
  contador     bigint not null default 1,      -- soma a cada comando que mexe nas tabelas de origem
  visto        bigint not null default 0,      -- contador da última geração que terminou bem
  mudou_em     timestamptz,
  conferido_em timestamptz                     -- última vez que os geradores rodaram (com ou sem mudança)
);
insert into public.painel_mudancas (id) values (1) on conflict (id) do nothing;
alter table public.painel_mudancas enable row level security;

create or replace function public.gestao_painel_marcar() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.painel_mudancas set contador = contador + 1, mudou_em = now() where id = 1;
  return null;
end $$;

drop trigger if exists painel_mudou on public.base_transacoes;
create trigger painel_mudou after insert or update or delete or truncate on public.base_transacoes
  for each statement execute function public.gestao_painel_marcar();
drop trigger if exists painel_mudou on gestao.veiculos;
create trigger painel_mudou after insert or update or delete or truncate on gestao.veiculos
  for each statement execute function public.gestao_painel_marcar();
drop trigger if exists painel_mudou on gestao.unidades;
create trigger painel_mudou after insert or update or delete or truncate on gestao.unidades
  for each statement execute function public.gestao_painel_marcar();

-- o que o agendamento chama: tudo numa transação (se um gerador falhar, 'visto' não anda e a próxima rodada tenta de novo)
create or replace function public.gestao_dados_painel_rodar() returns text language plpgsql security definer
set search_path = public, gestao as $$
declare m public.painel_mudancas;
begin
  select * into m from public.painel_mudancas where id = 1;
  if m.contador = m.visto and m.conferido_em > now() - interval '1 day' then return null; end if;
  perform public.gestao_gerar_dados_painel(false);
  perform public.gestao_gerar_base_copia(false);
  perform public.gestao_gerar_consolidacao(false);
  update public.painel_mudancas set visto = m.contador, conferido_em = now() where id = 1;
  return 'gerado ate ' || m.contador;
end $$;
revoke all on function public.gestao_dados_painel_rodar() from public, anon, authenticated;
revoke all on function public.gestao_painel_marcar() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'gestao-dados-painel';
select cron.schedule('gestao-dados-painel', '*/2 * * * *', $cron$select public.gestao_dados_painel_rodar()$cron$);
notify pgrst, 'reload schema';
