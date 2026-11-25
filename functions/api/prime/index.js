import { usuarioDaSessao, json } from '../../../lib/auth.js';
import { pode } from '../../../lib/permissoes.js';
import { chaveNome } from '../../../lib/motoristas.js';
import { lerCadastros } from '../../../lib/cadastros-fonte.js';

// Operacional > Programa PRIME. A conta (ranking, prêmios) é feita na tela com o arquivo de abastecimentos; aqui ficam as decisões
// do mês: abastecimentos que não entram (motivo, aviso ao motorista, troca de motorista), a exportação da telemetria, as notas
// manuais, os parâmetros e o fechamento. Nada disso muda a Base nem a Operação por motorista.
// GET  ?mes=AAAA-MM -> {mes, meses, situacao, parametros, resultado, decisoes, telemetria, notas, cadastro, podeEditar, admin}
// POST {acao: 'decidir', mes, itens: [{chave, entra, motivo, aviso, motorista_para, motorista}]}
//      {acao: 'telemetria', mes, arquivo, periodo, linhas: [{nome, pontos, horas, km}]}
//      {acao: 'nota', mes, motorista, nota (null apaga), motivo}
//      {acao: 'parametros', mes, parametros} · {acao: 'fechar', mes, parametros, resultado} · {acao: 'reabrir', mes} (administrador)
const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const mesAnterior = (m) => { const [a, b] = m.split('-').map(Number); return b === 1 ? (a - 1) + '-12' : a + '-' + String(b - 1).padStart(2, '0'); };
const texto = (v, max) => (v === null || v === undefined ? null : String(v).trim().slice(0, max) || null);
const vazio = (v) => v === null || v === undefined || v === '';
const agora = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

async function situacao(env, mes) {
  const r = await env.DB.prepare('SELECT situacao FROM prime_meses WHERE mes = ?').bind(mes).first();
  return r ? r.situacao : 'aberto';
}

export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  if (!pode(u, 'programa-prime')) return json({ erro: 'Seu acesso não inclui o Programa PRIME.' }, 403);
  const mes = new URL(request.url).searchParams.get('mes');
  if (!MES.test(mes || '')) return json({ erro: 'Mês inválido.' }, 400);
  const ant = mesAnterior(mes);
  const [m, meses, dec, tel, notas, cad] = await Promise.all([
    env.DB.prepare('SELECT * FROM prime_meses WHERE mes = ?').bind(mes).first(),
    env.DB.prepare('SELECT mes, situacao FROM prime_meses ORDER BY mes DESC').all(),
    // o mês anterior entra para o km dos abastecimentos tirados no fim dele passar para o primeiro deste mês
    env.DB.prepare('SELECT chave, mes, entra, motivo, aviso, motorista_para, motorista, usuario_nome, criado_em FROM prime_abastecimentos WHERE mes IN (?, ?)').bind(mes, ant).all(),
    env.DB.prepare('SELECT arquivo, periodo, linhas, usuario_nome, enviado_em FROM prime_telemetria WHERE mes = ?').bind(mes).first(),
    env.DB.prepare('SELECT motorista, nota, motivo, usuario_nome, criado_em FROM prime_notas WHERE mes = ?').bind(mes).all(),
    lerCadastros(env).catch(() => null),
  ]);
  // só nome, unidade e situação do cadastro (sem CPF nem senhas)
  const cadastro = cad && Array.isArray(cad.motoristas)
    ? cad.motoristas.map((r) => ({ nome: r.motorista || r.nome || '', unidade: r.unidade || '', situacao: r.situacao || '' })).filter((r) => r.nome)
    : null;
  const ler = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  const telemetria = tel ? { ...tel, linhas: ler(tel.linhas) || [] } : null;
  return json({
    mes, meses: meses.results, situacao: m ? m.situacao : 'aberto', parametros: m ? ler(m.parametros) : null,
    resultado: m ? ler(m.resultado) : null, fechadoPor: m ? m.fechado_por : null, fechadoEm: m ? m.fechado_em : null,
    decisoes: dec.results, telemetria, notas: notas.results, cadastro,
    podeEditar: pode(u, 'programa-prime-editar'), admin: u.papel === 'admin',
  });
}

