import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode } from '../../../lib/permissoes.js';
import { TANQUES, texto, numero, quandoValido, basesDoUsuario, veBase } from '../../../lib/bomba.js';
import { aplicarDepois } from '../../../lib/aplicar-banco.js';

// Bomba interna > Inclusão de abastecimento: abastecimentos das bombas internas lançados pelo site.
// GET  /api/bomba/abastecimentos   {abastecimentos (últimos 90 dias, com a situação da gravação na Base_copia), pode}
// POST /api/bomba/abastecimentos   {base_id, tanque, quando, placa, km, litros, motorista, preco, linha}
//   linha = [fonte 'MANUAL', ...48 colunas da Base] montada na página com o mesmo motor do Consolidador (veículo, matrícula,
//   posto e KM rodado herdados do histórico). Vira um lote do consolidador (o vigia grava na Base_copia) e fica em
//   bomba_abastecimentos para sair do estoque na hora.
// POST /api/bomba/abastecimentos   {id, acao: 'editar', base_id, tanque, quando, placa, km, litros, motorista, preco, linha,
//                                   linha_planilha?, vizinhos?}
//                                  {id, acao: 'excluir', linha_planilha?, vizinhos?}
//   Só depois que o lote foi gravado na Base_copia (antes disso a linha da planilha ainda não existe). A correção vai para
//   a fila do "Editar abastecimentos" (alteracoes_base_copia; o vigia acha a linha pela placa + data): editar = as
//   colunas que mudaram na linha; excluir = a linha sai da planilha. vizinhos = até 2 abastecimentos seguintes da mesma
//   placa e combustível na Base_copia cujo KM rodado / km por litro (R, S) muda com a correção: [{linha, placa, data,
//   celulas: {R, S}, antes}]. Lote que deu erro (nunca gravado): excluir só tira do site; editar não é aceito.
const PLACA = /^[A-Z]{3}\d[A-Z0-9]\d{2}$/;
// índices na linha (0 = fonte; depois as colunas da aba Transações)
const L = { forma: 2, data: 5, placa: 6, motorista: 12, combustivel: 14, litros: 15, preco: 16, hodo: 17, posto: 22 };
const letra = (i) => (i < 26 ? '' : String.fromCharCode(64 + Math.floor(i / 26))) + String.fromCharCode(65 + (i % 26));   // 0 -> A, 47 -> AV
// 'AAAA-MM-DDTHH:MM' -> número de série do Excel (como a DATA TRANSACAO da linha)
const serialDe = (q) => { const [a, m, d, h, mi] = q.match(/\d+/g).map(Number); return Date.UTC(a, m - 1, d, h, mi) / 86400000 + 25569; };
const CAMPOS = `a.id, a.base_id, a.tanque, a.quando, a.placa, a.km, a.litros, a.motorista, a.preco, a.lote_id, a.criado_em, a.usuario_nome,
  a.excluido, a.editado_em, a.editado_por, a.alteracao_id, l.estado, l.mensagem, l.aplicada_em, l.linha_inicial,
  x.acao AS alt_acao, x.estado AS alt_estado, x.mensagem AS alt_mensagem`;
const DE = `FROM bomba_abastecimentos a LEFT JOIN consolidador_lotes l ON l.id = a.lote_id LEFT JOIN alteracoes_base_copia x ON x.id = a.alteracao_id`;

// campos do lançamento (novo ou editado) e a linha da Base montada na página
async function validarLancamento(env, u, d) {
  const base = veBase(basesDoUsuario(u), d.base_id)
    ? await env.DB.prepare('SELECT id, posto, tanques FROM bomba_bases WHERE id = ? AND ativo = 1').bind(Number(d.base_id)).first() : null;
  const placa = texto(d.placa, 10).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const km = numero(d.km), litros = numero(d.litros), preco = numero(d.preco);
  const motorista = texto(d.motorista, 80).toUpperCase() || null;
  const erros = [];
  if (!base) erros.push('Escolha a unidade.');
  if (!TANQUES.includes(d.tanque)) erros.push('Escolha o combustível.');
  else if (base && !JSON.parse(base.tanques)[d.tanque]) erros.push('Esta unidade não tem tanque de ' + (d.tanque === 'arla' ? 'Arla' : 'diesel') + '.');
  if (!quandoValido(d.quando)) erros.push('Data e hora inválidas.');
  if (!PLACA.test(placa)) erros.push('Placa inválida (ex.: TLB2I85 ou ABC1234).');
  if (!(Number.isInteger(km) && km > 0 && km < 10_000_000)) erros.push('Informe o KM (hodômetro), só números.');
  if (!(litros > 0 && litros <= 5000)) erros.push('Informe a litragem.');
  if (preco !== null && !(preco > 0 && preco < 50)) erros.push('Preço por litro inválido.');
  const linha = d.linha;
  if (!Array.isArray(linha) || linha.length !== 49 || linha[0] !== 'MANUAL' || linha.slice(1).some((v) => v !== null && !['string', 'number'].includes(typeof v))) {
    erros.push('Linha da Base fora do formato. Recarregue a página e tente de novo.');
  } else if (base && !erros.length && (linha[L.placa] !== placa || linha[L.hodo] !== km || Math.abs(Number(linha[L.litros]) - litros) > 0.001 ||
      String(linha[L.posto] || '').toUpperCase() !== base.posto || linha[L.forma] !== 'BOMBA INTERNA' || typeof linha[L.data] !== 'number' ||
      Math.abs(linha[L.data] - serialDe(d.quando)) > 0.0001)) {
    erros.push('A linha da Base não confere com o abastecimento. Recarregue a página e tente de novo.');
  }
  return { erros, base, placa, km, litros, preco, motorista, linha };
}

