// Cadastro de motoristas e de placas nos cartões na nuvem (passo 4, 23/11/2026; pedido do usuário "sim, pode começar"): as mesmas
// regras do vigia (lib/nuvem/cadastros-cartoes.js, copiada para _shared). Motoristas do banco (gestao_motoristas_cartoes), estado e
// interruptores em public.nuvem_cache ('cadastros:'). ESTA ROTINA GRAVA NAS APIs DOS CARTÕES: em 'simular' só as consultas (GET)
// saem; criar, alterar, trocar senha e trocar centro de custo ficam só anotados, e o portal não é avisado (os dados pessoais seguem
// com o vigia). Ligar só com a aprovação do usuário.
import { rotina, rpc, portal, env, cacheNuvem } from '../_shared/nuvem.ts';
import { criarNovos, editarTruckpag, processarPlacas } from '../_shared/cadastros-cartoes.js';

rotina('cadastros-cartoes', async ({ modo }) => {
  const ligado = modo === 'ligado';
  const cache = await cacheNuvem('cadastros:');
  // deno-lint-ignore no-explicit-any
  const gravacoes: any[] = [], logs: string[] = [];
  // deno-lint-ignore no-explicit-any
  const api = async (metodo: string, rota: string, corpo?: any) => {
    if (metodo === 'GET') return portal(metodo, rota);
    gravacoes.push({ portal: rota, itens: (corpo.itens || []).length, limpar: (corpo.limpar || []).length });
    return ligado ? portal(metodo, rota, corpo) : {};
  };
  const fetchCartao = async (url: string, opcoes: RequestInit = {}) => {
    const metodo = (opcoes.method || 'GET').toUpperCase();
    if (metodo === 'GET' || ligado) {
      if (metodo !== 'GET') gravacoes.push({ cartao: metodo + ' ' + url.replace(/^https:\/\/[^/]+/, '').split('?')[0] });
      return fetch(url, opcoes);
    }
    // simulação: anota o que seria gravado (sem CPF, senha nem nascimento) e não envia
    // deno-lint-ignore no-explicit-any
    let corpo: any = {}; try { corpo = JSON.parse(String(opcoes.body || '{}')); } catch { /* sem corpo */ }
    gravacoes.push({ cartao: metodo + ' ' + url.replace(/^https:\/\/[^/]+/, '').split('?')[0], nome: corpo.nomeMotorista || corpo.nome || null,
      centro: corpo.centro_custo_id ?? null });
    return new Response(JSON.stringify({ sucesso: false, mensagem: 'simulado (não enviado)', message: 'simulado (não enviado)' }), { status: 418 });
  };
  const io = {
    api, log: (m: string) => logs.push(m), agora: () => Date.now(),
    chaves: (await cache.ler('chaves', {})) as Record<string, boolean>,
    ticket: { host: env('TICKET_HOST'), basic: env('TICKET_BASIC') }, truckpag: { hosts: [env('TRUCKPAG_HOST')], token: env('TRUCKPAG_TOKEN') },
    fetchCartao, motoristas: () => rpc('gestao_motoristas_cartoes', {}, 30000),
    ler: cache.ler, gravar: cache.gravar,
  };
  await criarNovos(io);
  await editarTruckpag(io);
  await processarPlacas(io);
  return { resultado: { gravacoes, logs: logs.slice(-20) } };
});
