// Fiscal/Financeiro > Conciliação de NFs: liga cada nota fiscal de serviço (NFS) que o cartão emite para a Raja às notas
// fiscais dos postos daquela fatura, pelas APIs (só leitura). Chamado pelo vigia no passo das APIs dos cartões; refaz a
// cada 6 horas e publica no KV "conciliacao-nfs".
// Ticket (cliente 245364): NFS = título da fatura de reembolso (/ebs/titulo/search: numeroFormularioFiscal, dataGeracao);
//   as compras do título (/ebs/titulo/{codigo}: detalhamentoCompras.autorizacao) são as transações dos lotes da coleta de
//   notas (/app-fuel/rest/wsConsultaColetaNotasPostos: lotes -> postos -> transações e notas eletrônicas/manuais).
//   O lote vai para o título com mais transações em comum (conferido: NFS 54060635 = lote 1038877, 23 de 23).
// TruckPag: NFS = título da API antiga (api.truckpag.com.br: POST /auth com usuário e MD5 da senha -> token; GET
//   /Faturamento/Titulos?dtini&dtfim&todas=S -> [{titulo_id, data_geracao, data_vencimento, valor_total, itens: [{transacao_id,
//   tipo, valor, chave_nfe}]}]); as notas dos postos vêm do XML (API nova, /nota-fiscal-xml) pela chave da NF-e.
//   Só roda com "titulosUsuario" e "titulosSenha" no bloco truckpag de apis-cartoes.json (login diferente do token).
// Passo 4 da migração (23/11/2026): regras sem arquivos próprios (antes em scripts/conciliacao_nfs.mjs, sem mudar regra).
// io = {log, agora(), diaLocal(ms), msLocal('AAAA-MM-DDTHH:MM:SS'), ticket: {host, basic}, truckpag: {hosts, token, titulosUsuario,
// titulosSenha, titulosHost}, md5(texto), base64(texto), ler/gravar(nome) ('titulo-N', 'lote-N', 'truckpag-nf-D', 'truckpag-transacoes-D',
// 'saida'), publicar(chave, objeto), temTempo()?}. temTempo: na nuvem, quando acaba, título/lote recente fica com a leitura anterior.
const CLIENTE = 245364;
const INICIO = '2026-01-01';   // NFS a partir desta data (pedido do usuário)
const FIXO_DIAS = 45;      // título/lote com mais de 45 dias não muda mais: fica do cache
const INTERVALO = 6 * 60 * 60 * 1000;

function cliente(io) {
  const c = io.ticket, H = { Authorization: 'Basic ' + c.basic, 'Content-Type': 'application/json', Accept: 'application/json' };
  const chamar = async (url, opt = {}) => {
    for (let tentativa = 0; ; tentativa++) {
      try {
        const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(60_000), ...opt });
        const t = await r.text();
        return JSON.parse(t);
      } catch (e) { if (tentativa >= 2) throw e; await new Promise((ok) => setTimeout(ok, 2000)); }
    }
  };
  const coleta = (p) => chamar(c.host + '/app-fuel/rest/wsConsultaColetaNotasPostos/' + p);
  return {
    async titulos(de, ate) {
      const j = await chamar(c.host + '/ticketlog-servicos/ebs/titulo/search', { method: 'POST',
        body: JSON.stringify({ codigoCliente: CLIENTE, codigoProduto: 4, dataGeracaoInicial: de + 'T00:00:00', dataGeracaoFinal: ate + 'T23:59:59' }) });
      if (!j.sucesso) throw new Error('títulos: ' + String(j.mensagem || j.errorMessage || '').slice(0, 150));
      return j.listaTitulos || [];
    },
    detalhe: (cod) => chamar(c.host + '/ticketlog-servicos/ebs/titulo/' + cod + '?codigoCliente=' + CLIENTE + '&codigoProduto=4'),
    lotes: (de, ate) => coleta(`consultarLotes?codigoCliente=${CLIENTE}&codigoTipoCartao=4&dataInicial=${de}&dataFinal=${ate}`).then((j) => j.lotes || []),
    postos: (lote) => coleta('consultarEstabelecimentosLote/' + lote).then((j) => j.estabelecimentos || []),
    transacoes: (lote, est) => coleta(`consultarTransacoesEstabelecimento?codigoLote=${lote}&codigoEstabelecimento=${est}`).then((j) => j.transacoes || []),
    eletronicas: (lote, est) => coleta(`consultarNotasEletronicasEstabelecimento?codigoLote=${lote}&codigoEstabelecimento=${est}`).then((j) => j.notas || []),
    manuais: (lote, est) => coleta(`consultarNotasManuaisEstabelecimento?codigoLote=${lote}&codigoEstabelecimento=${est}`).then((j) => j.notas || []),
  };
}

