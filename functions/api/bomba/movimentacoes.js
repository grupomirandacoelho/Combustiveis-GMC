import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode } from '../../../lib/permissoes.js';
import { TANQUES, texto, numero, quandoValido, basesDoUsuario, veBase, cadastroFornecedores } from '../../../lib/bomba.js';

// Bomba interna > Movimentações: compras de combustível dos tanques (entram no estoque).
// Só as das bases liberadas para o login (Gerenciar acessos; lib/bomba.js basesDoUsuario).
// GET  /api/bomba/movimentacoes   {movimentacoes, podeEditar, fornecedores (cadastro do Preço bomba interna, com CNPJ)}
// POST /api/bomba/movimentacoes   {id?, base_id, tanque, quando, litros, valor, nf, fornecedor, cnpj, emissao, obs}   (com id: edita)
//   fornecedor, CNPJ e emissão ('AAAA-MM-DD') da nota: opcionais, aparecem no Rateio das NFs para o fiscal
//                                 {id, excluir: true}                                        (exclui: some da lista e do estoque)
const CAMPOS = 'id, base_id, tanque, quando, litros, valor, nf, fornecedor, cnpj, emissao, obs, criado_em, usuario_nome';

// também usada pelo envio ao celular (functions/api/sync/push/contexto.js)
export async function lista(db, permitidas) {
  const { results } = await db.prepare(`SELECT ${CAMPOS} FROM bomba_movimentacoes WHERE excluida = 0 ORDER BY quando DESC, id DESC`).all();
  return results.filter((m) => veBase(permitidas, m.base_id));
}

export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  if (!pode(u, 'bomba-movimentacoes', 'bomba-estoque', 'bomba-abastecimento')) return json({ erro: 'Seu acesso não inclui as bombas internas.' }, 403);
  const [movimentacoes, fornecedores] = await Promise.all([lista(env.DB, basesDoUsuario(u)), cadastroFornecedores(env)]);
  return json({ movimentacoes, podeEditar: pode(u, 'bomba-movimentacoes-editar'), fornecedores });
}

export async function onRequestPost({ request, env }) {
  const origem = request.headers.get('Origin');
  if (origem && origem !== new URL(request.url).origin) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  if (!pode(u, 'bomba-movimentacoes-editar')) return json({ erro: 'Seu acesso às movimentações é só de consulta.' }, 403);
  let d;
  try { d = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const permitidas = basesDoUsuario(u);
  // editar ou excluir: a compra precisa ser de uma base que o login vê
  if (d.id) {
    const atual = await env.DB.prepare('SELECT base_id FROM bomba_movimentacoes WHERE id = ? AND excluida = 0').bind(Number(d.id)).first();
    if (!atual || !veBase(permitidas, atual.base_id)) return json({ erro: 'Movimentação não encontrada.' }, 404);
  }
  if (d.excluir) {
    const r = await env.DB.prepare('UPDATE bomba_movimentacoes SET excluida = 1, usuario_nome = ? WHERE id = ?').bind(u.nome, Number(d.id)).run();
    if (!r.meta.changes) return json({ erro: 'Movimentação não encontrada.' }, 404);
    return json({ ok: true, movimentacoes: await lista(env.DB, permitidas) });
  }
  const base = veBase(permitidas, d.base_id)
    ? await env.DB.prepare('SELECT id, tanques FROM bomba_bases WHERE id = ?').bind(Number(d.base_id)).first() : null;
  const litros = numero(d.litros), valor = numero(d.valor);
  const erros = [];
  if (!base) erros.push('Escolha a unidade (base).');
  if (!TANQUES.includes(d.tanque)) erros.push('Escolha o tanque (diesel ou Arla).');
  else if (base && !JSON.parse(base.tanques)[d.tanque]) erros.push('Esta base não tem tanque de ' + (d.tanque === 'arla' ? 'Arla' : 'diesel') + '.');
  if (!quandoValido(d.quando)) erros.push('Informe a data e a hora.');
  if (!(litros > 0 && litros <= 1_000_000)) erros.push('Informe a litragem.');
  if (!(valor > 0 && valor <= 100_000_000)) erros.push('Informe o valor total.');
  const fornecedor = texto(d.fornecedor, 120).toUpperCase() || null;
  const cnpj = String(d.cnpj || '').replace(/\D/g, '') || null;
  const emissao = texto(d.emissao, 10) || null;
  if (cnpj && cnpj.length !== 14) erros.push('CNPJ do fornecedor com 14 números.');
  if (emissao && !/^\d{4}-\d{2}-\d{2}$/.test(emissao)) erros.push('Data de emissão da nota inválida.');
  if (erros.length) return json({ erro: erros.join(' ') }, 400);
  const nf = texto(d.nf, 40) || null, obs = texto(d.obs, 500) || null;
  if (d.id) {
    const r = await env.DB.prepare(`UPDATE bomba_movimentacoes SET base_id = ?, tanque = ?, quando = ?, litros = ?, valor = ?, nf = ?, fornecedor = ?, cnpj = ?,
        emissao = ?, obs = ?, usuario_nome = ? WHERE id = ? AND excluida = 0`)
      .bind(base.id, d.tanque, d.quando, litros, valor, nf, fornecedor, cnpj, emissao, obs, u.nome, Number(d.id)).run();
    if (!r.meta.changes) return json({ erro: 'Movimentação não encontrada.' }, 404);
  } else {
    await env.DB.prepare(`INSERT INTO bomba_movimentacoes (base_id, tanque, quando, litros, valor, nf, fornecedor, cnpj, emissao, obs, usuario_nome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(base.id, d.tanque, d.quando, litros, valor, nf, fornecedor, cnpj, emissao, obs, u.nome).run();
  }
  return json({ ok: true, movimentacoes: await lista(env.DB, permitidas) });
}
