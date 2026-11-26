-- Espelho da coluna nova do D1 (migrations/0037_aviso_personalizado.sql, 26/11/2026): unidades do login para o aviso separado por unidade.
alter table public.usuarios add column if not exists unidades text;
