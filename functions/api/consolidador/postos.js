import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode } from '../../../lib/permissoes.js';

// POST /api/consolidador/postos
//   {acao: 'salvar', decisoes: [{nome, decisao: 'mesmo'|'novo'|'ignorar', canonico?, endereco?, cidade?, uf?}]}
//   {acao: 'remover', chave}
// Decisões do painel "Postos pendentes de autorização": gravadas, valem nas próximas consolidações sem perguntar de novo.
// A chave é o nome normalizado igual ao normKey() do consolidador (maiúsculas, sem acento, espaços simples).
const normKey = (s) => String(s ?? '').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(Boolean).join(' ');
const texto = (v, max) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); return t || null; };

export async function onRequestPost({ request, env }) {
  const origem = request.headers.get('Origin');
  if (origem && origem !== new URL(request.url).origin) return json({ erro: 'Origem não permitida.' }, 403);
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Sua sessão terminou. Entre de novo.' }, 401);
  if (!pode(u, 'consolidador-editar')) return json({ erro: 'Seu acesso ao consolidador é só de consulta.' }, 403);
  let corpo;
  try { corpo = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }

  if (corpo.acao === 'remover') {
    const r = await env.DB.prepare('DELETE FROM consolidador_postos WHERE chave = ?').bind(String(corpo.chave || '')).run();
    return json({ ok: true, removidos: r.meta.changes || 0 });
  }
  if (corpo.acao !== 'salvar' || !Array.isArray(corpo.decisoes) || !corpo.decisoes.length) return json({ erro: 'Nenhuma decisão para gravar.' }, 400);
  const stmts = [], erros = [];
  for (const d of corpo.decisoes.slice(0, 300)) {
    const nome = texto(d.nome, 200), chave = normKey(nome);
    const decisao = ['mesmo', 'novo', 'ignorar'].includes(d.decisao) ? d.decisao : null;
    const canonico = texto(d.canonico, 200);
    if (!chave || !decisao) { erros.push('Decisão inválida para "' + (nome || '?') + '".'); continue; }
    if (decisao === 'mesmo' && !canonico) { erros.push('Informe o posto já existente nos abastecimentos para "' + nome + '".'); continue; }
    stmts.push(env.DB.prepare(
      `INSERT INTO consolidador_postos (chave, nome, decisao, canonico, endereco, cidade, uf, usuario_nome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chave) DO UPDATE SET nome = excluded.nome, decisao = excluded.decisao, canonico = excluded.canonico,
         endereco = excluded.endereco, cidade = excluded.cidade, uf = excluded.uf, usuario_nome = excluded.usuario_nome,
         criado_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`)
      .bind(chave, nome, decisao, decisao === 'mesmo' ? canonico : null, texto(d.endereco, 200), texto(d.cidade, 80), texto(d.uf, 2), u.nome));
  }
  if (erros.length) return json({ erro: erros.join(' ') }, 400);
  await env.DB.batch(stmts);
  return json({ ok: true, gravadas: stmts.length });
}
