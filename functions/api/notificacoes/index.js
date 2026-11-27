import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode, permissoesDe, USAM_DADOS, CATALOGO } from '../../../lib/permissoes.js';
// quem recebe cada regra: o mesmo código da tela Configurar notificações (18/11/2026)
import { recebe, limparDestinatarios } from '../../../public/gestao/lib/destino-notificacao.js';
import { DE_USUARIOS, CAMPOS_USUARIO, unidadesDe } from '../../../lib/usuarios.js';
import { UNIDADES } from '../../../public/gestao/lib/unidades.js';

// Operacional > Notificações: regras dos avisos no canto da tela. A conta é feita no navegador (public/gestao/lib/notificacao.js,
// catálogo TIPOS); aqui ficam as regras, a validação dos campos de cada tipo e os dados do servidor que alguns tipos usam.
// GET  ?minhas=1 -> {regras, contexto}: as ativas que valem para quem está logado (qualquer login)
// GET            -> {regras, contexto, usuarios: [{id, nome, permissoes, acessos}], telas: [{grupo, itens: [{id, rotulo}]}], usamDados}
//                   (permissão "notificacoes"). destinatarios: {modo: 'todos' | 'telas' (telas: [...]) | 'usuarios' (ids: [...])}
// POST {acao: 'salvar', id?, nome, tipo, ativa, condicao, mensagem, nivel, destinatarios, repetir, celular}
//      celular (26/11/2026): também manda para o celular de quem ativou as notificações no aparelho (lib/nuvem/push.js)
//      {acao: 'ativar', id, ativa} · {acao: 'excluir', id}                      (permissão "notificacoes")
// contexto: {base: {baseSalvaEm, geradoEm, copiaEm}, alertasCartao: [{id, criado_em, placa, cartoes, motorista}] (quem vê os Cartões frota)}
const NIVEIS = ['info', 'alerta', 'critico'];
const ler = (s, p) => { try { return s ? JSON.parse(s) : p; } catch { return p; } };
const agora = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
export const regra = (r) => ({
  id: r.id, nome: r.nome, tipo: r.tipo, ativa: r.ativa === 1, condicao: ler(r.condicao, {}), mensagem: r.mensagem, nivel: r.nivel,
  destinatarios: ler(r.destinatarios, { modo: 'todos' }), repetir: r.repetir, celular: r.celular === 1,
  criado_por: r.criado_por, criado_em: r.criado_em, atualizado_por: r.atualizado_por, atualizado_em: r.atualizado_em,
});

