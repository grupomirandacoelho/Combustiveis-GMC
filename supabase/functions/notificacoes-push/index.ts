// Notificações no celular (26/11/2026; pedido do usuário: começar pela equipe de gestão e escolher em cada notificação se vai para o
// celular). A cada 10 min: pega no portal as regras marcadas "celular", quem recebe e os aparelhos (/api/sync/push/contexto), carrega
// só os dados que essas regras usam, avalia com o mesmo motor do sino (lib/nuvem/push.js -> notificacao.js) e manda por Web Push
// (lib/nuvem/webpush.js). O que já foi mandado fica em public.nuvem_cache ('push:enviados'), para não repetir antes da hora.
// Em 'simular' só anota o que mandaria. Segredos: VAPID_PUBLICA, VAPID_PRIVADA (scripts/nuvem_publicar.mjs --segredos).
import { rotina, portal, env, cacheNuvem } from '../_shared/nuvem.ts';
import { planejar, precisa } from '../_shared/push.js';
import { enviarPush } from '../_shared/webpush.js';
import { decodificar } from '../_shared/dados.js';
import { calcularEstoques } from '../_shared/notificacao.js';

const MAX_ENVIOS = 300;   // por rodada (segurança contra uma regra que dispare para muita gente de uma vez)

rotina('notificacoes-push', async ({ modo }) => {
  const ligado = modo === 'ligado';
  const c = await portal('GET', '/api/sync/push/contexto');
  if (!c.regras.length || !c.inscricoes.length) {
    return { resultado: { regras: c.regras.length, aparelhos: c.inscricoes.length, enviados: 0 } };
  }
  const usadas = c.regras.filter((r: { id: number }) => c.usuarios.some((u: { recebe: number[] }) => u.recebe.includes(r.id)));
  const p = precisa(usadas);
  const arquivo = (nome: string) => portal('GET', '/api/sync/push/arquivo?nome=' + nome);
  let dados = null, estoques = null;
  if (p.dados) {
    const [bruto, tr] = await Promise.all([arquivo('abastecimentos'), arquivo('tempo-real').catch(() => null)]);
    dados = decodificar(bruto, tr, { tempoReal: true });   // avisos são de operação: com as transações de hoje (estoque, preço)
  }
  if (p.estoque && c.bomba && dados) {
    const copia = await arquivo('base-copia').catch(() => null);
    estoques = calcularEstoques({ dados, bases: c.bomba.bases, movimentacoes: c.bomba.movimentacoes, manuais: c.bomba.manuais, copia });
  }
  const cache = await cacheNuvem('push:');
  const estado = (await cache.ler('enviados', {})) as Record<string, number>;
  const plano = planejar({ regras: c.regras, usuarios: c.usuarios, inscricoes: c.inscricoes, comum: c.comum, estoques, dados, estado });
  const resumo = plano.envios.map((e: { usuario_id: number; chave: string; mensagem: { titulo: string } }) => ({ usuario: e.usuario_id, chave: e.chave, titulo: e.mensagem.titulo }));
  if (!ligado) return { resultado: { regras: usadas.length, aparelhos: c.inscricoes.length, ocorrencias: plano.ocorrencias, mandaria: resumo.slice(0, 50) } };

  const vapid = { publica: env('VAPID_PUBLICA'), privada: env('VAPID_PRIVADA'), assunto: env('SITE_URL').replace(/\/+$/, '') };
  if (!vapid.publica || !vapid.privada) throw new Error('faltam os segredos VAPID_PUBLICA/VAPID_PRIVADA');
  const enviados: number[] = [], expiradas: number[] = [], falhas: string[] = [];
  for (const e of plano.envios.slice(0, MAX_ENVIOS)) {
    if (expiradas.includes(e.inscricao.id)) continue;
    try {
      const r = await enviarPush(e.inscricao, e.mensagem, vapid, { urgencia: e.urgencia, ttl: 12 * 3600 });
      if (r.ok) enviados.push(e.inscricao.id);
      else if (r.expirada) expiradas.push(e.inscricao.id);
      else falhas.push('HTTP ' + r.status);
    } catch (err) { falhas.push(String((err as Error)?.message || err).slice(0, 80)); }
  }
  await cache.gravar('enviados', plano.estado);
  if (enviados.length || expiradas.length) await portal('POST', '/api/sync/push/resultado', { enviados, expiradas });
  return { resultado: { regras: usadas.length, aparelhos: c.inscricoes.length, ocorrencias: plano.ocorrencias, enviados: enviados.length,
    expiradas: expiradas.length, falhas: falhas.slice(0, 5), avisos: resumo.slice(0, 20) } };
});
