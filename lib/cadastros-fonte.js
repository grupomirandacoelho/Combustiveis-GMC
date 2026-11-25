// Lista de placas e motoristas (com as senhas dos cartões) para o portal: da planilha, publicada pelo vigia na chave "cadastros"
// do KV, ou do banco (public.gestao_cadastros_lista, mesmo formato). Migração 15.3, item 1 (25/11/2026; pedido do usuário "Segue
// com a migração das planilhas"). Liga sem publicar o site: KV "cadastros-fonte" = "banco" (apagar a chave volta à planilha).
// Banco fora do ar ou lista vazia: usa a do KV, como antes.
import { rpc } from './supabase.js';

const CACHE_MS = 20_000;   // login e telas chamam muito: o mesmo isolate reaproveita a lista por 20 s
let cache = null;

export async function lerCadastros(env, { rpcFn = rpc, agora = Date.now } = {}) {
  const fonte = await env.DADOS.get('cadastros-fonte').catch(() => null);
  if (fonte === 'banco') {
    if (cache && agora() - cache.em < CACHE_MS) return cache.lista;
    const b = await rpcFn(env, 'gestao_cadastros_lista', {}, { ms: 8000 });
    if (b && Array.isArray(b.placas) && b.placas.length && Array.isArray(b.motoristas) && b.motoristas.length) {
      const lista = { ...b, fonte: 'banco' };
      cache = { em: agora(), lista };
      return lista;
    }
  }
  const c = await env.DADOS.get('cadastros', 'json').catch(() => null);
  return c ? { ...c, fonte: 'planilha' } : null;
}

// para os testes (e depois de gravar uma alteração no banco)
export function limparCacheCadastros() { cache = null; }
