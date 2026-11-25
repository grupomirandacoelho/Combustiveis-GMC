-- Migração 15.3, item 1, passo 2 (25/11/2026; plano em docs/MIGRACAO-15-3.md): os pedidos de placas e motoristas passam a ser
-- aplicados também direto no banco (Supabase, public.placas / public.motoristas; lib/aplicar-cadastros.js). O "estado" continua
-- sendo o da planilha (o vigia segue gravando como cópia); estas colunas dizem se (e quando) o pedido está no banco. Os pedidos de
-- antes ficam 'anterior' (o banco ainda é recopiado da planilha até a virada, então já chegam por ela).
ALTER TABLE alteracoes_cadastros ADD COLUMN banco_aplicado_em TEXT;
ALTER TABLE alteracoes_cadastros ADD COLUMN banco_mensagem TEXT;
UPDATE alteracoes_cadastros SET banco_aplicado_em = 'anterior';
CREATE INDEX IF NOT EXISTS idx_alt_cadastros_banco ON alteracoes_cadastros (banco_aplicado_em, id);
