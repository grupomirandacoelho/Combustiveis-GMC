// Dashboard "Real x Orçado": réplica do painel "Combustível, Arla & KM — Real × Orçado" (pasta Claude,
// dashboard_frota.html), com as mesmas regras do dashboard_frota_refresh.py:
//  Custos  - real: transações com SERVICO "Abastecimento" e INFORMACAO ADIDIONAL 3 de uma das unidades da aba BD_UND
//            do orçamento; Arla = tipo com "ARLA"; Combustível = tipo com "DIESEL" (todas as variantes); KM = km rodado
//            das linhas de diesel. Orçado: aba Base_Metas (COMBUSTIVEL CAMINHAO, ARLA, KM) da Banco_Orçamento_Despesas_Frota.
//  Consumo - só diesel e "Abastecimento", veículos da aba Metas (menos a categoria VENDA). Centro de custo = INF. ADICIONAL 3
//            da transação. Média = km ÷ litros; meta média ponderada pelos litros; economia = km ÷ meta − litros (por placa).
import { carregarDados, recarregarDados, fmt, esc, fmtMes, mesDoDia, fmtDia, inicioDoMes, diaParaData } from '../lib/dados.js';
import { carregarSheetJS } from '../lib/sheetjs.js';
import { confirmar } from '../lib/confirmar.js';
import { lerOrcamento } from '../lib/orcamento.js';
import { criarFiltros, statusHtml, agendador, ICONES } from '../lib/filtros.js';
import { graficoPeriodo } from '../lib/graficos.js';
import { pesosSemana, fracaoDoMes } from '../lib/esperado.js';

const ROTA = '#/real-orcado';
const DIAS_GRAFICO_DIARIO = 100;
const CATS = [
  { id: 'combustivel', titulo: 'Combustível (diesel)', nat: 'COMBUSTIVEL CAMINHAO', dinheiro: true, direcao: 'custo' },
  { id: 'arla', titulo: 'Arla 32', nat: 'ARLA', dinheiro: true, direcao: 'custo' },
  { id: 'km', titulo: 'KM rodado', nat: 'KM', dinheiro: false, direcao: 'volume' },
];
const MESES_LONGOS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const tem = (v) => v !== null && v !== undefined && isFinite(v);
const fReal0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const brl = (v) => (tem(v) ? fReal0.format(v) : '—');
const brlKm = (v) => (tem(v) ? fmt.moeda(v) : '—');
const curto = (c) => (v) => (tem(v) ? (c.dinheiro ? 'R$ ' : '') + fmt.curto(v) : '—');
const rotuloColuna = (v) => (tem(v) ? fmt.curto(v) : '');   // em cima das colunas: sem "R$" (o eixo já diz)
const fmtCat = (c) => (c.dinheiro ? brl : fmt.int);
// eixo vertical curto (cabe na margem do gráfico): 3 mi, 1,5 mi, 800 mil; a unidade está no título do painel
const eixoCat = () => (v) => {
  const a = Math.abs(v);
  if (a >= 1e6) return fmt.d1(v / 1e6).replace(/,0$/, '') + ' mi';
  if (a >= 1e3) return fmt.int(v / 1e3) + ' mil';
  return fmt.int(v);
};
const variacao = (real, plan) => (tem(real) && tem(plan) && plan !== 0 ? (real - plan) / plan : null);
const txtVar = (v) => (v === null ? '—' : (v > 0 ? '+' : '') + fmt.pct(v));
// custo (combustível, arla, R$/km): ficar acima do orçado é ruim; volume (km): ficar abaixo é ruim
const bomVar = (v, direcao) => (direcao === 'volume' ? v >= 0 : v <= 0);
// seta pelo sinal (▲ subiu, ▼ caiu) e cor pelo efeito (verde bom, vermelho ruim), como no painel original
const sinal = (v, bom, texto) => '<span class="status ' + (bom ? 'bom' : 'ruim') + '">' + (v > 0 ? ICONES.cima : ICONES.baixo) + esc(texto) + '</span>';
const htmlVar = (v, direcao) => (v === null ? '<span class="sem-dado">—</span>' : sinal(v, bomVar(v, direcao), txtVar(v)));
const ymParaMes = (s) => { const [a, m] = String(s).split('-').map(Number); return a * 12 + m - 1; };
const mesParaYm = (m) => Math.floor(m / 12) + '-' + String((m % 12) + 1).padStart(2, '0');
const ano = (m) => Math.floor(m / 12);
const ehDiesel = (c) => String(c || '').includes('DIESEL');
const ehArla = (c) => String(c || '').includes('ARLA');
const cmp = (a, b) => String(a).localeCompare(String(b), 'pt-BR', { numeric: true, sensitivity: 'base' });

// ---------- modelo: real e orçado por filial × mês ----------
function prepararCustos(d) {
  const orc = d.orcamento;
  if (!orc || !orc.linhas || !orc.linhas.length) return null;
  const inf2und = new Map(orc.unidades.map(([u, inf]) => [inf, u]));
  const unidades = [...new Set(orc.unidades.length ? orc.unidades.map((u) => u[0]) : orc.linhas.map((l) => l[0]))].sort(cmp);
  const natCat = Object.fromEntries(CATS.map((c) => [c.nat, c.id]));
  const plan = new Map();
  for (const [u, nat, ym, v] of orc.linhas) {
    const c = natCat[nat];
    if (!c) continue;
    const k = u + '|' + ymParaMes(ym);
    const e = plan.get(k) || { combustivel: 0, arla: 0, km: 0 };
    e[c] += v;
    plan.set(k, e);
  }
  const real = new Map(), linhasFilial = [];
  for (const l of d.linhas) {
    if (!l.abastecimento) continue;
    const u = inf2und.get(l.cc3);
    if (!u) continue;
    const arla = ehArla(l.combustivel), diesel = !arla && ehDiesel(l.combustivel);
    if (!arla && !diesel) continue;
    const k = u + '|' + mesDoDia(l.dia);
    const e = real.get(k) || { combustivel: 0, arla: 0, km: 0 };
    if (arla) e.arla += l.despesa; else { e.combustivel += l.despesa; e.km += l.km || 0; }
    real.set(k, e);
    linhasFilial.push({ filial: u, dia: l.dia });
  }
  const mesesPlan = [...plan.keys()].map((k) => Number(k.split('|')[1]));
  const minPlan = Math.min(...mesesPlan);
  const meses = [...new Set([...mesesPlan, ...[...real.keys()].map((k) => Number(k.split('|')[1]))])].filter((m) => m >= minPlan).sort((a, b) => a - b);
  const mesParcial = mesDoDia(d.diaMax);
  const dt = diaParaData(d.diaMax);
  const diaCorte = dt.getUTCDate(), diasNoMes = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  // fração do mês já vencida pelo peso de cada dia da semana (gasto de diesel e Arla das 12 semanas antes do mês), não por
  // dias corridos: 9 dias de um mês que começa no domingo com feriado não são 9/30 do gasto (10/11/2026)
  const iniMes = inicioDoMes(mesParcial), fimMes = inicioDoMes(mesParcial + 1) - 1;
  const pesos = pesosSemana(d.linhas.filter((l) => l.abastecimento && (ehArla(l.combustivel) || ehDiesel(l.combustivel))), iniMes, (l) => l.despesa);
  const fracao = fracaoDoMes(pesos, iniMes, d.diaMax, fimMes);
  return { unidades, plan, real, meses, mesParcial, diaCorte, diasNoMes, fracao, linhasFilial, arquivo: orc.arquivo };
}

