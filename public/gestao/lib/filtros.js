// Barra de filtros compartilhada pelos painéis: seleção múltipla com busca e contagem, período com atalhos,
// etiquetas removíveis e filtros guardados no endereço da página (#/rota?campo=valor&de=AAAA-MM-DD).
import { fmt, esc, fmtDia, mesDoDia, diaIso, isoParaDia, dataParaDia, inicioDoMes, placaDesabilitada } from './dados.js';

const ICONE_SETA = '<svg aria-hidden="true"><use href="#i-seta"/></svg>';
const ICONE_X = '<svg aria-hidden="true" width="14" height="14"><use href="#i-x"/></svg>';

const hoje = () => dataParaDia(new Date());
export const PRESETS = [
  { id: 'tudo', rotulo: 'Todo o período', faixa: () => [null, null] },
  { id: 'mes', rotulo: 'Este mês', faixa: () => { const m = mesDoDia(hoje()); return [inicioDoMes(m), null]; } },
  { id: 'mes-passado', rotulo: 'Mês passado', faixa: () => { const m = mesDoDia(hoje()) - 1; return [inicioDoMes(m), inicioDoMes(m + 1) - 1]; } },
  { id: '3meses', rotulo: 'Últimos 3 meses', faixa: () => { const m = mesDoDia(hoje()) - 2; return [inicioDoMes(m), null]; } },
  { id: 'ano', rotulo: 'Este ano', faixa: () => { const a = new Date().getFullYear(); return [isoParaDia(a + '-01-01'), null]; } },
  { id: 'ano-passado', rotulo: 'Ano passado', faixa: () => { const a = new Date().getFullYear() - 1; return [isoParaDia(a + '-01-01'), isoParaDia(a + '-12-31')]; } },
];

/**
 * @param {object} o
 * @param {Array}  o.dimensoes   [{id, rotulo, valor:(linha)=>texto} | {id:'periodo', rotulo, periodo:true}]
 * @param {Element} o.filtrosEl  onde desenhar a barra
 * @param {Element} o.chipsEl    onde desenhar as etiquetas
 * @param {string} o.rota        ex.: '#/despesas'
 * @param {Function} o.obterBase  () => linhas usadas nas contagens das opções
 * @param {Function} o.obterLimites () => [diaMin, diaMax]
 * @param {Function} o.aoMudar   chamado sempre que um filtro muda
 * @param {string} [o.prefixo]   prefixo dos ids (quando há mais de uma barra no DOM)
 * @param {string} [o.periodoPadrao] período ao entrar na tela sem período no endereço ('mes': o mês atual, ou o mês
 *                                passado quando a Base ainda não tem abastecimento no mês). "Todo o período" escolhido
 *                                pela pessoa fica no endereço (periodo=tudo) e é respeitado.
 */
