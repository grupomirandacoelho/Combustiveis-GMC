// Conciliação de NFs na nuvem (passo 4, 23/11/2026; pedido do usuário "Sim"): as mesmas regras do vigia (lib/nuvem/conciliacao.js,
// copiada para _shared). Títulos, lotes e notas em public.nuvem_cache ('conciliacao:'); publicação pelo portal (/api/sync/kv).
// Só leitura nas APIs. Modo 'simular': a saída fica em 'conciliacao:simulado:saida' para comparar com o vigia.
import { createHash } from 'node:crypto';
import { rotina, portal, env, diaLocal, cacheNuvem, prazo, msLocal } from '../_shared/nuvem.ts';
import { processar } from '../_shared/conciliacao.js';

rotina('conciliacao-nfs', async ({ modo }) => {
  const ligado = modo === 'ligado';
  const cache = await cacheNuvem('conciliacao:');
  const logs: string[] = [];
  const truckpag = { hosts: [env('TRUCKPAG_HOST')], token: env('TRUCKPAG_TOKEN'),
    titulosUsuario: env('TRUCKPAG_TITULOS_USUARIO') || undefined, titulosSenha: env('TRUCKPAG_TITULOS_SENHA') || undefined };
  const nomeSaida = ligado ? 'saida' : 'simulado:saida';   // na simulação, a saída anterior é a da própria simulação
  const r = await processar({
    log: (m: string) => logs.push(m), agora: () => Date.now(), diaLocal, msLocal, temTempo: prazo(80),
    ticket: { host: env('TICKET_HOST'), basic: env('TICKET_BASIC') }, truckpag,
    md5: async (t: string) => createHash('md5').update(t).digest('hex'), base64: (t: string) => btoa(t),
    ler: (nome: string, padrao: unknown) => cache.ler(nome === 'saida' ? nomeSaida : nome, padrao),
    gravar: (nome: string, valor: unknown) => cache.gravar(nome === 'saida' ? nomeSaida : nome, valor),
    // deno-lint-ignore no-explicit-any
    async publicar(chave: string, valor: any) { if (ligado) await portal('POST', '/api/sync/kv', { chave, valor }); },
  }, { forcar: true });   // o intervalo (6 h) é do agendador
  return { resultado: { ...(r || {}), logs: logs.slice(-20) } };
});
