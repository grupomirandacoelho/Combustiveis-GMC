// Carrega os abastecimentos gerados por scripts/importar_base.py e oferece formatação pt-BR.
import { chaveLinha } from './tempo-real.js';

let promessa = null;
let versaoAtual = null;
let etagBase = '';

// placas desabilitadas no cadastro de Placas: saem das listas e escolhas (filtro Placa, bomba interna, Consulta de KM,
// Editar abastecimentos); os totais continuam com os abastecimentos delas. Carregadas junto com os dados.
let desabilitadas = new Set(), promessaDesab = null;
const normPlaca = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const placaDesabilitada = (p) => desabilitadas.has(normPlaca(p));
export function carregarDesabilitadas() {
  if (!promessaDesab) {
    promessaDesab = fetch('/api/placas-desabilitadas', { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { placas: [] })).then((j) => { desabilitadas = new Set((j.placas || []).map(normPlaca)); })
      .catch(() => { promessaDesab = null; });
  }
  return promessaDesab;
}

// Arquivo dos painéis + transações das APIs em tempo real, baixados uma vez e usados de dois jeitos (26/11/2026):
//  - carregarDados(): os DASHBOARDS. Com os dados publicados (botão do Editar abastecimentos), só o que foi publicado (até D-1),
//    sem o tempo real;
//  - carregarDados({tempoReal: true}): as telas de OPERAÇÃO (Estoque, Lançar abastecimento, Cartões frota, Consulta de KM, Postos
//    dos motoristas, Rodada de preços, avisos): sempre com as transações das APIs de hoje (o estoque da bomba precisa descontar
//    as saídas de hoje; sem elas ficou acima do portal da TruckPag).
let promessaBruto = null, promessaOp = null;
function carregarBruto() {
  if (!promessaBruto) {
    const base = fetch('/gestao/dados/abastecimentos.json', { credentials: 'same-origin' })
      .then(async (r) => {
        if (r.status === 401 || r.redirected) { location.href = '/?entrar=1'; throw new Error('sessão'); }
        if (r.status === 503) throw new Error('Os dados ainda não foram gerados. Tente de novo em alguns minutos.');
        if (!r.ok) throw new Error('Não foi possível carregar os dados (' + r.status + ').');
        // versão = ETag (sem aspas), a mesma que o /api/dados/versao devolve: com os dados do banco ela junta a versão dos
        // abastecimentos e a das partes (negociações, coordenadas, orçamento); com a planilha é a versão da carga do vigia
        etagBase = String(r.headers.get('ETag') || '').replace(/^W\//, '').replace(/"/g, '');
        return r.json();
      });
    // transações das APIs dos cartões (Ticket Log e TruckPag) que ainda não estão na Base (scripts/cartoes_api.mjs). Sem elas
    // (ainda não enviadas, erro), fica só a Base.
    const tempoReal = fetch('/gestao/dados/tempo-real.json', { credentials: 'same-origin', cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    promessaBruto = Promise.all([base, tempoReal, carregarDesabilitadas()]).then(([bruto, tr]) => ({ bruto, tr }))
      .catch((e) => { promessaBruto = null; throw e; });
  }
  return promessaBruto;
}
export function carregarDados(o = {}) {
  if (o.tempoReal) {
    if (!promessaOp) {
      promessaOp = carregarBruto().then(({ bruto, tr }) => (bruto.publicadoAte ? decodificar(bruto, tr, { tempoReal: true }) : carregarDados()))
        .catch((e) => { promessaOp = null; throw e; });
    }
    return promessaOp;
  }
  if (!promessa) {
    promessa = carregarBruto()
      .then(({ bruto, tr }) => {
        // mesma combinação do /api/dados/versao: a versão muda quando chega transação nova pela API (menos com os dados
        // publicados: aí o tempo real não entra nos dashboards, ver decodificar)
        const trUsado = bruto.publicadoAte ? null : tr;
        versaoAtual = (etagBase || bruto.versao || bruto.geradoEm) + (trUsado && trUsado.versao ? '+' + trUsado.versao : '');
        return decodificar(bruto, tr);
      })
      .catch((e) => { promessa = null; throw e; });
  }
  return promessa;
}

// Descarta a cópia em memória e busca de novo (o navegador só baixa se a versão mudou).
export function recarregarDados() { promessa = null; promessaOp = null; promessaBruto = null; promessaDesab = null; return carregarDados(); }

// Versão que está na tela e versão que está no servidor.
export const versaoCarregada = () => versaoAtual;
export function versaoNoServidor() {
  return fetch('/api/dados/versao', { credentials: 'same-origin', cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}

// Transforma o formato colunar em linhas prontas para filtrar e somar. tr = transações em tempo real (APIs dos cartões),
// no mesmo formato colunar: entram no fim, com tempoReal: true.
// A transação do tempo real que a base já tem (mesma placa, minuto e litros) não entra de novo: desde 19/11/2026 a base vem do
// banco, que recebe o D-1 antes de o tempo real ser refeito (17 e 18/11 chegaram a aparecer em dobro).
export function juntarTempoReal(linhas, doTempoReal) {
  const ja = new Set(linhas.map((l) => chaveLinha(l.placa, l.dia, l.seg, l.litros)));
  let repetidas = 0;
  for (const l of doTempoReal) {
    if (ja.has(chaveLinha(l.placa, l.dia, l.seg, l.litros))) repetidas++;
    else linhas.push(l);
  }
  return repetidas;
}
// sem rede: também usada pela nuvem (envio das notificações ao celular, 26/11/2026)
export function decodificar(bruto, tr, o = {}) {
  // dados publicados pelo Editar abastecimentos (26/11/2026, decisão do usuário: os dashboards só mudam ao publicar, até D-1):
  // nos dashboards as transações das APIs que ainda não foram publicadas não entram; nas telas de operação (o.tempoReal) entram
  if (bruto.publicadoAte && !o.tempoReal) tr = null;
  const linhas = linhasDe(bruto, bruto.veiculos, false);
  // o aviso de tempo real conta só as que entraram (porCartao fica como veio do vigia)
  const entraram = tr && tr.linhas ? tr.linhas - juntarTempoReal(linhas, linhasDe(tr, bruto.veiculos, true)) : 0;
  return montar(bruto, linhas, tr && tr.linhas ? { ...tr, linhas: entraram } : tr);
}
function linhasDe(bruto, veiculos, tempoReal) {
  const { dic, col } = bruto;
  const n = bruto.linhas;
  const linhas = new Array(n);
  const fora = new Set(bruto.foraAbastecimento || []);   // SERVICO diferente de "Abastecimento" (poucas linhas)
  for (let i = 0; i < n; i++) {
    const placa = dic.placa[col.placa[i]];
    const v = veiculos[placa] || null;
    const km = col.km[i] || 0;
    const litros = col.litros[i] || 0;
    const meta = v && v.meta ? v.meta : null;
    linhas[i] = {
      dia: col.data[i],                       // dias desde 1970-01-01
      seg: col.seg ? col.seg[i] : null,       // hora da transação, em segundos desde a meia-noite
      placa,
      motorista: dic.motorista[col.motorista[i]] || '(sem motorista)',
      combustivel: dic.combustivel[col.combustivel[i]],
      cc: dic.cc[col.cc[i]] || '(sem centro de custo)',
      fornecedor: dic.fornecedor[col.fornecedor[i]],
      cidade: dic.cidade[col.cidade[i]],
      campanha: col.campanha[i],              // 1 sim, 0 não, null sem registro
      tipoEstab: col.tipo_estab ? (dic.tipo_estab[col.tipo_estab[i]] || '(sem tipo)') : '(sem tipo)',
      // cartão usado (TICKET, TRUCKPAG, VELOE, VIBRA; '' sem informação); undefined em dados enviados antes desta coluna
      cartao: col.cartao ? dic.cartao[col.cartao[i]] : undefined,
      abastecimento: !fora.has(i),
      cc3: dic.cc[col.cc[i]] || '',            // INFORMACAO ADIDIONAL 3 como veio (vazio fica vazio)
      km, litros,
      hodometro: col.hodometro[i],
      vlLitro: col.vl_litro[i],
      despesa: col.despesa[i] || 0,
      categoria: v ? v.categoria : null,
      modelo: v && v.modelo ? v.modelo : '(sem modelo)',
      ano: v && v.ano ? v.ano : null,
      meta,
      tanque: v ? v.tanque : null,
      // mesma regra do Power BI: litros que a meta permitiria para o km rodado
      litrosMeta: meta ? km / meta : 0,
      tempoReal,                              // veio da API do cartão e ainda não está na Base (planilha)
    };
  }
  return linhas;
}
function montar(bruto, linhas, tr) {
  const { veiculos } = bruto;
  let min = Infinity, max = -Infinity;
  for (const l of linhas) { if (l.dia < min) min = l.dia; if (l.dia > max) max = l.dia; }
  // preços negociados para as bombas internas: uma linha por dia × fornecedor × produto × unidade
  const negociacao = [];
  if (bruto.negociacao) {
    const nd = bruto.negociacao.dic, nc = bruto.negociacao.col;
    for (let i = 0; i < nc.data.length; i++) {
      negociacao.push({
        dia: nc.data[i], fornecedor: nd.fornecedor[nc.fornecedor[i]],
        produto: nd.produto[nc.produto[i]], unidade: nd.unidade[nc.unidade[i]], preco: nc.preco[i],
      });
    }
  }
  // negociações com os postos externos (planilha "Gestão de negociações de preço"), na ordem em que foram gravadas
  const negPostos = [];
  if (bruto.negPostos) {
    const pd = bruto.negPostos.dic, pc = bruto.negPostos.col;
    for (let i = 0; i < pc.data.length; i++) {
      negPostos.push({
        ordem: i, dia: pc.data[i], unidade: pd.unidade[pc.unidade[i]], posto: pd.posto[pc.posto[i]],
        cidade: pd.cidade[pc.cidade[i]], tipo: pd.tipo[pc.tipo[i]], plataforma: pd.plataforma[pc.plataforma[i]],
        combustivel: pd.combustivel[pc.combustivel[i]], status: pd.status[pc.status[i]], contato: pd.contato[pc.contato[i]],
        aviso: pd.aviso[pc.aviso[i]], valor: pc.valor[i], transDia: pc.trans_dia[i], transSeg: pc.trans_seg[i],
      });
    }
  }
  return {
    linhas, geradoEm: bruto.geradoEm, versao: bruto.versao, diaMin: min, diaMax: max,
    negociacao, fornecedoresBomba: bruto.fornecedoresBomba || null, locais: bruto.locais || {}, locaisSuspeitos: bruto.locaisSuspeitos || [], enderecos: bruto.enderecos || {}, veiculos: veiculos || {},
    orcamento: bruto.orcamento || null,   // {arquivo, unidades: [[unidade, inf]], linhas: [[unidade, natureza, 'AAAA-MM', valor]]}
    negPostos, limitesNeg: (bruto.negPostos && bruto.negPostos.limites) || { diasSemAtualizacao: 15, variacao: 0.1, diasRenegociacao: 90 },
    // transações das APIs dos cartões ainda fora da Base: quantas, até quando e quando foram lidas
    tempoReal: tr && tr.linhas ? { n: tr.linhas, geradoEm: tr.geradoEm, ate: tr.ate || null, porCartao: tr.porCartao || null } : null,
  };
}

// todo tipo de diesel (S-10, S-10 aditivado, comum, "DIESEL"...) conta junto nos painéis: é o mesmo tanque do caminhão
export const ehDiesel = (combustivel) => String(combustivel || '').toUpperCase().includes('DIESEL');

// nome sem acento, maiúsculo e com espaços simples: liga o posto da planilha de negociações ao das transações
export function chaveNome(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

// momento de uma transação (dia + segundos) como número comparável e como texto ISO local
export const momento = (dia, seg) => dia * 86400 + (seg || 0);
export function momentoIso(dia, seg) {
  const p = (n) => String(n).padStart(2, '0'), s = seg || 0;
  return diaIso(dia) + 'T' + p(Math.floor(s / 3600)) + ':' + p(Math.floor(s / 60) % 60) + ':' + p(s % 60);
}

// ---------- datas ----------
const DIA_MS = 86400000;
export const diaParaData = (d) => new Date(d * DIA_MS);
export const dataParaDia = (dt) => Math.floor(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()) / DIA_MS);
export function diaIso(d) { return diaParaData(d).toISOString().slice(0, 10); }
export function isoParaDia(s) { const [a, m, d] = s.split('-').map(Number); return Math.floor(Date.UTC(a, m - 1, d) / DIA_MS); }
const fData = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
export function fmtDia(d) { return fData.format(diaParaData(d)); }
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export function mesDoDia(d) { const x = diaParaData(d); return x.getUTCFullYear() * 12 + x.getUTCMonth(); }
export function fmtMes(m, longo) { const a = Math.floor(m / 12); return MESES[m % 12] + (longo ? ' de ' : '/') + (longo ? a : String(a).slice(2)); }
export function inicioDoMes(m) { return Math.floor(Date.UTC(Math.floor(m / 12), m % 12, 1) / DIA_MS); }

// ---------- números ----------
const f0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const f1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const f2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const f3 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const fMoeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const fPct = new Intl.NumberFormat('pt-BR', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });   // 2 casas em todo o portal (pedido do usuário, 06/11/2026)

const ok = (v) => v !== null && v !== undefined && isFinite(v);
export const fmt = {
  int: (v) => (ok(v) ? f0.format(v) : '—'),
  d1: (v) => (ok(v) ? f1.format(v) : '—'),
  d2: (v) => (ok(v) ? f2.format(v) : '—'),
  d3: (v) => (ok(v) ? f3.format(v) : '—'),
  moeda: (v) => (ok(v) ? fMoeda.format(v) : '—'),
  pct: (v) => (ok(v) ? fPct.format(v) : '—'),
  // 1.234.567 -> "1,23 mi"
  curto(v) {
    if (!ok(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e6) return f2.format(v / 1e6) + ' mi';
    if (a >= 1e4) return f1.format(v / 1e3) + ' mil';
    return f0.format(v);
  },
};

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