// campos de cada tipo: número dentro de um intervalo, um valor de uma lista, texto curto ou data (AAAA-MM-DD)
const n = (v, min, max, nome) => { const x = Number(v); return Number.isFinite(x) && x >= min && x <= max ? x : { erro: nome } };
const umDe = (v, lista, padrao) => (lista.includes(v) ? v : padrao);
const txt = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().slice(0, 80));
const data = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
// telas que podem ser escolhidas em "quem tem acesso a estas telas": as do menu (sem as permissões de edição)
const TELAS = CATALOGO.map((g) => ({ grupo: g.grupo, itens: g.itens.filter((i) => !i.requer).map((i) => ({ id: i.id, rotulo: i.rotulo })) })).filter((g) => g.itens.length);
const TELAS_IDS = TELAS.flatMap((g) => g.itens.map((i) => i.id));
const TIPOS = {
  'estoque-baixo': (c) => {
    const unidade = umDe(c.unidade, ['litros', 'pct'], 'litros');
    // base_ids: lista de bases (vazia = todas). Aceita ainda o base_id antigo (uma base só).
    const lista = Array.isArray(c.base_ids) ? c.base_ids : c.base_id === null || c.base_id === undefined || c.base_id === '' ? [] : [c.base_id];
    const base_ids = [...new Set(lista.map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 100);
    return { base_ids, tanque: umDe(c.tanque, ['diesel', 'arla', 'todos'], 'todos'), unidade,
      limite: unidade === 'pct' ? n(c.limite, 0.1, 99.9, 'O limite em % precisa ficar entre 0 e 100.') : n(c.limite, 1, 1e6, 'Informe o limite em litros.') };
  },
  comunicado: (c) => {
    const de = data(c.de), ate = data(c.ate);
    if (!de || !ate) return { erro: 'Informe as datas de início e de fim do comunicado.' };
    if (ate < de) return { erro: 'A data de fim é antes da de início.' };
    return { de, ate };
  },
  'preco-alto': (c) => {
    const modo = umDe(c.modo, ['reais', 'pct', 'ultimo_pct', 'ultimo_cent'], 'reais');
    return { combustivel: umDe(c.combustivel, ['diesel', 'arla', 'todos'], 'diesel'), cc: txt(c.cc), modo,
      limite: modo === 'pct' || modo === 'ultimo_pct' ? n(c.limite, 0.1, 500, 'O limite em % precisa ficar entre 0 e 500.')
        : modo === 'ultimo_cent' ? n(c.limite, 1, 500, 'O limite em centavos precisa ficar entre 1 e 500.') : n(c.limite, 0.01, 50, 'Informe o preço limite em R$ por litro.'),
      dias: n(c.dias, 1, 60, 'Os dias para olhar precisam ficar entre 1 e 60.') };
  },
  'falta-cartao': (c) => ({ cartao: umDe(c.cartao, ['todos', 'ticket', 'truckpag', 'veloe'], 'todos'), cc: txt(c.cc),
    minimo: n(c.minimo, 1, 999, 'O mínimo de pedidos abertos precisa ser de 1 a 999.'), horas: n(c.horas, 0, 720, 'As horas precisam ficar entre 0 e 720.') }),
  // aviso personalizado (26/11/2026): o usuário monta (lib/notificacao.js TIPOS.personalizado)
  personalizado: (c) => {
    const lista = (v, validos, max) => (Array.isArray(v) ? [...new Set(v.map(String).filter((x) => !validos || validos.includes(x)))].slice(0, max || 50) : []);
    const por_unidade = c.por_unidade === true;
    if (c.fonte !== 'abastecimentos') {
      return { fonte: 'postos', por_unidade, acoes: lista(c.acoes, ['adicionar', 'editar', 'rodada', 'autorizar', 'bloquear']),
        unidades_postos: lista(c.unidades_postos, UNIDADES), cartoes: lista(c.cartoes, ['TICKETLOG', 'TRUCKPAG', 'VELOE', 'IDENTIFICAÇÃO']),
        horas: n(c.horas, 1, 720, 'As horas do aviso precisam ficar entre 1 e 720.') };
    }
    const valor = Number(c.valor);
    if (!Number.isFinite(valor)) return { erro: 'Informe o valor da condição.' };
    return { fonte: 'abastecimentos', por_unidade,
      medida: umDe(c.medida, ['litros', 'despesa', 'preco', 'km', 'media', 'pct_meta', 'qtd'], 'litros'),
      agrupar: umDe(c.agrupar, ['abastecimento', 'placa', 'motorista', 'cc', 'posto', 'total'], 'placa'),
      operador: umDe(c.operador, ['>', '>=', '<', '<=', '='], '>'), valor,
      periodo: umDe(String(c.periodo), ['hoje', 'ontem', '7', '15', '30', 'mes'], 'ontem'),
      combustivel: umDe(c.combustivel, ['diesel', 'arla', 'todos'], 'diesel'),
      cartao: umDe(c.cartao, ['todos', 'TICKET', 'TRUCKPAG', 'VELOE', 'VIBRA'], 'todos'),
      estab: umDe(c.estab, ['todos', 'externo', 'interno'], 'todos'),
      ccs: lista(c.ccs, null, 60).map((x) => x.slice(0, 80)) };
  },
};
// mudanças nos Postos dos motoristas das últimas 30 dias (índice idx_alteracoes_postos_criado): para o aviso personalizado de postos
export async function alteracoesPostosRecentes(db, horas = 720) {
  const desde = new Date(Date.now() - Math.min(horas, 720) * 3600e3).toISOString().slice(0, 19) + 'Z';
  const { results } = await db.prepare('SELECT id, criado_em, acao, usuario_nome, dados FROM alteracoes_postos WHERE criado_em >= ? ORDER BY id DESC LIMIT 300')
    .bind(desde).all();
  return results.map((a) => ({ ...a, dados: ler(a.dados, {}) }));
}
const horasPostos = (regras) => Math.max(0, ...regras.filter((r) => r.tipo === 'personalizado' && (!r.condicao || r.condicao.fonte !== 'abastecimentos'))
  .map((r) => Number(r.condicao && r.condicao.horas) || 24));

async function contexto(env, u, regras, todasPostos = false) {
  const [versao, copia] = await Promise.all([env.DADOS.get('versao', 'json').catch(() => null), env.DADOS.get('base-copia-versao', 'json').catch(() => null)]);
  const ctx = { base: { baseSalvaEm: versao && versao.baseSalvaEm || null, geradoEm: versao && versao.geradoEm || null, copiaEm: copia && copia.enviadoEm || null },
    unidades: unidadesDe(u) };
  // aviso personalizado de postos: as mudanças do período que as regras olham (no editor, das últimas 72 h para a coluna "Agora")
  const h = todasPostos ? 72 : horasPostos(regras);
  if (h) ctx.alteracoesPostos = await alteracoesPostosRecentes(env.DB, h).catch(() => []);
  if (regras.some((r) => r.tipo === 'falta-cartao') && pode(u, 'cartoes-frota')) {
    const a = await env.DB.prepare("SELECT id, criado_em, placa, cartoes, motorista FROM alertas_cartoes WHERE estado = 'aberto' ORDER BY id DESC LIMIT 300").all().catch(() => ({ results: [] }));
    ctx.alertasCartao = a.results.map((x) => ({ ...x, cartoes: ler(x.cartoes, []) }));
  }
  return ctx;
}

export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  const { results } = await env.DB.prepare('SELECT * FROM notificacoes ORDER BY nome COLLATE NOCASE, id').all();
  const todas = results.map(regra);
  if (new URL(request.url).searchParams.get('minhas')) {
    const perms = permissoesDe(u);
    const minhas = todas.filter((r) => r.ativa && recebe(perms, u.id, r, USAM_DADOS, u.papel === 'admin' ? null : u.funcao_id));
    return json({ regras: minhas, contexto: minhas.length ? await contexto(env, u, minhas) : {} });
  }
  if (!pode(u, 'notificacoes')) return json({ erro: 'Seu acesso não inclui as Notificações.' }, 403);
  const us = await env.DB.prepare(`SELECT ${CAMPOS_USUARIO} ${DE_USUARIOS} WHERE u.ativo = 1 AND u.excluido = 0 ORDER BY u.nome COLLATE NOCASE`).all();
  // o que cada login enxerga (sem acesso à tela de origem, o aviso daquele tipo não aparece para ele)
  return json({ regras: todas, contexto: await contexto(env, u, [{ tipo: 'falta-cartao' }], true), telas: TELAS, usamDados: USAM_DADOS,
    usuarios: us.results.map((x) => ({ id: x.id, nome: x.nome, permissoes: permissoesDe(x),
      // função (perfil de acesso) para o "Para quem: por função" (26/11/2026); administrador não tem função
      funcao_id: x.papel === 'admin' ? null : x.funcao_id || null, funcao_nome: x.papel === 'admin' ? 'Administrador' : x.funcao_nome || 'Acesso personalizado',
      acessos: { estoque: pode(x, 'bomba-estoque'), cartoes: pode(x, 'cartoes-frota'), dados: pode(x, ...USAM_DADOS) } })),
    funcoes: (await env.DB.prepare('SELECT id, nome FROM funcoes ORDER BY nome COLLATE NOCASE').all()).results });
}

