// Dashboard "Evolução placas" — a matriz da aba "Evolução Motoristas%" do Power BI, com placas no lugar dos motoristas:
//  - linhas: placas (sem o centro de custo desde 26/11/2026, pedido do usuário: a placa pode passar por mais de uma unidade no
//    mesmo período e aparecia nas duas); colunas: meses; valor: % = Média real ÷ Meta média
//  - só diesel; veículos com categoria na aba Metas, exceto PICAPE e VENDA; sem os abastecimentos dos 3 motoristas
//    que a matriz do Power BI exclui
//  - verde quando a economia de litros é positiva (dentro da meta), vermelho quando é negativa
import { carregarDados, fmt, esc, fmtMes, mesDoDia, ehDiesel } from '../lib/dados.js';
import { criarFiltros, statusHtml, htmlApoio, agendador, faixaMeta, metaHtml, legendaMeta } from '../lib/filtros.js';
import { htmlMedidor, emAndamento } from '../lib/graficos.js';

const DIESEL = { has: ehDiesel };   // todo tipo de diesel (lib/dados.js)
const CATEGORIAS_FORA = new Set(['PICAPE', 'VENDA']);
const MOTORISTAS_FORA = new Set(['ANTONIO MARCOS GOCALVES SOUSA', 'GUILHERME DE ALMEIDA RODRIGUES', 'VITOR FERNANDES COELHO']);
const ROTA = '#/evolucao-placas';

// mesmos filtros da página do Power BI
const DIMENSOES = [
  { id: 'periodo', rotulo: 'Período', periodo: true },
  { id: 'motorista', rotulo: 'Motorista', valor: (l) => l.motorista },
  { id: 'placa', rotulo: 'Placa', valor: (l) => l.placa },
  { id: 'estabelecimento', rotulo: 'Estabelecimento', valor: (l) => l.tipoEstab },
  { id: 'campanha', rotulo: 'Campanha', valor: (l) => (l.campanha === 1 ? 'Sim' : l.campanha === 0 ? 'Não' : 'Sem registro') },
];

