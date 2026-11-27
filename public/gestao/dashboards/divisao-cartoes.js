// Dashboard "Divisão por cartão" — réplica da página "% Cartão" do Power BI, sem o gráfico de cima
// (especificação em design-system/DIVISAO-CARTOES.md):
//  - só postos externos (TIPO ESTABELECIMENTO = POSTO DE COMBUSTIVEL ou CAIS VIBRA), todos os combustíveis;
//  - cartão = FORMA DE PAGAMENTO ("Cartao Fisico" = Ticket), como no resto do portal;
//  - Mês a mês e Dia a dia: % dos litros de cada cartão (100% empilhado); clicar num cartão filtra o cartão, e os
//    gráficos continuam com todos os cartões, o escolhido em destaque; clicar num mês escolhe o mês do Dia a dia;
//  - a matriz não tem a Média 6 meses nem o 50% Ticket;
//  - Controle Ticket Log (26/11/2026, pedido do usuário; era o gráfico de cima do Power BI): litros no cartão Ticket por mês,
//    a média dos 6 meses anteriores e 50% dessa média (o volume mínimo a acompanhar). Segue os filtros, menos o Período (a
//    média precisa dos meses de antes) e o Cartão (é sempre o Ticket).
import { carregarDados, fmt, esc, fmtMes, mesDoDia, inicioDoMes, dataParaDia } from '../lib/dados.js';
import { criarFiltros, htmlApoio, agendador } from '../lib/filtros.js';
import { graficoPeriodo } from '../lib/graficos.js';
import { nomeCartao, corCartao, corTextoCartao } from '../lib/cartoes.js';

const EXTERNOS = new Set(['POSTO DE COMBUSTIVEL', 'CAIS VIBRA']);
const ORDEM = ['TICKET', 'TRUCKPAG', 'VELOE', 'VIBRA'];
const SEM = '(sem informação)';
const MAX_MESES = 24, POR_PAGINA = 25;
const chaveCartao = (l) => l.cartao || SEM;
const rotCartao = (k) => (k === SEM ? 'Sem informação' : nomeCartao(k));
const cor = (k) => (k === SEM ? '#5F6663' : corCartao(k));
const corTexto = (k) => (k === SEM ? '#fff' : corTextoCartao(k));
const posicao = (k) => { const i = ORDEM.indexOf(k); return k === SEM ? 99 : i < 0 ? 50 : i; };
const ordenarCartoes = (ks) => [...ks].sort((a, b) => posicao(a) - posicao(b) || a.localeCompare(b));
const L = (v) => fmt.int(v) + ' L';
// % inteiro para as colunas estreitas do Dia a dia (18/11/2026): 0,634 -> "63%"; abaixo de 1% mostra "<1%"
export const pctCurto = (p) => (p > 0 && p < 0.005 ? '<1%' : Math.round(p * 100) + '%');

const DIMENSOES = [
  { id: 'periodo', rotulo: 'Período', periodo: true },
  { id: 'cartao', rotulo: 'Cartão', valor: (l) => rotCartao(chaveCartao(l)) },
  { id: 'cc', rotulo: 'Centro de custo', valor: (l) => l.cc },
  { id: 'fornecedor', rotulo: 'Fornecedor', valor: (l) => l.fornecedor || '(sem nome)' },
  { id: 'combustivel', rotulo: 'Combustível', valor: (l) => l.combustivel },
  { id: 'placa', rotulo: 'Placa', valor: (l) => l.placa },
];

