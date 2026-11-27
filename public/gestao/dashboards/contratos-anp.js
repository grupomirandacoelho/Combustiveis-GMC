// Dashboard "Contratos x ANP" — ANP semanal do estado de referência de cada unidade contra a ANP da semana em que o contrato foi
// feito. Os contratos ficam no banco do portal (/api/contratos-anp; cadastro nesta tela), sem a planilha de reajustes.
//  - ANP: preço médio de revenda do óleo diesel S10 do estado, semana a semana (/gestao/dados/anp.json)
//  - variação = ANP da semana escolhida ÷ ANP da semana da data do contrato − 1 (por padrão, a última semana publicada)
import { fmt, esc, fmtDia } from '../lib/dados.js';
import { htmlApoio, agendador, trocarEndereco } from '../lib/filtros.js';
import { graficoPeriodo } from '../lib/graficos.js';
import { carregarOpcoes, listaEfetiva, temConfig, BOTAO_OPCOES, abrirOpcoes } from '../lib/opcoes.js';

const ROTA = '#/contratos-anp';
// regra do contrato: o preço só muda quando a ANP varia mais de 5% (para cima ou para baixo) desde a data base
const GATILHO = 0.05;
const foraDoGatilho = (pct) => pct !== null && Math.abs(pct) > GATILHO + 1e-9;
const SEMANAS_ANTES = 6;   // o gráfico começa algumas semanas antes da data base do contrato
const NOME_UF = { AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo',
  GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná',
  PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima',
  SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins' };

const semana = (dia) => dia - ((dia + 4) % 7);   // domingo da semana, como a "DATA INICIAL" da ANP
const diaIso = (iso) => { const [a, m, d] = iso.split('-').map(Number); return Math.floor(Date.UTC(a, m - 1, d) / 864e5); };
const rs = (v) => (v === null || v === undefined ? '—' : 'R$ ' + fmt.d3(v));
const sinal = (v, f) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v)));
const rotSemana = (p) => fmtDia(p).slice(0, 5) + ' a ' + fmtDia(p + 6);

