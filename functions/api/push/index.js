import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { enviarPush, endpointValido } from '../../../lib/nuvem/webpush.js';

// Notificações no celular (26/11/2026; pedido do usuário: começar pela equipe de gestão). O aparelho se inscreve pelo navegador
// (public/gestao/lib/celular.js) e quem manda é a nuvem (Edge Function notificacoes-push), com as regras marcadas "celular".
// GET  -> {chave (VAPID pública; null = ainda não configurado), aparelhos: [{id, aparelho, criado_em, ultimo_envio, endpoint}]}
// POST {acao: 'inscrever', inscricao: {endpoint, keys: {p256dh, auth}}, aparelho}
//      {acao: 'cancelar', endpoint}  ·  {acao: 'testar', endpoint?} (manda um aviso de teste para este aparelho ou para todos do login)
// Segredos do portal: VAPID_PUBLICA e VAPID_PRIVADA (JWK). Os mesmos na nuvem (scripts/nuvem_publicar.mjs --segredos).
const MAX_APARELHOS = 10;
const b64ok = (s, min, max) => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s) && s.length >= min && s.length <= max;
export const vapidDo = (env, origem) => (env.VAPID_PUBLICA && env.VAPID_PRIVADA
  ? { publica: env.VAPID_PUBLICA, privada: env.VAPID_PRIVADA, assunto: env.VAPID_ASSUNTO || origem } : null);

// valida a inscrição que o navegador mandou -> {valor} | {erro}
export function validarInscricao(d) {
  const i = d && d.inscricao, k = i && i.keys;
  if (!i || !endpointValido(i.endpoint)) return { erro: 'Inscrição do aparelho inválida.' };
  if (!k || !b64ok(k.p256dh, 80, 100) || !b64ok(k.auth, 16, 30)) return { erro: 'Chaves do aparelho inválidas.' };
  const aparelho = String((d && d.aparelho) || '').replace(/[^\p{L}\p{N} ·().,-]/gu, '').trim().slice(0, 60) || null;
  return { valor: { endpoint: i.endpoint, p256dh: k.p256dh, auth: k.auth, aparelho } };
}

export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  const { results } = await env.DB.prepare('SELECT id, aparelho, criado_em, ultimo_envio, endpoint FROM push_inscricoes WHERE usuario_id = ? ORDER BY id')
    .bind(u.id).all();
  return json({ chave: env.VAPID_PUBLICA || null, aparelhos: results });
}

export async function onRequestPost({ request, env }) {
  const origem = new URL(request.url).origin;
  const o = request.headers.get('Origin');
  if (o && o !== origem) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  let d;
  try { d = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }

  if (d.acao === 'inscrever') {
    const v = validarInscricao(d);
    if (v.erro) return json({ erro: v.erro }, 400);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_inscricoes WHERE usuario_id = ? AND endpoint <> ?').bind(u.id, v.valor.endpoint).first();
    if (n && n.n >= MAX_APARELHOS) return json({ erro: 'Limite de ' + MAX_APARELHOS + ' aparelhos. Desative um aparelho antigo antes.' }, 400);
    // o mesmo aparelho (endpoint) passa para o login que ativou por último
    await env.DB.prepare(`INSERT INTO push_inscricoes (usuario_id, endpoint, p256dh, auth, aparelho) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET usuario_id = excluded.usuario_id, p256dh = excluded.p256dh, auth = excluded.auth, aparelho = excluded.aparelho`)
      .bind(u.id, v.valor.endpoint, v.valor.p256dh, v.valor.auth, v.valor.aparelho).run();
    return json({ ok: true });
  }
  if (d.acao === 'cancelar') {
    if (typeof d.endpoint !== 'string') return json({ erro: 'Aparelho inválido.' }, 400);
    await env.DB.prepare('DELETE FROM push_inscricoes WHERE usuario_id = ? AND endpoint = ?').bind(u.id, d.endpoint).run();
    return json({ ok: true });
  }
  if (d.acao === 'testar') {
    const vapid = vapidDo(env, origem);
    if (!vapid) return json({ erro: 'As notificações no celular ainda não foram configuradas no servidor.' }, 503);
    const { results } = typeof d.endpoint === 'string'
      ? await env.DB.prepare('SELECT id, endpoint, p256dh, auth FROM push_inscricoes WHERE usuario_id = ? AND endpoint = ?').bind(u.id, d.endpoint).all()
      : await env.DB.prepare('SELECT id, endpoint, p256dh, auth FROM push_inscricoes WHERE usuario_id = ?').bind(u.id).all();
    if (!results.length) return json({ erro: 'Este aparelho não está com as notificações ativadas.' }, 404);
    const msg = { titulo: 'Teste de notificação', texto: 'Tudo certo: este aparelho recebe as notificações do portal.', url: '/gestao/#/', tag: 'teste', nivel: 'info' };
    let enviados = 0;
    for (const i of results) {
      const r = await enviarPush(i, msg, vapid, { ttl: 600 }).catch(() => ({ ok: false, expirada: false }));
      if (r.ok) { enviados++; await env.DB.prepare("UPDATE push_inscricoes SET ultimo_envio = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").bind(i.id).run(); }
      else if (r.expirada) await env.DB.prepare('DELETE FROM push_inscricoes WHERE id = ?').bind(i.id).run();
    }
    return enviados ? json({ ok: true, enviados }) : json({ erro: 'O serviço de notificações do aparelho não aceitou o envio. Desative e ative de novo neste aparelho.' }, 502);
  }
  return json({ erro: 'Ação desconhecida.' }, 400);
}
