-- Passo 4 (23/11/2026; pedido do usuário "sim, pode começar" para o cadastro de motoristas e placas nos cartões na nuvem):
-- a lista dos motoristas do cadastro no mesmo formato do scripts/planilha_cadastros.py gerar (que o vigia lê da planilha), para a
-- Edge Function cadastros-cartoes. Conferido em 23/11: 166 = 166 motoristas e nenhum campo diferente. Traz as senhas dos cartões:
-- só a chave secreta (service_role) executa.
create or replace function public.gestao_motoristas_cartoes() returns json language sql stable security definer
set search_path = public as $$
  select coalesce(json_agg(json_strip_nulls(json_build_object(
    'nome', motorista, 'unidade', unidade, 'usuario', usuario, 'senhaTicket', senha_ticket, 'senhaTruckpag', senha_truckpag,
    'senhaVeloe', senha_veloe, 'situacao', situacao, 'matricula', matricula, 'codigoTicket', codigo_ticket, 'idTruckpag', id_truckpag))
    order by linha), '[]'::json)
  from public.motoristas
$$;
revoke all on function public.gestao_motoristas_cartoes() from public, anon, authenticated;
grant execute on function public.gestao_motoristas_cartoes() to service_role;
notify pgrst, 'reload schema';
