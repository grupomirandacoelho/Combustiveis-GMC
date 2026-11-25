-- Migração 15.3, itens 4 e 5, passo 2 (25/11/2026; pedido do usuário "Pode seguir com as negociações e a localização dos postos"):
-- as filas do portal aplicadas direto no banco, com as regras do vigia na planilha:
--   gestao_aplicar_posto (fila alteracoes_postos; scripts/planilha_negociacao.py gravar): cada pedido é uma negociação nova no fim
--     da aba (data = hoje); contato vazio = "<USUÁRIO> (PORTAL)"; valor vazio = o da última negociação do posto com valor;
--     transação = a do pedido (rodada) ou o dia da última transação do posto na base; "Novo contato feito?" = Sim nas negociações
--     anteriores do posto; correção de cadastro (unidade_anterior/posto_anterior) leva as linhas antigas para a unidade e o nome
--     novos; coordenada informada vale para a lista dos motoristas (public.postos_coordenadas 'portal'). As colunas de fórmula da
--     planilha (N a P: dias, status, renegociação) não são guardadas: o portal calcula.
--   gestao_aplicar_local (fila alteracoes_locais; scripts/planilha_locais.py gravar): posto que já está na planilha de
--     localização troca só latitude e longitude; posto novo entra no fim (nome, cidade, UF, BRASIL). Coordenada guardada como a
--     planilha guarda (inteiro sem a vírgula: -19883025 = -19,883025; gestao_coordenada lê).
alter table public."alteracoes_postos" add column if not exists "banco_aplicado_em" text;
alter table public."alteracoes_postos" add column if not exists "banco_mensagem" text;
alter table public."alteracoes_locais" add column if not exists "banco_aplicado_em" text;
alter table public."alteracoes_locais" add column if not exists "banco_mensagem" text;

