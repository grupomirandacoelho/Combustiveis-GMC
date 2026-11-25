import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode } from '../../../lib/permissoes.js';
import { CARTOES, IDS, SITUACOES, CATEGORIAS_COM_CARTAO, normPlaca, placaValida, validar } from '../../../lib/cartoes.js';
import { lerCadastros } from '../../../lib/cadastros-fonte.js';

// GET  /api/cartoes   lista da planilha publicada pelo vigia + alterações do portal + avisos dos motoristas
// POST /api/cartoes   {acao: 'editar'|'adicionar', chave, dados: {ticket, truckpag, veloe}} -> pendente até o vigia gravar

async function lista(env) {
  const c = await env.DADOS.get('cartoes', 'json');
  return { itens: c && Array.isArray(c.cartoes) ? c.cartoes : null, atualizadoEm: c ? c.atualizadoEm : null };
}

export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  if (!pode(u, 'cartoes-frota')) return json({ erro: 'Seu acesso não inclui o controle dos cartões.' }, 403);
  const [{ itens, atualizadoEm }, cad, alt, alertas] = await Promise.all([
    lista(env),
    lerCadastros(env),
    env.DB.prepare(`SELECT id, criado_em, usuario_nome, acao, chave, dados, antes, estado, mensagem, aplicada_em, linha
                      FROM alteracoes_cartoes ORDER BY id DESC LIMIT 80`).all(),
    // em aberto (todos) e os resolvidos dos últimos 30 dias
    env.DB.prepare(`SELECT id, criado_em, placa, cartoes, motorista, telefone, observacao, estado, resolvido_em, resolvido_por, nota
                      FROM alertas_cartoes WHERE estado = 'aberto' OR resolvido_em >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 days')
                     ORDER BY id DESC LIMIT 200`).all(),
  ]);
  // unidade e situação de cada placa vêm do cadastro de placas (planilha de controle)
  const placas = cad && Array.isArray(cad.placas)
    ? cad.placas.map((p) => ({ placa: normPlaca(p.placa), unidade: p.unidade || null, situacao: p.situacao || 'ATIVA', categoria: p.categoria || null }))
    : [];
  return json({
    cartoes: CARTOES, situacoes: SITUACOES, categoriasComCartao: CATEGORIAS_COM_CARTAO, lista: itens, atualizadoEm, placas,
    podeEditar: pode(u, 'cartoes-frota-editar'),
    alteracoes: alt.results.map((r) => ({ ...r, dados: JSON.parse(r.dados), antes: r.antes ? JSON.parse(r.antes) : {} })),
    alertas: alertas.results.map((r) => ({ ...r, cartoes: JSON.parse(r.cartoes) })),
  });
}

export async function onRequestPost({ request, env }) {
  const origem = request.headers.get('Origin');
  if (origem && origem !== new URL(request.url).origin) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  if (!pode(u, 'cartoes-frota-editar')) return json({ erro: 'Seu acesso ao controle dos cartões é só de consulta.' }, 403);
  let corpo;
  try { corpo = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const acao = String(corpo.acao || '');
  if (!['editar', 'adicionar'].includes(acao)) return json({ erro: 'Ação desconhecida.' }, 400);
  const { itens, atualizadoEm } = await lista(env);
  if (!itens) return json({ erro: 'A lista ainda não foi publicada pelo computador da sincronização. Tente mais tarde.' }, 409);

  const { dados, erros } = validar(corpo.dados && typeof corpo.dados === 'object' ? corpo.dados : {});
  if (erros.length) return json({ erro: erros.join(' ') }, 400);
  const placa = normPlaca(corpo.chave);
  if (!placaValida(placa)) return json({ erro: 'Placa inválida (ex.: ABC1D23 ou ABC1234).' }, 400);
  const atual = itens.find((r) => normPlaca(r.placa) === placa);
  // a mesma placa adicionada pelo portal e ainda não publicada na lista conta como existente
  const desde = atualizadoEm ? String(atualizadoEm).slice(0, 19) + 'Z' : '';
  const novaPendente = await env.DB.prepare(
    `SELECT id FROM alteracoes_cartoes WHERE acao = 'adicionar' AND chave = ? AND (estado IN ('pendente', 'aguardando')
       OR (estado = 'aplicada' AND aplicada_em >= ?)) LIMIT 1`).bind(placa, desde).first();

  const antes = {};
  if (acao === 'editar') {
    if (!atual && !novaPendente) return json({ erro: 'Não encontrei a placa ' + placa + ' na lista. Recarregue a página.' }, 404);
    if (atual) {
      for (const id of IDS) {
        if (!(id in dados)) continue;
        if ((atual[id] || null) === dados[id]) delete dados[id];   // não mudou: não grava
        else antes[id] = atual[id] || null;
      }
      if (!Object.keys(dados).length) return json({ erro: 'Nada foi alterado.' }, 400);
    }
  } else if (atual || novaPendente) {
    return json({ erro: 'A placa ' + placa + ' já está no controle dos cartões' + (atual ? '.' : ' (aguardando gravação).') }, 409);
  } else {
    // o controle segue o cadastro de placas: placa cadastrada entra (ou não) sozinha; à mão, só caminhão ainda sem cadastro
    const cad = await lerCadastros(env);
    const merc = (v) => { const p = normPlaca(v); return /^[A-Z]{3}\d{4}$/.test(p) ? p.slice(0, 4) + 'ABCDEFGHIJ'[Number(p[4])] + p.slice(5) : p; };
    const p = cad && Array.isArray(cad.placas) ? cad.placas.find((x) => merc(x.placa) === merc(placa)) : null;
    if (p) {
      const ativa = !['DESABILITADA', 'VENDIDO'].includes(p.situacao || 'ATIVA'), comMotor = CATEGORIAS_COM_CARTAO.includes(String(p.categoria || '').toUpperCase());
      return json({ erro: ativa && comMotor
        ? 'A placa ' + placa + ' já está no cadastro de placas e entra sozinha no controle dos cartões em instantes.'
        : 'A placa ' + placa + ' está no cadastro como ' + (ativa ? (p.categoria || 'sem categoria') : 'desabilitada') +
          '. Só placas ativas de cavalo, truck, toco, bitruck, 3/4 e picape ficam no controle dos cartões.' }, 409);
    }
  }
  const r = await env.DB.prepare(
    `INSERT INTO alteracoes_cartoes (usuario_id, usuario_nome, acao, chave, dados, antes)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id, criado_em, estado`)
    .bind(u.id, u.nome, acao, placa, JSON.stringify(dados), JSON.stringify(antes)).first();
  return json({ ok: true, alteracao: { ...r, acao, chave: placa, dados, antes, usuario_nome: u.nome } }, 201);
}
