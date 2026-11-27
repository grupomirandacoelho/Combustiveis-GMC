// Dashboard "Despesas" — mesmas regras da aba "Despesas" do Power BI:
//  - um grupo de combustível por vez (10/11/2026, pedido do usuário): Diesel (S-10, comum, S500… todos), Arla 32 ou
//    Gasolina/etanol; abre no Diesel. Misturar dava km/L e R$/km sem sentido (a linha de Arla traz o km desde o Arla
//    anterior). Veículos com categoria na aba Metas, exceto PICAPE e VENDA
//  - Despesas = soma de VALOR EMISSAO; R$ por km = despesas ÷ km; Média = km ÷ litros; Preço médio = despesas ÷ litros
import { carregarDados, fmt, esc, ehDiesel } from '../lib/dados.js';
import { criarFiltros, htmlBomba, htmlApoio, agendador, botoesMaisMenos } from '../lib/filtros.js';

const CATEGORIAS_FORA = new Set(['PICAPE', 'VENDA']);
const POR_VEICULO = 20;
const POR_PAGINA = 25;

const DIMENSOES = [
  { id: 'motorista', rotulo: 'Motorista', valor: (l) => l.motorista },
  { id: 'estabelecimento', rotulo: 'Estabelecimento', valor: (l) => l.tipoEstab },
  { id: 'combustivel', rotulo: 'Combustível', valor: (l) => l.combustivel },
  { id: 'periodo', rotulo: 'Período', periodo: true },
  { id: 'cc', rotulo: 'Centro de custo', valor: (l) => l.cc },
  { id: 'categoria', rotulo: 'Categoria', valor: (l) => l.categoria },
  { id: 'placa', rotulo: 'Placa', valor: (l) => l.placa },
];

const ehArla = (c) => /ARLA/i.test(String(c || ''));
const GRUPOS = [
  { id: 'diesel', rot: 'Diesel', tem: (c) => ehDiesel(c) && !ehArla(c) },
  { id: 'arla', rot: 'Arla 32', tem: ehArla },
  { id: 'gasolina', rot: 'Gasolina / etanol', tem: (c) => /GASOLINA|ETANOL|ALCOOL|ÁLCOOL/i.test(String(c || '')) },
];
const grupoDe = (id) => GRUPOS.find((g) => g.id === id) || GRUPOS[0];

