-- Migração 15.3, item 3 (25/11/2026; pedido do usuário "finalizando segue com a bomba interna"): os preços negociados e o cadastro
-- dos fornecedores das bombas internas (planilha CONTROLES\Negociação bomba interna.xlsx, espelhada em public.bomba_precos e
-- public.bomba_fornecedores) no mesmo formato que o vigia põe nos dados dos painéis (scripts/importar_base.py ler_bomba_interna):
--   negociacao: {dic: {fornecedor, produto, unidade}, col: {data (dias desde 1970-01-01), fornecedor, produto, unidade (índices
--               no dic, na ordem em que aparecem), preco (4 casas)}}; só linhas com data, fornecedor e preço > 0 (zerado = vazio)
--   fornecedoresBomba: [[fornecedor, produto, unidade, ativo, cnpj (14 números ou null)]]
-- e o mesmo cadastro para o Rateio das NFs e as Movimentações (KV "fornecedores-bomba": {fornecedores, geradoEm}).
create or replace function public.gestao_chave_txt(v text) returns text language sql immutable as $$
  -- planilha_bomba.chave: sem acento, maiúsculas, espaços juntados
  select coalesce(upper(regexp_replace(btrim(translate(coalesce(v, ''),
    'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN')), '\s+', ' ', 'g')), '')
$$;

create or replace function public.gestao_bomba_fornecedores_lista() returns json language sql stable security definer
set search_path = public as $$
  select coalesce(json_agg(json_build_array(
      upper(public.gestao_txt(fornecedor)), upper(coalesce(public.gestao_txt(produto), '')), upper(coalesce(public.gestao_txt(unidade), '')),
      coalesce(upper(public.gestao_txt(ativo)), '') not in ('NAO', 'NÃO', 'N'),
      case when length(regexp_replace(coalesce(cnpj, ''), '\D', '', 'g')) = 14 then regexp_replace(cnpj, '\D', '', 'g') end)
    order by linha), '[]'::json)
  from public.bomba_fornecedores where public.gestao_txt(fornecedor) is not null
$$;

create or replace function public.gestao_bomba_extras() returns json language sql stable security definer
set search_path = public as $$
  with l as (
    select linha, data, upper(public.gestao_txt(fornecedor)) as f, upper(coalesce(public.gestao_txt(produto), '')) as p,
           upper(coalesce(public.gestao_txt(unidade), '')) as u, round(preco::numeric, 4) as preco
    from public.bomba_precos
    where data is not null and preco > 0 and public.gestao_txt(fornecedor) is not null),
  df as (select f as v, (row_number() over (order by min(linha)) - 1)::int as i from l group by f),
  dp as (select p as v, (row_number() over (order by min(linha)) - 1)::int as i from l group by p),
  du as (select u as v, (row_number() over (order by min(linha)) - 1)::int as i from l group by u)
  select json_build_object(
    'negociacao', json_build_object(
      'dic', json_build_object(
        'fornecedor', coalesce((select json_agg(v order by i) from df), '[]'::json),
        'produto', coalesce((select json_agg(v order by i) from dp), '[]'::json),
        'unidade', coalesce((select json_agg(v order by i) from du), '[]'::json)),
      'col', json_build_object(
        'data', coalesce((select json_agg((l.data - date '1970-01-01') order by l.linha) from l), '[]'::json),
        'fornecedor', coalesce((select json_agg(df.i order by l.linha) from l join df on df.v = l.f), '[]'::json),
        'produto', coalesce((select json_agg(dp.i order by l.linha) from l join dp on dp.v = l.p), '[]'::json),
        'unidade', coalesce((select json_agg(du.i order by l.linha) from l join du on du.v = l.u), '[]'::json),
        'preco', coalesce((select json_agg(l.preco order by l.linha) from l), '[]'::json))),
    'fornecedoresBomba', public.gestao_bomba_fornecedores_lista())
$$;

-- muda sempre que um preço ou um fornecedor muda (o portal refaz os dados dos painéis só quando a versão muda)
create or replace function public.gestao_bomba_versao() returns text language sql stable security definer
set search_path = public as $$
  select md5(coalesce((select max(sincronizado_em)::text || count(*) from public.bomba_precos), '') || '|' ||
             coalesce((select max(sincronizado_em)::text || count(*) from public.bomba_fornecedores), ''))
$$;

revoke all on function public.gestao_bomba_extras() from public, anon, authenticated;
revoke all on function public.gestao_bomba_fornecedores_lista() from public, anon, authenticated;
revoke all on function public.gestao_bomba_versao() from public, anon, authenticated;
grant execute on function public.gestao_bomba_extras() to service_role;
grant execute on function public.gestao_bomba_fornecedores_lista() to service_role;
grant execute on function public.gestao_bomba_versao() to service_role;
notify pgrst, 'reload schema';
