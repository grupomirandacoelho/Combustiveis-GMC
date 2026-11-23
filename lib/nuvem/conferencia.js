// Conferência com os cartões (Operacional): relê os últimos 45 dias da Ticket Log e da TruckPag (APIs) e compara com a
// CONTROLES\Base_copia.xlsx (lista .dados/cartoes-api/base-copia.json, montada pelo scripts/base_copia_lista.py). Publica no
// KV "conferencia-cartoes" o que está diferente (hodômetro, litros e valor), o que falta na Base_copia e o que sumiu do
// cartão. A classificação (corrigido no portal x alterado no cartão x conflito) é feita no site, com o histórico de
// correções (functions/api/conferencia-cartoes). Também atende os pedidos de inclusão da tela: monta o lote com o motor
// do Consolidador, como o D-1 das APIs (scripts/cartoes_api.mjs).
// Bomba interna: só hodômetro e litros (o valor muda de propósito no Rateio das NFs).
// Passo 4 da migração (23/11/2026): regras da Conferência sem arquivos próprios (antes em scripts/conferencia_cartoes.mjs, sem
// mudar regra). io = {api, log, agora(), diaLocal(ms), buscarTicket(d), buscarTruckpag(d), truckpagAnalitico(desde, ate) -> [transações],
// lista() -> lista da Base_copia, historico(), ler/gravar(nome) ('dia:AAAA-MM-DD', 'estado'), publicar(chave, objeto), temTempo()?}.
// temTempo: na nuvem (tempo limitado por execução), quando acaba, o dia fica com a leitura anterior; no vigia não há limite.
import { eventoTicket, eventoTruckpag, CORE, completarDoHistorico, semCpf } from './cartoes.js';

const DIAS = 45;                    // dias conferidos (até anteontem: ontem ainda pode estar entrando pelo D-1)
const INTERVALO = 3 * 3600e3;       // uma conferência completa a cada 3 horas
const VALIDADE = 2.5 * 3600e3;      // leitura de um dia vale por 2,5 h (na próxima volta lê de novo)

