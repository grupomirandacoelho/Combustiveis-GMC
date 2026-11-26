import { gerarHashSenha, senhaProvisoria, json } from '../../../lib/auth.js';
import { exigirAdmin, validarCampos, publico, buscarFuncao, CAMPOS_USUARIO, DE_USUARIOS, CATALOGO } from '../../../lib/usuarios.js';
import { limparPermissoes } from '../../../lib/permissoes.js';

// GET /api/usuarios: todos os logins (menos os excluídos), o catálogo de permissões e as funções (perfis de acesso)
export async function onRequestGet({ request, env }) {
  const { u, erro } = await exigirAdmin(request, env, false);
  if (erro) return erro;
  const [usuarios, funcoes, bases] = await Promise.all([
    env.DB.prepare(`SELECT ${CAMPOS_USUARIO} ${DE_USUARIOS} WHERE u.excluido = 0 ORDER BY u.ativo DESC, u.nome COLLATE NOCASE`).all(),
    env.DB.prepare(`SELECT f.id, f.nome, f.descricao, f.permissoes, f.atualizado_em,
        (SELECT COUNT(*) FROM usuarios u WHERE u.funcao_id = f.id AND u.excluido = 0 AND u.papel <> 'admin') AS logins
       FROM funcoes f ORDER BY f.nome COLLATE NOCASE`).all(),
    env.DB.prepare('SELECT id, nome, ativo FROM bomba_bases ORDER BY nome').all(),   // para liberar base por base
  ]);
  return json({
    usuarios: usuarios.results.map(publico), catalogo: CATALOGO, eu: u.id, bombaBases: bases.results,
    funcoes: funcoes.results.map((f) => ({ ...f, permissoes: limparPermissoes(JSON.parse(f.permissoes || '[]')) })),
  });
}

// POST /api/usuarios: cria um login com senha provisória (a pessoa troca no primeiro acesso)
export async function onRequestPost({ request, env }) {
  const { erro } = await exigirAdmin(request, env, true);
  if (erro) return erro;
  let corpo;
  try { corpo = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const { dados, erros } = validarCampos(corpo, true);
  if (erros.length) return json({ erro: erros.join(' ') }, 400);
  if (dados.funcao_id && !(await buscarFuncao(env.DB, dados.funcao_id))) return json({ erro: 'Essa função não existe mais. Recarregue a página.' }, 400);
  const existe = await env.DB.prepare('SELECT id FROM usuarios WHERE usuario = ?').bind(dados.usuario).first();
  if (existe) return json({ erro: 'Já existe um login "' + dados.usuario + '". Escolha outro.' }, 409);
  const senha = senhaProvisoria();
  const { id } = await env.DB.prepare(
    'INSERT INTO usuarios (usuario, nome, senha_hash, papel, permissoes, funcao_id, bomba_bases, unidades, trocar_senha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) RETURNING id')
    .bind(dados.usuario, dados.nome, await gerarHashSenha(senha), dados.papel, JSON.stringify(dados.permissoes), dados.funcao_id,
      Array.isArray(dados.bomba_bases) ? JSON.stringify(dados.bomba_bases) : null, Array.isArray(dados.unidades) ? JSON.stringify(dados.unidades) : null).first();
  const r = await env.DB.prepare(`SELECT ${CAMPOS_USUARIO} ${DE_USUARIOS} WHERE u.id = ?`).bind(id).first();
  return json({ ok: true, usuario: publico(r), senha }, 201);
}