const novo = () => ({ km: 0, litros: 0, litrosMeta: 0 });
function somar(a, l) { a.km += l.km; a.litros += l.litros; a.litrosMeta += l.litrosMeta; }
function pct(a) {
  if (!a || !a.litros || !a.litrosMeta) return null;
  return (a.km / a.litros) / (a.km / a.litrosMeta);
}
function acumular(alvo, m, l) {
  somar(alvo.total, l);
  if (!alvo.porMes.has(m)) alvo.porMes.set(m, novo());
  somar(alvo.porMes.get(m), l);
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
    base = d.linhas.filter((l) => DIESEL.has(l.combustivel) && l.categoria && !CATEGORIAS_FORA.has(l.categoria) && !MOTORISTAS_FORA.has(l.motorista));
    const g = new Date(d.geradoEm);
    ctx.definirSub('Dados atualizados em ' + g.toLocaleDateString('pt-BR') + ' às ' +
      g.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '. % da meta de km/L de cada placa, mês a mês.');
  }
  usarDados(dados);

  // sem filtro no endereço, abre no ano atual (a matriz com todos os meses desde 2023 fica larga demais)
  if (!location.hash.includes('?')) history.replaceState(null, '', ROTA + '?periodo=ano');

  let ordem = 'placa';                 // 'placa' (A-Z) ou 'pct' (melhor % primeiro)
  let filtradas = base;

  pagina.innerHTML = `
    <section class="filtros" id="ep-filtros" aria-label="Filtros"></section>
    <div class="chips" id="ep-chips" aria-live="polite"></div>
    <div class="abertura">
      <section class="meta-bloco" aria-labelledby="ep-meta-titulo">
        <h2 id="ep-meta-titulo">Média km/L contra a meta</h2>
        <div class="medidor" id="ep-medidor"></div>
      </section>
      <dl class="apoio apoio-coluna" id="ep-apoio"></dl>
    </div>
    <section class="painel painel-tabela">
      <div class="painel-cab">
        <h2>% da meta por placa, mês a mês</h2>
        <div class="segmentado" role="group" aria-label="Ordenar placas">
          <button type="button" data-ordem="placa" aria-pressed="true">Placa A-Z</button>
          <button type="button" data-ordem="pct" aria-pressed="false">Melhor %</button>
        </div>
      </div>

      <div class="legenda-matriz">${legendaMeta()}</div>
      <div class="tabela-rolagem matriz-rolagem"><table class="dados matriz" id="ep-matriz"></table></div>
    </section>`;
  const el = (id) => pagina.querySelector('#' + id);

  const filtros = criarFiltros({
    dimensoes: DIMENSOES, filtrosEl: el('ep-filtros'), chipsEl: el('ep-chips'), rota: ROTA,
    obterBase: () => base, obterLimites: () => [dados.diaMin, dados.diaMax], aoMudar: () => atualizar(), prefixo: 'ep',
  });

  function desenharTopo() {
    const t = novo();
    const placas = new Set();
    filtradas.forEach((l) => { somar(t, l); placas.add(l.placa); });
    const media = t.litros ? t.km / t.litros : null, meta = t.litrosMeta ? t.km / t.litrosMeta : null;
    el('ep-medidor').innerHTML = htmlMedidor(media, meta, statusHtml);
    const econ = t.litrosMeta - t.litros;
    el('ep-apoio').innerHTML = htmlApoio([
      { rot: '% da meta', val: fmt.pct(pct(t)) },
      { rot: econ >= 0 ? 'Economia de litros' : 'Litros gastos a mais', val: fmt.d2(Math.abs(econ)), det: filtradas.length ? metaHtml(pct(t), econ >= 0 ? 'dentro da meta' : 'acima da meta') : '' },
      { rot: 'Km rodado', val: fmt.int(t.km) },
      { rot: 'Placas', val: fmt.int(placas.size) },
    ]);
  }

  // célula: % da meta, com a cor da faixa (100%+, 95 a 100%, 90 a 95%, menos de 90%; o número sempre escrito)
  function celula(a, extra) {
    const p = pct(a);
    const cls = 'n' + (extra ? ' ' + extra : '');
    if (p === null) return '<td class="' + cls + ' c-vazia"><span class="sr">sem abastecimento</span></td>';
    return '<td class="' + cls + ' c-' + faixaMeta(p) + '" title="' +
      esc(fmt.d2(a.km / a.litros) + ' km/L; meta ' + fmt.d2(a.km / a.litrosMeta) + ' km/L; ' + fmt.int(a.km) + ' km') + '">' +
      esc(fmt.pct(p).replace(',00%', '%')) + '</td>';
  }

  function desenharMatriz() {
    const meses = [...new Set(filtradas.map((l) => mesDoDia(l.dia)))].sort((a, b) => a - b);
    const porPlaca = new Map();   // placa -> {total, porMes, modelo}
    const geral = { total: novo(), porMes: new Map() };
    for (const l of filtradas) {
      const m = mesDoDia(l.dia);
      let p = porPlaca.get(l.placa);
      if (!p) porPlaca.set(l.placa, (p = { total: novo(), porMes: new Map(), modelo: l.modelo }));
      acumular(p, m, l); acumular(geral, m, l);
    }
    const cmpNome = (a, b) => a.localeCompare(b, 'pt-BR', { numeric: true });
    const cmpPct = (a, b) => (pct(b.total) ?? -1) - (pct(a.total) ?? -1);
    const placas = [...porPlaca.entries()].sort(ordem === 'pct' ? (a, b) => cmpPct(a[1], b[1]) || cmpNome(a[0], b[0]) : (a, b) => cmpNome(a[0], b[0]));
    const sel = filtros.sel.placa;
    el('ep-matriz').innerHTML = !meses.length
      ? '<tbody><tr><td><div class="vazio">Nenhum abastecimento neste recorte. Tire um filtro para ver a matriz.</div></td></tr></tbody>'
      : '<thead><tr><th class="col-fixa"><span>Placa</span></th>' +
          meses.map((m) => '<th class="n"' + (emAndamento('mes', m) ? ' title="Mês em andamento: % da meta dos dias até agora"' : '') + '><span>' + esc(fmtMes(m)) + (emAndamento('mes', m) ? ' <small>(parcial)</small>' : '') + '</span></th>').join('') + '<th class="n col-total"><span>Total</span></th></tr></thead><tbody>' +
        placas.map(([placa, p]) =>
          '<tr class="' + (sel.has(placa) ? 'selecionado' : '') + '"><th class="col-fixa" scope="row"><button type="button" class="link-botao nome-clicavel" data-placa="' + esc(placa) + '" aria-pressed="' + sel.has(placa) + '">' +
            esc(placa) + '</button><small class="cidade-linha">' + esc(p.modelo) + '</small></th>' +
            meses.map((m) => celula(p.porMes.get(m))).join('') + celula(p.total, 'col-total') + '</tr>').join('') +
        '<tr class="linha-total"><th class="col-fixa" scope="row">Total</th>' + meses.map((m) => celula(geral.porMes.get(m))).join('') +
          celula(geral.total, 'col-total') + '</tr></tbody>';
  }
  el('ep-matriz').addEventListener('click', (e) => {
    const p = e.target.closest('[data-placa]');
    if (p) filtros.alternar('placa', p.dataset.placa);
  });
  pagina.querySelector('.segmentado').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ordem]');
    if (!b) return;
    ordem = b.dataset.ordem;
    pagina.querySelectorAll('[data-ordem]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    desenharMatriz();
  });

  const atualizar = agendador(() => {
    filtradas = base.filter((l) => filtros.passa(l, null));
    filtros.atualizarUI();
    desenharTopo();
    desenharMatriz();
  });
  atualizar();

  const aoAtualizarDados = () => carregarDados().then((d) => { usarDados(d); atualizar(); });
  window.addEventListener('dados-atualizados', aoAtualizarDados);
  return {
    desmontar() {
      filtros.destruir();
      window.removeEventListener('dados-atualizados', aoAtualizarDados);
    },
  };
}