// consumo: agrega por placa (a meta é da placa) e soma
function agregar(ls) {
  const porPlaca = new Map();
  for (const l of ls) {
    let a = porPlaca.get(l.placa);
    if (!a) porPlaca.set(l.placa, (a = { km: 0, lit: 0, meta: l.meta }));
    a.km += l.km; a.lit += l.litros;
  }
  let km = 0, lit = 0, num = 0, den = 0, eco = 0, temEco = false;
  for (const a of porPlaca.values()) {
    km += a.km; lit += a.lit;
    if (a.meta) { num += a.meta * a.lit; den += a.lit; eco += a.km / a.meta - a.lit; temEco = true; }
  }
  return { km, lit, media: lit > 0 ? km / lit : null, metaMedia: den > 0 ? num / den : null, economia: temEco ? eco : null, porPlaca };
}
// os 5 melhores motoristas (km/L) de um grupo de abastecimentos: dica dos gráficos do consumo
function melhoresMotoristas(ls, n = 5) {
  const m = new Map();
  for (const l of ls) { const a = m.get(l.motorista) || { km: 0, lit: 0 }; a.km += l.km; a.lit += l.litros; m.set(l.motorista, a); }
  return [...m.entries()].map(([nome, a]) => ({ nome, media: a.lit > 0 ? a.km / a.lit : 0 })).filter((x) => x.media > 0)
    .sort((a, b) => b.media - a.media).slice(0, n);
}

// barras horizontais (por filial / centro de custo): duas barras por linha, clicáveis
function htmlBarras(linhas, o) {
  if (!linhas.length) return '<div class="vazio">Nenhum dado neste recorte.</div>';
  const max = Math.max(1e-9, ...linhas.flatMap((x) => [x.a || 0, x.b || 0]));
  const pct = (v) => (tem(v) && v > 0 ? Math.max(0.5, (v / max) * 100) : 0);
  return linhas.map((x) =>
    '<button type="button" class="ro-barra' + (x.apagada ? ' apagada' : '') + '" data-valor="' + esc(x.nome) + '" aria-pressed="' + !!x.selecionada + '"' +
      ' title="' + esc(x.dica) + '">' +
      '<span class="ro-barra-nome">' + esc(x.nome) + '</span>' +
      '<span class="ro-barra-trilhos"><span class="ro-trilho"><i class="ro-a" style="width:' + pct(x.a) + '%"></i></span>' +
        '<span class="ro-trilho"><i class="ro-b" style="width:' + pct(x.b) + '%"></i></span></span>' +
      '<span class="ro-barra-val num">' + esc(o.fmt(x.a)) + '<small>' + esc(o.fmt(x.b)) + '</small></span>' +
    '</button>').join('');
}

// clique normal: mostra só aquele item (de novo: volta a todos); Ctrl/Cmd+clique: soma ou tira da seleção
function selecionar(sel, valor, somar, todos) {
  if (somar) {
    if (!sel.size) todos.forEach((x) => sel.add(x));
    if (sel.has(valor)) sel.delete(valor); else sel.add(valor);
    if (sel.size === todos.length) sel.clear();
  } else {
    const so = sel.size === 1 && sel.has(valor);
    sel.clear();
    if (!so) sel.add(valor);
  }
}

