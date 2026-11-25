import { usuarioDaSessao, json } from '../../lib/auth.js';
import { normPlaca } from '../../lib/cartoes.js';
import { lerCadastros } from '../../lib/cadastros-fonte.js';

// GET /api/placas-desabilitadas -> {placas: ['ABC1D23', ...]}: placas com SITUACAO = DESABILITADA no cadastro de Placas
// (chave "cadastros" do KV). O portal tira essas placas das listas e escolhas (filtro Placa dos painéis, bomba interna,
// Consulta de KM, Editar abastecimentos); os totais históricos continuam com os abastecimentos delas.
export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  return json({ placas: [...(await placasDesabilitadas(env))] });
}

export async function placasDesabilitadas(env) {
  const c = await lerCadastros(env).catch(() => null);
  const ls = c && Array.isArray(c.placas) ? c.placas : [];
  // só DESABILITADA some dos filtros: placa VENDIDO continua aparecendo, para ver se um carro vendido está abastecendo (usuário, 17/11/2026)
  return new Set(ls.filter((p) => String(p.situacao || '').toUpperCase() === 'DESABILITADA').map((p) => normPlaca(p.placa)).filter(Boolean));
}
