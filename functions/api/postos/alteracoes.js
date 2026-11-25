import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode } from '../../../lib/permissoes.js';
import { lerPostos } from '../../../lib/postos-fonte.js';
import { aplicarCadastrosDepois } from '../../../lib/aplicar-cadastros.js';

// Opções oficiais: as mesmas listas de validação da planilha "Gestão de negociações de preço"
export const UNIDADES = ['BELEM', 'CONQUISTA', 'GOIANIA', 'GOVERNADOR VALADARES', 'ILHEUS', 'JEQUIE', 'MARANHAO',
  'RECIFE', 'SALVADOR', 'SAO PAULO', 'SERRA', 'TEIXEIRA'];
export const TIPOS = ['', 'POLO', 'MINIMO'];
export const PLATAFORMAS = ['TICKETLOG', 'TRUCKPAG', 'VELOE', 'IDENTIFICAÇÃO'];
export const STATUS = ['POSTO AUTORIZADO', 'POSTO BLOQUEADO', 'EM NEGOCIAÇÃO'];
const ACOES = ['adicionar', 'editar', 'bloquear', 'autorizar'];

export const texto = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, max);
const numero = (v) => (v === '' || v === null || v === undefined ? null : Number(String(v).replace(',', '.')));

export function validar(acao, d) {
  const erros = [];
  const dados = {
    unidade: texto(d.unidade, 40),
    posto: texto(d.posto, 120),
    cidade: texto(d.cidade, 80),
    tipo: texto(d.tipo, 20),
    plataforma: texto(d.plataforma, 20),
    valor: numero(d.valor),
    combustivel: texto(d.combustivel || 'DIESEL S-10 COMUM', 40),
    status: texto(d.status, 30),
    aviso: texto(d.aviso, 200),
    contato: texto(d.contato, 100),
    latitude: numero(d.latitude),
    longitude: numero(d.longitude),
  };
  // rodada de preços: transação que deu o preço (coluna K) e variação contra a negociação anterior (coluna Q)
  if (d.transacao !== undefined && d.transacao !== null && d.transacao !== '') {
    dados.transacao = String(d.transacao).slice(0, 19);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(dados.transacao)) erros.push('Data da transação inválida.');
  }
  if (d.variacao !== undefined && d.variacao !== null && d.variacao !== '') {
    dados.variacao = numero(d.variacao);
    if (!(dados.variacao > -1 && dados.variacao < 10)) erros.push('Variação inválida.');
  }
  if (d.rodada) dados.rodada = true;
  // edição com a unidade trocada (posto cadastrado na unidade errada): o vigia passa as linhas dele para a unidade nova
  if (d.unidade_anterior !== undefined && d.unidade_anterior !== null && d.unidade_anterior !== '') {
    dados.unidade_anterior = texto(d.unidade_anterior, 40);
    if (acao !== 'editar' || !UNIDADES.includes(dados.unidade_anterior) || dados.unidade_anterior === dados.unidade) erros.push('Troca de unidade inválida.');
  }
  // edição com o nome trocado (o nome no portal do cartão é outro): o vigia renomeia as linhas dele na planilha
  if (d.posto_anterior !== undefined && d.posto_anterior !== null && d.posto_anterior !== '') {
    dados.posto_anterior = texto(d.posto_anterior, 120);
    if (acao !== 'editar' || !dados.posto_anterior || dados.posto_anterior === dados.posto) erros.push('Troca de nome inválida.');
  }
  if (!ACOES.includes(acao)) erros.push('Ação desconhecida.');
  if (!UNIDADES.includes(dados.unidade)) erros.push('Escolha a unidade.');
  if (!dados.posto) erros.push('Informe o nome do posto.');
  if (!dados.cidade) erros.push('Informe a cidade (ex.: MARABA - PA).');
  if (!TIPOS.includes(dados.tipo)) erros.push('Tipo deve ser POLO, MINIMO ou vazio.');
  if (!PLATAFORMAS.includes(dados.plataforma)) erros.push('Escolha o cartão (plataforma).');
  if (!STATUS.includes(dados.status)) erros.push('Escolha a situação do posto.');
  if (dados.valor !== null && !(dados.valor > 0 && dados.valor < 50)) erros.push('Valor negociado inválido (use R$ por litro, ex.: 6,29).');
  if (dados.latitude !== null && !(dados.latitude > -35 && dados.latitude < 6)) erros.push('Latitude fora do Brasil.');
  if (dados.longitude !== null && !(dados.longitude > -75 && dados.longitude < -30)) erros.push('Longitude fora do Brasil.');
  if ((dados.latitude === null) !== (dados.longitude === null)) erros.push('Informe latitude e longitude juntas.');
  return { dados, erros };
}

export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  if (!pode(u, 'postos-motoristas', 'rodada-precos')) return json({ erro: 'Seu acesso não inclui os postos dos motoristas.' }, 403);
  const { results } = await env.DB.prepare(
    `SELECT id, criado_em, usuario_nome, acao, dados, estado, mensagem, aplicada_em, linha
       FROM alteracoes_postos ORDER BY id DESC LIMIT 60`).all();
  const lista = await lerPostos(env);   // planilha (KV) ou banco ("postos-fonte", 15.3)
  const info = lista ? lista.info : null;
  return json({
    alteracoes: results.map((r) => ({ ...r, dados: JSON.parse(r.dados) })),
    opcoes: { unidades: UNIDADES, tipos: TIPOS, plataformas: PLATAFORMAS, status: STATUS },
    lista: info,
  });
}

export async function onRequestPost({ request, env, waitUntil }) {
  const origem = request.headers.get('Origin');
  if (origem && origem !== new URL(request.url).origin) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  if (!pode(u, 'postos-editar')) return json({ erro: 'Seu acesso não permite alterar postos.' }, 403);
  let corpo;
  try { corpo = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const acao = String(corpo.acao || '');
  const { dados, erros } = validar(acao, corpo.dados || {});
  if (erros.length) return json({ erro: erros.join(' ') }, 400);
  if (!dados.contato) dados.contato = texto(u.nome, 45) + ' (PORTAL)';
  const r = await env.DB.prepare(
    'INSERT INTO alteracoes_postos (usuario_id, usuario_nome, acao, dados) VALUES (?, ?, ?, ?) RETURNING id, criado_em, estado')
    .bind(u.id, u.nome, acao, JSON.stringify(dados)).first();
  aplicarCadastrosDepois({ env, waitUntil }, 'postos');   // aplica também direto no banco (15.3 item 4, 25/11/2026)
  return json({ ok: true, alteracao: { ...r, acao, dados, usuario_nome: u.nome } }, 201);
}
