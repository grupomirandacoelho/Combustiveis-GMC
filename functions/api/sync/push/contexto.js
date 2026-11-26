import { tokenSyncValido, json } from '../../../../lib/auth.js';
import { pode, permissoesDe, USAM_DADOS } from '../../../../lib/permissoes.js';
import { CAMPOS_USUARIO, DE_USUARIOS } from '../../../../lib/usuarios.js';
import { basesDoUsuario, lerBases } from '../../../../lib/bomba.js';
import { recebe } from '../../../../public/gestao/lib/destino-notificacao.js';
import { regra, alteracoesPostosRecentes } from '../../notificacoes/index.js';
import { unidadesDe } from '../../../../lib/usuarios.js';
import { lista as movimentacoesBomba } from '../../bomba/movimentacoes.js';
import { recentes as abastecimentosBomba } from '../../bomba/abastecimentos.js';

// Notificações no celular (26/11/2026): o que a nuvem (Edge Function notificacoes-push, lib/nuvem/push.js) precisa para avaliar as
// regras marcadas "celular" como o sino de cada login. Só com o token de sincronização.
// GET -> {regras, usuarios: [{id, recebe: [ids], pode: {estoque, cartoes, dados}, bases: null | [ids]}], inscricoes: [{id, usuario_id,
//         endpoint, p256dh, auth}], comum: {base, alertasCartao?}, bomba?: {bases, movimentacoes, manuais}}
// Sem regra com celular ou sem aparelho: só {regras: [], ...} (a nuvem não carrega mais nada).
export async function onRequestGet({ request, env }) {
  if (!tokenSyncValido(request, env)) return json({ erro: 'Não autorizado.' }, 401);
  const { results: rs } = await env.DB.prepare('SELECT * FROM notificacoes WHERE ativa = 1 AND celular = 1 ORDER BY id').all();
  const regras = rs.map(regra);
  const vazio = { regras: [], usuarios: [], inscricoes: [], comum: {} };
  if (!regras.length) return json(vazio);
  const { results: inscricoes } = await env.DB.prepare(`SELECT p.id, p.usuario_id, p.endpoint, p.p256dh, p.auth FROM push_inscricoes p
    JOIN usuarios u ON u.id = p.usuario_id WHERE u.ativo = 1 AND u.excluido = 0 ORDER BY p.id`).all();
  if (!inscricoes.length) return json({ ...vazio, regras });
  const ids = [...new Set(inscricoes.map((i) => i.usuario_id))];
  const { results: us } = await env.DB.prepare(`SELECT ${CAMPOS_USUARIO} ${DE_USUARIOS} WHERE u.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  const usuarios = us.map((x) => {
    const perms = permissoesDe(x), bases = basesDoUsuario(x);
    return { id: x.id, recebe: regras.filter((r) => recebe(perms, x.id, r, USAM_DADOS)).map((r) => r.id),
      pode: { estoque: pode(x, 'bomba-estoque'), cartoes: pode(x, 'cartoes-frota'), dados: pode(x, ...USAM_DADOS) }, bases: bases ? [...bases] : null,
      unidades: unidadesDe(x) };   // aviso personalizado separado por unidade (26/11/2026)
  }).filter((u) => u.recebe.length);
  const tipos = new Set(regras.filter((r) => usuarios.some((u) => u.recebe.includes(r.id))).map((r) => r.tipo));
  const [versao, copia] = await Promise.all([env.DADOS.get('versao', 'json').catch(() => null), env.DADOS.get('base-copia-versao', 'json').catch(() => null)]);
  const comum = { base: { baseSalvaEm: (versao && versao.baseSalvaEm) || null, geradoEm: (versao && versao.geradoEm) || null, copiaEm: (copia && copia.enviadoEm) || null } };
  if (tipos.has('falta-cartao')) {
    const a = await env.DB.prepare("SELECT id, criado_em, placa, cartoes, motorista FROM alertas_cartoes WHERE estado = 'aberto' ORDER BY id DESC LIMIT 300").all();
    comum.alertasCartao = a.results.map((x) => { let c = []; try { c = JSON.parse(x.cartoes || '[]'); } catch { /* sem cartões */ } return { ...x, cartoes: c }; });
  }
  // aviso personalizado de mudanças nos postos: as mudanças do maior período que as regras olham
  const horas = Math.max(0, ...regras.filter((r) => r.tipo === 'personalizado' && (!r.condicao || r.condicao.fonte !== 'abastecimentos') && usuarios.some((u) => u.recebe.includes(r.id)))
    .map((r) => Number(r.condicao && r.condicao.horas) || 24));
  if (horas) comum.alteracoesPostos = await alteracoesPostosRecentes(env.DB, horas);
  const out = { regras, usuarios, inscricoes: inscricoes.filter((i) => usuarios.some((u) => u.id === i.usuario_id)), comum };
  if (tipos.has('estoque-baixo')) {
    const [bases, movimentacoes, manuais] = await Promise.all([lerBases(env.DB, false, null), movimentacoesBomba(env.DB, null), abastecimentosBomba(env.DB, null)]);
    out.bomba = { bases, movimentacoes, manuais };
  }
  return json(out);
}
