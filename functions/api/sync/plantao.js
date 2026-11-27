import { tokenSyncValido, json } from '../../../lib/auth.js';

// Revezamento dos vigias. Cada vigia chama aqui antes de cada etapa de trabalho: {maquina, prioridade}.
// Resposta {ativo: true} = pode trabalhar; {ativo: false} = fica em espera.
//  - fica de plantão o vigia de menor prioridade (1 = principal) que deu sinal no último minuto;
//  - quem está de plantão e vê um de prioridade maior dando sinal devolve o plantão para ele (o principal voltou);
//  - quem está de plantão e para de dar sinal por PRAZO segundos perde o plantão (o reserva assume).
// Assumir e devolver são UPDATEs condicionais (uma instrução só), então nunca ficam dois de plantão ao mesmo tempo.
// Vigia desligado (15.4, 27/11/2026; pedido do usuário depois das comparações): com a chave KV "vigia-desligado", nenhum computador
// recebe o plantão (o principal e o reserva ficam em espera e não gravam nada), mesmo que a tarefa agendada continue ligada em algum
// deles. O sinal (vigias.visto_em) continua sendo anotado, para saber se algum vigia ainda está rodando. Para religar: apagar a chave.
export const CHAVE_DESLIGADO = 'vigia-desligado';
const VIVO = 60;     // s: sinal mais recente que isso = vigia ligado
const PRAZO = 240;   // s: plantão sem sinal há mais que isso fica livre

export async function onRequestPost({ request, env }) {
  if (!tokenSyncValido(request, env)) return json({ erro: 'Não autorizado.' }, 401);
  let corpo;
  try { corpo = await request.json(); } catch { return json({ erro: 'Dados inválidos.' }, 400); }
  const maquina = String(corpo.maquina || '').trim().slice(0, 80);
  const prioridade = Number.isInteger(corpo.prioridade) && corpo.prioridade > 0 ? corpo.prioridade : 9;
  if (!maquina) return json({ erro: 'Informe o nome do computador.' }, 400);
  const agora = Math.floor(Date.now() / 1000);
  const db = env.DB;

  await db.prepare('INSERT INTO vigias (maquina, prioridade, visto_em) VALUES (?, ?, ?) ON CONFLICT(maquina) DO UPDATE SET prioridade = excluded.prioridade, visto_em = excluded.visto_em')
    .bind(maquina, prioridade, agora).run();
  if (await env.DADOS.get(CHAVE_DESLIGADO)) {
    await db.prepare('UPDATE plantao SET maquina = NULL WHERE id = 1 AND maquina IS NOT NULL').run();
    return json({ ativo: false, plantao: null, desde: null, maquina, prioridade, desligado: true });
  }
  const p = await db.prepare('SELECT maquina, desde, renovado FROM plantao WHERE id = 1').first();
  const vivos = (await db.prepare('SELECT maquina, prioridade FROM vigias WHERE visto_em > ? ORDER BY prioridade, maquina').bind(agora - VIVO).all()).results;
  const desejado = vivos.length ? vivos[0].maquina : maquina;

  let ativo = false;
  if (p && p.maquina === maquina) {
    if (desejado !== maquina) {
      // um vigia de prioridade maior está ligado: devolve o plantão para ele (ele começa na próxima chamada)
      await db.prepare('UPDATE plantao SET maquina = ?, desde = ?, renovado = ? WHERE id = 1 AND maquina = ?').bind(desejado, agora, agora, maquina).run();
    } else {
      const r = await db.prepare('UPDATE plantao SET renovado = ? WHERE id = 1 AND maquina = ?').bind(agora, maquina).run();
      ativo = r.meta.changes === 1;
    }
  } else if (desejado === maquina || !p || !p.maquina) {
    // assume se o plantão está livre ou abandonado (quem estava parou de dar sinal)
    const r = await db.prepare('UPDATE plantao SET maquina = ?, desde = ?, renovado = ? WHERE id = 1 AND (maquina IS NULL OR renovado < ?)')
      .bind(maquina, agora, agora, agora - PRAZO).run();
    ativo = r.meta.changes === 1;
  } else if (p.renovado < agora - PRAZO) {
    // ninguém melhor está ligado e o plantão foi abandonado: este assume
    const r = await db.prepare('UPDATE plantao SET maquina = ?, desde = ?, renovado = ? WHERE id = 1 AND renovado < ?')
      .bind(maquina, agora, agora, agora - PRAZO).run();
    ativo = r.meta.changes === 1;
  }
  const atual = await db.prepare('SELECT maquina, desde FROM plantao WHERE id = 1').first();
  return json({ ativo, plantao: atual ? atual.maquina : null, desde: atual ? atual.desde : null, maquina, prioridade });
}
