-- Migração 15.3, item 2 (25/11/2026; pedido do usuário "Pode começar os cartões frota"): o controle dos cartões frota no mesmo
-- formato que o vigia publica na chave "cartoes" do KV (scripts/planilha_cartoes.py gerar): placa normalizada, cartões Ticket,
-- TruckPag e Veloe em maiúsculas, e as outras grafias da mesma placa (aba Placas MERCOSUL) em "apelidos".
create or replace function public.gestao_norm_placa_txt(v text) returns text language sql immutable as $$
  select nullif(upper(regexp_replace(coalesce(v, ''), '[^A-Za-z0-9]', '', 'g')), '')
$$;

create or replace function public.gestao_cartoes_lista() returns json language sql stable security definer
set search_path = public as $$
  with apelidos as (
    select ref, array_agg(distinct outra order by outra) as outras
    from (select public.gestao_norm_placa_txt(placa_protheus_referencia) as ref,
                 public.gestao_norm_placa_txt(unnest(array[placa_protheus_referencia, placa_base, placa_ticketlog, placa_truckpag, placa_veloego])) as outra
          from public.placas_mercosul) x
    where ref is not null and outra is not null and outra <> ref
    group by ref)
  select json_build_object(
    'cartoes', coalesce((select json_agg(
        jsonb_build_object('linha', c.linha, 'placa', public.gestao_norm_placa_txt(c.placa), 'ticket', upper(public.gestao_txt(c.ticket)),
                           'truckpag', upper(public.gestao_txt(c.truckpag)), 'veloe', upper(public.gestao_txt(c.veloe)))
        || case when a.outras is not null then jsonb_build_object('apelidos', to_jsonb(a.outras)) else '{}'::jsonb end
        order by c.linha)
      from public.cartoes_placas c left join apelidos a on a.ref = public.gestao_norm_placa_txt(c.placa)
      where public.gestao_norm_placa_txt(c.placa) is not null), '[]'::json),
    'atualizadoEm', to_char((select max(sincronizado_em) from public.cartoes_placas) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
$$;
revoke all on function public.gestao_cartoes_lista() from public, anon, authenticated;
grant execute on function public.gestao_cartoes_lista() to service_role;
notify pgrst, 'reload schema';
