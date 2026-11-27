// Dashboard "Média geral" — mesmas regras da aba "Média Geral" do Power BI:
//  - veículos das categorias 3/4, BITRUCK, CAVALO, TOCO e TRUCK (filtro da página)
//  - combustível começa com todos os tipos de diesel que aparecem na Base (S-10, S-10 aditivado, comum...: lib/dados.js ehDiesel)
//  - Média real = km ÷ litros; Meta média = km ÷ litros se meta; Economia = litros se meta − litros
import { carregarDados, fmt, esc, fmtMes, mesDoDia, fmtDia, inicioDoMes, ehDiesel } from '../lib/dados.js';
import { criarFiltros, statusHtml, htmlApoio, agendador, botoesMaisMenos, metaHtml, faixaMeta, legendaMeta, trocarEndereco } from '../lib/filtros.js';
import { graficoPeriodo, htmlMedidor, emAndamento } from '../lib/graficos.js';

const CATEGORIAS = new Set(['3/4', 'BITRUCK', 'CAVALO', 'TOCO', 'TRUCK']);
const ROTA = '#/media-geral';
const POR_PAGINA = 25;
const DIAS_GRAFICO_DIARIO = 100;   // até ~3 meses de dados, o gráfico mostra dia a dia

const DIMENSOES = [
  { id: 'periodo', rotulo: 'Período', periodo: true },
  { id: 'cc', rotulo: 'Centro de custo', valor: (l) => l.cc },
  { id: 'combustivel', rotulo: 'Combustível', valor: (l) => l.combustivel },
  { id: 'categoria', rotulo: 'Categoria', valor: (l) => l.categoria },
  { id: 'motorista', rotulo: 'Motorista', valor: (l) => l.motorista },
  { id: 'modelo', rotulo: 'Modelo', valor: (l) => l.modelo },
  { id: 'placa', rotulo: 'Placa', valor: (l) => l.placa },
  { id: 'estabelecimento', rotulo: 'Estabelecimento', valor: (l) => l.tipoEstab },
];

