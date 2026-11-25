import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { fonteBanco, versaoDoBanco } from '../../../lib/dados-painel.js';

// versão do arquivo dos painéis = o ETag que o navegador recebeu, sem aspas (public/gestao/lib/dados.js lê o ETag)
export const versaoDoEtag = (etag) => String(etag || '').replace(/^W\//, '').replace(/"/g, '');

// Versão dos dados dos dashboards: o site consulta de tempos em tempos para saber se há carga nova.
export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  const [info, status, plantao, tempoReal] = await Promise.all([env.DADOS.get('versao', 'json'), env.DADOS.get('status', 'json'),
    // qual computador está sincronizando agora (revezamento principal/reserva); sem a tabela ainda, fica nulo
    env.DB.prepare('SELECT p.maquina, p.desde, p.renovado, v.prioridade FROM plantao p LEFT JOIN vigias v ON v.maquina = p.maquina WHERE p.id = 1').first().catch(() => null),
    env.DADOS.get('tempo-real-versao', 'json')]);   // transações das APIs dos cartões ainda fora da Base
  // status: andamento do sincronizador (processando / ok / erro), para o botão Atualizar explicar o que está acontecendo
  // a versão do site junta a da Base e a das transações em tempo real (lib/dados.js monta a mesma combinação)
  const mais = tempoReal && tempoReal.versao ? '+' + tempoReal.versao : '';
  const resto = { tempoReal: tempoReal || null, plantao: plantao && plantao.maquina ? plantao : null };
  // painéis lendo do banco (desde 19/11/2026): a versão é a do banco, não a da última carga do vigia. Antes desta correção (25/11) as
  // duas nunca batiam e o botão "Atualizar: dados novos" ficava aceso o tempo todo. O andamento do vigia (status) não vale aqui.
  if (await fonteBanco(env).catch(() => false)) {
    const b = await versaoDoBanco(env).catch(() => null);
    if (b) {
      return json({ versao: versaoDoEtag(b.etag) + mais, geradoEm: b.v.geradoEm || null, linhas: b.v.linhas ?? null, origem: 'banco',
        status: null, ...resto });
    }
  }
  const versao = info && info.versao ? info.versao + mais : null;
  return json({ ...(info || {}), versao, status: status || null, ...resto });
}
