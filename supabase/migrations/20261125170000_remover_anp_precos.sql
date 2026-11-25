-- 25/11/2026 (pedido do usuário: "se não perder pode apagar"; espaço do plano gratuito, 334 de 500 MB): as tabelas da ANP saem do
-- banco. Nada as lia: o Preço x ANP e o Contratos x ANP usam o anp.json baixado do gov.br (scripts/anp_precos.py, KV "anp");
-- elas eram só o espelho da aba ANP da Base.xlsx (supabase_sync.py) e a cópia no modelo (gestao_carga.py), já tirados.
-- Volta, se um dia precisar: recriar pelas migrações 20261112190000/20261116120000 e recarregar da aba ANP da Base.xlsx.
drop table if exists public.anp_precos;
drop table if exists gestao.anp_precos;
delete from public.sincronizacao_planilhas where tabela = 'anp_precos';
