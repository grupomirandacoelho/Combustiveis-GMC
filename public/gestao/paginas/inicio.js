// Início da gestão: resumo geral com os números principais de cada painel que o login pode abrir.
// Cada número segue as MESMAS regras do painel de origem (ver o comentário no topo de cada dashboards/*.js) e cada
// bloco é um link para o painel. O mês do resumo é o do último abastecimento da Base, comparado com os mesmos dias
// do mês anterior. Os abastecimentos (~60 mil linhas) são somados numa passada só.
import { carregarDados, fmt, esc, fmtDia, mesDoDia, inicioDoMes, dataParaDia, diaIso, chaveNome, ehDiesel } from '../lib/dados.js';
import { statusHtml, faixaMeta } from '../lib/filtros.js';
import { htmlMedidor, graficoPeriodo } from '../lib/graficos.js';

// ---------- regras dos painéis ----------
const CATEGORIAS_FORA = new Set(['PICAPE', 'VENDA']);                                  // Despesas, Operação, Evolução
const DIESEL = { has: ehDiesel };   // todo tipo de diesel (lib/dados.js)     // Operação, Média geral, Evolução
const CATEGORIAS_MG = new Set(['3/4', 'BITRUCK', 'CAVALO', 'TOCO', 'TRUCK']);        // Média geral
const MOTORISTAS_FORA_EV = new Set(['ANTONIO MARCOS GOCALVES SOUSA', 'GUILHERME DE ALMEIDA RODRIGUES', 'VITOR FERNANDES COELHO']);   // Evolução placas
const DIESEL_POSTOS = { has: ehDiesel };   // todo tipo de diesel (lib/dados.js)                      // Preço postos externos
const POSTO = 'POSTO DE COMBUSTIVEL';
const TOLERANCIA = 0.005;            // R$/L: diferença de arredondamento não conta como acima/abaixo
const PRECO_MIN = 3, PRECO_MAX = 12; // Preço x ANP: fora disso é erro de digitação na Base
const SEMANAS_ANP = 4;               // Preço x ANP: últimas semanas com pesquisa da ANP e abastecimento nosso
const GATILHO = 0.05;                // Contratos x ANP: o contrato muda quando a ANP varia mais de 5%
const UFS = new Set(['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR',
  'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO']);

const semana = (dia) => dia - ((dia + 4) % 7);   // domingo da semana, como a "DATA INICIAL" da ANP
const rs = (v) => (v === null || v === undefined || !isFinite(v) ? '—' : 'R$ ' + fmt.d3(v));
const sinal = (v, f) => (v === null || v === undefined || !isFinite(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v)));
const variacao = (a, b) => (b ? a / b - 1 : null);
const nomeMes = (m) => new Date(Date.UTC(Math.floor(m / 12), m % 12, 1)).toLocaleDateString('pt-BR', { month: 'long', timeZone: 'UTC' });
const novo = () => ({ despesa: 0, litros: 0, km: 0, litrosMeta: 0, qtd: 0 });
function somar(a, l) { a.despesa += l.despesa; a.litros += l.litros; a.km += l.km; a.litrosMeta += l.litrosMeta; a.qtd++; }

// mesma situação da planilha de negociações (Preço postos externos)
function situacaoNeg(n, lim) {
  if (!n || n.transDia === null) return 0;
  const dias = n.dia - n.transDia;
  return dias > lim.diasRenegociacao ? 2 : dias > lim.diasSemAtualizacao ? 1 : 0;
}

