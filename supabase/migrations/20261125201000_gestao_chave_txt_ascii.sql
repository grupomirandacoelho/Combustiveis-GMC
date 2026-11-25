-- 25/11/2026 (15.3): gestao_chave_txt igual ao chave() do vigia (unicodedata NFKD + só ASCII): além dos acentos, some todo caractere
-- que não é ASCII (ex.: o travessão "–" em "REALEZA – GRUPO NAZARAO"); º e ª viram o e a (como no NFKD). Achado pela comparação
-- diária (comparar_cadastros.py): 3 postos da planilha de localização ficavam com chaves diferentes.
create or replace function public.gestao_chave_txt(v text) returns text language sql immutable as $$
  select coalesce(upper(regexp_replace(btrim(regexp_replace(translate(coalesce(v, ''),
    'áàâãäéèêëíìîïóòôõöúùûüçñýÿÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝºª', 'aaaaaeeeeiiiiooooouuuucnyyAAAAAEEEEIIIIOOOOOUUUUCNYoa'),
    '[^\x01-\x7F]', '', 'g')), '\s+', ' ', 'g')), '')
$$;
