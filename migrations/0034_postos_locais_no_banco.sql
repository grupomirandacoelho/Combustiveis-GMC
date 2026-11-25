-- Migração 15.3, itens 4 e 5 (25/11/2026; pedido do usuário "Pode seguir com as negociações e a localização dos postos"): os pedidos
-- dos postos dos motoristas (negociações, rodada de preços) e das coordenadas do mapa de calor passam a ser aplicados também direto
-- no banco (lib/aplicar-cadastros.js). O "estado" continua sendo o da planilha (o vigia segue gravando como cópia).
ALTER TABLE alteracoes_postos ADD COLUMN banco_aplicado_em TEXT;
ALTER TABLE alteracoes_postos ADD COLUMN banco_mensagem TEXT;
UPDATE alteracoes_postos SET banco_aplicado_em = 'anterior';
CREATE INDEX IF NOT EXISTS idx_alt_postos_banco ON alteracoes_postos (banco_aplicado_em, id);
ALTER TABLE alteracoes_locais ADD COLUMN banco_aplicado_em TEXT;
ALTER TABLE alteracoes_locais ADD COLUMN banco_mensagem TEXT;
UPDATE alteracoes_locais SET banco_aplicado_em = 'anterior';
CREATE INDEX IF NOT EXISTS idx_alt_locais_banco ON alteracoes_locais (banco_aplicado_em, id);
