-- 25/11/2026 (pedido do usuário: "só vai ser enviado uma vez por ano e não vai ter substituição, então não vai precisar de apagar o
-- antigo, visto que o próximo a ser enviado vai ser o do próximo ano"): o envio do orçamento pela tela Real x Orçado só ACRESCENTA os
-- anos que ainda não estão no portal. Ano que já está fica como está (não é substituído nem apagado); planilha só com anos já
-- enviados é recusada sem gravar nada. Unidades da aba BD_UND: as novas entram, as que já existem têm o INF ADICIONAL e o centro de
-- custo atualizados (nenhuma sai). Nada é apagado.
create or replace function public.gestao_orcamento_importar(p_arquivo text, p_usuario text, p_metas jsonb, p_unidades jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  existentes int[]; novos int[]; ja int[]; n_metas integer; n_und integer; base integer;
begin
  if jsonb_typeof(p_metas) <> 'array' or jsonb_array_length(p_metas) = 0 or jsonb_typeof(p_unidades) <> 'array' or jsonb_array_length(p_unidades) = 0 then
    return jsonb_build_object('ok', false, 'erro', 'A planilha precisa das abas Base_Metas e BD_UND com dados.');
  end if;
  select coalesce(array_agg(distinct extract(year from data)::int), '{}') into existentes from public.orcamento_metas where data is not null;
  select coalesce(array_agg(distinct a order by a) filter (where not (a = any(existentes))), '{}'),
         coalesce(array_agg(distinct a order by a) filter (where a = any(existentes)), '{}')
    into novos, ja
    from (select left(x->>'data', 4)::int as a from jsonb_array_elements(p_metas) x) y;
  if cardinality(novos) = 0 then
    return jsonb_build_object('ok', false, 'erro', 'O orçamento de ' || array_to_string(ja, ', ') ||
      ' já está no portal (não é substituído). Nada foi gravado.', 'anosJaExistentes', to_jsonb(ja));
  end if;
  select coalesce(max(linha), 1) into base from public.orcamento_metas;
  insert into public.orcamento_metas (linha, unidade, natureza, data, valor)
    select base + (row_number() over (order by o))::int, x->>'unidade', x->>'natureza', (x->>'data')::date, (x->>'valor')::double precision
    from jsonb_array_elements(p_metas) with ordinality t(x, o)
    where left(x->>'data', 4)::int = any(novos);
  get diagnostics n_metas = row_count;
  -- unidades: atualiza as que já existem (mesmo nome) e acrescenta as novas
  update public.orcamento_unidades u set inf_adicional = coalesce(x->>'inf_adicional', u.inf_adicional),
    centro_de_custo = coalesce(x->>'centro_de_custo', u.centro_de_custo), sincronizado_em = now()
    from jsonb_array_elements(p_unidades) x
    where public.gestao_chave_txt(u.unidade) = public.gestao_chave_txt(x->>'unidade');
  insert into public.orcamento_unidades (linha, unidade, inf_adicional, centro_de_custo)
    select (select coalesce(max(linha), 1) from public.orcamento_unidades) + (row_number() over (order by o))::int,
           x->>'unidade', x->>'inf_adicional', x->>'centro_de_custo'
    from jsonb_array_elements(p_unidades) with ordinality t(x, o)
    where not exists (select 1 from public.orcamento_unidades u where public.gestao_chave_txt(u.unidade) = public.gestao_chave_txt(x->>'unidade'));
  get diagnostics n_und = row_count;
  insert into public.parametros (nome, valor, atualizado_em)
  values ('orcamento_envio', jsonb_build_object('arquivo', p_arquivo, 'usuario', p_usuario, 'em', now(), 'anos', to_jsonb(novos)), now())
  on conflict (nome) do update set valor = excluded.valor, atualizado_em = now();
  return jsonb_build_object('ok', true, 'metas', n_metas, 'unidades', n_und, 'anosNovos', to_jsonb(novos), 'anosJaExistentes', to_jsonb(ja));
exception when others then
  return jsonb_build_object('ok', false, 'erro', 'Nada foi gravado: ' || sqlerrm);
end $$;

-- a tela mostra, antes de enviar, quais anos já estão no portal
create or replace function public.gestao_orcamento_info() returns json language sql stable security definer
set search_path = public as $$
  with m as (select greatest((select max(sincronizado_em) from public.orcamento_metas), (select max(sincronizado_em) from public.orcamento_unidades),
                             (select atualizado_em from public.parametros where nome = 'orcamento_envio')) as em,
                    (select count(*) from public.orcamento_metas)::text || '|' || (select count(*) from public.orcamento_unidades)::text as n)
  select json_build_object('versao', md5(coalesce(em::text, '') || '|' || n),
    'atualizadoEm', to_char(em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'envio', (select valor from public.parametros where nome = 'orcamento_envio'),
    'anos', coalesce((select json_agg(a order by a) from (select distinct extract(year from data)::int as a
                      from public.orcamento_metas where data is not null) y), '[]'::json)) from m
$$;
notify pgrst, 'reload schema';