export function criarFiltros(o) {
  const { filtrosEl, chipsEl, rota, obterBase, obterLimites, aoMudar } = o;
  const px = o.prefixo || 'f';
  // filtros a partir do n-ésimo ficam atrás de "Mais filtros" (celular e computador; o.recolher === false mostra todos no computador)
  const visiveis = o.visiveis || 3;
  // os mais usados vêm primeiro e ficam à mostra: Período (data), Placa e Estabelecimento; os outros mantêm a ordem da tela
  const prioridade = (d) => (d.periodo ? 0 : d.id === 'placa' ? 1 : d.id === 'estabelecimento' || d.id === 'posto' || d.rotulo === 'Estabelecimento' ? 2 : 9);
  const dimensoes = o.dimensoes.map((d, i) => [d, i]).sort((a, b) => prioridade(a[0]) - prioridade(b[0]) || a[1] - b[1]).map(([d]) => d);
  if (o.recolher !== false) filtrosEl.classList.add('recolher');
  const sel = {};
  dimensoes.forEach((d) => { if (!d.periodo) sel[d.id] = new Set(); });
  const periodo = { de: null, ate: null, preset: 'tudo' };
  const temPeriodo = dimensoes.some((d) => d.periodo);
  let painelAberto = null;

  // ignorar: id de uma dimensão (ou lista de ids) que não conta
  function passa(l, ignorar) {
    const pular = Array.isArray(ignorar) ? ignorar : [ignorar];
    for (const d of dimensoes) {
      if (pular.includes(d.id)) continue;
      if (d.periodo) {
        if (periodo.de !== null && l.dia < periodo.de) return false;
        if (periodo.ate !== null && l.dia > periodo.ate) return false;
      } else if (sel[d.id].size && !sel[d.id].has(d.valor(l))) return false;
    }
    return true;
  }

  // ---- rótulos ----
  function rotuloPeriodoCurto() {                   // "01/08 a 31/08/26" cabe no botão
    const curto = (d) => fmtDia(d).slice(0, 5);
    const ano2 = (d) => fmtDia(d).slice(8);
    const { de, ate } = periodo;
    if (de !== null && ate !== null) {
      return fmtDia(de).slice(6) === fmtDia(ate).slice(6)
        ? curto(de) + ' a ' + curto(ate) + '/' + ano2(ate)
        : curto(de) + '/' + ano2(de) + ' a ' + curto(ate) + '/' + ano2(ate);
    }
    return de !== null ? 'Desde ' + curto(de) + '/' + ano2(de) : 'Até ' + curto(ate) + '/' + ano2(ate);
  }
  function rotuloPeriodoLongo() {
    const p = PRESETS.find((x) => x.id === periodo.preset);
    if (p) return p.rotulo;
    return (periodo.de !== null ? fmtDia(periodo.de) : 'início') + ' a ' + (periodo.ate !== null ? fmtDia(periodo.ate) : 'hoje');
  }
  function rotulo(d) {
    if (d.periodo) {
      if (periodo.de === null && periodo.ate === null) return 'Todos';
      const p = PRESETS.find((x) => x.id === periodo.preset);
      return p ? p.rotulo : rotuloPeriodoCurto();
    }
    const s = sel[d.id];
    if (!s.size) return 'Todos';
    if (s.size === 1) return [...s][0];
    return s.size + ' selecionados';
  }
  const ativo = (d) => (d.periodo ? periodo.de !== null || periodo.ate !== null : sel[d.id].size > 0);

  // ---- desenho ----
  function desenhar() {
    filtrosEl.innerHTML = dimensoes.map((d, i) =>
      '<div class="filtro' + (i >= visiveis ? ' filtro-extra' : '') + '" data-dim="' + d.id + '">' +
        '<span class="filtro-rotulo" id="' + px + '-rot-' + d.id + '">' + esc(d.rotulo) + '</span>' +
        '<button type="button" class="filtro-botao' + (ativo(d) ? ' ativo' : '') + '" aria-haspopup="true" aria-expanded="false" ' +
          'aria-labelledby="' + px + '-rot-' + d.id + ' ' + px + '-val-' + d.id + '">' +
          '<span class="valor" id="' + px + '-val-' + d.id + '">' + esc(rotulo(d)) + '</span>' + ICONE_SETA +
        '</button>' +
      '</div>').join('') +
      (dimensoes.length > visiveis ? '<button type="button" class="btn btn-mais-filtros" data-mais aria-expanded="false"></button>' : '') +
      '<button type="button" class="btn limpar" data-limpar>Limpar filtros</button>';
    rotuloMais();
  }
  function rotuloMais() {
    const b = filtrosEl.querySelector('[data-mais]');
    if (!b) return;
    const aberto = filtrosEl.classList.contains('aberto');
    const n = dimensoes.filter((d, i) => i >= visiveis && ativo(d)).length;
    b.textContent = aberto ? 'Menos filtros' : 'Mais filtros' + (n ? ' (' + n + ')' : '');
    b.setAttribute('aria-expanded', String(aberto));
    b.classList.toggle('ativo', !aberto && n > 0);
  }

  function atualizarUI() {
    dimensoes.forEach((d) => {
      const b = filtrosEl.querySelector('[data-dim="' + d.id + '"] .filtro-botao');
      if (!b) return;
      b.classList.toggle('ativo', ativo(d));
      b.querySelector('.valor').textContent = rotulo(d);
    });
    rotuloMais();
    const chips = [];
    dimensoes.forEach((d) => {
      if (d.periodo) { if (ativo(d)) chips.push({ d: d.id, v: '', txt: 'Período: ' + rotuloPeriodoLongo() }); }
      // vários valores do mesmo filtro: uma etiqueta só ("Combustível: DIESEL +3"); o x limpa o filtro inteiro
      else if (sel[d.id].size === 1) sel[d.id].forEach((v) => chips.push({ d: d.id, v, txt: d.rotulo + ': ' + v }));
      else if (sel[d.id].size > 1) {
        const vs = [...sel[d.id]].sort((a, b) => String(a).localeCompare(String(b), 'pt-BR', { numeric: true }));
        chips.push({ d: d.id, v: '', todos: true, txt: d.rotulo + ': ' + vs[0] + ' +' + (vs.length - 1), titulo: vs.join(', ') });
      }
    });
    chipsEl.innerHTML = chips.map((c) =>
      '<span class="chip"' + (c.titulo ? ' title="' + esc(c.titulo) + '"' : '') + '>' + esc(c.txt) +
      '<button type="button" aria-label="Remover ' + esc(c.titulo ? d0(c.d) + ': ' + c.titulo : c.txt) + '" data-d="' + c.d + '" data-v="' + esc(c.v) + '"' + (c.todos ? ' data-todos' : '') + '>' + ICONE_X + '</button></span>').join('') +
      avisoPeriodo();
    escreverURL();
  }

  const d0 = (id) => dimensoes.find((x) => x.id === id).rotulo;
  function mudou() { aoMudar(); }

  // período sem nenhum dia dentro da Base (ex.: "Este mês" no dia 1º, antes de a Base trazer o mês novo): explica
  // por que os painéis ficaram vazios e oferece o mês passado
  function avisoPeriodo() {
    if (!temPeriodo) return '';
    const [min, max] = obterLimites();
    const depois = periodo.de !== null && periodo.de > max;
    const antes = periodo.ate !== null && periodo.ate < min;
    if (!depois && !antes) return '';
    return '<span class="chip-aviso" role="status">' + (depois
      ? 'Há abastecimentos até ' + esc(fmtDia(max)) + ': este período ainda não tem dados. Quando os abastecimentos dele entrarem, eles aparecem aqui.'
      : 'Os abastecimentos começam em ' + esc(fmtDia(min)) + ': este período não tem dados.') +
      (depois ? ' <button type="button" class="link-acao" data-ultimo-mes>Ver o mês passado</button>' : '') + '</span>';
  }

  // ---- painéis ----
  function fecharPainel() {
    if (!painelAberto) return;
    painelAberto.painel.remove();
    painelAberto.botao.setAttribute('aria-expanded', 'false');
    painelAberto = null;
  }
  function abrirPainel(filtroEl) {
    const id = filtroEl.dataset.dim;
    const reabrir = painelAberto && painelAberto.id === id;
    fecharPainel();
    if (reabrir) return;
    const d = dimensoes.find((x) => x.id === id);
    const botao = filtroEl.querySelector('.filtro-botao');
    const painel = document.createElement('div');
    painel.className = 'painel-filtro';
    painel.setAttribute('role', 'dialog');
    painel.setAttribute('aria-label', d.rotulo);
    filtroEl.appendChild(painel);
    botao.setAttribute('aria-expanded', 'true');
    painelAberto = { id, painel, botao };
    if (d.periodo) desenharPainelPeriodo(painel); else desenharPainelOpcoes(painel, d);
    const r = painel.getBoundingClientRect();
    if (r.right > innerWidth - 8) painel.style.left = Math.min(0, innerWidth - 8 - r.right) + 'px';
  }

  function desenharPainelOpcoes(painel, d) {
    const contagem = new Map();
    for (const l of obterBase()) {
      if (!passa(l, d.id)) continue;
      const v = d.valor(l);
      contagem.set(v, (contagem.get(v) || 0) + 1);
    }
    // placa desabilitada no cadastro não aparece na lista (a não ser que já esteja escolhida)
    if (d.id === 'placa') for (const v of [...contagem.keys()]) if (placaDesabilitada(v) && !sel[d.id].has(v)) contagem.delete(v);
    sel[d.id].forEach((v) => { if (!contagem.has(v)) contagem.set(v, 0); });
    const valores = [...contagem.keys()].sort((a, b) => String(a).localeCompare(String(b), 'pt-BR', { numeric: true }));
    const nome = d.rotulo.toLowerCase();
    painel.innerHTML =
      '<input type="search" autocomplete="off" placeholder="Procurar ' + esc(nome) + '…" aria-label="Procurar ' + esc(nome) + '">' +
      '<div class="opcoes" role="group"></div>' +
      '<div class="painel-rodape"><button type="button" class="link-acao" data-acao="visiveis">Marcar os visíveis</button>' +
      '<button type="button" class="link-acao" data-acao="limpar">Limpar</button></div>';
    const lista = painel.querySelector('.opcoes');
    const busca = painel.querySelector('input');
    function listar() {
      const t = busca.value.trim().toLowerCase();
      const vis = valores.filter((v) => !t || String(v).toLowerCase().includes(t));
      lista.innerHTML = vis.length ? vis.map((v) =>
        '<button type="button" class="opcao' + (contagem.get(v) ? '' : ' indisponivel') + '" role="checkbox" aria-checked="' + sel[d.id].has(v) + '" data-v="' + esc(v) + '">' +
          '<span class="caixa"></span><span class="txt">' + esc(v) + '</span><span class="qtd">' + fmt.int(contagem.get(v)) + '</span>' +
        '</button>').join('') : '<div class="vazio">Nada encontrado com esse texto.</div>';
      return vis;
    }
    let visiveis = listar();
    busca.addEventListener('input', () => { visiveis = listar(); });
    lista.addEventListener('click', (e) => {
      const b = e.target.closest('.opcao');
      if (!b) return;
      const v = b.dataset.v;
      if (sel[d.id].has(v)) sel[d.id].delete(v); else sel[d.id].add(v);
      b.setAttribute('aria-checked', String(sel[d.id].has(v)));
      mudou();
    });
    painel.querySelector('.painel-rodape').addEventListener('click', (e) => {
      const a = e.target.closest('[data-acao]');
      if (!a) return;
      if (a.dataset.acao === 'limpar') sel[d.id].clear();
      else visiveis.forEach((v) => sel[d.id].add(v));
      listar();
      mudou();
    });
    setTimeout(() => busca.focus(), 0);
  }

  function desenharPainelPeriodo(painel) {
    const [min, max] = obterLimites();
    painel.innerHTML =
      '<div class="periodos">' + PRESETS.map((p) =>
        '<button type="button" data-p="' + p.id + '" aria-pressed="' + (periodo.preset === p.id) + '">' + esc(p.rotulo) + '</button>').join('') + '</div>' +
      '<div class="datas">' +
        '<label>De<input type="date" data-campo="de" min="' + diaIso(min) + '" max="' + diaIso(max) + '" value="' + (periodo.de !== null ? diaIso(periodo.de) : '') + '"></label>' +
        '<label>Até<input type="date" data-campo="ate" min="' + diaIso(min) + '" max="' + diaIso(max) + '" value="' + (periodo.ate !== null ? diaIso(periodo.ate) : '') + '"></label>' +
      '</div>';
    painel.querySelector('.periodos').addEventListener('click', (e) => {
      const b = e.target.closest('[data-p]');
      if (!b) return;
      const p = PRESETS.find((x) => x.id === b.dataset.p);
      [periodo.de, periodo.ate] = p.faixa();
      periodo.preset = p.id;
      fecharPainel();
      mudou();
    });
    painel.querySelectorAll('input[type="date"]').forEach((inp) => inp.addEventListener('change', () => {
      const de = painel.querySelector('[data-campo="de"]').value, ate = painel.querySelector('[data-campo="ate"]').value;
      periodo.de = de ? isoParaDia(de) : null;
      periodo.ate = ate ? isoParaDia(ate) : null;
      if (periodo.de !== null && periodo.ate !== null && periodo.de > periodo.ate) [periodo.de, periodo.ate] = [periodo.ate, periodo.de];
      periodo.preset = periodo.de === null && periodo.ate === null ? 'tudo' : 'personalizado';
      painel.querySelectorAll('[data-p]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.p === periodo.preset)));
      mudou();
    }));
  }

  // ---- eventos ----
  filtrosEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-limpar]')) { limpar(); return; }
    if (e.target.closest('[data-mais]')) { filtrosEl.classList.toggle('aberto'); rotuloMais(); return; }
    const b = e.target.closest('.filtro-botao');
    if (b) abrirPainel(b.closest('.filtro'));
  });
  chipsEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-ultimo-mes]')) {
      const p = PRESETS.find((x) => x.id === 'mes-passado');
      [periodo.de, periodo.ate] = p.faixa();
      periodo.preset = p.id;
      mudou();
      return;
    }
    const b = e.target.closest('button[data-d]');
    if (!b) return;
    if (b.dataset.d === 'periodo') { periodo.de = periodo.ate = null; periodo.preset = 'tudo'; }
    else if ('todos' in b.dataset) sel[b.dataset.d].clear();
    else sel[b.dataset.d].delete(b.dataset.v);
    mudou();
  });
  const foraDoPainel = (e) => { if (painelAberto && !e.target.closest('.filtro')) fecharPainel(); };
  const escPainel = (e) => { if (e.key === 'Escape' && painelAberto) { const b = painelAberto.botao; fecharPainel(); b.focus(); } };
  document.addEventListener('mousedown', foraDoPainel);
  document.addEventListener('keydown', escPainel);

  function limpar() {
    Object.values(sel).forEach((s) => s.clear());
    periodo.de = periodo.ate = null; periodo.preset = 'tudo';
    fecharPainel();
    mudou();
  }

  // ---- endereço da página ----
  function lerURL() {
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    dimensoes.forEach((d) => { if (!d.periodo) q.getAll(d.id).forEach((v) => sel[d.id].add(v)); });
    if (!temPeriodo) return;
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (iso.test(q.get('de') || '')) periodo.de = isoParaDia(q.get('de'));
    if (iso.test(q.get('ate') || '')) periodo.ate = isoParaDia(q.get('ate'));
    const p = PRESETS.find((x) => x.id === q.get('periodo'));
    if (p && p.id !== 'tudo') { [periodo.de, periodo.ate] = p.faixa(); periodo.preset = p.id; }
    else if (periodo.de !== null || periodo.ate !== null) periodo.preset = 'personalizado';
    else if (!p && o.periodoPadrao) {
      // entrou sem período: abre no mês (evita o susto do total de todo o histórico)
      let id = o.periodoPadrao;
      if (id === 'mes') {
        try { const [, max] = obterLimites(); if (max < inicioDoMes(mesDoDia(hoje()))) id = 'mes-passado'; } catch {}
      }
      const d = PRESETS.find((x) => x.id === id);
      if (d) { [periodo.de, periodo.ate] = d.faixa(); periodo.preset = d.id; }
    }
  }
  function escreverURL() {
    const q = new URLSearchParams();
    dimensoes.forEach((d) => { if (!d.periodo) sel[d.id].forEach((v) => q.append(d.id, v)); });
    if (o.extrasURL) Object.entries(o.extrasURL()).forEach(([k, v]) => { if (v !== null && v !== undefined && v !== '') q.set(k, v); });
    if (periodo.preset !== 'tudo' && periodo.preset !== 'personalizado') q.set('periodo', periodo.preset);
    else if (periodo.preset === 'tudo' && o.periodoPadrao && temPeriodo) q.set('periodo', 'tudo');   // escolha da pessoa, não o padrão
    else {
      if (periodo.de !== null) q.set('de', diaIso(periodo.de));
      if (periodo.ate !== null) q.set('ate', diaIso(periodo.ate));
    }
    const s = q.toString();
    const novo = rota + (s ? '?' + s : '');
    trocarEndereco(rota, novo);   // sem recarregar a rota
    salvarFiltros(rota, s);   // ao voltar para esta tela, os filtros continuam (até sair do portal)
  }

  lerURL();
  desenhar();

  return {
    sel, periodo, passa, atualizarUI, limpar,
    alternar(dim, v) { if (sel[dim].has(v)) sel[dim].delete(v); else sel[dim].add(v); mudou(); },
    // período vindo de fora da barra (ex.: clique num mês do gráfico); preset 'personalizado' ou um dos PRESETS
    definirPeriodo(de, ate, preset) {
      periodo.de = de; periodo.ate = ate;
      periodo.preset = preset || (de === null && ate === null ? 'tudo' : 'personalizado');
      fecharPainel();
      mudou();
    },
    parametro: (nome) => new URLSearchParams(location.hash.split('?')[1] || '').get(nome),
    destruir() {
      document.removeEventListener('mousedown', foraDoPainel);
      document.removeEventListener('keydown', escPainel);
      fecharPainel();
    },
  };
}

