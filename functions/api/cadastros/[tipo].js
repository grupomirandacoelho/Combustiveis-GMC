import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode } from '../../../lib/permissoes.js';
import { CAMPOS, CHAVE, TIPOS, NOME, PESSOAIS, PESSOAIS_CARTOES, normalizarChave, validar, validarPessoais } from '../../../lib/cadastros.js';
import { chaveNome } from '../../../lib/motoristas.js';
import { rpc } from '../../../lib/supabase.js';
import { lerCadastros } from '../../../lib/cadastros-fonte.js';
import { aplicarCadastrosDepois } from '../../../lib/aplicar-cadastros.js';

// GET  /api/cadastros/placas|motoristas   lista publicada pelo vigia + alterações do portal
// POST /api/cadastros/placas|motoristas   {acao: 'editar'|'adicionar', chave, dados, pessoais?}  -> fica pendente até o vigia gravar
// POST /api/cadastros/motoristas            {acao: 'redefinir-senha', usuario}  -> a senha da área do motorista volta a ser o usuário
// Motoristas: CPF, nascimento e CNH ("pessoais") não vão para a planilha nem para a lista; só ficam na alteração até o
// vigia mandar à Ticket/TruckPag (functions/api/sync/cadastros/cartoes.js apaga). Nunca voltam no GET.
// Placas, desde 17/11/2026: a lista vem do banco (modelo `gestao`, lib/supabase.js) e cada alteração também é gravada nele na
// hora; a fila para a planilha continua (outros sistemas ainda leem a planilha). Banco fora do ar: lista publicada da planilha.
export async function lista(env, tipo) {
  if (tipo === 'placas') {
    const b = await rpc(env, 'gestao_placas');
    if (b && Array.isArray(b.placas) && b.placas.length) return { itens: b.placas, atualizadoEm: b.atualizadoEm, fonte: 'banco' };
  }
  const c = await lerCadastros(env);
  return { itens: c && Array.isArray(c[tipo]) ? c[tipo] : null, atualizadoEm: c ? c.atualizadoEm : null, fonte: c ? c.fonte : 'planilha' };
}

export async function onRequestGet({ request, env, params }) {
  const tipo = params.tipo;
  if (!TIPOS.includes(tipo)) return json({ erro: 'Cadastro desconhecido.' }, 404);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  if (!pode(u, 'cadastro-' + tipo)) return json({ erro: 'Seu acesso não inclui este cadastro.' }, 403);
  const { itens, atualizadoEm, fonte } = await lista(env, tipo);
  const { results } = await env.DB.prepare(
    `SELECT id, criado_em, usuario_nome, acao, chave, dados, antes, estado, mensagem, aplicada_em, linha
       FROM alteracoes_cadastros WHERE tipo = ? ORDER BY id DESC LIMIT 80`).bind(tipo).all();
  // sugestões dos campos de texto: os valores que já existem na planilha
  const sugestoes = {};
  for (const c of CAMPOS[tipo]) {
    if (!c.sugestoes) continue;
    const s = new Set(Array.isArray(c.sugestoes) ? c.sugestoes : []);
    (itens || []).forEach((r) => { if (r[c.id]) s.add(String(r[c.id])); });
    sugestoes[c.id] = [...s].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }
  // motoristas: quem já entrou na área do motorista, último acesso e se trocou a senha
  let acessos;
  if (tipo === 'motoristas') {
    const a = await env.DB.prepare('SELECT usuario, primeiro_acesso, ultimo_acesso, acessos, senha_hash IS NOT NULL AS senha_propria, redefinida_em FROM motoristas_acesso').all();
    acessos = Object.fromEntries(a.results.map((r) => [r.usuario, { primeiro: r.primeiro_acesso, ultimo: r.ultimo_acesso, vezes: r.acessos,
      senhaPropria: r.senha_propria === 1, redefinidaEm: r.redefinida_em }]));
  }
  return json({
    campos: CAMPOS[tipo], chave: CHAVE[tipo], lista: itens, atualizadoEm, fonte, sugestoes, ...(tipo === 'motoristas' ? { pessoais: PESSOAIS, acessos } : {}),
    podeEditar: pode(u, 'cadastro-' + tipo + '-editar'),
    alteracoes: results.map((r) => {
      // senhas dos cartões vão como estão (decisão do usuário em 10/11/2026: não são sensíveis; mascarar gerava erro nos cartões)
      return { ...r, dados: JSON.parse(r.dados), antes: r.antes ? JSON.parse(r.antes) : {} };
    }),
  });
}

