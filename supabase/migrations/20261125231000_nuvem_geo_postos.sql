-- 15.3 (25/11/2026; pedido do usuário "Pode seguir"): busca de coordenadas no OpenStreetMap como rotina da nuvem (Edge Function
-- geo-postos, de hora em hora). Começa em 'simular' (só anota o que gravaria); ligada, o vigia pula a dele (nuvemLigada('geo-postos')).
insert into public.nuvem_rotinas (nome, modo, intervalo_min, funcao) values ('geo-postos', 'simular', 60, true)
on conflict (nome) do nothing;
