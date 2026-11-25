-- Migração 15.3, itens 4 e 5 (25/11/2026; pedido do usuário "Pode seguir com as negociações e a localização dos postos"):
-- negociações com os postos externos (planilha "Gestão de negociações de preço", espelho public.negociacoes) e coordenadas dos
-- postos (planilha "LOCALIZAÇÃO DOS POSTOS", espelho public.postos_localizacao) no mesmo formato que o vigia publica:
--   gestao_postos_extras(): as partes "negPostos", "locais" e "locaisSuspeitos" dos dados dos painéis (scripts/importar_base.py)
--   gestao_postos_csv():    a lista dos motoristas, KV "postos" (scripts/planilha_negociacao.py gerar_postos)
-- O que ficava fora das planilhas vem para tabelas próprias (carga inicial: scripts/postos_semente.py):
--   public.municipios_sedes     sede de cada município (public/gestao/mapas/municipios.json): coordenada longe da cidade = suspeita
--   public.postos_coordenadas   'semente' = lista antiga dos motoristas (public/postos.csv); 'portal' = digitadas no portal
--                               (.dados/coordenadas-postos.json), que valem mais que a planilha
--   public.parametros           limites da aba de negociações (R1:W1 da planilha)

create table if not exists public.municipios_sedes (
  chave text not null, uf text not null, lat double precision not null, lng double precision not null,
  primary key (chave, uf));
create table if not exists public.postos_coordenadas (
  chave text not null, origem text not null check (origem in ('semente', 'portal')), lat text not null, lon text not null,
  atualizado_em timestamptz not null default now(), primary key (chave, origem));
create table if not exists public.parametros (nome text primary key, valor jsonb not null, atualizado_em timestamptz not null default now());
alter table public.municipios_sedes enable row level security;
alter table public.postos_coordenadas enable row level security;
alter table public.parametros enable row level security;

