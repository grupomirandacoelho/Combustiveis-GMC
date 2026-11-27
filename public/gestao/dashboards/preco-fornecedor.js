// Operacional > "Preço bomba interna" — preços negociados com os fornecedores das bombas internas
// (planilha CONTROLES\Negociação bomba interna.xlsx: DATA, FORNECEDOR, PRODUTO, PRECO, UNIDADE; aba Fornecedores).
// O gráfico do Power BI misturava todos os fornecedores, unidades e produtos em linhas coloridas (mais de 6 séries
// viram ruído). Aqui: um produto e uma unidade por vez; o preço mais recente vira um totem ordenado; na evolução,
// todos ficam em cinza e só até 3 fornecedores ganham cor, traço diferente e nome escrito na ponta.
// Lançamentos pelo site (/api/bomba-interna): negociações do dia (Arla vem com o último preço, diesel em branco) e
// fornecedores novos; o vigia grava na planilha (scripts/planilha_bomba.py) e repete o Arla todo dia. Enquanto a Base
// nova não chega, o que foi lançado aparece aqui marcado como "aguardando gravação".
// Fornecedores cadastrados: aba Fornecedores, com o CNPJ de cada unidade (liga às notas das Movimentações e do Rateio das
// NFs); quem edita muda o CNPJ e se o fornecedor está ativo.
import { carregarDados, fmt, esc, fmtDia, isoParaDia, diaIso, dataParaDia } from '../lib/dados.js';
import { criarFiltros, agendador } from '../lib/filtros.js';
import { carregarOpcoes, listaEfetiva, temConfig, BOTAO_OPCOES, abrirOpcoes } from '../lib/opcoes.js';

const DESTAQUES = [   // cor + traço: nunca só a cor
  { cor: 'var(--cat-1)', traco: '' },
  { cor: 'var(--cat-2)', traco: '7 4' },
  { cor: 'var(--cat-3)', traco: '2 3' },
];
const RECENTE = 7;           // dias: cotação mais velha que isso sai do totem e vai para "pararam de cotar"
const NOVO = 30;             // dias: fornecedor que começou a cotar há menos que isso ganha a etiqueta "novo"
const UNIDADES_FORA = new Set(['GV']);   // Governador Valadares: tanque descontinuado
const DIAS_TABELA = 12;

