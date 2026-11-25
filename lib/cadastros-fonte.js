// Listas das planilhas de cadastro para o portal: da planilha (publicada pelo vigia numa chave do KV) ou do banco (uma função
// public.gestao_*_lista no mesmo formato). Migração 15.3 (25/11/2026; plano em docs/MIGRACAO-15-3.md). Cada lista liga sem publicar
// o site por uma chave do KV "<nome>-fonte" = "banco" (apagar a chave volta à planilha). Banco fora do ar ou lista vazia: usa a do KV.
//   placas e motoristas (com as senhas dos cartões): "cadastros-fonte", gestao_cadastros_lista, KV "cadastros"  (item 1)
//   cartões frota:                                    "cartoes-fonte",   gestao_cartoes_lista,   KV "cartoes"    (item 2)
import { rpc } from './supabase.js';

const CACHE_MS = 20_000;   // login e telas chamam muito: o mesmo isolate reaproveita a lista por 20 s
const cache = new Map();

export const FONTES = {
  cadastros: { funcao: 'gestao_cadastros_lista', ok: (b) => Array.isArray(b.placas) && b.placas.length > 0 && Array.isArray(b.motoristas) && b.motoristas.length > 0 },
  cartoes: { funcao: 'gestao_cartoes_lista', ok: (b) => Array.isArray(b.cartoes) && b.cartoes.length > 0 },
};

export async function lerFonte(env, nome, { rpcFn = rpc, agora = Date.now } = {}) {
  const f = FONTES[nome];
  const fonte = await env.DADOS.get(nome + '-fonte').catch(() => null);
  if (fonte === 'banco') {
    const c = cache.get(nome);
    if (c && agora() - c.em < CACHE_MS) return c.lista;
    const b = await rpcFn(env, f.funcao, {}, { ms: 8000 });
    if (b && f.ok(b)) {
      const lista = { ...b, fonte: 'banco' };
      cache.set(nome, { em: agora(), lista });
      return lista;
    }
  }
  const c = await env.DADOS.get(nome, 'json').catch(() => null);
  return c ? { ...c, fonte: 'planilha' } : null;
}

export const lerCadastros = (env, opcoes) => lerFonte(env, 'cadastros', opcoes);
export const lerCartoes = (env, opcoes) => lerFonte(env, 'cartoes', opcoes);

// para os testes (e depois de gravar uma alteração no banco)
export function limparCacheCadastros() { cache.clear(); }
