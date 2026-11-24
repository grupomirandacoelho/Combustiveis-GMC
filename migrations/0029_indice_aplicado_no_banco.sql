-- 24/11/2026: índice para a varredura das filas (lib/aplicar-banco.js). Sem ele, cada varredura (pg_cron de 2 em 2 min desde 23/11)
-- lia alteracoes_base_copia inteira três vezes: 6,1 milhões de linhas lidas em 23/11, acima do limite diário do D1 (5 milhões),
-- e o portal respondeu 500 das 17:50 às 21:00 (volta à meia-noite UTC). Com (banco_aplicado_em, id) a busca dos pendentes
-- (IS NULL ... ORDER BY id) e das reservas ('aplicando:...', como faixa) leem só as linhas certas.
CREATE INDEX IF NOT EXISTS idx_alteracoes_base_copia_banco ON alteracoes_base_copia (banco_aplicado_em, id);
CREATE INDEX IF NOT EXISTS idx_consolidador_lotes_banco ON consolidador_lotes (banco_aplicado_em, id);