create or replace function public.gestao_aplicar_posto(p_dados jsonb, p_usuario text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d jsonb := coalesce(p_dados, '{}'::jsonb);
  k_uni text := public.gestao_chave_txt(d->>'unidade'); k_posto text := public.gestao_chave_txt(d->>'posto');
  ka_uni text := public.gestao_chave_txt(coalesce(nullif(d->>'unidade_anterior', ''), d->>'unidade'));
  ka_posto text := public.gestao_chave_txt(coalesce(nullif(d->>'posto_anterior', ''), d->>'posto'));
  valor double precision := nullif(d->>'valor', '')::double precision;
  trans timestamp; vlinha integer; movidas integer := 0;
begin
  if k_posto = '' or k_uni = '' then
    return jsonb_build_object('ok', false, 'erro', 'negociação incompleta');
  end if;
  -- correção de cadastro: as linhas do cadastro antigo passam a ter a unidade e o nome novos
  if (ka_uni, ka_posto) <> (k_uni, k_posto) then
    update public.negociacoes set unidade = d->>'unidade', posto_negociado = d->>'posto', sincronizado_em = now()
     where public.gestao_chave_txt(unidade) = ka_uni and public.gestao_chave_txt(posto_negociado) = ka_posto;
    get diagnostics movidas = row_count;
    if coalesce(d->>'posto_anterior', '') <> '' then   -- coordenada digitada para o nome antigo vale para o novo (se ele não tiver)
      insert into public.postos_coordenadas (chave, origem, lat, lon)
        select k_posto, 'portal', lat, lon from public.postos_coordenadas
         where chave = public.gestao_chave_txt(d->>'posto_anterior') and origem = 'portal'
        on conflict (chave, origem) do nothing;
    end if;
  end if;
  if valor is null then
    select valor_negociado into valor from public.negociacoes
     where public.gestao_chave_txt(unidade) = k_uni and public.gestao_chave_txt(posto_negociado) = k_posto and valor_negociado > 0
     order by linha desc limit 1;
  end if;
  trans := nullif(d->>'transacao', '')::timestamp;
  if trans is null then   -- o dia da última transação do posto na base (como o vigia, pelo arquivo dos painéis)
    select max(data_transacao)::date::timestamp into trans from public.base_transacoes
     where public.gestao_chave_txt(nome_estabelecimento) = k_posto;
  end if;
  update public.negociacoes set novo_contato_feito = 'Sim', sincronizado_em = now()
   where public.gestao_chave_txt(unidade) = k_uni and public.gestao_chave_txt(posto_negociado) = k_posto
     and upper(coalesce(btrim(novo_contato_feito), '')) <> 'SIM';
  insert into public.negociacoes (linha, data_da_negociacao, contato_da_negociacao, unidade, posto_negociado, cidade, tipo, plataforma,
    valor_negociado, tipo_combustivel, novo_contato_feito, data_da_ultima_transacao_usada_para_o_preco, observacao, aviso,
    variacao_pct_vs_abastecimento_anterior)
  values ((select coalesce(max(linha), 1) + 1 from public.negociacoes), (now() at time zone 'America/Bahia')::date,
    coalesce(nullif(d->>'contato', ''), upper(public.gestao_txt(p_usuario)) || ' (PORTAL)'),
    d->>'unidade', d->>'posto', d->>'cidade', nullif(d->>'tipo', ''), d->>'plataforma', valor,
    coalesce(nullif(d->>'combustivel', ''), 'DIESEL S-10 COMUM'), null, trans, d->>'status', nullif(d->>'aviso', ''),
    nullif(d->>'variacao', '')::double precision)
  returning linha into vlinha;
  if nullif(d->>'latitude', '') is not null and nullif(d->>'longitude', '') is not null then
    insert into public.postos_coordenadas (chave, origem, lat, lon)
    values (k_posto, 'portal', (d->>'latitude')::float8::text, (d->>'longitude')::float8::text)
    on conflict (chave, origem) do update set lat = excluded.lat, lon = excluded.lon, atualizado_em = now();
  end if;
  return jsonb_build_object('ok', true, 'linha', vlinha, 'movidas', movidas);
exception when others then
  return jsonb_build_object('ok', false, 'erro', 'Não gravado: ' || sqlerrm);
end $$;

create or replace function public.gestao_aplicar_local(p_nome text, p_cidade text, p_uf text, p_lat double precision, p_lon double precision)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  nome text := public.gestao_chave_txt(p_nome); vid bigint; vlinha integer;
  h double precision := round((p_lat * 1e6)::numeric); i double precision := round((p_lon * 1e6)::numeric);
begin
  if nome = '' or p_lat is null or p_lon is null then
    return jsonb_build_object('ok', false, 'erro', 'Coordenada ou nome do posto inválido.');
  end if;
  select id, linha into vid, vlinha from public.postos_localizacao where public.gestao_chave_txt(nome_estabelecimento) = nome order by linha limit 1;
  if vid is null then
    insert into public.postos_localizacao (linha, nome_estabelecimento, cidade, uf, pais, latitude, longitude)
    values ((select coalesce(max(linha), 1) + 1 from public.postos_localizacao), nome, nullif(public.gestao_chave_txt(p_cidade), ''),
            nullif(public.gestao_chave_txt(p_uf), ''), 'BRASIL', h, i)
    returning linha into vlinha;
  else
    update public.postos_localizacao set latitude = h, longitude = i, sincronizado_em = now() where id = vid;
  end if;
  return jsonb_build_object('ok', true, 'linha', vlinha);
exception when others then
  return jsonb_build_object('ok', false, 'erro', 'Não gravado: ' || sqlerrm);
end $$;

revoke all on function public.gestao_aplicar_posto(jsonb, text) from public, anon, authenticated;
revoke all on function public.gestao_aplicar_local(text, text, text, double precision, double precision) from public, anon, authenticated;
grant execute on function public.gestao_aplicar_posto(jsonb, text) to service_role;
grant execute on function public.gestao_aplicar_local(text, text, text, double precision, double precision) to service_role;
notify pgrst, 'reload schema';