function validar(d) {
  const erros = [];
  const nome = String(d.nome || '').trim().slice(0, 80);
  if (!nome) erros.push('Dê um nome para a notificação.');
  const tipo = TIPOS[d.tipo] ? d.tipo : null;
  if (!tipo) erros.push('Tipo de notificação desconhecido.');
  let condicao = null;
  if (tipo) {
    const c = TIPOS[tipo](d.condicao || {});
    if (c.erro) erros.push(c.erro);
    else {
      for (const [k, v] of Object.entries(c)) if (v && typeof v === 'object' && v.erro) erros.push(v.erro); else if (v && typeof v === 'object' && !Array.isArray(v)) delete c[k];   // listas (base_ids) ficam
      condicao = c;
    }
  }
  const mensagem = String(d.mensagem || '').trim().slice(0, 600);
  if (!mensagem) erros.push('Escreva a mensagem do aviso.');
  const nivel = NIVEIS.includes(d.nivel) ? d.nivel : 'alerta';
  const dst = limparDestinatarios(d.destinatarios, TELAS_IDS);
  if (dst.erro) erros.push(dst.erro);
  const destinatarios = dst.valor || { modo: 'todos' };
  const repetir = /^(sessao|diaria|nunca|horas:([1-9]|1\d|2[0-3]))$/.test(String(d.repetir || '')) ? d.repetir : 'diaria';   // nunca: aparece uma vez só (26/11/2026)
  return { erros, valor: { nome, tipo, ativa: d.ativa === false ? 0 : 1, condicao, mensagem, nivel, destinatarios, repetir, celular: d.celular === true ? 1 : 0 } };
}

