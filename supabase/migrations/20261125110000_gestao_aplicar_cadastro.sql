-- Migração 15.3, item 1, passo 2 (25/11/2026; pedido do usuário "Segue com a migração das planilhas"): os pedidos da fila
-- alteracoes_cadastros (placas e motoristas) aplicados direto nas tabelas public.placas / public.motoristas, com as mesmas regras
-- do scripts/planilha_cadastros.py gravar: editar acha a linha pela chave (placa ou usuário, normalizada); trocar a chave para uma
-- que já existe é erro; adicionar uma chave que já existe é erro; linha nova no fim. Campos calculados (ponto crítico, autonomia)
-- não são gravados: a lista calcula pela meta e pelo tanque (gestao_cadastros_lista).
-- 1) espelho do D1: colunas novas da fila (migração D1 0031)
alter table public."alteracoes_cadastros" add column if not exists "banco_aplicado_em" text;
alter table public."alteracoes_cadastros" add column if not exists "banco_mensagem" text;

create or replace function public.gestao_chave_cadastro(p_tipo text, v text) returns text language sql immutable as $$
  select case when p_tipo = 'placas' then upper(regexp_replace(coalesce(v, ''), '[^A-Za-z0-9]', '', 'g'))
              else coalesce(public.gestao_usuario(v), '') end
$$;

create or replace function public.gestao_aplicar_cadastro(p_tipo text, p_acao text, p_chave text, p_dados jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  atual text := public.gestao_chave_cadastro(p_tipo, p_chave);
  campo_chave text := case p_tipo when 'placas' then 'placa' else 'usuario' end;
  nova text := case when p_dados ? campo_chave then public.gestao_chave_cadastro(p_tipo, p_dados->>campo_chave) end;
  vid bigint; vlinha integer;
begin
  if p_tipo not in ('placas', 'motoristas') or p_acao not in ('editar', 'adicionar') then
    return jsonb_build_object('ok', false, 'erro', 'pedido inválido');
  end if;
  if p_tipo = 'placas' then
    if p_acao = 'editar' then
      select id, linha into vid, vlinha from public.placas where public.gestao_chave_cadastro('placas', placa) = atual order by linha limit 1;
      if vid is null then return jsonb_build_object('ok', false, 'erro', p_chave || ' não está mais no cadastro'); end if;
      if nova is not null and nova <> atual and exists (select 1 from public.placas where public.gestao_chave_cadastro('placas', placa) = nova) then
        return jsonb_build_object('ok', false, 'erro', (p_dados->>'placa') || ' já existe em outra linha do cadastro');
      end if;
    else
      if nova is null or nova = '' or exists (select 1 from public.placas where public.gestao_chave_cadastro('placas', placa) = nova) then
        return jsonb_build_object('ok', false, 'erro', coalesce(p_dados->>'placa', 'placa vazia') || ' já existe no cadastro');
      end if;
      insert into public.placas (linha, placa) values ((select coalesce(max(linha), 1) + 1 from public.placas), public.gestao_txt(p_dados->>'placa'))
        returning id, linha into vid, vlinha;
    end if;
    update public.placas set
      placa      = case when p_dados ? 'placa' then public.gestao_txt(p_dados->>'placa') else placa end,
      categoria  = case when p_dados ? 'categoria' then public.gestao_txt(p_dados->>'categoria') else categoria end,
      unidade    = case when p_dados ? 'unidade' then public.gestao_txt(p_dados->>'unidade') else unidade end,
      marca      = case when p_dados ? 'marca' then public.gestao_txt(p_dados->>'marca') else marca end,
      modelo     = case when p_dados ? 'modelo' then public.gestao_txt(p_dados->>'modelo') else modelo end,
      ano        = case when p_dados ? 'ano' then nullif(p_dados->>'ano', '')::numeric::bigint else ano end,
      meta       = case when p_dados ? 'meta' then nullif(p_dados->>'meta', '')::double precision else meta end,
      cap_tanque = case when p_dados ? 'capTanque' then nullif(p_dados->>'capTanque', '')::double precision else cap_tanque end,
      situacao   = case when p_dados ? 'situacao' then public.gestao_txt(p_dados->>'situacao') else situacao end,
      sincronizado_em = now()
    where id = vid;
  else
    if p_acao = 'editar' then
      select id, linha into vid, vlinha from public.motoristas where public.gestao_chave_cadastro('motoristas', usuario) = atual order by linha limit 1;
      if vid is null then return jsonb_build_object('ok', false, 'erro', p_chave || ' não está mais no cadastro'); end if;
      if nova is not null and nova <> atual and exists (select 1 from public.motoristas where public.gestao_chave_cadastro('motoristas', usuario) = nova) then
        return jsonb_build_object('ok', false, 'erro', (p_dados->>'usuario') || ' já existe em outra linha do cadastro');
      end if;
    else
      if nova is null or nova = '' or exists (select 1 from public.motoristas where public.gestao_chave_cadastro('motoristas', usuario) = nova) then
        return jsonb_build_object('ok', false, 'erro', coalesce(p_dados->>'usuario', 'usuário vazio') || ' já existe no cadastro');
      end if;
      insert into public.motoristas (linha, usuario) values ((select coalesce(max(linha), 1) + 1 from public.motoristas), nova)
        returning id, linha into vid, vlinha;
    end if;
    update public.motoristas set
      motorista      = case when p_dados ? 'nome' then public.gestao_txt(p_dados->>'nome') else motorista end,
      unidade        = case when p_dados ? 'unidade' then public.gestao_txt(p_dados->>'unidade') else unidade end,
      usuario        = case when p_dados ? 'usuario' then public.gestao_usuario(p_dados->>'usuario') else usuario end,
      senha_ticket   = case when p_dados ? 'senhaTicket' then public.gestao_txt(p_dados->>'senhaTicket') else senha_ticket end,
      senha_truckpag = case when p_dados ? 'senhaTruckpag' then public.gestao_txt(p_dados->>'senhaTruckpag') else senha_truckpag end,
      senha_veloe    = case when p_dados ? 'senhaVeloe' then public.gestao_txt(p_dados->>'senhaVeloe') else senha_veloe end,
      situacao       = case when p_dados ? 'situacao' then public.gestao_txt(p_dados->>'situacao') else situacao end,
      matricula      = case when p_dados ? 'matricula' then nullif(p_dados->>'matricula', '')::numeric::bigint else matricula end,
      codigo_ticket  = case when p_dados ? 'codigoTicket' then nullif(p_dados->>'codigoTicket', '')::numeric::bigint else codigo_ticket end,
      id_truckpag    = case when p_dados ? 'idTruckpag' then nullif(p_dados->>'idTruckpag', '')::numeric::bigint else id_truckpag end,
      sincronizado_em = now()
    where id = vid;
  end if;
  return jsonb_build_object('ok', true, 'linha', vlinha);
exception when others then
  return jsonb_build_object('ok', false, 'erro', 'valor inválido: ' || sqlerrm);
end $$;
revoke all on function public.gestao_aplicar_cadastro(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.gestao_aplicar_cadastro(text, text, text, jsonb) to service_role;
notify pgrst, 'reload schema';
