-- 25/11/2026: ANP e Petrobras pelo GitHub Actions LIGADOS (simulação igual ao vigia: anp.json versão c5a34d45ca78 idêntico parte a
-- parte; petrobras.json idêntico; publicação testada). O vigia deixa de baixar os dois (nuvemLigada('precos-anp')).
update public.nuvem_rotinas set modo = 'ligado' where nome = 'precos-anp';