export async function onRequestPost({ request, env }) {
  const u = await usuarioDaSessao(env.DB, request);
  if (!u) return json({ erro: 'Não conectado.' }, 401);
  if (!pode(u, 'programa-prime-editar')) return json({ erro: 'Seu acesso não permite alterar o Programa PRIME.' }, 403);
  let c;
  try { c = await request.json(); } catch { return json({ erro: 'Pedido inválido.' }, 400); }
  const mes = c && c.mes;
  if (!MES.test(mes || '')) return json({ erro: 'Mês inválido.' }, 400);
  if (c.acao === 'reabrir') {
    if (u.papel !== 'admin') return json({ erro: 'Só um administrador reabre um mês fechado.' }, 403);
    await env.DB.prepare(`UPDATE prime_meses SET situacao = 'aberto', resultado = NULL, fechado_por = NULL, fechado_em = NULL, atualizado_em = ${agora} WHERE mes = ?`).bind(mes).run();
    return json({ ok: true });
  }
  if (await situacao(env, mes) === 'fechado') return json({ erro: 'O mês está fechado. Peça a um administrador para reabrir.' }, 409);
  const quem = u.nome || u.usuario;

  if (c.acao === 'decidir') {
    const itens = Array.isArray(c.itens) ? c.itens.slice(0, 500) : [];
    if (!itens.length) return json({ erro: 'Nenhum abastecimento.' }, 400);
    const st = [];
    for (const it of itens) {
      const chave = texto(it.chave, 80);
      if (!chave) continue;
      const entra = it.entra ? 1 : 0, para = texto(it.motorista_para, 120);
      // voltou a entrar e sem troca de motorista: não precisa de linha
      if (entra && !para) { st.push(env.DB.prepare('DELETE FROM prime_abastecimentos WHERE chave = ?').bind(chave)); continue; }
      if (!entra && !texto(it.motivo, 80)) return json({ erro: 'Informe o motivo de tirar o abastecimento do PRIME.' }, 400);
      st.push(env.DB.prepare(`INSERT INTO prime_abastecimentos (chave, mes, entra, motivo, aviso, motorista_para, motorista, usuario_nome)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chave) DO UPDATE SET mes = excluded.mes, entra = excluded.entra, motivo = excluded.motivo,
        aviso = excluded.aviso, motorista_para = excluded.motorista_para, motorista = excluded.motorista, usuario_nome = excluded.usuario_nome,
        criado_em = ${agora}`)
        .bind(chave, mes, entra, entra ? null : texto(it.motivo, 80), entra ? null : texto(it.aviso, 300), para, chaveNome(it.motorista) || null, quem));
    }
    if (st.length) await env.DB.batch(st);
    return json({ ok: true, n: st.length });
  }

  if (c.acao === 'telemetria') {
    const num = (v) => (vazio(v) || !Number.isFinite(+v) ? null : +v);
    const linhas = (Array.isArray(c.linhas) ? c.linhas : []).slice(0, 2000)
      .map((l) => ({ nome: texto(l.nome, 120), pontos: num(l.pontos), horas: num(l.horas), km: num(l.km) }))
      .filter((l) => l.nome);
    if (!linhas.length) return json({ erro: 'A planilha não tem motoristas.' }, 400);
    await env.DB.prepare(`INSERT INTO prime_telemetria (mes, arquivo, periodo, linhas, usuario_nome) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mes) DO UPDATE SET arquivo = excluded.arquivo, periodo = excluded.periodo, linhas = excluded.linhas,
      usuario_nome = excluded.usuario_nome, enviado_em = ${agora}`)
      .bind(mes, texto(c.arquivo, 200), texto(c.periodo, 200), JSON.stringify(linhas), quem).run();
    return json({ ok: true, n: linhas.length });
  }

  if (c.acao === 'nota') {
    const mot = chaveNome(c.motorista);
    if (!mot) return json({ erro: 'Motorista inválido.' }, 400);
    if (vazio(c.nota)) {
      await env.DB.prepare('DELETE FROM prime_notas WHERE mes = ? AND motorista = ?').bind(mes, mot).run();
      return json({ ok: true });
    }
    const nota = Number(c.nota);
    if (!Number.isFinite(nota) || nota < -100 || nota > 200) return json({ erro: 'Nota inválida.' }, 400);
    await env.DB.prepare(`INSERT INTO prime_notas (mes, motorista, nota, motivo, usuario_nome) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mes, motorista) DO UPDATE SET nota = excluded.nota, motivo = excluded.motivo, usuario_nome = excluded.usuario_nome,
      criado_em = ${agora}`).bind(mes, mot, nota, texto(c.motivo, 200), quem).run();
    return json({ ok: true });
  }

  if (c.acao === 'parametros' || c.acao === 'fechar') {
    const p = JSON.stringify(c.parametros || null);
    if (p.length > 50000) return json({ erro: 'Parâmetros grandes demais.' }, 400);
    if (c.acao === 'parametros') {
      await env.DB.prepare(`INSERT INTO prime_meses (mes, parametros) VALUES (?, ?)
        ON CONFLICT(mes) DO UPDATE SET parametros = excluded.parametros, atualizado_em = ${agora}`).bind(mes, p).run();
      return json({ ok: true });
    }
    const resultado = Array.isArray(c.resultado) ? c.resultado : null;
    if (!resultado || !resultado.length) return json({ erro: 'O ranking está vazio.' }, 400);
    // ninguém fica sem nota: o mês só fecha com todas preenchidas
    if (resultado.some((r) => vazio(r.nota))) return json({ erro: 'Ainda há motoristas sem nota. Preencha todas antes de fechar o mês.' }, 400);
    const r = JSON.stringify(resultado);
    if (r.length > 900000) return json({ erro: 'Resultado grande demais.' }, 400);
    await env.DB.prepare(`INSERT INTO prime_meses (mes, situacao, parametros, resultado, fechado_por, fechado_em) VALUES (?, 'fechado', ?, ?, ?, ${agora})
      ON CONFLICT(mes) DO UPDATE SET situacao = 'fechado', parametros = excluded.parametros, resultado = excluded.resultado,
      fechado_por = excluded.fechado_por, fechado_em = excluded.fechado_em, atualizado_em = ${agora}`).bind(mes, p, r, quem).run();
    return json({ ok: true });
  }
  return json({ erro: 'Ação desconhecida.' }, 400);
}