// a planilha traz o preço com até 4 casas: todos com 4, para os números ficarem alinhados e comparáveis
// padrão do portal (3 casas); a 4ª só aparece quando a cotação tem (6,500 · 6,6448). A planilha baixada continua com 4.
const f3 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 4 });
const f4x = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const preco = (v) => (v === null || v === undefined ? '—' : f3.format(v));
const nomeProduto = (p) => (p === 'ARLA' ? 'Arla 32' : p.charAt(0) + p.slice(1).toLowerCase());
const NOMES_UNIDADE = { SP: 'São Paulo', GV: 'Governador Valadares', BELEM: 'Belém', JEQUIE: 'Jequié', SALVADOR: 'Salvador' };
const nomeUnidade = (u) => NOMES_UNIDADE[u] || u.charAt(0) + u.slice(1).toLowerCase();
// praças do "Lançar negociação" e do "Adicionar fornecedor": as com negociação + as com fornecedor cadastrado + a escolhida na tela,
// sem as descontinuadas (UNIDADES_FORA). São os códigos da planilha (SP, JEQUIE...), não o cadastro de unidades do portal.
export function pracasDoLancamento(comNegociacao, cadastroForn, atual) {
  const comFornecedor = cadastroForn.map((x) => x.u).filter((u) => !UNIDADES_FORA.has(u));
  return [...new Set([...comNegociacao, ...comFornecedor, atual].filter(Boolean))].sort((a, b) => nomeUnidade(a).localeCompare(nomeUnidade(b), 'pt-BR'));
}
const soNumeros = (v) => String(v ?? '').replace(/\D/g, '');
const fmtCnpj = (c) => (c && /^\d{14}$/.test(c) ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : c || '');

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando os preços…</div>';
  let dados, infoBomba;
  const buscarBomba = () => fetch('/api/bomba-interna', { credentials: 'same-origin', cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : { podeEditar: false, alteracoes: [] })).catch(() => ({ podeEditar: false, alteracoes: [] }));
  try { [dados, infoBomba] = await Promise.all([carregarDados(), buscarBomba()]); } catch (e) {
    pagina.innerHTML = '<div class="vazio">' + esc(e.message) + ' Recarregue a página para tentar de novo.</div>';
    return {};
  }
  if (!dados.negociacao.length) {
    pagina.innerHTML = '<div class="vazio">As negociações da bomba interna ainda não chegaram ao site. Tente de novo em alguns minutos.</div>';
    return {};
  }
  const podeEditar = infoBomba.podeEditar;

  // lançamento do site que a Base publicada ainda não traz: pendente, aguardando ou gravado depois da última carga
  const naoNaBase = (a) => a.estado === 'pendente' || a.estado === 'aguardando' ||
    (a.estado === 'aplicada' && a.aplicada_em && new Date(a.aplicada_em) > new Date(dados.geradoEm));
  let base = [];
  let produtos = [], unidades = [];
  function usarDados(d) {
    dados = d;
    // cotação zerada é lançamento vazio; unidades com tanque descontinuado ficam de fora
    const lidas = d.negociacao.filter((l) => l.preco > 0 && !UNIDADES_FORA.has(l.unidade));
    const k = (l) => l.dia + '|' + l.fornecedor + '|' + l.produto + '|' + l.unidade;
    const porChave = new Map(lidas.map((l) => [k(l), l]));
    for (const a of [...infoBomba.alteracoes].sort((x, y) => x.id - y.id)) {
      if (a.tipo !== 'negociacao' || !naoNaBase(a) || UNIDADES_FORA.has(a.dados.unidade)) continue;
      const l = { dia: isoParaDia(a.dados.data), fornecedor: a.dados.fornecedor, produto: a.dados.produto, unidade: a.dados.unidade,
        preco: a.dados.preco, pendente: a.estado };
      if (a.dados.excluir) { porChave.delete(k(l)); continue; }   // preço excluído pelo site: some antes de a Base nova chegar
      porChave.set(k(l), l);   // o lançado no site vale por cima do que está na Base (mesmo dia, fornecedor e unidade)
    }
    base = [...porChave.values()];
    produtos = [...new Set(base.map((l) => l.produto))].sort();
    unidades = [...new Set(base.map((l) => l.unidade))].sort((a, b) => nomeUnidade(a).localeCompare(nomeUnidade(b), 'pt-BR'));
    const ult = Math.max(...base.map((l) => l.dia));
    ctx.definirSub('Preços negociados para as bombas internas. Última cotação em ' + fmtDia(ult) + '.');
  }
  usarDados(dados);

  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  let produto = produtos.includes(q.get('produto')) ? q.get('produto') : (produtos.includes('DIESEL') ? 'DIESEL' : produtos[0]);
  let unidade = unidades.includes(q.get('unidade')) ? q.get('unidade') : unidades[0];
  let destacados = (q.get('destaque') || '').split('|').filter(Boolean).slice(0, 3);
  let destaqueManual = destacados.length > 0;

  pagina.innerHTML = `
    <div class="grupo-filtros">
    <div class="pf-acoes">
      ${podeEditar ? '<button type="button" class="btn btn-principal" id="pf-lancar"><svg aria-hidden="true"><use href="#i-mais"/></svg><span class="txt">Lançar negociação</span></button>' : ''}
      <button type="button" class="btn" id="pf-abrir-lista"><svg aria-hidden="true"><use href="#i-usuarios"/></svg><span class="txt">Fornecedores</span></button>
      ${podeEditar ? '<span class="nota" id="pf-pendentes"></span>' : ''}
    </div>
    <div class="escolhas">
      <div class="escolha"><span class="filtro-rotulo" id="pf-rot-prod">Produto</span>
        <div class="segmentado" role="group" aria-labelledby="pf-rot-prod" id="pf-produto"></div></div>
      <div class="escolha escolha-larga"><span class="filtro-rotulo" id="pf-rot-uni">Unidade</span>
        <div class="segmentado segmentado-quebra" role="group" aria-labelledby="pf-rot-uni" id="pf-unidade"></div></div>
    </div>
    <section class="filtros" id="pf-filtros" aria-label="Período"></section>
    </div>
    <div class="chips" id="pf-chips" aria-live="polite"></div>

    <div class="abertura">
      <section class="totem" aria-labelledby="pf-totem-titulo">
        <h2 class="bomba-titulo" id="pf-totem-titulo"></h2>
        <ol class="totem-lista" id="pf-totem"></ol>
        <div class="totem-parados" id="pf-parados"></div>
      </section>
      <section class="meta-bloco" aria-labelledby="pf-resumo-titulo">
        <h2 id="pf-resumo-titulo">Resumo da cotação</h2>
        <dl class="resumo-preco" id="pf-resumo"></dl>
      </section>
    </div>

    <section class="painel painel-largo">
      <div class="painel-cab">
        <h2>Evolução do preço</h2>
        <div class="legenda" id="pf-legenda"></div>
      </div>

      <div class="grafico" id="pf-grafico"></div>
    </section>

    <section class="painel painel-tabela">
      <div class="painel-cab"><h2>Últimas cotações</h2><span class="conta">o menor preço de cada dia vem marcado</span></div>
      <div class="tabela-rolagem"><table class="dados" id="pf-tabela"></table></div>
    </section>

    <dialog class="dialogo dialogo-largo" id="pf-dlg-lista" aria-labelledby="pf-lista-titulo">
      <div class="painel-cab"><div><h2 id="pf-lista-titulo">Fornecedores</h2><span class="conta" id="pf-cad-conta"></span></div>
        <div class="acoes-cab">
          ${podeEditar ? '<button type="button" class="btn btn-principal" id="pf-novo-forn"><svg aria-hidden="true"><use href="#i-mais"/></svg><span class="txt">Adicionar fornecedor</span></button>' : ''}
          <button type="button" class="btn btn-icone" id="pf-fechar-lista" aria-label="Fechar"><svg aria-hidden="true"><use href="#i-x"/></svg></button>
        </div></div>
      <div class="tabela-rolagem tabela-alta"><table class="dados" id="pf-cadastro"></table></div>
    </dialog>
    <dialog class="dialogo" id="pf-dlg-neg" aria-labelledby="pf-dlg-neg-titulo">
      <form method="dialog" id="pf-form-neg" novalidate>
        <h2 id="pf-dlg-neg-titulo">Lançar negociação</h2>
        <p class="dialogo-explica">Preço por litro de cada fornecedor no dia. Só os preenchidos são gravados nas negociações.
          No Arla o preço já vem com o último (ele se repete todo dia até mudar); no diesel, preencha o do dia.</p>
        <p class="erro-form oculto" id="pf-erro-neg" role="alert"></p>
        <div class="grade-form">
          <label class="campo-form"><span>Data</span><input type="date" name="data" required></label>
          <label class="campo-form"><span>Produto</span><select name="produto"><option value="DIESEL">Diesel</option><option value="ARLA">Arla 32</option></select></label>
          <label class="campo-form largo"><span>Unidade</span><select name="unidade"></select></label>
        </div>
        <div class="tabela-rolagem"><table class="dados pf-tabela-lanc" id="pf-lanc"></table></div>
        <div class="dialogo-acoes">
          <button type="button" class="btn" id="pf-cancelar-neg">Cancelar</button>
          <button type="submit" class="btn btn-principal" id="pf-salvar-neg">Salvar negociação</button>
        </div>
      </form>
    </dialog>
    <dialog class="dialogo" id="pf-dlg-forn" aria-labelledby="pf-dlg-forn-titulo">
      <form method="dialog" id="pf-form-forn" novalidate>
        ${BOTAO_OPCOES}
        <h2 id="pf-dlg-forn-titulo">Novo fornecedor</h2>
        <p class="dialogo-explica">Entra na lista de fornecedores e passa a aparecer no lançamento do produto e das unidades marcadas.</p>
        <p class="erro-form oculto" id="pf-erro-forn" role="alert"></p>
        <div class="grade-form">
          <label class="campo-form largo"><span>Fornecedor</span><input name="fornecedor" maxlength="60" autocomplete="off" placeholder="Nome como aparece na negociação"></label>
          <label class="campo-form"><span>Produto</span><select name="produto"><option value="DIESEL">Diesel</option><option value="ARLA">Arla 32</option></select></label>
        </div>
        <fieldset class="pf-unidades"><legend>Unidades atendidas e CNPJ de cada uma</legend><div id="pf-forn-unidades"></div></fieldset>
        <label class="pf-ativo"><input type="checkbox" name="ativo" checked> Ativo (aparece no lançamento das negociações)</label>
        <div class="dialogo-acoes">
          <button type="button" class="btn" id="pf-cancelar-forn">Cancelar</button>
          <button type="submit" class="btn btn-principal" id="pf-salvar-forn">Salvar fornecedor</button>
        </div>
      </form>
    </dialog>`;
  const el = (id) => pagina.querySelector('#' + id);
  // unidades (praças) do lançamento e do cadastro de fornecedor: a lista configurada na engrenagem ou as que já têm preço
  let opc = { opcoes: {}, podeEditar: false };
  carregarOpcoes('preco-fornecedor').then((o) => { opc = o; });
  const unidadesForm = () => listaEfetiva(opc, 'unidade', unidades);
  el('pf-form-forn').addEventListener('click', (e) => {
    if (!e.target.closest('[data-opcoes]')) return;
    abrirOpcoes({ tela: 'preco-fornecedor', titulo: 'Opções do cadastro de fornecedores', podeEditar: opc.podeEditar,
      campos: [{ id: 'unidade', rotulo: 'Unidades (praças)', valores: unidadesForm(), configurado: temConfig(opc, 'unidade'),
        explica: 'Use o nome da praça como nas negociações (ex.: JEQUIE, SP, BELEM).' },
        { id: 'produto', rotulo: 'Produtos', valores: ['Diesel', 'Arla 32'], fixo: true }],
      aoSalvar: (novos) => { opc = { ...opc, opcoes: { ...opc.opcoes, ...novos } }; } });
  });

  const filtros = criarFiltros({
    dimensoes: [{ id: 'periodo', rotulo: 'Período', periodo: true }],
    filtrosEl: el('pf-filtros'), chipsEl: el('pf-chips'), rota: '#/preco-fornecedor',
    obterBase: () => base,
    obterLimites: () => [Math.min(...base.map((l) => l.dia)), Math.max(...base.map((l) => l.dia))],
    aoMudar: () => atualizar(), prefixo: 'pf',
    extrasURL: () => ({ produto, unidade, destaque: destaqueManual ? destacados.join('|') : '' }),
  });

  function desenharEscolhas() {
    el('pf-produto').innerHTML = produtos.map((p) =>
      '<button type="button" data-produto="' + esc(p) + '" aria-pressed="' + (p === produto) + '">' + esc(nomeProduto(p)) + '</button>').join('');
    el('pf-unidade').innerHTML = unidades.map((u) =>
      '<button type="button" data-unidade="' + esc(u) + '" aria-pressed="' + (u === unidade) + '">' + esc(nomeUnidade(u)) + '</button>').join('');
  }
  el('pf-produto').addEventListener('click', (e) => {
    const b = e.target.closest('[data-produto]'); if (!b) return;
    produto = b.dataset.produto; destaqueManual = false; desenharEscolhas(); atualizar();
  });
  el('pf-unidade').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unidade]'); if (!b) return;
    unidade = b.dataset.unidade; destaqueManual = false; desenharEscolhas(); atualizar();
  });

  // ---------- cálculo ----------
  let series = new Map();   // fornecedor -> [{dia, preco}] em ordem
  let cotacaoAtual = [];    // [{nome, preco, dia}] mais recente de cada fornecedor, ordenado
  let ultimoDia = null;
  let primeiraCotacao = new Map();
  const ehNovo = (nome) => ultimoDia !== null && primeiraCotacao.has(nome) && ultimoDia - primeiraCotacao.get(nome) <= NOVO;

  function calcular() {
    const linhas = base.filter((l) => l.produto === produto && l.unidade === unidade && filtros.passa(l, null));
    series = new Map();
    for (const l of linhas) {
      let s = series.get(l.fornecedor);
      if (!s) series.set(l.fornecedor, (s = new Map()));
      s.set(l.dia, l);   // se houver duas cotações no mesmo dia, fica a última da planilha
    }
    series.forEach((m, k) => series.set(k, [...m.entries()].map(([dia, l]) => ({ dia, preco: l.preco, pendente: l.pendente })).sort((a, b) => a.dia - b.dia)));
    ultimoDia = linhas.length ? Math.max(...linhas.map((l) => l.dia)) : null;
    // primeira cotação de cada fornecedor neste produto e unidade, em todo o histórico (para marcar "novo")
    primeiraCotacao = new Map();
    for (const l of base) {
      if (l.produto !== produto || l.unidade !== unidade) continue;
      const p = primeiraCotacao.get(l.fornecedor);
      if (p === undefined || l.dia < p) primeiraCotacao.set(l.fornecedor, l.dia);
    }
    cotacaoAtual = [...series.entries()].map(([nome, s]) => ({ nome, ...s[s.length - 1] }))
      .sort((a, b) => a.preco - b.preco || a.nome.localeCompare(b.nome, 'pt-BR'));
    if (!destaqueManual) {
      destacados = cotacaoAtual.filter((c) => ultimoDia - c.dia <= RECENTE).slice(0, 3).map((c) => c.nome);
    } else {
      destacados = destacados.filter((n) => series.has(n));
    }
  }

  // ---------- totem ----------
  function desenharTotem() {
    const recentes = cotacaoAtual.filter((c) => ultimoDia - c.dia <= RECENTE);
    const antigas = cotacaoAtual.filter((c) => ultimoDia - c.dia > RECENTE);
    el('pf-totem-titulo').textContent = nomeProduto(produto) + ' em ' + nomeUnidade(unidade) +
      (ultimoDia !== null ? ', cotação de ' + fmtDia(ultimoDia) : '');
    if (!recentes.length) {
      el('pf-totem').innerHTML = '<li class="totem-vazio">Nenhuma cotação neste período. Escolha outro período ou outra unidade.</li>';
      el('pf-parados').innerHTML = '';
      return;
    }
    const menor = recentes[0].preco;
    el('pf-totem').innerHTML = recentes.map((c, i) => {
      const idx = destacados.indexOf(c.nome);
      const dif = c.preco - menor;
      return '<li><button type="button" class="totem-linha' + (idx >= 0 ? ' destacado' : '') + '" data-forn="' + esc(c.nome) + '" aria-pressed="' + (idx >= 0) + '"' +
          (idx >= 0 ? ' style="--marca:' + DESTAQUES[idx].cor + '"' : '') + '>' +
        '<span class="totem-pos">' + (i + 1) + '</span>' +
        '<span class="totem-nome">' + esc(c.nome) +
          (ehNovo(c.nome) ? ' <span class="etiqueta-novo">novo</span>' : '') +
          (c.dia !== ultimoDia ? '<small>cotado em ' + esc(fmtDia(c.dia)) + '</small>' : '') + '</span>' +
        '<span class="totem-dif">' + (i === 0 ? 'mais barato' : '+ ' + esc(preco(dif)) + ' <small>(' + esc(fmt.pct(dif / menor)) + ')</small>') + '</span>' +
        '<span class="totem-preco"><small>R$</small>' + esc(preco(c.preco)) + '</span>' +
      '</button></li>';
    }).join('');
    // quem parou de cotar sai do totem e fica listado com a última cotação
    el('pf-parados').innerHTML = antigas.length
      ? '<p class="totem-parados-titulo">Pararam de cotar (nada nos últimos ' + RECENTE + ' dias)</p><ul>' +
        antigas.sort((a, b) => b.dia - a.dia).map((c) =>
          '<li><span>' + esc(c.nome) + '</span><span>última em ' + esc(fmtDia(c.dia)) + ', R$ ' + esc(preco(c.preco)) + '</span></li>').join('') + '</ul>'
      : '';
  }
  el('pf-totem').addEventListener('click', (e) => {
    const b = e.target.closest('[data-forn]'); if (!b) return;
    const n = b.dataset.forn;
    const i = destacados.indexOf(n);
    if (i >= 0) destacados.splice(i, 1);
    else { if (destacados.length >= 3) destacados.shift(); destacados.push(n); }
    destaqueManual = true;
    desenharTotem(); desenharGrafico(); desenharLegenda(); filtros.atualizarUI();
    const novo = el('pf-totem').querySelector('[data-forn="' + CSS.escape(n) + '"]');
    if (novo) novo.focus();
  });

  // ---------- resumo ----------
  function desenharResumo() {
    const recentes = cotacaoAtual.filter((c) => ultimoDia - c.dia <= RECENTE);
    if (!recentes.length) { el('pf-resumo').innerHTML = ''; return; }
    const menor = recentes[0], maior = recentes[recentes.length - 1];
    // menor preço do dia, 30 dias antes da última cotação
    const menorDoDia = (dia) => {
      let m = null;
      series.forEach((s) => { const p = s.find((x) => x.dia === dia); if (p && (m === null || p.preco < m)) m = p.preco; });
      return m;
    };
    const dias = [...new Set([...series.values()].flat().map((x) => x.dia))].sort((a, b) => a - b);
    const alvo = ultimoDia - 30;
    const diaAntes = dias.filter((d) => d <= alvo).pop();
    const antes = diaAntes !== undefined ? menorDoDia(diaAntes) : null;
    const agora = menorDoDia(ultimoDia);
    const variacao = antes && agora ? agora - antes : null;
    el('pf-resumo').innerHTML =
      '<div><dt>Mais barato</dt><dd>' + esc(menor.nome) + '<span class="num">R$ ' + esc(preco(menor.preco)) + '</span></dd></div>' +
      '<div><dt>Diferença entre o mais barato e o mais caro</dt><dd><span class="num">R$ ' + esc(preco(maior.preco - menor.preco)) + '</span>' +
        '<small>' + esc(fmt.pct((maior.preco - menor.preco) / menor.preco)) + ' a mais no ' + esc(maior.nome) + '</small></dd></div>' +
      '<div><dt>Menor preço contra 30 dias atrás</dt><dd>' + (variacao === null ? '<span class="num">—</span><small>sem cotação há 30 dias</small>'
        : '<span class="num">' + (variacao > 0 ? '+' : variacao < 0 ? '−' : '') + 'R$ ' + esc(preco(Math.abs(variacao))) + '</span>' +
          '<small>' + (variacao > 0 ? 'subiu' : variacao < 0 ? 'caiu' : 'igual') + ' desde ' + esc(fmtDia(diaAntes)) + '</small>') + '</dd></div>' +
      '<div><dt>Fornecedores cotados</dt><dd><span class="num">' + fmt.int(recentes.length) + '</span><small>nos últimos ' + RECENTE + ' dias</small></dd></div>';
  }

  // ---------- gráfico: contexto em cinza + até 3 destaques ----------
  function desenharLegenda() {
    el('pf-legenda').innerHTML = destacados.map((n, i) =>
      '<span><svg width="22" height="6" aria-hidden="true"><line x1="1" y1="3" x2="21" y2="3" stroke="' + DESTAQUES[i].cor + '" stroke-width="2.5" stroke-dasharray="' + DESTAQUES[i].traco + '" stroke-linecap="round"/></svg>' + esc(n) + '</span>').join('') +
      '<span><i class="leg-contexto"></i>Demais fornecedores</span>';
  }

  function ticks(min, max, alvo) {
    const bruto = (max - min) / alvo || 0.01;
    const pot = Math.pow(10, Math.floor(Math.log10(bruto)));
    const passo = [1, 2, 2.5, 5, 10].map((m) => m * pot).find((p) => p >= bruto) || pot * 10;
    const r = [];
    for (let v = Math.floor(min / passo) * passo; v <= Math.ceil(max / passo) * passo + passo / 2; v += passo) r.push(+v.toFixed(6));
    return r;
  }

  function desenharGrafico() {
    const box = el('pf-grafico');
    const todos = [...series.values()].flat();
    const dias = [...new Set(todos.map((x) => x.dia))].sort((a, b) => a - b);
    if (dias.length < 2) {
      box.removeAttribute('tabindex');
      box.innerHTML = '<p class="vazio">São precisos pelo menos dois dias de cotação para mostrar a evolução.</p>';
      return;
    }
    const W = Math.max(320, box.clientWidth), H = 250;   // era 300 (densidade, 18/11/2026)
    const m = { l: 48, r: 120, t: 12, b: 28 };
    const d0 = dias[0], d1 = dias[dias.length - 1];
    let lo = Math.min(...todos.map((x) => x.preco)), hi = Math.max(...todos.map((x) => x.preco));
    const tk = ticks(lo - (hi - lo) * 0.06, hi + (hi - lo) * 0.06, 5);
    lo = tk[0]; hi = tk[tk.length - 1];
    const x = (d) => m.l + ((d - d0) / (d1 - d0)) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const caminho = (s) => s.map((p, i) => (i ? 'L' : 'M') + x(p.dia).toFixed(1) + ' ' + y(p.preco).toFixed(1)).join(' ');
    // eixo x: início de cada mês
    const marcas = [];
    const f = new Intl.DateTimeFormat('pt-BR', { month: 'short', timeZone: 'UTC' });
    for (let d = d0; d <= d1; d++) { const dt = new Date(d * 864e5); if (dt.getUTCDate() === 1) marcas.push(d); }
    if (!marcas.length || x(marcas[0]) - x(d0) > 44) marcas.unshift(d0);   // o início só ganha rótulo se não encostar no primeiro mês
    const contexto = [...series.entries()].filter(([n]) => !destacados.includes(n));
    const dest = destacados.map((n, i) => ({ nome: n, s: series.get(n), ...DESTAQUES[i] })).filter((d) => d.s);
    // rótulos na ponta sem sobrepor
    const pontas = dest.map((d) => ({ ...d, yy: y(d.s[d.s.length - 1].preco) })).sort((a, b) => a.yy - b.yy);
    for (let i = 1; i < pontas.length; i++) if (pontas[i].yy - pontas[i - 1].yy < 15) pontas[i].yy = pontas[i - 1].yy + 15;

    box.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="Evolução do preço de ' + esc(nomeProduto(produto)) + ' por fornecedor em ' + esc(nomeUnidade(unidade)) + '">' +
        tk.map((v) => '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--grade)"/>' +
          '<text class="eixo-txt" x="' + (m.l - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + fmt.d2(v) + '</text>').join('') +
        marcas.map((d) => '<text class="eixo-txt" x="' + x(d) + '" y="' + (H - 8) + '" text-anchor="middle">' + f.format(new Date(d * 864e5)).replace('.', '') + '</text>').join('') +
        contexto.map(([, s]) => '<path d="' + caminho(s) + '" fill="none" stroke="var(--eixo)" stroke-width="1.25" stroke-linejoin="round"/>').join('') +
        dest.map((d) => '<path d="' + caminho(d.s) + '" fill="none" stroke="' + d.cor + '" stroke-width="2.5" stroke-dasharray="' + d.traco + '" stroke-linejoin="round" stroke-linecap="round"/>').join('') +
        pontas.map((d) => {
          const u = d.s[d.s.length - 1];
          return '<circle cx="' + x(u.dia) + '" cy="' + y(u.preco) + '" r="4" fill="' + d.cor + '" stroke="var(--superficie)" stroke-width="2"/>' +
            '<text class="rot-serie" x="' + (x(u.dia) + 10) + '" y="' + (d.yy + 4) + '" fill="var(--tinta)">' + esc(d.nome.length > 14 ? d.nome.slice(0, 13) + '…' : d.nome) + ' ' + preco(u.preco) + '</text>';
        }).join('') +
        '<g class="cursor" style="display:none"><line y1="' + m.t + '" y2="' + (H - m.b) + '" stroke="var(--tinta-3)" stroke-width="1"/></g>' +
        '<rect x="' + m.l + '" y="0" width="' + (W - m.l - m.r) + '" height="' + H + '" fill="transparent" class="alvo"/>' +
      '</svg><div class="dica oculto"></div>';

    const svg = box.querySelector('svg'), cursor = svg.querySelector('.cursor'), dica = box.querySelector('.dica');
    let atual = dias.length - 1;
    function mostrar(i) {
      const dia = dias[i];
      cursor.style.display = '';
      cursor.querySelector('line').setAttribute('x1', x(dia)); cursor.querySelector('line').setAttribute('x2', x(dia));
      const doDia = [...series.entries()].map(([n, s]) => ({ n, p: s.find((q) => q.dia === dia) })).filter((v) => v.p).sort((a, b) => a.p.preco - b.p.preco);
      const linhas = doDia.filter((v) => destacados.includes(v.n) || v === doDia[0]).slice(0, 5);
      dica.innerHTML = '<strong>' + esc(fmtDia(dia)) + '</strong>' + (linhas.length ? linhas.map((v) => {
        const k = destacados.indexOf(v.n);
        return '<div class="linha-dica"><span>' + (k >= 0 ? '<i style="background:' + DESTAQUES[k].cor + '"></i>' : '') + esc(v.n) + (v === doDia[0] ? ' (menor)' : '') + '</span><b>' + esc(preco(v.p.preco)) + '</b></div>';
      }).join('') : '<div class="linha-dica"><span>Sem cotação neste dia</span></div>');
      dica.classList.remove('oculto');
      const esc2 = box.clientWidth / W;
      let left = x(dia) * esc2 + 14;
      if (left + dica.offsetWidth > box.clientWidth) left = x(dia) * esc2 - dica.offsetWidth - 14;
      dica.style.left = left + 'px';
      dica.style.top = '8px';
    }
    const alvoEl = svg.querySelector('.alvo');
    alvoEl.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const d = d0 + (((e.clientX - r.left) / r.width) * W - m.l) / (W - m.l - m.r) * (d1 - d0);
      let melhor = 0;
      dias.forEach((dd, i) => { if (Math.abs(dd - d) < Math.abs(dias[melhor] - d)) melhor = i; });
      atual = melhor; mostrar(atual);
    });
    alvoEl.addEventListener('mouseleave', () => { cursor.style.display = 'none'; dica.classList.add('oculto'); });
    box.tabIndex = 0;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Gráfico de preços. Use as setas para percorrer os dias de cotação.');
    box.onfocus = () => mostrar(atual);
    box.onblur = () => { cursor.style.display = 'none'; dica.classList.add('oculto'); };
    box.onkeydown = (e) => {
      if (e.key === 'ArrowLeft') { atual = Math.max(0, atual - 1); mostrar(atual); e.preventDefault(); }
      if (e.key === 'ArrowRight') { atual = Math.min(dias.length - 1, atual + 1); mostrar(atual); e.preventDefault(); }
    };
  }

  // ---------- tabela: últimos dias × fornecedores ----------
  function desenharTabela() {
    const dias = [...new Set([...series.values()].flat().map((x) => x.dia))].sort((a, b) => b - a).slice(0, DIAS_TABELA);
    // colunas: só quem cotou em algum dos dias mostrados (fornecedor novo entra, quem parou sai)
    const nomes = cotacaoAtual.map((c) => c.nome).filter((n) => series.get(n).some((q) => dias.includes(q.dia)));
    if (!dias.length) { el('pf-tabela').innerHTML = '<tbody><tr><td><div class="vazio">Nenhuma cotação neste recorte.</div></td></tr></tbody>'; return; }
    el('pf-tabela').innerHTML =
      '<thead><tr><th><span>Data</span></th>' + nomes.map((n) => '<th class="n"><span>' + esc(n) + '</span></th>').join('') + '</tr></thead><tbody>' +
      dias.map((d) => {
        const pts = nomes.map((n) => series.get(n).find((q) => q.dia === d) || null);
        const valores = pts.map((p) => (p ? p.preco : null));
        const min = Math.min(...valores.filter((v) => v !== null));
        return '<tr><td>' + esc(fmtDia(d)) + '</td>' + pts.map((p) => {
          const v = p ? p.preco : null;
          return '<td class="n' + (v === min ? ' menor-dia' : '') + '">' + (v === null ? '<span class="sem-dado">—</span>' : esc(preco(v)) + (v === min ? '<span class="sr"> (menor do dia)</span>' : '') +
            (p.pendente ? '<small class="cidade-linha pf-pendente" title="Lançado no site; aguardando gravação">' + (p.pendente === 'aplicada' ? 'gravado' : 'aguardando gravação') + '</small>' : '')) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody>';
  }

  // ---------- lançamentos: negociações e fornecedores ----------
  const lerPreco = (t) => { const s = String(t || '').trim().replace(/R\$|\s/g, '').replace(',', '.'); return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null; };
  const f4 = (v) => (v === null || v === undefined ? '' : f4x.format(v));
  // fornecedores de cada produto e unidade: aba Fornecedores (ou o histórico, enquanto ela não existir) + lançados no site
  function listaFornecedores(prod, uni) {
    const m = new Map();   // nome -> ativo
    if (dados.fornecedoresBomba) {
      for (const [f, p, u, ativo] of dados.fornecedoresBomba) if (p === prod && u === uni) m.set(f, ativo);
    } else {
      const ult = new Map();
      for (const l of dados.negociacao) if (l.produto === prod && l.unidade === uni) ult.set(l.fornecedor, Math.max(ult.get(l.fornecedor) || 0, l.dia));
      const hoje = dataParaDia(new Date());
      ult.forEach((dia, f) => m.set(f, hoje - dia <= 30));
    }
    for (const a of [...infoBomba.alteracoes].sort((x, y) => x.id - y.id)) {
      if (a.estado === 'erro') continue;
      if (a.tipo === 'fornecedor' && a.dados.produto === prod && a.dados.unidades.includes(uni)) m.set(a.dados.fornecedor, a.dados.ativo !== false);
      if (a.tipo === 'negociacao' && a.dados.produto === prod && a.dados.unidade === uni) m.set(a.dados.fornecedor, true);
    }
    return [...m.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], 'pt-BR'));
  }
  // última cotação de cada fornecedor (com os lançados no site), até o dia escolhido
  function ultimaCotacao(prod, uni, forn, ate) {
    let u = null;
    for (const l of base) if (l.produto === prod && l.unidade === uni && l.fornecedor === forn && l.dia <= ate && (!u || l.dia >= u.dia)) u = l;
    return u;
  }
  const dlgNeg = el('pf-dlg-neg'), formNeg = el('pf-form-neg'), dlgForn = el('pf-dlg-forn'), formForn = el('pf-form-forn');
  function erro(id, msg) { const e = el(id); if (!e) return; e.textContent = msg || ''; e.classList.toggle('oculto', !msg); }
  // cadastro: aba Fornecedores + lançados no site (pendentes ou gravados depois da última carga)
  function cadastro() {
    const m = new Map();
    for (const [f, p, u, ativo, cnpj] of dados.fornecedoresBomba || []) m.set(f + '|' + p + '|' + u, { f, p, u, ativo, cnpj: cnpj || null });
    for (const a of [...infoBomba.alteracoes].sort((x, y) => x.id - y.id)) {
      if (a.tipo !== 'fornecedor' || a.estado === 'erro') continue;
      for (const u of a.dados.unidades) {
        const k = a.dados.fornecedor + '|' + a.dados.produto + '|' + u, atual = m.get(k);
        const cnpj = a.dados.cnpjs && u in a.dados.cnpjs ? a.dados.cnpjs[u] || null : atual ? atual.cnpj : null;
        m.set(k, { f: a.dados.fornecedor, p: a.dados.produto, u, ativo: a.dados.ativo !== false, cnpj, pendente: naoNaBase(a) && a.estado !== 'aplicada' });
      }
    }
    return [...m.values()].sort((a, b) => (b.ativo - a.ativo) || a.f.localeCompare(b.f, 'pt-BR') || a.p.localeCompare(b.p) || nomeUnidade(a.u).localeCompare(nomeUnidade(b.u), 'pt-BR'));
  }
  // lista de fornecedores num pop-up (botão "Fornecedores"), com "Adicionar fornecedor" dentro
  const dlgLista = el('pf-dlg-lista');
  el('pf-abrir-lista').addEventListener('click', () => { desenharCadastro(); dlgLista.showModal(); });
  el('pf-fechar-lista').addEventListener('click', () => dlgLista.close());
  dlgLista.addEventListener('click', (e) => { if (e.target === dlgLista) dlgLista.close(); });
  function desenharCadastro() {
    const ls = cadastro();
    el('pf-cad-conta').textContent = fmt.int(ls.length) + (ls.length === 1 ? ' fornecedor por unidade' : ' fornecedores por unidade');
    el('pf-cadastro').innerHTML = '<thead><tr><th><span>Fornecedor</span></th><th><span>Produto</span></th><th><span>Unidade</span></th><th><span>CNPJ</span></th><th><span>Situação</span></th>' +
      (podeEditar ? '<th class="acoes-linha"><span>Ações</span></th>' : '') + '</tr></thead><tbody>' +
      ls.map((x, i) => '<tr><td><strong>' + esc(x.f) + '</strong></td><td>' + esc(nomeProduto(x.p)) + '</td><td>' + esc(nomeUnidade(x.u)) + '</td>' +
        '<td>' + (x.cnpj ? esc(fmtCnpj(x.cnpj)) : '<span class="sem-dado">sem CNPJ</span>') + '</td>' +
        '<td>' + (x.ativo ? 'Ativo' : 'Inativo') + (x.pendente ? '<small class="cidade-linha">aguardando gravação</small>' : '') + '</td>' +
        (podeEditar ? '<td class="acoes-linha"><button type="button" class="btn-linha" data-cad="' + i + '">Editar</button></td>' : '') + '</tr>').join('') + '</tbody>';
    el('pf-cadastro').onclick = (e) => {
      const b = e.target.closest('[data-cad]'); if (!b) return;
      abrirFornecedor(ls[Number(b.dataset.cad)]);
    };
  }
  function desenharLancamento() {
    const prod = formNeg.produto.value, uni = formNeg.unidade.value, dia = formNeg.data.value ? isoParaDia(formNeg.data.value) : dataParaDia(new Date());
    const lista = listaFornecedores(prod, uni);
    el('pf-lanc').innerHTML = lista.length
      ? '<thead><tr><th><span>Fornecedor</span></th><th class="n"><span>Última cotação</span></th><th class="n"><span>Preço do dia (R$/L)</span></th></tr></thead><tbody>' +
        lista.map(([f, ativo]) => {
          const u = ultimaCotacao(prod, uni, f, dia), mesmoDia = u && u.dia === dia;
          // Arla: já vem com o último preço (repete até mudar), só dos ativos; diesel: em branco, a não ser que o dia já tenha preço
          const valor = mesmoDia || (prod === 'ARLA' && ativo && u) ? u.preco : null;
          return '<tr><td><strong>' + esc(f) + '</strong>' + (ativo ? '' : '<small class="cidade-linha">inativo na aba Fornecedores</small>') + '</td>' +
            '<td class="n">' + (u ? 'R$ ' + esc(preco(u.preco)) + '<small class="cidade-linha">' + esc(fmtDia(u.dia)) + '</small>' : '<span class="sem-dado">—</span>') + '</td>' +
            '<td class="n"><input class="campo-tabela" inputmode="numeric" data-moeda="4" autocomplete="off" data-forn="' + esc(f) + '" value="' + esc(f4(valor).replace('.', ',')) + '"' +
              ' placeholder="' + esc(u ? f4(u.preco) : '0,0000') + '" aria-label="Preço de ' + esc(f) + '"></td></tr>';
        }).join('') + '</tbody>'
      : '<tbody><tr><td><div class="vazio">Nenhum fornecedor de ' + esc(nomeProduto(prod)) + ' em ' + esc(nomeUnidade(uni)) + '. Use Fornecedores > Adicionar fornecedor.</div></td></tr></tbody>';
  }
  // "Lançar negociação" e "Adicionar fornecedor": só as praças com negociação e as que já têm fornecedor cadastrado, mais a escolhida
  // na tela (23/11/2026: desde 18/11 aparecia o cadastro inteiro de unidades do portal, com outros nomes — RAJA JEQUIE em vez de JEQUIE)
  const unidadesLancamento = () => pracasDoLancamento(unidades, cadastro(), unidade);
  function abrirLancamento() {
    formNeg.reset();
    formNeg.data.value = diaIso(dataParaDia(new Date()));
    formNeg.produto.value = produto;
    formNeg.unidade.innerHTML = unidadesLancamento().map((u) => '<option value="' + esc(u) + '"' + (u === unidade ? ' selected' : '') + '>' + esc(nomeUnidade(u)) + '</option>').join('');
    erro('pf-erro-neg', '');
    desenharLancamento();
    dlgNeg.showModal();
    const primeiro = formNeg.querySelector('#pf-lanc input'); if (primeiro) primeiro.focus();
  }
  if (podeEditar) {
    el('pf-lancar').addEventListener('click', abrirLancamento);
    ['data', 'produto', 'unidade'].forEach((n) => formNeg[n].addEventListener('change', desenharLancamento));
    el('pf-cancelar-neg').addEventListener('click', () => dlgNeg.close());
    formNeg.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = formNeg.data.value;
      if (!data) { erro('pf-erro-neg', 'Escolha a data.'); return; }
      const itens = [], ruins = [];
      const prod = formNeg.produto.value, uni = formNeg.unidade.value, dia = isoParaDia(data);
      formNeg.querySelectorAll('#pf-lanc input[data-forn]').forEach((i) => {
        // preço que o dia já tinha (planilha ou lançado no site): apagar o campo exclui; o mesmo valor não é reenviado
        // (antes o campo vazio era ignorado e o preço errado ficava; e cada "Salvar" repetia todos os preços — 11/11/2026)
        const u = ultimaCotacao(prod, uni, i.dataset.forn, dia), ja = u && u.dia === dia ? u.preco : null;
        if (!i.value.trim()) {
          if (ja !== null) itens.push({ data, fornecedor: i.dataset.forn, produto: prod, unidade: uni, excluir: true });
          return;
        }
        const v = lerPreco(i.value);
        if (!(v > 0 && v < 50)) { ruins.push(i.dataset.forn); i.classList.add('invalido'); return; }
        i.classList.remove('invalido');
        if (ja !== null && Math.abs(ja - v) < 0.00005) return;
        itens.push({ data, fornecedor: i.dataset.forn, produto: prod, unidade: uni, preco: v });
      });
      if (ruins.length) { erro('pf-erro-neg', 'Confira o preço de ' + ruins.join(', ') + ' (ex.: 5,2825).'); return; }
      if (!itens.length) { erro('pf-erro-neg', 'Nada mudou: preencha um preço novo ou apague um preço do dia para excluí-lo.'); return; }
      const excl = itens.filter((x) => x.excluir).map((x) => x.fornecedor);
      if (excl.length && !(await confirmar('Excluir o preço de ' + excl.join(', ') + ' em ' + fmtDia(dia) + '? Ele sai das negociações.'))) return;
      await enviar({ negociacoes: itens }, 'pf-salvar-neg', 'pf-erro-neg', dlgNeg, () => {
        produto = formNeg.produto.value; unidade = formNeg.unidade.value;
      });
    });
    el('pf-novo-forn').addEventListener('click', () => abrirFornecedor(null));   // dentro do pop-up da lista
    el('pf-cancelar-forn').addEventListener('click', () => dlgForn.close());
    formForn.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nome = formForn.fornecedor.value.trim();
      const unis = [...formForn.querySelectorAll('#pf-forn-unidades input[type=checkbox]:checked')].map((i) => i.value);
      if (nome.length < 2) { erro('pf-erro-forn', 'Escreva o nome do fornecedor.'); formForn.fornecedor.focus(); return; }
      if (!unis.length) { erro('pf-erro-forn', 'Marque pelo menos uma unidade.'); return; }
      const cnpjs = {};
      for (const u of unis) {
        const c = soNumeros(formForn.querySelector('.pf-cnpj[data-uni="' + u + '"]').value);
        if (c && c.length !== 14) { erro('pf-erro-forn', 'O CNPJ de ' + nomeUnidade(u) + ' precisa ter 14 números.'); return; }
        cnpjs[u] = c;
      }
      await enviar({ fornecedor: { fornecedor: nome, produto: formForn.produto.value, unidades: unis, ativo: formForn.ativo.checked, cnpjs } }, 'pf-salvar-forn', 'pf-erro-forn', dlgForn);
    });
    [dlgNeg, dlgForn].forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
  }
  // novo fornecedor (x = null) ou editar uma linha do cadastro (CNPJ e ativo daquela unidade)
  function abrirFornecedor(x) {
    formForn.reset();
    const cad = cadastro();
    el('pf-dlg-forn-titulo').textContent = x ? 'Editar fornecedor' : 'Novo fornecedor';
    formForn.fornecedor.value = x ? x.f : '';
    formForn.fornecedor.readOnly = !!x;
    formForn.produto.value = x ? x.p : produto;
    formForn.produto.disabled = !!x;
    formForn.ativo.checked = x ? x.ativo : true;
    const unis = x ? [x.u] : unidadesLancamento();   // praças (SP, JEQUIE...), não os nomes do cadastro de unidades (RAJA JEQUIE)
    const cnpjDe = (u) => { const c = cad.find((y) => y.f === formForn.fornecedor.value.trim().toUpperCase() && y.p === formForn.produto.value && y.u === u); return c ? c.cnpj : ''; };
    el('pf-forn-unidades').innerHTML = unis.map((u) => '<div class="pf-uni-cnpj"><label class="pf-uni"><input type="checkbox" value="' + esc(u) + '"' +
      (x || u === unidade ? ' checked' : '') + (x ? ' disabled' : '') + '> ' + esc(nomeUnidade(u)) + '</label>' +
      '<input class="pf-cnpj" data-uni="' + esc(u) + '" data-mascara="cnpj" inputmode="numeric" maxlength="18" autocomplete="off" placeholder="CNPJ 00.000.000/0000-00" aria-label="CNPJ em ' + esc(nomeUnidade(u)) + '" value="' + esc(fmtCnpj(cnpjDe(u))) + '"></div>').join('');
    erro('pf-erro-forn', '');
    dlgForn.showModal();
    (x ? formForn.querySelector('.pf-cnpj') : formForn.fornecedor).focus();
  }
  async function enviar(corpo, idBotao, idErro, dlg, depois) {
    const b = el(idBotao), txt = b.textContent;
    b.disabled = true; b.textContent = 'Salvando…';
    try {
      const r = await fetch('/api/bomba-interna', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { location.href = '/?entrar=1'; return; }
      if (!r.ok) throw new Error(j.erro || 'Não foi possível salvar (' + r.status + ').');
      infoBomba.alteracoes = [...j.alteracoes, ...infoBomba.alteracoes];
      if (depois) depois();
      dlg.close();
      usarDados(dados); desenharEscolhas(); atualizar(); desenharPendentes(); desenharCadastro(); vigiar();
    } catch (err) {
      erro(idErro, err.message);
    } finally {
      b.disabled = false; b.textContent = txt;
    }
  }
  function desenharPendentes() {
    const caixa = el('pf-pendentes');
    if (!caixa) return;
    const pend = infoBomba.alteracoes.filter((a) => a.estado === 'pendente' || a.estado === 'aguardando');
    // "Cancelado: ..." (preço excluído antes de gravar) não é falha: fica fora do aviso
    const erros = infoBomba.alteracoes.filter((a) => a.estado === 'erro' && !/^Cancelado/.test(a.mensagem || ''));
    caixa.innerHTML = (pend.length ? esc(fmt.int(pend.length)) + (pend.length === 1 ? ' lançamento aguardando' : ' lançamentos aguardando') + ' gravação' +
      (pend.some((a) => a.estado === 'aguardando') ? '' : '') + '.' : '') +
      (erros.length ? ' <span class="aviso-linha">' + esc(fmt.int(erros.length)) + ' não gravado(s): ' + esc(erros[0].mensagem || '') + '</span>' : '');
  }
  // enquanto houver lançamento esperando a planilha, confere a cada 15 s
  let timer = null, parado = false;
  function vigiar() {
    if (parado || timer || !infoBomba.alteracoes.some((a) => a.estado === 'pendente' || a.estado === 'aguardando')) return;
    timer = setTimeout(async () => {
      timer = null;
      infoBomba = { ...infoBomba, ...(await buscarBomba()) };
      usarDados(dados); atualizar(); desenharPendentes(); desenharCadastro();
      vigiar();
    }, 15000);
  }

  // ---------- ciclo ----------
  const atualizar = agendador(() => {
    calcular();
    filtros.atualizarUI();
    desenharTotem();
    desenharResumo();
    desenharLegenda();
    desenharGrafico();
    desenharTabela();
  });
  desenharEscolhas();
  atualizar();
  desenharPendentes();
  desenharCadastro();
  vigiar();

  let tRedim = null;
  const aoRedimensionar = () => { clearTimeout(tRedim); tRedim = setTimeout(desenharGrafico, 120); };
  window.addEventListener('resize', aoRedimensionar);
  const ro = new ResizeObserver(aoRedimensionar);
  ro.observe(el('pf-grafico'));
  const aoAtualizarDados = () => Promise.all([carregarDados(), buscarBomba()]).then(([d, b]) => {
    infoBomba = { ...infoBomba, ...b }; usarDados(d); desenharEscolhas(); atualizar(); desenharPendentes();
  });
  window.addEventListener('dados-atualizados', aoAtualizarDados);
  return {
    desmontar() {
      parado = true; clearTimeout(timer);
      filtros.destruir();
      window.removeEventListener('resize', aoRedimensionar);
      window.removeEventListener('dados-atualizados', aoAtualizarDados);
      ro.disconnect();
    },
  };
}
