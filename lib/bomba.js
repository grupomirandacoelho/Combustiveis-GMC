// Validações comuns do grupo Bomba interna (bases, movimentações e abastecimentos lançados pelo site).
import { rpc } from './supabase.js';
export const TANQUES = ['diesel', 'arla'];
export const QUANDO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;   // 'AAAA-MM-DDTHH:MM' (hora local)
export const texto = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const numero = (v) => (v === '' || v === null || v === undefined ? null : Number(String(v).replace(',', '.')));

export function quandoValido(q) {
  if (typeof q !== 'string' || !QUANDO.test(q)) return false;
  const d = new Date(q + ':00Z');
  return !Number.isNaN(d.getTime()) && d.getUTCFullYear() >= 2020 && d.getUTCFullYear() <= 2100;
}

// bases que o login vê (coluna usuarios.bomba_bases, marcada em Gerenciar acessos):
// null = todas (administrador, ou "todas as bases"); senão um Set com os ids liberados (valor ilegível = nenhuma)
export function basesDoUsuario(u) {
  if (!u || u.papel === 'admin' || u.bomba_bases === null || u.bomba_bases === undefined) return null;
  try {
    const l = JSON.parse(u.bomba_bases);
    return new Set(Array.isArray(l) ? l.map(Number).filter(Number.isInteger) : []);
  } catch { return new Set(); }
}
export const veBase = (permitidas, id) => !permitidas || permitidas.has(Number(id));

export async function lerBases(db, soAtivas, permitidas = null) {
  const { results } = await db.prepare(
    `SELECT id, nome, posto, tanques, ativo, criado_em, atualizado_em, usuario_nome FROM bomba_bases ${soAtivas ? 'WHERE ativo = 1' : ''} ORDER BY nome`).all();
  return results.filter((b) => veBase(permitidas, b.id)).map((b) => ({ ...b, tanques: JSON.parse(b.tanques) }));
}

// cadastro dos fornecedores das bombas internas (aba Fornecedores da planilha Negociação bomba interna, publicada pelo vigia
// no KV "fornecedores-bomba") + os lançados no site que ainda não chegaram lá. O CNPJ (de cada unidade) liga às notas.
// -> [{fornecedor, produto, unidade, ativo, cnpj}]
export async function cadastroFornecedores(env) {
  // 15.3 (25/11/2026): com a chave KV "bomba-fonte" = "banco", o cadastro vem do banco (gestao_bomba_fornecedores_lista)
  let kv = null;
  if ((await env.DADOS.get('bomba-fonte').catch(() => null)) === 'banco') {
    const f = await rpc(env, 'gestao_bomba_fornecedores_lista', {}, { ms: 8000 });
    if (Array.isArray(f) && f.length) kv = { fornecedores: f };
  }
  if (!kv) kv = await env.DADOS.get('fornecedores-bomba', 'json').catch(() => null);
  const m = new Map();
  for (const [fornecedor, produto, unidade, ativo, cnpj] of (kv && kv.fornecedores) || []) {
    m.set(fornecedor + '|' + produto + '|' + unidade, { fornecedor, produto, unidade, ativo: ativo !== false, cnpj: cnpj || null });
  }
  const { results } = await env.DB.prepare(
    "SELECT dados FROM alteracoes_bomba WHERE tipo = 'fornecedor' AND estado != 'erro' AND criado_em >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days') ORDER BY id").all();
  for (const r of results) {
    const d = JSON.parse(r.dados);
    for (const unidade of d.unidades || []) {
      const k = d.fornecedor + '|' + d.produto + '|' + unidade, atual = m.get(k);
      const cnpj = d.cnpjs && unidade in d.cnpjs ? d.cnpjs[unidade] || null : atual ? atual.cnpj : null;
      m.set(k, { fornecedor: d.fornecedor, produto: d.produto, unidade, ativo: d.ativo !== false, cnpj });
    }
  }
  return [...m.values()].sort((a, b) => a.fornecedor.localeCompare(b.fornecedor) || a.produto.localeCompare(b.produto) || a.unidade.localeCompare(b.unidade));
}