// faz uma lista de tarefas com no máximo n ao mesmo tempo
// inicio: por onde começar a fila (rodízio na nuvem, onde o tempo acaba antes do fim: a cada execução começa num ponto e, em
// poucas execuções, tudo é relido). A posição de cada resultado na saída não muda; sem rodízio (vigia) é a ordem de sempre.
async function emParalelo(itens, n, fn, inicio = 0) {
  const saida = new Array(itens.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, async () => {
    while (i < itens.length) { const k = (inicio + i++) % itens.length; saida[k] = await fn(itens[k]); }
  }));
  return saida;
}

let proxima = 0;
export async function processar(io, { forcar } = {}) {
  const { log } = io, dia = (ms) => io.diaLocal(ms);
  if (!forcar && io.agora() < proxima) return null;
  proxima = io.agora() + INTERVALO;
  const T = cliente(io);
  const recente = () => !io.temTempo || io.temTempo();   // ainda há tempo para reler o que é recente
  // rodízio só com prazo (nuvem): cada execução começa a reler a fila num ponto diferente
  const giro = (n) => (io.temTempo && n ? Math.floor(io.agora() / 6e4) % n : 0);
  const hoje = io.agora(), fixo = dia(hoje - FIXO_DIAS * 864e5), desde = io.msLocal(INICIO + 'T12:00:00');

  // 1) títulos (NFS) em janelas de 31 dias
  const titulos = [];
  for (let ini = desde; ini <= hoje; ini += 31 * 864e5) titulos.push(...(await T.titulos(dia(ini), dia(Math.min(ini + 30 * 864e5, hoje)))));
  const vistos = new Set();
  const nfs = titulos.filter((t) => t.numeroFormularioFiscal && !vistos.has(t.codigoTitulo) && vistos.add(t.codigoTitulo));

  // 2) compras de cada título (cache dos antigos)
  await emParalelo(nfs, 4, async (t) => {
    const arq = 'titulo-' + t.codigoTitulo;
    const g = String(t.dataGeracao).slice(0, 10);
    let d = g < fixo || !recente() ? await io.ler(arq, null) : null;
    if (!d) {
      const j = await T.detalhe(t.codigoTitulo);
      const x = j.titulo || {};
      d = { compras: (x.detalhamentoCompras || []).map((c) => String(c.autorizacao)), valorCompras: x.valorTotalCompras ?? null, nossoNumero: x.nossoNumero || null };
      await io.gravar(arq, d);
    }
    t._d = d;
  }, giro(nfs.length));

  // 3) lotes da coleta (mesmas datas de geração) com postos, transações e notas (cache dos antigos)
  const datas = [...new Set(nfs.map((t) => String(t.dataGeracao).slice(0, 10)))].sort();
  const lotes = [];
  if (datas.length) {
    for (let ini = io.msLocal(datas[0] + 'T12:00:00') - 864e5; ini <= hoje; ini += 32 * 864e5) lotes.push(...(await T.lotes(dia(ini), dia(Math.min(ini + 31 * 864e5, hoje)))));
  }
  const unicos = [...new Map(lotes.map((l) => [l.codigoLote, l])).values()];
  const detalhados = await emParalelo(unicos, 3, async (l) => {
    const arq = 'lote-' + l.codigoLote;
    const g = String(l.dataGeracao).slice(0, 10);
    let d = g < fixo || !recente() ? await io.ler(arq, null) : null;
    if (!d) {
      const postos = await T.postos(l.codigoLote);
      d = { codigoLote: l.codigoLote, dataGeracao: g, postos: await emParalelo(postos, 2, async (p) => ({
        codigo: p.codigoEstabelecimento, nome: p.estabelecimento, valorTotal: p.valorTotal,
        transacoes: (await T.transacoes(l.codigoLote, p.codigoEstabelecimento)).map((x) => String(x.codigoTransacao)),
        notas: [...(await T.eletronicas(l.codigoLote, p.codigoEstabelecimento)).map((n) => ({ ...n, tipo: 'Eletrônica' })),
          ...(await T.manuais(l.codigoLote, p.codigoEstabelecimento)).map((n) => ({ ...n, tipo: 'Manual' }))]
          .map((n) => ({ tipo: n.tipo, numero: n.numero, serie: n.serie || null, dataEmissao: String(n.dataEmissao || '').slice(0, 10) || null,
            razaoSocial: n.razaoSocial || null, cnpj: n.cnpj || null, valor: n.valorTotalNota ?? null, chave: n.chaveAcesso || null })),
      })) };
      await io.gravar(arq, d);
    }
    return d;
  }, giro(unicos.length));

  // 4) cada lote vai para o título com mais transações em comum
  const porCompra = new Map();
  for (const t of nfs) for (const c of t._d.compras) porCompra.set(c, t);
  const notasDe = new Map(nfs.map((t) => [t.codigoTitulo, []]));
  const lotesDe = new Map(nfs.map((t) => [t.codigoTitulo, []]));
  for (const l of detalhados) {
    const conta = new Map();
    for (const p of l.postos) for (const x of p.transacoes) { const t = porCompra.get(x); if (t) conta.set(t, (conta.get(t) || 0) + 1); }
    const [dono] = [...conta.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    if (!dono) continue;
    lotesDe.get(dono.codigoTitulo).push(l.codigoLote);
    for (const p of l.postos) for (const n of p.notas) notasDe.get(dono.codigoTitulo).push({ ...n, posto: p.nome, codigoPosto: p.codigo, lote: l.codigoLote });
    // posto sem nota ainda (recolhimento em andamento)
    for (const p of l.postos) if (!p.notas.length) notasDe.get(dono.codigoTitulo).push({ tipo: 'Sem nota', numero: null, dataEmissao: null, razaoSocial: null, valor: null, posto: p.nome, codigoPosto: p.codigo, lote: l.codigoLote, valorPosto: p.valorTotal });
  }
  let truckpag = [];
  try { truckpag = await nfsTruckpag(io); } catch (e) { log('Conciliação de NFs: TruckPag não respondeu (' + String(e.message || e).slice(0, 150) + ').'); }
  const saida = {
    geradoEm: new Date(io.agora()).toISOString(),
    truckpag: truckpag === null ? 'sem-acesso' : 'ok',
    nfs: [...(truckpag || []), ...nfs.map((t) => ({
      cartao: 'TICKET', numero: String(t.numeroFormularioFiscal), dataEmissao: String(t.dataGeracao).slice(0, 10), vencimento: String(t.dataVencimento || '').slice(0, 10) || null,
      pagamento: t.dataPagamento ? String(t.dataPagamento).slice(0, 10) : null, valor: t.valorTitulo, valorCompras: t._d.valorCompras, nossoNumero: t._d.nossoNumero,
      codigoTitulo: t.codigoTitulo, compras: t._d.compras.length, lotes: lotesDe.get(t.codigoTitulo), notas: notasDe.get(t.codigoTitulo),
    }))].sort((a, b) => b.dataEmissao.localeCompare(a.dataEmissao) || b.numero.localeCompare(a.numero)),
  };
  const anterior = await io.ler('saida', null);
  const nNfs = saida.nfs.length;
  if (anterior && JSON.stringify(anterior.nfs) === JSON.stringify(saida.nfs)) return { nfs: nNfs, mudou: false };
  await io.gravar('saida', saida);
  await io.publicar('conciliacao-nfs', saida);
  const nNotas = saida.nfs.reduce((s, x) => s + x.notas.filter((n) => n.numero).length, 0);
  const nTp = saida.nfs.filter((x) => x.cartao === 'TRUCKPAG').length;
  log(`Conciliação de NFs: ${saida.nfs.length - nTp} NFS da Ticket${truckpag === null ? '' : ', ' + nTp + ' da TruckPag'}, ${nNotas} notas dos postos.`);
  return { nfs: nNfs, notas: nNotas, mudou: true };
}

// ---------- TruckPag (null = sem o login da API de títulos) ----------
async function nfsTruckpag(io) {
  const c = io.truckpag || {}, dia = (ms) => io.diaLocal(ms), agora = () => io.agora();
  if (!c.titulosUsuario || !c.titulosSenha) return null;
  const antiga = c.titulosHost || 'https://api.truckpag.com.br';
  const md5 = await io.md5(String(c.titulosSenha));
  const a = await fetch(antiga + '/auth', { method: 'POST', signal: AbortSignal.timeout(60_000),
    headers: { Authorization: 'Basic ' + io.base64(c.titulosUsuario + ':' + md5) } });
  const aj = await a.json().catch(() => ({}));
  if (!aj.token) throw new Error('login da API de títulos recusado (HTTP ' + a.status + ')');
  const ymd = (ms) => dia(ms).replace(/-/g, '');
  const titulos = [];
  for (let ini = io.msLocal(INICIO + 'T12:00:00'); ini <= agora(); ini += 31 * 864e5) {
    const r = await fetch(antiga + '/Faturamento/Titulos?todas=S&dtini=' + ymd(ini) + '&dtfim=' + ymd(Math.min(ini + 30 * 864e5, agora())),
      { headers: { Authorization: 'Bearer ' + aj.token, Accept: 'application/json' }, signal: AbortSignal.timeout(120_000) });
    const j = await r.json().catch(() => []);
    if (Array.isArray(j)) titulos.push(...j);
  }
  // notas dos postos (XML da API nova) por chave da NF-e, semana a semana, com cache das semanas antigas
  const nova = (c.hosts || []).find((h) => /prd/.test(h)) || 'https://api.prd.truckpag.com.br';
  const porChave = new Map();
  const tag = (x, n) => (x.match(new RegExp('<' + n + '>([^<]*)</' + n + '>')) || [])[1] || null;
  // desde 45 dias antes do início: as notas de um lote podem ter sido emitidas bem antes da data dele
  for (let ini = io.msLocal(INICIO + 'T12:00:00') - 45 * 864e5; ini <= agora(); ini += 7 * 864e5) {
    const de = dia(ini), ate = dia(Math.min(ini + 6 * 864e5, agora()));
    const arq = 'truckpag-nf-' + de;
    let lista = de < dia(agora() - FIXO_DIAS * 864e5) || (io.temTempo && !io.temTempo()) ? await io.ler(arq, null) : null;
    if (!lista) {
      const r = await fetch(nova + '/api/integracao-clientes/nota-fiscal-xml?data_emissao_inicial=' + de + '&data_emissao_final=' + ate,
        { headers: { Authorization: 'Bearer ' + c.token, Accept: 'application/json' }, signal: AbortSignal.timeout(120_000) });
      const j = await r.json().catch(() => ({}));
      const xs = j.data || j.Dados || j;
      lista = (Array.isArray(xs) ? xs : Object.values(xs || {})).filter((x) => typeof x === 'string').map((x) => {
        const emit = x.split('<dest>')[0];
        return { chave: ((x.match(/Id="NFe(\d{44})"/) || [])[1]) || null, razaoSocial: tag(emit, 'xNome'), numero: Number(tag(x, 'nNF')) || null,
          serie: tag(x, 'serie'), dataEmissao: String(tag(x, 'dhEmi') || tag(x, 'dEmi') || '').slice(0, 10) || null, valor: Number(tag(x, 'vNF')) || null };
      });
      await io.gravar(arq, lista);
    }
    for (const n of lista) if (n.chave) porChave.set(n.chave, n);
  }
  // transações sem nota: posto, data e placa vêm do relatório analítico de transações da API nova (janelas de 2 meses,
  // cache das antigas); compra estornada e o estorno dela se anulam e não precisam de nota
  const porTransacao = new Map();
  if (titulos.some((t) => (t.itens || []).some((i) => !i.chave_nfe))) {
    for (let ini = io.msLocal(INICIO + 'T12:00:00') - 45 * 864e5; ini <= agora(); ini += 61 * 864e5) {
      const de = dia(ini), ate = dia(Math.min(ini + 60 * 864e5, agora()));
      const arq = 'truckpag-transacoes-' + de;
      let lista = ate < dia(agora() - FIXO_DIAS * 864e5) || (io.temTempo && !io.temTempo()) ? await io.ler(arq, null) : null;
      if (!lista) {
        const r = await fetch(nova + '/api/integracao-clientes/relatorios/analitico-transacao', { method: 'POST', signal: AbortSignal.timeout(180_000),
          headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ data_inicial: de, data_final: ate }) });
        const j = await r.json().catch(() => ({}));
        lista = (Array.isArray(j.data) ? j.data : []).map((x) => ({ id: String(x.transacao_id), data: String(x.transacao_data || '').slice(0, 16).replace(' ', 'T'),
          posto: x.estabelecimento_nome || null, placa: x.veiculo_placa || null, servico: x.servico_nome || null, valor: Number(x.transacao_valor) || null, status: x.transacao_status || null }));
        await io.gravar(arq, lista);
      }
      for (const x of lista) porTransacao.set(x.id, x);
    }
  }
  return titulos.map((t) => {
    const chaves = [...new Set((t.itens || []).map((i) => String(i.chave_nfe || '')).filter((k) => /^\d{44}$/.test(k)))];
    const notas = chaves.map((k) => porChave.get(k) || { numero: Number(k.slice(25, 34)) || null, serie: null, dataEmissao: null, valor: null, razaoSocial: null, chave: k, semXml: true })
      .map((n) => ({ tipo: n.semXml ? 'Eletrônica (sem XML)' : 'Eletrônica', numero: n.numero, serie: n.serie, dataEmissao: n.dataEmissao, razaoSocial: n.razaoSocial,
        posto: n.razaoSocial || '(posto não identificado)', valor: n.valor, chave: n.chave }));
    const tipo = (i) => String(i.tipo || '').toUpperCase();
    for (const i of (t.itens || []).filter((x) => !x.chave_nfe)) {
      const x = porTransacao.get(String(i.transacao_id)) || {};
      const estornada = tipo(i) === 'ESTORNO' || String(x.status || '').toUpperCase() === 'ESTORNADA';
      notas.push({ tipo: estornada ? 'Estornada' : 'Sem nota', numero: null, dataEmissao: null, valor: null, razaoSocial: null,
        posto: x.posto || '(posto não identificado)', transacao: i.transacao_id, tipoTransacao: tipo(i), dataTransacao: x.data || null,
        placa: x.placa || null, servico: x.servico || null, valorPosto: Number(i.valor) || x.valor || null });
    }
    // compras líquidas do lote: os estornos já vêm negativos (a soma dos itens é o valor do lote)
    const compras = (t.itens || []).reduce((s, i) => s + (Number(i.valor) || 0), 0);
    return { cartao: 'TRUCKPAG', numero: String(t.titulo_id), dataEmissao: String(t.data_geracao || '').slice(0, 10), vencimento: String(t.data_vencimento || '').slice(0, 10) || null,
      pagamento: null, valor: Number(t.valor_total) || null, valorCompras: compras || Number(t.valor_total) || null, codigoTitulo: t.titulo_id,
      compras: (t.itens || []).length, lotes: [], notas };
  }).filter((t) => t.dataEmissao >= INICIO);
}