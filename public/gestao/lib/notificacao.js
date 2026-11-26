// Notificações no canto da tela (toast) e o motor das regras de Operacional > Notificações.
//  - mostrarNotificacao({chave, titulo, texto, nivel, acao, aoFechar, sozinha}): aviso com animação de entrada e saída e X.
//    Mesma chave = atualiza o aviso que já está na tela (não empilha repetido). Até 3 na tela; os outros esperam.
//  - TIPOS: catálogo dos tipos de aviso. Cada tipo diz os campos do formulário, as variáveis da mensagem, quem pode receber
//    (precisa) e como verifica (avaliar). Tipo novo = uma entrada nova aqui + a validação em functions/api/notificacoes.
//  - iniciarNotificacoes({pode, usuario}): busca as regras ativas do usuário, carrega só os dados que elas usam, verifica e mostra.
//    Desde 18/11/2026 tudo o que dispara vai para o sino do cabeçalho (evento "centro-notificacoes", listaDoSino()); no canto
//    da tela só aparece o que é de nível crítico.
//    Refaz a cada 10 min, ao chegar dado novo, ao voltar para a aba (no máximo a cada 2 min) e quando uma regra é gravada.
//  - Depois de fechar no X, o aviso só volta conforme a regra ("repetir"). Se a condição deixar de valer, o "fechado" é esquecido.
import { carregarDados, esc, ehDiesel } from './dados.js';
import { NOME_TANQUE, calcularEstoque, linhasDaCopia, juntarLinhas } from './bomba.js';
import { arrastarParaFechar } from './gesto.js';

const MAX_NA_TELA = 3;
const ICONE = { info: 'i-info', alerta: 'i-alerta', critico: 'i-alerta' };
const reduzido = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let pilha = null;
const naTela = new Map();   // chave -> elemento
const fila = [];

function pilhaEl() {
  if (!pilha || !document.body.contains(pilha)) {
    pilha = document.createElement('section');
    pilha.className = 'notif-pilha';
    pilha.setAttribute('aria-label', 'Notificações');
    document.body.appendChild(pilha);
  }
  return pilha;
}

export function mostrarNotificacao(n) {
  const chave = n.chave || 'n' + Math.random().toString(36).slice(2);
  const ja = naTela.get(chave);
  if (ja) { preencher(ja, n); return chave; }
  if (naTela.size >= MAX_NA_TELA) { if (!fila.some((x) => x.chave === chave)) fila.push({ ...n, chave }); return chave; }
  const el = document.createElement('div');
  el.dataset.chave = chave;
  preencher(el, n);
  el.setAttribute('role', n.nivel === 'critico' ? 'alert' : 'status');
  el.addEventListener('click', (e) => {
    if (e.target.closest('.notif-x')) { fecharNotificacao(chave, true); return; }
    if (e.target.closest('.notif-acao')) fecharNotificacao(chave, false);
  });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharNotificacao(chave, true); });
  // celular: arrastar o aviso para o lado fecha (como fechar no X), igual ao menu (18/11/2026)
  arrastarParaFechar(el, { direcoes: [1, -1], esmaecer: true, ativo: () => window.matchMedia('(max-width:820px)').matches,
    aoSair: () => { el.classList.add('arrastado'); fecharNotificacao(chave, true); } });
  naTela.set(chave, el);
  pilhaEl().appendChild(el);
  if (n.sozinha) el._timer = setTimeout(() => fecharNotificacao(chave, false), n.sozinha);
  return chave;
}

