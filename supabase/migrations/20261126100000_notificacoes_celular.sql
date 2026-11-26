-- Espelho da coluna nova do D1 (migrations/0036_notificacoes_celular.sql, 26/11/2026): notificação que também vai para o celular.
-- A tabela push_inscricoes (aparelhos) fica só no D1, como as sessões (scripts/supabase_d1.py FORA).
alter table public.notificacoes add column if not exists celular bigint;
alter table gestao.notificacoes add column if not exists celular boolean not null default false;
