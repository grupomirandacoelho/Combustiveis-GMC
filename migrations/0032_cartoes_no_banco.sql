-- Migração 15.3, item 2 (25/11/2026; pedido do usuário "Pode começar os cartões frota"): os pedidos do controle dos cartões frota
-- passam a ser aplicados também direto no banco (Supabase, public.cartoes_placas; lib/aplicar-cadastros.js). O "estado" continua
-- sendo o da planilha (o vigia segue gravando como cópia). Os pedidos de antes ficam 'anterior' (já chegam pela recópia da planilha).
ALTER TABLE alteracoes_cartoes ADD COLUMN banco_aplicado_em TEXT;
ALTER TABLE alteracoes_cartoes ADD COLUMN banco_mensagem TEXT;
UPDATE alteracoes_cartoes SET banco_aplicado_em = 'anterior';
CREATE INDEX IF NOT EXISTS idx_alt_cartoes_banco ON alteracoes_cartoes (banco_aplicado_em, id);