export function htmlNotificacao(n, estatica) {
  return '<svg class="notif-ic" aria-hidden="true"><use href="#' + (ICONE[n.nivel] || 'i-info') + '"/></svg>' +
    '<div class="notif-corpo"><strong class="notif-titulo">' + esc(n.titulo || 'Aviso') + '</strong>' +
    (n.texto ? '<p class="notif-texto">' + esc(n.texto) + '</p>' : '') +
    (n.acao ? (estatica ? '<span class="notif-acao">' + esc(n.acao.rotulo) + '</span>' : '<a class="notif-acao" href="' + esc(n.acao.href) + '">' + esc(n.acao.rotulo) + '</a>') : '') + '</div>' +
    (estatica ? '<span class="notif-x" aria-hidden="true"><svg><use href="#i-x"/></svg></span>'
      : '<button type="button" class="notif-x" aria-label="Fechar aviso: ' + esc(n.titulo || '') + '" title="Fechar"><svg aria-hidden="true"><use href="#i-x"/></svg></button>');
}
function preencher(el, n) {
  el.className = 'notif notif-' + (n.nivel || 'info');
  el.innerHTML = htmlNotificacao(n, false);
  if (n.aoFechar) el._aoFechar = n.aoFechar;
}

// pessoa = fechou no X (conta para o "repetir"); false = sumiu sozinho, foi pela ação ou a condição deixou de valer
export function fecharNotificacao(chave, pessoa) {
  const el = naTela.get(chave);
  if (!el) { const i = fila.findIndex((x) => x.chave === chave); if (i >= 0) fila.splice(i, 1); return; }
  naTela.delete(chave);
  clearTimeout(el._timer);
  if (pessoa && el._aoFechar) el._aoFechar();
  let feito = false;
  const tirar = () => { if (feito) return; feito = true; el.remove(); const prox = fila.shift(); if (prox) mostrarNotificacao(prox); };
  el.classList.add('saindo');
  el.addEventListener('animationend', tirar, { once: true });
  setTimeout(tirar, reduzido() ? 150 : 400);   // garante a saída mesmo sem o evento (aba em segundo plano)
}

// ---------------- catálogo dos tipos ----------------
const fmtL = (v) => Math.round(v).toLocaleString('pt-BR');
const fmtRs = (v) => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
const p2 = (x) => String(x).padStart(2, '0');
// horário de Salvador (sem horário de verão) também fora do navegador: a nuvem avalia as regras para o envio ao celular em UTC
// (26/11/2026); no navegador da equipe (Bahia) dá o mesmo de antes
const BAHIA_MS = 3 * 3600e3;
const fmtData = (iso) => { const t = Date.parse(iso); if (isNaN(t)) return '—'; const d = new Date(t - BAHIA_MS); return p2(d.getUTCDate()) + '/' + p2(d.getUTCMonth() + 1) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()); };
const fmtDiaIso = (s) => { const [a, m, d] = String(s || '').split('-'); return d ? d + '/' + m + '/' + a : '—'; };
const hojeIso = () => new Date(Date.now() - BAHIA_MS).toISOString().slice(0, 10);
const somarDiasIso = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };
const isoDeDia = (d) => new Date(d * 864e5).toISOString().slice(0, 10);
const diaHoje = () => Math.floor((Date.now() - BAHIA_MS) / 864e5);   // dias desde 1970 (como o arquivo de abastecimentos), no dia de Salvador
const interno = (l) => /INTERNO/i.test(l.tipoEstab || '') || /^(POSTO INT\b|BOMBA INTERNA)/i.test(l.fornecedor || '');
const combustivelDe = (l) => (ehDiesel(l.combustivel) ? 'diesel' : /ARLA/i.test(l.combustivel || '') ? 'arla' : 'outro');
export function montarTexto(modelo, v) { return String(modelo || '').replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)); }
export function descreverLimite(c) {
  return c.unidade === 'pct' ? String(c.limite).replace('.', ',') + '% da capacidade' : fmtL(c.limite) + ' L';
}
const cartaoNome = { todos: 'qualquer cartão', ticket: 'Ticket', truckpag: 'TruckPag', veloe: 'Veloe' };
// bases de uma regra de estoque baixo: base_ids (lista; vazia = todas). Regras antigas guardavam uma só em base_id.
export const basesDaRegra = (c) => (Array.isArray(c && c.base_ids) ? c.base_ids
  : c && c.base_id !== null && c.base_id !== undefined && c.base_id !== '' ? [Number(c.base_id)] : []);
const unidadeDe = (ctx, placa) => (ctx.dados && ctx.dados.veiculos && ctx.dados.veiculos[placa] ? ctx.dados.veiculos[placa].unidade : null);

