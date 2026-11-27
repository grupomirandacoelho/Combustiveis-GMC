// Programa PRIME > "Resultado PRIME" (11/11/2026): tela de apresentação do mês fechado, por unidade.
//  - fonte: o resultado gravado no fechamento (/api/prime?mes=AAAA-MM: resultado por motorista e prêmio dos encarregados);
//    só meses fechados (os números não mudam depois);
//  - litros economizados = litros pela meta − litros abastecidos de cada motorista (km ÷ meta da placa − litros: a mesma
//    conta da Operação por motorista), SÓ dos motoristas com ≥ 95% da meta (o mínimo do prêmio de combustível, parâmetro
//    pctMeta do mês): quem fica abaixo não recebe, então o que gastou a mais não é custo do programa (11/11/2026);
//    negativo = os considerados gastaram mais que a meta;
//  - preço médio da unidade = Σ valor ÷ Σ litros de TODOS os abastecimentos de diesel do mês com o centro de custo da unidade
//    (não só os do PRIME); economia em R$ = litros economizados × preço médio da unidade;
//  - premiação = prêmio de telemetria + prêmio combustível dos motoristas + o prêmio do encarregado, dividido entre as
//    unidades dele na proporção dos motoristas de cada uma no ranking;
//  - resultado = economia em R$ − premiação; retorno = economia ÷ premiação;
//  - painel "Antes x depois dos deflatores" (13/11/2026): a mesma conta com o prêmio original da conta (premioAntesPagamento)
//    contra o que foi pago pela lista de premiados sem deflatores. A economia é a mesma nos dois: quem não recebeu economizou
//    de qualquer forma, os deflatores só tiram o prêmio (19/11/2026).
import { carregarDados, fmt, esc, fmtMes, mesDoDia, ehDiesel } from '../lib/dados.js';
import { htmlApoio, metaHtml, statusHtml, trocarEndereco } from '../lib/filtros.js';
import { tabelaOrdenavel } from '../lib/tabela.js';

// unidades que não participam do Programa PRIME (11/11/2026: RAJA ADM)
const UNIDADES_FORA = new Set(['RAJA ADM']);

const ROTA = '#/prime-resultado';
const ymDe = (m) => Math.floor(m / 12) + '-' + String((m % 12) + 1).padStart(2, '0');
const mDe = (ym) => { const [a, b] = ym.split('-').map(Number); return a * 12 + b - 1; };
const rs = (v) => (v === null || v === undefined || !isFinite(v) ? '—' : fmt.moeda(v));
const rsInt = (v) => (v === null || v === undefined || !isFinite(v) ? '—' : (Math.round(v) < 0 ? '−' : '') + 'R$ ' + fmt.int(Math.abs(Math.round(v))));
// "RAJA LOG GRANEL" -> "Granel"; "RAJA VITORIA DA CONQUISTA" -> "Vitoria da Conquista"
const nomeUni = (u) => String(u || '—').replace(/^RAJA (LOG )?/, '').toLowerCase().replace(/(^|\s)(\S)(\S*)/g, (t, s, a, b) => s + ((a + b).length > 2 ? a.toUpperCase() + b : a + b));