// abastecimento seguinte (da mesma placa e combustível) cujo km rodado muda com a correção
function vizinhoValido(v) {
  if (!v || !Number.isInteger(v.linha) || v.linha < 2 || typeof v.placa !== 'string' || !PLACA.test(v.placa) ||
      typeof v.data !== 'number' || !Number.isFinite(v.data) || !v.celulas || typeof v.celulas !== 'object') return false;
  const cols = Object.keys(v.celulas);
  return cols.length > 0 && cols.every((c) => ['R', 'S'].includes(c) && (v.celulas[c] === null ||
    (typeof v.celulas[c] === 'number' && Number.isFinite(v.celulas[c]) && Math.abs(v.celulas[c]) < 1e9)));
}
const alteracao = (env, u, it) => env.DB.prepare(
  'INSERT INTO alteracoes_base_copia (usuario_id, usuario_nome, linha, placa, data, acao, celulas, antes) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
  .bind(u.id, u.nome, it.linha, it.placa, it.data, it.acao, JSON.stringify(it.celulas), JSON.stringify(it.antes || {}));
const ler = (env, id) => env.DB.prepare(`SELECT ${CAMPOS} ${DE} WHERE a.id = ?`).bind(id).first();

// lançados pelo site nos últimos 90 dias (as bases que o login vê; null = todas). Também usada pelo envio ao celular.
export async function recentes(db, permitidas) {
  const { results } = await db.prepare(
    `SELECT ${CAMPOS} ${DE} WHERE a.criado_em >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-90 days') ORDER BY a.id DESC LIMIT 500`).all();
  return results.filter((a) => veBase(permitidas, a.base_id));
}

export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  if (!pode(u, 'bomba-abastecimento', 'bomba-estoque')) return json({ erro: 'Seu acesso não inclui as bombas internas.' }, 403);
  const permitidas = basesDoUsuario(u);   // só as bases liberadas para o login (Gerenciar acessos)
  return json({ abastecimentos: await recentes(env.DB, permitidas), pode: pode(u, 'bomba-abastecimento') });
}