// campos: {id, rotulo, tipo: 'select'|'multi'|'numero'|'data', opcoes: [[valor, rótulo]] | 'bases' | 'unidades', padrao, largo}
// avaliar(regra, ctx) -> [{chave, texto}]   ctx = {estoques, dados, contexto: {base, alertasCartao}}
export const TIPOS = {
  'estoque-baixo': {
    rotulo: 'Estoque baixo (bomba interna)', nome: 'Estoque baixo', precisa: 'bomba-estoque', acesso: 'estoque', quem: 'Todos com acesso ao Estoque',
    acao: { rotulo: 'Ver o estoque', href: '#/bomba-estoque' }, usa: ['estoques'],
    campos: [
      { id: 'base_ids', rotulo: 'Bases', tipo: 'multi', opcoes: 'bases', padrao: [], largo: true, dica: 'nenhuma marcada = todas as bases' },
      { id: 'tanque', rotulo: 'Tanque', tipo: 'select', opcoes: [['diesel', 'Diesel S10'], ['arla', 'Arla 32'], ['todos', 'Diesel e Arla']], padrao: 'diesel' },
      { id: 'limite', rotulo: 'Avisar quando ficar abaixo de', tipo: 'numero', padrao: 2000 },
      { id: 'unidade', rotulo: 'Em', tipo: 'select', opcoes: [['litros', 'litros'], ['pct', '% da capacidade do tanque']], padrao: 'litros' },
    ],
    variaveis: ['base', 'tanque', 'volume', 'limite', 'capacidade', 'percentual'],
    mensagem: '{tanque} da base {base} está com {volume} L ({percentual} do tanque), abaixo do limite de {limite}. Programe a compra.',
    exemplo: { base: 'RAJA JEQUIE', tanque: 'Diesel S10', volume: '1.850', limite: '2.000 L', capacidade: '15.000', percentual: '12%' },
    resumo: (c, nomes) => (c.tanque === 'todos' ? 'Diesel e Arla' : NOME_TANQUE[c.tanque]) + ' · ' + (basesDaRegra(c).length ? basesDaRegra(c).map(nomes.base).join(', ') : 'todas as bases') + ' · abaixo de ' + descreverLimite(c),
    avaliar(r, ctx) {
      if (!ctx.estoques) return null;
      const c = r.condicao, out = [], ids = basesDaRegra(c);
      for (const e of ctx.estoques) {
        if (ids.length && !ids.includes(e.base_id)) continue;
        if (c.tanque && c.tanque !== 'todos' && c.tanque !== e.tanque) continue;
        if (!(c.unidade === 'pct' ? e.pct !== null && e.pct * 100 < c.limite : e.volume < c.limite)) continue;
        out.push({ chave: 'r' + r.id + ':' + e.base_id + ':' + e.tanque, onde: e.base + ' · ' + NOME_TANQUE[e.tanque], texto: montarTexto(r.mensagem, {
          base: e.base, tanque: NOME_TANQUE[e.tanque], volume: fmtL(e.volume), limite: descreverLimite(c), capacidade: fmtL(e.capacidade),
          percentual: e.pct === null ? '—' : Math.round(e.pct * 100) + '%' }) });
      }
      return out;
    },
  },
  comunicado: {
    rotulo: 'Comunicado (mensagem livre)', nome: 'Comunicado', precisa: null, acesso: null, quem: 'Todos os usuários', acao: null, usa: [],
    campos: [
      { id: 'de', rotulo: 'Mostrar a partir de', tipo: 'data', padrao: () => hojeIso() },
      { id: 'ate', rotulo: 'Até', tipo: 'data', padrao: () => somarDiasIso(hojeIso(), 7) },
    ],
    variaveis: ['de', 'ate'], mensagem: '', exemplo: { de: fmtDiaIso(hojeIso()), ate: fmtDiaIso(somarDiasIso(hojeIso(), 7)) },
    resumo: (c) => 'De ' + fmtDiaIso(c.de) + ' até ' + fmtDiaIso(c.ate),
    avaliar(r) {
      const h = hojeIso(), c = r.condicao;
      return h >= c.de && h <= c.ate ? [{ chave: 'r' + r.id + ':' + c.de, onde: 'hoje', texto: montarTexto(r.mensagem, { de: fmtDiaIso(c.de), ate: fmtDiaIso(c.ate) }) }] : [];
    },
  },
  'preco-alto': {
    rotulo: 'Preço alto em posto externo', nome: 'Preço alto no posto', precisa: 'dados', acesso: 'dados', quem: 'Quem tem acesso aos painéis de preço',
    acao: { rotulo: 'Ver no mapa de calor', href: '#/mapa-calor' }, usa: ['dados'],
    campos: [
      { id: 'combustivel', rotulo: 'Combustível', tipo: 'select', opcoes: [['diesel', 'Diesel'], ['arla', 'Arla 32'], ['todos', 'Diesel e Arla']], padrao: 'diesel' },
      { id: 'cc', rotulo: 'Unidade', tipo: 'select', opcoes: 'unidades', padrao: null },
      { id: 'modo', rotulo: 'Avisar quando o preço passar de', tipo: 'select', largo: true, opcoes: [['reais', 'um valor em R$ por litro'], ['pct', 'uma % acima da mediana dos postos'],
        ['ultimo_pct', 'uma % acima do último preço pago no mesmo posto'], ['ultimo_cent', 'centavos acima do último preço pago no mesmo posto']], padrao: 'reais' },
      { id: 'limite', rotulo: 'Limite (R$/L, % ou centavos)', tipo: 'numero', padrao: 6.5 },
      { id: 'dias', rotulo: 'Olhar os últimos (dias)', tipo: 'numero', padrao: 1 },
    ],
    variaveis: ['qtd', 'limite', 'dias', 'maior_posto', 'maior_preco', 'ultimo_preco', 'aumento', 'mediana', 'lista'],
    mensagem: '{qtd} abastecimento(s) acima de {limite} nos últimos {dias} dia(s). Mais caro: {maior_posto} ({maior_preco}). {lista}',
    exemplo: { qtd: '3', limite: 'R$ 6,50/L', dias: '1', maior_posto: 'POSTO EXEMPLO (JEQUIÉ)', maior_preco: 'R$ 6,89/L', ultimo_preco: 'R$ 6,59/L', aumento: 'R$ 6,59 → R$ 6,89 (+R$ 0,30, +4,6%)', mediana: 'R$ 6,31/L', lista: 'POSTO EXEMPLO R$ 6,89 · POSTO DOIS R$ 6,62' },
    resumo: (c) => ({ diesel: 'Diesel', arla: 'Arla 32', todos: 'Diesel e Arla' }[c.combustivel] + ' · ' + (c.cc || 'todas as unidades') + ' · acima de ' +
      (c.modo === 'pct' ? fmtPct(c.limite) + ' da mediana' : c.modo === 'ultimo_pct' ? fmtPct(c.limite) + ' do último preço do posto'
        : c.modo === 'ultimo_cent' ? Number(c.limite).toLocaleString('pt-BR') + ' centavo(s) do último preço do posto' : fmtRs(c.limite) + '/L') + ' · últimos ' + c.dias + ' dia(s)'),
    avaliar(r, ctx) {
      if (!ctx.dados) return null;
      const c = r.condicao, desde = diaHoje() - c.dias + 1;
      const ls = ctx.dados.linhas.filter((l) => l.dia >= desde && !interno(l) && l.vlLitro > 0 && (c.combustivel === 'todos' ? combustivelDe(l) !== 'outro' : combustivelDe(l) === c.combustivel) &&
        (!c.cc || l.cc === c.cc));
      if (!ls.length) return [];
      const precos = ls.map((l) => l.vlLitro).sort((a, b) => a - b), meio = (precos.length - 1) / 2;
      const mediana = (precos[Math.floor(meio)] + precos[Math.ceil(meio)]) / 2;
      const porUltimo = c.modo === 'ultimo_pct' || c.modo === 'ultimo_cent';
      // último preço pago no mesmo posto e combustível ANTES de cada abastecimento (toda a história, não só a janela)
      const anterior = new Map();   // também para mostrar o aumento em qualquer opção
      {
        const hist = new Map();
        for (const l of ctx.dados.linhas) {
          if (interno(l) || !(l.vlLitro > 0) || combustivelDe(l) === 'outro') continue;
          const k = l.fornecedor + '|' + combustivelDe(l);
          (hist.get(k) || hist.set(k, []).get(k)).push(l);
        }
        for (const ls2 of hist.values()) {
          ls2.sort((a, b) => a.dia - b.dia || (a.seg ?? 0) - (b.seg ?? 0));
          for (let i = 1; i < ls2.length; i++) anterior.set(ls2[i], ls2[i - 1]);
        }
      }
      const tetoDe = (l) => {
        if (c.modo === 'pct') return mediana * (1 + c.limite / 100);
        if (!porUltimo) return c.limite;
        const a = anterior.get(l);
        if (!a) return Infinity;   // primeiro abastecimento no posto: sem preço anterior para comparar
        return c.modo === 'ultimo_pct' ? a.vlLitro * (1 + c.limite / 100) : a.vlLitro + c.limite / 100;
      };
      const caros = ls.filter((l) => l.vlLitro > tetoDe(l) + 1e-9).sort((a, b) => b.vlLitro - a.vlLitro);
      if (!caros.length) return [];
      const porPosto = new Map();
      for (const l of caros) if (!porPosto.has(l.fornecedor)) porPosto.set(l.fornecedor, l);
      const top = caros[0], antTop = anterior.get(top);
      // "R$ 7,65 → R$ 8,15 (+R$ 0,50, +6,5%)": preço anterior no posto, o pago agora e o aumento
      const aumento = (l) => {
        const a = anterior.get(l);
        if (!a) return fmtRs(l.vlLitro);
        const d = l.vlLitro - a.vlLitro, s = d >= 0 ? '+' : '−';
        return fmtRs(a.vlLitro) + ' → ' + fmtRs(l.vlLitro) + ' (' + s + fmtRs(Math.abs(d)) + ', ' + s + fmtPct(Math.abs(d / a.vlLitro * 100)) + ')';
      };
      const rotLimite = c.modo === 'pct' ? fmtPct(c.limite) + ' da mediana (' + fmtRs(tetoDe(top)) + '/L)'
        : c.modo === 'ultimo_pct' ? fmtPct(c.limite) + ' do último preço pago no posto'
        : c.modo === 'ultimo_cent' ? Number(c.limite).toLocaleString('pt-BR') + ' centavo(s) do último preço pago no posto' : fmtRs(c.limite) + '/L';
      return [{ chave: 'r' + r.id, onde: caros.length + ' abastecimento(s)',
        // o link abre o mapa de calor no período do aviso, já filtrado nos postos citados
        acao: { rotulo: 'Ver no mapa de calor', href: '#/mapa-calor?de=' + isoDeDia(desde) + '&ate=' + isoDeDia(diaHoje()) + '&postos=' + encodeURIComponent([...porPosto.keys()].join('|')) },
        texto: montarTexto(r.mensagem, {
        qtd: String(caros.length), limite: rotLimite, dias: String(c.dias),
        maior_posto: top.fornecedor + (top.cidade ? ' (' + top.cidade + ')' : ''), maior_preco: fmtRs(top.vlLitro) + '/L', mediana: fmtRs(mediana) + '/L',
        ultimo_preco: antTop ? fmtRs(antTop.vlLitro) + '/L' : '—', aumento: antTop ? aumento(top) : '—',
        lista: [...porPosto.values()].slice(0, 3).map((l) => l.fornecedor + ' ' + aumento(l)).join(' · ') +
          (porPosto.size > 3 ? ' e mais ' + (porPosto.size - 3) : '') }) }];
    },
  },
  'falta-cartao': {
    rotulo: 'Falta cartão (aviso do motorista)', nome: 'Falta cartão', precisa: 'cartoes-frota', acesso: 'cartoes', quem: 'Todos com acesso aos Cartões frota',
    acao: { rotulo: 'Ver os pedidos', href: '#/cartoes-frota' }, usa: ['contexto'],
    campos: [
      { id: 'cartao', rotulo: 'Cartão', tipo: 'select', opcoes: [['todos', 'Qualquer cartão'], ['ticket', 'Ticket'], ['truckpag', 'TruckPag'], ['veloe', 'Veloe']], padrao: 'todos' },
      { id: 'cc', rotulo: 'Unidade do veículo', tipo: 'select', opcoes: 'unidades', padrao: null },
      { id: 'minimo', rotulo: 'Avisar com pelo menos (pedidos abertos)', tipo: 'numero', padrao: 1 },
      { id: 'horas', rotulo: 'Só os abertos há mais de (horas; 0 = qualquer)', tipo: 'numero', padrao: 0 },
    ],
    variaveis: ['qtd', 'placas', 'motoristas', 'mais_antigo'],
    mensagem: '{qtd} motorista(s) avisaram que estão sem cartão: {placas}. O pedido mais antigo é de {mais_antigo}.',
    exemplo: { qtd: '2', placas: 'ABC1D23, XYZ4E56', motoristas: 'JOÃO DA SILVA, PEDRO SOUZA', mais_antigo: '04/11 08:15' },
    resumo: (c) => (cartaoNome[c.cartao] || c.cartao) + ' · ' + (c.cc || 'todas as unidades') + ' · ' + c.minimo + '+ pedido(s) aberto(s)' + (c.horas ? ' há mais de ' + c.horas + ' h' : ''),
    avaliar(r, ctx) {
      const a = ctx.contexto && ctx.contexto.alertasCartao;
      if (!a) return null;
      const c = r.condicao, limite = Date.now() - (c.horas || 0) * 3600e3;
      const ls = a.filter((x) => (c.cartao === 'todos' || (x.cartoes || []).includes(c.cartao)) && (!c.horas || new Date(x.criado_em).getTime() <= limite) &&
        (!c.cc || unidadeDe(ctx, x.placa) === c.cc));
      if (ls.length < (c.minimo || 1)) return [];
      const antigo = ls.reduce((m, x) => (!m || x.criado_em < m.criado_em ? x : m), null);
      return [{ chave: 'r' + r.id, onde: ls.length + ' pedido(s)', texto: montarTexto(r.mensagem, {
        qtd: String(ls.length), placas: [...new Set(ls.map((x) => x.placa))].slice(0, 6).join(', ') + (ls.length > 6 ? '…' : ''),
        motoristas: [...new Set(ls.map((x) => x.motorista))].slice(0, 4).join(', ') + (ls.length > 4 ? '…' : ''), mais_antigo: fmtData(antigo.criado_em) }) }];
    },
  },
  'base-desatualizada': {
    rotulo: 'Base desatualizada', nome: 'Base desatualizada', precisa: null, acesso: null, quem: 'Todos os usuários', acao: null, usa: ['contexto'],
    campos: [
      { id: 'planilha', rotulo: 'Planilha', tipo: 'select', opcoes: [['base', 'Base.xlsx'], ['copia', 'Base_copia (CONTROLES)'], ['ambas', 'Qualquer uma das duas']], padrao: 'base' },
      { id: 'horas', rotulo: 'Avisar depois de (horas sem atualizar)', tipo: 'numero', padrao: 24 },
    ],
    variaveis: ['planilha', 'horas', 'desde', 'limite'],
    mensagem: 'A {planilha} está há {horas} h sem atualizar no portal (última em {desde}). Atualize para os painéis mostrarem os abastecimentos novos.',
    exemplo: { planilha: 'Base.xlsx', horas: '30', desde: '04/11 09:23', limite: '24 h' },
    resumo: (c) => ({ base: 'Base.xlsx', copia: 'Base_copia', ambas: 'Base.xlsx ou Base_copia' }[c.planilha] + ' · mais de ' + c.horas + ' h sem atualizar'),
    avaliar(r, ctx) {
      const b = ctx.contexto && ctx.contexto.base;
      if (!b) return null;
      const c = r.condicao, out = [];
      const ver = (nome, quando, k) => {
        if (!quando) return;
        const h = (Date.now() - new Date(quando).getTime()) / 3600e3;
        if (h >= c.horas) out.push({ chave: 'r' + r.id + ':' + k, onde: nome, texto: montarTexto(r.mensagem, { planilha: nome, horas: String(Math.floor(h)), desde: fmtData(quando), limite: c.horas + ' h' }) });
      };
      if (c.planilha !== 'copia') ver('Base.xlsx', b.baseSalvaEm || b.geradoEm, 'base');
      if (c.planilha !== 'base') ver('Base_copia', b.copiaEm, 'copia');
      return out;
    },
  },
};

