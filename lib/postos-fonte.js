// Lista dos postos dos motoristas (/postos.csv: app dos motoristas, roteirizador; e a contagem na tela Postos dos motoristas):
// do KV "postos"/"postos-info" que o vigia publica da planilha de negociações, ou do banco (gestao_postos_csv / gestao_postos_info,
// mesmo formato). Migração 15.3 itens 4 e 5 (25/11/2026; pedido do usuário "Pode seguir com as negociações e a localização dos
// postos"). Liga sem publicar o site: KV "postos-fonte" = "banco" (apagar volta à planilha). Banco fora do ar: o KV, como antes.
import { rpc, rpcTexto } from './supabase.js';

const CACHE_MS = 30_000;   // o app dos motoristas pede a lista a cada abertura: o mesmo isolate reaproveita por 30 s
let cache = null;

// {csv, info: {atualizadoEm, postos}, fonte} ou null
export async function lerPostos(env, { agora = Date.now } = {}) {
  if ((await env.DADOS.get('postos-fonte').catch(() => null)) === 'banco') {
    if (cache && agora() - cache.em < CACHE_MS) return cache.lista;
    const [texto, info] = await Promise.all([rpcTexto(env, 'gestao_postos_csv', {}, { ms: 10000 }), rpc(env, 'gestao_postos_info', {}, { ms: 8000 })]);
    let csv = null;
    try { csv = texto ? JSON.parse(texto) : null; } catch { csv = null; }   // a API devolve o texto como string JSON
    const linhas = typeof csv === 'string' ? csv.split('\n').filter((l) => l.trim()) : [];
    if (linhas.length > 1 && linhas[0].startsWith('Unidade;Posto;')) {
      const lista = { csv, info: { atualizadoEm: info && info.atualizadoEm, postos: linhas.length - 1 }, fonte: 'banco' };
      cache = { em: agora(), lista };
      return lista;
    }
  }
  const [csv, info] = await Promise.all([env.DADOS.get('postos'), env.DADOS.get('postos-info', 'json').catch(() => null)]);
  return csv ? { csv, info, fonte: 'planilha' } : null;
}

export function limparCachePostos() { cache = null; }
