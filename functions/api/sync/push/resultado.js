import { tokenSyncValido, json } from '../../../../lib/auth.js';

// Notificações no celular (26/11/2026): a nuvem avisa o que mandou. enviados = inscrições que receberam (anota a hora do último envio);
// expiradas = inscrições que o serviço de push recusou com 404/410 (o aparelho desativou ou apagou o app): saem da lista.
// POST {enviados: [ids], expiradas: [ids]}
const ids = (l) => (Array.isArray(l) ? [...new Set(l.map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 500) : []);
export async function onRequestPost({ request, env }) {
  if (!tokenSyncValido(request, env)) return json({ erro: 'Não autorizado.' }, 401);
  let d;
  try { d = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const enviados = ids(d.enviados), expiradas = ids(d.expiradas);
  const cmds = [
    ...enviados.map((id) => env.DB.prepare("UPDATE push_inscricoes SET ultimo_envio = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").bind(id)),
    ...expiradas.map((id) => env.DB.prepare('DELETE FROM push_inscricoes WHERE id = ?').bind(id)),
  ];
  if (cmds.length) await env.DB.batch(cmds);
  return json({ ok: true, enviados: enviados.length, expiradas: expiradas.length });
}