export async function onRequestPost({ request, env, waitUntil }) {
  const origem = request.headers.get('Origin');
  if (origem && origem !== new URL(request.url).origin) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  if (!pode(u, 'bomba-abastecimento')) return json({ erro: 'Seu acesso não inclui o lançamento de abastecimentos.' }, 403);
  let d;
  try { d = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  if (d.id) {
    const resp = await corrigir(env, u, d);
    if (resp.ok) aplicarDepois({ env, waitUntil });   // aplica também direto no banco (15.2 passo 3)
    return resp;
  }
  const v = await validarLancamento(env, u, d);
  if (v.erros.length) return json({ erro: v.erros.join(' ') }, 400);
  const { base, placa, km, litros, preco, motorista, linha } = v;
  const resumo = { origem: 'bomba-interna', placa, km, litros, tanque: d.tanque, posto: base.posto, quando: d.quando };
  const chaves = [[[placa, km, linha[L.combustivel]].join('§'), linha[L.data]]];
  const lote = await env.DB.prepare(
    'INSERT INTO consolidador_lotes (usuario_id, usuario_nome, resumo, linhas, chaves) VALUES (?, ?, ?, ?, ?) RETURNING id, estado')
    .bind(u.id, u.nome, JSON.stringify(resumo), JSON.stringify([linha]), JSON.stringify(chaves)).first();
  const a = await env.DB.prepare(
    `INSERT INTO bomba_abastecimentos (base_id, tanque, quando, placa, km, litros, motorista, preco, lote_id, usuario_nome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(base.id, d.tanque, d.quando, placa, km, litros, motorista, preco, lote.id, u.nome).first();
  aplicarDepois({ env, waitUntil });
  return json({ ok: true, abastecimento: await ler(env, a.id) }, 201);
}

// editar ou excluir um lançado pelo site
async function corrigir(env, u, d) {
  const atual = await env.DB.prepare(`SELECT ${CAMPOS}, a.linha AS linha_atual, l.linhas AS lote_linhas ${DE} WHERE a.id = ?`).bind(Number(d.id)).first();
  if (!atual || atual.excluido || !veBase(basesDoUsuario(u), atual.base_id)) return json({ erro: 'Abastecimento não encontrado.' }, 404);
  if (d.acao !== 'editar' && d.acao !== 'excluir') return json({ erro: 'Ação inválida.' }, 400);
  if (atual.alt_estado === 'pendente' || atual.alt_estado === 'aguardando') {
    return json({ erro: 'A correção anterior deste abastecimento ainda não foi gravada na Base_copia. Aguarde e tente de novo.' }, 409);
  }
  const agora = new Date().toISOString().slice(0, 19) + 'Z';
  // lote que deu erro: a linha nunca entrou na planilha
  if (atual.estado === 'erro') {
    if (d.acao === 'editar') return json({ erro: 'Este abastecimento não foi gravado na Base_copia. Exclua e lance de novo.' }, 400);
    await env.DB.prepare('UPDATE bomba_abastecimentos SET excluido = 1, editado_em = ?, editado_por = ? WHERE id = ?').bind(agora, u.nome, atual.id).run();
    return json({ ok: true, abastecimento: await ler(env, atual.id) });
  }
  if (atual.estado !== 'aplicada') {
    return json({ erro: atual.estado === 'aguardando'
      ? 'Este abastecimento ainda não foi gravado: a Base_copia está aberta no Excel. Depois que ela for fechada e o abastecimento gravado, dá para editar ou excluir.'
      : 'Este abastecimento ainda está sendo gravado na Base_copia. Aguarde alguns segundos e tente de novo.' }, 409);
  }
  const vizinhos = Array.isArray(d.vizinhos) ? d.vizinhos : [];
  if (vizinhos.length > 2 || !vizinhos.every(vizinhoValido)) return json({ erro: 'Dados do abastecimento seguinte fora do formato. Recarregue a página.' }, 400);
  // linha na planilha: a que a página achou na lista da Base_copia (se mudou de lugar) ou a da gravação; o vigia confere pela placa + data
  const linhaPlan = Number.isInteger(d.linha_planilha) && d.linha_planilha >= 2 ? d.linha_planilha : atual.linha_inicial;
  if (!Number.isInteger(linhaPlan) || linhaPlan < 2) return json({ erro: 'Não sei em que linha da Base_copia está este abastecimento. Recarregue a página.' }, 409);
  const chave = { linha: linhaPlan, placa: atual.placa, data: serialDe(atual.quando) };
  const ops = [];
  let novo = null, principal = false;
  if (d.acao === 'excluir') {
    ops.push(alteracao(env, u, { ...chave, acao: 'excluir', celulas: {}, antes: {} }));
    principal = true;
  } else {
    novo = await validarLancamento(env, u, d);
    if (novo.erros.length) return json({ erro: novo.erros.join(' ') }, 400);
    const antiga = atual.linha_atual ? JSON.parse(atual.linha_atual) : (JSON.parse(atual.lote_linhas || '[]')[0] || null);
    if (!antiga) return json({ erro: 'Linha original do abastecimento não encontrada.' }, 409);
    // só as colunas que mudaram (1..48 da linha = A..AV da planilha)
    const celulas = {}, antes = {};
    for (let i = 1; i <= 48; i++) {
      const a = antiga[i] ?? null, b = novo.linha[i] ?? null;
      const igual = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b;
      if (!igual) { celulas[letra(i - 1)] = b; antes[letra(i - 1)] = a; }
    }
    if (!Object.keys(celulas).length && !vizinhos.length) return json({ ok: true, semMudanca: true, abastecimento: await ler(env, atual.id) });
    if (Object.keys(celulas).length) { ops.push(alteracao(env, u, { ...chave, acao: 'editar', celulas, antes })); principal = true; }
  }
  for (const viz of vizinhos) ops.push(alteracao(env, u, { linha: viz.linha, placa: viz.placa, data: viz.data, acao: 'editar', celulas: viz.celulas, antes: viz.antes }));
  const res = await env.DB.batch(ops);
  const altId = principal ? res[0].results[0].id : atual.alteracao_id;
  if (d.acao === 'excluir') {
    await env.DB.prepare('UPDATE bomba_abastecimentos SET excluido = 1, alteracao_id = ?, editado_em = ?, editado_por = ? WHERE id = ?')
      .bind(altId, agora, u.nome, atual.id).run();
  } else {
    await env.DB.prepare(`UPDATE bomba_abastecimentos SET base_id = ?, tanque = ?, quando = ?, placa = ?, km = ?, litros = ?, motorista = ?, preco = ?,
        linha = ?, alteracao_id = ?, editado_em = ?, editado_por = ? WHERE id = ?`)
      .bind(novo.base.id, d.tanque, d.quando, novo.placa, novo.km, novo.litros, novo.motorista, novo.preco, JSON.stringify(novo.linha), altId, agora, u.nome, atual.id).run();
  }
  return json({ ok: true, abastecimento: await ler(env, atual.id) });
}
