import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { validar, texto } from './alteracoes.js';
import { pode } from '../../../lib/permissoes.js';
import { aplicarCadastrosDepois } from '../../../lib/aplicar-cadastros.js';

// Rodada de preços: a atualização semanal do valor negociado de cada posto pelo preço da última transação.
// Cada posto vira uma alteração "editar" comum; o vigia grava todas juntas na planilha de negociações,
// com o contato no mesmo texto que a rodada feita fora do portal usa.
const CONTATO = 'ATUALIZAÇÃO AUTOMÁTICA (BASE DE TRANSAÇÕES)';
const MAX_ITENS = 300;
// bombas internas fora da rodada (13/11/2026): o preço delas não vem da última transação (sem o rateio sairia errado).
// Mesma lista em public/gestao/paginas/rodada-precos.js
const FORA_DA_RODADA = new Set(['POSTO INT RAJA BELEM', 'POSTO INT RAJA JEQUIE', 'POSTO INT RAJA SALVADOR', 'POSTO INT RAJA SAO PAULO',
  'CAANA', 'CALAN', 'CABET', 'CAAPE']);
const chave = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

export async function onRequestPost({ request, env, waitUntil }) {
  const origem = request.headers.get('Origin');
  if (origem && origem !== new URL(request.url).origin) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  if (!pode(u, 'rodada-precos')) return json({ erro: 'Seu acesso não permite gravar a rodada de preços.' }, 403);
  let corpo;
  try { corpo = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const itens = Array.isArray(corpo.itens) ? corpo.itens : [];
  if (!itens.length) return json({ erro: 'Nenhum posto marcado para a rodada.' }, 400);
  if (itens.length > MAX_ITENS) return json({ erro: 'Rodada grande demais (máximo ' + MAX_ITENS + ' postos).' }, 400);
  const limitePct = Math.round(Number(corpo.limitePct) || 10);

  const linhas = [];
  for (const [i, it] of itens.entries()) {
    const { dados, erros } = validar('editar', { ...it, rodada: true });
    if (!dados.transacao) erros.push('Falta a data da transação.');
    if (dados.valor === null) erros.push('Falta o valor.');
    if (FORA_DA_RODADA.has(chave(dados.posto))) erros.push('Bomba interna não entra na rodada de preços.');
    if (erros.length) return json({ erro: 'Posto ' + (i + 1) + ' (' + (dados.posto || '?') + '): ' + erros.join(' ') }, 400);
    // variação acima do limite só entra quando a pessoa confirmou na tela
    dados.contato = texto(it.confirmado ? CONTATO + ' - CONFIRMADO PELO USUÁRIO (VARIAÇÃO >' + limitePct + '%)' : CONTATO, 100);
    linhas.push(dados);
  }
  const sql = 'INSERT INTO alteracoes_postos (usuario_id, usuario_nome, acao, dados) VALUES (?, ?, ?, ?)';
  await env.DB.batch(linhas.map((d) => env.DB.prepare(sql).bind(u.id, u.nome, 'editar', JSON.stringify(d))));
  aplicarCadastrosDepois({ env, waitUntil }, 'postos');   // aplica também direto no banco (15.3 item 4, 25/11/2026)
  return json({ ok: true, postos: linhas.length }, 201);
}
