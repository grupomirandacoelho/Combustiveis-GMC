-- Migração 15.3, item 2, passo 2 (25/11/2026; pedido do usuário "Pode começar os cartões frota"): os pedidos da fila
-- alteracoes_cartoes aplicados direto em public.cartoes_placas, com as regras do scripts/planilha_cartoes.py gravar: a placa é a
-- chave (normalizada); editar acha a linha da placa e pode trocar o nome dela (placa antiga -> Mercosul) se a nova não existir;
-- adicionar uma placa que já está é erro; linha nova no fim; só os cartões enviados mudam (vazio = sem valor).
alter table public."alteracoes_cartoes" add column if not exists "banco_aplicado_em" text;
alter table public."alteracoes_cartoes" add column if not exists "banco_mensagem" text;

create or replace function public.gestao_aplicar_cartao(p_acao text, p_chave text, p_dados jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  placa_ text := coalesce(public.gestao_norm_placa_txt(p_chave), public.gestao_norm_placa_txt(p_dados->>'placa'));
  nova text := public.gestao_norm_placa_txt(p_dados->>'placa');
  vid bigint; vlinha integer;
begin
  if p_acao not in ('editar', 'adicionar') or placa_ is null then
    return jsonb_build_object('ok', false, 'erro', 'pedido inválido');
  end if;
  if p_acao = 'editar' then
    select id, linha into vid, vlinha from public.cartoes_placas where public.gestao_norm_placa_txt(placa) = placa_ order by linha limit 1;
    if vid is null then
      return jsonb_build_object('ok', false, 'erro', 'A placa ' || placa_ || ' não está mais no controle dos cartões');
    end if;
    if nova is not null and nova <> placa_ then
      if exists (select 1 from public.cartoes_placas where public.gestao_norm_placa_txt(placa) = nova) then
        return jsonb_build_object('ok', false, 'erro', 'A placa ' || nova || ' já está em outra linha do controle dos cartões');
      end if;
      update public.cartoes_placas set placa = nova where id = vid;
    end if;
  else
    if exists (select 1 from public.cartoes_placas where public.gestao_norm_placa_txt(placa) = placa_) then
      return jsonb_build_object('ok', false, 'erro', 'A placa ' || placa_ || ' já está no controle dos cartões');
    end if;
    insert into public.cartoes_placas (linha, placa) values ((select coalesce(max(linha), 1) + 1 from public.cartoes_placas), placa_)
      returning id, linha into vid, vlinha;
  end if;
  update public.cartoes_placas set
    ticket   = case when p_dados ? 'ticket' then public.gestao_txt(p_dados->>'ticket') else ticket end,
    truckpag = case when p_dados ? 'truckpag' then public.gestao_txt(p_dados->>'truckpag') else truckpag end,
    veloe    = case when p_dados ? 'veloe' then public.gestao_txt(p_dados->>'veloe') else veloe end,
    sincronizado_em = now()
  where id = vid;
  return jsonb_build_object('ok', true, 'linha', vlinha);
exception when others then
  return jsonb_build_object('ok', false, 'erro', 'valor inválido: ' || sqlerrm);
end $$;
revoke all on function public.gestao_aplicar_cartao(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.gestao_aplicar_cartao(text, text, jsonb) to service_role;
notify pgrst, 'reload schema';