async function buscarMes(ym) {
  const r = await fetch('/api/prime?mes=' + encodeURIComponent(ym), { credentials: 'same-origin', cache: 'no-store' });
  if (r.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Não foi possível carregar o PRIME.');
  return j;
}

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando o resultado do PRIME…</div>';
  let dados, info;
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  try {
    dados = await carregarDados();
    // o GET de qualquer mês traz a lista de meses; abre no mês pedido ou no último fechado
    info = await buscarMes(q.get('mes') || ymDe(mesDoDia(dados.diaMax)));
    const fechados = (info.meses || []).filter((m) => m.situacao === 'fechado').map((m) => m.mes);
    if (!q.get('mes') && fechados.length && info.mes !== fechados[0]) info = await buscarMes(fechados[0]);
  } catch (e) {
    if (e.message !== 'sessão') pagina.innerHTML = '<div class="vazio">' + esc(e.message) + ' Recarregue a página para tentar de novo.</div>';
    return {};
  }

  pagina.innerHTML = `
    <div class="anp-controles">
      <div class="anp-grupo"><label class="filtro-rotulo" for="prr-mes">Mês da campanha</label><select id="prr-mes" class="campo-sel"></select></div>
      <p class="nota prr-situacao" id="prr-situacao"></p>
    </div>
    <dl class="apoio apoio-pilha" id="prr-topo"></dl>
    <dl class="apoio apoio-pilha" id="prr-economia"></dl>
    <section class="painel">
      <div class="painel-cab"><h2>Economia x premiação por unidade</h2><span class="conta" id="prr-conta"></span></div>
      <div class="prr-legenda"><span><i class="prr-i-econ"></i>Economia em R$</span><span><i class="prr-i-neg"></i>Gastou mais que a meta</span><span><i class="prr-i-prem"></i>Premiação</span><span class="prr-leg-saldo">Saldo = economia − premiação</span></div>
      <div class="prr-barras" id="prr-barras"></div>
    </section>
    <section class="painel painel-tabela">
      <div class="painel-cab"><h2>Resultado por unidade</h2></div>
      <div class="tabela-rolagem"><table class="dados prr-tabela" id="prr-tabela"></table></div>
      <p class="nota" id="prr-nota"></p>
    </section>
    <section class="painel">
      <div class="painel-cab"><h2>Antes x depois dos deflatores</h2><span class="conta" id="prr-def-conta"></span></div>
      <div id="prr-def-corpo"></div>
      <div class="tabela-rolagem"><table class="dados prr-tabela" id="prr-def-tabela"></table></div>
      <p class="nota" id="prr-def-nota"></p>
    </section>`;
  const el = (id) => pagina.querySelector('#' + id);
  const det = (s) => '<small class="apoio-det">' + s + '</small>';   // texto de apoio embaixo do número (tamanho pequeno)
  const tab = tabelaOrdenavel(el('prr-tabela'), {
    padrao: { campo: 'econR', dir: -1 },
    vazio: 'Nenhuma unidade neste mês.',
    colunas: [
      { id: 'u', rot: 'Unidade', v: (a) => nomeUni(a.u), html: (a) => '<strong>' + esc(nomeUni(a.u)) + '</strong><small class="cidade-linha">' + esc(a.u) + '</small>' },
      { id: 'motoristas', rot: 'Motoristas', n: true, v: (a) => a.motoristas, html: (a) => fmt.int(a.motoristas) + '<small class="cidade-linha">' + fmt.int(a.premiados) + ' premiados · ' + fmt.int(a.considerados) + ' na conta</small>' },
      { id: 'km', rot: 'Km', n: true, v: (a) => a.km, html: (a) => fmt.int(a.km) },
      { id: 'litros', rot: 'Litros', n: true, v: (a) => a.litros, html: (a) => fmt.int(a.litros) },
      { id: 'pct', rot: '% da meta', v: (a) => a.pct, html: (a) => (a.pct ? metaHtml(a.pct, fmt.pct(a.pct)) : '—') },
      { id: 'econL', rot: 'Litros economizados', dica: 'Só dos motoristas com 95% da meta ou mais', n: true, v: (a) => a.econL, html: (a) => fmt.int(Math.round(a.econL)), cls: (a) => (a.econL < 0 ? 'neg-txt' : '') },
      { id: 'preco', rot: 'Preço médio', n: true, v: (a) => a.preco, html: (a) => rs(a.preco) + (a.precoProprio ? '' : '<small class="cidade-linha">média geral</small>') },
      { id: 'econR', rot: 'Economia R$', n: true, v: (a) => a.econR, html: (a) => rsInt(a.econR), cls: (a) => ((a.econR || 0) < 0 ? 'neg-txt' : '') },
      { id: 'premioMot', rot: 'Prêmio motoristas', n: true, v: (a) => a.premioSS + a.premioComb, html: (a) => rsInt(a.premioSS + a.premioComb) },
      { id: 'premioEnc', rot: 'Prêmio encarregado', n: true, v: (a) => a.premioEnc, html: (a) => rsInt(a.premioEnc) },
      { id: 'premio', rot: 'Premiação', n: true, v: (a) => a.premio, html: (a) => rsInt(a.premio) },
      { id: 'resultado', rot: 'Resultado', n: true, v: (a) => a.resultado, html: (a) => '<strong>' + rsInt(a.resultado) + '</strong>', cls: (a) => ((a.resultado || 0) >= 0 ? 'pos-txt' : 'neg-txt') },
      { id: 'retorno', rot: 'Retorno', n: true, v: (a) => a.retorno, html: (a) => (a.retorno === null ? '—' : fmt.d2(a.retorno) + '×') },
    ],
  });

  // comparativo antes x depois dos deflatores (13/11/2026): antes = conta do portal; depois = lista de premiados sem deflatores
  const dif = (d, a) => (d === null || a === null ? null : d - a);
  const rsDif = (v) => (v === null || !isFinite(v) ? '—' : (Math.round(v) > 0 ? '+ ' : '') + rsInt(v));
  const clsDif = (v) => (v === null ? '' : v > 0.5 ? 'pos-txt' : v < -0.5 ? 'neg-txt' : '');
  const tabDef = tabelaOrdenavel(el('prr-def-tabela'), {
    padrao: { campo: 'difRes', dir: -1 },
    vazio: 'Nenhuma unidade neste mês.',
    colunas: [
      { id: 'u', rot: 'Unidade', v: (a) => nomeUni(a.u), html: (a) => '<strong>' + esc(nomeUni(a.u)) + '</strong><small class="cidade-linha">' + esc(a.u) + '</small>' },
      { id: 'nao', rot: 'Não receberam', dica: 'Motoristas premiados na conta que ficaram fora da lista de premiados (deflatores)', n: true, v: (a) => a.nao, html: (a) => fmt.int(a.nao) + '<small class="cidade-linha">de ' + fmt.int(a.premiadosAntes) + ' premiados</small>' },
      { id: 'econ', rot: 'Economia R$', dica: 'A mesma antes e depois: quem não recebeu economizou de qualquer forma', n: true, v: (a) => a.econ, html: (a) => rsInt(a.econ), cls: (a) => ((a.econ || 0) < 0 ? 'neg-txt' : '') },
      { id: 'premA', rot: 'Premiação antes', n: true, v: (a) => a.premA, html: (a) => rsInt(a.premA) },
      { id: 'premD', rot: 'Premiação depois', n: true, v: (a) => a.premD, html: (a) => rsInt(a.premD) },
      { id: 'resA', rot: 'Resultado antes', n: true, v: (a) => a.resA, html: (a) => rsInt(a.resA), cls: (a) => ((a.resA || 0) >= 0 ? 'pos-txt' : 'neg-txt') },
      { id: 'resD', rot: 'Resultado depois', n: true, v: (a) => a.resD, html: (a) => '<strong>' + rsInt(a.resD) + '</strong>', cls: (a) => ((a.resD || 0) >= 0 ? 'pos-txt' : 'neg-txt') },
      { id: 'difRes', rot: 'Diferença no resultado', n: true, v: (a) => a.difRes, html: (a) => rsDif(a.difRes), cls: (a) => clsDif(a.difRes) },
    ],
  });

  function desenharComparativo(A, D) {
    if (!A) {
      el('prr-def-conta').textContent = '';
      el('prr-def-corpo').innerHTML = '<div class="vazio">Este mês ainda não tem a lista de premiados sem deflatores: a premiação mostrada é a da conta do portal, então antes e depois são iguais.</div>';
      el('prr-def-tabela').innerHTML = ''; el('prr-def-nota').textContent = '';
      return;
    }
    const a = A.T, d = D.T;
    const antes = (v, txt) => det('antes ' + txt + (v === null ? '' : ' · ' + rsDif(v)));
    const melhorou = d.resultado >= a.resultado;
    el('prr-def-conta').textContent = fmt.int(d.naoRecebeu) + ' motoristas não receberam';
    el('prr-def-corpo').innerHTML = '<dl class="apoio apoio-pilha">' + htmlApoio([
      { rot: 'Prêmio que não foi pago', val: rsInt(a.premio - d.premio), det: det(fmt.int(d.naoRecebeu) + ' de ' + fmt.int(a.premiados) + ' premiados na conta ficaram fora da lista') },
      { rot: 'Economia em R$', val: rsInt(d.econR), det: det('a mesma antes e depois: os deflatores só tiram o prêmio') },
      { rot: 'Premiação total', val: rsInt(d.premio), det: antes(dif(d.premio, a.premio), rsInt(a.premio)) },
      { rot: 'Resultado (economia − premiação)', val: rsInt(d.resultado),
        det: det('antes ' + rsInt(a.resultado)) + ' ' + statusHtml(melhorou, (melhorou ? '+ ' : '− ') + rsInt(Math.abs(d.resultado - a.resultado))) },
      { rot: 'Retorno', val: d.retorno === null ? '—' : fmt.d2(d.retorno) + '×', det: det('antes ' + (a.retorno === null ? '—' : fmt.d2(a.retorno) + '×')) },
    ]) + '</dl>';
    const porU = new Map(A.linhas.map((x) => [x.u, x]));
    const linhas = D.linhas.map((x) => {
      const y = porU.get(x.u) || {};
      return { u: x.u, nao: x.naoRecebeu, premiadosAntes: y.premiados || 0, econ: x.econR, premA: y.premio || 0, premD: x.premio,
        resA: y.resultado ?? null, resD: x.resultado, difRes: dif(x.resultado, y.resultado ?? null) };
    });
    const cel = (v, c) => '<td class="n num' + (c ? ' ' + c : '') + '">' + v + '</td>';
    tabDef.atualizar(linhas, '<tr><th>Total</th>' + cel(fmt.int(d.naoRecebeu) + '<small class="cidade-linha">de ' + fmt.int(a.premiados) + ' premiados</small>') +
      cel(rsInt(d.econR), d.econR < 0 ? 'neg-txt' : '') + cel(rsInt(a.premio)) + cel(rsInt(d.premio)) +
      cel(rsInt(a.resultado), a.resultado >= 0 ? 'pos-txt' : 'neg-txt') + cel('<strong>' + rsInt(d.resultado) + '</strong>', d.resultado >= 0 ? 'pos-txt' : 'neg-txt') +
      cel(rsDif(d.resultado - a.resultado), clsDif(d.resultado - a.resultado)) + '</tr>');
    el('prr-def-nota').textContent = 'Antes = a conta do portal no fechamento, com o prêmio de todos os motoristas que bateram as metas. Depois = o que foi pago pela ' +
      'lista de premiados sem deflatores: quem estava premiado na conta e não recebeu sai só da premiação. A economia é a mesma nos dois (todos com a % mínima da meta), ' +
      'porque quem não recebeu economizou de qualquer forma. O prêmio dos encarregados é o mesmo nos dois. Diferença no resultado = o prêmio que não foi pago.';
  }

  function desenhar() {
    const ym = info.mes, m = mDe(ym);
    trocarEndereco(ROTA, ROTA + '?mes=' + ym);
    const fechados = (info.meses || []).filter((x) => x.situacao === 'fechado');
    el('prr-mes').innerHTML = (fechados.some((x) => x.mes === ym) ? fechados : [{ mes: ym }, ...fechados])
      .map((x) => '<option value="' + x.mes + '"' + (x.mes === ym ? ' selected' : '') + '>' + esc(fmtMes(mDe(x.mes), true)) + '</option>').join('');
    const res = info.situacao === 'fechado' && Array.isArray(info.resultado) ? info.resultado : null;
    ctx.definirSub('Resultado do Programa PRIME por unidade: economia de diesel em R$ contra a premiação do mês.');
    if (!res) {
      el('prr-situacao').textContent = '';
      el('prr-topo').innerHTML = ''; el('prr-economia').innerHTML = ''; el('prr-barras').innerHTML = '';
      el('prr-tabela').innerHTML = '<tbody><tr><td><div class="vazio">' + esc(fmtMes(m, true)) + ' ainda não foi fechado. O resultado aparece aqui depois do fechamento em Programa PRIME &gt; Fechamento abastecimentos.</div></td></tr></tbody>';
      el('prr-nota').textContent = ''; el('prr-conta').textContent = '';
      el('prr-def-conta').textContent = ''; el('prr-def-corpo').innerHTML = ''; el('prr-def-tabela').innerHTML = ''; el('prr-def-nota').textContent = '';
      return;
    }
    el('prr-situacao').textContent = 'Fechado' + (info.fechadoPor ? ' por ' + info.fechadoPor : '') + (info.fechadoEm ? ' em ' + new Date(info.fechadoEm).toLocaleDateString('pt-BR') : '') + '.';

    // preço médio do diesel de cada centro de custo no mês (todos os abastecimentos de diesel)
    const preco = new Map();
    let pv = 0, pl = 0;
    for (const l of dados.linhas) {
      if (mesDoDia(l.dia) !== m || !ehDiesel(l.combustivel) || !(l.litros > 0)) continue;
      const a = preco.get(l.cc) || { v: 0, l: 0 };
      a.v += l.despesa || 0; a.l += l.litros; preco.set(l.cc, a);
      pv += l.despesa || 0; pl += l.litros;
    }
    const precoGeral = pl ? pv / pl : null;

    // litros economizados só de quem fez a % da meta mínima do prêmio de combustível (95%): abaixo disso o motorista não recebe
    // nada, então o que ele gastou a mais não é custo do programa e sim desempenho dele (decisão do usuário em 11/11/2026)
    const pcts = (info.parametros && Array.isArray(info.parametros.pctMeta) ? info.parametros.pctMeta : []).filter((x) => x > 0);
    const PCT_MIN = pcts.length ? Math.min(...pcts) : 0.95;
    const enc = (info.parametros && info.parametros.resultadoEncarregados) || [];
    // antes = a conta do portal sem a lista de premiados (prêmio original em premioAntesPagamento, quem "não recebeu" ainda conta);
    // depois = o que foi pago (lista de premiados sem deflatores) — o padrão da tela (comparativo pedido em 13/11/2026)
    function agregar(antes) {
      const uni = new Map();
      const novo = (u) => ({ u, motoristas: 0, premiados: 0, considerados: 0, qtd: 0, km: 0, litros: 0, litrosMeta: 0, litrosC: 0, litrosMetaC: 0, econPosL: 0, premioSS: 0, premioComb: 0, premioEnc: 0, naoRecebeu: 0 });
      for (const r of res) {
        const k = r.unidade || '—';
        if (UNIDADES_FORA.has(k)) continue;
        const a = uni.get(k) || novo(k);
        const orig = antes && r.premioAntesPagamento;
        const ss = orig ? orig.premioSS || 0 : r.premioSS || 0, comb = orig ? orig.premioComb || 0 : r.premioComb || 0;
        a.motoristas++; if (ss + comb > 0) a.premiados++;
        if (r.naoRecebeu) a.naoRecebeu++;
        a.qtd += r.qtd || 0; a.km += r.km || 0; a.litros += r.litros || 0; a.litrosMeta += r.litrosMeta || 0;
        a.econPosL += Math.max(0, (r.litrosMeta || 0) - (r.litros || 0));   // só quem ficou acima da meta (economizou de fato)
        // naoRecebeu = estava premiado na conta mas não recebeu (deflatores). Continua na economia: economizou de qualquer forma, os
        // deflatores só tiram o prêmio (correção pedida pelo usuário em 19/11/2026; de 12/11 a 19/11 ele saía também da economia)
        if (r.pct !== null && r.pct !== undefined && r.pct >= PCT_MIN - 1e-9) { a.considerados++; a.litrosC += r.litros || 0; a.litrosMetaC += r.litrosMeta || 0; }
        a.premioSS += ss; a.premioComb += comb;
        uni.set(k, a);
      }
      // prêmio dos encarregados (não muda com os deflatores), dividido entre as unidades dele pela quantidade de motoristas de cada uma
      let premioEncSemUni = 0;
      for (const e of enc) {
        if (!(e.total > 0)) continue;
        const us = (e.unidades || []).filter((u) => uni.has(u));
        const n = us.reduce((s, u) => s + uni.get(u).motoristas, 0);
        if (!n) { premioEncSemUni += e.total; continue; }
        for (const u of us) uni.get(u).premioEnc += e.total * uni.get(u).motoristas / n;
      }
      const linhas = [...uni.values()].map((a) => {
        const p = preco.get(a.u), pm = p && p.l ? p.v / p.l : precoGeral;
        const econL = a.litrosMetaC - a.litrosC, econR = pm ? econL * pm : null, econPosR = pm ? a.econPosL * pm : null;
        const premio = a.premioSS + a.premioComb + a.premioEnc;
        return { ...a, preco: pm, precoProprio: !!(p && p.l), econL, econR, econPosR, premio, resultado: econR === null ? null : econR - premio,
          retorno: premio > 0 && econR > 0 ? econR / premio : null, pct: a.litros && a.litrosMeta ? a.litrosMeta / a.litros : null };
      }).sort((x, y) => (y.econR ?? -Infinity) - (x.econR ?? -Infinity));
      const T = { motoristas: 0, premiados: 0, considerados: 0, naoRecebeu: 0, litrosC: 0, litrosMetaC: 0, qtd: 0, km: 0, litros: 0, litrosMeta: 0, econPosL: 0, econPosR: 0, premioSS: 0, premioComb: 0, premioEnc: 0, econL: 0, econR: 0, premio: 0 };
      for (const a of linhas) for (const k of Object.keys(T)) T[k] += a[k] || 0;
      T.premioEnc += premioEncSemUni; T.premio += premioEncSemUni;
      T.resultado = T.econR - T.premio; T.retorno = T.premio > 0 && T.econR > 0 ? T.econR / T.premio : null;
      T.pct = T.litros && T.litrosMeta ? T.litrosMeta / T.litros : null;
      T.preco = T.econL ? T.econR / T.econL : precoGeral;   // preço médio ponderado pela economia de cada unidade
      return { linhas, T, premioEncSemUni };
    }
    const { linhas, T, premioEncSemUni } = agregar(false);
    const temDeflatores = !!(info.parametros && info.parametros.pagamento);
    desenharComparativo(temDeflatores ? agregar(true) : null, { linhas, T });

    // faixa 1: os números do fechamento
    el('prr-topo').innerHTML = htmlApoio([
      { rot: 'Motoristas no ranking', val: fmt.int(T.motoristas), det: det(fmt.int(T.premiados) + ' premiados') },
      // meses importados das planilhas (jul–set/2026) não têm a quantidade de abastecimentos
      { rot: 'Abastecimentos que entram', val: res.some((r) => r.qtd > 0) ? fmt.int(T.qtd) : '—' },
      { rot: 'Prêmio telemetria', val: rsInt(T.premioSS) },
      { rot: 'Prêmio combustível', val: rsInt(T.premioComb) },
      { rot: 'Encarregados', val: rsInt(T.premioEnc) },
      { rot: 'Premiação total', val: rsInt(T.premio) },
    ]);
    // faixa 2: o que a campanha devolveu
    const bom = T.resultado >= 0;
    el('prr-economia').innerHTML = htmlApoio([
      { rot: T.econL >= 0 ? 'Litros economizados' : 'Litros gastos a mais', val: fmt.int(Math.abs(Math.round(T.econL))) + ' L',
        det: det(fmt.int(T.considerados) + ' de ' + fmt.int(T.motoristas) + ' motoristas, os com ' + fmt.pct(PCT_MIN) + ' da meta ou mais') },
      { rot: 'Economia em R$', val: rsInt(T.econR), det: det('preço médio ' + rs(T.preco) + '/L') },
      { rot: 'Resultado (economia − premiação)', val: rsInt(T.resultado), det: statusHtml(bom, bom ? 'a campanha se pagou' : 'prêmio maior que a economia') },
      { rot: 'Retorno', val: T.retorno === null ? '—' : fmt.d2(T.retorno) + '×', det: det(T.retorno === null ? 'sem economia no mês' : 'R$ economizados por R$ 1 de prêmio') },
      // só quem ficou acima da meta: o ganho de quem a premiação recompensa (a economia geral desconta quem gastou a mais)
      { rot: 'Economia de quem bateu a meta', val: rsInt(T.econPosR), det: det(fmt.int(Math.round(T.econPosL)) + ' L' +
        (T.premio > 0 ? ' · ' + fmt.d2(T.econPosR / T.premio) + '× a premiação' : '')) },
    ]);

    // barras: economia x premiação por unidade (escala comum)
    el('prr-conta').textContent = fmt.int(linhas.length) + ' unidades';
    const max = Math.max(1, ...linhas.map((a) => Math.max(Math.abs(a.econR || 0), a.premio)));
    const larg = (v) => (Math.abs(v || 0) / max * 100).toFixed(2) + '%';
    el('prr-barras').innerHTML = linhas.map((a) => '<div class="prr-linha">' +
      '<div class="prr-nome"><strong>' + esc(nomeUni(a.u)) + '</strong><small class="cidade-linha">' + fmt.int(a.motoristas) + ' motoristas</small></div>' +
      '<div class="prr-pares">' +
        '<div class="prr-par"><span class="prr-val num">' + esc(rsInt(a.econR)) + '</span><span class="prr-trilho"><span class="prr-barra prr-econ' + ((a.econR || 0) < 0 ? ' prr-neg' : '') + '" style="width:' + larg(a.econR) + '"></span></span></div>' +
        '<div class="prr-par"><span class="prr-val num">' + esc(rsInt(a.premio)) + '</span><span class="prr-trilho"><span class="prr-barra prr-prem" style="width:' + larg(a.premio) + '"></span></span></div>' +
      '</div>' +
      '<div class="prr-saldo">' + (a.resultado === null ? '—' : statusHtml(a.resultado >= 0, (a.resultado >= 0 ? '+ ' : '− ') + rsInt(Math.abs(a.resultado)))) + '</div>' +
    '</div>').join('');

    // tabela ordenável (lib/tabela.js); o total fica no rodapé (não entra na ordenação)
    const cel = (v) => '<td class="n num">' + v + '</td>';
    tab.atualizar(linhas, '<tr><th>Total</th>' + cel(fmt.int(T.motoristas) + '<small class="cidade-linha">' + fmt.int(T.premiados) + ' premiados · ' + fmt.int(T.considerados) + ' na conta</small>') + cel(fmt.int(T.km)) + cel(fmt.int(T.litros)) +
      '<td>' + (T.pct ? metaHtml(T.pct, fmt.pct(T.pct)) : '—') + '</td>' +
      '<td class="n num' + (T.econL < 0 ? ' neg-txt' : '') + '">' + fmt.int(Math.round(T.econL)) + '</td>' + cel(rs(T.preco)) +
      '<td class="n num' + (T.econR < 0 ? ' neg-txt' : '') + '">' + rsInt(T.econR) + '</td>' + cel(rsInt(T.premioSS + T.premioComb)) + cel(rsInt(T.premioEnc)) + cel(rsInt(T.premio)) +
      '<td class="n num ' + (T.resultado >= 0 ? 'pos-txt' : 'neg-txt') + '"><strong>' + rsInt(T.resultado) + '</strong></td>' + cel(T.retorno === null ? '—' : fmt.d2(T.retorno) + '×') + '</tr>');
    el('prr-nota').textContent = 'Litros economizados = litros pela meta (km ÷ meta da placa) − litros abastecidos (mesma conta da economia de cada abastecimento na Operação por motorista), só dos motoristas com ' + fmt.pct(PCT_MIN) +
      ' da meta ou mais: abaixo disso o motorista não recebe prêmio de combustível, então o que ele gastou a mais não é custo do programa. Negativo = os considerados gastaram mais que a meta. ' +
      'Preço médio = valor ÷ litros de todos os abastecimentos de diesel do mês com o centro de custo da unidade. Economia em R$ = litros economizados × preço médio da unidade. ' +
      'Premiação = prêmio de telemetria e de combustível dos motoristas + o do encarregado, dividido entre as unidades dele pela quantidade de motoristas de cada uma. ' +
      '"Economia de quem bateu a meta" soma só os motoristas que gastaram menos que a meta (a economia geral desconta os que gastaram mais).' +
      (info.parametros && info.parametros.pagamento ? ' Neste mês a premiação dos motoristas é a que foi paga (lista de premiados sem deflatores): ' + fmt.int(info.parametros.pagamento.naoRecebeu || 0) +
        ' motoristas premiados na conta não receberam (saem da premiação; a economia deles continua na conta).' : '') +
      (premioEncSemUni ? ' ' + rsInt(premioEncSemUni) + ' de encarregados sem motoristas no ranking entram só no total.' : '');
  }

  el('prr-mes').addEventListener('change', async (e) => {
    try { info = await buscarMes(e.target.value); desenhar(); } catch (err) { if (err.message !== 'sessão' && ctx.aviso) ctx.aviso(err.message); }
  });
  desenhar();
  return {};
}
