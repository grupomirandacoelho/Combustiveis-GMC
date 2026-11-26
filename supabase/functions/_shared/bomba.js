// Bomba interna: cálculo do estoque de cada tanque, usado pelo Estoque e pela Inclusão de abastecimento.
//   volume = estoque inicial (medição em inicialEm) + compras (Movimentações) - saídas, tudo depois da medição;
//   saídas = abastecimentos da Base nessa bomba (NOME ESTABELECIMENTO = posto da base, combustível do tanque) +
//            os lançados pelo site que a Base ainda não trouxe (mesma placa, hora e litros);
//   preço médio = média ponderada que se move a cada compra (o abastecimento tira litros, não muda o preço);
//            sem preço inicial e sem compra, vale o último preço da bomba na Base.
import { chaveNome } from './dados.js';

export const NOME_TANQUE = { diesel: 'Diesel S10', arla: 'Arla 32' };
export const COMBUSTIVEL_DO_TANQUE = { diesel: 'DIESEL S-10 COMUM', arla: 'Arla 32' };   // como vai para a Base
export const tanqueDe = (combustivel) => (/ARLA/i.test(combustivel || '') ? 'arla' : /^DIESEL/i.test(combustivel || '') ? 'diesel' : null);
// minutos desde 1970: 'AAAA-MM-DDTHH:MM' (hora local) e dia/segundo dos dados da Base (mesma hora local)
export const minutosDe = (q) => { const [a, m, d, h, mi] = q.match(/\d+/g).map(Number); return Date.UTC(a, m - 1, d, h, mi) / 60000; };
export const minutosDaLinha = (l) => l.dia * 1440 + Math.floor((l.seg || 0) / 60);
export const normPlaca = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export function agoraLocal() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// abastecimentos da CONTROLES\Base_copia (/gestao/dados/base-copia.json) no formato das linhas da Base usado aqui. Os do
// Consolidador entram primeiro na Base_copia; assim saem do estoque sem esperar a Base.xlsx.
export function linhasDaCopia(d) {
  const c = d.col, D = d.dic, txt = (k, i) => (c[k][i] === null ? null : D[k][c[k][i]]);
  return c.linha.map((_, i) => {
    const s = c.dt[i];
    if (typeof s !== 'number') return null;
    const seg = Math.round((s % 1) * 86400);
    return { dia: Math.floor(s) - 25569 + (seg >= 86400 ? 1 : 0), seg: seg % 86400, placa: txt('placa', i), fornecedor: txt('posto', i),
      combustivel: txt('fuel', i), litros: c.litros[i], vlLitro: c.vl[i] };
  }).filter(Boolean);
}
// Base_copia (tem os do Consolidador e as correções do Editar abastecimentos) + o que só a Base tem, sem contar duas vezes
// o mesmo abastecimento: posto, minuto e litros (a placa fica de fora porque pode ter sido corrigida na Base_copia)
export function juntarLinhas(base, copia) {
  if (!copia || !copia.length) return base;
  const chave = (l) => chaveNome(l.fornecedor) + '|' + minutosDaLinha(l) + '|' + Math.round((l.litros || 0) * 100);
  const vistas = new Set(copia.map(chave));
  return copia.concat(base.filter((l) => !vistas.has(chave(l))));
}

// saídas da Base de um posto, por tanque, em ordem de hora (uma passada pelos dados, guardada por posto)
const cacheSaidas = new WeakMap();
function saidasDaBase(linhas, posto) {
  let porPosto = cacheSaidas.get(linhas);
  if (!porPosto) { porPosto = new Map(); cacheSaidas.set(linhas, porPosto); }
  const k = chaveNome(posto);
  if (porPosto.has(k)) return porPosto.get(k);
  const r = { diesel: [], arla: [] };
  for (const l of linhas) {
    if (chaveNome(l.fornecedor) !== k) continue;
    const t = tanqueDe(l.combustivel);
    if (t && l.litros > 0) r[t].push({ t: minutosDaLinha(l), litros: l.litros, preco: l.vlLitro, placa: l.placa, origem: 'base' });
  }
  r.diesel.sort((a, b) => a.t - b.t); r.arla.sort((a, b) => a.t - b.t);
  porPosto.set(k, r);
  return r;
}

export function calcularEstoque(base, tanque, { linhas, movimentacoes, manuais }) {
  const cfg = base.tanques && base.tanques[tanque];
  if (!cfg) return null;
  const t0 = minutosDe(cfg.inicialEm);
  const daBase = saidasDaBase(linhas || [], base.posto)[tanque];
  const saidas = daBase.filter((s) => s.t > t0);
  // lançados pelo site ainda não vistos na Base (a Base pode trazer com alguns segundos de diferença)
  const pendentes = (manuais || []).filter((a) => !a.excluido && a.base_id === base.id && a.tanque === tanque && minutosDe(a.quando) > t0)
    .filter((a) => { const ta = minutosDe(a.quando), p = normPlaca(a.placa);
      return !daBase.some((s) => Math.abs(s.t - ta) <= 1 && Math.abs(s.litros - a.litros) < 0.01 && normPlaca(s.placa) === p); })
    .map((a) => ({ t: minutosDe(a.quando), litros: a.litros, preco: a.preco, placa: a.placa, origem: 'site' }));
  const compras = (movimentacoes || []).filter((m) => m.base_id === base.id && m.tanque === tanque && minutosDe(m.quando) > t0)
    .map((m) => ({ t: minutosDe(m.quando), litros: m.litros, preco: m.valor / m.litros, tipo: 'compra' }));
  const eventos = [...compras, ...saidas.map((s) => ({ ...s, tipo: 'saida' })), ...pendentes.map((s) => ({ ...s, tipo: 'saida' }))]
    .sort((a, b) => a.t - b.t || (a.tipo === 'compra' ? -1 : 1));
  let volume = cfg.inicial, preco = cfg.precoInicial ?? null;
  for (const e of eventos) {
    if (e.tipo === 'compra') {
      preco = volume > 0 && preco !== null ? (volume * preco + e.litros * e.preco) / (volume + e.litros) : e.preco;
      volume += e.litros;
    } else volume -= e.litros;
  }
  if (preco === null) {   // sem preço inicial e sem compra: último preço da bomba na Base
    const ult = [...daBase].reverse().find((s) => s.preco > 0);
    preco = ult ? ult.preco : null;
  }
  const litrosSaida = [...saidas, ...pendentes].reduce((s, x) => s + x.litros, 0);
  const litrosCompra = compras.reduce((s, x) => s + x.litros, 0);
  const ultimaSaida = [...saidas, ...pendentes].reduce((m, s) => (m === null || s.t > m ? s.t : m), null);
  return {
    tanque, capacidade: cfg.capacidade, volume, pct: cfg.capacidade > 0 ? volume / cfg.capacidade : null, preco,
    inicial: cfg.inicial, inicialEm: cfg.inicialEm, litrosSaida, litrosCompra, nSaidas: saidas.length + pendentes.length,
    nPendentes: pendentes.length, nCompras: compras.length, ultimaSaida,
  };
}

// minutos desde 1970 -> 'dd/mm/aaaa hh:mm'
export function fmtMinutos(t) {
  if (t === null || t === undefined) return '—';
  const d = new Date(t * 60000), p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}
export const fmtQuando = (q) => (q ? fmtMinutos(minutosDe(q)) : '—');