async function obterJson(arquivo) {
  const r = await fetch('/gestao/dados/' + arquivo, { credentials: 'same-origin' });
  if (r.status === 401 || r.redirected) throw new Error('sessão');
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

const SEMANAS_ESPERADO = 12;   // gráfico de gasto diário: o esperado de cada dia vem das 12 semanas anteriores
const SEMANA_TXT = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

// ---------- uma passada pelos abastecimentos ----------
function resumir(d, quer) {
  const m = mesDoDia(d.diaMax);
  const de = inicioDoMes(m), ate = d.diaMax;
  // comparação: mês completo contra o mês anterior inteiro; mês em andamento contra os MESMOS DIAS DA SEMANA de 4 semanas antes
  // (28 dias). "Mesmos dias do mês anterior" misturava domingos e feriados de forma diferente (01-09/11/2026 tinha 2 domingos e
  // Finados; 01-09/10, 1 domingo): litros e gasto apareciam -40% só pelo calendário (10/11/2026).
  const completo = mesDoDia(ate + 1) !== m;
  const deA = completo ? inicioDoMes(m - 1) : de - 28, ateA = completo ? Math.min(inicioDoMes(m - 1) + (ate - de), de - 1) : ate - 28;
  const semMin = semana(ate) - 7 * 16;   // Preço x ANP: só as semanas recentes interessam
  const r = {
    m, de, ate, deA, ateA, completo,
    desp: [novo(), novo()], dsl: [novo(), novo()], om: [novo(), novo()], mg: [novo(), novo()],   // dsl: só diesel (litros e preço do início)
    placas: new Map(),                              // Evolução: placa -> somas do mês
    pp: { acima: 0, qtdNeg: 0, qtdAcima: 0, postos: new Set() },
    anpSem: new Map(),                              // Preço x ANP: domingo -> {litros, valor} em postos externos
    combDiesel: new Set(),                          // nomes de diesel que aparecem (filtro do link da Média geral)
    dias: new Map(),                                // Despesas: dia do mês -> gasto (gráfico do início)
    diasHist: new Map(),                            // dia -> gasto nas 12 semanas antes do mês (esperado por dia da semana)
    mgCat: new Map(),                               // Média geral: categoria -> somas do mês
  };

  // Preço postos externos: negociações de cada posto em ordem de data (e de gravação, no mesmo dia)
  let negPorPosto = null;
  const chaves = new Map();   // fornecedor -> chaveNome (evita normalizar o mesmo nome milhares de vezes)
  const chave = (s) => { let k = chaves.get(s); if (k === undefined) chaves.set(s, (k = chaveNome(s))); return k; };
  if (quer.pp) {
    negPorPosto = new Map();
    for (const n of d.negPostos) {
      const k = chaveNome(n.posto);
      if (!negPorPosto.has(k)) negPorPosto.set(k, []);
      negPorPosto.get(k).push(n);
    }
    negPorPosto.forEach((l) => l.sort((a, b) => a.dia - b.dia || a.ordem - b.ordem));
  }

  for (const l of d.linhas) {
    // gasto por dia das 12 semanas antes do mês (o "esperado" de cada dia = média dos mesmos dias da semana)
    if (l.dia >= de - SEMANAS_ESPERADO * 7 && l.dia < de && l.categoria && !CATEGORIAS_FORA.has(l.categoria)) r.diasHist.set(l.dia, (r.diasHist.get(l.dia) || 0) + l.despesa);
    const b = l.dia >= de && l.dia <= ate ? 0 : l.dia >= deA && l.dia <= ateA ? 1 : -1;
    if (b >= 0) {
      const diesel = DIESEL.has(l.combustivel);
      if (diesel) r.combDiesel.add(l.combustivel);
      if (l.categoria && !CATEGORIAS_FORA.has(l.categoria)) {
        somar(r.desp[b], l);                                       // Despesas: todos os combustíveis
        if (diesel) somar(r.dsl[b], l);                            // litros e preço médio: só diesel (Arla ~R$ 2,30 puxava o preço para baixo)
        if (b === 0) r.dias.set(l.dia, (r.dias.get(l.dia) || 0) + l.despesa);
        if (diesel) {
          somar(r.om[b], l);                                       // Operação por motorista
          if (b === 0 && !MOTORISTAS_FORA_EV.has(l.motorista)) {   // Evolução placas
            let p = r.placas.get(l.placa);
            if (!p) r.placas.set(l.placa, (p = novo()));
            somar(p, l);
          }
        }
      }
      if (diesel && CATEGORIAS_MG.has(l.categoria)) {                     // Média geral
        somar(r.mg[b], l);
        if (b === 0) { let c = r.mgCat.get(l.categoria); if (!c) r.mgCat.set(l.categoria, (c = novo())); somar(c, l); }
      }
      if (b === 0 && negPorPosto && l.tipoEstab === POSTO && DIESEL_POSTOS.has(l.combustivel) && l.vlLitro > 0) {
        const k = chave(l.fornecedor);
        r.pp.postos.add(k);
        const negs = negPorPosto.get(k);
        let vigente = null;
        if (negs) for (const n of negs) { if (n.dia > l.dia) break; if (n.valor || /BLOQUE/.test(n.status || '')) vigente = n; }
        // posto bloqueado: o preço da planilha é o de quando foi bloqueado, não serve de negociado (13/11/2026)
        if (vigente && !/BLOQUE/.test(vigente.status || '')) {
          r.pp.qtdNeg++;
          const dif = l.vlLitro - vigente.valor;
          if (dif > TOLERANCIA) { r.pp.acima += dif * l.litros; r.pp.qtdAcima++; }
        }
      }
    }
    if (quer.anp && l.dia >= semMin && l.tipoEstab === POSTO && /^DIESEL/.test(l.combustivel || '') && l.litros > 0 &&
        l.vlLitro >= PRECO_MIN && l.vlLitro <= PRECO_MAX) {
      const uf = /- ([A-Z]{2})$/.exec(l.cidade || '');
      if (!uf || !UFS.has(uf[1])) continue;
      const s = semana(l.dia);
      let a = r.anpSem.get(s);
      if (!a) r.anpSem.set(s, (a = { litros: 0, valor: 0 }));
      a.litros += l.litros;
      a.valor += l.despesa > 0 ? l.despesa : l.litros * l.vlLitro;
    }
  }

  // Preço postos externos: negociações desatualizadas dos postos usados no mês
  r.pp.desat = 0; r.pp.reneg = 0;
  if (negPorPosto) {
    r.pp.postos.forEach((k) => {
      const negs = negPorPosto.get(k);
      if (!negs || /BLOQUE/.test(negs[negs.length - 1].status || '')) return;   // bloqueado não é negociação desatualizada
      const s = situacaoNeg(negs[negs.length - 1], d.limitesNeg);
      if (s === 1) r.pp.desat++; else if (s === 2) r.pp.reneg++;
    });
  }
  return r;
}

// Preço x ANP (recorte padrão do painel: Brasil, semanal, postos externos): as últimas semanas com ANP e abastecimento
function compararANP(anp, anpSem) {
  const s = anp.series.semanal.brasil;
  const porSem = new Map();
  for (let i = 0; i < s.p.length; i++) porSem.set(s.p[i], s.v[i] / 1000);
  const semanas = [...anpSem.keys()].filter((p) => porSem.has(p)).sort((a, b) => b - a).slice(0, SEMANAS_ANP);
  if (!semanas.length) return null;
  let lC = 0, vC = 0, aC = 0;
  for (const p of semanas) {
    const a = anpSem.get(p);
    lC += a.litros; vC += a.valor; aC += a.litros * porSem.get(p);
  }
  const nosso = vC / lC, media = aC / lC;
  return { nosso, anp: media, dif: nosso - media, impacto: vC - aC, de: semanas[semanas.length - 1], ate: semanas[0] + 6, n: semanas.length };
}

// Contratos x ANP: última semana publicada da ANP por estado contra o preço de cada contrato
// mesma regra do painel Contratos x ANP (dashboards/contratos-anp.js): contratos cadastrados no portal (/api/contratos-anp), variação =
// ANP da última semana publicada ÷ ANP da semana da data do contrato − 1 (25/11/2026: antes lia a planilha de reajustes, que saiu)
const domingoDa = (dia) => dia - ((dia + 4) % 7);   // domingo da semana, como a "DATA INICIAL" da ANP
const diaDoIso = (iso) => { const [a, m, d] = String(iso).split('-').map(Number); return Math.floor(Date.UTC(a, m - 1, d) / 864e5); };
export function compararContratos(anp, contratos) {
  const s = anp.series.semanal.estado, ufs = anp.locais.estado.map((e) => e[0]);
  const porEstado = new Map();
  for (let i = 0; i < s.p.length; i++) porEstado.set(ufs[s.l[i]] + '|' + s.p[i], s.v[i] / 1000);
  const ultima = Math.max(...s.p);
  const anpEm = (uf, p) => {   // semana sem pesquisa naquele estado: vale a anterior mais próxima (até 3 semanas)
    for (let k = 0; k <= 3; k++) { const v = porEstado.get(uf + '|' + (p - 7 * k)); if (v !== undefined) return v; }
    return null;
  };
  const ativos = contratos.filter((c) => c.ativo && c.uf && c.data_contrato);
  let com = 0, acima = 0, abaixo = 0;
  for (const c of ativos) {
    const naBase = anpEm(c.uf, domingoDa(diaDoIso(c.data_contrato))), atual = anpEm(c.uf, ultima);
    if (naBase === null || atual === null) continue;
    const pct = atual / naBase - 1;
    com++;
    if (Math.abs(pct) > GATILHO + 1e-9) { if (pct > 0) acima++; else abaixo++; }
  }
  return { total: ativos.length, com, acima, abaixo, semana: ultima };
}
async function obterContratos() {
  const r = await fetch('/api/contratos-anp', { credentials: 'same-origin', cache: 'no-store' });
  if (r.status === 401 || r.redirected) throw new Error('sessão');
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()).contratos || [];
}

