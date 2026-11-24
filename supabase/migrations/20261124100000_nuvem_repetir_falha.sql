-- 24/11/2026: rotina que falhou é disparada de novo 10 min depois, sem esperar o intervalo inteiro. Visto em 24/11: a Conciliação
-- de NFs (6 h) falhou à 1:15 e às 7:15 (tempo esgotado lendo o nuvem_cache enquanto a Conferência lia o dela ao mesmo tempo) e só
-- tentaria de novo às 13:15. Falha = a última execução registrada da rotina não deu ok.
create or replace function public.gestao_nuvem_disparar() returns integer language plpgsql security definer
set search_path = public, extensions as $$
declare r record; v_url text; v_chave text; n integer := 0;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'url_projeto';
  select decrypted_secret into v_chave from vault.decrypted_secrets where name = 'chave_nuvem';
  if v_url is null or v_chave is null then return 0; end if;
  for r in select x.nome from public.nuvem_rotinas x
           where x.funcao and x.modo <> 'desligado'
             and (x.disparada_em is null
                  or x.disparada_em <= now() - make_interval(mins => x.intervalo_min) + interval '30 seconds'
                  or (x.disparada_em <= now() - interval '10 minutes'
                      and (select e.ok from public.nuvem_execucoes e where e.rotina = x.nome order by e.em desc limit 1) is false))
  loop
    perform net.http_post(url := v_url || '/functions/v1/' || r.nome, body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-chave-nuvem', v_chave, 'x-region', 'sa-east-1'),
      timeout_milliseconds := 10000);
    update public.nuvem_rotinas set disparada_em = now() where nome = r.nome;
    n := n + 1;
  end loop;
  return n;
end $$;
