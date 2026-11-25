-- Migração 15.3, item 3, passo 2 (25/11/2026; pedido do usuário "finalizando segue com a bomba interna"): os pedidos da fila
-- alteracoes_bomba (Operacional > Preço bomba interna) aplicados direto em public.bomba_precos / public.bomba_fornecedores, com as
-- regras do scripts/planilha_bomba.py gravar:
--   negociacao: mesmo dia, fornecedor, produto e unidade troca o preço; senão linha nova no fim; o fornecedor entra (ou volta a
--               ATIVO) no cadastro; nomes sem acento e em maiúsculas
--   negociacao com excluir: o preço daquele dia fica vazio (a linha fica; lançamento vazio)
--   fornecedor: uma linha por unidade (ATIVO SIM/NAO); CNPJ informado: 14 números viram 00.000.000/0000-00, vazio apaga
-- e a repetição do Arla (planilha_bomba.py arla): fornecedor ATIVO de Arla cujo último preço numa unidade é de antes de hoje
-- ganha uma linha por dia (até 31 dias) com o mesmo preço. Só depois da virada da bomba (antes, o vigia faz na planilha).
alter table public."alteracoes_bomba" add column if not exists "banco_aplicado_em" text;
alter table public."alteracoes_bomba" add column if not exists "banco_mensagem" text;

create or replace function public.gestao_bomba_garantir_fornecedor(p_forn text, p_prod text, p_unid text, p_ativo boolean,
  p_cnpj text default null, p_tem_cnpj boolean default false) returns integer
language plpgsql security definer set search_path = public as $$
declare
  f text := public.gestao_chave_txt(p_forn); p text := public.gestao_chave_txt(p_prod); u text := public.gestao_chave_txt(p_unid);
  vid bigint; vlinha integer; n text := regexp_replace(coalesce(p_cnpj, ''), '\D', '', 'g');
begin
  select id, linha into vid, vlinha from public.bomba_fornecedores
   where public.gestao_chave_txt(fornecedor) = f and public.gestao_chave_txt(produto) = p and public.gestao_chave_txt(unidade) = u
   order by linha limit 1;
  if vid is null then
    insert into public.bomba_fornecedores (linha, fornecedor, produto, unidade, ativo)
    values ((select coalesce(max(linha), 1) + 1 from public.bomba_fornecedores), f, p, u, case when p_ativo then 'SIM' else 'NAO' end)
    returning id, linha into vid, vlinha;
  else
    update public.bomba_fornecedores set ativo = case when p_ativo then 'SIM' else 'NAO' end, sincronizado_em = now() where id = vid;
  end if;
  if p_tem_cnpj then
    update public.bomba_fornecedores set cnpj = case when length(n) = 14
      then substr(n, 1, 2) || '.' || substr(n, 3, 3) || '.' || substr(n, 6, 3) || '/' || substr(n, 9, 4) || '-' || substr(n, 13) end,
      sincronizado_em = now() where id = vid;
  end if;
  return vlinha;
end $$;

create or replace function public.gestao_bomba_negociacao(p_dia date, p_forn text, p_prod text, p_unid text, p_preco numeric) returns integer
language plpgsql security definer set search_path = public as $$
declare
  f text := public.gestao_chave_txt(p_forn); p text := public.gestao_chave_txt(p_prod); u text := public.gestao_chave_txt(p_unid);
  vid bigint; vlinha integer;
begin
  select id, linha into vid, vlinha from public.bomba_precos
   where data = p_dia and public.gestao_chave_txt(fornecedor) = f and public.gestao_chave_txt(produto) = p and public.gestao_chave_txt(unidade) = u
   order by linha desc limit 1;
  if vid is null then
    insert into public.bomba_precos (linha, data, fornecedor, produto, unidade, preco)
    values ((select coalesce(max(linha), 1) + 1 from public.bomba_precos), p_dia, f, p, u, round(p_preco, 4))
    returning id, linha into vid, vlinha;
  else
    update public.bomba_precos set preco = round(p_preco, 4), sincronizado_em = now() where id = vid;
  end if;
  perform public.gestao_bomba_garantir_fornecedor(f, p, u, true);
  return vlinha;
end $$;