function kpi(rotulo, valor, sub, extra) {
  return '<div class="ro-kpi"><div class="ro-kpi-rot">' + esc(rotulo) + '</div><div class="ro-kpi-num num">' + esc(valor) + '</div>' +
    (sub ? '<div class="ro-kpi-sub">' + sub + '</div>' : '') + (extra || '') + '</div>';
}

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando os abastecimentos e o orçamento…</div>';
  let dados;
  try { dados = await carregarDados(); } catch (e) {
    pagina.innerHTML = '<div class="vazio">' + esc(e.message) + ' Recarregue a página para tentar de novo.</div>';
    return {};
  }
  let M = null;   // real e orçado por filial
  let C = null;   // linhas do consumo
  function usarDados(d) {
    dados = d;
    M = prepararCustos(d);
    C = d.linhas.filter((l) => l.abastecimento && ehDiesel(l.combustivel) && d.veiculos[l.placa] && d.veiculos[l.placa].categoria !== 'VENDA')
      .map((l) => Object.assign(Object.create(l), { _cc: l.cc3 || '(sem unidade)', _cat: l.categoria || '(sem categoria)' }));
    const g = new Date(d.geradoEm);
    ctx.definirSub('Dados reais até ' + fmtDia(d.diaMax) + ' (mês ' + fmtMes(mesDoDia(d.diaMax)) + ' parcial). Base enviada em ' + g.toLocaleDateString('pt-BR') +
      ' às ' + g.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + (M ? '. Orçamento: ' + M.arquivo + '.' : '.'));
  }
  usarDados(dados);

  const q0 = new URLSearchParams(location.hash.split('?')[1] || '');
  pagina.innerHTML =
    '<div class="segmentado ro-visoes" role="group" aria-label="Visão do painel">' +
      '<button type="button" data-visao="custos">Custos (real × orçado)</button>' +
      '<button type="button" data-visao="consumo">Consumo (km/L)</button>' +
    '</div><div class="ro-orc" id="ro-orc"></div><div id="ro-corpo"></div>';
  const corpo = pagina.querySelector('#ro-corpo');
  let visao = null, atual = null;
  function abrir(v, inicial) {
    if (atual) atual.desmontar();
    visao = v;
    pagina.querySelectorAll('[data-visao]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.visao === v)));
    if (!inicial) history.replaceState(null, '', ROTA + '?visao=' + v + (v === 'consumo' ? '&periodo=ano' : ''));
    else if (v === 'consumo' && ![...q0.keys()].some((k) => k !== 'visao')) history.replaceState(null, '', ROTA + '?visao=consumo&periodo=ano');
    atual = v === 'custos' ? montarCustos() : montarConsumo();
  }
  // orçamento: último envio e, para quem pode, o envio da planilha (15.3, 25/11/2026: o orçamento continua no Excel e vai ao banco
  // por aqui; o portal lê a planilha no navegador e o banco troca o orçamento inteiro)
  const caixaOrc = pagina.querySelector('#ro-orc');
  function mostrarEnvio(info) {
    const e = info && info.envio;
    const quando = e && e.em ? new Date(e.em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '';
    caixaOrc.innerHTML = '<span class="ro-orc-info">' + (e && e.usuario ? 'Orçamento enviado por ' + esc(e.usuario) + ' em ' + esc(quando) +
      ' (' + esc(e.arquivo || '') + ')' : (M ? 'Orçamento: ' + esc(M.arquivo || '') : '')) + '</span>' +
      (info && info.podeEnviar ? '<button type="button" class="btn" id="ro-orc-enviar">Enviar planilha do orçamento</button><input type="file" id="ro-orc-arquivo" accept=".xlsx,.xlsm,.xls" hidden>' : '');
    const bt = caixaOrc.querySelector('#ro-orc-enviar'), arq = caixaOrc.querySelector('#ro-orc-arquivo');
    if (!bt) return;
    bt.addEventListener('click', () => arq.click());
    arq.addEventListener('change', async () => {
      const f = arq.files[0];
      arq.value = '';
      if (f) await enviarOrcamento(f, bt);
    });
  }
  const mesAno = (m) => m.slice(5, 7) + '/' + m.slice(0, 4);   // 'AAAA-MM' -> 'MM/AAAA'
  async function enviarOrcamento(f, bt) {
    bt.disabled = true;
    try {
      const XLSX = await carregarSheetJS();
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true });
      const aba = (nome) => {
        const n = wb.SheetNames.find((x) => x.trim().toUpperCase() === nome.toUpperCase());
        return n ? XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }) : null;
      };
      const o = lerOrcamento({ baseMetas: aba('Base_Metas'), bdUnd: aba('BD_UND') });
      if (o.erro) { ctx.aviso(o.erro); return; }
      const r = o.resumo;
      const nat = Object.entries(r.porNatureza).sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([n, v]) => n + ' ' + (n === 'KM' ? fmt.int(v) : brl(v))).join('; ');
      const texto = 'Trocar o orçamento do portal pelo da planilha "' + f.name + '"? ' + r.linhas + ' linhas de ' + r.unidades + ' unidades, de ' +
        mesAno(r.mesInicio) + ' a ' + mesAno(r.mesFim) + '. Totais: ' + nat + '.' +
        (o.ignoradas.length ? ' ' + o.ignoradas.length + ' linha(s) incompleta(s) ficam de fora (ex.: linha ' + o.ignoradas.slice(0, 3).join(', ') + ').' : '');
      if (!(await confirmar(texto, { titulo: 'Enviar orçamento', ok: 'Enviar' }))) return;
      const resp = await fetch('/api/orcamento', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arquivo: f.name, metas: o.metas, unidades: o.unidades }) });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) { ctx.aviso(j.erro || 'Não foi possível enviar o orçamento (' + resp.status + ').'); return; }
      ctx.aviso('Orçamento enviado: ' + j.metas + ' linhas e ' + j.unidades + ' unidades. Atualizando o painel…');
      usarDados(await recarregarDados());
      abrir(visao, false);
      carregarEnvio();
    } catch (e) {
      ctx.aviso('Não foi possível ler a planilha: ' + (e && e.message ? e.message : e));
    } finally { bt.disabled = false; }
  }
  function carregarEnvio() {
    fetch('/api/orcamento', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then(mostrarEnvio);
  }
  carregarEnvio();

  pagina.querySelector('.ro-visoes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-visao]');
    if (b && b.dataset.visao !== visao) abrir(b.dataset.visao, false);
  });

  // ======================================================================== CUSTOS
  function montarCustos() {
    if (!M) {
      corpo.innerHTML = '<div class="vazio"><strong>O orçamento ainda não chegou ao site.</strong> Ele vem da planilha Banco_Orçamento_Despesas_Frota ' +
        '(pasta Dashboars Logística) junto com a próxima carga da Base. Use o botão Atualizar quando a Base for enviada.</div>';
      return { desmontar() {}, redesenhar() {} };
    }
    const anoAtual = ano(M.mesParcial);
    const JANELAS = [['3m', '3M'], ['6m', '6M'], ['12m', '12M'], ['ano-' + (anoAtual - 1), 'Ano ' + (anoAtual - 1)], ['ano-' + anoAtual, 'Ano ' + anoAtual], ['tudo', 'Tudo']];
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    const est = {
      janela: JANELAS.some(([k]) => k === q.get('janela')) ? q.get('janela') : '12m',
      meses: q.get('mes') ? new Set(q.get('mes').split(',').filter((s) => /^\d{4}-\d{2}$/.test(s)).map(ymParaMes)) : null,
      comparar: q.get('comparar') === '1',
    };
    if (est.meses && !est.meses.size) est.meses = null;
    let ordem = { campo: 'comb_var', dir: -1 };

    corpo.innerHTML = `
      <div class="grupo-filtros">
      <section class="filtros" id="ro-filtros" aria-label="Filtros"></section>
      <div class="ro-periodo">
        <span class="filtro-rotulo">Período</span>
        <div class="segmentado segmentado-quebra" id="ro-janelas" role="group" aria-label="Período">
          ${JANELAS.map(([k, r]) => '<button type="button" data-janela="' + k + '">' + esc(r) + '</button>').join('')}
        </div>
        <label class="ro-comparar"><input type="checkbox" id="ro-comparar"> Comparar com ${anoAtual - 1}</label>
      </div>
      </div>
      <div class="chips" id="ro-chips" aria-live="polite"></div>
      <p class="nota ro-dica" id="ro-dica"></p>
      <section class="ro-kpis" id="ro-kpis" aria-label="Resumo do período"></section>
      ${CATS.map((c) => `<section class="painel ro-painel" aria-labelledby="ro-t-${c.id}">
        <div class="painel-cab"><h2 id="ro-t-${c.id}">${esc(c.titulo)} <small class="ro-unidade">${c.dinheiro ? 'R$' : 'km'}</small></h2><div class="legenda" id="ro-leg-${c.id}"></div></div>
        <div class="ro-par">
          <div class="ro-par-a">
            <p class="ro-subtitulo" id="ro-st-${c.id}"></p>
            <div class="grafico" id="ro-g-${c.id}"></div>
            <p class="nota ro-ritmo" id="ro-r-${c.id}"></p>
          </div>
          <div class="ro-par-b">
            <p class="ro-subtitulo">Por filial · clique para focar (Ctrl+clique soma)</p>
            <div class="ro-legenda-barras"><span><i class="ro-a"></i>Real</span><span><i class="ro-b"></i>Orçado</span></div>
            <div class="ro-barras" id="ro-b-${c.id}"></div>
          </div>
        </div>
      </section>`).join('')}
      <section class="painel painel-tabela">
        <div class="painel-cab"><h2>Detalhe por filial</h2><span class="conta" id="ro-tab-periodo"></span></div>
        <div class="tabela-rolagem"><table class="dados ro-tabela" id="ro-tabela"></table></div>
      </section>
      <details class="nota nota-mais"><summary>Como é calculado</summary>Cobre as filiais com orçamento na planilha Banco_Orçamento_Despesas_Frota (aba BD_UND). Unidades administrativas e de retirada
        (ADM, Diretoria, Fazenda, Kemigas, retiradas) não têm orçamento próprio e ficam fora deste comparativo. Combustível considera os abastecimentos de diesel
        (todas as variantes); Arla considera Arla 32; KM é o km rodado registrado em cada abastecimento de diesel. A filial de cada abastecimento é a
        Informação Adicional 3 da transação. O mês corrente é parcial: reflete só os abastecimentos já lançados até a data de corte; o "ritmo esperado"
        é o orçado do mês × dias corridos ÷ dias do mês.</details>`;
    const el = (id) => corpo.querySelector('#' + id);

    const filtros = criarFiltros({
      dimensoes: [{ id: 'filial', rotulo: 'Filiais', valor: (l) => l.filial }],
      filtrosEl: el('ro-filtros'), chipsEl: el('ro-chips'), rota: ROTA,
      obterBase: () => M.linhasFilial, obterLimites: () => [dados.diaMin, dados.diaMax], aoMudar: () => atualizar(), prefixo: 'ro',
      extrasURL: () => ({ visao: 'custos', janela: est.janela === '12m' ? '' : est.janela, mes: est.meses ? [...est.meses].sort((a, b) => a - b).map(mesParaYm).join(',') : '', comparar: est.comparar ? '1' : '' }),
    });
    const unidadesSel = () => (filtros.sel.filial.size ? M.unidades.filter((u) => filtros.sel.filial.has(u)) : M.unidades);

    function valor(u, m, cat, campo) {
      const e = (campo === 'real' ? M.real : M.plan).get(u + '|' + m);
      if (!e) return null;
      if (campo === 'real' && !(e.combustivel > 0 || e.arla > 0 || e.km > 0)) return null;
      return e[cat];
    }
    function soma(unids, meses, cat, campo) {
      let t = null;
      for (const u of unids) for (const m of meses) { const v = valor(u, m, cat, campo); if (v !== null) t = (t || 0) + v; }
      return t;
    }
    // meses do atalho de período (o que o gráfico mensal mostra; todos clicáveis)
    function universo() {
      const i = M.meses.indexOf(M.mesParcial), fim = i === -1 ? M.meses.length - 1 : i;
      const j = est.janela;
      if (/^\d+m$/.test(j)) return M.meses.slice(Math.max(0, fim - parseInt(j, 10) + 1), fim + 1);
      if (j.startsWith('ano-')) return M.meses.filter((m) => ano(m) === Number(j.slice(4)));
      return M.meses.slice();
    }
    // meses que entram nos números: o atalho recortado pelos meses clicados. Comparando com o ano anterior, vale o ano
    // atual até o mês de corte (os dois lados com o mesmo número de meses)
    function mesesPeriodo() {
      if (est.comparar) return M.meses.filter((m) => ano(m) === anoAtual && m <= M.mesParcial);
      const u = universo();
      return est.meses ? u.filter((m) => est.meses.has(m)) : u;
    }
    const anteriores = (ms) => ms.map((m) => m - 12).filter((m) => M.meses.includes(m));
    function selecionarMes(m, somar) {
      selecionar(est.meses || (est.meses = new Set()), m, somar, universo());
      if (!est.meses.size) est.meses = null;
      atualizar();
    }

    function desenharTopo() {
      corpo.querySelectorAll('[data-janela]').forEach((b) => {
        b.setAttribute('aria-pressed', String(!est.comparar && b.dataset.janela === est.janela));
        b.disabled = est.comparar;
      });
      el('ro-comparar').checked = est.comparar;
      const ms = mesesPeriodo(), un = unidadesSel();
      let periodo;
      if (est.comparar) periodo = esc(ms.length ? 'comparando ' + fmtMes(ms[0]) + ' a ' + fmtMes(ms[ms.length - 1]) + ' com o mesmo período de ' + (anoAtual - 1) : '—');
      else if (est.meses) periodo = esc(ms.length <= 4 ? ms.map((m) => fmtMes(m)).join(', ') : ms.length + ' meses selecionados (' + fmtMes(ms[0]) + ' a ' + fmtMes(ms[ms.length - 1]) + ')') +
        ' · <button type="button" class="link-acao" id="ro-limpar-meses">limpar seleção de meses</button>';
      else periodo = esc(ms.length ? ms.length + (ms.length === 1 ? ' mês: ' : ' meses: ') + fmtMes(ms[0]) + ' a ' + fmtMes(ms[ms.length - 1]) : '—');
      el('ro-dica').innerHTML = esc(un.length + ' de ' + M.unidades.length + ' filiais') + ' · ' + periodo;

      const ant = est.comparar ? anteriores(ms) : [];
      const tot = {};
      for (const c of CATS) {
        tot[c.id] = { r: soma(un, ms, c.id, 'real'), p: soma(un, ms, c.id, 'plan'), ra: soma(un, ant, c.id, 'real'), pa: soma(un, ant, c.id, 'plan') };
        // mês em andamento no período: o real vai até hoje e o orçado é do mês inteiro; a comparação justa é com o ritmo
        // esperado (orçado do mês parcial × fração já vencida pelo peso dos dias da semana). O real atual continua no cartão.
        const pParcial = ms.includes(M.mesParcial) ? soma(un, [M.mesParcial], c.id, 'plan') : null;
        tot[c.id].ritmo = pParcial !== null && tot[c.id].p !== null ? tot[c.id].p - pParcial * (1 - M.fracao) : null;
        // comparativo anual: o mesmo mês do ano anterior entra só com a mesma fração (senão o mês parcial perde para um mês inteiro)
        if (est.comparar && ms.includes(M.mesParcial) && ant.includes(M.mesParcial - 12)) {
          const corta = (v, campo) => { const x = soma(un, [M.mesParcial - 12], c.id, campo); return v === null || x === null ? v : v - x * (1 - M.fracao); };
          tot[c.id].ra = corta(tot[c.id].ra, 'real'); tot[c.id].pa = corta(tot[c.id].pa, 'plan');
        }
      }
      const div = (a, b) => (tem(a) && b ? a / b : null);
      tot.custoKm = { r: div(tot.combustivel.r, tot.km.r), p: div(tot.combustivel.p, tot.km.p), ra: div(tot.combustivel.ra, tot.km.ra), pa: div(tot.combustivel.pa, tot.km.pa) };   // razão: não precisa de ritmo
      const cartao = (rot, t, f, direcao) => {
        const comRitmo = t.ritmo !== null && t.ritmo !== undefined;
        const v = variacao(t.r, comRitmo ? t.ritmo : t.p);
        const pct = t.p ? Math.min(100, Math.max(0, ((t.r || 0) / t.p) * 100)) : 0;
        let yoy = '';
        if (est.comparar) {
          const vAnt = variacao(t.ra, t.pa), cresc = variacao(t.r, t.ra);
          yoy = '<div class="ro-kpi-sub">' + (anoAtual - 1) + ': real <span class="num">' + esc(f(t.ra)) + '</span> · orçado <span class="num">' + esc(f(t.pa)) + '</span></div>' +
            '<div class="ro-kpi-sub ro-kpi-yoy"><span>' + (anoAtual - 1) + ' vs orçado: ' + htmlVar(vAnt, direcao) + '</span>' +
            '<span>' + (anoAtual - 1) + '→' + anoAtual + ': ' + htmlVar(cresc, direcao) + '</span></div>';
        }
        return kpi(rot, f(t.r), 'Orçado: <span class="num">' + esc(f(t.p)) + '</span>' +
          (comRitmo ? '<br>Ritmo esperado até o dia ' + M.diaCorte + ': <span class="num">' + esc(f(t.ritmo)) + '</span>' : ''),
          yoy + '<div class="ro-kpi-var">' + (v === null ? '<span class="sem-dado">sem orçado no período</span>' : htmlVar(v, direcao) + ' <span class="ro-kpi-vs">' + (comRitmo ? 'vs ritmo esperado' : 'vs orçado') + '</span>') + '</div>' +
          // a barra tem a cor da variação (verde: dentro do esperado; vermelho: estourou o orçado ou ficou abaixo, conforme a direção)
          '<div class="ro-kpi-barra' + (v === null ? '' : bomVar(v, direcao) ? ' bom' : ' ruim') + '" title="' + esc(fmt.pct(t.p ? (t.r || 0) / t.p : null) + ' do orçado') + '"><i style="width:' + pct + '%"></i></div>');
      };
      el('ro-kpis').innerHTML =
        cartao('Combustível (diesel)', tot.combustivel, brl, 'custo') +
        cartao('Arla 32', tot.arla, brl, 'custo') +
        cartao('KM rodado', tot.km, fmt.int, 'volume') +
        cartao('Custo por km (diesel)', tot.custoKm, brlKm, 'custo');
    }

    function desenharTendencia(c) {
      const box = el('ro-g-' + c.id), un = unidadesSel(), f = fmtCat(c);
      if (est.comparar) {
        el('ro-st-' + c.id).textContent = 'Comparativo anual: real ' + (anoAtual - 1) + ' × ' + anoAtual;
        el('ro-leg-' + c.id).innerHTML = '<span><i class="leg-barra"></i>Real ' + anoAtual + '</span><span><i class="leg-contexto"></i>Real ' + (anoAtual - 1) + '</span>' +
          '<span><i class="leg-tracejada"></i>Orçado ' + anoAtual + '</span>';
        const pts = MESES_CURTOS.map((r, i) => ({
          rotulo: r, rotuloLongo: MESES_LONGOS[i],
          atual: soma(un, [anoAtual * 12 + i], c.id, 'real'), anterior: soma(un, [(anoAtual - 1) * 12 + i], c.id, 'real'),
          orcAtual: soma(un, [anoAtual * 12 + i], c.id, 'plan'), orcAnterior: soma(un, [(anoAtual - 1) * 12 + i], c.id, 'plan'),
        }));
        graficoPeriodo(box, pts, {
          barras: { campo: 'atual', rot: 'Real ' + anoAtual, cor: 'var(--serie-1)' },
          linhas: [{ campo: 'anterior', rot: 'Real ' + (anoAtual - 1), cor: 'var(--eixo)' },
            { campo: 'orcAtual', rot: 'Orçado ' + anoAtual, cor: 'var(--tinta-2)', tracejada: true },
            { campo: 'orcAnterior', rot: 'Orçado ' + (anoAtual - 1), cor: 'var(--eixo)', tracejada: true }],
          fmtV: f, fmtRotulo: rotuloColuna, fmtEixo: eixoCat(c), rotulo: c.titulo + ': real de ' + anoAtual + ' em colunas e ' + (anoAtual - 1) + ' em linha, por mês',
        });
        el('ro-r-' + c.id).textContent = '';
        return;
      }
      el('ro-st-' + c.id).textContent = 'Evolução mensal: real × orçado · clique num mês para filtrar (Ctrl+clique soma)';
      el('ro-leg-' + c.id).innerHTML = '<span><i class="leg-barra"></i>Real</span><span><i class="leg-meta"></i>Orçado</span>' +
        '<span><i class="ro-leg-ritmo"></i>Ritmo esperado</span>';
      const ms = universo();
      const pts = ms.map((m) => {
        const real = soma(un, [m], c.id, 'real'), plan = soma(un, [m], c.id, 'plan');
        return {
          mes: m, rotulo: fmtMes(m), rotuloLongo: fmtMes(m, true) + (m === M.mesParcial ? ' (mês parcial)' : ''),
          real, plan, ritmo: m === M.mesParcial && plan !== null ? plan * M.fracao : null,
        };
      });
      graficoPeriodo(box, pts, {
        barras: { campo: 'real', rot: 'Real', cor: 'var(--serie-1)' },
        linhas: [{ campo: 'plan', rot: 'Orçado', cor: 'var(--tinta-2)' },
          { campo: 'ritmo', rot: 'Ritmo esperado até o dia ' + M.diaCorte + ' (' + fmt.pct(M.fracao) + ' do orçado)', cor: 'var(--cat-2)' }],
        fmtV: f, fmtRotulo: rotuloColuna, fmtEixo: eixoCat(c),
        ultimoParcial: pts.length > 1 && pts[pts.length - 1].mes === M.mesParcial,
        destacar: est.meses ? (p) => est.meses.has(p.mes) : null,
        aoClicar: (p, e) => selecionarMes(p.mes, !!(e && (e.ctrlKey || e.metaKey))),
        rotulo: c.titulo + ': real em colunas e orçado em linha, por mês',
      });
      // ritmo do mês parcial: o real já está acima ou abaixo do que o orçado previa até hoje?
      const p = pts.find((x) => x.mes === M.mesParcial);
      const r = el('ro-r-' + c.id);
      if (p && p.ritmo !== null) {
        let html = esc('Ritmo esperado até o dia ' + M.diaCorte + ': ' + f(p.ritmo) + ' (' + fmt.pct(M.fracao) + ' do orçado do mês: o peso dos ' + M.diaCorte +
          ' primeiros dias pelo gasto de cada dia da semana nas 12 semanas anteriores; domingo pesa bem menos que terça).');
        if (p.real !== null) {
          const dif = p.real - p.ritmo, acima = dif > 0;
          const ruim = c.direcao === 'volume' ? !acima : acima;
          html += ' Real atual ' + sinal(dif, !ruim, (acima ? 'acima' : 'abaixo') + ' do ritmo') + ' em ' + esc(f(Math.abs(dif))) + '.';
        }
        r.innerHTML = html;
      } else r.textContent = '';
    }

    function desenharBarras(c) {
      const ms = mesesPeriodo(), sel = filtros.sel.filial, fl = fmtCat(c);
      const linhas = M.unidades.map((u) => {
        const a = soma([u], ms, c.id, 'real'), b = soma([u], ms, c.id, 'plan');
        return { nome: u, a, b, apagada: sel.size && !sel.has(u), selecionada: sel.has(u),
          dica: u + ' · real ' + fl(a) + ' · orçado ' + fl(b) + ' · ' + txtVar(variacao(a, b)) };
      });
      el('ro-b-' + c.id).innerHTML = htmlBarras(linhas, { fmt: curto(c) });
    }

    const COLUNAS = [
      { id: 'unidade', rot: 'Filial' },
      // o orçado vai embaixo do real, na mesma célula (9 colunas que cabem no cartão, sem rolar para o lado)
      { id: 'comb_real', rot: 'Combustível real / orç.', f: brl, plan: 'comb_plan' }, { id: 'comb_var', rot: 'Var.', v: 'custo' },
      { id: 'arla_real', rot: 'Arla real / orç.', f: brl, plan: 'arla_plan' }, { id: 'arla_var', rot: 'Var.', v: 'custo' },
      { id: 'km_real', rot: 'KM real / orç.', f: fmt.int, plan: 'km_plan' }, { id: 'km_var', rot: 'Var.', v: 'volume' },
      { id: 'ck_real', rot: 'R$/km real / orç.', f: brlKm, plan: 'ck_plan' }, { id: 'ck_var', rot: 'Var.', v: 'custo' },
    ];
    function desenharTabela() {
      const ms = mesesPeriodo();
      el('ro-tab-periodo').textContent = ms.length ? fmtMes(ms[0]) + ' a ' + fmtMes(ms[ms.length - 1]) : '';
      const linhas = unidadesSel().map((u) => {
        const r = { unidade: u };
        for (const [c, k] of [['combustivel', 'comb'], ['arla', 'arla'], ['km', 'km']]) {
          r[k + '_real'] = soma([u], ms, c, 'real'); r[k + '_plan'] = soma([u], ms, c, 'plan'); r[k + '_var'] = variacao(r[k + '_real'], r[k + '_plan']);
        }
        r.ck_real = tem(r.comb_real) && r.km_real ? r.comb_real / r.km_real : null;
        r.ck_plan = tem(r.comb_plan) && r.km_plan ? r.comb_plan / r.km_plan : null;
        r.ck_var = variacao(r.ck_real, r.ck_plan);
        return r;
      });
      linhas.sort((a, b) => {
        const va = a[ordem.campo], vb = b[ordem.campo];
        if (va === null && vb === null) return 0;
        if (va === null) return 1; if (vb === null) return -1;
        return ordem.dir * (typeof va === 'string' ? cmp(va, vb) : va - vb);
      });
      el('ro-tabela').innerHTML = '<thead><tr>' + COLUNAS.map((c, i) => {
        const ativa = ordem.campo === c.id;
        return '<th class="' + (i ? 'n' : '') + '" aria-sort="' + (ativa ? (ordem.dir < 0 ? 'descending' : 'ascending') : 'none') + '">' +
          '<button type="button" data-col="' + c.id + '">' + esc(c.rot) + (ativa ? '<span class="seta">' + (ordem.dir < 0 ? '▼' : '▲') + '</span>' : '') + '</button></th>';
      }).join('') + '</tr></thead><tbody>' +
        linhas.map((r) => '<tr>' + COLUNAS.map((c, i) => (i === 0 ? '<td><strong>' + esc(r.unidade) + '</strong></td>'
          : '<td class="n">' + (c.v ? htmlVar(r[c.id], c.v) : '<span class="num">' + esc(c.f(r[c.id])) + '</span>' +
            (c.plan ? '<small class="cidade-linha num">orç. ' + esc(c.f(r[c.plan])) + '</small>' : '')) + '</td>')).join('') + '</tr>').join('') + '</tbody>';
    }

    el('ro-tabela').addEventListener('click', (e) => {
      const b = e.target.closest('[data-col]');
      if (!b) return;
      const id = b.dataset.col;
      ordem = ordem.campo === id ? { campo: id, dir: -ordem.dir } : { campo: id, dir: id === 'unidade' ? 1 : -1 };
      desenharTabela();
      const novo = el('ro-tabela').querySelector('[data-col="' + id + '"]');
      if (novo) novo.focus();
    });
    corpo.querySelectorAll('.ro-barras').forEach((box) => box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-valor]');
      if (!b) return;
      selecionar(filtros.sel.filial, b.dataset.valor, e.ctrlKey || e.metaKey, M.unidades);
      atualizar();
    }));
    el('ro-janelas').addEventListener('click', (e) => {
      const b = e.target.closest('[data-janela]');
      if (!b || b.disabled) return;
      est.janela = b.dataset.janela; est.meses = null;
      atualizar();
    });
    el('ro-comparar').addEventListener('change', (e) => { est.comparar = e.target.checked; atualizar(); });
    el('ro-dica').addEventListener('click', (e) => { if (e.target.closest('#ro-limpar-meses')) { est.meses = null; atualizar(); } });

    function desenharGraficos() { CATS.forEach(desenharTendencia); }
    const atualizar = agendador(() => {
      filtros.atualizarUI();
      desenharTopo();
      desenharGraficos();
      CATS.forEach(desenharBarras);
      desenharTabela();
    });
    atualizar();
    return {
      redesenhar: desenharGraficos,
      dadosNovos() { atualizar(); },
      desmontar() { filtros.destruir(); },
    };
  }

  // ======================================================================== CONSUMO
  function montarConsumo() {
    const DIMENSOES = [
      { id: 'periodo', rotulo: 'Período', periodo: true },
      { id: 'cc', rotulo: 'Centro de custo', valor: (l) => l._cc },
      { id: 'categoria', rotulo: 'Categoria', valor: (l) => l._cat },
      { id: 'modelo', rotulo: 'Modelo', valor: (l) => l.modelo },
      { id: 'placa', rotulo: 'Placa', valor: (l) => l.placa },
      { id: 'motorista', rotulo: 'Motorista', valor: (l) => l.motorista },
    ];
    let ordem = { campo: 'economia', dir: 1 };
    let filtradas = C;
    corpo.innerHTML = `
      <section class="filtros" id="rc-filtros" aria-label="Filtros"></section>
      <div class="chips" id="rc-chips" aria-live="polite"></div>
      <section class="ro-kpis" id="rc-kpis" aria-label="Resumo do consumo"></section>
      <section class="painel ro-painel" aria-labelledby="rc-t">
        <div class="painel-cab"><h2 id="rc-t">Km por litro</h2>
          <div class="legenda"><span><i class="leg-barra"></i>Média real (km/L)</span><span><i class="leg-meta"></i>Meta média (km/L)</span></div></div>
        <div class="ro-par">
          <div class="ro-par-a">
            <div class="grafico-acoes"><p class="ro-subtitulo" id="rc-st"></p>
              <button type="button" class="btn oculto" id="rc-voltar"><svg aria-hidden="true"><use href="#i-recolher"/></svg><span class="txt">Voltar ao período anterior</span></button></div>
            <div class="grafico" id="rc-grafico"></div>
          </div>
          <div class="ro-par-b">
            <p class="ro-subtitulo">Por centro de custo · clique para focar (Ctrl+clique soma)</p>
            <div class="ro-legenda-barras"><span><i class="ro-a"></i>Média real</span><span><i class="ro-b"></i>Meta média</span></div>
            <div class="ro-barras" id="rc-cc"></div>
          </div>
        </div>
      </section>
      <section class="painel painel-tabela">
        <div class="painel-cab"><h2>Detalhe por veículo</h2><span class="conta" id="rc-conta"></span></div>

        <div class="tabela-rolagem ro-rolagem"><table class="dados tabela-clicavel ro-tabela-placas" id="rc-tabela"></table></div>
      </section>
      <details class="nota nota-mais"><summary>Como é calculado</summary>Só considera abastecimentos de diesel (todas as variantes juntas, sem Arla, gasolina, etanol ou gás natural) e exclui veículos
        marcados como "VENDA" na aba Metas. O centro de custo de cada abastecimento vem da Informação Adicional 3 da transação (não do cadastro do veículo),
        porque um veículo pode rodar por outra unidade em viagens pontuais. Média = soma do km rodado ÷ soma dos litros no recorte. Meta média = média das
        metas dos veículos, ponderada pelos litros de cada um. Economia (L) = para cada veículo com meta, os litros que ele gastaria rodando a mesma
        quilometragem na meta menos os litros que de fato gastou; negativo significa que gastou mais que a meta previa.</details>`;
    const el = (id) => corpo.querySelector('#' + id);
    const filtros = criarFiltros({
      dimensoes: DIMENSOES, filtrosEl: el('rc-filtros'), chipsEl: el('rc-chips'), rota: ROTA,
      obterBase: () => C, obterLimites: () => [dados.diaMin, dados.diaMax], aoMudar: () => atualizar(), prefixo: 'rc',
      extrasURL: () => ({ visao: 'consumo' }),
    });

    function desenharKpis() {
      const t = agregar(filtradas);
      const v = t.media !== null && t.metaMedia ? t.media / t.metaMedia - 1 : null;
      el('rc-kpis').innerHTML =
        kpi('Média real', (t.media === null ? '—' : fmt.d2(t.media)) + ' km/L', 'Meta média: <span class="num">' + esc(fmt.d2(t.metaMedia)) + ' km/L</span>',
          '<div class="ro-kpi-var">' + (v === null ? '<span class="sem-dado">sem meta no recorte</span>' : sinal(v, v >= 0, txtVar(v)) + ' <span class="ro-kpi-vs">vs meta</span>') + '</div>') +
        kpi('Km rodado', fmt.int(t.km), 'no período e filtros escolhidos') +
        kpi('Litros consumidos', fmt.int(t.lit), 'diesel, todas as variantes') +
        kpi('Economia (L)', t.economia === null ? '—' : fmt.int(t.economia),
          t.economia === null ? 'sem veículos com meta cadastrada' : statusHtml(t.economia >= 0, t.economia >= 0 ? 'abaixo da meta de consumo' : 'acima da meta de consumo'));
    }

    // gráfico: mês a mês (até ~3 meses de dados, dia a dia); clicar filtra o período, "Voltar" desfaz
    const anteriores = [];
    function desenharGrafico() {
      let min = Infinity, max = -Infinity;
      for (const l of filtradas) { if (l.dia < min) min = l.dia; if (l.dia > max) max = l.dia; }
      const porDia = filtradas.length && max - min <= DIAS_GRAFICO_DIARIO;
      el('rc-st').textContent = (porDia ? 'Dia a dia' : 'Evolução mensal') + ': média real × meta média · clique ' + (porDia ? 'num dia' : 'num mês') + ' para filtrar';
      el('rc-voltar').classList.toggle('oculto', !anteriores.length);
      const grupos = new Map();
      for (const l of filtradas) {
        const k = porDia ? l.dia : mesDoDia(l.dia);
        if (!grupos.has(k)) grupos.set(k, []);
        grupos.get(k).push(l);
      }
      const pts = [...grupos.entries()].sort((a, b) => a[0] - b[0]).map(([k, ls]) => {
        const t = agregar(ls);
        return { chave: k, porDia, rotulo: porDia ? fmtDia(k).slice(0, 5) : fmtMes(k), rotuloLongo: porDia ? fmtDia(k) : fmtMes(k, true),
          media: t.media, meta: t.metaMedia, ls };
      });
      const p = filtros.periodo;
      graficoPeriodo(el('rc-grafico'), pts, {
        barras: { campo: 'media', rot: 'Média real', cor: 'var(--serie-1)' },
        linhas: [{ campo: 'meta', rot: 'Meta média', cor: 'var(--tinta-2)' }],
        fmtV: (v) => (tem(v) ? fmt.d2(v) : '—'), fmtEixo: fmt.d1,
        extras: (q) => melhoresMotoristas(q.ls).map((m, i) => [(i + 1) + 'º ' + m.nome, fmt.d2(m.media) + ' km/L']),
        rotulo: 'Média real em colunas e meta média em linha, ' + (porDia ? 'por dia' : 'por mês'),
        destacar: porDia && p.de !== null && p.de === p.ate ? (q) => q.chave === p.de : null,
        aoClicar: (q) => {
          const de = q.porDia ? q.chave : inicioDoMes(q.chave);
          const ate = q.porDia ? q.chave : inicioDoMes(q.chave + 1) - 1;
          if (p.de === de && p.ate === ate) { voltar(); return; }
          anteriores.push({ de: p.de, ate: p.ate, preset: p.preset });
          filtros.definirPeriodo(de, ate);
        },
      });
    }
    function voltar() {
      const a = anteriores.pop();
      if (a) filtros.definirPeriodo(a.de, a.ate, a.preset); else filtros.definirPeriodo(null, null);
      queueMicrotask(() => el('rc-grafico').focus());
    }
    el('rc-voltar').addEventListener('click', voltar);

    let centros = [];
    function desenharCentros() {
      const base = C.filter((l) => filtros.passa(l, 'cc'));
      const grupos = new Map();
      for (const l of base) { if (!grupos.has(l._cc)) grupos.set(l._cc, []); grupos.get(l._cc).push(l); }
      const sel = filtros.sel.cc;
      centros = [...grupos.keys()].sort(cmp);
      const linhas = centros.map((cc) => {
        const ls = grupos.get(cc), t = agregar(ls);
        const top = melhoresMotoristas(ls).map((m, i) => (i + 1) + 'º ' + m.nome + ': ' + fmt.d2(m.media)).join('\n');
        return { nome: cc, a: t.media, b: t.metaMedia, apagada: sel.size && !sel.has(cc), selecionada: sel.has(cc),
          dica: cc + ' · média ' + fmt.d2(t.media) + ' · meta ' + fmt.d2(t.metaMedia) + (top ? '\nMelhores motoristas (km/L):\n' + top : '') };
      }).filter((x) => x.a !== null || x.b !== null);
      el('rc-cc').innerHTML = htmlBarras(linhas, { fmt: (v) => (tem(v) ? fmt.d2(v) : '—') });
    }
    el('rc-cc').addEventListener('click', (e) => {
      const b = e.target.closest('[data-valor]');
      if (!b) return;
      selecionar(filtros.sel.cc, b.dataset.valor, e.ctrlKey || e.metaKey, centros);
      atualizar();
    });

    const COLUNAS = [
      { id: 'placa', rot: 'Placa' }, { id: 'categoria', rot: 'Categoria' }, { id: 'modelo', rot: 'Modelo' }, { id: 'ano', rot: 'Ano' },
      { id: 'meta', rot: 'Meta', n: true }, { id: 'media', rot: 'Média', n: true },
      { id: 'km', rot: 'Km rodado', n: true }, { id: 'litros', rot: 'Litros', n: true },
      { id: 'economia', rot: 'Economia (L)', n: true },
    ];
    function desenharTabela() {
      // as linhas ignoram o filtro de placa (a tabela continua servindo para escolher); o total segue todos os filtros
      const t = agregar(C.filter((l) => filtros.passa(l, 'placa')));
      const sel = filtros.sel.placa;
      const linhas = [...t.porPlaca.entries()].map(([placa, a]) => {
        const v = dados.veiculos[placa] || {};
        return { placa, categoria: v.categoria || '—', modelo: v.modelo || '—', ano: v.ano || '—', meta: a.meta || null,
          media: a.lit > 0 ? a.km / a.lit : null, km: a.km, litros: a.lit, economia: a.meta ? a.km / a.meta - a.lit : null };
      });
      linhas.sort((a, b) => {
        const va = a[ordem.campo], vb = b[ordem.campo];
        if (va === null && vb === null) return 0;
        if (va === null) return 1; if (vb === null) return -1;
        return ordem.dir * (typeof va === 'string' ? cmp(va, vb) : va - vb);
      });
      const tot = agregar(filtradas);
      el('rc-conta').textContent = fmt.int(linhas.length) + (linhas.length === 1 ? ' veículo' : ' veículos');
      el('rc-tabela').innerHTML = '<thead><tr>' + COLUNAS.map((c) => {
        const ativa = ordem.campo === c.id;
        return '<th class="' + (c.n ? 'n' : '') + '" aria-sort="' + (ativa ? (ordem.dir < 0 ? 'descending' : 'ascending') : 'none') + '">' +
          '<button type="button" data-col="' + c.id + '">' + esc(c.rot) + (ativa ? '<span class="seta">' + (ordem.dir < 0 ? '▼' : '▲') + '</span>' : '') + '</button></th>';
      }).join('') + '</tr></thead><tbody>' +
        (linhas.length ? linhas.map((r) => '<tr class="' + (sel.has(r.placa) ? 'selecionado' : '') + '" data-placa="' + esc(r.placa) + '">' +
          '<td><button type="button" class="link-botao nome-clicavel" aria-pressed="' + sel.has(r.placa) + '">' + esc(r.placa) + '</button></td>' +
          '<td>' + esc(r.categoria) + '</td><td class="trunc">' + esc(r.modelo) + '</td><td>' + esc(r.ano) + '</td>' +
          '<td class="n">' + esc(fmt.d2(r.meta)) + '</td><td class="n">' + esc(fmt.d2(r.media)) + '</td>' +
          '<td class="n">' + esc(fmt.int(r.km)) + '</td><td class="n">' + esc(fmt.int(r.litros)) + '</td>' +
          '<td class="n">' + (r.economia === null ? '<span class="sem-dado">—</span>' : statusHtml(r.economia >= 0, fmt.int(r.economia))) + '</td></tr>').join('')
          : '<tr><td colspan="' + COLUNAS.length + '"><div class="vazio">Nenhum abastecimento de diesel neste recorte.</div></td></tr>') + '</tbody>' +
        '<tfoot><tr><td>Total</td><td></td><td></td><td></td><td class="n">' + esc(fmt.d2(tot.metaMedia)) + '</td><td class="n">' + esc(fmt.d2(tot.media)) + '</td>' +
          '<td class="n">' + esc(fmt.int(tot.km)) + '</td><td class="n">' + esc(fmt.int(tot.lit)) + '</td>' +
          '<td class="n">' + (tot.economia === null ? '—' : esc(fmt.int(tot.economia))) + '</td></tr></tfoot>';
    }
    el('rc-tabela').addEventListener('click', (e) => {
      const b = e.target.closest('[data-col]');
      if (b) {
        const id = b.dataset.col, col = COLUNAS.find((c) => c.id === id);
        ordem = ordem.campo === id ? { campo: id, dir: -ordem.dir } : { campo: id, dir: id === 'economia' ? 1 : col.n ? -1 : 1 };
        desenharTabela();
        const novo = el('rc-tabela').querySelector('[data-col="' + id + '"]');
        if (novo) novo.focus();
        return;
      }
      const linha = e.target.closest('tr[data-placa]');
      if (linha) filtros.alternar('placa', linha.dataset.placa);
    });

    const atualizar = agendador(() => {
      filtradas = C.filter((l) => filtros.passa(l, null));
      filtros.atualizarUI();
      desenharKpis();
      desenharGrafico();
      desenharCentros();
      desenharTabela();
    });
    atualizar();
    return {
      redesenhar: desenharGrafico,
      dadosNovos() { atualizar(); },
      desmontar() { filtros.destruir(); },
    };
  }

  abrir(q0.get('visao') === 'consumo' ? 'consumo' : 'custos', true);

  let tRedim = null;
  const aoRedimensionar = () => { clearTimeout(tRedim); tRedim = setTimeout(() => atual && atual.redesenhar(), 120); };
  window.addEventListener('resize', aoRedimensionar);
  const aoTema = () => atual && atual.redesenhar();
  window.addEventListener('tema', aoTema);
  const aoAtualizarDados = () => carregarDados().then((d) => {
    const tinhaOrcamento = !!M;
    usarDados(d);
    if (!tinhaOrcamento && M) abrir(visao, true); else if (atual.dadosNovos) atual.dadosNovos();
  });
  window.addEventListener('dados-atualizados', aoAtualizarDados);
  return {
    desmontar() {
      if (atual) atual.desmontar();
      window.removeEventListener('resize', aoRedimensionar);
      window.removeEventListener('tema', aoTema);
      window.removeEventListener('dados-atualizados', aoAtualizarDados);
    },
  };
}