// ---------- filtros guardados por tela, só nesta sessão do navegador (sessionStorage) ----------
// Saem ao fechar o navegador, ao clicar em Sair e ao entrar de novo no portal (limparFiltrosSalvos).
const PREFIXO_FILTROS = 'filtros:';
// troca o endereço (#/rota?...) sem recarregar, só se a página aberta ainda é a desta tela (27/11/2026: uma tela que terminava
// de carregar depois que a pessoa já tinha ido para outra reescrevia o endereço e a levava de volta)
export function trocarEndereco(rota, novo) {
  if (location.hash.split('?')[0] !== String(rota).split('?')[0]) return;
  if (location.hash !== novo) history.replaceState(null, '', novo);
}

export function salvarFiltros(rota, consulta) {
  try {
    if (consulta) sessionStorage.setItem(PREFIXO_FILTROS + rota, consulta);
    else sessionStorage.removeItem(PREFIXO_FILTROS + rota);
  } catch {}
}
export function filtrosSalvos(rota) {
  try { return sessionStorage.getItem(PREFIXO_FILTROS + rota) || ''; } catch { return ''; }
}
export function limparFiltrosSalvos() {
  try { Object.keys(sessionStorage).filter((k) => k.startsWith(PREFIXO_FILTROS)).forEach((k) => sessionStorage.removeItem(k)); } catch {}
}