create or replace function public.gestao_aplicar_bomba(p_tipo text, p_dados jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d jsonb := coalesce(p_dados, '{}'::jsonb); dia date; vlinha integer; u text;
begin
  if p_tipo = 'negociacao' then
    dia := nullif(left(coalesce(d->>'data', ''), 10), '')::date;
    if dia is null or coalesce(d->>'fornecedor', '') = '' or coalesce(d->>'produto', '') = '' or coalesce(d->>'unidade', '') = '' then
      return jsonb_build_object('ok', false, 'erro', 'Não gravado: ' || case when (d->>'excluir')::boolean then 'exclusão' else 'negociação' end || ' incompleta');
    end if;
    if coalesce((d->>'excluir')::boolean, false) then
      update public.bomba_precos set preco = null, sincronizado_em = now()
       where id = (select id from public.bomba_precos
                    where data = dia and public.gestao_chave_txt(fornecedor) = public.gestao_chave_txt(d->>'fornecedor')
                      and public.gestao_chave_txt(produto) = public.gestao_chave_txt(d->>'produto')
                      and public.gestao_chave_txt(unidade) = public.gestao_chave_txt(d->>'unidade') order by linha desc limit 1)
      returning linha into vlinha;
      return jsonb_build_object('ok', true, 'linha', vlinha);
    end if;
    if not (coalesce(nullif(d->>'preco', '')::numeric, 0) > 0) then
      return jsonb_build_object('ok', false, 'erro', 'Não gravado: negociação incompleta');
    end if;
    vlinha := public.gestao_bomba_negociacao(dia, d->>'fornecedor', d->>'produto', d->>'unidade', (d->>'preco')::numeric);
    return jsonb_build_object('ok', true, 'linha', vlinha);
  elsif p_tipo = 'fornecedor' then
    if coalesce(d->>'fornecedor', '') = '' or coalesce(d->>'produto', '') = '' or jsonb_array_length(coalesce(d->'unidades', '[]'::jsonb)) = 0 then
      return jsonb_build_object('ok', false, 'erro', 'Não gravado: fornecedor incompleto');
    end if;
    for u in select jsonb_array_elements_text(d->'unidades') loop
      perform public.gestao_bomba_garantir_fornecedor(d->>'fornecedor', d->>'produto', u, coalesce((d->>'ativo')::boolean, true),
        d->'cnpjs'->>u, coalesce(d->'cnpjs' ? u, false));
    end loop;
    return jsonb_build_object('ok', true, 'linha', null);
  end if;
  return jsonb_build_object('ok', false, 'erro', 'Não gravado: tipo desconhecido');
exception when others then
  return jsonb_build_object('ok', false, 'erro', 'Não gravado: ' || sqlerrm);
end $$;

-- repetição do Arla até p_ate (hoje): devolve as linhas criadas
create or replace function public.gestao_bomba_repetir_arla(p_ate date default (now() at time zone 'America/Bahia')::date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; ult record; dia date; novas jsonb := '[]'::jsonb;
begin
  for r in select distinct public.gestao_chave_txt(fornecedor) as f, public.gestao_chave_txt(unidade) as u from public.bomba_fornecedores
           where public.gestao_chave_txt(produto) = 'ARLA' and public.gestao_chave_txt(ativo) not in ('NAO', 'N') loop
    select data, preco into ult from public.bomba_precos
     where public.gestao_chave_txt(fornecedor) = r.f and public.gestao_chave_txt(produto) = 'ARLA' and public.gestao_chave_txt(unidade) = r.u
       and preco > 0 and data is not null
     order by data desc, linha desc limit 1;
    if ult.data is null or ult.data >= p_ate then continue; end if;
    dia := greatest(ult.data + 1, p_ate - 30);
    while dia <= p_ate loop
      if not exists (select 1 from public.bomba_precos where data = dia and public.gestao_chave_txt(fornecedor) = r.f
                     and public.gestao_chave_txt(produto) = 'ARLA' and public.gestao_chave_txt(unidade) = r.u) then
        novas := novas || jsonb_build_object('data', dia, 'fornecedor', r.f, 'unidade', r.u, 'preco', ult.preco,
          'linha', public.gestao_bomba_negociacao(dia, r.f, 'ARLA', r.u, ult.preco::numeric));
      end if;
      dia := dia + 1;
    end loop;
  end loop;
  return novas;
end $$;

revoke all on function public.gestao_bomba_garantir_fornecedor(text, text, text, boolean, text, boolean) from public, anon, authenticated;
revoke all on function public.gestao_bomba_negociacao(date, text, text, text, numeric) from public, anon, authenticated;
revoke all on function public.gestao_aplicar_bomba(text, jsonb) from public, anon, authenticated;
revoke all on function public.gestao_bomba_repetir_arla(date) from public, anon, authenticated;
grant execute on function public.gestao_aplicar_bomba(text, jsonb) to service_role;
grant execute on function public.gestao_bomba_repetir_arla(date) to service_role;
notify pgrst, 'reload schema';
