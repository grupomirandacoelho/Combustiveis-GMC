-- 26/11/2026, pedido do usuário: botão "Publicar nos dashboards" no Editar abastecimentos. Decisão do usuário: os dashboards
-- só mudam ao publicar ("Só ao publicar"): a publicação leva todos os abastecimentos até ontem (D-1), já validados; os de hoje e os
-- que chegam pelas APIs só entram na próxima publicação. O Editar abastecimentos (base-copia) e o Consolidador continuam na hora.
--  - public.painel_publicacao: até que dia está publicado, quem pediu e quando foi gerado;
--  - gestao_gerar_dados_painel: só as linhas até painel_publicacao.ate (e o arquivo leva "publicadoAte");
--  - gestao_dados_painel_rodar (pg_cron, 2 min): não refaz mais os painéis sozinho; gera quando há pedido de publicação;
--  - gestao_painel_publicar(usuario) pede (o portal chama; a geração leva até ~1 min e roda no agendamento, sem o limite de 8 s
--    da API) e gestao_painel_publicacao_info() devolve a situação. A primeira publicação (até ontem) já fica pedida aqui.
create table if not exists public.painel_publicacao (
  id           smallint primary key default 1 check (id = 1),
  ate          date,                     -- último dia publicado (ontem, no horário da Bahia, quando pediu)
  pedido_em    timestamptz,
  pedido_por   text,
  publicado_em timestamptz,              -- quando o arquivo dos painéis foi gerado com esse "ate"
  publicado_por text
);
alter table public.painel_publicacao enable row level security;
insert into public.painel_publicacao (id, ate, pedido_em, pedido_por)
values (1, (now() at time zone 'America/Bahia')::date - 1, now(), 'Primeira publicação (implantação)') on conflict (id) do nothing;

