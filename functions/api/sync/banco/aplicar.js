import { tokenSyncValido, json } from '../../../../lib/auth.js';
import { aplicarPendentes } from '../../../../lib/aplicar-banco.js';
import { aplicarCadastrosPendentes, aplicarCartoesPendentes } from '../../../../lib/aplicar-cadastros.js';

// Migração 100% nuvem, 15.2 passo 3: varredura das filas — aplica no banco o que ficou pendente (banco fora do ar na hora da gravação,
// pedidos gravados por rotas antigas). Chamada de tempos em tempos (vigia e, depois, agendador na nuvem), com o token de sincronização.
// POST -> {aplicados, erros, parou}; até 4 rodadas de 50 pedidos por chamada.
export async function onRequestPost({ request, env }) {
  if (!tokenSyncValido(request, env)) return json({ erro: 'Não autorizado.' }, 401);
  const total = { aplicados: 0, erros: 0, parou: false };
  for (let i = 0; i < 4; i++) {
    const r = await aplicarPendentes(env);
    if (r.semBanco) return json({ erro: 'Banco não configurado.' }, 503);
    total.aplicados += r.aplicados; total.erros += r.erros; total.parou = r.parou;
    if (r.parou || (r.aplicados + r.erros) === 0) break;
  }
  // placas e motoristas (15.3, 25/11/2026): fila própria, depois dos abastecimentos
  const c = await aplicarCadastrosPendentes(env);
  const k = await aplicarCartoesPendentes(env);   // cartões frota (15.3 item 2)
  return json({ ok: true, ...total, cadastros: { aplicados: c.aplicados, erros: c.erros }, cartoes: { aplicados: k.aplicados, erros: k.erros } });
}
