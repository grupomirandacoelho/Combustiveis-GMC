-- Migração 15.3, item 3 (25/11/2026; pedido do usuário "finalizando segue com a bomba interna"): os pedidos do Preço bomba interna
-- (negociações e fornecedores) passam a ser aplicados também direto no banco (Supabase, public.bomba_precos / bomba_fornecedores;
-- lib/aplicar-cadastros.js). O "estado" continua sendo o da planilha (o vigia segue gravando como cópia). Os de antes ficam 'anterior'.
ALTER TABLE alteracoes_bomba ADD COLUMN banco_aplicado_em TEXT;
ALTER TABLE alteracoes_bomba ADD COLUMN banco_mensagem TEXT;
UPDATE alteracoes_bomba SET banco_aplicado_em = 'anterior';
CREATE INDEX IF NOT EXISTS idx_alt_bomba_banco ON alteracoes_bomba (banco_aplicado_em, id);
