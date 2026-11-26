// Regras da tela "Gerenciar acessos" (só administradores): validação dos campos e proteção do último administrador.
import { usuarioDaSessao, json } from './auth.js';
import { UNIDADES } from '../public/gestao/lib/unidades.js';

// unidades do login (coluna JSON) -> lista de códigos ([] = todas)
export function unidadesDe(r) {
  try { const l = JSON.parse((r && r.unidades) || '[]'); return Array.isArray(l) ? l.filter((x) => UNIDADES.includes(x)) : []; } catch { return []; }
}
import { CATALOGO, limparPermissoes, permissoesDe } from './permissoes.js';

export const PAPEIS = ['admin', 'gestor'];   // gestor = acesso personalizado

// administrador conectado, ou a resposta de erro pronta
export async function exigirAdmin(request, env, escrita) {
  if (escrita) {
    const origem = request.headers.get('Origin');
    if (origem && origem !== new URL(request.url).origin) return { erro: json({ erro: 'Origem não permitida.' }, 403) };
  }
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return { erro: json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401) };
  if (u.papel !== 'admin') return { erro: json({ erro: 'Só administradores gerenciam os acessos.' }, 403) };
  return { u };
}

export function validarCampos(d, novo) {
  const erros = [];
  const saida = {};
  if (novo) {
    saida.usuario = String(d.usuario || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,64}$/.test(saida.usuario)) erros.push('O usuário precisa ter de 3 a 64 caracteres: letras sem acento, números, ponto, hífen ou sublinhado (ex.: maria.silva).');
  }
  if (novo || d.nome !== undefined) {
    saida.nome = String(d.nome || '').replace(/\s+/g, ' ').trim();
    if (saida.nome.length < 2 || saida.nome.length > 80) erros.push('Informe o nome da pessoa (até 80 caracteres).');
  }
  if (novo || d.papel !== undefined) {
    saida.papel = String(d.papel || '');
    if (!PAPEIS.includes(saida.papel)) erros.push('Escolha o tipo de acesso.');
  }
  if (novo || d.permissoes !== undefined) saida.permissoes = limparPermissoes(d.permissoes);
  if (d.ativo !== undefined) saida.ativo = d.ativo ? 1 : 0;
  // função (perfil de acesso): só para quem não é administrador; null = acesso personalizado
  if (novo || d.funcao_id !== undefined) {
    const f = d.funcao_id === null || d.funcao_id === '' || d.funcao_id === undefined ? null : Number(d.funcao_id);
    if (f !== null && !(Number.isInteger(f) && f > 0)) erros.push('Função inválida.');
    saida.funcao_id = saida.papel === 'admin' ? null : f;
  }
  // bases da bomba interna que o login vê: null = todas (inclusive as criadas depois); lista de ids = só essas
  if (d.bomba_bases !== undefined) {
    if (d.bomba_bases === null) saida.bomba_bases = null;
    else if (Array.isArray(d.bomba_bases) && d.bomba_bases.every((x) => Number.isInteger(Number(x)) && Number(x) > 0)) {
      saida.bomba_bases = [...new Set(d.bomba_bases.map(Number))].sort((a, b) => a - b);
    } else erros.push('Bases da bomba interna inválidas.');
  }
  // unidades do login (26/11/2026): para os avisos separados por unidade (encarregados). null ou lista vazia = todas
  if (d.unidades !== undefined) {
    if (d.unidades === null || (Array.isArray(d.unidades) && !d.unidades.length)) saida.unidades = null;
    else if (Array.isArray(d.unidades) && d.unidades.every((x) => UNIDADES.includes(String(x)))) saida.unidades = [...new Set(d.unidades.map(String))].sort();
    else erros.push('Unidades inválidas.');
  }
  if (saida.papel === 'gestor' && !saida.funcao_id && saida.permissoes && !saida.permissoes.length) erros.push('Escolha uma função ou marque pelo menos uma página que a pessoa pode usar.');
  return { dados: saida, erros };
}

// a função existe? (devolve a linha ou null)
export async function buscarFuncao(db, id) {
  return id ? db.prepare('SELECT id, nome, permissoes FROM funcoes WHERE id = ?').bind(id).first() : null;
}

// colunas do login com a função dele, para listar e devolver na API
export const CAMPOS_USUARIO = `u.id, u.usuario, u.nome, u.papel, u.ativo, u.trocar_senha, u.criado_em, u.ultimo_acesso, u.permissoes,
  u.funcao_id, f.nome AS funcao_nome, f.permissoes AS funcao_permissoes, u.bomba_bases, u.unidades`;
export const DE_USUARIOS = 'FROM usuarios u LEFT JOIN funcoes f ON f.id = u.funcao_id';

export async function adminsAtivos(db, excetoId) {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE papel = 'admin' AND ativo = 1 AND excluido = 0 AND id <> ?")
    .bind(excetoId ?? -1).first();
  return r.n;
}

export function publico(r) {
  return {
    id: r.id, usuario: r.usuario, nome: r.nome, papel: r.papel, ativo: r.ativo === 1,
    trocar_senha: r.trocar_senha === 1, criado_em: r.criado_em, ultimo_acesso: r.ultimo_acesso,
    permissoes: permissoesDe(r),                      // as que valem (da função, se tiver)
    funcao_id: r.papel === 'admin' ? null : (r.funcao_id || null), funcao_nome: r.papel === 'admin' ? null : (r.funcao_nome || null),
    personalizadas: (() => { try { return limparPermissoes(JSON.parse(r.permissoes || '[]')); } catch { return []; } })(),
    // null = todas as bases; administrador sempre vê todas
    bomba_bases: r.papel === 'admin' || r.bomba_bases === null || r.bomba_bases === undefined ? null
      : (() => { try { const l = JSON.parse(r.bomba_bases); return Array.isArray(l) ? l : []; } catch { return []; } })(),
    unidades: unidadesDe(r),   // [] = todas
  };
}

export { CATALOGO };