async function obter(arquivo, nome) {
  const r = await fetch('/gestao/dados/' + arquivo, { credentials: 'same-origin' });
  if (r.status === 401 || r.redirected) { location.href = '/?entrar=1'; throw new Error('sessão'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Não foi possível carregar ' + nome + ' (' + r.status + ').');
  return j;
}

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando os contratos e os preços da ANP…</div>';
  let anp, contratos = [], podeEditar = false;
  async function carregarContratos() {
    const r = await fetch('/api/contratos-anp', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || 'Não foi possível carregar os contratos (' + r.status + ').');
    contratos = j.contratos; podeEditar = j.podeEditar;
  }
  async function carregar() { [anp] = await Promise.all([obter('anp.json', 'os preços da ANP'), carregarContratos()]); }
  try { await carregar(); } catch (e) {
    pagina.innerHTML = '<div class="vazio">' + esc(e.message) + ' Recarregue a página para tentar de novo.</div>';
    return {};
  }

  // ANP semanal por estado: "UF|domingo" -> {v, n, mn, mx}; semanas publicadas em ordem
  let porEstado, semanas;
  function usarANP() {
    porEstado = new Map();
    const s = anp.series.semanal.estado, ufs = anp.locais.estado.map((e) => e[0]);
    for (let i = 0; i < s.p.length; i++) {
      porEstado.set(ufs[s.l[i]] + '|' + s.p[i], { v: s.v[i] / 1000, n: s.n[i], mn: s.mn[i] === null ? null : s.mn[i] / 1000, mx: s.mx[i] === null ? null : s.mx[i] / 1000 });
    }
    semanas = [...new Set(s.p)].sort((a, b) => a - b);
  }
  usarANP();
  // semana sem pesquisa naquele estado: vale a anterior mais próxima (até 3 semanas)
  function anpEm(uf, p) {
    for (let k = 0; k <= 3; k++) {
      const x = porEstado.get(uf + '|' + (p - 7 * k));
      if (x) return { ...x, semana: p - 7 * k };
    }
    return null;
  }

  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const estado = { semana: Number(q.get('semana')) || null, sel: q.get('unidade') || '', ordem: { col: 'pct', dir: -1 } };

  pagina.innerHTML = `
    <div class="anp-controles">
      <div class="anp-grupo anp-local"><label class="filtro-rotulo" for="ct-semana">Comparar com a ANP da semana</label><select id="ct-semana" class="campo-sel"></select></div>
    </div>
    <div class="abertura">
      <section class="bomba" aria-labelledby="ct-bomba-titulo">
        <h2 class="bomba-titulo" id="ct-bomba-titulo">ANP contra a ANP da data do contrato</h2>
        <dl class="bomba-registros" id="ct-bomba"></dl>
      </section>
      <dl class="apoio apoio-coluna" id="ct-resumo"></dl>
    </div>
    <section class="painel painel-tabela">
      <div class="painel-cab"><h2>Por unidade</h2><span class="conta" id="ct-conta"></span>
        <button type="button" class="btn btn-principal oculto" id="ct-novo"><svg aria-hidden="true"><use href="#i-mais"/></svg><span class="txt">Adicionar contrato</span></button></div>
      <p class="nota" id="ct-nota"></p>
      <div class="tabela-rolagem"><table class="dados tabela-clicavel" id="ct-tabela"></table></div>
    </section>
    <section class="painel painel-largo">
      <div class="painel-cab">
        <h2 id="ct-grafico-titulo"></h2>
        <div class="legenda"><span><i class="leg-media"></i>ANP do estado (semanal)</span><span><i class="leg-meta leg-tracejada"></i>ANP na data do contrato</span><span><i class="leg-meta leg-tracejada leg-gatilho"></i>+5%</span><span><i class="leg-meta leg-tracejada leg-piso"></i>−5%</span></div>
      </div>

      <div class="grafico" id="ct-grafico"></div>
    </section>
    <p class="nota anp-fonte" id="ct-fonte"></p>
    <dialog class="dialogo" id="ct-dlg" aria-labelledby="ct-dlg-titulo">
      <form method="dialog" id="ct-form" novalidate>
        ${BOTAO_OPCOES}
        <h2 id="ct-dlg-titulo">Adicionar contrato</h2>
        <div class="grade-form">
          <label class="campo-form largo"><span>Unidade</span><input name="unidade" maxlength="80" autocomplete="off" required list="ct-sug-unidade"></label>
          <label class="campo-form"><span>Estado de referência da ANP</span><select name="uf" class="campo-sel">${Object.entries(NOME_UF).map(([k, v]) => '<option value="' + k + '">' + esc(v) + '</option>').join('')}</select></label>
          <label class="campo-form"><span>Data do contrato</span><input type="date" name="data_contrato" required></label>
          <label class="campo-form largo"><span>Produto</span><input name="produto" maxlength="60" autocomplete="off" list="ct-sug-produto"></label>
          <label class="campo-form largo"><span>Observação</span><input name="observacao" maxlength="300" autocomplete="off"></label>
        </div>
        <datalist id="ct-sug-unidade"></datalist><datalist id="ct-sug-produto"></datalist>
        <p class="nota" id="ct-dlg-anp"></p>
        <p class="erro-form oculto" id="ct-erro" role="alert"></p>
        <div class="dialogo-acoes"><button type="button" class="btn" id="ct-cancelar">Cancelar</button><button type="submit" class="btn btn-principal" id="ct-salvar">Salvar</button></div>
      </form>
    </dialog>`;
  const el = (id) => pagina.querySelector('#' + id);

  function linhas() {
    const p = estado.semana;
    return contratos.filter((c) => c.ativo).map((c) => {
      const dia = diaIso(c.data_contrato);
      const naBase = anpEm(c.uf, semana(dia)), atual = anpEm(c.uf, p);
      const dif = atual && naBase ? atual.v - naBase.v : null;
      return { ...c, dia, naBase, atual, dif, pct: dif === null ? null : atual.v / naBase.v - 1 };
    });
  }

  function escreverURL() {
    const s = new URLSearchParams();
    if (estado.semana !== semanas[semanas.length - 1]) s.set('semana', estado.semana);
    if (estado.sel) s.set('unidade', estado.sel);
    const novo = ROTA + (s.toString() ? '?' + s : '');
    trocarEndereco(ROTA, novo);
  }

  const COLUNAS = [
    { id: 'unidade', rot: 'Unidade', v: (l) => l.unidade },
    { id: 'uf', rot: 'Estado de referência', v: (l) => NOME_UF[l.uf] },
    { id: 'dia', rot: 'Data do contrato', n: true, v: (l) => l.dia, f: (v) => fmtDia(v) },
    { id: 'naBase', rot: 'ANP na semana do contrato', n: true, v: (l) => (l.naBase ? l.naBase.v : null), f: rs },
    { id: 'atual', rot: 'ANP na semana', n: true, v: (l) => (l.atual ? l.atual.v : null), f: rs },
    { id: 'dif', rot: 'Diferença R$/L', n: true, v: (l) => l.dif, f: (v) => sinal(v, fmt.d3) },
    { id: 'pct', rot: 'Variação %', n: true, v: (l) => l.pct, f: (v) => sinal(v, fmt.pct) },
  ];

  function desenhar() {
    if (!semanas.includes(estado.semana)) estado.semana = semanas[semanas.length - 1];
    el('ct-semana').innerHTML = semanas.slice().reverse().map((p, i) => '<option value="' + p + '"' + (p === estado.semana ? ' selected' : '') + '>' +
      esc(rotSemana(p)) + (i === 0 ? ' (última publicada)' : '') + '</option>').join('');
    const ls = linhas();
    if (!ls.some((l) => l.unidade === estado.sel)) {
      const maior = ls.filter((l) => l.pct !== null).sort((a, b) => b.pct - a.pct)[0];
      estado.sel = maior ? maior.unidade : (ls[0] ? ls[0].unidade : '');
    }
    escreverURL();

    el('ct-novo').classList.toggle('oculto', !podeEditar);

    const com = ls.filter((l) => l.pct !== null);
    const media = com.length ? com.reduce((s, l) => s + l.pct, 0) / com.length : null;
    const acima = com.filter((l) => foraDoGatilho(l.pct) && l.pct > 0), abaixo = com.filter((l) => foraDoGatilho(l.pct) && l.pct < 0);
    el('ct-bomba').innerHTML = [
      { rot: 'Variação média da ANP', ico: 'mercado', uni: '', val: media === null ? '—' : sinal(media, fmt.pct), destaque: true },
      { rot: 'Acima da variação de +' + fmt.pct(GATILHO), ico: 'sobe', uni: 'de ' + com.length, val: String(acima.length) },
      { rot: 'Abaixo da variação de −' + fmt.pct(GATILHO), ico: 'desce', uni: 'de ' + com.length, val: String(abaixo.length) },
    ].map((r) => '<div class="registro' + (r.destaque ? ' registro-principal' : '') + (r.ico ? ' ico-' + r.ico : '') + '"><dt>' + esc(r.rot) + '</dt><dd><span class="reg-num">' + esc(r.val) +
      '</span><span class="reg-uni">' + esc(r.uni) + '</span></dd></div>').join('');
    // ranking por estado de referência: a variação do estado é a da unidade dele com a maior (ou menor) variação
    const porUf = new Map();
    for (const l of com) {
      if (!porUf.has(l.uf)) porUf.set(l.uf, []);
      porUf.get(l.uf).push(l);
    }
    const estados = [...porUf.entries()].map(([uf, us]) => ({ uf, us, max: Math.max(...us.map((u) => u.pct)), min: Math.min(...us.map((u) => u.pct)) }));
    const maior = estados.slice().sort((a, b) => b.max - a.max)[0], menor = estados.slice().sort((a, b) => a.min - b.min)[0];
    const detalhe = (e, alvo) => {
      const us = e.us.filter((u) => Math.abs(u.pct - alvo) < 1e-9);
      const u = us[0];
      return '<small class="anp-cobertura">' + esc(us.map((x) => x.unidade).join(', ') + ': ' + rs(u.naBase.v) + ' na data do contrato, ' + rs(u.atual.v) + ' agora') + '</small>';
    };
    const dentro = com.length - acima.length - abaixo.length;
    el('ct-resumo').innerHTML = htmlApoio([
      { rot: 'Maior alta desde o contrato', val: maior && maior.max > 0 ? NOME_UF[maior.uf] + ' ' + sinal(maior.max, fmt.pct) : '—', det: maior && maior.max > 0 ? detalhe(maior, maior.max) : '' },
      { rot: 'Maior queda desde o contrato', val: menor && menor.min < 0 ? NOME_UF[menor.uf] + ' ' + sinal(menor.min, fmt.pct) : '—', det: menor && menor.min < 0 ? detalhe(menor, menor.min) : '' },
      { rot: 'Dentro da variação do contrato (±' + fmt.pct(GATILHO) + ')', val: dentro + ' de ' + com.length },
      { rot: 'Semana da ANP', val: rotSemana(estado.semana) },
    ]);

    const c = COLUNAS.find((x) => x.id === estado.ordem.col);
    ls.sort((a, b) => {
      const va = c.v(a), vb = c.v(b);
      if ((va === null) !== (vb === null)) return va === null ? 1 : -1;
      return estado.ordem.dir * (typeof va === 'string' ? va.localeCompare(vb, 'pt-BR') : va - vb) || a.unidade.localeCompare(b.unidade, 'pt-BR');
    });
    el('ct-conta').textContent = ls.length + (ls.length === 1 ? ' contrato' : ' contratos');
    el('ct-nota').textContent = '';
    el('ct-tabela').innerHTML = '<thead><tr>' + COLUNAS.map((col) => {
      const ativa = estado.ordem.col === col.id;
      return '<th' + (col.n ? ' class="n"' : '') + ' aria-sort="' + (ativa ? (estado.ordem.dir > 0 ? 'ascending' : 'descending') : 'none') + '"><button type="button" data-col="' + col.id + '">' +
        esc(col.rot) + (ativa ? '<span class="seta">' + (estado.ordem.dir > 0 ? '▲' : '▼') + '</span>' : '') + '</button></th>';
    }).join('') + '<th><span>Situação</span></th>' + (podeEditar ? '<th class="nt-col-acoes"><span class="sr">Ações</span></th>' : '') + '</tr></thead><tbody>' + (ls.length ? ls.map((l) => {
      // vermelho só quando a ANP passa de +5% do contrato; abaixo de −5% é sinalizado sem vermelho
      const fora = foraDoGatilho(l.pct);
      const tom = fora && l.pct > 0 ? ' anp-acima' : '';
      const sit = l.pct === null ? '<span class="sem-dado">sem ANP</span>'
        : fora && l.pct > 0 ? '<span class="sit sit-ruim" title="ANP acima da variação do contrato">▲ Acima da variação</span>'
          : fora ? '<span class="sit sit-livre" title="ANP abaixo da variação do contrato">▼ Abaixo da variação</span>'
            : '<span class="sit sit-ok" title="ANP dentro da variação do contrato">Dentro da variação</span>';
      return '<tr data-unidade="' + esc(l.unidade) + '" tabindex="0"' + (l.unidade === estado.sel ? ' class="selecionado"' : '') + '>' + COLUNAS.map((col) => {
        if (col.id === 'unidade') return '<td><strong>' + esc(l.unidade) + '</strong><small class="cidade-linha">' + esc(l.produto) + (l.observacao ? ' · ' + esc(l.observacao) : '') + '</small></td>';
        if (col.id === 'uf') return '<td>' + esc(NOME_UF[l.uf]) + '</td>';
        const v = col.v(l);
        const extra = col.id === 'atual' && l.atual && l.atual.semana !== estado.semana ? '<small class="cidade-linha">semana de ' + esc(fmtDia(l.atual.semana).slice(0, 5)) + '</small>' : '';
        return '<td class="n' + (['dif', 'pct'].includes(col.id) && v !== null ? tom : '') + '">' + esc(col.f(v)) + extra + '</td>';
      }).join('') + '<td>' + sit + '</td>' + (podeEditar ? '<td class="nt-col-acoes"><div class="nt-acoes">' +
        '<button type="button" class="btn-lixeira btn-editar" data-editar="' + l.id + '" aria-label="Editar o contrato de ' + esc(l.unidade) + '" title="Editar"><svg aria-hidden="true"><use href="#i-lapis"/></svg></button>' +
        '<button type="button" class="btn-lixeira" data-excluir="' + l.id + '" aria-label="Excluir o contrato de ' + esc(l.unidade) + '" title="Excluir"><svg aria-hidden="true"><use href="#i-lixeira"/></svg></button></div></td>' : '') + '</tr>';
    }).join('') : '<tr><td colspan="' + (COLUNAS.length + 2) + '"><div class="vazio">Nenhum contrato cadastrado.' + (podeEditar ? ' Use "Adicionar contrato".' : '') + '</div></td></tr>') + '</tbody>';

    desenharGrafico(ls.find((l) => l.unidade === estado.sel));
    el('ct-fonte').innerHTML = 'ANP: preço médio de revenda do óleo diesel S10 do estado, Levantamento de Preços de Combustíveis.';
    ctx.definirSub('ANP semanal do estado de referência de cada unidade contra a ANP da semana do contrato.');
  }

  function desenharGrafico(l) {
    if (!l) { el('ct-grafico').innerHTML = '<div class="vazio">Nenhum contrato.</div>'; el('ct-grafico-titulo').textContent = 'Evolução'; return; }
    const ini = semana(l.dia) - SEMANAS_ANTES * 7, ref = l.naBase ? l.naBase.v : null;
    const pts = semanas.filter((p) => p >= ini && p <= estado.semana).map((p) => {
      const x = porEstado.get(l.uf + '|' + p);
      const vigente = ref !== null && p >= semana(l.dia);
      return { rotulo: fmtDia(p).slice(0, 5), rotuloLongo: 'Semana de ' + rotSemana(p), anp: x ? x.v : null, x,
        contrato: vigente ? ref : null, teto: vigente ? ref * (1 + GATILHO) : null, piso: vigente ? ref * (1 - GATILHO) : null };
    });
    el('ct-grafico-titulo').textContent = l.unidade + ': ANP de ' + NOME_UF[l.uf] + ' contra a da semana do contrato (' + rs(ref) + ' em ' + fmtDia(l.dia) + ')';
    graficoPeriodo(el('ct-grafico'), pts, {
      linhas: [
        { campo: 'teto', rot: '+' + fmt.pct(GATILHO), cor: 'var(--ruim)', tracejada: true },
        { campo: 'piso', rot: '−' + fmt.pct(GATILHO), cor: 'var(--eixo)', tracejada: true },
        { campo: 'contrato', rot: 'ANP na data do contrato', cor: 'var(--tinta-2)', tracejada: true },
        { campo: 'anp', rot: 'ANP ' + l.uf, cor: 'var(--serie-1)' },
      ],
      fmtV: rs, fmtEixo: fmt.d2,
      extras: (p) => (p.x ? [['Variação contra a data do contrato', ref ? sinal(p.x.v / ref - 1, fmt.pct) : '—'], ['ANP mín. – máx.', (p.x.mn ? fmt.d3(p.x.mn) : '—') + ' – ' + (p.x.mx ? fmt.d3(p.x.mx) : '—')]] : []),
      rotulo: 'ANP semanal do estado de referência e ANP da semana do contrato de ' + l.unidade,
    });
  }

  const atualizar = agendador(desenhar);
  el('ct-semana').addEventListener('change', (e) => { estado.semana = Number(e.target.value); atualizar(); });
  el('ct-tabela').addEventListener('click', (e) => {
    const col = e.target.closest('[data-col]');
    if (col) {
      const id = col.dataset.col;
      estado.ordem = estado.ordem.col === id ? { col: id, dir: -estado.ordem.dir } : { col: id, dir: ['unidade', 'uf'].includes(id) ? 1 : -1 };
      atualizar();
      return;
    }
    const ed = e.target.closest('[data-editar]'), ex = e.target.closest('[data-excluir]');
    if (ed) { abrirContrato(contratos.find((c) => c.id === Number(ed.dataset.editar))); return; }
    if (ex) { excluirContrato(contratos.find((c) => c.id === Number(ex.dataset.excluir))); return; }
    const tr = e.target.closest('[data-unidade]');
    if (tr) { estado.sel = tr.dataset.unidade; atualizar(); }
  });
  // ---------- cadastro dos contratos ----------
  const form = el('ct-form');
  let editando = null;
  // unidade (praça) e produto: a lista configurada na engrenagem ou os valores que já existem nos contratos
  let opc = { opcoes: {}, podeEditar: false };
  carregarOpcoes('contratos-anp').then((o) => { opc = o; });
  const existentes = (campo) => [...new Set(contratos.map((c) => String(c[campo] || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const listaDe = (campo) => listaEfetiva(opc, campo, existentes(campo));
  const encherListas = () => ['unidade', 'produto'].forEach((c) => { el('ct-sug-' + c).innerHTML = listaDe(c).map((v) => '<option value="' + esc(v) + '">').join(''); });
  form.addEventListener('click', (e) => {
    if (!e.target.closest('[data-opcoes]')) return;
    abrirOpcoes({ tela: 'contratos-anp', titulo: 'Opções do cadastro de contratos', podeEditar: opc.podeEditar,
      campos: [{ id: 'unidade', rotulo: 'Unidades (praças dos contratos)', valores: listaDe('unidade'), configurado: temConfig(opc, 'unidade') },
        { id: 'produto', rotulo: 'Produtos', valores: listaDe('produto'), configurado: temConfig(opc, 'produto') },
        { id: 'uf', rotulo: 'Estados de referência da ANP', valores: Object.values(NOME_UF), fixo: true, explica: 'Os estados da pesquisa da ANP: não mudam.' }],
      aoSalvar: (novos) => { opc = { ...opc, opcoes: { ...opc.opcoes, ...novos } }; encherListas(); } });
  });
  const anpDoForm = () => {
    const d = form.data_contrato.value, uf = form.uf.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { el('ct-dlg-anp').textContent = ''; return; }
    const x = anpEm(uf, semana(diaIso(d)));
    el('ct-dlg-anp').textContent = x ? 'ANP de ' + NOME_UF[uf] + ' na semana de ' + rotSemana(x.semana) + ': ' + rs(x.v) + ' (é a referência deste contrato).'
      : 'A ANP não tem preço de ' + NOME_UF[uf] + ' nessa semana: a variação fica sem referência.';
  };
  function abrirContrato(c) {
    editando = c || null;
    el('ct-dlg-titulo').textContent = c ? 'Editar contrato' : 'Adicionar contrato';
    form.unidade.value = c ? c.unidade : ''; form.uf.value = c ? c.uf : 'BA'; form.data_contrato.value = c ? c.data_contrato : '';
    form.produto.value = c ? c.produto : 'OLEO DIESEL S10'; form.observacao.value = c ? c.observacao || '' : '';
    el('ct-erro').classList.add('oculto');
    anpDoForm();
    encherListas();
    el('ct-dlg').showModal();
    form.unidade.focus();
  }
  async function enviar(corpo) {
    const r = await fetch('/api/contratos-anp', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    if (r.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || 'Não foi possível gravar (' + r.status + ').');
    return j;
  }
  async function excluirContrato(c) {
    if (!c || !(await confirmar('Excluir o contrato de ' + c.unidade + '? Ele sai desta tela para todos.'))) return;
    try { await enviar({ acao: 'excluir', id: c.id }); contratos = contratos.filter((x) => x.id !== c.id); atualizar(); ctx.aviso('Contrato excluído.'); }
    catch (err) { if (err.message !== 'sessão') ctx.aviso(err.message); }
  }
  el('ct-novo').addEventListener('click', () => abrirContrato(null));
  el('ct-cancelar').addEventListener('click', () => el('ct-dlg').close());
  form.addEventListener('input', anpDoForm);
  form.addEventListener('change', anpDoForm);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = el('ct-salvar');
    b.disabled = true; b.textContent = 'Salvando…';
    try {
      const j = await enviar({ acao: 'salvar', id: editando ? editando.id : undefined, unidade: form.unidade.value, uf: form.uf.value,
        data_contrato: form.data_contrato.value, produto: form.produto.value, observacao: form.observacao.value, ativo: true });
      contratos = editando ? contratos.map((x) => (x.id === j.contrato.id ? j.contrato : x)) : [...contratos, j.contrato];
      estado.sel = j.contrato.unidade;
      el('ct-dlg').close();
      atualizar();
      ctx.aviso('Contrato de ' + j.contrato.unidade + ' salvo.');
    } catch (err) {
      if (err.message !== 'sessão') { el('ct-erro').textContent = err.message; el('ct-erro').classList.remove('oculto'); }
    } finally { b.disabled = false; b.textContent = 'Salvar'; }
  });
  el('ct-tabela').addEventListener('keydown', (e) => {
    const tr = e.target.closest('[data-unidade]');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); estado.sel = tr.dataset.unidade; atualizar(); }
  });
  window.addEventListener('resize', atualizar);
  // botão Atualizar da barra: busca a ANP e os contratos de novo
  const aoAtualizarDados = () => carregar().then(() => { usarANP(); atualizar(); }).catch(() => {});
  window.addEventListener('dados-atualizados', aoAtualizarDados);
  atualizar();
  return {
    desmontar() {
      window.removeEventListener('resize', atualizar);
      window.removeEventListener('dados-atualizados', aoAtualizarDados);
    },
  };
}