const somarDias = (dia, n) => { const d = new Date(dia + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const limpa = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const ehArla = (f) => /ARLA/i.test(String(f || ''));
const minutoDeData = (d) => Math.round((d.getTime() / 864e5 + 25569) * 1440);   // a data vem com a hora local nos campos UTC
const quandoDe = (min) => { const d = new Date((min / 1440 - 25569) * 864e5); return d.toISOString().slice(0, 16).replace('T', ' '); };
const idDe = (ev) => ev._api + ':' + ev._id;
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
function cartaoDaLinha(forma, serial) {
  const f = semAcento(forma);
  if (f === 'CARTAO FISICO') return 'TICKET';
  if (f === 'TRUCKPAG') return 'TRUCKPAG';
  if (!f && serial < 45836) return 'TICKET';   // forma vazia antes de 28/06/2025: só havia Ticket
  return null;
}

async function lerDia(io, dia) {
  const c = await io.ler('dia:' + dia, null);
  if (c && io.agora() - c.em < VALIDADE) return c;
  if (c && io.temTempo && !io.temTempo()) return c;   // sem tempo nesta execução: fica a leitura anterior
  try {
    const [ticket, truckpag] = (await Promise.all([io.buscarTicket(dia), io.buscarTruckpag(dia)])).map(semCpf);   // sem o CPF do motorista
    const novo = { dia, em: io.agora(), ticket, truckpag };
    await io.gravar('dia:' + dia, novo);
    return novo;
  } catch (e) {
    io.log('Conferência com os cartões: não foi possível ler ' + dia + ' (' + String(e.message || e).slice(0, 160) + ')' + (c ? '; fica a leitura anterior.' : '.'));
    return c;   // null: o dia fica fora (não acusa nada sem ter lido)
  }
}

function eventosDe(lido) {
  const evs = [];
  for (const t of lido.ticket) { const ev = eventoTicket(t); ev._dia = lido.dia; ev._raw = t; evs.push(ev); }
  for (const t of lido.truckpag) { const ev = eventoTruckpag(t); ev._dia = lido.dia; ev._raw = t; evs.push(ev); }
  return evs;
}

// situação de cada transação da TruckPag (relatório analítico de transações, o mesmo da Conciliação de NFs): o relatório
// de abastecimentos não diz se foi estornada/recusada nem se o lançamento manual da bomba foi um VAZAMENTO (não é abastecimento)
async function situacaoTruckpag(io, desde, ate) {
  try {
    const data = await io.truckpagAnalitico(desde, ate);
    return new Map(data.map((x) => [String(x.transacao_id), { status: String(x.transacao_status || '').toUpperCase(), mensagem: String(x.mensagem || '').toUpperCase() }]));
  } catch (e) {
    io.log('Conferência com os cartões: situação das transações da TruckPag indisponível (' + String(e.message || e).slice(0, 120) + ').');
    return new Map();
  }
}
const naoConta = (ev, situacao) => {
  if (ev._api !== 'truckpag') return false;
  const s = situacao.get(String(ev._id));
  return !!s && (s.status !== 'APROVADA' || s.mensagem.includes('VAZAMENTO'));
};

// compara os eventos dos cartões com a Base_copia; dias = os que foram lidos (só eles entram em "sumiu")
function comparar(b, eventos, dias, enviados) {
  if (!b) throw new Error('lista da Base_copia indisponível');
  const c = b.col, D = b.dic, txt = (k, i) => (c[k][i] === null ? null : D[k][c[k][i]]);
  const diasSet = new Set(dias);
  const porChave = new Map();   // placa|minuto -> linhas da Base_copia
  const porMinuto = new Map();  // minuto -> linhas (para achar a mesma transação com a placa trocada)
  for (let i = 0; i < c.linha.length; i++) {
    const serial = c.dt[i], min = Math.round(serial * 1440);
    const dia = quandoDe(min).slice(0, 10);
    if (!diasSet.has(dia)) continue;
    const posto = txt('posto', i) || '';
    const l = { linha: c.linha[i], serial, min, dia, placa: limpa(txt('placa', i)), fuel: txt('fuel', i), posto, mot: txt('mot', i),
      cartao: cartaoDaLinha(txt('forma', i), serial), interna: /^POSTO INT/i.test(posto),
      Q: c.hodo[i], O: c.litros[i], T: c.valor[i], usada: false };
    const k = l.placa + '|' + min;
    if (!porChave.has(k)) porChave.set(k, []);
    porChave.get(k).push(l);
    if (!porMinuto.has(min)) porMinuto.set(min, []);
    porMinuto.get(min).push(l);
  }
  const mesmoTipo = (l, ev) => !l.usada && ehArla(l.fuel) === ehArla(ev['TIPO COMBUSTIVEL']);
  // 1ª passagem: mesma placa e mesmo minuto (± 1 minuto de arredondamento)
  const achar = (ev) => {
    const placa = limpa(ev.PLACA), min = minutoDeData(ev['DATA TRANSACAO']);
    for (const dm of [0, -1, 1]) {
      const cand = (porChave.get(placa + '|' + (min + dm)) || []).filter((l) => mesmoTipo(l, ev));
      if (cand.length) return cand.sort((x, y) => Math.abs((x.O || 0) - (ev.LITROS || 0)) - Math.abs((y.O || 0) - (ev.LITROS || 0)))[0];
    }
    return null;
  };
  // 2ª passagem: placa trocada (corrigida no portal ou no cartão) — mesmo minuto, mesmo cartão e mesmos litros
  const acharPorLitros = (ev) => {
    const min = minutoDeData(ev['DATA TRANSACAO']);
    for (const dm of [0, -1, 1]) {
      const l = (porMinuto.get(min + dm) || []).find((x) => mesmoTipo(x, ev) && x.cartao === ev.fonte && Math.abs((x.O || 0) - (ev.LITROS || 0)) < 0.01);
      if (l) return l;
    }
    return null;
  };
  // 3ª passagem: hora ou combustível mudados — mesma placa, mesmo dia, mesmo cartão e mesmos litros
  const acharNoDia = (ev) => {
    const placa = limpa(ev.PLACA), dia = quandoDe(minutoDeData(ev['DATA TRANSACAO'])).slice(0, 10);
    for (const ls of porChave.values()) {
      const l = ls.find((x) => !x.usada && x.placa === placa && x.dia === dia && x.cartao === ev.fonte && Math.abs((x.O || 0) - (ev.LITROS || 0)) < 0.01);
      if (l) return l;
    }
    return null;
  };
  const itens = [];
  const base = (ev, extra) => ({ cartao: ev.fonte, placa: limpa(ev.PLACA), quando: quandoDe(minutoDeData(ev['DATA TRANSACAO'])),
    combustivel: ev['TIPO COMBUSTIVEL'], posto: ev['NOME ESTABELECIMENTO'] || '', motorista: ev['NOME MOTORISTA'] || '', ...extra });
  const pares = eventos.map((ev) => { const l = achar(ev); if (l) l.usada = true; return [ev, l]; });
  for (const par of pares) if (!par[1]) { const l = acharPorLitros(par[0]); if (l) { l.usada = true; par[1] = l; } }
  for (const par of pares) if (!par[1]) { const l = acharNoDia(par[0]); if (l) { l.usada = true; par[1] = l; } }
  for (const [ev, l] of pares) {
    const cart = { F: limpa(ev.PLACA), Q: ev['HODOMETRO OU HORIMETRO'], O: ev.LITROS, T: ev['VALOR EMISSAO'] ?? (ev.LITROS && ev['VL/LITRO'] ? Math.round(ev.LITROS * ev['VL/LITRO'] * 100) / 100 : null) };
    if (!l) {
      if (enviados.has(idDe(ev))) continue;   // já foi num lote do D-1: está a caminho da Base_copia
      itens.push(base(ev, { tipo: 'falta', id: idDe(ev), dia: ev._dia, cartaoVals: cart }));
      continue;
    }
    const colunas = [];
    if (l.placa !== cart.F) colunas.push('F');
    if (cart.Q !== null && cart.Q !== undefined && (l.Q === null || Math.abs(l.Q - cart.Q) >= 0.5)) colunas.push('Q');
    // litros: a TruckPag manda 3 casas (150,045) e a Base_copia guarda 2 (150,05); menos de 0,01 L é arredondamento
    if (cart.O !== null && cart.O !== undefined && Math.abs((l.O || 0) - cart.O) >= 0.0099) colunas.push('O');
    // valor: só diferença de mais de R$ 0,50 (a Base_copia guarda o valor com 4 casas; o cartão, com 2)
    if (!l.interna && cart.T !== null && cart.T !== undefined && Math.abs((l.T || 0) - cart.T) >= 0.5) colunas.push('T');
    if (colunas.length) {
      itens.push(base(ev, { tipo: 'diferente', linha: l.linha, chave: l.placa + '|' + l.min, colunas,
        nossos: { F: l.placa, Q: l.Q, O: l.O, T: l.T }, cartaoVals: cart, id: idDe(ev) }));
    }
  }
  // linhas Ticket/TruckPag da Base_copia que nenhuma transação dos cartões explicou
  for (const ls of porChave.values()) {
    for (const l of ls) {
      if (l.usada || !l.cartao) continue;
      itens.push({ tipo: 'sumiu', cartao: l.cartao, placa: l.placa, quando: quandoDe(l.min), combustivel: l.fuel, posto: l.posto, motorista: l.mot || '',
        linha: l.linha, chave: l.placa + '|' + l.min, nossos: { Q: l.Q, O: l.O, T: l.T } });
    }
  }
  itens.sort((a, b) => (a.quando < b.quando ? 1 : -1));
  return itens;
}

// ---------- pedidos de inclusão (tela): lote como o D-1 ----------
async function incluir(io) {
  const { api, log } = io;
  const { pedidos } = await api('GET', '/api/sync/conferencia-cartoes/pedidos');
  if (!pedidos || !pedidos.length) return;
  const hist = await io.historico();
  if (!hist) { log('Conferência com os cartões: histórico da Base indisponível para incluir; tenta na próxima volta.'); return; }
  const estado = await api('GET', '/api/sync/cartoes-api/estado');
  const dec = {
    aliasExtras: (estado.postos || []).filter((p) => p.decisao === 'mesmo' && p.canonico).map((p) => [p.nome, p.canonico]),
    postosNovos: (estado.postos || []).filter((p) => p.decisao === 'novo').map((p) => ({ nome_cru: p.nome, endereco: p.endereco, cidade: p.cidade, uf: p.uf })),
    postosIgnorados: (estado.postos || []).filter((p) => p.decisao === 'ignorar').map((p) => p.nome),
  };
  const resultado = [];
  const porDia = new Map();
  for (const p of pedidos) { if (!porDia.has(p.dia)) porDia.set(p.dia, []); porDia.get(p.dia).push(p); }
  for (const [dia, ps] of porDia) {
    const lido = await lerDia(io, dia);
    const evs = lido ? eventosDe(lido) : [];
    const escolhidos = [];
    for (const p of ps) {
      const ev = evs.find((e) => idDe(e) === p.cartao_id);
      if (!ev) resultado.push({ id: p.id, estado: 'erro', mensagem: 'A transação não aparece mais no cartão.' });
      else { const c = { ...ev }; delete c._raw; escolhidos.push({ p, ev: c }); }
    }
    if (!escolhidos.length) continue;
    const baseH = CORE.carregarHistorico(hist);
    for (const [k, serial] of estado.chaves || []) if (!baseH.existing_keys.has(k)) baseH.existing_keys.set(k, [CORE.excelSerialToDate(serial)]);
    escolhidos.forEach((x) => completarDoHistorico(baseH, x.ev));
    const r = CORE.consolidar({ base: baseH, manuais: escolhidos.map((x) => x.ev), ...dec });
    const dup = new Set(r.duplicados.map((x) => x.placa + '|' + x.data.getTime() + '|' + x.hodometro));
    const vao = [];
    for (const x of escolhidos) {
      const k = x.ev.PLACA + '|' + x.ev['DATA TRANSACAO'].getTime() + '|' + x.ev['HODOMETRO OU HORIMETRO'];
      if (dup.has(k)) resultado.push({ id: x.p.id, estado: 'duplicado', mensagem: 'Já existe na Base_copia (mesma placa, data e hodômetro).' });
      else vao.push(x);
    }
    const evsLote = r.eventos.filter((e) => vao.some((x) => idDe(x.ev) === idDe(e)));
    if (!evsLote.length) { vao.forEach((x) => resultado.push({ id: x.p.id, estado: 'erro', mensagem: 'O Consolidador não montou a linha.' })); continue; }
    const linhas = evsLote.map((e) => [e.fonte, ...CORE.buildRow(e)]);
    const chaves = evsLote.filter((e) => e['HODOMETRO OU HORIMETRO'] !== null && e['HODOMETRO OU HORIMETRO'] !== undefined)
      .map((e) => [[e.PLACA, e['HODOMETRO OU HORIMETRO'], e['TIPO COMBUSTIVEL']].join('§'), CORE.dateToSerial(e['DATA TRANSACAO'])]);
    const resumo = { n_ticket: evsLote.filter((e) => e.fonte === 'TICKET').length, n_truckpag: evsLote.filter((e) => e.fonte === 'TRUCKPAG').length,
      conferencia: true, avisos: r.avisos.filter((a) => evsLote.some((e) => a.includes(e.PLACA))).slice(0, 50) };
    try {
      const j = await api('POST', '/api/sync/cartoes-api/lote', { dia, linhas, chaves, ids: evsLote.map(idDe), resumo });
      vao.forEach((x) => resultado.push({ id: x.p.id, estado: 'feito', lote_id: j.id, mensagem: 'Lote ' + j.id + ' do Consolidador.' }));
      log(`Conferência com os cartões: ${evsLote.length} transação(ões) de ${dia} incluída(s) num lote da Base_copia (lote ${j.id}).`);
    } catch (e) {
      vao.forEach((x) => resultado.push({ id: x.p.id, estado: 'erro', mensagem: String(e.message || e).slice(0, 200) }));
    }
  }
  if (resultado.length) await api('POST', '/api/sync/conferencia-cartoes/pedidos', { itens: resultado });
}

let proxima = 0;
export async function processar(io, { forcar } = {}) {
  const { api, log } = io;
  try { await incluir(io); } catch (e) { log('Conferência com os cartões (inclusões): ' + String(e.message || e).slice(0, 200)); }
  const est = await io.ler('estado', {});
  if (!forcar && (io.agora() < proxima || io.agora() - (est.em || 0) < INTERVALO)) return null;
  proxima = io.agora() + INTERVALO;
  const hoje = io.diaLocal(io.agora()), ate = somarDias(hoje, -2), desde = somarDias(hoje, -(DIAS + 1));
  const dias = [];
  for (let d = desde; d <= ate; d = somarDias(d, 1)) dias.push(d);
  const lidos = [];
  // do mais novo para o mais velho: com o tempo limitado da nuvem, os dias recentes são relidos primeiro
  for (const d of [...dias].reverse()) { const l = await lerDia(io, d); if (l) lidos.unshift(l); }
  const situacao = await situacaoTruckpag(io, desde, ate);
  const eventos = lidos.flatMap(eventosDe).filter((ev) => !naoConta(ev, situacao));
  const estado = await api('GET', '/api/sync/cartoes-api/estado');
  const b = await io.lista();
  if (!b) throw new Error('lista da Base_copia indisponível');
  const itens = comparar(b, eventos, lidos.map((l) => l.dia), new Set(estado.ids || []));
  const saida = { geradoEm: new Date(io.agora()).toISOString(), desde, ate, lidos: lidos.length, transacoes: eventos.length, itens };
  await io.publicar('conferencia-cartoes', saida);
  await io.gravar('estado', { em: io.agora() });
  const n = (t) => itens.filter((i) => i.tipo === t).length;
  log(`Conferência com os cartões: ${eventos.length} transações de ${lidos.length} dias conferidas; ${n('diferente')} diferente(s), ${n('falta')} faltando na Base_copia, ${n('sumiu')} que não estão no cartão.`);
  return { lidos: lidos.length, transacoes: eventos.length, diferentes: n('diferente'), faltam: n('falta'), sumiu: n('sumiu') };
}