// ---------- desenho (Overview do Figma: indicadores, gráfico + média, números + atalhos) ----------
const ICONE = (id) => '<svg aria-hidden="true"><use href="#' + id + '"/></svg>';
// cartão KPI (Total Revenue): melhorSubir = true (subir é bom), false (subir é ruim) ou null (neutro)
function kpi(href, rot, num, uni, v, mesAntTxt, melhorSubir) {
  let varHtml = '';
  if (v !== null && v !== undefined && isFinite(v)) {
    const sobe = v > 0, bom = melhorSubir === null ? null : (sobe === melhorSubir);
    varHtml = '<span class="reg-var"><b class="' + (bom === null ? '' : bom ? 'sobe' : 'desce') + '">' + ICONE(sobe ? 'i-cima' : 'i-baixo') +
      fmt.pct(Math.abs(v)) + '</b>vs. ' + esc(mesAntTxt) + '</span>';
  }
  // sem o ícone "i" ao lado do nome (não abria nada; o cartão inteiro já leva ao painel), 18/11/2026
  return '<a class="registro" href="' + esc(href) + '"><span class="reg-rot">' + esc(rot) + '</span>' +
    '<span class="reg-val"><span class="reg-num num">' + esc(num) + '</span>' + (uni ? '<span class="reg-uni">' + esc(uni) + '</span>' : '') + varHtml + '</span></a>';
}
// linha da tabela "Números de cada painel"
function linha(href, painel, rot, num, situacao, comp) {
  return '<tr data-href="' + esc(href) + '" tabindex="0"><td><a class="nome-clicavel" href="' + esc(href) + '">' + esc(painel) + '</a></td>' +
    '<td>' + esc(rot) + (comp ? '<small class="ini-comp-linha">' + comp + '</small>' : '') + '</td><td class="n num">' + esc(num) + '</td>' +
    '<td>' + (situacao || '') + '</td></tr>';
}
const linhaErro = (href, painel, texto) => linha(href, painel, texto, '—', '', '');
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * @param {Element} caixa       onde desenhar o resumo (display:contents: os cartões entram na grade da página)
 * @param {object} o
 * @param {Function} o.pode     pode(perm) do login
 * @param {Element} [o.texto]   parágrafo de abertura (recebe o mês do resumo)
 */