export async function onRequestPost({ request, env, params, waitUntil }) {
  const tipo = params.tipo;
  if (!TIPOS.includes(tipo)) return json({ erro: 'Cadastro desconhecido.' }, 404);
  const origem = request.headers.get('Origin');
  if (origem && origem !== new URL(request.url).origin) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  if (!pode(u, 'cadastro-' + tipo + '-editar')) return json({ erro: 'Seu acesso a este cadastro é só de consulta.' }, 403);
  let corpo;
  try { corpo = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const acao = String(corpo.acao || '');
  if (tipo === 'motoristas' && acao === 'redefinir-senha') return redefinirSenha(env, u, corpo);
  if (!['editar', 'adicionar'].includes(acao)) return json({ erro: 'Ação desconhecida.' }, 400);
  const { itens, atualizadoEm } = await lista(env, tipo);
  if (!itens) return json({ erro: 'A lista ainda não foi publicada pelo computador da sincronização. Tente mais tarde.' }, 409);

  const { dados, erros } = validar(tipo, acao, corpo.dados && typeof corpo.dados === 'object' ? corpo.dados : {});
  if (erros.length) return json({ erro: erros.join(' ') }, 400);
  // motoristas: CPF e nascimento para os cartões. Cadastro novo: CPF sempre (dá o usuário); nascimento se for aos cartões.
  // Edição: os dois juntos ou nenhum (a TruckPag exige os dois em toda edição)
  const cartoes = tipo === 'motoristas' && acao === 'adicionar' && corpo.cartoes !== false;
  let pessoais = {};
  if (tipo === 'motoristas') {
    const v = validarPessoais(corpo.pessoais, acao === 'adicionar' ? (cartoes ? PESSOAIS_CARTOES : ['cpf']) : []);
    if (v.erros.length) return json({ erro: v.erros.join(' ') }, 400);
    pessoais = v.pessoais;
    if (acao === 'editar' && Object.keys(pessoais).length && !(pessoais.cpf && pessoais.dataNascimento)) {
      return json({ erro: 'Para repetir a alteração na TruckPag, informe CPF e data de nascimento (ou deixe os dois em branco).' }, 400);
    }
  }
  const k = CHAVE[tipo];
  const qual = tipo === 'placas' ? 'A placa ' : 'O usuário ';
  const achar = (v) => itens.find((r) => normalizarChave(tipo, r[k]) === normalizarChave(tipo, v));
  // também as já gravadas na planilha que a lista publicada ainda não traz (o vigia republica logo depois)
  const desde = atualizadoEm ? String(atualizadoEm).slice(0, 19) + 'Z' : '';
  const pendentes = (await env.DB.prepare(
    `SELECT acao, chave, dados FROM alteracoes_cadastros WHERE tipo = ? AND (estado IN ('pendente', 'aguardando')
       OR (estado = 'aplicada' AND aplicada_em >= ?))`).bind(tipo, desde).all()).results;
  const chavePendente = (v) => pendentes.some((p) => normalizarChave(tipo, p.chave) === normalizarChave(tipo, v) ||
    normalizarChave(tipo, JSON.parse(p.dados)[k] || '') === normalizarChave(tipo, v));

  let chave, aviso = null;
  const antes = {};
  if (acao === 'editar') {
    const atual = achar(corpo.chave);
    if (!atual) return json({ erro: 'Não encontrei ' + (tipo === 'placas' ? 'esta placa' : 'este motorista') + ' na lista. Recarregue a página.' }, 404);
    chave = atual[k];
    for (const [c, v] of Object.entries(dados)) {
      const velho = atual[c] ?? null;
      if (String(velho ?? '') === String(v ?? '')) delete dados[c];   // não mudou: não grava
      else antes[c] = velho;
    }
    if (!Object.keys(dados).length) return json({ erro: 'Nada foi alterado.' }, 400);
    if (k in dados) {
      const outro = achar(dados[k]);
      if ((outro && outro !== atual) || chavePendente(dados[k])) return json({ erro: qual + dados[k] + ' já está cadastrado.' }, 409);
    }
  } else {
    if (tipo === 'motoristas') {
      // usuário = 6 primeiros números do CPF; já sendo de outro motorista, sorteia um livre (e avisa)
      let usr = pessoais.cpf.slice(0, 6);
      const dono = achar(usr);
      if (dono || chavePendente(usr)) {
        if (dono && chaveNome(dono.nome) === chaveNome(dados.nome)) return json({ erro: (dados.nome || 'Este motorista') + ' já está cadastrado (usuário ' + usr + ').' }, 409);
        do { usr = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000)); } while (achar(usr) || chavePendente(usr));
        aviso = 'Os 6 primeiros números deste CPF já são o usuário de outro motorista: este ficou com o usuário ' + usr + ' (a senha inicial é o mesmo número).';
      }
      dados.usuario = usr;
    }
    chave = dados[k];
    if (achar(chave) || chavePendente(chave)) {
      return json({ erro: qual + chave + ' já está cadastrado' + (achar(chave) ? '.' : ' (alteração aguardando gravação).') }, 409);
    }
  }
  // unidade, categoria e marca têm de estar nos cadastros do portal (banco, esquema cadastro; 18/11/2026). Antes da fila da
  // planilha: o que não está cadastrado nem chega à planilha. Motorista: só a unidade.
  const validarNoCadastro = tipo === 'placas' ? dados : 'unidade' in dados ? { unidade: dados.unidade } : null;
  if (validarNoCadastro) {
    const invalido = await rpc(env, 'gestao_validar_placa', { p_dados: validarNoCadastro });
    if (typeof invalido === 'string' && invalido) return json({ erro: invalido }, 400);
  }
  // motorista novo com a caixa "cadastrar nos sites dos cartões frota" desmarcada: o vigia não cria na Ticket/TruckPag
  const semCartoes = tipo === 'motoristas' && acao === 'adicionar' && corpo.cartoes === false ? 1 : 0;
  // o que vai aos cartões: cadastro novo (se for criar lá) ou edição de nome/senha TruckPag com CPF e nascimento informados
  const guardar = tipo !== 'motoristas' ? null
    : acao === 'adicionar' ? (cartoes ? pessoais : null)
    : pessoais.cpf && ('nome' in dados || 'senhaTruckpag' in dados) ? { cpf: pessoais.cpf, dataNascimento: pessoais.dataNascimento } : null;
  const r = await env.DB.prepare(
    `INSERT INTO alteracoes_cadastros (usuario_id, usuario_nome, tipo, acao, chave, dados, antes, sem_cartoes, pessoais)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, criado_em, estado`)
    .bind(u.id, u.nome, tipo, acao, String(chave), JSON.stringify(dados), JSON.stringify(antes), semCartoes, guardar ? JSON.stringify(guardar) : null).first();
  // placas: grava também no banco na hora (a planilha continua recebendo pela fila). Falha no banco não desfaz a alteração:
  // a próxima carga do modelo (vigia) traz da planilha
  if (tipo === 'placas') await rpc(env, 'gestao_salvar_placa', { p_acao: acao, p_chave: String(chave), p_dados: dados });
  aplicarCadastrosDepois({ env, waitUntil });   // aplica também direto no banco (15.3, 25/11/2026)
  return json({ ok: true, aviso, alteracao: { ...r, acao, chave, dados, antes, usuario_nome: u.nome, tipo, nome: NOME[tipo] } }, 201);
}

// a senha da área do motorista volta a ser o próprio usuário (e as sessões abertas dele terminam)
async function redefinirSenha(env, u, corpo) {
  const usuario = String(corpo.usuario || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(usuario)) return json({ erro: 'Usuário inválido.' }, 400);
  const agora = new Date().toISOString().slice(0, 19) + 'Z';
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO motoristas_acesso (usuario, senha_hash, redefinida_por, redefinida_em) VALUES (?1, NULL, ?2, ?3)
      ON CONFLICT(usuario) DO UPDATE SET senha_hash = NULL, senha_trocada_em = NULL, redefinida_por = ?2, redefinida_em = ?3`).bind(usuario, u.nome, agora),
    env.DB.prepare('DELETE FROM sessoes_motoristas WHERE usuario = ?').bind(usuario),
  ]);
  return json({ ok: true, redefinidaEm: agora });
}
