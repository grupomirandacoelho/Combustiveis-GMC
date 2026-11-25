import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode } from '../../../lib/permissoes.js';
import { aplicarCadastrosDepois } from '../../../lib/aplicar-cadastros.js';

// Mapa de calor > Postos sem coordenadas: coordenadas cadastradas pelo site, gravadas pelo vigia na planilha
// LOCALIZAÇÃO DOS POSTOS (scripts/planilha_locais.py).
// GET  /api/locais   pendentes e as dos últimos 7 dias (a página põe o posto no mapa antes da Base nova chegar)
// POST /api/locais   {nome, cidade, uf, lat, lon}
const so = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  if (!pode(u, 'mapa-calor')) return json({ erro: 'Seu acesso não inclui o mapa de calor.' }, 403);
  const { results } = await env.DB.prepare(
    `SELECT id, criado_em, usuario_nome, nome, cidade, uf, lat, lon, estado, mensagem, aplicada_em, linha FROM alteracoes_locais
      WHERE estado IN ('pendente', 'aguardando') OR criado_em >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')
      ORDER BY id DESC LIMIT 500`).all();
  return json({ podeEditar: pode(u, 'mapa-calor-editar'), alteracoes: results });
}

export async function onRequestPost({ request, env, waitUntil }) {
  const origem = request.headers.get('Origin');
  if (origem && origem !== new URL(request.url).origin) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  if (!pode(u, 'mapa-calor-editar')) return json({ erro: 'Seu acesso ao mapa de calor é só de consulta.' }, 403);
  let d;
  try { d = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const nome = so(d.nome, 200).toUpperCase(), cidade = so(d.cidade, 100).toUpperCase(), uf = so(d.uf, 2).toUpperCase();
  const lat = Number(d.lat), lon = Number(d.lon);
  if (!nome) return json({ erro: 'Posto sem nome.' }, 400);
  if (!(lat > -35 && lat < 6) || !(lon > -75 && lon < -30)) return json({ erro: 'Coordenada fora do Brasil. Confira a latitude e a longitude.' }, 400);
  if (uf && !/^[A-Z]{2}$/.test(uf)) return json({ erro: 'UF inválida.' }, 400);
  // o mesmo posto ainda esperando gravação: troca a coordenada em vez de criar outra linha
  const pend = await env.DB.prepare(`SELECT id FROM alteracoes_locais WHERE nome = ? AND estado IN ('pendente', 'aguardando') LIMIT 1`).bind(nome).first();
  const r = pend
    ? await env.DB.prepare(`UPDATE alteracoes_locais SET lat = ?, lon = ?, cidade = ?, uf = ?, usuario_id = ?, usuario_nome = ?, estado = 'pendente', mensagem = NULL,
        banco_aplicado_em = NULL, banco_mensagem = NULL
        WHERE id = ? RETURNING id, criado_em, usuario_nome, nome, cidade, uf, lat, lon, estado, mensagem, aplicada_em, linha`)
      .bind(lat, lon, cidade || null, uf || null, u.id, u.nome, pend.id).first()
    : await env.DB.prepare(`INSERT INTO alteracoes_locais (usuario_id, usuario_nome, nome, cidade, uf, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?)
        RETURNING id, criado_em, usuario_nome, nome, cidade, uf, lat, lon, estado, mensagem, aplicada_em, linha`)
      .bind(u.id, u.nome, nome, cidade || null, uf || null, lat, lon).first();
  aplicarCadastrosDepois({ env, waitUntil }, 'locais');   // aplica também direto no banco (15.3 item 5, 25/11/2026)
  return json({ ok: true, alteracao: r }, 201);
}
