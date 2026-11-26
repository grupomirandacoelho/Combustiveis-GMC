// Publicar nos dashboards (26/11/2026; pedido do usuário: as transações das APIs entram com km errado e distorcem os painéis; o
// Editar abastecimentos é onde ele valida. Decisão: "Só ao publicar"): os dashboards ficam na última publicação; publicar leva todos
// os abastecimentos até ontem (D-1). Quem gera o arquivo é o agendamento do banco (gestao_dados_painel_rodar, a cada 2 min), que
// atende o pedido (migração 20261126110000_painel_publicacao.sql).
// GET  -> {ate, pedidoEm, pedidoPor, publicadoEm, publicadoPor, pendente, versao, podePublicar}  (permissão "abastecimentos")
// POST -> pede a publicação (permissão "abastecimentos-editar"). Antes aplica no banco as correções que ainda estão na fila;
//         se alguma ainda não entrou, não publica (409) para não sair sem ela.
import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode } from '../../../lib/permissoes.js';
import { rpc, temBanco } from '../../../lib/supabase.js';
import { aplicarPendentes } from '../../../lib/aplicar-banco.js';

export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  if (!pode(u, 'abastecimentos')) return json({ erro: 'Seu acesso não inclui o Editar abastecimentos.' }, 403);
  if (!temBanco(env)) return json({ erro: 'O banco de dados não está configurado no portal.' }, 503);
  const info = await rpc(env, 'gestao_painel_publicacao_info', {}, { ms: 8000 }).catch(() => null);
  if (!info) return json({ erro: 'O banco de dados não respondeu. Tente de novo em instantes.' }, 502);
  return json({ ...info, podePublicar: pode(u, 'abastecimentos-editar') });
}

export async function onRequestPost({ request, env }) {
  const origem = request.headers.get('Origin');
  if (origem && origem !== new URL(request.url).origin) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  if (!pode(u, 'abastecimentos-editar')) return json({ erro: 'Seu acesso não permite publicar nos dashboards.' }, 403);
  if (!temBanco(env)) return json({ erro: 'O banco de dados não está configurado no portal.' }, 503);
  await aplicarPendentes(env).catch(() => null);
  const fila = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM alteracoes_base_copia WHERE banco_aplicado_em IS NULL AND estado <> 'erro')
    + (SELECT COUNT(*) FROM consolidador_lotes WHERE banco_aplicado_em IS NULL AND estado <> 'erro') AS n`).first();
  if (fila && fila.n > 0) {
    return json({ erro: fila.n + (fila.n === 1 ? ' correção ainda está' : ' correções ainda estão') +
      ' sendo gravada(s) no banco. Tente publicar de novo em 1 minuto, para elas entrarem na publicação.' }, 409);
  }
  const info = await rpc(env, 'gestao_painel_publicar', { p_usuario: u.nome || u.usuario }, { ms: 8000 }).catch(() => null);
  if (!info) return json({ erro: 'O banco de dados não respondeu. Tente de novo em instantes.' }, 502);
  return json({ ok: true, ...info });
}