export async function onRequestPost({ request, env }) {
  const origem = request.headers.get('Origin');
  if (origem && origem !== new URL(request.url).origin) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  if (!pode(u, 'notificacoes')) return json({ erro: 'Seu acesso não permite mudar as Notificações.' }, 403);
  let d;
  try { d = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const quem = u.nome || u.usuario;
  const id = Number(d.id);

  if (d.acao === 'excluir') {
    if (!Number.isInteger(id)) return json({ erro: 'Notificação inválida.' }, 400);
    await env.DB.prepare('DELETE FROM notificacoes WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  if (d.acao === 'ativar') {
    if (!Number.isInteger(id)) return json({ erro: 'Notificação inválida.' }, 400);
    await env.DB.prepare(`UPDATE notificacoes SET ativa = ?, atualizado_por = ?, atualizado_em = ${agora} WHERE id = ?`).bind(d.ativa ? 1 : 0, quem, id).run();
    return json({ ok: true });
  }
  if (d.acao !== 'salvar') return json({ erro: 'Ação desconhecida.' }, 400);
  const { erros, valor: v } = validar(d);
  if (erros.length) return json({ erro: erros.join(' ') }, 400);
  const campos = [v.nome, v.tipo, v.ativa, JSON.stringify(v.condicao), v.mensagem, v.nivel, JSON.stringify(v.destinatarios), v.repetir, v.celular, quem];
  let r;
  if (Number.isInteger(id) && id > 0) {
    r = await env.DB.prepare(`UPDATE notificacoes SET nome = ?, tipo = ?, ativa = ?, condicao = ?, mensagem = ?, nivel = ?, destinatarios = ?, repetir = ?,
      celular = ?, atualizado_por = ?, atualizado_em = ${agora} WHERE id = ? RETURNING *`).bind(...campos, id).first();
    if (!r) return json({ erro: 'Essa notificação não existe mais.' }, 404);
  } else {
    r = await env.DB.prepare(`INSERT INTO notificacoes (nome, tipo, ativa, condicao, mensagem, nivel, destinatarios, repetir, celular, criado_por, atualizado_por)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).bind(...campos, quem).first();
  }
  return json({ ok: true, regra: regra(r) });
}