-- importar_base.chave_cidade: sem acento, maiúsculas, hífen e apóstrofo viram espaço
create or replace function public.gestao_chave_cidade(v text) returns text language sql immutable as $$
  select public.gestao_chave_txt(replace(replace(coalesce(v, ''), '-', ' '), '''', ' '))
$$;
-- importar_base.coordenada: número digitado sem a vírgula decimal (-16658807) tenta 6, 7 e 5 casas; fora do Brasil = nada
create or replace function public.gestao_coordenada(x double precision, latitude boolean) returns double precision language sql immutable as $$
  select case
    when x is null then null
    when (latitude and x > -35 and x < 6) or (not latitude and x > -75 and x < -30) then x
    when abs(x) >= 1000 and x = trunc(x) then (
      select y from (values (1, x / 1e6), (2, x / 1e7), (3, x / 1e5)) t(o, y)
      where (latitude and y > -35 and y < 6) or (not latitude and y > -75 and y < -30) order by o limit 1)
  end
$$;
create or replace function public.gestao_distancia_km(lat1 float8, lng1 float8, lat2 float8, lng2 float8) returns float8 language sql immutable as $$
  select 2 * 6371 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

create or replace function public.gestao_postos_extras() returns json language sql stable security definer
set search_path = public as $$
  with n as (
    select linha, data_da_negociacao as d, upper(public.gestao_txt(posto_negociado)) as posto,
      coalesce(upper(public.gestao_txt(unidade)), '') as unidade, coalesce(upper(public.gestao_txt(cidade)), '') as cidade,
      coalesce(upper(public.gestao_txt(tipo)), '') as tipo, coalesce(upper(public.gestao_txt(plataforma)), '') as plataforma,
      coalesce(upper(public.gestao_txt(tipo_combustivel)), '') as combustivel, coalesce(upper(public.gestao_txt(observacao)), '') as status,
      coalesce(upper(public.gestao_txt(contato_da_negociacao)), '') as contato, coalesce(upper(public.gestao_txt(aviso)), '') as aviso,
      case when valor_negociado > 0 then round(valor_negociado::numeric, 4) end as valor,
      data_da_ultima_transacao_usada_para_o_preco as t
    from public.negociacoes where data_da_negociacao is not null and public.gestao_txt(posto_negociado) is not null),
  x as (
    select n.linha, c.campo, c.valor from n, lateral (values ('unidade', n.unidade), ('posto', n.posto), ('cidade', n.cidade), ('tipo', n.tipo),
      ('plataforma', n.plataforma), ('combustivel', n.combustivel), ('status', n.status), ('contato', n.contato), ('aviso', n.aviso)) c(campo, valor)),
  v as (   -- dicionários: cada texto na ordem em que aparece
    select campo, valor, (row_number() over (partition by campo order by min(linha)) - 1)::int as i from x group by campo, valor),
  dic as (select campo, json_agg(valor order by i) as lista from v group by campo),
  col as (select x.campo, json_agg(v.i order by x.linha) as lista from x join v on v.campo = x.campo and v.valor = x.valor group by x.campo),
  loc as (
    select linha, upper(public.gestao_txt(nome_estabelecimento)) as nome,
      public.gestao_coordenada(latitude, true) as lat, public.gestao_coordenada(longitude, false) as lng,
      coalesce(public.gestao_txt(cidade), '') as cidade, coalesce(upper(public.gestao_txt(uf)), '') as uf
    from public.postos_localizacao),
  loc_ok as (   -- a sede da cidade da linha diz se a coordenada é suspeita (mais de 100 km)
    select l.*, (select public.gestao_distancia_km(l.lat, l.lng, s.lat, s.lng) from public.municipios_sedes s
                 where s.chave = public.gestao_chave_cidade(l.cidade) and s.uf = l.uf) as km
    from loc l where l.nome is not null and l.lat is not null and l.lng is not null),
  -- como o vigia: na ordem das linhas, a primeira boa de cada nome entra; suspeita fica de fora (e vai para a lista de suspeitas)
  -- se o nome ainda não tinha entrado
  ordem as (
    select o.*, (select min(b.linha) from loc_ok b where b.nome = o.nome and (b.km is null or b.km <= 100)) as primeira_boa
    from loc_ok o),
  bons as (select distinct on (nome) nome, lat, lng from ordem where (km is null or km <= 100) order by nome, linha),
  suspeitos as (select * from ordem where km > 100 and (primeira_boa is null or linha < primeira_boa))
  select json_build_object(
    'negPostos', case when exists (select 1 from n) then json_build_object(
      'dic', (select json_object_agg(campo, lista) from dic),
      'col', (select json_object_agg(campo, lista) from col)::jsonb || jsonb_build_object(
        'data', (select json_agg(d - date '1970-01-01' order by linha) from n),
        'valor', (select json_agg(valor order by linha) from n),
        'trans_dia', (select json_agg(t::date - date '1970-01-01' order by linha) from n),
        'trans_seg', (select json_agg((extract(epoch from t::time))::int order by linha) from n)),
      'limites', coalesce((select valor from public.parametros where nome = 'negociacoes_limites'),
                          '{"diasSemAtualizacao": 15, "variacao": 0.1, "diasRenegociacao": 90}'::jsonb)) end,
    'locais', coalesce((select json_object_agg(nome, json_build_array(round(lat::numeric, 6)::float8, round(lng::numeric, 6)::float8)) from bons), '{}'::json),
    'locaisSuspeitos', coalesce((select json_agg(json_build_object('nome', nome, 'cidade', upper(cidade), 'uf', uf,
        'lat', round(lat::numeric, 6)::float8, 'lng', round(lng::numeric, 6)::float8, 'km', round(km::numeric)) order by linha)
      from suspeitos), '[]'::json))
$$;

create or replace function public.gestao_postos_csv() returns text language sql stable security definer
set search_path = public as $$
  with n as (   -- a última negociação de cada (unidade, posto): o mesmo posto pode atender duas unidades
    select distinct on (public.gestao_chave_txt(unidade), public.gestao_chave_txt(posto_negociado))
      public.gestao_chave_txt(unidade) as uni, public.gestao_chave_txt(posto_negociado) as k, data_da_negociacao as d,
      public.gestao_txt(unidade) as unidade, public.gestao_txt(posto_negociado) as posto, public.gestao_txt(cidade) as cidade,
      public.gestao_txt(observacao) as status, public.gestao_txt(plataforma) as cartao, public.gestao_txt(aviso) as aviso,
      public.gestao_txt(tipo) as tipo
    from public.negociacoes
    where public.gestao_txt(posto_negociado) is not null and data_da_negociacao is not null
    order by public.gestao_chave_txt(unidade), public.gestao_chave_txt(posto_negociado), data_da_negociacao desc, linha desc),
  loc as (   -- planilha de localização: a primeira linha com coordenada de cada nome
    select distinct on (k) k, round(lat::numeric, 6)::float8::text as lat, round(lng::numeric, 6)::float8::text as lng
    from (select linha, public.gestao_chave_txt(nome_estabelecimento) as k, public.gestao_coordenada(latitude, true) as lat,
                 public.gestao_coordenada(longitude, false) as lng from public.postos_localizacao) x
    where k <> '' and lat is not null and lng is not null order by k, linha)
  select 'Unidade;Posto;Cidade;Status;Cartao;Latitude;Longitude;Aviso;Negociado;Tipo' || E'\n' || coalesce(string_agg(
    concat_ws(';',
      case n.uni when 'BELEM' then 'Belém' when 'CONQUISTA' then 'Conquista' when 'GOIANIA' then 'Goiânia'
        when 'GOVERNADOR VALADARES' then 'Governador Valadares' when 'ILHEUS' then 'Ilhéus' when 'JEQUIE' then 'Jequié'
        when 'MARANHAO' then 'Maranhão' when 'RECIFE' then 'Recife' when 'SALVADOR' then 'Salvador' when 'SAO PAULO' then 'São Paulo'
        when 'SERRA' then 'Serra' when 'TEIXEIRA' then 'Teixeira' else initcap(coalesce(n.unidade, '')) end,
      replace(coalesce(n.posto, ''), ';', ','), replace(coalesce(n.cidade, ''), ';', ','), replace(coalesce(n.status, ''), ';', ','),
      replace(coalesce(n.cartao, ''), ';', ','),
      -- digitada no portal > lista antiga > planilha de localização
      coalesce(p.lat, s.lat, l.lat, ''), coalesce(p.lon, s.lon, l.lng, ''),
      replace(coalesce(n.aviso, ''), ';', ','), to_char(n.d, 'YYYY-MM-DD'), upper(replace(coalesce(n.tipo, ''), ';', ','))),
    E'\n' order by n.uni collate "C", public.gestao_chave_txt(n.cidade) collate "C", n.k collate "C") || E'\n', '')
  from n
  left join public.postos_coordenadas p on p.chave = n.k and p.origem = 'portal'
  left join public.postos_coordenadas s on s.chave = n.k and s.origem = 'semente'
  left join loc l on l.k = n.k
  where n.d >= date '2026-09-15'   -- DATA_CORTE: negociação de antes não volta para a lista
$$;

revoke all on function public.gestao_postos_extras() from public, anon, authenticated;
revoke all on function public.gestao_postos_csv() from public, anon, authenticated;
grant execute on function public.gestao_postos_extras() to service_role;
grant execute on function public.gestao_postos_csv() to service_role;
notify pgrst, 'reload schema';
