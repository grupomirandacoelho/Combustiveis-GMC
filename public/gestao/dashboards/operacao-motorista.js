// Dashboard "Operação por motorista" — mesmas regras da aba "Operação p/ Motorista" do Power BI:
//  - só diesel (todos os tipos: S-10, S-10 aditivado, comum; lib/dados.js ehDiesel)
//  - só veículos com categoria na aba Metas, exceto PICAPE e VENDA
//  - Litros se meta = km ÷ meta da placa; Economia = Litros se meta − Litros
//  - Média real = km ÷ litros; Meta média = km ÷ Litros se meta; % = Média real ÷ Meta média
import { carregarDados, fmt, esc, fmtDia, fmtMes, mesDoDia, inicioDoMes, ehDiesel, diaIso } from '../lib/dados.js';
import { ligarBaixar } from '../lib/baixar.js';
import { criarFiltros, faixaMeta, metaHtml, valorRs } from '../lib/filtros.js';
import { htmlMedidor, suavizar, emAndamento } from '../lib/graficos.js';

const DIESEL = { has: ehDiesel };   // todo tipo de diesel (lib/dados.js)
const CATEGORIAS_FORA = new Set(['PICAPE', 'VENDA']);
const POR_PAGINA = 50;
const DIAS_GRAFICO_DIARIO = 100;   // até ~3 meses de dados, a evolução mostra dia a dia
// o ranking do Power BI esconde estes nomes (os totais continuam contando os abastecimentos deles)
const FORA_DO_RANKING = new Set([
  'ANTONIO MARCOS GOCALVES SOUSA', 'GUILHERME DE ALMEIDA RODRIGUES', 'VITOR FERNANDES COELHO',
  'RODRIGO COELHO FERREIRA', 'ANTONIO JOSE RODRIGUES COELHO',
]);

// dimensões filtráveis, na mesma ordem do painel do Power BI
const DIMENSOES = [
  { id: 'campanha', rotulo: 'Campanha', valor: (l) => (l.campanha === 1 ? 'Sim' : l.campanha === 0 ? 'Não' : 'Sem registro') },
  { id: 'cc', rotulo: 'Centro de custo', valor: (l) => l.cc },
  { id: 'placa', rotulo: 'Placa', valor: (l) => l.placa },
  { id: 'estabelecimento', rotulo: 'Estabelecimento', valor: (l) => l.tipoEstab },
  { id: 'modelo', rotulo: 'Modelo', valor: (l) => l.modelo },
  { id: 'periodo', rotulo: 'Período', periodo: true },
  { id: 'motorista', rotulo: 'Motorista', valor: (l) => l.motorista },
  { id: 'categoria', rotulo: 'Categoria', valor: (l) => l.categoria },
];

const hora = (seg) => String(Math.floor(seg / 3600)).padStart(2, '0') + ':' + String(Math.floor(seg / 60) % 60).padStart(2, '0');

const ICONE = {
  cima: '<svg aria-hidden="true"><use href="#i-cima"/></svg>',
  baixo: '<svg aria-hidden="true"><use href="#i-baixo"/></svg>',
  seta: '<svg aria-hidden="true"><use href="#i-seta"/></svg>',
  x: '<svg aria-hidden="true" width="14" height="14"><use href="#i-x"/></svg>',
};

function somar(linhas) {
  let km = 0, litros = 0, despesa = 0, litrosMeta = 0;
  for (const l of linhas) { km += l.km; litros += l.litros; despesa += l.despesa; litrosMeta += l.litrosMeta; }
  const media = litros ? km / litros : null;
  const metaMedia = litrosMeta ? km / litrosMeta : null;
  return {
    qtd: linhas.length, km, litros, despesa, litrosMeta,
    media, metaMedia,
    pct: media && metaMedia ? media / metaMedia : null,
    economia: litrosMeta - litros,
    preco: litros ? despesa / litros : null,
  };
}

