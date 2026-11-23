// Conferência com os cartões na nuvem (passo 4, 23/11/2026; pedido do usuário "Sim"): as mesmas regras do vigia
// (lib/nuvem/conferencia.js, copiada para _shared). Leituras dos 45 dias em public.nuvem_cache ('conferencia:'), lista da
// Base_copia e histórico do banco, publicação pelo portal (/api/sync/kv), pedidos de inclusão pelas rotas de sempre.
// Modo 'simular': nada sai daqui (a publicação fica em 'conferencia:simulado:...' para comparar com o vigia).
import { rotina, gerado, portal, env, diaLocal, cacheNuvem, prazo } from '../_shared/nuvem.ts';
import { buscarTicket, buscarTruckpag } from '../_shared/cartoes.js';
import { processar } from '../_shared/conferencia.js';

rotina('conferencia-cartoes', async ({ modo }) => {
  const ligado = modo === 'ligado';
  const cache = await cacheNuvem('conferencia:');
  // deno-lint-ignore no-explicit-any
  const enviados: any[] = [], logs: string[] = [];
  // deno-lint-ignore no-explicit-any
  const api = async (metodo: string, rota: string, corpo?: any) => {
    if (metodo === 'GET') return portal(metodo, rota);
    enviados.push({ rota, itens: (corpo.itens || corpo.linhas || []).length });
    return ligado ? portal(metodo, rota, corpo) : { id: 'simulado', inseridos: 0 };
  };
  const cfgT = { host: env('TICKET_HOST'), basic: env('TICKET_BASIC'), clientes: JSON.parse(env('TICKET_CLIENTES') || '[]') };
  const cfgP = { hosts: [env('TRUCKPAG_HOST')], token: env('TRUCKPAG_TOKEN') };
  const r = await processar({
    api, log: (m: string) => logs.push(m), agora: () => Date.now(), diaLocal, temTempo: prazo(100),
    buscarTicket: (dia: string) => buscarTicket(cfgT, dia), buscarTruckpag: (dia: string) => buscarTruckpag(cfgP, dia),
    async truckpagAnalitico(desde: string, ate: string) {
      const res = await fetch(env('TRUCKPAG_HOST') + '/api/integracao-clientes/relatorios/analitico-transacao', { method: 'POST', signal: AbortSignal.timeout(120_000),
        headers: { Authorization: 'Bearer ' + env('TRUCKPAG_TOKEN'), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ data_inicial: desde, data_final: ate }) });
      const j = await res.json();
      if (!Array.isArray(j.data)) throw new Error('HTTP ' + res.status);
      return j.data;
    },
    lista: () => gerado('base-copia'), historico: () => gerado('consolidacao'),
    ler: cache.ler, gravar: cache.gravar,
    // deno-lint-ignore no-explicit-any
    async publicar(chave: string, valor: any) {
      if (ligado) await portal('POST', '/api/sync/kv', { chave, valor });
      else await cache.gravar('simulado:' + chave, valor);
    },
  }, { forcar: true });   // o intervalo (3 h) é do agendador
  return { resultado: { ...(r || {}), enviados, logs: logs.slice(-20) } };
});
