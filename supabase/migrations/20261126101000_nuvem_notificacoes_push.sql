-- Notificações no celular (26/11/2026; pedido do usuário "Monta como você me sugeriu"): Edge Function notificacoes-push a cada
-- 10 min. Já começa ligada: só manda as regras marcadas "Enviar também para o celular" (nenhuma no começo) para quem ativou no aparelho.
insert into public.nuvem_rotinas (nome, modo, intervalo_min, funcao) values ('notificacoes-push', 'ligado', 10, true)
on conflict (nome) do nothing;