function agrupar(linhas, chave) {
  const m = new Map();
  for (const l of linhas) {
    const k = chave(l);
    let a = m.get(k);
    if (!a) m.set(k, (a = { nome: k, despesa: 0, litros: 0, km: 0, qtd: 0, amostra: l }));
    a.despesa += l.despesa; a.litros += l.litros; a.km += l.km || 0; a.qtd++;
  }
  return [...m.values()];
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
  let grupo = grupoDe(new URLSearchParams(location.hash.split('?')[1] || '').get('comb'));
  function usarDados(d) {
    dados = d;
    // gasolina/etanol: carros sem categoria nas Metas ou PICAPE/VENDA (a regra de categoria deixaria o grupo sempre vazio)
    base = d.linhas.filter((l) => grupo.tem(l.combustivel) && (grupo.id === 'gasolina' || (l.categoria && !CATEGORIAS_FORA.has(l.categoria))));
    const g = new Date(d.geradoEm);
    ctx.definirSub('Dados atualizados em ' + g.toLocaleDateString('pt-BR') + ' às ' +
      g.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '. ' + grupo.rot + (grupo.id === 'diesel' ? ' (todos os tipos: S-10, comum, S500…)' : '') + '.');
  }
  usarDados(dados);

  let limiteVeiculos = POR_VEICULO;
  let ordemForn = { campo: 'despesa', dir: -1 };
  let buscaForn = '';
  let paginaForn = 0;
  let filtradas = base;

  pagina.innerHTML = `
    <div class="anp-controles">
      <div class="anp-grupo"><span class="filtro-rotulo">Combustível</span>
        <div class="segmentado" role="group" aria-label="Grupo de combustível" id="dp-grupo">${GRUPOS.map((g) => '<button type="button" data-grupo="' + g.id + '">' + g.rot + '</button>').join('')}</div></div>
    </div>
    <section class="filtros" id="dp-filtros" aria-label="Filtros"></section>
    <div class="chips" id="dp-chips" aria-live="polite"></div>
    <div class="abertura abertura-unica">
      <section class="bomba" aria-labelledby="dp-bomba-titulo">
        <h2 class="bomba-titulo" id="dp-bomba-titulo">Gasto no período</h2>
        <dl class="bomba-registros" id="dp-bomba"></dl>
      </section>
    </div>
    <dl class="apoio" id="dp-apoio"></dl>

    <div class="grade-paineis">
      <section class="painel">
        <div class="painel-cab"><h2>Gasto por veículo</h2><span class="conta" id="dp-conta-veic"></span></div>

        <div class="barras" id="dp-veiculos"></div>
      </section>
      <section class="painel conter">
        <div class="painel-cab"><h2>Gasto por centro de custo</h2><span class="conta" id="dp-conta-cc"></span></div>

        <div class="tabela-rolagem"><table class="dados tabela-clicavel" id="dp-cc"></table></div>
      </section>
    </div>

    <section class="painel painel-tabela">
      <div class="painel-cab"><h2>Gasto por fornecedor</h2><span class="conta" id="dp-conta-forn"></span></div>
      <div class="tabela-ferramentas">
        <input type="search" id="dp-busca" placeholder="Posto ou cidade…" aria-label="Procurar fornecedor" autocomplete="off">
      </div>
      <div class="tabela-rolagem"><table class="dados" id="dp-forn"></table></div>
      <div class="paginacao" id="dp-paginacao"></div>
    </section>`;
  const el = (id) => pagina.querySelector('#' + id);

  const filtros = criarFiltros({
    dimensoes: DIMENSOES, filtrosEl: el('dp-filtros'), chipsEl: el('dp-chips'), rota: '#/despesas',
    obterBase: () => base, obterLimites: () => [dados.diaMin, dados.diaMax], aoMudar: () => atualizar(), prefixo: 'dp', periodoPadrao: 'mes',
    extrasURL: () => ({ comb: grupo.id === 'diesel' ? '' : grupo.id }),
  });

  // ---------- topo ----------
  function desenharTopo() {
    let despesa = 0, litros = 0, km = 0;
    const placas = new Set(), postos = new Set();
    for (const l of filtradas) { despesa += l.despesa; litros += l.litros; km += l.km || 0; placas.add(l.placa); postos.add(l.fornecedor); }
    el('dp-bomba').innerHTML = htmlBomba({ despesa, litros, preco: litros ? despesa / litros : null });
    el('dp-apoio').innerHTML = htmlApoio([
      { rot: 'Km rodado', val: fmt.int(km) },
      { rot: 'Gasto por km', val: km ? 'R$ ' + fmt.d2(despesa / km) : '—' },
      { rot: grupo.id === 'arla' ? 'Km por litro de Arla' : 'Média', val: litros ? fmt.d2(km / litros) + ' km/L' : '—' },
      { rot: 'Veículos', val: fmt.int(placas.size) },
      { rot: 'Postos', val: fmt.int(postos.size) },
    ]);
  }

  // ---------- gasto por veículo: barras horizontais, uma cor só (a identidade é a placa, não a cor) ----------
  function desenharVeiculos() {
    const lista = agrupar(filtradas, (l) => l.placa).sort((a, b) => b.despesa - a.despesa);
    const total = lista.reduce((s, a) => s + a.despesa, 0);
    const max = lista.length ? lista[0].despesa : 0;
    const selecionadas = filtros.sel.placa;
    el('dp-conta-veic').textContent = fmt.int(lista.length) + (lista.length === 1 ? ' veículo' : ' veículos');
    el('dp-veiculos').innerHTML = (lista.length ? lista.slice(0, limiteVeiculos).map((a) => {
      const s = a.amostra;
      const cat = s.categoria ? s.categoria.charAt(0) + s.categoria.slice(1).toLowerCase() : null;
      const sub = [cat, s.modelo !== '(sem modelo)' ? 'modelo ' + s.modelo : null].filter(Boolean).join(', ');
      return '<button type="button" class="barra-linha' + (selecionadas.has(a.nome) ? ' selecionado' : '') + '" data-placa="' + esc(a.nome) + '" aria-pressed="' + selecionadas.has(a.nome) + '">' +
        '<span class="barra-nome">' + esc(a.nome) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>' +
        '<span class="barra-trilho" aria-hidden="true"><span class="barra-cheia" style="transform:scaleX(' + (max ? a.despesa / max : 0) + ')"></span></span>' +
        '<span class="barra-valor"><strong>' + esc(fmt.moeda(a.despesa)) + '</strong><small>' + esc(fmt.pct(total ? a.despesa / total : 0)) + ' do total</small></span>' +
      '</button>';
    }).join('') : '<p class="vazio">Nenhum abastecimento neste recorte. Tire um filtro para ver os veículos.</p>') +
      botoesMaisMenos(lista.length, limiteVeiculos, POR_VEICULO);
  }
  el('dp-veiculos').addEventListener('click', (e) => {
    if (e.target.closest('[data-menos]')) {
      limiteVeiculos = POR_VEICULO;
      desenharVeiculos();
      el('dp-veiculos').scrollIntoView({ block: 'nearest' });
      const b = el('dp-veiculos').querySelector('[data-mais]') || el('dp-veiculos').querySelector('.barra-linha');
      if (b) b.focus();
      return;
    }
    if (e.target.closest('[data-mais]')) {
      const foco = limiteVeiculos;
      limiteVeiculos += POR_VEICULO;
      desenharVeiculos();
      const linhas = el('dp-veiculos').querySelectorAll('.barra-linha');
      if (linhas[foco]) linhas[foco].focus();
      return;
    }
    const b = e.target.closest('[data-placa]');
    if (b) filtros.alternar('placa', b.dataset.placa);
  });

  // ---------- gasto por centro de custo ----------
  function desenharCC() {
    const lista = agrupar(filtradas, (l) => l.cc).sort((a, b) => b.despesa - a.despesa);
    const selecionados = filtros.sel.cc;
    el('dp-conta-cc').textContent = fmt.int(lista.length) + (lista.length === 1 ? ' centro de custo' : ' centros de custo');
    el('dp-cc').innerHTML =
      // colunas pedidas pelo usuário em 26/11/2026: centro de custo, despesa, volume, km rodado, preço médio e média
      '<thead><tr><th><span>Centro de custo</span></th><th class="n"><span>Despesa</span></th><th class="n col-opc1"><span>Volume (L)</span></th>' +
      '<th class="n col-opc2"><span>Km rodado</span></th><th class="n col-opc2"><span>Preço médio</span></th><th class="n"><span>Média (km/L)</span></th></tr></thead><tbody>' +
      (lista.length ? lista.map((a) =>
        '<tr class="' + (selecionados.has(a.nome) ? 'selecionado' : '') + '" data-cc="' + esc(a.nome) + '">' +
        '<td class="trunc"><button type="button" class="link-botao nome-clicavel" data-cc="' + esc(a.nome) + '" aria-pressed="' + selecionados.has(a.nome) + '">' + esc(a.nome) + '</button></td>' +
        '<td class="n">' + esc(fmt.moeda(a.despesa)) + '</td>' +
        '<td class="n col-opc1">' + esc(fmt.int(a.litros)) + '</td><td class="n col-opc2">' + esc(fmt.int(a.km)) + '</td>' +
        '<td class="n col-opc2">' + esc(a.litros ? fmt.moeda(a.despesa / a.litros) : '—') + '</td>' +
        '<td class="n">' + esc(a.litros && a.km ? fmt.d2(a.km / a.litros) : '—') + '</td></tr>').join('')
        : '<tr><td colspan="6"><div class="vazio">Nenhum centro de custo neste recorte.</div></td></tr>') + '</tbody>';
  }

  // a linha inteira responde ao clique; o botão do nome dá o foco e o Enter pelo teclado
  el('dp-cc').addEventListener('click', (e) => {
    const linha = e.target.closest('tr[data-cc]');
    if (!linha) return;
    const nome = linha.dataset.cc;
    filtros.alternar('cc', nome);
    queueMicrotask(() => {
      const b = [...el('dp-cc').querySelectorAll('button[data-cc]')].find((x) => x.dataset.cc === nome);
      if (b) b.focus();
    });
  });

  // ---------- gasto por fornecedor ----------
  const COL_FORN = [
    { id: 'nome', rot: 'Posto', v: (a) => a.nome, txt: (a) => a.nome, trunc: true },
    { id: 'cidade', rot: 'Cidade', v: (a) => a.amostra.cidade, txt: (a) => a.amostra.cidade, trunc: true },
    { id: 'tipo', rot: 'Estabelecimento', v: (a) => a.amostra.tipoEstab, txt: (a) => a.amostra.tipoEstab === 'ESTABELECIMENTO INTERNO' ? 'Interno' : a.amostra.tipoEstab === 'POSTO DE COMBUSTIVEL' ? 'Posto' : a.amostra.tipoEstab },
    { id: 'despesa', rot: 'Despesa', n: true, v: (a) => a.despesa, txt: (a) => fmt.moeda(a.despesa) },
    { id: 'litros', rot: 'Litros', n: true, v: (a) => a.litros, txt: (a) => fmt.d2(a.litros) },
    { id: 'preco', rot: 'Preço médio', n: true, v: (a) => (a.litros ? a.despesa / a.litros : null), txt: (a) => fmt.moeda(a.litros ? a.despesa / a.litros : null) },
    { id: 'qtd', rot: 'Abastecimentos', n: true, v: (a) => a.qtd, txt: (a) => fmt.int(a.qtd) },
  ];
  function desenharFornecedores() {
    const t = buscaForn.trim().toLowerCase();
    let lista = agrupar(filtradas, (l) => l.fornecedor || '(sem nome)');
    if (t) lista = lista.filter((a) => a.nome.toLowerCase().includes(t) || (a.amostra.cidade || '').toLowerCase().includes(t));
    const c = COL_FORN.find((x) => x.id === ordemForn.campo);
    lista.sort((a, b) => {
      const va = c.v(a), vb = c.v(b);
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      return ordemForn.dir * (typeof va === 'string' ? va.localeCompare(vb, 'pt-BR') : va - vb) || b.despesa - a.despesa;
    });
    const paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));
    paginaForn = Math.min(paginaForn, paginas - 1);
    const trecho = lista.slice(paginaForn * POR_PAGINA, (paginaForn + 1) * POR_PAGINA);
    el('dp-conta-forn').textContent = fmt.int(lista.length) + (lista.length === 1 ? ' fornecedor' : ' fornecedores');
    el('dp-forn').innerHTML =
      '<thead><tr>' + COL_FORN.map((col) => {
        const ativa = ordemForn.campo === col.id;
        return '<th class="' + (col.n ? 'n' : '') + '" aria-sort="' + (ativa ? (ordemForn.dir < 0 ? 'descending' : 'ascending') : 'none') + '">' +
          '<button type="button" data-col="' + col.id + '">' + esc(col.rot) + (ativa ? '<span class="seta">' + (ordemForn.dir < 0 ? '▼' : '▲') + '</span>' : '') + '</button></th>';
      }).join('') + '</tr></thead><tbody>' +
      (trecho.length ? trecho.map((a) => '<tr>' + COL_FORN.map((col) =>
        '<td class="' + (col.n ? 'n' : '') + (col.trunc ? ' trunc' : '') + '">' + esc(col.txt(a)) + '</td>').join('') + '</tr>').join('')
        : '<tr><td colspan="' + COL_FORN.length + '"><div class="vazio">Nenhum fornecedor com esse nome ou cidade.</div></td></tr>') + '</tbody>';
    el('dp-paginacao').innerHTML = lista.length > POR_PAGINA
      ? '<span>Página ' + (paginaForn + 1) + ' de ' + paginas + '</span>' +
        '<button type="button" data-pg="' + (paginaForn - 1) + '" ' + (paginaForn === 0 ? 'disabled' : '') + ' aria-label="Página anterior">‹</button>' +
        '<button type="button" data-pg="' + (paginaForn + 1) + '" ' + (paginaForn >= paginas - 1 ? 'disabled' : '') + ' aria-label="Próxima página">›</button>'
      : '';
  }
  el('dp-forn').addEventListener('click', (e) => {
    const b = e.target.closest('[data-col]');
    if (!b) return;
    const col = COL_FORN.find((x) => x.id === b.dataset.col);
    ordemForn = ordemForn.campo === col.id ? { campo: col.id, dir: -ordemForn.dir } : { campo: col.id, dir: col.n ? -1 : 1 };
    paginaForn = 0;
    desenharFornecedores();
    const novo = el('dp-forn').querySelector('[data-col="' + col.id + '"]');
    if (novo) novo.focus();
  });
  el('dp-paginacao').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pg]');
    if (!b || b.disabled) return;
    paginaForn = Number(b.dataset.pg);
    desenharFornecedores();
  });
  let tBusca = null;
  el('dp-busca').addEventListener('input', (e) => {
    clearTimeout(tBusca);
    tBusca = setTimeout(() => { buscaForn = e.target.value; paginaForn = 0; desenharFornecedores(); }, 150);
  });

  // ---------- ciclo ----------
  // troca do grupo de combustível: a base muda, a escolha de tipos de combustível de outro grupo sai e o endereço guarda
  const marcarGrupo = () => el('dp-grupo').querySelectorAll('[data-grupo]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.grupo === grupo.id)));
  marcarGrupo();
  el('dp-grupo').addEventListener('click', (e) => {
    const b = e.target.closest('[data-grupo]');
    if (!b || b.dataset.grupo === grupo.id) return;
    grupo = grupoDe(b.dataset.grupo);
    filtros.sel.combustivel.clear();
    usarDados(dados);
    marcarGrupo();
    filtros.definirPeriodo(filtros.periodo.de, filtros.periodo.ate, filtros.periodo.preset);   // grava o endereço e redesenha
  });

  const atualizar = agendador(() => {
    filtradas = base.filter((l) => filtros.passa(l, null));
    paginaForn = 0;
    filtros.atualizarUI();
    desenharTopo();
    desenharVeiculos();
    desenharCC();
    desenharFornecedores();
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
