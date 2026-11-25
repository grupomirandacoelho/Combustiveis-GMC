import { tokenSyncValido, json } from '../../../../lib/auth.js';
import { rpc, temBanco } from '../../../../lib/supabase.js';

// Coordenadas que a busca no OpenStreetMap do vigia (scripts/geocodificar_postos.py) gravou sozinha na planilha LOCALIZAÇÃO DOS
// POSTOS: entram também no banco, com a mesma regra das cadastradas no mapa de calor (gestao_aplicar_local). 15.3 item 5,
// 25/11/2026: depois da virada a planilha não é mais recopiada para o banco, e sem isto essas coordenadas ficariam só nela.
// POST {itens: [{nome, cidade, uf, lat, lon}]} -> {ok, gravados, erros}
export async function onRequestPost({ request, env }) {
  if (!tokenSyncValido(request, env)) return json({ erro: 'Não autorizado.' }, 401);
  if (!temBanco(env)) return json({ erro: 'Banco não configurado.' }, 503);
  let corpo;
  try { corpo = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const so = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  let gravados = 0, erros = 0;
  for (const it of (Array.isArray(corpo.itens) ? corpo.itens : []).slice(0, 50)) {
    const lat = Number(it.lat), lon = Number(it.lon);
    if (!so(it.nome, 200) || !(lat > -35 && lat < 6) || !(lon > -75 && lon < -30)) { erros++; continue; }
    const r = await rpc(env, 'gestao_aplicar_local', { p_nome: so(it.nome, 200), p_cidade: so(it.cidade, 100) || null,
      p_uf: so(it.uf, 2) || null, p_lat: lat, p_lon: lon });
    if (r && r.ok) gravados++; else erros++;
  }
  return json({ ok: true, gravados, erros });
}
