-- 25/11/2026 (pedido do usuário: "pode tirar aquele botão de 'Enviar planilha' e inclui um Botão pequeno no lado direito dos filtros
-- escrito 'Orçamentos' e nele podendo alterar o orçamento de cada ano incluído ... excluir ou incluir"): o orçamento passa a ser
-- cuidado ano a ano pela janela "Orçamentos" do Real x Orçado. Cada ano vem da planilha (abas Base_Metas e BD_UND) que o usuário
-- escolhe; só as linhas daquele ano entram.
--   incluir: o ano não pode estar no portal; alterar: troca as linhas daquele ano (o ano tem de estar); excluir: tira o ano.
-- Unidades da aba BD_UND: as novas entram, as que já existem têm o INF ADICIONAL e o centro de custo atualizados (nenhuma sai).
-- Toda exclusão tem WHERE (a API do Supabase recusa DELETE sem WHERE: safeupdate).

create table if not exists public.orcamento_envios (
  ano integer primary key, arquivo text, usuario text, em timestamptz not null default now()
);
alter table public.orcamento_envios enable row level security;
-- anos que já estão no banco (vieram da planilha pelo vigia até a virada de 25/11/2026)
insert into public.orcamento_envios (ano, arquivo, usuario, em)
  select distinct extract(year from data)::int, (select valor->>'arquivo' from public.parametros where nome = 'orcamento_envio'), null,
         (select max(sincronizado_em) from public.orcamento_metas)
  from public.orcamento_metas where data is not null
on conflict (ano) do nothing;

create or replace function public.gestao_orcamento_anos() returns json language sql stable security definer
set search_path = public as $$
  select coalesce(json_agg(json_build_object(
      'ano', a.ano, 'linhas', a.linhas, 'unidades', a.unidades, 'meses', a.meses,
      'combustivel', a.combustivel, 'arla', a.arla, 'km', a.km,
      'arquivo', e.arquivo, 'usuario', e.usuario, 'em', to_char(e.em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    order by a.ano desc), '[]'::json)
  from (select extract(year from data)::int as ano, count(*) as linhas, count(distinct public.gestao_chave_txt(unidade)) as unidades,
               count(distinct date_trunc('month', data)) as meses,
               round(sum(valor) filter (where upper(public.gestao_txt(natureza)) = 'COMBUSTIVEL CAMINHAO')::numeric, 2) as combustivel,
               round(sum(valor) filter (where upper(public.gestao_txt(natureza)) = 'ARLA')::numeric, 2) as arla,
               round(sum(valor) filter (where upper(public.gestao_txt(natureza)) = 'KM')::numeric, 0) as km
        from public.orcamento_metas where data is not null group by 1) a
  left join public.orcamento_envios e on e.ano = a.ano
$$;

create or replace function public.gestao_orcamento_ano(p_acao text, p_ano integer, p_arquivo text, p_usuario text, p_metas jsonb, p_unidades jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare existe boolean; n_metas integer := 0; n_und integer := 0; base integer;
begin
  if p_acao not in ('incluir', 'alterar', 'excluir') or p_ano is null or p_ano < 2000 or p_ano > 2100 then
    return jsonb_build_object('ok', false, 'erro', 'Pedido inválido.');
  end if;
  existe := exists (select 1 from public.orcamento_metas where extract(year from data)::int = p_ano);
  if p_acao = 'incluir' and existe then
    return jsonb_build_object('ok', false, 'erro', 'O orçamento de ' || p_ano || ' já está no portal. Use "Alterar" para trocá-lo.');
  end if;
  if p_acao in ('alterar', 'excluir') and not existe then
    return jsonb_build_object('ok', false, 'erro', 'O orçamento de ' || p_ano || ' não está no portal.');
  end if;
  if p_acao <> 'excluir' then
    if jsonb_typeof(p_metas) <> 'array' or not exists (select 1 from jsonb_array_elements(p_metas) x where left(x->>'data', 4)::int = p_ano) then
      return jsonb_build_object('ok', false, 'erro', 'A planilha não tem linhas de ' || p_ano || ' na aba Base_Metas.');
    end if;
  end if;
  if p_acao in ('alterar', 'excluir') then
    delete from public.orcamento_metas where extract(year from data)::int = p_ano;
  end if;
  if p_acao = 'excluir' then
    delete from public.orcamento_envios where ano = p_ano;
    return jsonb_build_object('ok', true, 'ano', p_ano);
  end if;
  select coalesce(max(linha), 1) into base from public.orcamento_metas;
  insert into public.orcamento_metas (linha, unidade, natureza, data, valor)
    select base + (row_number() over (order by o))::int, x->>'unidade', x->>'natureza', (x->>'data')::date, (x->>'valor')::double precision
    from jsonb_array_elements(p_metas) with ordinality t(x, o)
    where left(x->>'data', 4)::int = p_ano;
  get diagnostics n_metas = row_count;
  if jsonb_typeof(p_unidades) = 'array' then
    update public.orcamento_unidades u set inf_adicional = coalesce(x->>'inf_adicional', u.inf_adicional),
      centro_de_custo = coalesce(x->>'centro_de_custo', u.centro_de_custo), sincronizado_em = now()
      from jsonb_array_elements(p_unidades) x
      where public.gestao_chave_txt(u.unidade) = public.gestao_chave_txt(x->>'unidade');
    insert into public.orcamento_unidades (linha, unidade, inf_adicional, centro_de_custo)
      select (select coalesce(max(linha), 1) from public.orcamento_unidades) + (row_number() over (order by o))::int,
             x->>'unidade', x->>'inf_adicional', x->>'centro_de_custo'
      from jsonb_array_elements(p_unidades) with ordinality t(x, o)
      where public.gestao_txt(x->>'unidade') is not null
        and not exists (select 1 from public.orcamento_unidades u where public.gestao_chave_txt(u.unidade) = public.gestao_chave_txt(x->>'unidade'));
    get diagnostics n_und = row_count;
  end if;
  insert into public.orcamento_envios (ano, arquivo, usuario, em) values (p_ano, p_arquivo, p_usuario, now())
  on conflict (ano) do update set arquivo = excluded.arquivo, usuario = excluded.usuario, em = now();
  insert into public.parametros (nome, valor, atualizado_em)
  values ('orcamento_envio', jsonb_build_object('arquivo', p_arquivo, 'usuario', p_usuario, 'em', now(), 'ano', p_ano), now())
  on conflict (nome) do update set valor = excluded.valor, atualizado_em = now();
  return jsonb_build_object('ok', true, 'ano', p_ano, 'metas', n_metas, 'unidades', n_und);
exception when others then
  return jsonb_build_object('ok', false, 'erro', 'Nada foi gravado: ' || sqlerrm);
end $$;

-- a versão (etag dos painéis) muda também quando um ano é excluído
create or replace function public.gestao_orcamento_info() returns json language sql stable security definer
set search_path = public as $$
  with m as (select greatest((select max(sincronizado_em) from public.orcamento_metas), (select max(sincronizado_em) from public.orcamento_unidades),
                             (select atualizado_em from public.parametros where nome = 'orcamento_envio'), (select max(em) from public.orcamento_envios)) as em,
                    (select count(*) from public.orcamento_metas)::text || '|' || (select count(*) from public.orcamento_unidades)::text || '|' ||
                    (select string_agg(ano::text, ',' order by ano) from public.orcamento_envios) as n)
  select json_build_object('versao', md5(coalesce(em::text, '') || '|' || coalesce(n, '')),
    'atualizadoEm', to_char(em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'envio', (select valor from public.parametros where nome = 'orcamento_envio'),
    'anos', coalesce((select json_agg(a order by a) from (select distinct extract(year from data)::int as a
                      from public.orcamento_metas where data is not null) y), '[]'::json)) from m
$$;

-- o envio da planilha inteira (substituído pela janela "Orçamentos") sai
drop function if exists public.gestao_orcamento_importar(text, text, jsonb, jsonb);

revoke all on function public.gestao_orcamento_anos() from public, anon, authenticated;
revoke all on function public.gestao_orcamento_ano(text, integer, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.gestao_orcamento_anos() to service_role;
grant execute on function public.gestao_orcamento_ano(text, integer, text, text, jsonb, jsonb) to service_role;
notify pgrst, 'reload schema';