export async function montarResumo(caixa, { pode, texto }) {
  const quer = {
    desp: pode('despesas'), om: pode('operacao-motorista'), mg: pode('media-geral'), ev: pode('evolucao-placas'),
    pp: pode('preco-postos'), anp: pode('preco-anp'), ct: pode('contratos-anp'),
  };
  const precisaBase = quer.desp || quer.om || quer.mg || quer.ev || quer.pp || quer.anp;
  if (!precisaBase && !quer.ct) { caixa.remove(); return; }
  caixa.innerHTML = '<div class="carregando"><div class="giro"></div>Somando os números do mês…</div>';

  const nada = Promise.resolve(null);
  const [rd, ra, rr] = await Promise.allSettled([
    precisaBase ? carregarDados() : nada,
    quer.anp || quer.ct ? obterJson('anp.json') : nada,
    quer.ct ? obterContratos() : nada,
  ]);
  if (!caixa.isConnected) return;   // saiu do início enquanto carregava
  const d = rd.status === 'fulfilled' ? rd.value : null;
  const anp = ra.status === 'fulfilled' ? ra.value : null;
  const reaj = rr.status === 'fulfilled' ? rr.value : null;

  let r = null;
  if (d) {
    try { r = resumir(d, quer); } catch (e) { r = null; }
  }

  // filtro de período dos links: "Este mês" quando o mês da Base é o de hoje; senão, as datas exatas
  const periodo = r ? (mesDoDia(dataParaDia(new Date())) === r.m ? 'periodo=mes' : 'de=' + diaIso(r.de) + '&ate=' + diaIso(r.ate)) : '';
  const mesTxt = r ? nomeMes(r.m) : '';
  // rótulo da comparação: o mês anterior (mês completo) ou "4 semanas antes" (mês em andamento, mesmos dias da semana)
  const mesAntTxt = r ? (r.completo ? nomeMes(r.m - 1) : '4 semanas antes') : '';
  const antPeriodo = r ? fmtDia(r.deA).slice(0, 5) + ' a ' + fmtDia(r.ateA).slice(0, 5) : '';

  if (texto && r) {
    texto.textContent = 'Resumo de ' + mesTxt + ' de ' + Math.floor(r.m / 12) +
      (r.completo ? ' (mês completo), comparado com ' + mesAntTxt : ' até ' + fmtDia(r.ate) + ', o último abastecimento registrado, comparado com os mesmos dias da semana de 4 semanas antes (' + antPeriodo + ')') +
      '. Clique num cartão ou numa linha para abrir o painel.';
  }

  let html = '';
  let grafico = null, ultimoParcial = false;

  // ---- faixa 1: indicadores do mês (Despesas, todos os combustíveis) ----
  if (r && quer.desp) {
    const t = r.desp[0], a = r.desp[1], dt = r.dsl[0], da = r.dsl[1];
    const preco = dt.litros ? dt.despesa / dt.litros : null, precoA = da.litros ? da.despesa / da.litros : null;
    const url = '#/despesas?' + periodo;
    html += '<div class="bomba-registros ini-kpis">' +
      kpi(url, 'Gasto em ' + mesTxt, fmt.moeda(t.despesa), '', variacao(t.despesa, a.despesa), mesAntTxt, false) +
      kpi(url, 'Litros de diesel', fmt.d2(dt.litros), 'L', variacao(dt.litros, da.litros), mesAntTxt, null) +
      kpi(url, 'Preço médio do diesel', preco === null ? '—' : fmt.d3(preco), 'R$/L', preco && precoA ? variacao(preco, precoA) : null, mesAntTxt, false) +
    '</div>';
  }

  // ---- faixa 2: gasto diário (General Sale Activity) + média contra a meta (com as categorias) ----
  if (r && quer.desp) {
    const dias = [];
    for (let k = r.de; k <= r.ate; k++) dias.push(k);
    // mês em andamento: o último dia da Base ainda está entrando (fica tracejado no gráfico e fora da média por dia)
    const parcial = mesDoDia(r.ate + 1) === r.m && dias.length > 2;
    const cheios = parcial ? dias.slice(0, -1) : dias;
    ultimoParcial = parcial;
    // Referência de cada dia = média do mesmo dia da semana nas 12 semanas antes do mês (domingo gasta ~1/4 de uma terça):
    // uma média única do mês (total ÷ dias corridos) ficava abaixo de todo dia útil e acima de todo fim de semana (10/11/2026)
    const esperado = (k) => { let s = 0; for (let w = 1; w <= SEMANAS_ESPERADO; w++) { const x = k - 7 * w; s += x >= r.de ? (r.dias.get(x) || 0) : (r.diasHist.get(x) || 0); } return s / SEMANAS_ESPERADO; };
    const dow = (k) => new Date(k * 864e5).getUTCDay();   // 0 = domingo
    const media = (ks) => (ks.length ? ks.reduce((s, k) => s + (r.dias.get(k) || 0), 0) / ks.length : null);
    const mUtil = media(cheios.filter((k) => dow(k) >= 1 && dow(k) <= 5)), mFds = media(cheios.filter((k) => dow(k) === 0 || dow(k) === 6));
    const somaReal = cheios.reduce((s, k) => s + (r.dias.get(k) || 0), 0), somaEsp = cheios.reduce((s, k) => s + esperado(k), 0);
    const pEsp = somaEsp > 0 ? somaReal / somaEsp : null;
    grafico = dias.map((k) => ({ rotulo: fmtDia(k).slice(0, 2), rotuloLongo: fmtDia(k) + ' (' + SEMANA_TXT[dow(k)] + ')', v: r.dias.get(k) || 0, m: esperado(k) }));
    html += '<section class="cartao ini-grafico" aria-labelledby="ini-graf-titulo">' +
      '<div class="cab-cartao"><h2 id="ini-graf-titulo">Gasto diário com combustível</h2><span class="sel-cartao">' + esc(capital(mesTxt)) + '</span></div>' +
      '<div class="resumo-graf">' +
        '<div><small>Média por dia útil</small><strong class="num">' + esc(mUtil === null ? '—' : fmt.moeda(mUtil)) + '</strong></div>' +
        '<div><small>Média no fim de semana</small><strong class="num">' + esc(mFds === null ? '—' : fmt.moeda(mFds)) + '</strong></div>' +
        '<div title="Gasto do mês até ' + esc(cheios.length ? fmtDia(cheios[cheios.length - 1]) : '') + ' contra o esperado para os mesmos dias (média de cada dia da semana nas ' + SEMANAS_ESPERADO + ' semanas anteriores)">' +
          '<small>Contra o esperado</small><strong class="num">' + esc(pEsp === null ? '—' : fmt.pct(pEsp)) + '</strong></div>' +
        '<a class="link-acao" href="#/despesas?' + esc(periodo) + '">Abrir Despesas</a></div>' +
      '<div class="grafico" id="ini-graf"></div></section>';
  }
  if (r && quer.mg) {
    const t = r.mg[0], a = r.mg[1];
    const media = t.litros ? t.km / t.litros : null, meta = t.litrosMeta ? t.km / t.litrosMeta : null;
    const mediaA = a.litros ? a.km / a.litros : null, metaA = a.litrosMeta ? a.km / a.litrosMeta : null;
    const urlMg = '#/media-geral?' + periodo + '&' + [...r.combDiesel].map((c) => 'combustivel=' + encodeURIComponent(c)).join('&');
    const cats = [...r.mgCat.entries()].filter(([, s]) => s.litros && s.litrosMeta).sort((x, y) => y[1].litros - x[1].litros).slice(0, 4);
    html += '<section class="meta-bloco ini-meta' + (quer.desp ? '' : ' ini-sozinho') + '" aria-labelledby="ini-meta-titulo">' +
      '<div class="cab-cartao"><h2 id="ini-meta-titulo">Média km/L contra a meta</h2>' +
        // seta de "abrir" (leva ao painel do gráfico); os três pontinhos davam a ideia de um menu de opções que não existe
        '<a class="btn-cartao" href="' + esc(urlMg) + '" aria-label="Abrir o painel Média geral" title="Abrir o painel Média geral">' + ICONE('i-abrir') + '</a></div>' +
      '<div class="medidor">' + htmlMedidor(media, meta, statusHtml) + '</div>' +
      cats.map(([cat, s]) => {
        const m = s.km / s.litros, mt = s.km / s.litrosMeta, pct = m / mt;
        return '<a class="linha-lista" href="' + esc(urlMg + '&categoria=' + encodeURIComponent(cat)) + '"><span class="mini-icone" aria-hidden="true"></span>' +
          '<div><strong>' + esc(capital(cat.toLowerCase())) + '</strong><span>' + fmt.d2(m) + ' km/L · meta ' + fmt.d2(mt) + '</span></div>' +
          '<span class="sit ' + faixaMeta(pct) + '">' + fmt.pct(pct) + '</span></a>';
      }).join('') +
      '<p class="ini-comp">' + esc((r.completo ? mesAntTxt : '4 semanas antes (' + antPeriodo + ')') + ': ' + (mediaA === null ? '—' : fmt.d2(mediaA) + ' km/L') + (metaA ? ' (' + fmt.pct(mediaA / metaA) + ' da meta)' : '')) + '</p>' +
    '</section>';
  }

  // ---- faixa 3: números de cada painel (Top Transactions) ----
  let linhas = '';
  const comp = (rot, val) => esc(mesAntTxt + ': ' + rot + (val ? ' (' + val + ')' : ''));
  if (r && quer.om) {
    const t = r.om[0], a = r.om[1];
    const econ = t.litrosMeta - t.litros, econA = a.litrosMeta - a.litros;
    const url = '#/operacao-motorista?' + periodo;
    const txtEcon = (v) => (v >= 0 ? 'economia de ' : 'gasto a mais de ') + fmt.d2(Math.abs(v)) + ' L';
    linhas += linha(url, 'Operação por motorista', econ >= 0 ? 'Economia de litros no mês' : 'Litros gastos a mais no mês', fmt.d2(Math.abs(econ)) + ' L',
      t.qtd ? statusHtml(econ >= 0, econ >= 0 ? 'Dentro da meta' : 'Gasto acima da meta') : '', comp(a.qtd ? txtEcon(econA) : '—'));
    const preco = t.litros ? t.despesa / t.litros : null, precoA = a.litros ? a.despesa / a.litros : null;
    linhas += linha(url, 'Operação por motorista', 'Preço médio do diesel', rs(preco) + '/L', '',
      comp(rs(precoA), preco && precoA ? sinal(variacao(preco, precoA), fmt.pct) : ''));
  }
  if (r && quer.ev) {
    let com = 0, abaixo = 0;
    r.placas.forEach((p) => { if (p.litros && p.litrosMeta) { com++; if (p.litrosMeta - p.litros < 0) abaixo++; } });
    linhas += linha('#/evolucao-placas', 'Evolução placas', 'Placas abaixo da meta de km/L', fmt.int(abaixo) + ' de ' + fmt.int(com),
      com ? statusHtml(abaixo === 0, fmt.pct(abaixo / com) + ' das placas') : '', com ? '' : esc('Nenhuma placa com meta no mês.'));
  }
  if (r && quer.pp) {
    const p = r.pp, desat = p.desat + p.reneg;
    linhas += linha('#/preco-postos?' + periodo, 'Preço postos externos', 'Pago acima do negociado', fmt.moeda(p.acima),
      desat ? statusHtml(false, desat + (desat === 1 ? ' desatualizada' : ' desatualizadas') + (p.reneg ? ', ' + p.reneg + ' renegociar' : '')) : statusHtml(true, 'Negociações em dia'),
      p.qtdNeg ? esc(fmt.int(p.qtdAcima) + ' de ' + fmt.int(p.qtdNeg) + ' abastecimentos acima do negociado') : '');
  }
  if (quer.anp) {
    const c = r && anp ? (() => { try { return compararANP(anp, r.anpSem); } catch (e) { return null; } })() : null;
    if (c) {
      const acima = c.dif > TOLERANCIA, abaixo = c.dif < -TOLERANCIA;
      linhas += linha('#/preco-anp', 'Preço x ANP', 'Diesel em postos externos contra a ANP Brasil', sinal(c.dif, fmt.d3) + ' R$/L',
        statusHtml(!acima, acima ? fmt.pct(c.dif / c.anp) + ' acima' : abaixo ? fmt.pct(-c.dif / c.anp) + ' abaixo' : 'Na média'),
        esc('Nosso ' + rs(c.nosso) + ' · ANP ' + rs(c.anp) + ' · ' + (c.n === 1 ? 'semana' : 'últimas ' + c.n + ' semanas') + ' de ' + fmtDia(c.de).slice(0, 5) + ' a ' + fmtDia(c.ate)));
    } else {
      linhas += linhaErro('#/preco-anp', 'Preço x ANP', d && anp ? 'Sem semanas com pesquisa da ANP e abastecimento em posto externo.' : 'Preços da ANP indisponíveis agora; abra o painel para tentar de novo.');
    }
  }
  if (quer.ct) {
    const c = anp && reaj ? (() => { try { return compararContratos(anp, reaj); } catch (e) { return null; } })() : null;
    if (c) {
      linhas += linha('#/contratos-anp', 'Contratos x ANP', 'Contratos com a ANP acima de +' + fmt.pct(GATILHO), fmt.int(c.acima) + ' de ' + fmt.int(c.com),
        statusHtml(c.acima === 0, c.acima ? 'Pedem reajuste' : 'Nenhum acima'),
        esc((c.abaixo ? c.abaixo + ' abaixo de −' + fmt.pct(GATILHO) + ' · ' : '') + 'ANP de ' + fmtDia(c.semana).slice(0, 5) + ' a ' + fmtDia(c.semana + 6)));
    } else {
      linhas += linhaErro('#/contratos-anp', 'Contratos x ANP', 'Contratos ou preços da ANP indisponíveis agora; abra o painel para tentar de novo.');
    }
  }
  if (linhas) {
    html += '<section class="cartao ini-numeros" aria-labelledby="ini-num-titulo"><div class="cab-cartao"><h2 id="ini-num-titulo">Números de cada painel</h2>' +
      '<span class="conta">' + esc(capital(mesTxt || 'mês atual')) + '</span></div>' +
      '<div class="tabela-rolagem"><table class="dados ini-tabela"><thead><tr><th><span>Painel</span></th><th><span>Indicador</span></th><th class="n"><span>Valor</span></th>' +
      '<th><span>Situação</span></th></tr></thead><tbody>' + linhas + '</tbody></table></div></section>';
  }

  if (!d && precisaBase) {
    html = '<div class="vazio">' + esc(rd.reason && rd.reason.message ? rd.reason.message : 'Não foi possível carregar os abastecimentos.') +
      ' Recarregue a página para tentar de novo.</div>' + html;
  }
  if (!html) { caixa.remove(); return; }
  caixa.innerHTML = html;
  // a linha inteira da tabela abre o painel
  const tab = caixa.querySelector('.ini-tabela');
  if (tab) {
    const ir = (tr) => { if (tr) location.hash = tr.dataset.href.replace(/^#/, ''); };
    tab.addEventListener('click', (e) => { if (!e.target.closest('a')) ir(e.target.closest('tr[data-href]')); });
    tab.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-href]')) ir(e.target); });
  }
  if (grafico) {
    // o gráfico ocupa a altura que sobra no cartão (a faixa tem a altura do cartão da média ao lado); mínimo 244 px
    const box = caixa.querySelector('#ini-graf');
    let feito = '';
    const desenhar = () => {
      if (!box.isConnected) return;
      const alto = Math.max(244, Math.floor(box.clientHeight / 12) * 12), chave = box.clientWidth + 'x' + alto;
      if (chave === feito) return;
      feito = chave;
      graficoPeriodo(box, grafico, {
        // pontos em cada dia na linha do gasto (sem eles não dava para saber onde ficava cada dia), 18/11/2026
        linhas: [{ campo: 'v', rot: 'Gasto no dia', cor: 'var(--serie-1)', pontos: true }, { campo: 'm', rot: 'Esperado para o dia', cor: 'var(--texto-2)', tracejada: true }],
        fmtV: (v) => fmt.moeda(v), fmtEixo: (v) => (Math.abs(v) >= 1000 ? fmt.int(v / 1000) + 'k' : fmt.int(v)),
        rotulo: 'Gasto por dia em ' + mesTxt, altura: alto - 6, ultimoParcial,
      });
    };
    desenhar();
    new ResizeObserver(desenhar).observe(box);
  }
}