// ---------------- dados que os tipos usam ----------------
async function obter(url) {
  const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
// volume de cada tanque das bases ativas (a mesma conta da tela Estoque). Sem rede: também usada pela nuvem no envio ao celular.
// dados = arquivo dos painéis decodificado; bases/movimentacoes/manuais como vêm das rotas /api/bomba/*; copia = base-copia.json
export function calcularEstoques({ dados, bases, movimentacoes, manuais, copia }) {
  const linhas = copia ? juntarLinhas(dados.linhas, linhasDaCopia(copia)) : dados.linhas;
  const res = [];
  for (const base of bases.filter((x) => x.ativo)) {
    for (const t of ['diesel', 'arla']) {
      const e = calcularEstoque(base, t, { linhas, movimentacoes, manuais });
      if (e) res.push({ base_id: base.id, base: base.nome, tanque: t, volume: e.volume, capacidade: e.capacidade, pct: e.pct });
    }
  }
  return res;
}
// as bases que o login vê (as rotas já filtram por login)
export async function carregarEstoques() {
  const [d, b, m, a, c] = await Promise.all([carregarDados({ tempoReal: true }), obter('/api/bomba/bases'), obter('/api/bomba/movimentacoes'), obter('/api/bomba/abastecimentos'),
    fetch('/gestao/dados/base-copia.json', { credentials: 'same-origin', cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
  return calcularEstoques({ dados: d, bases: b.bases, movimentacoes: m.movimentacoes, manuais: a.abastecimentos, copia: c });
}
// carrega só o que as regras usam; o que o login não pode ver fica null (o tipo não dispara para ele)
export async function carregarContexto(regras, pode, contexto) {
  const tipos = new Set(regras.map((r) => r.tipo));
  const precisaDados = [...tipos].some((t) => TIPOS[t] && TIPOS[t].usa.includes('dados')) || regras.some((r) => r.tipo === 'falta-cartao' && r.condicao.cc);
  const ctx = { contexto: contexto || {}, estoques: null, dados: null };
  await Promise.all([
    tipos.has('estoque-baixo') && pode('bomba-estoque') ? carregarEstoques().then((e) => { ctx.estoques = e; }).catch(() => {}) : null,
    precisaDados ? carregarDados({ tempoReal: true }).then((d) => { ctx.dados = d; }).catch(() => {}) : null,
  ]);
  return ctx;
}
// o que dispara agora: [{regra, chave, texto, onde}] (null do tipo = sem dados para verificar)
export function avaliar(regras, ctx) {
  const out = [];
  for (const r of regras) {
    const t = TIPOS[r.tipo];
    const x = t ? t.avaliar(r, ctx) : null;
    if (x) for (const o of x) out.push({ regra: r, ...o, titulo: r.nome });
  }
  return out;
}

// "fechado no X": guardado por login e por ocorrência
const chaveFechado = (uid, k) => 'notif-fechada:' + uid + ':' + k;
function lerFechado(uid, k, repetir) {
  try {
    if (repetir === 'sessao') return sessionStorage.getItem(chaveFechado(uid, k)) !== null;
    const em = Number(localStorage.getItem(chaveFechado(uid, k)));
    if (!em) return false;
    if (repetir === 'diaria') return new Date(em).toDateString() === new Date().toDateString();
    const h = Number(String(repetir).split(':')[1]) || 24;
    return Date.now() - em < h * 3600e3;
  } catch { return false; }
}
function marcarFechado(uid, k, repetir) {
  try { (repetir === 'sessao' ? sessionStorage : localStorage).setItem(chaveFechado(uid, k), String(Date.now())); } catch {}
}
function esquecerFechado(uid, k) {
  try { localStorage.removeItem(chaveFechado(uid, k)); sessionStorage.removeItem(chaveFechado(uid, k)); } catch {}
}

// ---------------- sino do cabeçalho ----------------
// hora em que cada aviso apareceu pela primeira vez (fica enquanto ele continuar disparando): mostra no sino e marca "lida"
function horasDesde(uid, chaves) {
  const k = 'notif-desde:' + uid;
  let m = {};
  try { m = JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch {}
  const novo = {};
  for (const c of chaves) novo[c] = m[c] || Date.now();
  try { localStorage.setItem(k, JSON.stringify(novo)); } catch {}
  return novo;
}
let doSino = { uid: '', itens: [] };
export const listaDoSino = () => doSino;
function publicarSino(uid, itens) {
  const ordem = { critico: 0, alerta: 1, info: 2 };
  itens.sort((a, b) => (ordem[a.nivel] ?? 3) - (ordem[b.nivel] ?? 3) || b.desde - a.desde);
  doSino = { uid, itens };
  window.dispatchEvent(new CustomEvent('centro-notificacoes', { detail: doSino }));
}

export function iniciarNotificacoes({ pode, usuario }) {
  if (!usuario) return;
  const uid = usuario.usuario || usuario.id || usuario.nome;   // login (o /api/me não traz o id)
  const ativas = new Set();   // ocorrências que estavam disparando na última volta
  let rodando = false, ultima = 0;
  async function rodar(forcar) {
    if (rodando || document.hidden || (forcar !== true && ultima && Date.now() - ultima < 2 * 60 * 1000)) return;
    rodando = true; ultima = Date.now();
    try {
      const { regras, contexto } = await obter('/api/notificacoes?minhas=1');
      const minhas = regras.filter((r) => TIPOS[r.tipo] && (!TIPOS[r.tipo].precisa || TIPOS[r.tipo].precisa === 'dados' || pode(TIPOS[r.tipo].precisa)));
      const ctx = minhas.length ? await carregarContexto(minhas, pode, contexto) : {};
      const agora = avaliar(minhas, ctx);
      const chaves = new Set(agora.map((x) => x.chave));
      for (const k of [...ativas]) if (!chaves.has(k)) { esquecerFechado(uid, k); fecharNotificacao(k, false); ativas.delete(k); }
      const desde = horasDesde(uid, chaves);
      publicarSino(uid, agora.map((x) => ({ chave: x.chave, titulo: x.titulo, texto: x.texto, nivel: x.regra.nivel,
        acao: x.acao || TIPOS[x.regra.tipo].acao, desde: desde[x.chave] })));
      for (const x of agora) {
        ativas.add(x.chave);
        if (x.regra.nivel !== 'critico') continue;   // no canto da tela só o crítico; o resto fica no sino
        if (lerFechado(uid, x.chave, x.regra.repetir)) continue;
        mostrarNotificacao({ chave: x.chave, titulo: x.titulo, texto: x.texto, nivel: x.regra.nivel, acao: x.acao || TIPOS[x.regra.tipo].acao,
          aoFechar: () => marcarFechado(uid, x.chave, x.regra.repetir) });
      }
    } catch { /* sem rede ou sem acesso: tenta de novo na próxima volta */ }
    finally { rodando = false; }
  }
  setTimeout(() => rodar(true), 1500);   // deixa a página abrir primeiro
  setInterval(() => rodar(true), 10 * 60 * 1000);
  window.addEventListener('dados-atualizados', () => rodar(true));
  window.addEventListener('notificacoes-mudaram', () => rodar(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) rodar(false); });
}
