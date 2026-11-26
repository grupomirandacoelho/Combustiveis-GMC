import { tokenSyncValido, json } from '../../../../lib/auth.js';
import { fonteBanco, abastecimentosDoBanco, usaBanco, geradoDoBanco } from '../../../../lib/dados-painel.js';

// Notificações no celular (26/11/2026): os arquivos de dados que a nuvem usa para avaliar as regras, os mesmos que o navegador lê em
// /gestao/dados/<nome>.json (do banco quando a chave do KV está em "banco"; senão os do vigia). Só com o token de sincronização.
// GET ?nome=abastecimentos | base-copia | tempo-real -> o JSON como está (sem transformar; o de abastecimentos tem ~5 MB)
const TIPO = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
export async function onRequestGet({ request, env }) {
  if (!tokenSyncValido(request, env)) return json({ erro: 'Não autorizado.' }, 401);
  const nome = new URL(request.url).searchParams.get('nome');
  if (!['abastecimentos', 'base-copia', 'tempo-real'].includes(nome)) return json({ erro: 'Arquivo desconhecido.' }, 400);
  try {
    if (nome === 'abastecimentos' && await fonteBanco(env)) {
      const b = await abastecimentosDoBanco(env);
      if (b) return new Response(b.corpo, { headers: TIPO });
    }
    if (nome === 'base-copia' && await usaBanco(env, 'base-copia')) {
      const b = await geradoDoBanco(env, 'base-copia');
      if (b) return new Response(b.corpo, { headers: TIPO });
    }
  } catch (e) { console.error('push/arquivo ' + nome + ': ' + (e && e.message)); }
  const corpo = await env.DADOS.get(nome, 'stream');
  if (!corpo) return json({ erro: 'Sem dados.' }, 404);
  return new Response(corpo, { headers: TIPO });
}