// soma de litros por chave e cartão: Map chave -> {total, por: Map cartão -> litros}
function somar(linhas, chave) {
  const m = new Map();
  for (const l of linhas) {
    const k = chave(l);
    let a = m.get(k);
    if (!a) m.set(k, (a = { total: 0, por: new Map() }));
    a.total += l.litros;
    const c = chaveCartao(l);
    a.por.set(c, (a.por.get(c) || 0) + l.litros);
  }
  return m;
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
    base = d.linhas.filter((l) => EXTERNOS.has(l.tipoEstab) && l.litros > 0);
    const g = new Date(d.geradoEm);
    ctx.definirSub('Dados atualizados em ' + g.toLocaleDateString('pt-BR') + ' às ' + g.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) +
      '. Só postos externos (sem a bomba interna), todos os combustíveis.');
  }
  usarDados(dados);

  let filtradas = [], semCartao = [];
  let mesDia = null;                         // mês do gráfico "Dia a dia" (null = o último do período)
  const abertos = new Set();                 // meses abertos na matriz
  let ordemForn = { campo: 'litros', dir: -1 }, buscaForn = '', paginaForn = 0;

  pagina.innerHTML = `
    <section class="filtros" id="dc-filtros" aria-label="Filtros"></section>
    <div class="chips" id="dc-chips" aria-live="polite"></div>
    <dl class="apoio apoio-pilha" id="dc-apoio"></dl>
    <section class="painel">
      <div class="painel-cab"><h2>Mês a mês</h2><span class="conta" id="dc-conta-mes"></span></div>
      <div class="dc-legenda" id="dc-legenda" role="group" aria-label="Cartões (clique para filtrar)"></div>
      <div class="dc-grafico" id="dc-meses"></div>
      <p class="nota">% dos litros de cada cartão no mês. Clique num mês para ver o dia a dia dele; clique num cartão para filtrar.</p>
    </section>
    <section class="painel">
      <div class="painel-cab"><h2 id="dc-tit-dias">Dia a dia</h2><span class="conta" id="dc-conta-dia"></span></div>
      <div class="dc-grafico dc-grafico-dias" id="dc-dias"></div>
    </section>
    <section class="painel">
      <div class="painel-cab"><h2>Controle Ticket Log</h2><div class="legenda"><span><i class="leg-barra" style="background:${corCartao('TICKET')}"></i>Litros no Ticket</span>
        <span><i class="leg-meta"></i>Média 6 meses</span><span><i class="leg-tracejada"></i>50% da média</span></div></div>
      <div class="grafico" id="dc-ticket"></div>
      <p class="nota">Litros abastecidos com o cartão Ticket (Cartão Físico) em cada mês, a média dos 6 meses anteriores e a linha de 50% dessa média.</p>
    </section>
    <div class="grade-paineis">
      <section class="painel conter">
        <div class="painel-cab"><h2>Litros por mês e cartão</h2><span class="conta" id="dc-conta-mat"></span></div>
        <div class="tabela-rolagem"><table class="dados tabela-clicavel dc-matriz" id="dc-matriz"></table></div>
        <p class="nota">Clique no mês para abrir os cartões; clique no cartão para filtrar.</p>
      </section>
      <section class="painel conter painel-tabela dc-forn-painel">
        <div class="painel-cab"><h2>Litros por fornecedor</h2><span class="conta" id="dc-conta-forn"></span></div>
        <div class="tabela-ferramentas"><input type="search" id="dc-busca" placeholder="Posto ou cidade…" aria-label="Procurar fornecedor" autocomplete="off"></div>
        <div class="tabela-rolagem"><table class="dados tabela-clicavel" id="dc-forn"></table></div>
        <div class="paginacao" id="dc-paginacao"></div>
      </section>
    </div>`;
  const el = (id) => pagina.querySelector('#' + id);

  const filtros = criarFiltros({
    dimensoes: DIMENSOES, filtrosEl: el('dc-filtros'), chipsEl: el('dc-chips'), rota: '#/divisao-cartoes', visiveis: 4,
    obterBase: () => base, obterLimites: () => [dados.diaMin, dados.diaMax], aoMudar: () => atualizar(), prefixo: 'dc', periodoPadrao: 'ano',
  });
  const selCartao = () => filtros.sel.cartao;
  const apagado = (k) => selCartao().size > 0 && !selCartao().has(rotCartao(k));

  // ---------- topo ----------
  function desenharTopo() {
    const tot = semCartao.reduce((s, l) => s + l.litros, 0);
    const por = somar(semCartao, () => 'x').get('x');
    const itens = [{ rot: 'Litros no período', val: L(filtradas.reduce((s, l) => s + l.litros, 0)) }];
    if (por) for (const k of ordenarCartoes(por.por.keys())) itens.push({ rot: rotCartao(k), val: fmt.pct(tot ? por.por.get(k) / tot : 0) });
    el('dc-apoio').innerHTML = htmlApoio(itens);
  }

  // ---------- colunas 100% empilhadas (Mês a mês e Dia a dia) ----------
  // cols: [{id, rot, rotLongo, total, por: Map, marcado, oculto (rótulo do eixo), parcial}]
  // textos: true = % com casas (Mês a mês); 'curto' = % inteiro, fonte menor (Dia a dia, colunas estreitas; 18/11/2026); false = sem
  function htmlColunas(cols, cartoes, textos) {
    const curto = textos === 'curto';
    return '<div class="dc-colunas" style="--n:' + cols.length + '">' + cols.map((c, i) => {
      const segs = cartoes.filter((k) => c.por.get(k)).map((k) => {
        const p = c.por.get(k) / c.total;
        return '<span class="dc-seg' + (apagado(k) ? ' apagado' : '') + (corTexto(k) !== '#fff' ? ' claro' : '') + '" data-cartao="' + esc(k) + '" style="height:' + (p * 100).toFixed(3) + '%;background:' + cor(k) + ';color:' + corTexto(k) + '">' +
          (textos && p >= (curto ? 0.1 : 0.08) ? '<b' + (curto ? ' class="dc-pct-curto"' : '') + '>' + esc(curto ? pctCurto(p) : fmt.pct(p)) + '</b>' : '') + '</span>';
      }).join('');
      const desc = c.total ? cartoes.filter((k) => c.por.get(k)).map((k) => rotCartao(k) + ' ' + fmt.pct(c.por.get(k) / c.total)).join(', ') : 'sem abastecimento';
      return '<button type="button" class="dc-col' + (c.marcado ? ' marcado' : '') + (c.total ? '' : ' vazia') + '" data-i="' + i + '" aria-label="' + esc(c.rotLongo + ': ' + desc) + '"' +
        (c.marcado ? ' aria-pressed="true"' : '') + '><span class="dc-pilha">' + segs + '</span><span class="dc-rot' + (c.oculto ? ' dc-rot-oculto' : '') + '">' +
        (c.rotCurto ? '<span class="dc-rot-l">' + esc(c.rot) + '</span><span class="dc-rot-m" aria-hidden="true">' + esc(c.rotCurto) + '</span><span class="dc-rot-c" aria-hidden="true">' + esc(c.rotCurto.charAt(0).toUpperCase()) + '</span>' : esc(c.rot)) +
        '</span></button>';
    }).join('') + '</div><div class="dica oculto"></div>';
  }
  function ligarColunas(box, cols, cartoes, aoEscolher) {
    const dica = box.querySelector('.dica');
    const mostrar = (b) => {
      const c = cols[Number(b.dataset.i)];
      if (!c || !c.total) { dica.classList.add('oculto'); return; }
      dica.innerHTML = '<strong>' + esc(c.rotLongo) + (c.parcial ? ' · em andamento' : '') + '</strong>' +
        cartoes.filter((k) => c.por.get(k)).map((k) => '<div class="linha-dica"><span><i style="background:' + cor(k) + '"></i>' + esc(rotCartao(k)) + '</span><b class="num">' +
          esc(fmt.pct(c.por.get(k) / c.total)) + ' · ' + esc(L(c.por.get(k))) + '</b></div>').join('') +
        '<div class="linha-dica"><span>Total</span><b class="num">' + esc(L(c.total)) + '</b></div>';
      dica.classList.remove('oculto');
      const r = b.getBoundingClientRect(), rb = box.getBoundingClientRect();
      let left = r.left - rb.left + r.width / 2 + 10;
      if (left + dica.offsetWidth > box.clientWidth) left = r.left - rb.left + r.width / 2 - dica.offsetWidth - 10;
      dica.style.left = Math.max(0, left) + 'px';
      dica.style.top = '6px';
    };
    box.onmouseover = (e) => { const b = e.target.closest('.dc-col'); if (b) mostrar(b); };
    box.onfocusin = (e) => { const b = e.target.closest('.dc-col'); if (b) mostrar(b); };
    box.onmouseleave = () => dica.classList.add('oculto');
    box.onfocusout = () => dica.classList.add('oculto');
    box.onclick = (e) => {
      const s = e.target.closest('.dc-seg');
      if (s) { filtros.alternar('cartao', rotCartao(s.dataset.cartao)); return; }
      const b = e.target.closest('.dc-col');
      if (b && aoEscolher) aoEscolher(cols[Number(b.dataset.i)]);
    };
    box.onkeydown = (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const bs = [...box.querySelectorAll('.dc-col')], i = bs.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const j = Math.max(0, Math.min(bs.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
      bs[j].focus();
    };
  }

  // ---------- controle Ticket Log ----------
  // média 6 meses = média dos litros no Ticket nos 6 meses anteriores (mês sem Ticket conta 0; no começo da Base, os que houver)
  function desenharTicket() {
    const porMes = new Map();
    let primeiro = Infinity;
    for (const l of base) {
      if (chaveCartao(l) !== 'TICKET' || !filtros.passa(l, ['periodo', 'cartao'])) continue;
      const m = mesDoDia(l.dia);
      porMes.set(m, (porMes.get(m) || 0) + l.litros);
      if (m < primeiro) primeiro = m;
    }
    const ms = [...new Set(semCartao.map((l) => mesDoDia(l.dia)))].sort((a, b) => a - b);
    const box = el('dc-ticket');
    if (!ms.length || !porMes.size) { box.innerHTML = '<div class="vazio">Nenhum abastecimento no Ticket neste recorte.</div>'; return; }
    const meses = [];
    for (let m = Math.max(ms[0], ms[ms.length - 1] - MAX_MESES + 1); m <= ms[ms.length - 1]; m++) meses.push(m);
    const atual = mesDoDia(dataParaDia(new Date()));
    const pts = meses.map((m) => {
      const ant = [];
      for (let k = m - 6; k < m; k++) if (k >= primeiro) ant.push(porMes.get(k) || 0);
      const media = ant.length ? ant.reduce((s, v) => s + v, 0) / ant.length : null;
      return { mes: m, rotulo: fmtMes(m), rotuloLongo: fmtMes(m, true) + (m === atual ? ' (mês parcial)' : ''), litros: porMes.get(m) || 0, media, metade: media === null ? null : media / 2 };
    });
    graficoPeriodo(box, pts, {
      barras: { campo: 'litros', rot: 'Litros no Ticket', cor: corCartao('TICKET') },
      linhas: [{ campo: 'media', rot: 'Média 6 meses', cor: 'var(--tinta-2)' }, { campo: 'metade', rot: '50% da média', cor: 'var(--tinta-2)', tracejada: true }],
      fmtV: (v) => (v === null || v === undefined ? '—' : L(v)), fmtRotulo: (v) => (v ? fmt.curto(v) : ''), fmtEixo: (v) => fmt.curto(v),
      ultimoParcial: pts.length > 1 && pts[pts.length - 1].mes === atual,
      extras: (q) => (q.media ? [['Contra a média', fmt.pct(q.litros / q.media)], ['Contra os 50%', fmt.pct(q.litros / q.metade)]] : []),
      rotulo: 'Litros no cartão Ticket por mês em colunas, média dos 6 meses anteriores e 50% da média em linhas',
    });
  }

  function desenharMeses() {
    const por = somar(semCartao, (l) => mesDoDia(l.dia));
    const ms = [...por.keys()].sort((a, b) => a - b);
    const box = el('dc-meses');
    if (!ms.length) {
      box.innerHTML = '<div class="vazio">Nenhum abastecimento em postos externos neste recorte.</div>';
      el('dc-legenda').innerHTML = ''; el('dc-conta-mes').textContent = '';
      mesDia = null;
      return;
    }
    const meses = [];
    for (let m = Math.max(ms[0], ms[ms.length - 1] - MAX_MESES + 1); m <= ms[ms.length - 1]; m++) meses.push(m);
    if (mesDia === null || !meses.includes(mesDia)) mesDia = meses[meses.length - 1];
    const atual = mesDoDia(dataParaDia(new Date()));
    const cols = meses.map((m) => ({ id: m, rot: fmtMes(m), rotCurto: fmtMes(m).split('/')[0], rotLongo: fmtMes(m, true), total: (por.get(m) || {}).total || 0, por: (por.get(m) || { por: new Map() }).por, marcado: m === mesDia, parcial: m === atual }));
    const cartoes = ordenarCartoes(new Set(cols.flatMap((c) => [...c.por.keys()])));
    const tot = cols.reduce((s, c) => s + c.total, 0);
    el('dc-conta-mes').textContent = meses.length === 1 ? '1 mês' : meses.length + ' meses';
    el('dc-legenda').innerHTML = cartoes.map((k) => {
      const v = cols.reduce((s, c) => s + (c.por.get(k) || 0), 0), on = selCartao().has(rotCartao(k));
      return '<button type="button" class="dc-leg' + (apagado(k) ? ' apagado' : '') + '" data-cartao="' + esc(k) + '" aria-pressed="' + on + '"><i style="background:' + cor(k) + '"></i>' +
        esc(rotCartao(k)) + ' <b class="num">' + esc(fmt.pct(tot ? v / tot : 0)) + '</b></button>';
    }).join('');
    box.innerHTML = htmlColunas(cols, cartoes, meses.length <= 14);
    ligarColunas(box, cols, cartoes, (c) => {
      if (c.id === mesDia) return;
      mesDia = c.id;
      desenharMeses(); desenharDias();
      const b = el('dc-meses').querySelector('.dc-col.marcado'); if (b) b.focus();
    });
  }
  el('dc-legenda').addEventListener('click', (e) => { const b = e.target.closest('[data-cartao]'); if (b) filtros.alternar('cartao', rotCartao(b.dataset.cartao)); });

  function desenharDias() {
    const box = el('dc-dias');
    if (mesDia === null) { box.innerHTML = ''; el('dc-tit-dias').textContent = 'Dia a dia'; el('dc-conta-dia').textContent = ''; return; }
    const ini = inicioDoMes(mesDia), fim = inicioDoMes(mesDia + 1) - 1;
    const doMes = semCartao.filter((l) => l.dia >= ini && l.dia <= fim);
    const por = somar(doMes, (l) => l.dia);
    const hoje = dataParaDia(new Date());
    const nomeMesLongo = fmtMes(mesDia, true);
    const cols = [];
    for (let d = ini; d <= fim; d++) {
      const n = d - ini + 1, a = por.get(d);
      cols.push({ id: d, rot: String(n), rotLongo: n + ' de ' + nomeMesLongo, total: a ? a.total : 0, por: a ? a.por : new Map(), oculto: !(n === 1 || n % 5 === 0), parcial: d === hoje });
    }
    const cartoes = ordenarCartoes(new Set(cols.flatMap((c) => [...c.por.keys()])));
    el('dc-tit-dias').textContent = 'Dia a dia em ' + nomeMesLongo;
    const dias = cols.filter((c) => c.total).length;
    el('dc-conta-dia').textContent = dias === 1 ? '1 dia com abastecimento' : dias + ' dias com abastecimento';
    box.innerHTML = dias ? htmlColunas(cols, cartoes, 'curto') : '<div class="vazio">Nenhum abastecimento em postos externos neste mês.</div>';
    if (dias) ligarColunas(box, cols, cartoes, null);
  }

  // ---------- matriz: mês (com a média dos 6 meses anteriores) e os cartões do mês ----------
  let primeiraMatriz = true;
  function desenharMatriz() {
    const porMes = somar(filtradas, (l) => mesDoDia(l.dia));
    const meses = [...porMes.keys()].sort((a, b) => b - a);
    el('dc-conta-mat').textContent = meses.length === 1 ? '1 mês' : meses.length + ' meses';
    if (!meses.length) { el('dc-matriz').innerHTML = '<tbody><tr><td><div class="vazio">Nenhum abastecimento em postos externos neste recorte.</div></td></tr></tbody>'; return; }
    if (primeiraMatriz) { abertos.add(meses[0]); primeiraMatriz = false; }   // abre o mês mais recente na primeira vez
    const linhaVal = (litros, pct) => '<td class="n num">' + esc(L(litros)) + '</td><td class="n num">' + (pct === null ? '' : esc(fmt.pct(pct))) + '</td>';
    let html = '<thead><tr><th><span>Mês / cartão</span></th><th class="n"><span>Litros</span></th><th class="n"><span>% do mês</span></th></tr></thead><tbody>';
    let anoAnt = null;
    for (const m of meses) {
      const ano = Math.floor(m / 12), a = porMes.get(m), aberto = abertos.has(m);
      if (ano !== anoAnt) {
        const tAno = meses.filter((x) => Math.floor(x / 12) === ano).reduce((s, x) => s + porMes.get(x).total, 0);
        html += '<tr class="dc-ano"><th scope="rowgroup">' + ano + '</th><td class="n num">' + esc(L(tAno)) + '</td><td></td></tr>';
        anoAnt = ano;
      }
      html += '<tr class="dc-mes" data-mes="' + m + '" aria-expanded="' + aberto + '"><td><button type="button" class="link-botao nome-clicavel" data-mes="' + m + '">' +
        '<span class="dc-seta" aria-hidden="true">' + (aberto ? '▾' : '▸') + '</span> ' + esc(fmtMes(m, true)) + '</button></td>' + linhaVal(a.total, null) + '</tr>';
      if (aberto) {
        for (const k of ordenarCartoes(a.por.keys())) {
          const sel = selCartao().has(rotCartao(k));
          html += '<tr class="dc-cartao' + (sel ? ' selecionado' : '') + '" data-cartao="' + esc(k) + '"><td><button type="button" class="link-botao nome-clicavel" data-cartao="' + esc(k) + '" aria-pressed="' + sel + '">' +
            '<i class="dc-bola" style="background:' + cor(k) + '"></i>' + esc(rotCartao(k)) + '</button></td>' + linhaVal(a.por.get(k), a.total ? a.por.get(k) / a.total : 0) + '</tr>';
        }
      }
    }
    const tot = meses.reduce((s, m) => s + porMes.get(m).total, 0);
    html += '</tbody><tfoot><tr><th>Total</th><td class="n num">' + esc(L(tot)) + '</td><td></td></tr></tfoot>';
    el('dc-matriz').innerHTML = html;
  }
  el('dc-matriz').addEventListener('click', (e) => {
    const c = e.target.closest('tr[data-cartao]');
    if (c) { filtros.alternar('cartao', rotCartao(c.dataset.cartao)); return; }
    const m = e.target.closest('tr[data-mes]');
    if (!m) return;
    const mes = Number(m.dataset.mes);
    if (abertos.has(mes)) abertos.delete(mes); else abertos.add(mes);
    desenharMatriz();
    const b = el('dc-matriz').querySelector('button[data-mes="' + mes + '"]'); if (b) b.focus();
  });

  // ---------- fornecedores ----------
  const COL_FORN = [
    { id: 'nome', rot: 'Posto', v: (a) => a.nome, txt: (a) => esc(a.nome), trunc: true },
    { id: 'cidade', rot: 'Cidade', v: (a) => a.cidade || '', txt: (a) => esc(a.cidade || '—'), trunc: true },
    { id: 'litros', rot: 'Litros', n: true, v: (a) => a.litros, txt: (a) => esc(fmt.d2(a.litros)) },
    { id: 'pct', rot: '% do total', n: true, v: (a) => a.litros, txt: (a) => esc(fmt.pct(a.pctTotal)) },
    { id: 'cartao', rot: 'Cartão principal', v: (a) => rotCartao(a.principal), txt: (a) => '<span class="dc-cartao-forn"><i class="dc-bola" style="background:' + cor(a.principal) + '"></i>' + esc(rotCartao(a.principal)) + '</span>' },
  ];
  function desenharFornecedores() {
    const m = new Map();
    for (const l of filtradas) {
      const k = l.fornecedor || '(sem nome)';
      let a = m.get(k);
      if (!a) m.set(k, (a = { nome: k, cidade: l.cidade, litros: 0, por: new Map() }));
      a.litros += l.litros;
      const c = chaveCartao(l); a.por.set(c, (a.por.get(c) || 0) + l.litros);
    }
    const tot = filtradas.reduce((s, l) => s + l.litros, 0);
    let lista = [...m.values()].map((a) => ({ ...a, pctTotal: tot ? a.litros / tot : 0, principal: [...a.por.entries()].sort((x, y) => y[1] - x[1])[0][0] }));
    const t = buscaForn.trim().toLowerCase();
    if (t) lista = lista.filter((a) => a.nome.toLowerCase().includes(t) || (a.cidade || '').toLowerCase().includes(t));
    const c = COL_FORN.find((x) => x.id === ordemForn.campo);
    lista.sort((a, b) => { const va = c.v(a), vb = c.v(b); return ordemForn.dir * (typeof va === 'string' ? va.localeCompare(vb, 'pt-BR') : va - vb) || b.litros - a.litros; });
    const paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));
    paginaForn = Math.min(paginaForn, paginas - 1);
    const trecho = lista.slice(paginaForn * POR_PAGINA, (paginaForn + 1) * POR_PAGINA);
    const sel = filtros.sel.fornecedor;
    el('dc-conta-forn').textContent = lista.length === 1 ? '1 fornecedor' : fmt.int(lista.length) + ' fornecedores';
    el('dc-forn').innerHTML = '<thead><tr>' + COL_FORN.map((col) => {
      const ativa = ordemForn.campo === col.id;
      return '<th class="' + (col.n ? 'n' : '') + '" aria-sort="' + (ativa ? (ordemForn.dir < 0 ? 'descending' : 'ascending') : 'none') + '"><button type="button" data-col="' + col.id + '">' +
        esc(col.rot) + (ativa ? '<span class="seta">' + (ordemForn.dir < 0 ? '▼' : '▲') + '</span>' : '') + '</button></th>';
    }).join('') + '</tr></thead><tbody>' +
      (trecho.length ? trecho.map((a) => '<tr class="' + (sel.has(a.nome) ? 'selecionado' : '') + '" data-forn="' + esc(a.nome) + '">' + COL_FORN.map((col, j) =>
        '<td class="' + (col.n ? 'n num' : '') + (col.trunc ? ' trunc' : '') + '">' + (j === 0 ? '<button type="button" class="link-botao nome-clicavel" data-forn="' + esc(a.nome) + '" aria-pressed="' + sel.has(a.nome) + '">' + col.txt(a) + '</button>' : col.txt(a)) + '</td>').join('') + '</tr>').join('')
        : '<tr><td colspan="' + COL_FORN.length + '"><div class="vazio">Nenhum fornecedor com esse nome ou cidade.</div></td></tr>') + '</tbody>';
    el('dc-paginacao').innerHTML = lista.length > POR_PAGINA
      ? '<span>Página ' + (paginaForn + 1) + ' de ' + paginas + '</span>' +
        '<button type="button" data-pg="' + (paginaForn - 1) + '" ' + (paginaForn === 0 ? 'disabled' : '') + ' aria-label="Página anterior">‹</button>' +
        '<button type="button" data-pg="' + (paginaForn + 1) + '" ' + (paginaForn >= paginas - 1 ? 'disabled' : '') + ' aria-label="Próxima página">›</button>' : '';
  }
  el('dc-forn').addEventListener('click', (e) => {
    const h = e.target.closest('[data-col]');
    if (h) {
      const col = COL_FORN.find((x) => x.id === h.dataset.col);
      ordemForn = ordemForn.campo === col.id ? { campo: col.id, dir: -ordemForn.dir } : { campo: col.id, dir: col.n ? -1 : 1 };
      paginaForn = 0; desenharFornecedores(); ajustarAltura();
      const novo = el('dc-forn').querySelector('[data-col="' + col.id + '"]'); if (novo) novo.focus();
      return;
    }
    const r = e.target.closest('tr[data-forn]');
    if (r) filtros.alternar('fornecedor', r.dataset.forn);
  });
  el('dc-paginacao').addEventListener('click', (e) => { const b = e.target.closest('[data-pg]'); if (b && !b.disabled) { paginaForn = Number(b.dataset.pg); desenharFornecedores(); } });
  let tBusca = null;
  el('dc-busca').addEventListener('input', (e) => { clearTimeout(tBusca); tBusca = setTimeout(() => { buscaForn = e.target.value; paginaForn = 0; desenharFornecedores(); }, 150); });

  // ---------- altura da lista de fornecedores: lado a lado com a matriz, a mesma altura dela (a lista rola dentro);
  // um embaixo do outro (tela estreita), até 520 px ----------
  function ajustarAltura() {
    const matriz = el('dc-matriz'), lista = el('dc-forn');
    if (!matriz || !lista) return;   // a tela já saiu (erro "closest" de null, 27/11/2026)
    const mat = matriz.closest('section'), forn = lista.closest('section'), rol = lista.closest('.tabela-rolagem');
    if (!mat || !forn || !rol) return;
    rol.style.maxHeight = '';
    const ladoALado = Math.abs(mat.getBoundingClientRect().top - forn.getBoundingClientRect().top) < 2;
    const resto = forn.offsetHeight - rol.offsetHeight;   // cabeçalho, busca e paginação
    rol.style.maxHeight = (ladoALado ? Math.max(220, mat.offsetHeight - resto) : 520) + 'px';
  }
  let parado = false;   // a tela saiu: chamadas atrasadas não desenham mais (27/11/2026)
  const ro = new ResizeObserver(() => { if (!parado) ajustarAltura(); });
  ro.observe(el('dc-matriz').closest('section'));

  // ---------- ciclo ----------
  const atualizar = agendador(() => {
    filtradas = base.filter((l) => filtros.passa(l, null));
    semCartao = base.filter((l) => filtros.passa(l, 'cartao'));   // os gráficos mostram todos os cartões (o filtrado em destaque)
    paginaForn = 0;
    filtros.atualizarUI();
    desenharTopo();
    desenharTicket();
    desenharMeses();
    desenharDias();
    desenharMatriz();
    desenharFornecedores();
    ajustarAltura();
  });
  atualizar();

  const aoAtualizarDados = () => carregarDados().then((d) => { if (parado) return; usarDados(d); atualizar(); });
  window.addEventListener('dados-atualizados', aoAtualizarDados);
  // o gráfico do Ticket acompanha a largura da tela
  let tRedim = null;
  const aoRedimensionar = () => { if (parado) return; clearTimeout(tRedim); tRedim = setTimeout(desenharTicket, 150); };
  window.addEventListener('resize', aoRedimensionar);
  return { desmontar() { parado = true; clearTimeout(tRedim); clearTimeout(tBusca); window.removeEventListener('dados-atualizados', aoAtualizarDados); window.removeEventListener('resize', aoRedimensionar); ro.disconnect(); filtros.destruir(); } };
}
