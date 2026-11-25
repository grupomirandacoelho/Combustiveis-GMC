import { tokenSyncValido, json } from '../../../../lib/auth.js';
import { aplicarCadastrosDepois } from '../../../../lib/aplicar-cadastros.js';

// O vigia manda aqui o que as APIs dos cartões devolveram para os motoristas do cadastro (código da Ticket, ID da
// TruckPag): entra na mesma fila do Cadastro > Motoristas (alteracoes_cadastros) e o vigia grava na planilha.
// E avisa quais alterações já foram enviadas aos cartões: os dados pessoais delas (CPF, nascimento, CNH) são apagados.
// POST {itens: [{usuario, dados: {codigoTicket?, idTruckpag?, matricula?}}], limpar: [id da alteração]}
const CAMPOS = ['codigoTicket', 'idTruckpag', 'matricula'];
const ok = (v) => Number.isInteger(v) && v > 0 && v < 1e12;

export async function onRequestPost({ request, env, waitUntil }) {
  if (!tokenSyncValido(request, env)) return json({ erro: 'Não autorizado.' }, 401);
  let d;
  try { d = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const itens = (Array.isArray(d.itens) ? d.itens : []).slice(0, 300).map((it) => ({
    usuario: String(it.usuario || '').replace(/\D/g, ''),
    dados: Object.fromEntries(Object.entries(it.dados || {}).filter(([k, v]) => CAMPOS.includes(k) && ok(v))),
  })).filter((it) => it.usuario.length === 6 && Object.keys(it.dados).length);
  const limpar = (Array.isArray(d.limpar) ? d.limpar : []).filter((i) => Number.isInteger(i) && i > 0).slice(0, 300);
  const stmts = limpar.map((id) => env.DB.prepare("UPDATE alteracoes_cadastros SET pessoais = NULL WHERE id = ? AND tipo = 'motoristas'").bind(id));
  if (itens.length) {
    const adm = await env.DB.prepare("SELECT id FROM usuarios WHERE papel = 'admin' AND ativo = 1 AND excluido = 0 ORDER BY id LIMIT 1").first();
    if (!adm) return json({ erro: 'Nenhum administrador ativo para registrar a alteração.' }, 500);
    for (const it of itens) {
      stmts.push(env.DB.prepare(
        `INSERT INTO alteracoes_cadastros (usuario_id, usuario_nome, tipo, acao, chave, dados, antes) VALUES (?, ?, 'motoristas', 'editar', ?, ?, '{}')`)
        .bind(adm.id, 'APIs dos cartões (automático)', it.usuario, JSON.stringify(it.dados)));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  if (itens.length) aplicarCadastrosDepois({ env, waitUntil });   // números dos cartões também no banco (15.3)
  return json({ ok: true, inseridos: itens.length, limpos: limpar.length });
}
