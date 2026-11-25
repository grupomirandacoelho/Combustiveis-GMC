-- 25/11/2026: a lista de postos candidatos da busca no OpenStreetMap passa da API (corta em 8 s; a consulta leva de 2 a 17 s conforme
-- a carga do banco) para um pg_cron (sem esse limite), a cada 3 horas, guardada em public.nuvem_cache 'geo:candidatos'. A Edge
-- Function geo-postos só lê a lista guardada.
select cron.unschedule('geo-candidatos') where exists (select 1 from cron.job where jobname = 'geo-candidatos');
select cron.schedule('geo-candidatos', '17 */3 * * *',
  $$select public.gestao_nuvem_cache_gravar('geo:candidatos', public.gestao_geo_candidatos()::jsonb)$$);
select public.gestao_nuvem_cache_gravar('geo:candidatos', public.gestao_geo_candidatos()::jsonb);