// ---------- peças compartilhadas pelos painéis ----------
export const ICONES = {
  cima: '<svg aria-hidden="true"><use href="#i-cima"/></svg>',
  baixo: '<svg aria-hidden="true"><use href="#i-baixo"/></svg>',
};

// Faixas do % da meta (média km/L ÷ meta): abaixo de 100% não é "ruim" — quanto mais perto de 100%, melhor.
// 100%+ verde · 95% a 100% verde-claro · 90% a 95% amarelo · menos de 90% vermelho (gestao.css: .meta-100/95/90/abaixo)
export const FAIXAS_META = [
  ['meta-100', '100% ou mais'], ['meta-95', '95% a 100%'], ['meta-90', '90% a 95%'], ['meta-abaixo', 'menos de 90%'],
];
export function faixaMeta(p) {
  if (p === null || p === undefined || !isFinite(p)) return '';
  return p >= 1 ? 'meta-100' : p >= 0.95 ? 'meta-95' : p >= 0.9 ? 'meta-90' : 'meta-abaixo';
}
// pílula com a cor da faixa e a seta (para cima: na meta; para baixo: abaixo)
export function metaHtml(p, texto) {
  const f = faixaMeta(p);
  if (!f) return '';
  return '<span class="status ' + f + '">' + (p >= 1 ? ICONES.cima : ICONES.baixo) + esc(texto) + '</span>';
}
// legenda das faixas (cor + texto)
export const legendaMeta = () => '<span class="legenda-meta">' + FAIXAS_META.map(([c, t]) => '<span><i class="' + c + '"></i>' + t + '</span>').join('') + '</span>';

