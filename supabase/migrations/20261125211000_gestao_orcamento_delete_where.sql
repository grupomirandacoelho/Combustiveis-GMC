-- 25/11/2026: o primeiro envio do orçamento pelo portal falhou: a API do Supabase (extensão safeupdate, carregada para o papel da
-- API) recusa DELETE sem WHERE; testado só pela conexão direta, onde ela não roda. Troca do orçamento com "where true".
create or replace function public.gestao_orcamento_importar(p_arquivo text, p_usuario text, p_metas jsonb, p_unidades jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n_metas integer; n_und integer;
begin
  if jsonb_typeof(p_metas) <> 'array' or jsonb_array_length(p_metas) = 0 or jsonb_typeof(p_unidades) <> 'array' or jsonb_array_length(p_unidades) = 0 then
    return jsonb_build_object('ok', false, 'erro', 'A planilha precisa das abas Base_Metas e BD_UND com dados.');
  end if;
  delete from public.orcamento_metas where true;   -- "where": a API do Supabase (safeupdate) recusa DELETE sem WHERE
  insert into public.orcamento_metas (linha, unidade, natureza, data, valor)
    select (o + 1)::int, x->>'unidade', x->>'natureza', (x->>'data')::date, (x->>'valor')::double precision
    from jsonb_array_elements(p_metas) with ordinality t(x, o);
  get diagnostics n_metas = row_count;
  delete from public.orcamento_unidades where true;
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
notify pgrst, 'reload schema';
