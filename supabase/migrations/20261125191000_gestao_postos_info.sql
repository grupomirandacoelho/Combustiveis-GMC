-- 15.3 itens 4 e 5 (25/11/2026): versão e data da lista de postos e das coordenadas no banco. A versão entra no etag dos dados dos
-- painéis (lib/dados-painel.js EXTRAS_BANCO) e a data aparece na tela Postos dos motoristas (antes vinha do KV "postos-info").
create or replace function public.gestao_postos_info() returns json language sql stable security definer
set search_path = public as $$
  with m as (select greatest(
      (select max(sincronizado_em) from public.negociacoes), (select max(sincronizado_em) from public.postos_localizacao),
      (select max(atualizado_em) from public.postos_coordenadas), (select max(atualizado_em) from public.parametros)) as em,
    (select count(*) from public.negociacoes)::text || '|' || (select count(*) from public.postos_localizacao)::text || '|' ||
    (select count(*) from public.postos_coordenadas)::text as n)
  select json_build_object('versao', md5(coalesce(em::text, '') || '|' || n),
    'atualizadoEm', to_char(em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) from m
$$;
revoke all on function public.gestao_postos_info() from public, anon, authenticated;
grant execute on function public.gestao_postos_info() to service_role;
notify pgrst, 'reload schema';
