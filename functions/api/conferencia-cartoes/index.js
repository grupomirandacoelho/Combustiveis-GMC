import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode } from '../../../lib/permissoes.js';

// Operacional > Conferência com os cartões. O vigia (scripts/conferencia_cartoes.mjs) publica no KV "conferencia-cartoes" a
// comparação da Base_copia com as APIs da Ticket e da TruckPag (últimos 45 dias). Aqui cada diferença é classificada com o
// histórico de correções do portal (alteracoes_base_copia), comparando três valores de cada campo:
//   original = o que veio do cartão (o "antes" da primeira correção feita no portal; sem correção, o valor da Base_copia)
//   nosso    = o que está na Base_copia (ou a última correção ainda não gravada)
//   cartão   = o que a API mostra hoje
// cartão = nosso: some · corrigido no portal e cartão = original: "corrigido" (não é erro) · sem correção: "cartao" (mudou lá)
// · corrigido aqui e o cartão também mudou: "conflito". Mais "falta" (no cartão, não na Base_copia) e "sumiu" (o contrário).
// GET  -> {geradoEm, desde, ate, itens, contagem, podeEditar, podeAplicar}   (?resumo=1 -> {pendentes})
// POST {acao: 'manter', chaves: []} | {acao: 'desfazer', chaves: []} | {acao: 'incluir', itens: [{id, dia, placa, quando}]}
const COLS = ['F', 'Q', 'O', 'T'];   // placa, hodômetro, litros, valor
const minutoDe = (serial) => Math.round(serial * 1440);
const limpa = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const igual = (a, b, c) => {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (c === 'F') return limpa(a) === limpa(b);
  return Math.abs(Number(a) - Number(b)) < (c === 'Q' ? 0.5 : c === 'O' ? 0.0099 : 0.5);   // litros: 3 casas no cartão, 2 na Base_copia
};

async function montar(env) {
  const d = await env.DADOS.get('conferencia-cartoes', 'json').catch(() => null);
  if (!d) return null;
  const desdeSerial = (Date.parse(d.desde + 'T00:00:00Z') / 864e5) + 25569 - 1;
  const [alt, dec, ped] = await Promise.all([
    env.DB.prepare(`SELECT placa, data, celulas, antes, estado FROM alteracoes_base_copia
      WHERE acao = 'editar' AND estado <> 'erro' AND data >= ? ORDER BY id`).bind(desdeSerial).all(),
    env.DB.prepare('SELECT chave, decisao, usuario_nome, criado_em FROM conferencia_decisoes').all(),
    env.DB.prepare('SELECT cartao_id, estado, mensagem, usuario_nome, criado_em FROM conferencia_pedidos').all(),
  ]);
  // correções do portal por abastecimento (placa + minuto: as linhas da Base_copia mudam de número quando uma é excluída)
  // também pelo minuto + placa nova: com a placa corrigida, a linha da Base_copia já está com a placa nova
  const correcoes = new Map();
  for (const a of alt.results) {
    const k = limpa(a.placa) + '|' + minutoDe(a.data);
    let cel = {}, ant = {};
    try { cel = JSON.parse(a.celulas); ant = JSON.parse(a.antes); } catch {}
    const c = correcoes.get(k) || {};
    for (const col of COLS) {
      if (!(col in cel)) continue;
      if (!c[col]) c[col] = { original: col in ant ? ant[col] : undefined, ultimo: cel[col] };
      else c[col].ultimo = cel[col];
    }
    correcoes.set(k, c);
    if (c.F && c.F.ultimo) correcoes.set(limpa(c.F.ultimo) + '|' + minutoDe(a.data), c);
  }
  const decisoes = new Map(dec.results.map((x) => [x.chave, x]));
  const pedidos = new Map(ped.results.map((x) => [x.cartao_id, x]));
  const itens = [];
  for (const it of d.itens) {
    if (it.tipo === 'falta') {
      const chave = 'falta|' + it.id;
      itens.push({ ...it, classe: 'falta', chave, decisao: decisoes.get(chave) || null, pedido: pedidos.get(it.id) || null });
      continue;
    }
    if (it.tipo === 'sumiu') {
      const chave = 'sumiu|' + it.chave;
      itens.push({ ...it, classe: 'sumiu', chave, decisao: decisoes.get(chave) || null });
      continue;
    }
    const corr = correcoes.get(it.chave) || {};
    const campos = [];
    for (const col of it.colunas) {
      const cartao = it.cartaoVals[col], c = corr[col];
      const nosso = c ? c.ultimo : it.nossos[col];
      if (igual(nosso, cartao, col)) continue;   // a correção pendente já deixou igual ao cartão
      const original = c && c.original !== undefined ? c.original : it.nossos[col];
      const classe = !c ? 'cartao' : igual(cartao, original, col) ? 'corrigido' : 'conflito';
      const chave = 'dif|' + it.chave + '|' + col + '|' + cartao;
      campos.push({ col, nosso, cartao, original, classe, chave, decisao: decisoes.get(chave) || null });
    }
    if (!campos.length) continue;
    const ativos = campos.filter((x) => !x.decisao);
    const classe = !ativos.length ? 'mantido' : ativos.some((x) => x.classe === 'conflito') ? 'conflito'
      : ativos.some((x) => x.classe === 'cartao') ? 'cartao' : 'corrigido';
    itens.push({ ...it, classe, campos });
  }
  const resolver = (i) => (i.classe === 'cartao' || i.classe === 'conflito') ||
    ((i.classe === 'falta' || i.classe === 'sumiu') && !i.decisao && !(i.pedido && i.pedido.estado !== 'erro'));
  const contagem = { cartao: 0, conflito: 0, falta: 0, sumiu: 0, corrigido: 0, mantido: 0 };
  for (const i of itens) {
    if (i.classe === 'falta' || i.classe === 'sumiu') { if (resolver(i)) contagem[i.classe]++; else contagem.mantido++; }
    else contagem[i.classe]++;
  }
  return { geradoEm: d.geradoEm, desde: d.desde, ate: d.ate, lidos: d.lidos, itens, contagem, pendentes: itens.filter(resolver).length };
}

