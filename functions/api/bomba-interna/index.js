import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode } from '../../../lib/permissoes.js';
import { aplicarCadastrosDepois } from '../../../lib/aplicar-cadastros.js';

// Operacional > Preço bomba interna: negociações e fornecedores lançados no site; o vigia grava na planilha
// CONTROLES\Negociação bomba interna.xlsx (scripts/planilha_bomba.py).
// GET  /api/bomba-interna   lançamentos pendentes e dos últimos 7 dias (a página mostra antes de a Base nova chegar)
// POST /api/bomba-interna   {negociacoes: [{data, fornecedor, produto, unidade, preco}]} ou
//                           {fornecedor: {fornecedor, produto, unidades, ativo, cnpjs: {UNIDADE: '14 números' ou ''}}}
//   cnpjs: CNPJ de cada unidade (liga o fornecedor às notas do Rateio das NFs); unidade fora de cnpjs mantém o da planilha
const PRODUTOS = new Set(['DIESEL', 'ARLA']);
const so = (v, max) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, max);
const ehData = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  if (!pode(u, 'preco-fornecedor')) return json({ erro: 'Seu acesso não inclui o preço da bomba interna.' }, 403);
  const { results } = await env.DB.prepare(
    `SELECT id, criado_em, usuario_nome, tipo, dados, estado, mensagem, aplicada_em, linha FROM alteracoes_bomba
      WHERE estado IN ('pendente', 'aguardando') OR criado_em >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')
      ORDER BY id DESC LIMIT 1000`).all();
  return json({ podeEditar: pode(u, 'preco-fornecedor-editar'), alteracoes: results.map((r) => ({ ...r, dados: JSON.parse(r.dados) })) });
}

export async function onRequestPost({ request, env, waitUntil }) {
  const origem = request.headers.get('Origin');
  if (origem && origem !== new URL(request.url).origin) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  if (!pode(u, 'preco-fornecedor-editar')) return json({ erro: 'Seu acesso ao preço da bomba interna é só de consulta.' }, 403);
  let d;
  try { d = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const novos = [];
  if (Array.isArray(d.negociacoes)) {
    if (!d.negociacoes.length || d.negociacoes.length > 100) return json({ erro: 'Informe de 1 a 100 preços por vez.' }, 400);
    for (const n of d.negociacoes) {
      const item = { data: String(n.data || ''), fornecedor: so(n.fornecedor, 60), produto: so(n.produto, 10), unidade: so(n.unidade, 30), preco: Number(n.preco) };
      if (!ehData(item.data)) return json({ erro: 'Data inválida.' }, 400);
      if (!item.fornecedor || !item.unidade || !PRODUTOS.has(item.produto)) return json({ erro: 'Fornecedor, produto ou unidade inválido.' }, 400);
      // excluir: o preço daquele dia foi apagado na tela (lançado por engano). Vai para a fila (o vigia deixa a célula do preço
      // vazia na planilha: "cotação zerada é lançamento vazio") e cancela o que ainda não foi gravado do mesmo preço (11/11/2026)
      if (n.excluir === true) { delete item.preco; item.excluir = true; novos.push(['negociacao', item]); continue; }
      if (!(item.preco > 0 && item.preco < 50)) return json({ erro: 'Preço inválido para ' + item.fornecedor + ' (use R$ por litro, ex.: 5,2825).' }, 400);
      item.preco = Math.round(item.preco * 10000) / 10000;
      novos.push(['negociacao', item]);
    }
  } else if (d.fornecedor && typeof d.fornecedor === 'object') {
    const f = d.fornecedor;
    const item = { fornecedor: so(f.fornecedor, 60), produto: so(f.produto, 10),
      unidades: [...new Set((Array.isArray(f.unidades) ? f.unidades : []).map((x) => so(x, 30)).filter(Boolean))].slice(0, 20), ativo: f.ativo !== false };
    if (item.fornecedor.length < 2) return json({ erro: 'Escreva o nome do fornecedor.' }, 400);
    if (!PRODUTOS.has(item.produto)) return json({ erro: 'Escolha o produto (Diesel ou Arla).' }, 400);
    if (!item.unidades.length) return json({ erro: 'Marque pelo menos uma unidade.' }, 400);
    if (f.cnpjs && typeof f.cnpjs === 'object') {
      item.cnpjs = {};
      for (const [uni, v] of Object.entries(f.cnpjs)) {
        const u = so(uni, 30), c = String(v ?? '').replace(/\D/g, '');
        if (!item.unidades.includes(u)) continue;
        if (c && c.length !== 14) return json({ erro: 'CNPJ de ' + u + ' com 14 números (ex.: 34.274.233/0371-03).' }, 400);
        item.cnpjs[u] = c;
      }
    }
    novos.push(['fornecedor', item]);
  } else {
    return json({ erro: 'Nada para salvar.' }, 400);
  }
  // exclusão: o que ainda está na fila para o mesmo dia/fornecedor/produto/unidade não é mais gravado
  const cancelar = novos.filter(([, x]) => x.excluir).map(([, x]) => env.DB.prepare(
    `UPDATE alteracoes_bomba SET estado = 'erro', mensagem = 'Cancelado: preço excluído pelo site antes de gravar'
      WHERE tipo = 'negociacao' AND estado IN ('pendente', 'aguardando') AND json_extract(dados, '$.data') = ? AND json_extract(dados, '$.fornecedor') = ?
        AND json_extract(dados, '$.produto') = ? AND json_extract(dados, '$.unidade') = ?`).bind(x.data, x.fornecedor, x.produto, x.unidade));
  if (cancelar.length) await env.DB.batch(cancelar);
  const res = await env.DB.batch(novos.map(([tipo, dados]) => env.DB.prepare(
    `INSERT INTO alteracoes_bomba (usuario_id, usuario_nome, tipo, dados) VALUES (?, ?, ?, ?)
     RETURNING id, criado_em, usuario_nome, tipo, dados, estado, mensagem, aplicada_em, linha`).bind(u.id, u.nome, tipo, JSON.stringify(dados))));
  aplicarCadastrosDepois({ env, waitUntil }, 'bomba');   // aplica também direto no banco (15.3 item 3, 25/11/2026)
  return json({ ok: true, alteracoes: res.map((r) => r.results[0]).map((r) => ({ ...r, dados: JSON.parse(r.dados) })) }, 201);
}
