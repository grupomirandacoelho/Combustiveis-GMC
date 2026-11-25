-- Migração 15.3, item 2 (25/11/2026; pedido do usuário "Pode começar os cartões frota"): a ligação do controle dos cartões frota
-- com o cadastro de placas, que o vigia fazia na planilha (scripts/planilha_cartoes.py sincronizar), no banco:
--   placa ativa (nem DESABILITADA nem VENDIDO) de categoria com cartão (CAVALO, TRUCK, TOCO, BITRUCK, 3/4, PICAPE) que falta entra
--   no fim, com os cartões vazios; placa do controle que está (ou já esteve) no cadastro e não deve ter cartão sai; placa que nunca
--   esteve no cadastro fica (aviso "fora do cadastro" no portal). Placa antiga e Mercosul são o mesmo veículo; as outras grafias da
--   aba Placas MERCOSUL também contam. As linhas que ficam são renumeradas em sequência.
-- p_gravar = false só diz o que faria (para comparar com o vigia antes da virada).
create table if not exists public.cartoes_placas_vistas (
  placa text primary key,            -- formato Mercosul: placas que já estiveram no cadastro (.dados/cartoes-placas-vistas.json)
  vista_em timestamptz not null default now()
);
alter table public.cartoes_placas_vistas enable row level security;

create or replace function public.gestao_mercosul(v text) returns text language sql immutable as $$
  select case when p ~ '^[A-Z]{3}[0-9]{4}$' then substr(p, 1, 4) || substr('ABCDEFGHIJ', substr(p, 5, 1)::int + 1, 1) || substr(p, 6) else p end
  from (select public.gestao_norm_placa_txt(v) as p) x
$$;

create or replace function public.gestao_sincronizar_cartoes(p_gravar boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  adicionadas text[]; removidas text[]; fora text[]; manter bigint[];
begin
  drop table if exists _cad;
  drop table if exists _cart;
  create temporary table _cad on commit drop as
    select distinct on (public.gestao_mercosul(placa)) public.gestao_mercosul(placa) as k, public.gestao_norm_placa_txt(placa) as placa,
      coalesce(upper(public.gestao_txt(situacao)), 'ATIVA') not in ('DESABILITADA', 'VENDIDO')
        and upper(coalesce(public.gestao_txt(categoria), '')) in ('CAVALO', 'TRUCK', 'TOCO', 'BITRUCK', '3/4', 'PICAPE') as quer
    from public.placas where public.gestao_norm_placa_txt(placa) is not null order by public.gestao_mercosul(placa), linha;
  create temporary table _cart on commit drop as
    select c.id, c.linha, public.gestao_norm_placa_txt(c.placa) as placa,
      array(select distinct public.gestao_mercosul(o) from unnest(array[c.placa] || coalesce((
        select array[m.placa_base, m.placa_ticketlog, m.placa_truckpag, m.placa_veloego, m.placa_protheus_referencia] from public.placas_mercosul m
        where public.gestao_norm_placa_txt(m.placa_protheus_referencia) = public.gestao_norm_placa_txt(c.placa) limit 1), '{}')) o
        where public.gestao_norm_placa_txt(o) is not null) as chaves
    from public.cartoes_placas c where public.gestao_norm_placa_txt(c.placa) is not null;

  select array_agg(c.id order by c.linha) filter (where exists (select 1 from _cad d where d.quer and d.k = any(c.chaves))
           or not exists (select 1 from _cad d where d.k = any(c.chaves))
              and not exists (select 1 from public.cartoes_placas_vistas v where v.placa = any(c.chaves))),
         array_agg(c.placa order by c.linha) filter (where not exists (select 1 from _cad d where d.quer and d.k = any(c.chaves))
           and (exists (select 1 from _cad d where d.k = any(c.chaves)) or exists (select 1 from public.cartoes_placas_vistas v where v.placa = any(c.chaves)))),
         array_agg(c.placa order by c.linha) filter (where not exists (select 1 from _cad d where d.k = any(c.chaves))
           and not exists (select 1 from public.cartoes_placas_vistas v where v.placa = any(c.chaves)))
    into manter, removidas, fora from _cart c;
  select array_agg(d.placa order by d.k) into adicionadas from _cad d
    where d.quer and not exists (select 1 from _cart c where d.k = any(c.chaves));

  if p_gravar then
    insert into public.cartoes_placas_vistas (placa) select k from _cad on conflict (placa) do nothing;
    if coalesce(cardinality(adicionadas), 0) + coalesce(cardinality(removidas), 0) > 0 then
      delete from public.cartoes_placas c where public.gestao_norm_placa_txt(c.placa) is not null and not (c.id = any(coalesce(manter, '{}')));
      update public.cartoes_placas c set linha = n.nova, sincronizado_em = now()
        from (select id, (row_number() over (order by linha) + 1)::int as nova from public.cartoes_placas c2
              where public.gestao_norm_placa_txt(c2.placa) is not null) n
        where c.id = n.id and c.linha <> n.nova;
      insert into public.cartoes_placas (linha, placa)
        select (select coalesce(max(linha), 1) from public.cartoes_placas) + row_number() over (order by a.ord), a.placa
        from unnest(coalesce(adicionadas, '{}')) with ordinality a(placa, ord);
    end if;
  end if;
  return jsonb_build_object('adicionadas', to_jsonb(coalesce(adicionadas, '{}')), 'removidas', to_jsonb(coalesce(removidas, '{}')),
    'foraDoCadastro', to_jsonb(coalesce(fora, '{}')), 'gravado', p_gravar);
end $$;
revoke all on function public.gestao_sincronizar_cartoes(boolean) from public, anon, authenticated;
grant execute on function public.gestao_sincronizar_cartoes(boolean) to service_role;
notify pgrst, 'reload schema';