// Texto de status sempre com ícone (nunca só a cor)
export function statusHtml(bom, texto) {
  return '<span class="status ' + (bom ? 'bom' : 'ruim') + '">' + (bom ? ICONES.cima : ICONES.baixo) + esc(texto) + '</span>';
}

// Mostrador da bomba: valor, litros e preço por litro (o elemento marcante do design system)
export function htmlBomba(t) {
  const registros = [
    { rot: 'Valor', uni: '', val: valorRs(t.despesa), destaque: true },
    { rot: 'Litros', uni: 'L', val: fmt.d2(t.litros) },
    { rot: 'Preço por litro', uni: 'R$/L', val: fmt.d3(t.preco) },
  ];
  return registros.map((r) =>
    '<div class="registro' + (r.destaque ? ' registro-principal' : '') + '">' +
      '<dt>' + esc(r.rot) + '</dt>' +
      '<dd><span class="reg-num">' + esc(r.val) + '</span>' + (r.uni ? '<span class="reg-uni">' + esc(r.uni) + '</span>' : '') + '</dd>' +
    '</div>').join('');
}
// Padrão do portal: reais sempre com "R$" na frente (R$ 1.234,56); preço por litro com 3 casas e "R$/L" depois
export const valorRs = (v) => (v === null || v === undefined || !isFinite(v) ? '—' : 'R$ ' + fmt.d2(v));