function statusHtml(pct, texto) {
  if (pct === null) return '';
  const bom = pct >= 1;
  return '<span class="status ' + (bom ? 'bom' : 'ruim') + '">' + (bom ? ICONE.cima : ICONE.baixo) + esc(texto) + '</span>';
}

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando os abastecimentos…</div>';

  let dados;
  try {
    dados = await carregarDados();
  } catch (e) {
    pagina.innerHTML = '<div class="vazio">' + esc(e.message) + ' Recarregue a página para tentar de novo.</div>';
    return {};
  }

  let base = [];
  function usarDados(d) {
    dados = d;
    base = d.linhas.filter((l) => DIESEL.has(l.combustivel) && l.categoria && !CATEGORIAS_FORA.has(l.categoria));
    const g = new Date(d.geradoEm);
    ctx.definirSub('Dados atualizados em ' + g.toLocaleDateString('pt-BR') + ' às ' +
      g.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + ', com abastecimentos até ' + fmtDia(d.diaMax));
  }
  usarDados(dados);

  // ---------- estado ----------
  let visaoRanking = 'motorista';
  const DESTAQUE_RANKING = 5;      // os 5 primeiros ficam à vista; o restante vai numa área com rolagem própria
  let ordemRanking = { campo: 'pct', dir: -1 };
  let ordemTabela = { campo: 'dia', dir: -1 };
  let buscaTabela = '';
  let paginaTabela = 0;
  let filtradas = base;       // passam nos filtros (a tabela mostra todas)
  let consideradas = base;    // entram nas contas: as filtradas, recortadas pela seleção de abastecimentos
  // seleção de abastecimentos na tabela (como no Power BI): clique = só aquele; Ctrl+clique soma/tira; Shift+clique = intervalo.
  // modo "somente": o painel conta só os selecionados; "exceto": conta todos menos eles (tirar abastecimentos da média)
  const selAbast = new Set();
  let modoSel = 'somente';
  let ancora = null;          // chave do último clicado (para o Shift+clique)
  const chaves = new WeakMap();
  const chaveL = (l) => {
    let k = chaves.get(l);
    if (k === undefined) { k = [l.dia, l.seg ?? '', l.placa, l.hodometro ?? '', l.litros, l.despesa, l.motorista].join('|'); chaves.set(l, k); }
    return k;
  };

  // ---------- esqueleto ----------
  pagina.innerHTML = `
    <section class="filtros" id="om-filtros" aria-label="Filtros"></section>
    <div class="chips" id="om-chips" aria-live="polite"></div>
    <div class="aviso-selecao oculto" id="om-selecao" role="status"></div>

    <div class="abertura">
      <section class="bomba" aria-labelledby="om-bomba-titulo">
        <h2 class="bomba-titulo" id="om-bomba-titulo">Abastecido no período</h2>
        <dl class="bomba-registros" id="om-bomba"></dl>
      </section>
      <section class="meta-bloco" aria-labelledby="om-meta-titulo">
        <h2 id="om-meta-titulo">Média contra a meta</h2>
        <div class="medidor" id="om-medidor"></div>
      </section>
    </div>
    <dl class="apoio" id="om-apoio"></dl>

    <div class="grade-paineis">
      <section class="painel">
        <div class="painel-cab">
          <h2 id="om-evol-titulo">Evolução mês a mês</h2>
          <div class="legenda"><span><i class="leg-media"></i>Média real</span><span><i class="leg-meta"></i>Meta</span></div>
        </div>
        <div class="grafico-acoes">
          <p class="nota" id="om-evol-nota"></p>
          <button type="button" class="btn oculto" id="om-voltar"><svg aria-hidden="true"><use href="#i-recolher"/></svg><span class="txt">Voltar ao período anterior</span></button>
        </div>
        <div class="grafico" id="om-evolucao"></div>
      </section>
      <section class="painel">
        <div class="painel-cab">
          <h2>Ranking da meta</h2>
          <div class="segmentado" role="group" aria-label="Agrupar ranking">
            <button type="button" data-visao="motorista" aria-pressed="true">Motorista</button>
            <button type="button" data-visao="placa" aria-pressed="false">Placa</button>
          </div>
        </div>

        <div class="ranking" id="om-ranking"></div>
      </section>
    </div>

    <section class="painel painel-tabela">
      <div class="painel-cab">
        <h2>Abastecimentos</h2>
        <span class="conta" id="om-conta"></span>
      </div>
      <div class="tabela-ferramentas">
        <input type="search" id="om-busca" placeholder="Motorista, placa ou posto…" aria-label="Procurar na tabela" autocomplete="off">
        <button type="button" class="btn so-edicao" id="om-exportar"><svg aria-hidden="true"><use href="#i-baixar"/></svg><span class="txt">Baixar</span></button>
      </div>
      <p class="nota">Clique num abastecimento para filtrar por ele · Ctrl+clique soma outros · Shift+clique seleciona um intervalo.</p>
      <div class="tabela-rolagem"><table class="dados om-tabela-selecao" id="om-tabela"></table></div>
      <div class="paginacao" id="om-paginacao"></div>
    </section>`;

  const el = (id) => pagina.querySelector('#' + id);

  // ---------- filtros (componente compartilhado) ----------
  const filtros = criarFiltros({
    dimensoes: DIMENSOES, filtrosEl: el('om-filtros'), chipsEl: el('om-chips'), rota: '#/operacao-motorista',
    obterBase: () => base, obterLimites: () => [dados.diaMin, dados.diaMax], aoMudar: () => atualizar(), prefixo: 'om', periodoPadrao: 'mes',
  });
  const sel = filtros.sel;
  const passa = filtros.passa;

  // ---------- indicadores ----------
  // Mostrador da bomba: valor, litros e preço por litro, como o totalizador de uma bomba de combustível.
  // Os números nunca são cortados: o tamanho da fonte acompanha a largura do mostrador (container query).
  function desenharIndicadores(t) {
    const registros = [
      { rot: 'Valor', uni: '', val: valorRs(t.despesa), destaque: true },
      { rot: 'Litros', uni: 'L', val: fmt.d2(t.litros) },
      { rot: 'Preço por litro', uni: 'R$/L', val: fmt.d3(t.preco) },
    ];
    el('om-bomba').innerHTML = registros.map((r) =>
      '<div class="registro' + (r.destaque ? ' registro-principal' : '') + '">' +
        '<dt>' + esc(r.rot) + '</dt>' +
        '<dd><span class="reg-num">' + esc(r.val) + '</span>' + (r.uni ? '<span class="reg-uni">' + esc(r.uni) + '</span>' : '') + '</dd>' +
      '</div>').join('');

    const placas = new Set(), motoristas = new Set();
    for (const l of consideradas) { placas.add(l.placa); motoristas.add(l.motorista); }
    const econ = t.economia;
    const apoio = [
      { rot: 'Km rodado', val: fmt.int(t.km) },
      {
        // negativa: "litros gastos a mais", sempre com o número positivo (economia negativa confunde)
        rot: econ >= 0 ? 'Economia de litros' : 'Litros gastos a mais', val: fmt.d2(Math.abs(econ)),
        det: t.qtd ? metaHtml(t.metaMedia ? t.media / t.metaMedia : (econ >= 0 ? 1 : 0), econ >= 0 ? 'dentro da meta' : 'acima da meta') : '',
      },
      { rot: 'Abastecimentos', val: fmt.int(t.qtd) },
      { rot: 'Veículos', val: fmt.int(placas.size) },
      { rot: 'Motoristas', val: fmt.int(motoristas.size) },
    ];
    el('om-apoio').innerHTML = apoio.map((a) =>
      '<div><dt>' + esc(a.rot) + '</dt><dd><span class="num">' + esc(a.val) + '</span>' + (a.det ? ' ' + a.det : '') + '</dd></div>').join('');
  }

  // ---------- medidor da meta ----------
  function desenharMedidor(t) {
    const box = el('om-medidor');
    // mesmo medidor em meio círculo das outras telas
    box.innerHTML = htmlMedidor(t.media, t.metaMedia, (bom, texto) => statusHtml(bom ? 1 : 0, texto));
  }

  // ---------- evolução (gráfico de linhas) ----------
  let pontosEvol = [];
  function calcularEvolucao() {
    const porMes = new Map();
    for (const l of consideradas) {
      const m = mesDoDia(l.dia);
      let a = porMes.get(m);
      if (!a) porMes.set(m, (a = { chave: m, km: 0, litros: 0, litrosMeta: 0, despesa: 0, qtd: 0 }));
      a.km += l.km; a.litros += l.litros; a.litrosMeta += l.litrosMeta; a.despesa += l.despesa; a.qtd++;
    }
    let pontos = [...porMes.values()].sort((a, b) => a.chave - b.chave);
    let porDia = false;
    let dMin = Infinity, dMax = -Infinity;
    for (const l of consideradas) { if (l.dia < dMin) dMin = l.dia; if (l.dia > dMax) dMax = l.dia; }
    if (pontos.length === 1 || dMax - dMin <= DIAS_GRAFICO_DIARIO) {   // período curto: mostra dia a dia
      porDia = true;
      const dias = new Map();
      for (const l of consideradas) {
        let a = dias.get(l.dia);
        if (!a) dias.set(l.dia, (a = { chave: l.dia, km: 0, litros: 0, litrosMeta: 0, despesa: 0, qtd: 0 }));
        a.km += l.km; a.litros += l.litros; a.litrosMeta += l.litrosMeta; a.despesa += l.despesa; a.qtd++;
      }
      pontos = [...dias.values()].sort((a, b) => a.chave - b.chave);
    }
    // dias (ou meses) sem abastecimento entram vazios: o eixo segue o tempo e a linha fica interrompida (antes o buraco sumia
    // e os pontos de antes e depois ficavam lado a lado — 10/11/2026)
    if (pontos.length > 1) {
      const tem = new Map(pontos.map((p) => [p.chave, p])), cheio = [];
      for (let k = pontos[0].chave; k <= pontos[pontos.length - 1].chave; k++) cheio.push(tem.get(k) || { chave: k, km: 0, litros: 0, litrosMeta: 0, despesa: 0, qtd: 0 });
      pontos = cheio;
    }
    pontos.forEach((p) => {
      p.porDia = porDia;
      p.media = p.litros ? p.km / p.litros : null;
      p.meta = p.litrosMeta ? p.km / p.litrosMeta : null;
      p.rotulo = porDia ? fmtDia(p.chave).slice(0, 5) : fmtMes(p.chave);
      p.rotuloLongo = porDia ? fmtDia(p.chave) : fmtMes(p.chave, true);
    });
    el('om-evol-titulo').textContent = porDia ? 'Evolução dia a dia' : 'Evolução mês a mês';
    el('om-evol-nota').textContent = porDia ? 'Clique em um dia para filtrar o painel por ele.' : 'Clique em um mês para filtrar o painel por ele e ver os dias do mês.';
    el('om-voltar').classList.toggle('oculto', !anteriores.length);
    pontosEvol = pontos;
  }

  // clique no gráfico filtra o painel inteiro pelo mês (ou dia); "Voltar" devolve o período de antes do clique
  const anteriores = [];
  function filtrarPeloGrafico(p) {
    const per = filtros.periodo;
    const de = p.porDia ? p.chave : inicioDoMes(p.chave);
    const ate = p.porDia ? p.chave : inicioDoMes(p.chave + 1) - 1;
    if (per.de === de && per.ate === ate) { voltarPeriodo(); return; }   // clicou de novo no que já está filtrado
    anteriores.push({ de: per.de, ate: per.ate, preset: per.preset });
    filtros.definirPeriodo(de, ate);
  }
  function voltarPeriodo() {
    const a = anteriores.pop();
    if (a) filtros.definirPeriodo(a.de, a.ate, a.preset); else filtros.definirPeriodo(null, null);
    queueMicrotask(() => el('om-evolucao').focus());
  }
  el('om-voltar').addEventListener('click', voltarPeriodo);

  function ticks(min, max, alvo) {
    const passoBruto = (max - min) / alvo;
    const pot = Math.pow(10, Math.floor(Math.log10(passoBruto)));
    const passo = [1, 2, 2.5, 5, 10].map((m) => m * pot).find((p) => p >= passoBruto) || pot * 10;
    const ini = Math.floor(min / passo) * passo, fim = Math.ceil(max / passo) * passo;
    const r = [];
    for (let v = ini; v <= fim + passo / 2; v += passo) r.push(+v.toFixed(6));
    return r;
  }

  function desenharEvolucao() {
    const box = el('om-evolucao');
    if (!box) return;   // a tela já saiu (redimensionar atrasado; erro "clientWidth" de null, 27/11/2026)
    const pts = pontosEvol, comDado = pts.filter((p) => p.media !== null);
    if (comDado.length < 2) {
      box.removeAttribute('tabindex'); box.removeAttribute('role'); box.removeAttribute('aria-label');
      box.innerHTML = '<div class="vazio">Escolha um período com pelo menos dois dias com abastecimento para ver a evolução.</div>';
      return;
    }
    const W = Math.max(320, box.clientWidth), H = 210;   // era 250 (densidade, 18/11/2026)
    const m = { l: 40, r: 64, t: 14, b: 28 };
    const vals = comDado.flatMap((p) => [p.media, p.meta].filter((v) => v !== null));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const folga = (hi - lo) * 0.12 || 0.2;
    const tk = ticks(lo - folga, hi + folga, 4);
    lo = tk[0]; hi = tk[tk.length - 1];
    const x = (i) => m.l + (i * (W - m.l - m.r)) / (pts.length - 1);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const caminho = (campo) => pts.map((p, i) => (p[campo] === null ? '' : (i && pts[i - 1][campo] !== null ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p[campo]).toFixed(1))).join(' ');
    const passoX = Math.max(1, Math.ceil(pts.length / Math.floor((W - m.l - m.r) / 64)));
    const ult = comDado[comDado.length - 1], iUlt = pts.indexOf(ult);
    // item 6: o último mês/dia ainda em andamento sai tracejado e mais claro (a queda do mês parcial não é real)
    const iAnt = iUlt - 1, parcial = iUlt === pts.length - 1 && iAnt >= 0 && pts[iAnt].media !== null && comDado.length > 2 && emAndamento(ult.porDia ? 'dia' : 'mes', ult.chave);
    let yMed = y(ult.media), yMeta = ult.meta !== null ? y(ult.meta) : null;
    if (yMeta !== null && Math.abs(yMed - yMeta) < 16) { const c = (yMed + yMeta) / 2; if (yMed <= yMeta) { yMed = c - 8; yMeta = c + 8; } else { yMed = c + 8; yMeta = c - 8; } }

    box.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="Média real e meta por período">' +
        tk.map((v) => '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--grade)" stroke-width="1"/>' +
          '<text class="eixo-txt num" x="' + (m.l - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + fmt.d1(v) + '</text>').join('') +
        pts.map((p, i) => (i % passoX === 0 || i === pts.length - 1) && !(i !== pts.length - 1 && pts.length - 1 - i < passoX / 2)
          ? '<text class="eixo-txt" x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(p.rotulo) + '</text>' : '').join('') +
        '<path d="' + suavizar(caminho('meta')) + '" fill="none" stroke="var(--tinta-2)" stroke-width="1.5" stroke-dasharray="6 5" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<path d="' + suavizar(parcial ? caminho('media').replace(/\s*L[^ML]*$/, '') : caminho('media')) + '" fill="none" stroke="var(--serie-1)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
        (parcial ? '<path d="M' + x(iAnt).toFixed(1) + ' ' + y(pts[iAnt].media).toFixed(1) + ' L' + x(iUlt).toFixed(1) + ' ' + y(ult.media).toFixed(1) +
          '" fill="none" stroke="var(--serie-1)" stroke-width="2" stroke-dasharray="4 4" opacity="0.55" stroke-linecap="round"/>' : '') +
        '<circle cx="' + x(iUlt) + '" cy="' + y(ult.media) + '" r="4" fill="' + (parcial ? 'var(--superficie)' : 'var(--serie-1)') + '" stroke="' + (parcial ? 'var(--serie-1)' : 'var(--superficie)') + '" stroke-width="2"/>' +
        '<text class="rot-serie" x="' + (W - m.r + 8) + '" y="' + (yMed + 4) + '" fill="var(--tinta)">' + fmt.d2(ult.media) + '</text>' +
        (yMeta !== null ? '<text class="rot-serie" x="' + (W - m.r + 8) + '" y="' + (yMeta + 4) + '" fill="var(--tinta-2)">Meta ' + fmt.d2(ult.meta) + '</text>' : '') +
        '<g class="cursor" style="display:none"><line y1="' + m.t + '" y2="' + (H - m.b) + '" stroke="var(--eixo)" stroke-width="1"/>' +
          '<circle class="c-meta" r="4" fill="var(--tinta-2)" stroke="var(--superficie)" stroke-width="2"/>' +
          '<circle class="c-media" r="5" fill="var(--serie-1)" stroke="var(--superficie)" stroke-width="2"/></g>' +
        '<rect x="' + m.l + '" y="0" width="' + (W - m.l - m.r) + '" height="' + H + '" fill="transparent" class="alvo"/>' +
      '</svg><div class="dica oculto"></div>';

    const svg = box.querySelector('svg'), cursor = svg.querySelector('.cursor'), dica = box.querySelector('.dica');
    function mostrar(i) {
      const p = pts[i];
      cursor.style.display = '';
      if (p.media === null) {   // dia/mês sem abastecimento
        cursor.querySelector('line').setAttribute('x1', x(i)); cursor.querySelector('line').setAttribute('x2', x(i));
        cursor.querySelector('.c-media').style.display = 'none'; cursor.querySelector('.c-meta').style.display = 'none';
        dica.innerHTML = '<strong>' + esc(p.rotuloLongo) + '</strong><div class="linha-dica"><span>Sem abastecimento</span></div>';
        dica.classList.remove('oculto');
        const esc2 = box.clientWidth / W;
        let left = x(i) * esc2 + 14;
        if (left + dica.offsetWidth > box.clientWidth) left = x(i) * esc2 - dica.offsetWidth - 14;
        dica.style.left = left + 'px'; dica.style.top = '10px';
        return;
      }
      cursor.querySelector('.c-media').style.display = '';
      cursor.querySelector('line').setAttribute('x1', x(i)); cursor.querySelector('line').setAttribute('x2', x(i));
      const cm = cursor.querySelector('.c-media'); cm.setAttribute('cx', x(i)); cm.setAttribute('cy', y(p.media));
      const ct = cursor.querySelector('.c-meta');
      if (p.meta !== null) { ct.style.display = ''; ct.setAttribute('cx', x(i)); ct.setAttribute('cy', y(p.meta)); } else ct.style.display = 'none';
      const pct = p.media && p.meta ? p.media / p.meta : null;
      dica.innerHTML = '<strong>' + esc(p.rotuloLongo) + (parcial && i === iUlt ? ' · em andamento' : '') + '</strong>' +
        '<div class="linha-dica"><span><i style="background:var(--serie-1)"></i>Média real</span><b class="num">' + fmt.d2(p.media) + ' km/L</b></div>' +
        '<div class="linha-dica"><span><i style="background:var(--tinta-2)"></i>Meta</span><b class="num">' + fmt.d2(p.meta) + ' km/L</b></div>' +
        '<div class="linha-dica"><span>% da meta</span><b class="num">' + fmt.pct(pct) + '</b></div>' +
        '<div class="linha-dica"><span>Litros</span><b class="num">' + fmt.int(p.litros) + '</b></div>';
      dica.classList.remove('oculto');
      const escala = box.clientWidth / W;
      let left = x(i) * escala + 14;
      if (left + dica.offsetWidth > box.clientWidth) left = x(i) * escala - dica.offsetWidth - 14;
      dica.style.left = left + 'px';
      dica.style.top = Math.max(0, y(p.media) * escala - dica.offsetHeight / 2) + 'px';
    }
    let atual = iUlt;
    const alvo = svg.querySelector('.alvo');
    alvo.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      atual = Math.max(0, Math.min(pts.length - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (pts.length - 1))));
      mostrar(atual);
    });
    alvo.addEventListener('mouseleave', () => { cursor.style.display = 'none'; dica.classList.add('oculto'); });
    alvo.style.cursor = 'pointer';
    alvo.addEventListener('click', (e) => {   // o ponto vem da posição do clique (no toque do celular não há mousemove)
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      atual = Math.max(0, Math.min(pts.length - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (pts.length - 1))));
      filtrarPeloGrafico(pts[atual]);
    });
    // teclado: o gráfico recebe foco e as setas percorrem os períodos
    box.tabIndex = 0;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Gráfico de média real e meta. Use as setas para percorrer os períodos e Enter para filtrar pelo período.');
    box.onfocus = () => mostrar(atual);
    box.onblur = () => { cursor.style.display = 'none'; dica.classList.add('oculto'); };
    box.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); filtrarPeloGrafico(pts[atual]); return; }
      if (e.key === 'ArrowLeft') { atual = Math.max(0, atual - 1); mostrar(atual); e.preventDefault(); }
      if (e.key === 'ArrowRight') { atual = Math.min(pts.length - 1, atual + 1); mostrar(atual); e.preventDefault(); }
    };
  }

  // ---------- ranking ----------
  // "MARCOS ANTONIO DA SILVA" -> "Marcos Antonio da Silva": ocupa menos linhas e lê melhor (o filtro continua pelo nome original)
  const MINUSCULAS = new Set(['da', 'das', 'de', 'do', 'dos', 'e']);
  const nomeLegivel = (s) => String(s || '').toLocaleLowerCase('pt-BR').split(' ')
    .map((p, i) => (i && MINUSCULAS.has(p) ? p : p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1))).join(' ');
  function desenharRanking() {
    const grupos = new Map();
    const chave = visaoRanking === 'motorista' ? (l) => l.motorista : (l) => l.placa;
    for (const l of consideradas) {
      if (FORA_DO_RANKING.has(l.motorista)) continue;
      const k = chave(l);
      let a = grupos.get(k);
      if (!a) grupos.set(k, (a = { nome: k, km: 0, litros: 0, litrosMeta: 0, qtd: 0, extra: new Set(), modelo: l.modelo, categoria: l.categoria }));
      a.km += l.km; a.litros += l.litros; a.litrosMeta += l.litrosMeta; a.qtd++;
      a.extra.add(visaoRanking === 'motorista' ? l.placa : l.motorista);
    }
    const lista = [...grupos.values()].map((a) => {
      a.media = a.litros ? a.km / a.litros : null;
      a.meta = a.litrosMeta ? a.km / a.litrosMeta : null;
      a.pct = a.media && a.meta ? a.media / a.meta : null;
      return a;
    });
    const { campo, dir } = ordemRanking;
    lista.sort((a, b) => {
      if (campo === 'nome') return dir * a.nome.localeCompare(b.nome, 'pt-BR');
      const va = a[campo], vb = b[campo];
      if (va === null) return 1; if (vb === null) return -1;
      return dir * (va - vb);
    });
    const selecionados = sel[visaoRanking];
    const maxPct = 1.6; // a barra vai até 160%; acima disso o número mostra o valor real
    const seta = (c) => (ordemRanking.campo === c ? (ordemRanking.dir < 0 ? ' ↓' : ' ↑') : '');
    const linhaRanking = (a, i) => {
        const sub = visaoRanking === 'motorista'
          ? fmt.int(a.km) + ' km em ' + a.extra.size + (a.extra.size === 1 ? ' placa' : ' placas')
          : [a.modelo, a.categoria, fmt.int(a.km) + ' km'].filter(Boolean).join(', ');
        const larg = a.pct !== null ? Math.min(1, a.pct / maxPct) * 100 : 0;
        return '<button type="button" class="ranking-linha' + (selecionados.has(a.nome) ? ' selecionado' : '') + '" data-nome="' + esc(a.nome) + '" aria-pressed="' + selecionados.has(a.nome) + '">' +
          '<span class="pos num">' + (i + 1) + '</span>' +
          '<span class="nome">' + esc(visaoRanking === 'motorista' ? nomeLegivel(a.nome) : a.nome) + '<small>' + esc(sub) + '</small></span>' +
          '<span class="media num">' + fmt.d2(a.media) + '</span>' +
          '<span class="barra-pct ' + faixaMeta(a.pct) + '" title="Meta: ' + fmt.d2(a.meta) + ' km/L">' +
            '<span class="trilho"><span class="cheia" style="width:' + larg + '%"></span><span class="cem" style="left:' + (100 / maxPct) + '%"></span></span>' +
            '<span class="txt num">' + fmt.pct(a.pct).replace(',00%', '%') + '</span>' +
          '</span></button>';
    };
    // os 5 primeiros em destaque; o restante numa área com rolagem própria (o cabeçalho fica sempre à vista)
    const rotulo = visaoRanking === 'motorista' ? 'motoristas' : 'placas';
    const resto = lista.length - DESTAQUE_RANKING;
    // guarda a rolagem e o foco para não "pular" ao redesenhar (ex.: depois de clicar num nome)
    const antes = el('om-ranking').querySelector('.om-ranking-resto');
    const rolagemAntes = antes ? antes.scrollTop : 0;
    const focoAntes = el('om-ranking').contains(document.activeElement) && document.activeElement.dataset.nome;
    el('om-ranking').innerHTML =
      '<div class="ranking-cab"><span></span>' +
        '<button type="button" data-ord="nome">' + (visaoRanking === 'motorista' ? 'Motorista' : 'Placa') + seta('nome') + '</button>' +
        '<button type="button" data-ord="media" style="text-align:right">km/L' + seta('media') + '</button>' +
        '<button type="button" data-ord="pct">% da meta' + seta('pct') + '</button></div>' +
      (lista.length
        ? '<div class="om-ranking-resto" role="region" tabindex="0" aria-labelledby="om-ranking-demais">' +
            lista.map(linhaRanking).join('') +
          '</div>' +
          (resto > 0
            ? '<p class="om-ranking-demais" id="om-ranking-demais">' + fmt.int(lista.length) + ' ' + rotulo + ' · role a lista para ver todos</p>'
            : '')
        : '<div class="vazio">Nenhum abastecimento neste recorte. Tire um filtro para ver o ranking.</div>');
    const depois = el('om-ranking').querySelector('.om-ranking-resto');
    if (depois) {
      // a caixa mostra só os 5 primeiros; o resto aparece rolando a própria lista
      const linhas = depois.querySelectorAll('.ranking-linha');
      const ult = resto > 0 ? linhas[DESTAQUE_RANKING - 1] : null;
      // se a tela ainda não foi desenhada (altura 0), fica a altura máxima do CSS
      depois.style.maxHeight = ult && ult.offsetHeight ? (ult.offsetTop - linhas[0].offsetTop + ult.offsetHeight + 2) + 'px' : '';
      depois.scrollTop = rolagemAntes;
    }
    if (focoAntes) {
      const f = [...el('om-ranking').querySelectorAll('.ranking-linha')].find((b) => b.dataset.nome === focoAntes);
      if (f) f.focus({ preventScroll: true });
    }
  }
  el('om-ranking').addEventListener('click', (e) => {
    const o = e.target.closest('[data-ord]');
    if (o) {
      const c = o.dataset.ord;
      ordemRanking = ordemRanking.campo === c ? { campo: c, dir: -ordemRanking.dir } : { campo: c, dir: c === 'nome' ? 1 : -1 };
      desenharRanking();
      voltarRolagemRanking();
      const b = el('om-ranking').querySelector('[data-ord="' + c + '"]');   // o foco continua no botão de ordenar
      if (b) b.focus();
      return;
    }
    const linha = e.target.closest('.ranking-linha');
    if (!linha) return;
    const s = sel[visaoRanking], n = linha.dataset.nome;
    if (s.has(n)) s.delete(n); else s.add(n);
    atualizar();
  });
  pagina.querySelector('.segmentado').addEventListener('click', (e) => {
    const b = e.target.closest('[data-visao]');
    if (!b) return;
    visaoRanking = b.dataset.visao;
    pagina.querySelectorAll('.segmentado [data-visao]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    desenharRanking();
    voltarRolagemRanking();
  });
  // nova ordem ou novo agrupamento: a lista com rolagem volta ao topo
  function voltarRolagemRanking() {
    const r = el('om-ranking').querySelector('.om-ranking-resto');
    if (r) r.scrollTop = 0;
  }

  // ---------- tabela ----------
  const COLUNAS = [
    { id: 'dia', rot: 'Data', v: (l) => l.dia * 86400 + (l.seg || 0), txt: (l) => fmtDia(l.dia) },   // a hora vai embaixo (desenharTabela)
    { id: 'motorista', rot: 'Motorista', v: (l) => l.motorista, txt: (l) => l.motorista, trunc: true },
    { id: 'placa', rot: 'Placa', v: (l) => l.placa, txt: (l) => l.placa },
    { id: 'km', rot: 'Km rodado', n: true, v: (l) => l.km, txt: (l) => fmt.int(l.km) },
    { id: 'hodometro', rot: 'Hodômetro', n: true, v: (l) => l.hodometro, txt: (l) => fmt.int(l.hodometro) },
    { id: 'meta', rot: 'Meta', n: true, v: (l) => l.meta, txt: (l) => fmt.d2(l.meta) },
    { id: 'media', rot: 'Média real', n: true, v: (l) => (l.litros ? l.km / l.litros : null), txt: (l) => fmt.d2(l.litros ? l.km / l.litros : null) },
    { id: 'litros', rot: 'Litros', n: true, v: (l) => l.litros, txt: (l) => fmt.d2(l.litros) },
    { id: 'tanque', rot: '% tanque', detalhe: true, n: true, v: (l) => (l.tanque ? l.litros / l.tanque : null), txt: (l) => fmt.pct(l.tanque ? l.litros / l.tanque : null) },
    { id: 'despesa', rot: 'Despesa', n: true, v: (l) => l.despesa, txt: (l) => fmt.moeda(l.despesa) },
    { id: 'vlLitro', rot: 'R$/litro', detalhe: true, n: true, v: (l) => l.vlLitro, txt: (l) => fmt.moeda(l.vlLitro) },
    { id: 'econ', rot: 'Econ. litros', n: true, v: (l) => l.litrosMeta - l.litros, cor: true, txt: (l) => fmt.d2(l.litrosMeta - l.litros) },
    { id: 'fornecedor', rot: 'Posto', detalhe: true, v: (l) => l.fornecedor, txt: (l) => l.fornecedor, trunc: true },
    { id: 'cidade', rot: 'Cidade', detalhe: true, v: (l) => l.cidade, txt: (l) => l.cidade, trunc: true },
    { id: 'cc', rot: 'Centro de custo', detalhe: true, v: (l) => l.cc, txt: (l) => l.cc, trunc: true },
    { id: 'campanha', rot: 'Campanha', detalhe: true, v: (l) => l.campanha, txt: (l) => (l.campanha === 1 ? 'Sim' : l.campanha === 0 ? 'Não' : 'Sem registro') },
  ];
  // na tabela ficam só as colunas da análise rápida; as de "detalhe" aparecem ao abrir a linha (setinha no fim)
  const VISIVEIS = COLUNAS.filter((c) => !c.detalhe), DETALHES = COLUNAS.filter((c) => c.detalhe);
  const abertos = new Set();   // chaveL dos abastecimentos com os detalhes abertos

  function linhasTabela() {
    const t = buscaTabela.trim().toLowerCase();
    let lista = t ? filtradas.filter((l) =>
      l.motorista.toLowerCase().includes(t) || l.placa.toLowerCase().includes(t) ||
      (l.fornecedor || '').toLowerCase().includes(t) || (l.cidade || '').toLowerCase().includes(t)) : filtradas.slice();
    const c = COLUNAS.find((x) => x.id === ordemTabela.campo), dir = ordemTabela.dir;
    lista.sort((a, b) => {
      const va = c.v(a), vb = c.v(b);
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const r = typeof va === 'string' ? va.localeCompare(vb, 'pt-BR') : va - vb;
      return dir * r || b.dia - a.dia;
    });
    return lista;
  }

  let listaAtual = [];
  function desenharTabela() {
    const lista = linhasTabela();
    listaAtual = lista;
    const paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));
    paginaTabela = Math.min(paginaTabela, paginas - 1);
    const ini = paginaTabela * POR_PAGINA;
    const trecho = lista.slice(ini, ini + POR_PAGINA);
    el('om-conta').textContent = fmt.int(lista.length) + (lista.length === 1 ? ' abastecimento' : ' abastecimentos');
    el('om-tabela').innerHTML =
      '<thead><tr>' + VISIVEIS.map((c) => {
        const ord = ordemTabela.campo === c.id;
        return '<th class="' + (c.n ? 'n' : '') + '" aria-sort="' + (ord ? (ordemTabela.dir < 0 ? 'descending' : 'ascending') : 'none') + '">' +
          '<button type="button" data-col="' + c.id + '">' + esc(c.rot) + (ord ? '<span class="seta">' + (ordemTabela.dir < 0 ? '▼' : '▲') + '</span>' : '') + '</button></th>';
      }).join('') + '<th class="om-abrir-col"><span class="om-sr">Mais informações</span></th></tr></thead>' +
      '<tbody>' + (trecho.length ? trecho.map((l, j) => {
        const k = chaveL(l), marcado = selAbast.has(k), aberto = abertos.has(k);
        const cls = (marcado ? (modoSel === 'exceto' ? 'desconsiderado' : 'selecionado') : '') + (aberto ? ' om-aberto' : '');
        const idDet = 'om-det-' + (ini + j);
        return '<tr data-i="' + (ini + j) + '" tabindex="0" class="' + cls + '" aria-selected="' + marcado + '"' +
          (marcado && modoSel === 'exceto' ? ' title="Fora da conta do painel"' : '') + '>' + VISIVEIS.map((c) => {
        let cls = (c.n ? 'n' : '') + (c.trunc ? ' trunc' : '');
        if (c.cor) { const v = c.v(l); cls += v >= 0 ? ' pos-txt' : ' neg-txt'; }
        const t = c.txt(l);
        // transação da API do cartão que ainda não está na planilha (tempo real)
        const selo = c.id === 'dia' && l.tempoReal ? '<span class="selo-tempo-real" title="Veio da API do cartão hoje; entra nos abastecimentos no dia seguinte (D-1)">API</span>' : '';
        // horário do abastecimento embaixo da data
        const horaTxt = c.id === 'dia' && l.seg !== null && l.seg !== undefined ? '<small class="cidade-linha num">' + esc(hora(l.seg)) + '</small>' : '';
        return '<td class="' + cls + '"' + (c.trunc ? ' title="' + esc(t) + '"' : '') + '>' + esc(t) + selo + horaTxt + '</td>';
      }).join('') +
        '<td class="om-abrir-col"><button type="button" class="om-abrir" data-abrir="' + (ini + j) + '" aria-expanded="' + aberto + '"' +
          (aberto ? ' aria-controls="' + idDet + '"' : '') + ' aria-label="' + (aberto ? 'Esconder' : 'Mostrar') + ' mais informações" title="' +
          (aberto ? 'Esconder' : 'Mais informações') + '"><svg aria-hidden="true"><use href="#i-seta"/></svg></button></td></tr>' +
        (aberto ? '<tr class="om-detalhe" id="' + idDet + '"><td colspan="' + (VISIVEIS.length + 1) + '"><dl class="om-det">' +
          DETALHES.map((c) => { const t = c.txt(l); return '<div><dt>' + esc(c.rot) + '</dt><dd>' + (t ? esc(t) : '<span class="sem-dado">—</span>') + '</dd></div>'; }).join('') +
          '</dl></td></tr>' : '');
      }).join('')
        : '<tr><td colspan="' + (VISIVEIS.length + 1) + '"><div class="vazio">Nenhum abastecimento com esses filtros.</div></td></tr>') + '</tbody>';
    el('om-paginacao').innerHTML = lista.length > POR_PAGINA
      ? '<span>Página ' + (paginaTabela + 1) + ' de ' + paginas + '</span>' +
        '<button type="button" data-pg="0" ' + (paginaTabela === 0 ? 'disabled' : '') + ' aria-label="Primeira página">«</button>' +
        '<button type="button" data-pg="' + (paginaTabela - 1) + '" ' + (paginaTabela === 0 ? 'disabled' : '') + ' aria-label="Página anterior">‹</button>' +
        '<button type="button" data-pg="' + (paginaTabela + 1) + '" ' + (paginaTabela >= paginas - 1 ? 'disabled' : '') + ' aria-label="Próxima página">›</button>' +
        '<button type="button" data-pg="' + (paginas - 1) + '" ' + (paginaTabela >= paginas - 1 ? 'disabled' : '') + ' aria-label="Última página">»</button>'
      : '';
  }
  // ---------- seleção de abastecimentos (clique nas linhas da tabela) ----------
  function selecionarLinha(i, e) {
    const l = listaAtual[i];
    if (!l) return;
    const k = chaveL(l);
    const iAncora = ancora === null ? -1 : listaAtual.findIndex((x) => chaveL(x) === ancora);
    if (e.shiftKey && iAncora >= 0) {
      // intervalo entre o último clicado e este (na ordem atual da tabela); com Ctrl soma ao que já estava
      if (!(e.ctrlKey || e.metaKey)) selAbast.clear();
      for (let x = Math.min(i, iAncora); x <= Math.max(i, iAncora); x++) selAbast.add(chaveL(listaAtual[x]));
    } else if (e.ctrlKey || e.metaKey) {
      if (selAbast.has(k)) selAbast.delete(k); else selAbast.add(k);
      ancora = k;
    } else {
      const so = selAbast.size === 1 && selAbast.has(k);   // clicou de novo no único selecionado: limpa
      selAbast.clear();
      if (!so) selAbast.add(k);
      ancora = k;
    }
    atualizar(true);
  }
  // Shift+clique não seleciona o texto da tabela
  el('om-tabela').addEventListener('mousedown', (e) => { if (e.shiftKey && e.target.closest('tbody tr[data-i]')) e.preventDefault(); });
  el('om-tabela').addEventListener('keydown', (e) => {
    const tr = e.target.closest('tbody tr[data-i]');
    if (!tr || (e.key !== 'Enter' && e.key !== ' ') || e.target.closest('button')) return;   // Enter na setinha: o próprio botão
    e.preventDefault();
    selecionarLinha(Number(tr.dataset.i), e);
  });
  const aoClicarSelecao = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-ver-medidor')) { el('om-medidor').closest('section').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    if (b.dataset.modo) modoSel = b.dataset.modo;
    if (b.hasAttribute('data-limpar-selecao')) { selAbast.clear(); ancora = null; modoSel = 'somente'; }
    atualizar(true);
  };
  el('om-selecao').addEventListener('click', aoClicarSelecao);

  // ---------- resumo flutuante da seleção ----------
  // Com abastecimentos selecionados e o medidor fora da tela (rolando a tabela), a média contra a meta fica presa no rodapé:
  // dá para ir marcando linhas e ver o resultado sem voltar ao topo. Fica no <body> porque a .pagina é um container de CSS
  // (um position:fixed dentro dela ficaria preso a ela). Sai junto com a tela (desmontar).
  const flutuante = document.createElement('div');
  flutuante.className = 'sel-flutuante oculto';
  flutuante.setAttribute('role', 'region');
  flutuante.setAttribute('aria-label', 'Média dos abastecimentos selecionados contra a meta');
  document.body.appendChild(flutuante);
  flutuante.addEventListener('click', aoClicarSelecao);
  // o medidor conta como visível quando pelo menos um terço dele está na tela (checado na rolagem e ao redesenhar)
  function medidorVisivel() {
    const r = el('om-medidor').getBoundingClientRect();
    const visto = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return r.height > 0 && visto >= r.height / 3;
  }
  let tRolar = null;
  const aoRolar = () => { if (tRolar) return; tRolar = setTimeout(() => { tRolar = null; mostrarFlutuante(); }, 80); };
  document.addEventListener('scroll', aoRolar, { passive: true, capture: true });
  function mostrarFlutuante() {
    const ver = selAbast.size > 0 && !medidorVisivel();
    flutuante.classList.toggle('oculto', !ver);
    document.body.classList.toggle('com-sel-flutuante', ver);
  }
  function desenharFlutuante(t) {
    if (!selAbast.size) { flutuante.innerHTML = ''; mostrarFlutuante(); return; }
    const p = t.media && t.metaMedia ? t.media / t.metaMedia : null;
    const econ = t.economia, n = selAbast.size;
    flutuante.innerHTML =
      '<div class="sf-media"><span class="sf-rot">Média contra a meta</span>' +
        '<span class="sf-num"><strong class="num">' + (t.media ? fmt.d2(t.media) : '—') + '</strong> km/L' +
        (t.metaMedia ? '<small> · meta ' + fmt.d2(t.metaMedia) + '</small>' : '') + '</span></div>' +
      '<div class="sf-pct">' + (p !== null ? metaHtml(p, fmt.pct(p) + ' da meta') : '<span class="sem-dado">sem meta</span>') + '</div>' +
      '<div class="sf-det"><span>' + fmt.int(t.qtd) + (t.qtd === 1 ? ' abastecimento na conta' : ' abastecimentos na conta') + '</span>' +
        (t.qtd ? '<span>' + fmt.d2(Math.abs(econ)) + ' L ' + (econ >= 0 ? 'de economia' : 'gastos a mais') + '</span>' : '') + '</div>' +
      '<div class="sf-acoes">' +
        '<div class="segmentado" role="group" aria-label="Como usar a seleção">' +
          '<button type="button" data-modo="somente" aria-pressed="' + (modoSel === 'somente') + '" title="Conta só os ' + n + ' selecionados">Só os selecionados (' + fmt.int(n) + ')</button>' +
          '<button type="button" data-modo="exceto" aria-pressed="' + (modoSel === 'exceto') + '">Todos menos eles</button>' +
        '</div>' +
        '<button type="button" class="btn" data-ver-medidor title="Voltar ao medidor e aos números do painel">Ver painel</button>' +
        '<button type="button" class="link-acao" data-limpar-selecao>Limpar</button>' +
      '</div>';
    mostrarFlutuante();
  }
  function desenharSelecao() {
    const box = el('om-selecao');
    box.classList.toggle('oculto', !selAbast.size);
    if (!selAbast.size) { box.innerHTML = ''; return; }
    const n = selAbast.size, um = n === 1;
    box.innerHTML = '<span><strong>' + fmt.int(n) + (um ? ' abastecimento selecionado' : ' abastecimentos selecionados') + '.</strong> ' +
      (modoSel === 'somente'
        ? 'O painel está contando só ' + (um ? 'ele' : 'eles') + '.'
        : 'O painel está contando todos os abastecimentos do filtro, menos ' + (um ? 'este' : 'estes') + ' (' + fmt.int(consideradas.length) + ' na conta).') + '</span>' +
      '<div class="segmentado" role="group" aria-label="Como usar a seleção">' +
        '<button type="button" data-modo="somente" aria-pressed="' + (modoSel === 'somente') + '">Só os selecionados</button>' +
        '<button type="button" data-modo="exceto" aria-pressed="' + (modoSel === 'exceto') + '">Todos menos os selecionados</button>' +
      '</div>' +
      '<button type="button" class="link-acao" data-limpar-selecao>Limpar seleção</button>';
  }

  el('om-tabela').addEventListener('click', (e) => {
    // setinha no fim da linha: abre/fecha os detalhes sem mexer na seleção
    const ab = e.target.closest('[data-abrir]');
    if (ab) {
      const l = listaAtual[Number(ab.dataset.abrir)];
      if (!l) return;
      const k = chaveL(l);
      if (abertos.has(k)) abertos.delete(k); else abertos.add(k);
      desenharTabela();
      const novo = el('om-tabela').querySelector('[data-abrir="' + ab.dataset.abrir + '"]');
      if (novo) novo.focus();
      return;
    }
    if (e.target.closest('tr.om-detalhe')) return;   // clique nos detalhes não seleciona
    const tr = e.target.closest('tbody tr[data-i]');
    if (tr) { selecionarLinha(Number(tr.dataset.i), e); return; }
    const b = e.target.closest('[data-col]');
    if (!b) return;
    const c = b.dataset.col;
    const col = COLUNAS.find((x) => x.id === c);
    ordemTabela = ordemTabela.campo === c ? { campo: c, dir: -ordemTabela.dir } : { campo: c, dir: col.n || c === 'dia' ? -1 : 1 };
    paginaTabela = 0;
    desenharTabela();
  });
  el('om-paginacao').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pg]');
    if (!b || b.disabled) return;
    paginaTabela = Number(b.dataset.pg);
    desenharTabela();
    el('om-tabela').scrollIntoView({ block: 'nearest' });
  });
  let tBusca = null;
  el('om-busca').addEventListener('input', (e) => {
    clearTimeout(tBusca);
    tBusca = setTimeout(() => { buscaTabela = e.target.value; paginaTabela = 0; desenharTabela(); }, 150);
  });

  // baixar a tabela (CSV com ; e vírgula decimal, ou XLSX)
  const num = (titulo, casas, largura) => ({ titulo, tipo: 'numero', casas, largura: largura || 11 });
  ligarBaixar(el('om-exportar'), () => ({
    nome: 'operacao-por-motorista-' + new Date().toISOString().slice(0, 10), aba: 'Abastecimentos',
    colunas: [{ titulo: 'Data', tipo: 'data', largura: 11 }, { titulo: 'Motorista', largura: 30 }, { titulo: 'Placa', largura: 10 }, num('Km rodado', 0), num('Hodometro', 0),
      num('Meta', 2, 8), num('Media real', 2), num('Litros', 2), num('% tanque', 1, 9), { titulo: 'Despesa', tipo: 'moeda', largura: 12 }, num('R$/litro', 2, 9),
      num('Econ. litros', 2), { titulo: 'Posto', largura: 30 }, { titulo: 'Cidade', largura: 20 }, { titulo: 'Centro de custo', largura: 22 }, { titulo: 'Campanha', largura: 10 }],
    linhas: linhasTabela().map((l) => [
      diaIso(l.dia), l.motorista, l.placa, l.km, l.hodometro, l.meta,
      l.litros ? l.km / l.litros : null, l.litros, l.tanque ? l.litros / l.tanque * 100 : null,
      l.despesa, l.vlLitro, l.litrosMeta - l.litros, l.fornecedor, l.cidade, l.cc,
      l.campanha === 1 ? 'Sim' : l.campanha === 0 ? 'Não' : '',
    ]),
  }));

  // ---------- ciclo de atualização ----------
  let agendado = false, manterPagina = true;
  // manter: true quando só a seleção de abastecimentos mudou (a tabela fica na mesma página)
  function atualizar(manter) {
    manterPagina = manterPagina && manter === true;
    if (agendado) return;
    agendado = true;
    // microtarefa (não requestAnimationFrame): roda mesmo com a aba em segundo plano
    queueMicrotask(() => {
      agendado = false;
      filtradas = base.filter((l) => passa(l, null));
      // a seleção só vale para abastecimentos que continuam nos filtros
      if (selAbast.size) {
        const noFiltro = new Set(filtradas.map(chaveL));
        for (const k of [...selAbast]) if (!noFiltro.has(k)) selAbast.delete(k);
      }
      consideradas = !selAbast.size ? filtradas
        : filtradas.filter((l) => (modoSel === 'somente') === selAbast.has(chaveL(l)));
      const t = somar(consideradas);
      if (!manterPagina) paginaTabela = 0;
      manterPagina = true;
      filtros.atualizarUI();
      desenharSelecao();
      desenharIndicadores(t);
      desenharMedidor(t);
      desenharFlutuante(t);
      calcularEvolucao();
      desenharEvolucao();
      desenharRanking();
      desenharTabela();
    });
  }

  atualizar();

  // botão Atualizar da barra: dados novos entram mantendo os filtros escolhidos
  // parado: a tela saiu; chamadas atrasadas (dados novos, redimensionar) não desenham mais (27/11/2026)
  let parado = false;
  const aoAtualizarDados = () => carregarDados().then((d) => { if (parado) return; usarDados(d); atualizar(); });
  window.addEventListener('dados-atualizados', aoAtualizarDados);

  let tRedim = null;
  const aoRedimensionar = () => { if (parado) return; clearTimeout(tRedim); tRedim = setTimeout(desenharEvolucao, 120); };
  window.addEventListener('resize', aoRedimensionar);
  const ro = new ResizeObserver(aoRedimensionar);
  ro.observe(el('om-evolucao'));

  return {
    desmontar() {
      parado = true; clearTimeout(tRedim); clearTimeout(tRolar);
      filtros.destruir();
      window.removeEventListener('resize', aoRedimensionar);
      window.removeEventListener('dados-atualizados', aoAtualizarDados);
      ro.disconnect();
      document.removeEventListener('scroll', aoRolar, { capture: true });
      flutuante.remove();
      document.body.classList.remove('com-sel-flutuante');
    },
  };
}
