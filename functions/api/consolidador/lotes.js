import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode } from '../../../lib/permissoes.js';
import { aplicarDepois } from '../../../lib/aplicar-banco.js';

// POST /api/consolidador/lotes   {resumo, linhas: [[fonte, ...48 colunas da Base]], chaves: [[placa§hodômetro§combustível, data serial]]}
// O lote fica pendente até o vigia acrescentar as linhas na aba Transações da CONTROLES\Base_copia.xlsx.
const FONTES = new Set(['TICKET', 'TRUCKPAG', 'VELOE', 'VIBRA']);
const LIMITE = 1_800_000;   // bytes do lote (uma linha do D1 vai até ~2 MB)

export async function onRequestPost({ request, env, waitUntil }) {
  const origem = request.headers.get('Origin');
  if (origem && origem !== new URL(request.url).origin) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  if (!pode(u, 'consolidador-editar')) return json({ erro: 'Seu acesso ao consolidador é só de consulta.' }, 403);
  const texto = await request.text();
  if (texto.length > LIMITE + 200_000) return json({ erro: 'Lote grande demais: processe os arquivos em partes menores (por período).' }, 413);
  let d;
  try { d = JSON.parse(texto); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const linhas = Array.isArray(d.linhas) ? d.linhas : [];
  if (!linhas.length) return json({ erro: 'Nenhum abastecimento para gravar.' }, 400);
  if (linhas.some((l) => !Array.isArray(l) || l.length !== 49 || !FONTES.has(l[0]) ||
      l.slice(1).some((v) => v !== null && !['string', 'number'].includes(typeof v)))) {
    return json({ erro: 'Linhas fora do formato dos abastecimentos (48 colunas). Recarregue a página e processe de novo.' }, 400);
  }
  const chaves = (Array.isArray(d.chaves) ? d.chaves : []).filter((c) => Array.isArray(c) && typeof c[0] === 'string').slice(0, 5000);
  const resumo = d.resumo && typeof d.resumo === 'object' ? d.resumo : {};
  const linhasJson = JSON.stringify(linhas);
  if (linhasJson.length > LIMITE) return json({ erro: 'Lote grande demais: processe os arquivos em partes menores (por período).' }, 413);
  const r = await env.DB.prepare(
    `INSERT INTO consolidador_lotes (usuario_id, usuario_nome, resumo, linhas, chaves) VALUES (?, ?, ?, ?, ?) RETURNING id, criado_em, estado`)
    .bind(u.id, u.nome, JSON.stringify(resumo), linhasJson, JSON.stringify(chaves)).first();
  aplicarDepois({ env, waitUntil });   // aplica também direto no banco (15.2 passo 3)
  return json({ ok: true, lote: { ...r, usuario_nome: u.nome, resumo, chaves, mensagem: null, linha_inicial: null, linha_final: null } }, 201);
}