// Linha de apoio: [{rot, val, det?(html)}]
// valor sem nenhum algarismo (ex.: "a do estado de cada abastecimento") é texto: quebra linha em vez de estourar o cartão (18/11)
export const valorTexto = (v) => typeof v === 'string' && v.trim() !== '' && v.trim() !== '—' && !/\d/.test(v);
export function htmlApoio(itens) {
  return itens.map((a) =>
    '<div><dt>' + esc(a.rot) + '</dt><dd><span class="num' + (valorTexto(a.val) ? ' apoio-texto' : '') + '">' + esc(a.val) + '</span>' + (a.det ? ' ' + a.det : '') + '</dd></div>').join('');
}

// "Mostrar mais N" e "Mostrar menos" embaixo de uma lista paginada aos poucos (botões data-mais / data-menos)
export function botoesMaisMenos(total, limite, passo) {
  const mais = total > limite, menos = limite > passo && total > passo;
  if (!mais && !menos) return '';
  return '<div class="mais-acoes">' +
    (mais ? '<button type="button" class="mais-ranking" data-mais>Mostrar mais ' + Math.min(passo, total - limite) +
      ' <span>(' + fmt.int(Math.min(limite, total)) + ' de ' + fmt.int(total) + ')</span></button>' : '') +
    (menos ? '<button type="button" class="mais-ranking" data-menos>Mostrar menos <span>(voltar aos ' + fmt.int(passo) + ' primeiros)</span></button>' : '') +
  '</div>';
}

// Agenda uma única atualização por ciclo (microtarefa: roda mesmo com a aba em segundo plano)
export function agendador(fn) {
  let agendado = false;
  return () => {
    if (agendado) return;
    agendado = true;
    queueMicrotask(() => { agendado = false; fn(); });
  };
}