create or replace function public.gestao_gerar_dados_painel(p_forcar boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'gestao'
AS $$
declare
  assin text := public.gestao_assinatura_painel();
  atual text;
  agora timestamp := (now() at time zone 'America/Bahia');
  v_versao text := to_char(agora, 'YYYYMMDDHH24MISS');
  corpo text; n integer;
  -- publicação (26/11/2026): só os abastecimentos até o dia publicado; sem publicação, todos (como antes)
  v_ate date := (select ate from public.painel_publicacao where id = 1);
begin
  select assinatura into atual from public.dados_painel where id = 1;
  if not p_forcar and atual is not distinct from assin then return null; end if;

  create temporary table if not exists _r (i integer, linha integer, dia integer, seg integer, placa text, mot text, comb text, litros float8,
    vl float8, hod bigint, km bigint, desp float8, forn text, cid text, cc text, camp integer, tipo text, cartao text, serv text, ende text) on commit drop;
  truncate _r;
  insert into _r
  select (row_number() over (order by b.linha))::integer - 1, b.linha,
    (b.data_transacao::date - date '1970-01-01'),
    extract(hour from b.data_transacao)::integer * 3600 + extract(minute from b.data_transacao)::integer * 60 + floor(extract(second from b.data_transacao))::integer,
    upper(public.gestao_texto(b.placa)), upper(public.gestao_texto(b.nome_motorista)), upper(public.gestao_texto(b.tipo_combustivel)),
    round(b.litros::numeric, 4)::float8, round(b.vl_litro::numeric, 4)::float8,
    round(b.hodometro_ou_horimetro::numeric)::bigint, round(b.km_rodados_ou_horas_trabalhadas::numeric)::bigint, round(b.valor_emissao::numeric, 4)::float8,
    public.gestao_texto(b.nome_estabelecimento),
    case when public.gestao_texto(b.cidade) <> '' and public.gestao_texto(b.uf) <> '' then public.gestao_texto(b.cidade) || ' - ' || public.gestao_texto(b.uf)
         else public.gestao_texto(b.cidade) end,
    upper(public.gestao_texto(b.informacao_adicional_3)),
    case when upper(public.gestao_texto(b.campanha)) in ('SIM', 'S') then 1 when upper(public.gestao_texto(b.campanha)) in ('NÃO', 'NAO', 'N') then 0 end,
    upper(public.gestao_texto(b.tipo_estabelecimento)),
    -- cartão usado (importar_base.cartao_usado): "Cartao Fisico" é o Ticket; vazio é Ticket só antes de 28/06/2025
    case
      when gestao.chave(b.forma_de_pagamento) = 'CARTAO FISICO' then 'TICKET'
      when gestao.chave(b.forma_de_pagamento) = '' then case when b.data_transacao::date < date '2025-06-28' then 'TICKET' else '' end
      else gestao.chave(b.forma_de_pagamento) end,
    public.gestao_texto(b.servico),
    array_to_string(array_remove(array[nullif(public.gestao_texto(b.endereco), ''), nullif(public.gestao_texto(b.bairro), '')], null), ', ')
  from public.base_transacoes b
  where b.data_transacao is not null and b.litros is not null
    and (v_ate is null or b.data_transacao::date <= v_ate);
  select count(*) into n from _r;

  -- KM rodado impossível (importar_base.corrigir_km_impossivel): só diesel; passa de 3.000 km e de 3x a diferença do hodômetro para
  -- o abastecimento anterior da mesma placa, com a diferença entre 1 e 3.000 km -> o KM vira a diferença
  update _r set km = c.dif from (
    select i, km, hod - lag(hod) over (partition by placa order by dia, coalesce(seg, 0), i) as dif
    from _r where hod is not null and comb like '%DIESEL%' and comb not like '%ARLA%') c
  where _r.i = c.i and c.km is not null and c.dif > 0 and c.dif <= 3000 and c.km > 3000 and c.km > 3 * c.dif;

  with
    d_placa as (select placa as v, row_number() over (order by min(i)) - 1 as k from _r group by placa),
    d_mot as (select mot as v, row_number() over (order by min(i)) - 1 as k from _r group by mot),
    d_comb as (select comb as v, row_number() over (order by min(i)) - 1 as k from _r group by comb),
    d_forn as (select forn as v, row_number() over (order by min(i)) - 1 as k from _r group by forn),
    d_cid as (select cid as v, row_number() over (order by min(i)) - 1 as k from _r group by cid),
    d_cc as (select cc as v, row_number() over (order by min(i)) - 1 as k from _r group by cc),
    d_tipo as (select tipo as v, row_number() over (order by min(i)) - 1 as k from _r group by tipo),
    d_cartao as (select cartao as v, row_number() over (order by min(i)) - 1 as k from _r group by cartao),
    linhas as (
      select r.*, p.k as kp, m.k as km_, c.k as kc, f.k as kf, ci.k as kci, cc.k as kcc, t.k as kt, ca.k as kca
      from _r r join d_placa p on p.v = r.placa join d_mot m on m.v = r.mot join d_comb c on c.v = r.comb join d_forn f on f.v = r.forn
        join d_cid ci on ci.v = r.cid join d_cc cc on cc.v = r.cc join d_tipo t on t.v = r.tipo join d_cartao ca on ca.v = r.cartao),
    veic as (
      select v.placa, json_build_object('categoria', nullif(upper(public.gestao_texto(v.categoria)), ''), 'modelo', nullif(public.gestao_texto(v.modelo), ''),
        'unidade', u.nome, 'meta', round(v.meta_km_l::numeric, 4)::float8, 'tanque', round(v.capacidade_tanque_l::numeric, 2)::float8,
        'ano', v.ano_fabricacao::text, 'pc', round(v.ponto_critico_km_l::numeric, 3)::float8) as o
      from gestao.veiculos v left join gestao.unidades u on u.id = v.unidade_id where v.cadastrado),
    ende as (select distinct on (upper(forn)) upper(forn) as posto, ende from _r where ende <> '' order by upper(forn), i desc)
  select json_build_object(
    'versao', v_versao, 'geradoEm', to_char(agora, 'YYYY-MM-DD"T"HH24:MI:SS'), 'origem', 'banco (base_transacoes)', 'linhas', n, 'publicadoAte', to_char(v_ate, 'YYYY-MM-DD'),
    'dic', json_build_object(
      'placa', (select json_agg(v order by k) from d_placa), 'motorista', (select json_agg(v order by k) from d_mot),
      'combustivel', (select json_agg(v order by k) from d_comb), 'fornecedor', (select json_agg(v order by k) from d_forn),
      'cidade', (select json_agg(v order by k) from d_cid), 'cc', (select json_agg(v order by k) from d_cc),
      'tipo_estab', (select json_agg(v order by k) from d_tipo), 'cartao', (select json_agg(v order by k) from d_cartao)),
    'veiculos', coalesce((select json_object_agg(placa, o) from veic), '{}'::json),
    'col', (select json_build_object(
      'data', json_agg(dia order by i), 'placa', json_agg(kp order by i), 'motorista', json_agg(km_ order by i),
      'combustivel', json_agg(kc order by i), 'litros', json_agg(litros order by i), 'vl_litro', json_agg(vl order by i),
      'hodometro', json_agg(hod order by i), 'km', json_agg(km order by i), 'despesa', json_agg(desp order by i),
      'fornecedor', json_agg(kf order by i), 'cidade', json_agg(kci order by i), 'cc', json_agg(kcc order by i),
      'campanha', json_agg(camp order by i), 'tipo_estab', json_agg(kt order by i), 'seg', json_agg(seg order by i),
      'cartao', json_agg(kca order by i)) from linhas),
    'foraAbastecimento', coalesce((select json_agg(i order by i) from _r where serv <> 'Abastecimento'), '[]'::json),
    'enderecos', coalesce((select json_object_agg(posto, ende) from ende), '{}'::json)
  )::text into corpo;

  -- área do motorista (15.2 passo 1b, 19/11/2026): abastecimentos dos últimos 13 meses de cada motorista com os mesmos números
  -- dos painéis (km corrigido, posto, cidade), para o portal entregar a cada um só os dele (gestao_painel_motorista). Mesmo
  -- formato e período do scripts/painel_motoristas.mjs: [dia, seg, placa, combustível, posto, cidade, litros, km, hodômetro, 1/0].
  delete from public.dados_motoristas;
  insert into public.dados_motoristas (chave, linhas)
  select gestao.chave(mot), json_agg(json_build_array(dia, seg, placa, comb, forn, cid, coalesce(litros, 0), coalesce(km, 0), hod,
           case when serv <> 'Abastecimento' then 0 else 1 end) order by i)
  from _r
  where dia >= (select date_trunc('month', date '1970-01-01' + max(dia) - interval '12 months')::date - date '1970-01-01' from _r)
    and gestao.chave(mot) <> ''
  group by gestao.chave(mot);

  insert into public.dados_painel (id, assinatura, versao, gerado_em, linhas, dados) values (1, assin, v_versao, now(), n, corpo)
    on conflict (id) do update set assinatura = excluded.assinatura, versao = excluded.versao, gerado_em = excluded.gerado_em,
      linhas = excluded.linhas, dados = excluded.dados;
  return v_versao;
end $$;

create or replace function public.gestao_dados_painel_rodar() returns text language plpgsql security definer
set search_path = public, gestao as $$
declare m public.painel_mudancas; pb public.painel_publicacao; r text := null;
begin
  -- publicação pedida e ainda não gerada: gera o arquivo dos painéis até o dia pedido
  select * into pb from public.painel_publicacao where id = 1;
  if pb.pedido_em is not null and (pb.publicado_em is null or pb.pedido_em > pb.publicado_em) then
    perform public.gestao_gerar_dados_painel(true);
    update public.painel_publicacao set publicado_em = now(), publicado_por = pb.pedido_por where id = 1;
    r := 'publicado ate ' || pb.ate;
  end if;
  -- Editar abastecimentos e Consolidador: na hora, só quando algo mudou (ou uma vez por dia)
  select * into m from public.painel_mudancas where id = 1;
  if m.contador = m.visto and m.conferido_em > now() - interval '1 day' then return r; end if;
  perform public.gestao_gerar_base_copia(false);
  perform public.gestao_gerar_consolidacao(false);
  update public.painel_mudancas set visto = m.contador, conferido_em = now() where id = 1;
  return coalesce(r || '; ', '') || 'listas ate ' || m.contador;
end $$;

create or replace function public.gestao_painel_publicar(p_usuario text) returns jsonb language plpgsql security definer
set search_path = public as $$
begin
  update public.painel_publicacao set ate = (now() at time zone 'America/Bahia')::date - 1, pedido_em = now(),
    pedido_por = left(coalesce(nullif(btrim(p_usuario), ''), 'portal'), 80) where id = 1;
  return public.gestao_painel_publicacao_info();
end $$;

create or replace function public.gestao_painel_publicacao_info() returns jsonb language sql stable security definer
set search_path = public as $$
  select jsonb_build_object('ate', p.ate, 'pedidoEm', p.pedido_em, 'pedidoPor', p.pedido_por, 'publicadoEm', p.publicado_em,
    'publicadoPor', p.publicado_por, 'pendente', p.pedido_em is not null and (p.publicado_em is null or p.pedido_em > p.publicado_em),
    'versao', (select versao from public.dados_painel where id = 1))
  from public.painel_publicacao p where p.id = 1
$$;

-- a versão (ETag e aviso de dados novos) também diz até quando está publicado
create or replace function public.gestao_dados_painel_versao() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('versao', versao, 'geradoEm', gerado_em, 'linhas', linhas,
    'publicadoAte', (select ate from public.painel_publicacao where id = 1 and publicado_em is not null))
  from public.dados_painel where id = 1
$$;

revoke all on function public.gestao_painel_publicar(text) from public, anon, authenticated;
revoke all on function public.gestao_painel_publicacao_info() from public, anon, authenticated;
grant execute on function public.gestao_painel_publicar(text) to service_role;
grant execute on function public.gestao_painel_publicacao_info() to service_role;
notify pgrst, 'reload schema';
