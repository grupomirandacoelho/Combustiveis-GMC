// Busca de coordenadas dos postos no OpenStreetMap na nuvem (15.3, 25/11/2026; pedido do usuário "Pode seguir"): as mesmas regras do
// vigia (lib/nuvem/geo.js, copiada para _shared). Postos candidatos do banco (gestao_geo_candidatos, guardada pelo pg_cron), estado em public.nuvem_cache
// ('geo:estado'). Ligada, grava a coordenada segura na localização dos postos (gestao_aplicar_local); em 'simular' só anota o que
// gravaria (sem gravar nem o estado).
import { rotina, rpc, cacheNuvem } from '../_shared/nuvem.ts';
import { processar, USER_AGENT } from '../_shared/geo.js';

rotina('geo-postos', async ({ modo }) => {
  const ligado = modo === 'ligado';
  const cache = await cacheNuvem('geo:');
  const r = await processar({
    ligado,
    hoje: new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10),   // dia em Brasília
    // lista guardada pelo pg_cron 'geo-candidatos' a cada 3 h (a consulta é pesada demais para a API)
    candidatos: async () => (await cache.ler('candidatos', [])) as unknown[],
    ler: cache.ler, gravar: cache.gravar,
    esperar: (ms: number) => new Promise((ok) => setTimeout(ok, ms)),
    buscarJson: async (url: string) => {
      const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR' }, signal: AbortSignal.timeout(30000) });
      if (!resp.ok) throw Object.assign(new Error('HTTP ' + resp.status), { status: resp.status });
      return await resp.json();
    },
    gravarLocal: async (l: { nome: string; cidade: string; uf: string; lat: number; lon: number }) => {
      const g = await rpc('gestao_aplicar_local', { p_nome: l.nome, p_cidade: l.cidade || null, p_uf: l.uf || null, p_lat: l.lat, p_lon: l.lon });
      return !!(g && g.ok);
    },
  });
  return { resultado: r };
});
