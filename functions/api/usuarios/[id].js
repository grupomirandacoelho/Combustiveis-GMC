import { gerarHashSenha, senhaProvisoria, limparFalhas, json } from '../../../lib/auth.js';
import { exigirAdmin, validarCampos, adminsAtivos, publico, buscarFuncao, CAMPOS_USUARIO, DE_USUARIOS } from '../../../lib/usuarios.js';

async function alvo(env, params) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) return null;
  return env.DB.prepare(`SELECT ${CAMPOS_USUARIO} ${DE_USUARIOS} WHERE u.id = ? AND u.excluido = 0`).bind(id).first();
}

// PUT /api/usuarios/:id  {nome, papel, permissoes, ativo}  ou  {redefinirSenha: true}
export async function onRequestPut({ request, env, params }) {
  const { u, erro } = await exigirAdmin(request, env, true);
  if (erro) return erro;
  const a = await alvo(env, params);
  if (!a) return json({ erro: 'Login não encontrado.' }, 404);
  let corpo;
  try { corpo = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }

  if (corpo.redefinirSenha) {
    const senha = senhaProvisoria();
    await env.DB.batch([
      env.DB.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 1 WHERE id = ?').bind(await gerarHashSenha(senha), a.id),
      env.DB.prepare('DELETE FROM sessoes WHERE usuario_id = ?').bind(a.id),   // desconecta os aparelhos dele
    ]);
    await limparFalhas(env.DB, a.usuario);
    return json({ ok: true, senha, usuario: publico({ ...a, trocar_senha: 1 }) });
  }

  const { dados, erros } = validarCampos(corpo, false);
  if (erros.length) return json({ erro: erros.join(' ') }, 400);
  const papel = dados.papel ?? a.papel;
  const ativo = dados.ativo ?? a.ativo;
  if (a.id === u.id && (papel !== 'admin' || ativo !== 1)) {
    return json({ erro: 'Você não pode tirar o seu próprio acesso de administrador nem desativar o seu login.' }, 400);
  }
  if (a.papel === 'admin' && a.ativo === 1 && (papel !== 'admin' || ativo !== 1) && !(await adminsAtivos(env.DB, a.id))) {
    return json({ erro: 'Precisa sobrar pelo menos um administrador ativo.' }, 400);
  }
  const nome = dados.nome ?? a.nome;
  const permissoes = dados.permissoes ? JSON.stringify(dados.permissoes) : a.permissoes;
  // função: administrador nunca tem; sem o campo no pedido, mantém a atual
  const funcao = papel === 'admin' ? null : (dados.funcao_id !== undefined ? dados.funcao_id : a.funcao_id);
  if (funcao && !(await buscarFuncao(env.DB, funcao))) return json({ erro: 'Essa função não existe mais. Recarregue a página.' }, 400);
  // bases da bomba interna: sem o campo no pedido, mantém as atuais
  const bases = dados.bomba_bases === undefined ? a.bomba_bases : dados.bomba_bases === null ? null : JSON.stringify(dados.bomba_bases);
  // unidades (avisos separados por unidade): sem o campo no pedido, mantém as atuais
  const unidades = dados.unidades === undefined ? a.unidades : dados.unidades === null ? null : JSON.stringify(dados.unidades);
  const ops = [env.DB.prepare('UPDATE usuarios SET nome = ?, papel = ?, permissoes = ?, funcao_id = ?, ativo = ?, bomba_bases = ?, unidades = ? WHERE id = ?')
    .bind(nome, papel, permissoes, funcao, ativo, bases, unidades, a.id)];
  if (!ativo) ops.push(env.DB.prepare('DELETE FROM sessoes WHERE usuario_id = ?').bind(a.id));
  await env.DB.batch(ops);
  const r = await env.DB.prepare(`SELECT ${CAMPOS_USUARIO} ${DE_USUARIOS} WHERE u.id = ?`).bind(a.id).first();
  return json({ ok: true, usuario: publico(r) });
}

// DELETE /api/usuarios/:id — o login sai da lista e não entra mais; o registro fica para o histórico de alterações
export async function onRequestDelete({ request, env, params }) {
  const { u, erro } = await exigirAdmin(request, env, true);
  if (erro) return erro;
  const a = await alvo(env, params);
  if (!a) return json({ erro: 'Login não encontrado.' }, 404);
  if (a.id === u.id) return json({ erro: 'Você não pode excluir o seu próprio login.' }, 400);
  if (a.papel === 'admin' && a.ativo === 1 && !(await adminsAtivos(env.DB, a.id))) {
    return json({ erro: 'Precisa sobrar pelo menos um administrador ativo.' }, 400);
  }
  // o nome de login fica livre para ser usado de novo; a senha vira uma que ninguém conhece
  await env.DB.batch([
    env.DB.prepare('UPDATE usuarios SET excluido = 1, ativo = 0, usuario = ?, senha_hash = ? WHERE id = ?')
      .bind(a.usuario + '#excluido-' + a.id, await gerarHashSenha(senhaProvisoria(32)), a.id),
    env.DB.prepare('DELETE FROM sessoes WHERE usuario_id = ?').bind(a.id),
  ]);
  return json({ ok: true });
}