function somar(linhas) {
  const t = { km: 0, litros: 0, litrosMeta: 0, qtd: linhas.length };
  for (const l of linhas) { t.km += l.km; t.litros += l.litros; t.litrosMeta += l.litrosMeta; }
  t.media = t.litros ? t.km / t.litros : null;
  t.meta = t.litrosMeta ? t.km / t.litrosMeta : null;
  t.pct = t.media && t.meta ? t.media / t.meta : null;
  t.economia = t.litrosMeta - t.litros;
  return t;
}

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando os abastecimentos…</div>';
  let dados;
  try { dados = await carregarDados(); } catch (e) {
    pagina.innerHTML = '<div class="vazio">' + esc(e.message) + ' Recarregue a página para tentar de novo.</div>';
    return {};
  }
  let base = [];
  function usarDados(d) {
    dados = d;
    // sem Arla nunca: a linha de Arla traz o km desde o Arla anterior (ex.: 1 L com 1.549 km = 1.549 km/L) e, com o filtro de
    // combustível vazio ou vindo de outro link, entrava na média (10/11/2026)
    base = d.linhas.filter((l) => CATEGORIAS.has(l.categoria) && !/ARLA/i.test(l.combustivel || ''));
    const g = new Date(d.geradoEm);
    ctx.definirSub('Dados atualizados em ' + g.toLocaleDateString('pt-BR') + ' às ' +
      g.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + ', com abastecimentos até ' + fmtDia(d.diaMax) +
      '. Categorias 3/4, bitruck, cavalo, toco e truck.');
  }
  usarDados(dados);
  if (!location.hash.includes('?')) {
    const diesels = [...new Set(dados.linhas.map((l) => l.combustivel).filter(ehDiesel))].sort();
    trocarEndereco(ROTA, ROTA + '?' + diesels.map((c) => 'combustivel=' + encodeURIComponent(c)).join('&'));
  }

  let filtradas = base;
  let ordem = { campo: 'km', dir: -1 };
  let limite = POR_PAGINA;

  pagina.innerHTML = `
    <section class="filtros" id="mg-filtros" aria-label="Filtros"></section>
    <div class="chips" id="mg-chips" aria-live="polite"></div>
    <div class="abertura">
      <section class="meta-bloco" aria-labelledby="mg-meta-titulo">
        <h2 id="mg-meta-titulo">Média km/L contra a meta</h2>
        <div class="medidor" id="mg-medidor"></div>
      </section>
      <dl class="apoio apoio-coluna" id="mg-apoio"></dl>
    </div>
    <section class="painel painel-largo">
      <div class="painel-cab">
        <h2 id="mg-grafico-titulo">Média real e meta, mês a mês</h2>
        <div class="legenda">${legendaMeta()}<span><i class="leg-meta"></i>Meta</span></div>
      </div>
      <div class="grafico-acoes">
        <p class="nota" id="mg-grafico-nota"></p>
        <button type="button" class="btn oculto" id="mg-voltar"><svg aria-hidden="true"><use href="#i-recolher"/></svg><span class="txt">Voltar ao período anterior</span></button>
      </div>
      <div class="grafico" id="mg-grafico"></div>
    </section>
    <section class="painel painel-tabela">
      <div class="painel-cab"><h2>Média por placa</h2><span class="conta" id="mg-conta"></span></div>

      <div class="tabela-rolagem"><table class="dados tabela-clicavel" id="mg-tabela"></table></div>
      <div id="mg-mais"></div>
    </section>`;
  const el = (id) => pagina.querySelector('#' + id);

  const filtros = criarFiltros({
    dimensoes: DIMENSOES, filtrosEl: el('mg-filtros'), chipsEl: el('mg-chips'), rota: ROTA,
    obterBase: () => base, obterLimites: () => [dados.diaMin, dados.diaMax], aoMudar: () => { limite = POR_PAGINA; atualizar(); }, prefixo: 'mg', periodoPadrao: 'mes',
  });

  function desenharTopo() {
    const t = somar(filtradas);
    el('mg-medidor').innerHTML = htmlMedidor(t.media, t.meta, statusHtml);
    const placas = new Set(filtradas.map((l) => l.placa));
    el('mg-apoio').innerHTML = htmlApoio([
      { rot: 'Km rodado', val: fmt.int(t.km) },
      { rot: t.economia >= 0 ? 'Economia real (litros)' : 'Litros gastos a mais', val: fmt.d2(Math.abs(t.economia)), det: t.qtd ? metaHtml(t.meta ? t.media / t.meta : (t.economia >= 0 ? 1 : 0), t.economia >= 0 ? 'dentro da meta' : 'acima da meta') : '' },
      { rot: 'Litros', val: fmt.int(t.litros) },
      { rot: 'Veículos', val: fmt.int(placas.size) },
    ]);
  }

  // ---------- gráfico: segue os filtros e também filtra o painel ----------
  // clicar num mês filtra o painel inteiro por ele (e o gráfico passa a mostrar os dias do mês); clicar num dia
  // filtra aquele dia. "Voltar" devolve o período que estava antes do clique.
  const anteriores = [];
  // quem estava no carro no dia (26/11/2026, pedido do usuário: o mesmo carro pode ter mais de um motorista). Com mais de um,
  // cada nome leva a média dele no dia; ordem: quem mais rodou
  function motoristasDoDia(ls) {
    const m = new Map();
    for (const l of ls) {
      const a = m.get(l.motorista) || { km: 0, litros: 0 };
      a.km += l.km || 0; a.litros += l.litros || 0;
      m.set(l.motorista, a);
    }
    const lista = [...m.entries()].sort((a, b) => b[1].km - a[1].km);
    const nomes = lista.map(([nome, a]) => nome + (lista.length > 1 && a.litros ? ' (' + fmt.d2(a.km / a.litros) + ' km/L)' : ''));
    // sem placa filtrada o dia tem dezenas de motoristas: os 3 que mais rodaram e quantos mais
    return nomes.length <= 4 ? nomes : [...nomes.slice(0, 3), 'e mais ' + (nomes.length - 3) + ' (filtre uma placa para ver quem estava em cada carro)'];
  }
  function desenharGrafico() {
    let min = Infinity, max = -Infinity;
    for (const l of filtradas) { if (l.dia < min) min = l.dia; if (l.dia > max) max = l.dia; }
    const porDia = filtradas.length && max - min <= DIAS_GRAFICO_DIARIO;
    el('mg-grafico-titulo').textContent = 'Média real e meta, ' + (porDia ? 'dia a dia' : 'mês a mês');
    el('mg-grafico-nota').textContent = porDia
      ? 'Clique em um dia para filtrar o painel por ele.'
      : 'Clique em um mês para filtrar o painel por ele e ver os dias do mês.';
    el('mg-voltar').classList.toggle('oculto', !anteriores.length);
    const grupos = new Map();
    for (const l of filtradas) {
      const k = porDia ? l.dia : mesDoDia(l.dia);
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(l);
    }
    const pts = [...grupos.entries()].sort((a, b) => a[0] - b[0]).map(([k, ls]) => {
      const t = somar(ls);
      return {
        chave: k, porDia,
        rotulo: porDia ? fmtDia(k).slice(0, 5) : fmtMes(k), rotuloLongo: porDia ? fmtDia(k) : fmtMes(k, true),
        media: t.media, meta: t.meta, km: t.km, pct: t.pct,
        motoristas: porDia ? motoristasDoDia(ls) : null,
      };
    });
    const p = filtros.periodo;
    graficoPeriodo(el('mg-grafico'), pts, {
      // colunas com a cor da faixa do % da meta; escala sem os picos (dia com abastecimento pequeno dá km/L irreal)
      barras: { campo: 'media', rot: 'Média real', cor: 'var(--serie-1)', corDe: (q) => (faixaMeta(q.pct) ? 'var(--' + faixaMeta(q.pct) + ')' : null) },
      cortarPicos: true,
      ultimoParcial: pts.length > 1 && emAndamento(porDia ? 'dia' : 'mes', pts[pts.length - 1].chave),
      linhas: [{ campo: 'meta', rot: 'Meta', cor: 'var(--tinta-2)' }],
      fmtV: (v) => (v === null || v === undefined ? '—' : fmt.d2(v)), fmtEixo: fmt.d1,
      extras: (q) => [['% da meta', fmt.pct(q.pct)], ['Km rodado', fmt.int(q.km)],
        ...(q.motoristas && q.motoristas.length ? [[q.motoristas.length === 1 ? 'Motorista' : 'Motoristas', q.motoristas.join(' · ').replace(' · e mais', ' e mais')]] : [])],
      rotulo: 'Média real em colunas e meta em linha, ' + (porDia ? 'por dia' : 'por mês'),
      // um dia filtrado: a coluna dele fica em destaque e as outras apagadas
      destacar: porDia && p.de !== null && p.de === p.ate ? (q) => q.chave === p.de : null,
      aoClicar: (q) => {
        const de = q.porDia ? q.chave : inicioDoMes(q.chave);
        const ate = q.porDia ? q.chave : inicioDoMes(q.chave + 1) - 1;
        if (p.de === de && p.ate === ate) { voltar(); return; }   // clicou de novo no que já está filtrado
        anteriores.push({ de: p.de, ate: p.ate, preset: p.preset });
        filtros.definirPeriodo(de, ate);
      },
    });
  }
  function voltar() {
    const a = anteriores.pop();
    if (a) filtros.definirPeriodo(a.de, a.ate, a.preset);
    else filtros.definirPeriodo(null, null);
    queueMicrotask(() => el('mg-grafico').focus());
  }
  el('mg-voltar').addEventListener('click', voltar);

  const COLUNAS = [
    { id: 'placa', rot: 'Placa', v: (a) => a.placa },
    { id: 'modelo', rot: 'Modelo', v: (a) => a.modelo },
    { id: 'ano', rot: 'Ano', v: (a) => a.ano || '' },
    { id: 'meta', rot: 'Meta (km/L)', n: true, v: (a) => a.meta },
    { id: 'media', rot: 'Média real', n: true, v: (a) => a.media },
    { id: 'pct', rot: '% da meta', n: true, v: (a) => a.pct },
    { id: 'km', rot: 'Km rodado', n: true, v: (a) => a.km },
  ];
  function desenharTabela() {
    const grupos = new Map();
    for (const l of filtradas) {
      if (!grupos.has(l.placa)) grupos.set(l.placa, { placa: l.placa, modelo: l.modelo, ano: l.ano, linhas: [] });
      grupos.get(l.placa).linhas.push(l);
    }
    const lista = [...grupos.values()].map((g) => Object.assign(g, somar(g.linhas)));
    const c = COLUNAS.find((x) => x.id === ordem.campo);
    lista.sort((a, b) => {
      const va = c.v(a), vb = c.v(b);
      if (va === null) return 1; if (vb === null) return -1;
      return ordem.dir * (typeof va === 'string' ? va.localeCompare(vb, 'pt-BR', { numeric: true }) : va - vb);
    });
    const sel = filtros.sel.placa;
    el('mg-conta').textContent = fmt.int(lista.length) + (lista.length === 1 ? ' placa' : ' placas');
    el('mg-tabela').innerHTML =
      '<thead><tr>' + COLUNAS.map((col) => {
        const ativa = ordem.campo === col.id;
        return '<th class="' + (col.n ? 'n' : '') + '" aria-sort="' + (ativa ? (ordem.dir < 0 ? 'descending' : 'ascending') : 'none') + '">' +
          '<button type="button" data-col="' + col.id + '">' + esc(col.rot) + (ativa ? '<span class="seta">' + (ordem.dir < 0 ? '▼' : '▲') + '</span>' : '') + '</button></th>';
      }).join('') + '</tr></thead><tbody>' +
      (lista.length ? lista.slice(0, limite).map((a) =>
        '<tr class="' + (sel.has(a.placa) ? 'selecionado' : '') + '" data-placa="' + esc(a.placa) + '">' +
          '<td><button type="button" class="link-botao nome-clicavel" data-placa="' + esc(a.placa) + '" aria-pressed="' + sel.has(a.placa) + '">' + esc(a.placa) + '</button></td>' +
          '<td class="trunc">' + esc(a.modelo) + '</td><td>' + esc(a.ano || '—') + '</td>' +
          '<td class="n">' + esc(fmt.d2(a.meta)) + '</td><td class="n">' + esc(fmt.d2(a.media)) + '</td>' +
          '<td class="n">' + (a.pct === null ? '—' : metaHtml(a.pct, fmt.pct(a.pct))) + '</td>' +
          '<td class="n">' + esc(fmt.int(a.km)) + '</td></tr>').join('')
        : '<tr><td colspan="' + COLUNAS.length + '"><div class="vazio">Nenhum abastecimento neste recorte.</div></td></tr>') + '</tbody>';
    el('mg-mais').innerHTML = botoesMaisMenos(lista.length, limite, POR_PAGINA);
  }
  el('mg-tabela').addEventListener('click', (e) => {
    const b = e.target.closest('[data-col]');
    if (b) {
      const col = COLUNAS.find((x) => x.id === b.dataset.col);
      ordem = ordem.campo === col.id ? { campo: col.id, dir: -ordem.dir } : { campo: col.id, dir: col.n ? -1 : 1 };
      desenharTabela();
      const novo = el('mg-tabela').querySelector('[data-col="' + col.id + '"]');
      if (novo) novo.focus();
      return;
    }
    const linha = e.target.closest('tr[data-placa]');
    if (linha) filtros.alternar('placa', linha.dataset.placa);
  });
  el('mg-mais').addEventListener('click', (e) => {
    if (e.target.closest('[data-mais]')) { limite += POR_PAGINA; desenharTabela(); return; }
    if (e.target.closest('[data-menos]')) { limite = POR_PAGINA; desenharTabela(); el('mg-tabela').scrollIntoView({ block: 'nearest' }); }
  });

  const atualizar = agendador(() => {
    filtradas = base.filter((l) => filtros.passa(l, null));
    filtros.atualizarUI();
    desenharTopo();
    desenharGrafico();
    desenharTabela();
  });
  atualizar();

  let tRedim = null;
  const aoRedimensionar = () => { clearTimeout(tRedim); tRedim = setTimeout(desenharGrafico, 120); };
  window.addEventListener('resize', aoRedimensionar);
  const aoAtualizarDados = () => carregarDados().then((d) => { usarDados(d); atualizar(); });
  window.addEventListener('dados-atualizados', aoAtualizarDados);
  return {
    desmontar() {
      filtros.destruir();
      window.removeEventListener('resize', aoRedimensionar);
      window.removeEventListener('dados-atualizados', aoAtualizarDados);
    },
  };
}
