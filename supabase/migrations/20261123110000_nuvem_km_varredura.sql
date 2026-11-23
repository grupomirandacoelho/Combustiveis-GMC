-- Passo 4 (23/11/2026; pedido do usuário "Pode" para tirar do vigia o recálculo do KM e a varredura das filas):
-- 1) recálculo do KM no banco: quando um lote entra (gestao_aplicar_lote), gestao_km_seguintes(ids) devolve as correções do
--    abastecimento SEGUINTE de cada linha inserida, com a regra do scripts/km_recalcular.mjs (mesma placa e cadeia de combustível;
--    só troca o km que ainda é o antigo, contado do anterior ao inserido, ou vazio; km corrigido à mão fica; negativo não mexe).
--    Quem chama é o aplicador do portal (lib/aplicar-banco.js), que põe as correções na fila (banco e planilha de reserva);
-- 2) varredura das filas pelo pg_cron (a cada 2 min chama /api/sync/banco/aplicar do portal), no lugar do vigia;
-- 3) nuvem_rotinas.funcao: rotinas que não são Edge Function (só interruptor para o vigia pular a dele) não são disparadas.
alter table public.nuvem_rotinas add column if not exists funcao boolean not null default true;

create or replace function public.gestao_nuvem_disparar() returns integer language plpgsql security definer
set search_path = public, extensions as $$
declare r record; v_url text; v_chave text; n integer := 0;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'url_projeto';
  select decrypted_secret into v_chave from vault.decrypted_secrets where name = 'chave_nuvem';
  if v_url is null or v_chave is null then return 0; end if;
  for r in select nome from public.nuvem_rotinas
           where funcao and modo <> 'desligado' and (disparada_em is null or disparada_em <= now() - make_interval(mins => intervalo_min) + interval '30 seconds')
  loop
    perform net.http_post(url := v_url || '/functions/v1/' || r.nome, body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-chave-nuvem', v_chave, 'x-region', 'sa-east-1'),
      timeout_milliseconds := 10000);
    update public.nuvem_rotinas set disparada_em = now() where nome = r.nome;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.gestao_km_seguintes(p_ids bigint[]) returns json language sql stable security definer
set search_path = public, gestao as $$
  with ins as (
    select distinct public.gestao_norm_placa(b.placa) as p, public.gestao_cadeia_comb(b.tipo_combustivel) as c
    from public.base_transacoes b
    where b.id = any(p_ids) and b.hodometro_ou_horimetro is not null and b.data_transacao is not null),
  cad as (
    select b.id, b.linha, b.placa, b.data_transacao as dt, b.hodometro_ou_horimetro as hodo, b.km_rodados_ou_horas_trabalhadas as km,
      b.km_litro_ou_litros_hora as kml, b.litros, public.gestao_cadeia_comb(b.tipo_combustivel) as cadeia,
      lag(b.hodometro_ou_horimetro) over w as ant_hodo, lead(b.id) over w as seg_id
    from public.base_transacoes b
    join ins on ins.p = public.gestao_norm_placa(b.placa) and ins.c = public.gestao_cadeia_comb(b.tipo_combustivel)
    where b.hodometro_ou_horimetro is not null and b.data_transacao is not null
    window w as (partition by public.gestao_norm_placa(b.placa), public.gestao_cadeia_comb(b.tipo_combustivel)
                 order by b.data_transacao, b.hodometro_ou_horimetro, b.id)),
  calc as (
    select distinct on (s.id) s.id, s.linha, s.placa, s.dt, s.km, s.kml, s.litros, s.cadeia,
      round((s.hodo - x.hodo)::numeric, 2) as km_novo,
      case when x.ant_hodo is null then null else round((s.hodo - x.ant_hodo)::numeric, 2) end as km_antigo
    from cad x join cad s on s.id = x.seg_id
    where x.id = any(p_ids)
    order by s.id, x.dt)
  select coalesce(json_agg(json_build_object(
      'linha', linha, 'placa', placa, 'data', public.gestao_serial(dt),
      -- tanque: a planilha de reserva não confunde diesel e Arla no mesmo segundo (TMZ6D31, 23/11/2026)
      'tanque', case when cadeia = 'DIESEL' then 'diesel' when cadeia like '%ARLA%' then 'arla' end,
      'celulas', json_build_object('R', km_novo, 'S', case when litros > 0 then round(km_novo / litros::numeric, 4) end),
      'antes', json_build_object('R', km, 'S', kml)) order by dt), '[]'::json)
  from calc
  where km_novo >= 0
    and not (km is not null and abs(km - km_novo) < 0.5)
    and not (km is not null and (km_antigo is null or abs(km - km_antigo) >= 0.5))
$$;

-- varredura das filas: o portal reaplica no banco o que ficou pendente (banco fora do ar na hora da gravação)
create or replace function public.gestao_nuvem_varrer_filas() returns void language plpgsql security definer
set search_path = public, extensions as $$
declare v_site text; v_token text;
begin
  if public.gestao_nuvem_modo('varredura-filas') <> 'ligado' then return; end if;
  select decrypted_secret into v_site from vault.decrypted_secrets where name = 'site_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'sync_token';
  if v_site is null or v_token is null then return; end if;
  perform net.http_post(url := v_site || '/api/sync/banco/aplicar', body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token), timeout_milliseconds := 30000);
  update public.nuvem_rotinas set disparada_em = now() where nome = 'varredura-filas';
end $$;

revoke all on function public.gestao_nuvem_disparar(), public.gestao_km_seguintes(bigint[]), public.gestao_nuvem_varrer_filas() from public, anon, authenticated;
grant execute on function public.gestao_km_seguintes(bigint[]) to service_role;

-- interruptores (começam desligados: ligar depois de publicar o portal)
insert into public.nuvem_rotinas (nome, modo, intervalo_min, funcao) values ('km-recalcular', 'desligado', 5, false), ('varredura-filas', 'desligado', 2, false)
on conflict (nome) do update set funcao = false;

select cron.unschedule('nuvem-varredura-filas') where exists (select 1 from cron.job where jobname = 'nuvem-varredura-filas');
select cron.schedule('nuvem-varredura-filas', '*/2 * * * *', $$select public.gestao_nuvem_varrer_filas()$$);
notify pgrst, 'reload schema';
