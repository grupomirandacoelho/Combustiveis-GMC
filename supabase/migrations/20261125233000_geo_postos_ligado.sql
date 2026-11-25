-- 25/11/2026: busca de coordenadas no OpenStreetMap na nuvem LIGADA (simulação igual ao vigia: 173 candidatos no banco x 172 no vigia,
-- a diferença é um posto novo dos últimos abastecimentos; nenhuma consulta pendente nos dois). Estado copiado do vigia (360 postos).
-- O vigia deixa de buscar (nuvemLigada('geo-postos')).
update public.nuvem_rotinas set modo = 'ligado' where nome = 'geo-postos';
