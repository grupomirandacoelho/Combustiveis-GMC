-- Migração 15.3, item 6 (25/11/2026; pedido do usuário "Pode seguir com o upload do orçamento"; decisão: o orçamento continua sendo
-- preenchido no Excel e é enviado pelo portal): a planilha Banco_Orçamento_Despesas_Frota (abas Base_Metas e BD_UND, espelhadas em
-- public.orcamento_metas e public.orcamento_unidades) passa a ser importada pela tela Real x Orçado, e os painéis leem o orçamento do
-- banco no mesmo formato que o vigia publicava (scripts/importar_base.py ler_orcamento):
--   {arquivo, unidades: [[unidade, inf adicional]], linhas: [[unidade, natureza, 'AAAA-MM', valor]]} (soma as repetidas, 2 casas)

-- quem enviou por último (nome do arquivo, usuário, data): public.parametros 'orcamento_envio'
insert into public.parametros (nome, valor) values ('orcamento_envio', '{"arquivo": "Banco_Orçamento_Despesas_Frota.xlsx", "usuario": null}')
on conflict (nome) do nothing;

create or replace function public.gestao_orcamento_extras() returns json language sql stable security definer
set search_path = public as $$
  select json_build_object('orcamento', case when exists (select 1 from public.orcamento_metas) then json_build_object(
    'arquivo', (select valor->>'arquivo' from public.parametros where nome = 'orcamento_envio'),
    'unidades', coalesce((select json_agg(json_build_array(public.gestao_txt(unidade), upper(public.gestao_txt(inf_adicional))) order by linha)
                          from public.orcamento_unidades where public.gestao_txt(unidade) is not null and public.gestao_txt(inf_adicional) is not null), '[]'::json),
    'linhas', coalesce((select json_agg(json_build_array(u, n, m, round(v::numeric, 2)) order by u collate "C", n collate "C", m collate "C")
                        from (select public.gestao_txt(unidade) as u, upper(public.gestao_txt(natureza)) as n, to_char(data, 'YYYY-MM') as m, sum(valor) as v
                              from public.orcamento_metas
                              where public.gestao_txt(unidade) is not null and public.gestao_txt(natureza) is not null and data is not null and valor is not null
                              group by 1, 2, 3) s), '[]'::json)) end)
$$;

create or replace function public.gestao_orcamento_info() returns json language sql stable security definer
set search_path = public as $$
  with m as (select greatest((select max(sincronizado_em) from public.orcamento_metas), (select max(sincronizado_em) from public.orcamento_unidades),
                             (select atualizado_em from public.parametros where nome = 'orcamento_envio')) as em,
                    (select count(*) from public.orcamento_metas)::text || '|' || (select count(*) from public.orcamento_unidades)::text as n)
  select json_build_object('versao', md5(coalesce(em::text, '') || '|' || n),
    'atualizadoEm', to_char(em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'envio', (select valor from public.parametros where nome = 'orcamento_envio')) from m
$$;

-- importação pelo portal: troca o orçamento inteiro numa transação (o que não couber no tipo desfaz tudo)
--   p_metas:    [{unidade, natureza, data 'AAAA-MM-DD', valor}]       (aba Base_Metas, na ordem da planilha)
--   p_unidades: [{unidade, inf_adicional, centro_de_custo}]          (aba BD_UND)
create or replace function public.gestao_orcamento_importar(p_arquivo text, p_usuario text, p_metas jsonb, p_unidades jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n_metas integer; n_und integer;
begin
  if jsonb_typeof(p_metas) <> 'array' or jsonb_array_length(p_metas) = 0 or jsonb_typeof(p_unidades) <> 'array' or jsonb_array_length(p_unidades) = 0 then
    return jsonb_build_object('ok', false, 'erro', 'A planilha precisa das abas Base_Metas e BD_UND com dados.');
  end if;
  delete from public.orcamento_metas;
  insert into public.orcamento_metas (linha, unidade, natureza, data, valor)
    select (o + 1)::int, x->>'unidade', x->>'natureza', (x->>'data')::date, (x->>'valor')::double precision
    from jsonb_array_elements(p_metas) with ordinality t(x, o);
  get diagnostics n_metas = row_count;
  delete from public.orcamento_unidades;
  insert into public.orcamento_unidades (linha, unidade, inf_adicional, centro_de_custo)
    select (o + 1)::int, x->>'unidade', x->>'inf_adicional', x->>'centro_de_custo'
    from jsonb_array_elements(p_unidades) with ordinality t(x, o);
  get diagnostics n_und = row_count;
  insert into public.parametros (nome, valor, atualizado_em)
  values ('orcamento_envio', jsonb_build_object('arquivo', p_arquivo, 'usuario', p_usuario, 'em', now()), now())
  on conflict (nome) do update set valor = excluded.valor, atualizado_em = now();
  return jsonb_build_object('ok', true, 'metas', n_metas, 'unidades', n_und);
exception when others then
  return jsonb_build_object('ok', false, 'erro', 'Nada foi gravado: ' || sqlerrm);
end $$;

revoke all on function public.gestao_orcamento_extras() from public, anon, authenticated;
revoke all on function public.gestao_orcamento_info() from public, anon, authenticated;
revoke all on function public.gestao_orcamento_importar(text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.gestao_orcamento_extras() to service_role;
grant execute on function public.gestao_orcamento_info() to service_role;
grant execute on function public.gestao_orcamento_importar(text, text, jsonb, jsonb) to service_role;
notify pgrst, 'reload schema';
