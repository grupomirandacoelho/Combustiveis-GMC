-- 15.3 (25/11/2026; pedido do usuário "Pode seguir" com a busca de coordenadas na nuvem): os postos que a busca no OpenStreetMap
-- tenta localizar, com as regras do scripts/geocodificar_postos.py (candidatos e com_coordenada):
--   postos de diesel da operação (tipo do estabelecimento POSTO DE COMBUSTIVEL ou vazio; sem os motoristas do administrativo e sem o
--   centro de custo RAJA ADM), com quantos abastecimentos tiveram e a cidade/UF do último, que ainda não têm coordenada boa na
--   localização dos postos (válida e a até 100 km da sede da cidade da linha). Do mais abastecido para o menos.
create or replace function public.gestao_geo_candidatos() returns json language sql stable security definer
set search_path = public as $$
  -- a normalização dos nomes (gestao_chave_txt) roda só nas combinações distintas, não nas 63 mil linhas (a API corta em 8 s)
  with g as (
    select nome_estabelecimento, tipo_combustivel, tipo_estabelecimento, nome_motorista, informacao_adicional_3,
           count(*) as n, max(linha) as ult
    from public.base_transacoes where nome_estabelecimento is not null group by 1, 2, 3, 4, 5),
  f as (
    select public.gestao_chave_txt(nome_estabelecimento) as k, n, ult from g
    where public.gestao_txt(nome_estabelecimento) is not null
      and public.gestao_chave_txt(tipo_combustivel) like 'DIESEL%'
      and public.gestao_chave_txt(tipo_estabelecimento) in ('POSTO DE COMBUSTIVEL', '')
      and public.gestao_chave_txt(nome_motorista) not in ('CAIO COELHO DUTRA', 'JACY RODRIGUES COELHO')
      and public.gestao_chave_txt(informacao_adicional_3) <> 'RAJA ADM'),
  agrupado as (select k, sum(n)::int as n, max(ult) as ult from f group by k),
  postos as (   -- nome, cidade e UF do último abastecimento do posto
    select a.k, upper(btrim(t.nome_estabelecimento)) as nome, upper(btrim(coalesce(t.cidade, ''))) as cidade,
           upper(btrim(coalesce(t.uf, ''))) as uf, a.n
    from agrupado a join public.base_transacoes t on t.linha = a.ult),
  bons as (   -- coordenada válida e perto da cidade da própria linha (as suspeitas contam como sem coordenada)
    select distinct public.gestao_chave_txt(l.nome_estabelecimento) as k
    from public.postos_localizacao l
    left join public.municipios_sedes s on s.chave = public.gestao_chave_cidade(l.cidade) and s.uf = upper(btrim(coalesce(l.uf, '')))
    where public.gestao_txt(l.nome_estabelecimento) is not null
      and public.gestao_coordenada(l.latitude, true) is not null and public.gestao_coordenada(l.longitude, false) is not null
      and (s.chave is null or public.gestao_distancia_km(public.gestao_coordenada(l.latitude, true), public.gestao_coordenada(l.longitude, false), s.lat, s.lng) <= 100))
  select coalesce(json_agg(json_build_object('chave', p.k, 'nome', p.nome, 'cidade', p.cidade, 'uf', p.uf, 'n', p.n,
      'sede', (select json_build_array(s.lat, s.lng) from public.municipios_sedes s where s.chave = public.gestao_chave_cidade(p.cidade) and s.uf = p.uf))
    order by p.n desc, p.k), '[]'::json)
  from postos p where not exists (select 1 from bons where bons.k = p.k)
$$;
revoke all on function public.gestao_geo_candidatos() from public, anon, authenticated;
grant execute on function public.gestao_geo_candidatos() to service_role;
notify pgrst, 'reload schema';
