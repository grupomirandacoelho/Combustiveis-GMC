import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode } from '../../../lib/permissoes.js';
import { TANQUES, texto, numero, quandoValido, lerBases, basesDoUsuario, veBase } from '../../../lib/bomba.js';

// Bomba interna > Estoque: bases (bombas internas) e os tanques delas.
// Cada login vê só as bases liberadas para ele em Gerenciar acessos (lib/bomba.js basesDoUsuario); criar base nova
// é só para quem vê todas (senão a base criada sumiria da tela de quem a criou).
// GET  /api/bomba/bases   {bases, podeEditar, podeCriar}
// POST /api/bomba/bases   {id?, nome, posto, ativo?, tanques: {diesel: {capacidade, inicial, inicialEm, precoInicial?} | null, arla: ... | null}}
//   posto = NOME ESTABELECIMENTO dos abastecimentos dessa bomba na Base (é por ele que o estoque acha as saídas)
//   inicial/inicialEm = litros no tanque naquele momento (medição); editar de novo vale como acerto de estoque
function validarTanque(t, nome) {
  if (t === null || t === undefined || t === false) return { valor: null };
  const capacidade = numero(t.capacidade), inicial = numero(t.inicial), precoInicial = numero(t.precoInicial);
  const erros = [];
  if (!(capacidade > 0 && capacidade <= 1_000_000)) erros.push(`Capacidade do tanque de ${nome} inválida.`);
  if (!(inicial >= 0 && inicial <= 1_000_000)) erros.push(`Estoque inicial do tanque de ${nome} inválido.`);
  else if (capacidade > 0 && inicial > capacidade * 1.05) erros.push(`O estoque inicial do tanque de ${nome} passa da capacidade.`);
  if (!quandoValido(t.inicialEm)) erros.push(`Informe a data e a hora da medição do tanque de ${nome}.`);
  if (precoInicial !== null && !(precoInicial > 0 && precoInicial < 50)) erros.push(`Preço inicial do tanque de ${nome} inválido.`);
  return { erros, valor: { capacidade, inicial, inicialEm: t.inicialEm, precoInicial } };
}

export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  if (!pode(u, 'bomba-estoque', 'bomba-abastecimento', 'bomba-movimentacoes')) return json({ erro: 'Seu acesso não inclui as bombas internas.' }, 403);
  const permitidas = basesDoUsuario(u);
  return json({ bases: await lerBases(env.DB, false, permitidas), podeEditar: pode(u, 'bomba-estoque-editar'),
    podeCriar: pode(u, 'bomba-estoque-editar') && !permitidas });
}

export async function onRequestPost({ request, env }) {
  const origem = request.headers.get('Origin');
  if (origem && origem !== new URL(request.url).origin) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  if (!pode(u, 'bomba-estoque-editar')) return json({ erro: 'Seu acesso ao estoque é só de consulta.' }, 403);
  let d;
  try { d = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const permitidas = basesDoUsuario(u);
  if (d.id && !veBase(permitidas, d.id)) return json({ erro: 'Base não encontrada.' }, 404);
  if (!d.id && permitidas) return json({ erro: 'Seu acesso é só a algumas bases; uma base nova precisa ser criada por quem tem acesso a todas.' }, 403);
  const nome = texto(d.nome, 80).toUpperCase(), posto = texto(d.posto, 120).toUpperCase();
  const erros = [];
  if (!nome) erros.push('Informe o nome da base.');
  if (!posto) erros.push('Informe o posto (nome do estabelecimento como aparece nos abastecimentos).');
  const tanques = {};
  for (const t of TANQUES) {
    const r = validarTanque((d.tanques || {})[t], t === 'diesel' ? 'diesel' : 'Arla');
    if (r.erros) erros.push(...r.erros);
    tanques[t] = r.valor;
  }
  if (!tanques.diesel && !tanques.arla) erros.push('Cadastre pelo menos um tanque (diesel ou Arla).');
  if (erros.length) return json({ erro: erros.join(' ') }, 400);
  const ativo = d.ativo === false || d.ativo === 0 ? 0 : 1;
  if (d.id) {
    const r = await env.DB.prepare(`UPDATE bomba_bases SET nome = ?, posto = ?, tanques = ?, ativo = ?, usuario_nome = ?,
        atualizado_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`)
      .bind(nome, posto, JSON.stringify(tanques), ativo, u.nome, Number(d.id)).run();
    if (!r.meta.changes) return json({ erro: 'Base não encontrada.' }, 404);
  } else {
    await env.DB.prepare('INSERT INTO bomba_bases (nome, posto, tanques, ativo, usuario_nome) VALUES (?, ?, ?, ?, ?)')
      .bind(nome, posto, JSON.stringify(tanques), ativo, u.nome).run();
  }
  return json({ ok: true, bases: await lerBases(env.DB, false, permitidas) });
}