export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  if (!pode(u, 'conferencia-cartoes')) return json({ erro: 'Seu acesso não inclui a conferência com os cartões.' }, 403);
  const r = await montar(env);
  if (!r) return json({ erro: 'A conferência ainda não foi feita (roda a cada 3 horas). Tente mais tarde.' }, 503);
  if (new URL(request.url).searchParams.get('resumo')) return json({ pendentes: r.pendentes });
  return json({ ...r, podeEditar: pode(u, 'conferencia-cartoes-editar'), podeAplicar: pode(u, 'abastecimentos-editar') });
}

export async function onRequestPost({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  if (!pode(u, 'conferencia-cartoes-editar')) return json({ erro: 'Seu acesso à conferência é só de consulta.' }, 403);
  let b;
  try { b = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const chaveOk = (c) => typeof c === 'string' && c.length > 4 && c.length <= 200 && /^(dif|falta|sumiu)\|/.test(c);
  if (b.acao === 'manter') {
    const chaves = (Array.isArray(b.chaves) ? b.chaves : []).filter(chaveOk).slice(0, 200);
    if (!chaves.length) return json({ erro: 'Nada para marcar.' }, 400);
    await env.DB.batch(chaves.map((c) => env.DB.prepare(
      'INSERT OR REPLACE INTO conferencia_decisoes (chave, decisao, usuario_nome) VALUES (?, ?, ?)').bind(c, 'manter', u.nome)));
  } else if (b.acao === 'desfazer') {
    const chaves = (Array.isArray(b.chaves) ? b.chaves : [b.chave]).filter(chaveOk).slice(0, 200);
    if (!chaves.length) return json({ erro: 'Dados inválidos.' }, 400);
    await env.DB.batch(chaves.map((c) => env.DB.prepare('DELETE FROM conferencia_decisoes WHERE chave = ?').bind(c)));
  } else if (b.acao === 'incluir') {
    const its = (Array.isArray(b.itens) ? b.itens : []).filter((i) => i && /^(ticket|truckpag):\w+$/.test(String(i.id)) && /^\d{4}-\d{2}-\d{2}$/.test(String(i.dia))).slice(0, 100);
    if (!its.length) return json({ erro: 'Nada para incluir.' }, 400);
    // pedido com erro pode ser feito de novo; os outros ficam como estão
    await env.DB.batch(its.map((i) => env.DB.prepare(
      `INSERT INTO conferencia_pedidos (cartao_id, dia, placa, quando, usuario_nome) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cartao_id) DO UPDATE SET estado = 'pendente', mensagem = NULL, usuario_nome = excluded.usuario_nome, criado_em = excluded.criado_em
       WHERE conferencia_pedidos.estado = 'erro'`).bind(String(i.id), i.dia, String(i.placa || '').slice(0, 10), String(i.quando || '').slice(0, 20), u.nome)));
  } else return json({ erro: 'Ação desconhecida.' }, 400);
  return json({ ok: true });
}