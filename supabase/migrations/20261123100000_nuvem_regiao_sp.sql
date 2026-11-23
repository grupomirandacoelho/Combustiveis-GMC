-- Passo 4 (23/11/2026): as rotinas da nuvem passam a rodar em São Paulo. O banco fica em us-east-1 e o pg_cron disparava as Edge
-- Functions lá; a TruckPag recusa chamadas de fora do Brasil (HTTP 403 "Acesso nao autorizado"), então desde 19/11 14:40 a simulação
-- das APIs dos cartões e dos estornos não lia a TruckPag. Diagnóstico: a mesma chamada deu 403 em us-east-1 e 200 em sa-east-1.
-- O cabeçalho x-region escolhe a região em que a função roda.
create or replace function public.gestao_nuvem_disparar() returns integer language plpgsql security definer
set search_path = public, extensions as $$
declare r record; v_url text; v_chave text; n integer := 0;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'url_projeto';
  select decrypted_secret into v_chave from vault.decrypted_secrets where name = 'chave_nuvem';
  if v_url is null or v_chave is null then return 0; end if;
  for r in select nome from public.nuvem_rotinas
           where modo <> 'desligado' and (disparada_em is null or disparada_em <= now() - make_interval(mins => intervalo_min) + interval '30 seconds')
  loop
    perform net.http_post(url := v_url || '/functions/v1/' || r.nome, body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-chave-nuvem', v_chave, 'x-region', 'sa-east-1'),
      timeout_milliseconds := 10000);
    update public.nuvem_rotinas set disparada_em = now() where nome = r.nome;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.gestao_nuvem_disparar() from public, anon, authenticated;
