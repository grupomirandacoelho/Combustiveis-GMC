// Dados dos painéis vindos do banco (migração 100% nuvem, etapa 15.2 passo 1, 19/11/2026).
// O banco monta a parte dos abastecimentos (public.dados_painel, refeita pelo pg_cron: migração 20261119100000_gestao_dados_painel.sql)
// e o vigia manda à parte o que ainda vem das planilhas (KV "abastecimentos-extras": negociações, coordenadas, orçamento). Aqui as
// duas viram o mesmo /gestao/dados/abastecimentos.json de antes, guardado no KV por versão (o banco só é lido quando muda).
// Liga/desliga sem publicar o site: KV "abastecimentos-fonte" = "banco" (qualquer outro valor ou vazio = planilha, como antes).
import { rpc, rpcTexto, temBanco } from './supabase.js';

// junta dois objetos JSON em texto sem transformar (5 MB): {..a..} + {..b..} -> {..a.., ..b..}. Chaves de b não podem repetir as de a.
export function juntarJson(a, b) {
  const ta = String(a || '').trim(), tb = String(b || '').trim();
  if (!ta.startsWith('{') || !ta.endsWith('}') || !tb.startsWith('{') || !tb.endsWith('}')) throw new Error('JSON inválido para juntar');
  const corpoB = tb.slice(1, -1).trim();
  return corpoB ? ta.slice(0, -1) + ',' + corpoB + '}' : ta;
}

export async function fonteBanco(env) {
  if (!temBanco(env)) return false;
  return (await env.DADOS.get('abastecimentos-fonte')) === 'banco';
}

// Passo 2 (19/11/2026): lista do Editar abastecimentos e histórico do Consolidador, montados no banco (public.dados_gerados,
// migrações 20261119120000/121000). Cada um com a sua chave liga/desliga no KV: "<nome>-fonte" = "banco".
export const GERADOS = { 'base-copia.json': 'base-copia', 'consolidacao.json': 'consolidacao' };
export async function usaBanco(env, nome) {
  if (!temBanco(env)) return false;
  return (await env.DADOS.get(nome + '-fonte')) === 'banco';
}
// {etag, corpo} ou null (o portal usa o arquivo das planilhas). Guardado no KV "<nome>-nuvem" por versão.
export async function geradoDoBanco(env, nome) {
  const v = await rpc(env, 'gestao_dados_gerados_versao', { p_nome: nome }, { ms: 8000 });
  if (!v || !v.versao) return null;
  const etag = '"b' + v.versao + '"';
  const guardado = await env.DADOS.getWithMetadata(nome + '-nuvem', 'stream');
  if (guardado && guardado.value && guardado.metadata && guardado.metadata.etag === etag) return { etag, corpo: guardado.value };
  if (guardado && guardado.value && guardado.value.cancel) guardado.value.cancel();
  const corpo = await rpcTexto(env, 'gestao_dados_gerados', { p_nome: nome }, { ms: 25000 });
  if (!corpo) return null;
  await env.DADOS.put(nome + '-nuvem', corpo, { metadata: { etag } });
  return { etag, corpo };
}

// 15.3 (25/11/2026): partes do KV "abastecimentos-extras" (que o vigia monta das planilhas) que já vêm do banco. Cada uma liga pela
// sua chave do KV ("<fonte>" = "banco"); a versão dela entra no etag, para os painéis se refazerem quando ela muda.
export const EXTRAS_BANCO = [
  { fonte: 'bomba-fonte', funcao: 'gestao_bomba_extras', versao: 'gestao_bomba_versao', campos: ['negociacao', 'fornecedoresBomba'] },
  { fonte: 'postos-fonte', funcao: 'gestao_postos_extras', versao: 'gestao_postos_info', campos: ['negPostos', 'locais', 'locaisSuspeitos'] },
  { fonte: 'orcamento-fonte', funcao: 'gestao_orcamento_extras', versao: 'gestao_orcamento_info', campos: ['orcamento'] },
];
async function extrasLigados(env) {
  const flags = await Promise.all(EXTRAS_BANCO.map((x) => env.DADOS.get(x.fonte).catch(() => null)));
  const ligados = EXTRAS_BANCO.filter((_, i) => flags[i] === 'banco');
  // a versão vem como texto ou como {versao, ...}
  const versoes = (await Promise.all(ligados.map((x) => rpc(env, x.versao, {}, { ms: 8000 })))).map((v) => (v && typeof v === 'object' ? v.versao : v));
  // versão que não veio: essa parte fica com a planilha (o etag não depende dela)
  return ligados.map((x, i) => ({ ...x, v: versoes[i] })).filter((x) => typeof x.v === 'string' && x.v);
}
// extras (texto do KV) com as partes ligadas trocadas pelas do banco; null se alguma não vier (quem chamou não guarda nada)
export async function extrasComBanco(env, extras, ligados) {
  if (!ligados.length) return extras;
  const obj = JSON.parse(extras);
  for (const x of ligados) {
    const b = await rpcTexto(env, x.funcao, {}, { ms: 20000 });
    if (!b) return null;
    const d = JSON.parse(b);
    for (const c of x.campos) obj[c] = d[c] ?? null;
  }
  return JSON.stringify(obj);
}

// etag do arquivo montado do banco: versão dos abastecimentos + a de cada parte ligada. A versão do vigia (KV "versao") só entra
// enquanto alguma parte ainda vem das planilhas (com todas no banco, salvar a Base não muda nada nos painéis; 25/11/2026)
export function etagAbastecimentos(v, extrasInfo, ligados) {
  const vigia = ligados.length < EXTRAS_BANCO.length ? '-' + ((extrasInfo && extrasInfo.versao) || '0') : '';
  return '"b' + v.versao + vigia + ligados.map((x) => '-' + String(x.v).slice(0, 12)).join('') + '"';
}
// versão do arquivo dos painéis vindo do banco, sem baixar nada: {etag, v, ligados} ou null. Usada também pelo /api/dados/versao
// (aviso "Atualizar: dados novos"), que precisa da mesma versão que o navegador recebeu no ETag.
export async function versaoDoBanco(env) {
  const [v, extrasInfo, ligados] = await Promise.all([rpc(env, 'gestao_dados_painel_versao', {}, { ms: 8000 }), env.DADOS.get('versao', 'json'),
    extrasLigados(env)]);
  if (!v || !v.versao) return null;
  return { etag: etagAbastecimentos(v, extrasInfo, ligados), v, ligados };
}

// {etag, corpo (stream ou texto)} ou null (sem dados do banco: quem chamou usa o arquivo das planilhas)
export async function abastecimentosDoBanco(env) {
  const ver = await versaoDoBanco(env);
  if (!ver) return null;
  const { etag, ligados } = ver;
  const guardado = await env.DADOS.getWithMetadata('abastecimentos-nuvem', 'stream');
  if (guardado && guardado.value && guardado.metadata && guardado.metadata.etag === etag) return { etag, corpo: guardado.value };
  if (guardado && guardado.value && guardado.value.cancel) guardado.value.cancel();
  const [base, extrasKv] = await Promise.all([rpcTexto(env, 'gestao_dados_painel', {}, { ms: 25000 }), env.DADOS.get('abastecimentos-extras')]);
  if (!base || !extrasKv) return null;
  const extras = await extrasComBanco(env, extrasKv, ligados);
  if (!extras) return null;
  const corpo = juntarJson(base, extras);
  await env.DADOS.put('abastecimentos-nuvem', corpo, { metadata: { etag } });
  return { etag, corpo };
}
