-- 15.3 (25/11/2026; decisão do usuário: ANP e Petrobras pelo GitHub Actions, .github/workflows/precos-anp-petrobras.yml): interruptor
-- para o vigia. 'ligado' = o Actions publica e o vigia deixa de baixar (scripts/sincronizar.mjs nuvemLigada('precos-anp')).
-- Não é Edge Function (funcao = false: o pg_cron não dispara nada).
insert into public.nuvem_rotinas (nome, modo, intervalo_min, funcao) values ('precos-anp', 'simular', 180, false)
on conflict (nome) do nothing;
