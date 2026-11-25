-- 25/11/2026 (pedido do usuário "Pode seguir", pendências da 15.4): o vigia consulta /api/sync/bomba-rateio/estado a cada 5 min e a
-- lista dos abastecimentos de bomba já corrigidos à mão ("travados") lia a fila alteracoes_base_copia inteira (2.513 linhas por vez,
-- ~0,7 milhão por dia no limite gratuito do D1). Índice parcial com a MESMA condição da consulta (o SQLite só usa índice parcial quando
-- o WHERE da consulta repete o dele) e com as colunas que ela devolve: a consulta passa a ler só as linhas travadas.
CREATE INDEX IF NOT EXISTS idx_alteracoes_rateio_travados ON alteracoes_base_copia (placa, data, tanque)
  WHERE estado IN ('pendente', 'aguardando', 'aplicada') AND (celulas LIKE '%"P"%' OR celulas LIKE '%"T"%')
    AND (usuario_nome = 'Rateio das NFs (nota fechada)' OR usuario_nome NOT LIKE 'Rateio das NFs%');
