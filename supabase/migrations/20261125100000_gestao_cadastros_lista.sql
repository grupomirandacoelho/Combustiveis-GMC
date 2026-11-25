-- Migração 15.3, item 1 (25/11/2026; pedido do usuário "Segue com a migração das planilhas", decisão "Não, tudo pelo portal"):
-- a lista de placas e motoristas no mesmo formato que o vigia publica na chave "cadastros" do KV
-- (scripts/planilha_cadastros.py gerar -> ler): o portal passa a ler daqui. Traz as senhas dos cartões: só service_role.
create or replace function public.gestao_txt(v text) returns text language sql immutable as $$
  select nullif(regexp_replace(btrim(v), '\s+', ' ', 'g'), '')
$$;
-- usuário do motorista: só os números, 6 dígitos com zero à esquerda (planilha_cadastros.usuario)
create or replace function public.gestao_usuario(v text) returns text language sql immutable as $$
  select case when d = '' then null when length(d) <= 6 then lpad(d, 6, '0') else d end
  from (select regexp_replace(coalesce(v, ''), '\D', '', 'g') d) x
$$;

create or replace function public.gestao_cadastros_lista() returns json language sql stable security definer
set search_path = public as $$
  select json_build_object(
    'placas', coalesce((select json_agg(json_build_object(
        'linha', linha, 'placa', public.gestao_txt(placa), 'categoria', public.gestao_txt(categoria), 'unidade', public.gestao_txt(unidade),
        'marca', public.gestao_txt(marca), 'modelo', public.gestao_txt(modelo), 'ano', ano, 'meta', meta,
        -- as fórmulas da planilha (H = meta - 0,5; J = tanque x meta x 0,75); valor digitado à mão fica
        'pontoCritico', case when meta > 0 then round((meta - 0.5)::numeric, 3) else round(ponto_critico::numeric, 3) end,
        'capTanque', cap_tanque,
        'autonomia', case when meta > 0 and cap_tanque > 0 then round((cap_tanque * meta * 0.75)::numeric, 3)
                          else round(auton_margem_de_seg::numeric, 3) end,
        'situacao', coalesce(upper(public.gestao_txt(situacao)), 'ATIVA')) order by linha) from public.placas), '[]'::json),
    'motoristas', coalesce((select json_agg(json_build_object(
        'linha', linha, 'nome', public.gestao_txt(motorista), 'unidade', public.gestao_txt(unidade), 'usuario', public.gestao_usuario(usuario),
        'senhaTicket', public.gestao_txt(senha_ticket), 'senhaTruckpag', public.gestao_txt(senha_truckpag),
        'senhaVeloe', public.gestao_txt(senha_veloe), 'situacao', public.gestao_txt(situacao), 'matricula', matricula,
        'codigoTicket', codigo_ticket, 'idTruckpag', id_truckpag) order by linha) from public.motoristas), '[]'::json),
    'atualizadoEm', to_char((select greatest(max(p.sincronizado_em), (select max(sincronizado_em) from public.motoristas)) from public.placas p)
                    at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
$$;
revoke all on function public.gestao_cadastros_lista() from public, anon, authenticated;
grant execute on function public.gestao_cadastros_lista() to service_role;
notify pgrst, 'reload schema';
