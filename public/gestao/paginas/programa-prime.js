// Operacional > Programa PRIME: fechamento mensal do ranking dos motoristas (design-system/PRIME.md).
// Por motorista: nota da telemetria SS (ou manual) e média de combustível contra a meta, com os prêmios das tabelas do mês.
// Os abastecimentos vêm do arquivo de abastecimentos (Base); o que se decide aqui (tirar do PRIME, trocar motorista, notas) fica
// em /api/prime e não muda a Base nem a Operação por motorista. Abastecimento tirado sai só da média (km/L e % da meta): o km
// rodado dele continua contando no km do mês (faixa do prêmio). A nota da telemetria só vale com cobertura de 50% do km dos abastecimentos,
// a não ser que ela não dê prêmio; sem telemetria a nota é manual. O mês só fecha com todos os motoristas com nota.
import { carregarDados, esc, fmt, fmtDia, chaveNome, ehDiesel, mesDoDia, inicioDoMes, fmtMes } from '../lib/dados.js';
import { metaHtml, botoesMaisMenos } from '../lib/filtros.js';
import { seloCartao } from '../lib/cartoes.js';
import { carregarSheetJS } from '../lib/sheetjs.js';
import { ligarBaixar } from '../lib/baixar.js';
import { corrigirNaBaseCopia } from '../lib/base-copia.js';

// parâmetros do fechamento de setembro/2026 (Parametros Campanha (com km).xlsx); cada mês grava os seus
const PADRAO = {
  ss: [[100, 250], [90, 150], [80, 100]],                         // nota mínima -> R$
  estrelas: [90, 80, 70, 60, 50],                                  // 5, 4, 3, 2 e 1 estrela
  faixasKm: [8500, 7000, 5500, 4000, 2500, 1000],
  pctMeta: [1.05, 1, 0.95],
  combustivel: [[1400, 1050, 700], [1200, 900, 600], [1000, 750, 500], [700, 500, 300], [500, 350, 200], [300, 200, 100]],
  coberturaMin: 0.5,
  kmMinimo: 1000,                                                  // rodou menos que isso no mês: perde todos os prêmios (decisão do usuário em 11/11/2026)
  encSS: [[100, 750], [90, 500], [80, 400]],
  encComb: [[1.05, 600], [1, 400], [0.95, 300]],
  encarregados: [
    { nome: 'Antônio Marcos', unidades: ['RAJA JEQUIE', 'RAJA VITORIA DA CONQUISTA', 'RAJA LOG ILHEUS'] },
    { nome: 'Aldemir Bonfim', unidades: ['RAJA SALVADOR'] },
    { nome: 'Fábio Pontes', unidades: ['RAJA RECIFE'] },
    { nome: 'Fábio Silva', unidades: ['RAJA LOG GRANEL', 'RAJA GOIANIA'] },
    { nome: 'Trindade Filho', unidades: ['RAJA LOG BELEM', 'RAJA MARANHAO'] },
    { nome: 'Guilherme Almeida', unidades: ['RAJA SERRA', 'RAJA GOVERNADOR VALADARES', 'KEMIGAS GV'] },
    { nome: 'Aibson Gomes', unidades: ['RAJA LOG TEIXEIRA DE FREITAS', 'KEMIGAS NANUQUE'] },
  ],
  excluidos: ['ALESSANDRO STRELOW SIQUEIRA', 'CARTAO TREINAMENTO', 'ITAMAR QUITO ROSENO', 'NAO INFORMADO',
    'GUILHERME DE ALMEIDA RODRIGUES', 'CAIO COELHO DUTRA', 'LUCIANA MIRANDA COELHO'],
};
const MOTIVOS = ['Abastecimento parcial', 'Motorista coringa', 'Veículo administrativo', 'Caminhão novo / primeiro abastecimento', 'KM fora do normal', 'Outro'];
const AVISO_PADRAO = {
  'Abastecimento parcial': 'Abastecimento parcial: Não completou o tanque final do mês',
  'Motorista coringa': 'Abastecimento sem motorista identificado: fica fora do PRIME.',
  'Veículo administrativo': 'Veículo administrativo: fica fora do PRIME.',
  'Caminhão novo / primeiro abastecimento': 'Primeiro abastecimento do veículo: fica fora do PRIME.',
  'KM fora do normal': 'KM fora do normal neste abastecimento: ficou fora da média do PRIME.',
};
// parcial no último abastecimento do mês: o 1º da placa no mês seguinte completa o tanque (média muito baixa) e também fica fora
const MOTIVO_PARCIAL = 'Abastecimento parcial', MOTIVO_COMPLETOU = 'Completou o abastecimento parcial';
const AVISO_COMPLETOU = 'Completou o tanque do abastecimento parcial do fim do mês anterior: fica fora do PRIME.';
const fPct2 = new Intl.NumberFormat('pt-BR', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : fPct2.format(v));   // % da meta: 00,00%
const PASSO = 50;
const ymDeMes = (m) => Math.floor(m / 12) + '-' + String((m % 12) + 1).padStart(2, '0');
const mesDeYm = (s) => { const [a, b] = s.split('-').map(Number); return a * 12 + b - 1; };
const hora = (seg) => (seg === null || seg === undefined ? '' : String(Math.floor(seg / 3600)).padStart(2, '0') + ':' + String(Math.floor(seg / 60) % 60).padStart(2, '0'));
const chaveDe = (l) => l.placa + '|' + l.dia + '|' + Math.round(l.hodometro || 0);
const estrelasTxt = (n) => (n ? '★'.repeat(n) : '—');
const rs = (v) => (v ? 'R$ ' + fmt.int(v) : '—');
const num = (s) => { const t = String(s ?? '').trim().replace(/\./g, '').replace(',', '.'); return t === '' ? null : Number(t); };

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando o Programa PRIME…</div>';
  let dados;
  try { dados = await carregarDados(); } catch (e) { pagina.innerHTML = '<div class="vazio">' + esc(e.message) + '</div>'; return {}; }

  // mês padrão: o mês passado (o fechamento é feito depois que o mês acaba)
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const mesAtual = mesDoDia(Math.floor(Date.now() / 864e5));
  let mes = /^\d{4}-\d{2}$/.test(q.get('mes') || '') ? mesDeYm(q.get('mes')) : mesAtual - 1;
  let aba = ['ranking', 'abastecimentos', 'telemetria', 'encarregados', 'parametros'].includes(q.get('aba')) ? q.get('aba') : 'ranking';
  let api = null, calc = null, ocupado = false;
  // nomes para "Motorista deste abastecimento": cadastro + ranking + quem abasteceu na Base nos últimos 12 meses
  // (ex.: ITAMAR QUITO ROSENO não está no cadastro nem no PRIME, mas abastece; trocar para ele junta o abastecimento aos dele)
  let nomesBase = null;
  const nomesParaTroca = () => {
    if (!nomesBase) {
      const fim = dados.linhas.reduce((m, l) => Math.max(m, l.dia || 0), 0);
      nomesBase = dados.linhas.filter((l) => l.motorista && l.dia >= fim - 365).map((l) => l.motorista);
    }
    const porChave = new Map();
    for (const n of [...(api.cadastro || []).map((c) => c.nome), ...calc.ranking.map((r) => r.nome), ...nomesBase]) {
      const nome = String(n || '').trim().replace(/\s+/g, ' '), k = chaveNome(nome);
      if (k && !porChave.has(k)) porChave.set(k, nome);
    }
    return [...porChave.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  };
  const filtroAb = { busca: '', situacao: 'todos', limite: PASSO };
  const filtroTel = { ver: 'todos', busca: '' };
  let limiteRank = PASSO;
  let buscaRank = '';   // busca por motorista no ranking
  // ordenação por coluna em cada aba ({campo, dir}; null = a ordem padrão) e o motorista aberto no ranking
  const ordem = { ranking: null, abastecimentos: null, telemetria: null, encarregados: null };
  let abertoRank = null;
  let rascunhoEnc = null;   // encarregados sendo editados na aba Parâmetros (adicionar/excluir antes de gravar)

  async function chamar(metodo, corpo) {
    const r = await fetch('/api/prime' + (metodo === 'GET' ? '?mes=' + ymDeMes(mes) : ''), {
      method: metodo, credentials: 'same-origin', cache: 'no-store',
      headers: corpo ? { 'Content-Type': 'application/json' } : undefined, body: corpo ? JSON.stringify({ mes: ymDeMes(mes), ...corpo }) : undefined,
    });
    if (r.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || 'Não foi possível falar com o servidor (' + r.status + ').');
    return j;
  }
  const aviso = (t) => (ctx.aviso ? ctx.aviso(t) : alert(t));

  // ---------------- cálculo ----------------
  function parametros() {
    const p = api && api.parametros ? api.parametros : {};
    return { ...PADRAO, ...p };
  }
  function calcular() {
    const P = parametros();
    const ini = inicioDoMes(mes), fim = inicioDoMes(mes + 1) - 1, iniAnt = inicioDoMes(mes - 1);
    const dec = new Map((api.decisoes || []).map((d) => [d.chave, d]));
    const excl = new Set(P.excluidos.map(chaveNome));
    // diesel da Base e das APIs dos cartões que a Base ainda não tem (selo API), do mês anterior (para achar o parcial do fim dele) e deste mês
    const porPlaca = new Map();
    for (const l of dados.linhas) {
      if (l.dia < iniAnt || l.dia > fim || !ehDiesel(l.combustivel)) continue;
      (porPlaca.get(l.placa) || porPlaca.set(l.placa, []).get(l.placa)).push(l);
    }
    const linhas = [];   // abastecimentos do mês, com a decisão e o km que vale no PRIME
    for (const ls of porPlaca.values()) {
      ls.sort((a, b) => a.dia - b.dia || (a.seg ?? 0) - (b.seg ?? 0) || (a.hodometro || 0) - (b.hodometro || 0));
      let ant = null;
      for (const l of ls) {
        const d = dec.get(chaveDe(l));
        let fora = !!(d && !d.entra), completou = null;
        // o anterior da placa foi o último do mês dele e saiu por parcial: este (1º do mês seguinte) completa o tanque e sai junto
        // da média (o km de cada um continua no km rodado do mês dele)
        if (!fora && ant && ant.fora && ant.motivo === MOTIVO_PARCIAL && mesDoDia(ant.l.dia) < mesDoDia(l.dia)) { fora = true; completou = ant; ant.parcialFim = true; }
        const doMes = l.dia >= ini;
        const item = { l, chave: chaveDe(l), d, fora, km: l.km || 0, motorista: (d && d.motorista_para) || l.motorista, completou,
          motivo: completou ? MOTIVO_COMPLETOU : d && d.motivo, aviso: completou ? AVISO_COMPLETOU : d && d.aviso };
        if (doMes) linhas.push(item);
        ant = item;
      }
      // parcial no último abastecimento do mês: o 1º do mês seguinte também vai sair (avisado já agora)
      if (ant && ant.fora && ant.motivo === MOTIVO_PARCIAL && !ant.completou) ant.parcialFim = true;
    }
    linhas.sort((a, b) => b.l.dia - a.l.dia || (b.l.seg ?? 0) - (a.l.seg ?? 0));

    // por motorista: km rodado = todos os abastecimentos do mês (os tirados também); média e meta = só os que entram
    const mot = new Map();
    for (const it of linhas) {
      const k = chaveNome(it.motorista);
      if (!k || excl.has(k) || k === '(SEM MOTORISTA)') continue;
      let m = mot.get(k);
      if (!m) mot.set(k, (m = { chave: k, nome: it.motorista, km: 0, kmMedia: 0, litros: 0, kmMeta: 0, litrosMeta: 0, qtd: 0, ultimo: null }));
      m.km += it.km;
      if (it.fora) continue;
      m.kmMedia += it.km; m.litros += it.l.litros || 0; m.qtd++;
      if (it.l.meta) { m.kmMeta += it.km; m.litrosMeta += it.km / it.l.meta; }
      if (!m.ultimo || it.l.dia > m.ultimo.dia || (it.l.dia === m.ultimo.dia && (it.l.seg ?? 0) > (m.ultimo.seg ?? 0))) m.ultimo = it.l;
    }
    const tel = new Map(((api.telemetria && api.telemetria.linhas) || []).map((t) => [chaveNome(t.nome), t]));
    const notas = new Map((api.notas || []).map((n) => [n.motorista, n]));
    const cad = new Map((api.cadastro || []).map((c) => [chaveNome(c.nome), c]));
    const minPremio = Math.min(...P.ss.map((x) => x[0]));
    const estrelas = (n) => (n === null ? 0 : P.estrelas.filter((x) => n >= x).length);
    const premioSS = (n) => { if (n === null) return 0; const f = P.ss.find((x) => n >= x[0]); return f ? f[1] : 0; };
    const faixaKm = (km) => P.faixasKm.find((f) => km >= f) ?? null;
    const premioComb = (km, pct) => {
      const i = P.faixasKm.findIndex((f) => km >= f);
      if (i < 0 || pct === null) return 0;
      const j = P.pctMeta.findIndex((p) => pct >= p);
      return j < 0 ? 0 : P.combustivel[i][j];
    };
    const ranking = [...mot.values()].map((m) => {
      const t = tel.get(m.chave) || null, manual = notas.get(m.chave) || null;
      const cobertura = t && t.km !== null && t.km !== undefined && m.km ? t.km / m.km : null;
      let nota = null, origem = 'falta', porque = '';
      if (manual) { nota = manual.nota; origem = 'manual'; porque = manual.motivo || ''; }
      else if (t && t.pontos !== null) {
        if (cobertura === null || cobertura >= P.coberturaMin) { nota = t.pontos; origem = 'telemetria'; }
        else if (t.pontos < minPremio) { nota = t.pontos; origem = 'telemetria'; porque = 'cobertura de ' + fmt.pct(cobertura) + ', mas a nota não dá prêmio'; }
        else porque = 'a telemetria cobriu ' + fmt.pct(cobertura) + ' do km: a nota ' + fmt.d2(t.pontos) + ' não vale';
      } else porque = 'sem telemetria (carro sem SS)';
      const meta = m.litrosMeta ? m.kmMeta / m.litrosMeta : null;
      const media = m.litros ? m.kmMedia / m.litros : null;
      const pct = meta && media ? media / meta : null;
      const semKm = m.km < (P.kmMinimo || 0);   // abaixo do km mínimo: sem prêmio de telemetria nem de combustível
      const pSS = semKm ? 0 : premioSS(nota), pC = semKm ? 0 : premioComb(m.km, pct);
      return {
        ...m, unidade: m.ultimo ? m.ultimo.cc : '', tel: t, manual, cobertura, nota, origem, porque, estrelas: estrelas(nota),
        meta, media, pct, faixa: faixaKm(m.km), premioSS: pSS, premioComb: pC, total: pSS + pC, cadastro: cad.get(m.chave) || null,
      };
    }).sort((a, b) => (b.nota ?? -999) - (a.nota ?? -999) || b.km - a.km);

    // encarregados: nota ponderada pelo km e % da meta das unidades deles
    const encarregados = P.encarregados.map((e) => {
      const uni = new Set(e.unidades.map((u) => chaveNome(u)));
      const ms = ranking.filter((r) => uni.has(chaveNome(r.unidade)));
      const comNota = ms.filter((r) => r.nota !== null && r.km);
      const kmN = comNota.reduce((s, r) => s + r.km, 0);
      const nota = kmN ? comNota.reduce((s, r) => s + r.nota * r.km, 0) / kmN : null;
      const km = ms.reduce((s, r) => s + (r.kmMedia ?? r.km), 0), litros = ms.reduce((s, r) => s + r.litros, 0);   // média: só os que entram
      const kmMeta = ms.reduce((s, r) => s + r.kmMeta, 0), litrosMeta = ms.reduce((s, r) => s + r.litrosMeta, 0);
      const pct = litros && litrosMeta ? (km / litros) / (kmMeta / litrosMeta) : null;
      const fSS = nota === null ? null : P.encSS.find((x) => nota >= x[0]);
      const fC = pct === null ? null : P.encComb.find((x) => pct >= x[0]);
      const pSS = fSS ? fSS[1] : 0, pC = fC ? fC[1] : 0;
      return { ...e, motoristas: ms.length, nota, estrelas: estrelas(nota), pct, premioSS: pSS, premioComb: pC, total: pSS + pC };
    });
    // motoristas da telemetria sem abastecimento no ranking (saíram, sem cadastro, nome diferente)
    const semRanking = [...tel.values()].filter((t) => !mot.has(chaveNome(t.nome)) && !excl.has(chaveNome(t.nome)));
    return { P, linhas, ranking, encarregados, semRanking, faltando: ranking.filter((r) => r.nota === null) };
  }

  // ---------------- tela ----------------
  pagina.innerHTML = `
    <section class="painel pr-topo">
      <div class="pr-mes">
        <label class="filtro-rotulo" for="pr-mes">Mês do fechamento</label>
        <select id="pr-mes" class="campo-sel"></select>
        <span id="pr-situacao"></span>
      </div>
      <div class="acoes-cab">
        <button type="button" class="btn" id="pr-baixar"><svg aria-hidden="true"><use href="#i-baixar"/></svg><span class="txt">Baixar</span></button>
        <button type="button" class="btn oculto" id="pr-reabrir">Reabrir mês</button>
        <button type="button" class="btn btn-principal oculto" id="pr-fechar">Fechar mês</button>
      </div>
    </section>
    <div class="aviso-pendencias oculto" id="pr-faltando" role="status"></div>
    <dl class="apoio apoio-pilha" id="pr-resumo"></dl>
    <section class="painel painel-tabela">
      <div class="painel-cab"><div class="segmentado" id="pr-abas" role="group" aria-label="Parte do fechamento"></div><span class="conta" id="pr-conta"></span></div>
      <div id="pr-corpo"></div>
    </section>
    <dialog class="dialogo" id="pr-dlg" aria-labelledby="pr-dlg-titulo">
      <form method="dialog" id="pr-form">
        <h2 id="pr-dlg-titulo">Tirar do PRIME</h2>
        <p class="dialogo-explica" id="pr-dlg-sub"></p>
        <div class="grade-form">
          <label class="pr-so-decidir">Situação no PRIME
            <select name="entra" class="campo-sel"><option value="0">Não entra no PRIME</option><option value="1">Entra no PRIME</option></select></label>
          <label class="pr-so-fora">Motivo
            <select name="motivo" class="campo-sel">${MOTIVOS.map((m) => '<option>' + esc(m) + '</option>').join('')}</select></label>
          <label class="pr-so-fora pr-largo">Aviso ao motorista (aparece na área dele)
            <textarea name="aviso" rows="3" maxlength="300"></textarea></label>
          <label class="pr-largo">Motorista deste abastecimento (troca também nos abastecimentos e no resto do portal; vazio = o original)
            <input name="para" list="pr-motoristas" autocomplete="off" maxlength="120"></label>
        </div>
        <datalist id="pr-motoristas"></datalist>
        <p class="erro-form oculto" id="pr-dlg-erro"></p>
        <div class="dialogo-acoes"><button type="button" class="btn" data-fechar>Cancelar</button><button type="submit" class="btn btn-principal" id="pr-dlg-ok">Gravar</button></div>
      </form>
    </dialog>`;
  const el = (id) => pagina.querySelector('#' + id);
  const editavel = () => api && api.podeEditar && api.situacao !== 'fechado';
  const fechado = () => api && api.situacao === 'fechado';

  function escreverURL() {
    const novo = '#/programa-prime?mes=' + ymDeMes(mes) + (aba !== 'ranking' ? '&aba=' + aba : '');
    if (location.hash !== novo) history.replaceState(null, '', novo);
  }

  async function carregar(silencioso) {
    if (!silencioso) el('pr-corpo').innerHTML = '<div class="carregando"><div class="giro"></div>Carregando ' + esc(fmtMes(mes, true)) + '…</div>';
    try { api = await chamar('GET'); } catch (e) { if (e.message !== 'sessão' && el('pr-corpo')) el('pr-corpo').innerHTML = '<div class="vazio">' + esc(e.message) + '</div>'; return; }
    if (!pagina.isConnected || !el('pr-corpo')) return;   // saiu da tela antes de a resposta chegar
    calc = calcular();
    desenhar();
  }

  function desenharMeses() {
    // os últimos 12 meses com abastecimento na Base, mais os já fechados
    const ate = Math.min(mesAtual, mesDoDia(dados.diaMax));
    const opcoes = new Set();
    for (let m = ate; m > ate - 12; m--) opcoes.add(m);
    (api && api.meses || []).forEach((x) => opcoes.add(mesDeYm(x.mes)));
    opcoes.add(mes);
    const sit = new Map((api && api.meses || []).map((x) => [x.mes, x.situacao]));
    el('pr-mes').innerHTML = [...opcoes].sort((a, b) => b - a).map((m) => '<option value="' + m + '"' + (m === mes ? ' selected' : '') + '>' +
      esc(fmtMes(m, true)) + (sit.get(ymDeMes(m)) === 'fechado' ? ' · fechado' : '') + '</option>').join('');
  }

  // posição da rolagem (a lista com rolagem própria, o detalhe do motorista e a página): redesenhar a mesma aba não volta ao início
  let abaDesenhada = null;
  function rolagens() {
    const r = [];
    for (let n = el('pr-corpo'); n; n = n.parentElement) if (n.scrollTop) r.push([n, n.scrollTop]);
    const lista = el('pr-corpo').querySelector('.tabela-rolagem'), det = el('pr-corpo').querySelector('.pr-det-rolagem');
    return { r, lista: lista ? lista.scrollTop : 0, det: det ? det.scrollTop : 0 };
  }
  function desenhar() {
    const mesmaAba = abaDesenhada === aba, antes = mesmaAba ? rolagens() : null;
    desenharTela();
    abaDesenhada = aba;
    desenharFlutuante();   // a seleção continua ao trocar de aba ou redesenhar (as contas podem ter mudado)
    if (!antes) return;
    const lista = el('pr-corpo').querySelector('.tabela-rolagem'), det = el('pr-corpo').querySelector('.pr-det-rolagem');
    if (lista) lista.scrollTop = antes.lista;
    if (det) det.scrollTop = antes.det;
    for (const [n, y] of antes.r) n.scrollTop = y;
  }
  function desenharTela() {
    escreverURL();
    desenharMeses();
    const fech = fechado();
    // mês fechado: o resultado gravado no fechamento (não recalcula com dados que chegaram depois)
    const ranking = fech && api.resultado ? api.resultado : calc.ranking;
    el('pr-situacao').innerHTML = fech
      ? '<span class="sit sit-ok">Fechado</span> <span class="nota">por ' + esc(api.fechadoPor || '—') + (api.fechadoEm ? ' em ' + esc(new Date(api.fechadoEm).toLocaleDateString('pt-BR')) : '') + '</span>'
      : '<span class="sit sit-alerta">Em aberto</span>' + (calc.faltando.length ? ' <button type="button" class="sit sit-ruim pr-selo-falta" data-ir-faltando title="O mês só fecha com todas as notas preenchidas. Clique para preencher.">' +
        fmt.int(calc.faltando.length) + ' sem nota</button>' : '');
    el('pr-fechar').classList.toggle('oculto', !editavel());
    el('pr-fechar').disabled = calc.faltando.length > 0 || !calc.ranking.length;
    el('pr-fechar').title = calc.faltando.length ? 'Preencha as ' + calc.faltando.length + ' notas que faltam para fechar o mês' : '';
    el('pr-reabrir').classList.toggle('oculto', !(fech && api.admin));
    const falt = fech ? 0 : calc.faltando.length;
    el('pr-faltando').classList.add('oculto');
    const fora = calc.linhas.filter((i) => i.fora).length;
    const tot = (k) => ranking.reduce((s, r) => s + (r[k] || 0), 0);
    el('pr-resumo').innerHTML = [
      ['Motoristas no ranking', fmt.int(ranking.length)],
      ['Abastecimentos que entram', fmt.int(calc.linhas.length - fora) + ' de ' + fmt.int(calc.linhas.length)],
      ['Prêmio telemetria', rs(tot('premioSS'))],
      ['Prêmio combustível', rs(tot('premioComb'))],
      ['Total motoristas', rs(tot('total'))],
      ['Encarregados', rs(((fech && api.parametros && api.parametros.resultadoEncarregados) || calc.encarregados).reduce((s, e) => s + (e.total || 0), 0))],
    ].map(([r, v]) => '<div><dt>' + esc(r) + '</dt><dd><span class="num">' + esc(v) + '</span></dd></div>').join('');
    const ABAS = [['ranking', 'Ranking'], ['abastecimentos', 'Abastecimentos' + (fora ? ' (' + fora + ' fora)' : '')], ['telemetria', 'Telemetria e notas' + (falt ? ' (' + falt + ' sem nota)' : '')],
      ['encarregados', 'Encarregados'], ['parametros', 'Parâmetros']];
    el('pr-abas').innerHTML = ABAS.map(([k, r]) => '<button type="button" data-aba="' + k + '" aria-pressed="' + (k === aba) + '">' + esc(r) + '</button>').join('');
    ({ ranking: desenharRanking, abastecimentos: desenharAbastecimentos, telemetria: desenharTelemetria, encarregados: desenharEncarregados, parametros: desenharParametros })[aba](ranking);
  }

  // cabeçalho que ordena ao clicar (como nas outras telas) e a ordenação de cada aba
  const th = (abaOrd, campo, rot, n) => {
    const o = ordem[abaOrd], ativa = o && o.campo === campo;
    return '<th' + (n ? ' class="n"' : '') + ' aria-sort="' + (ativa ? (o.dir > 0 ? 'ascending' : 'descending') : 'none') + '"><button type="button" data-ord="' + campo + '">' +
      esc(rot) + (ativa ? '<span class="seta">' + (o.dir > 0 ? '▲' : '▼') + '</span>' : '') + '</button></th>';
  };
  function ordenar(lista, abaOrd, valores) {
    const o = ordem[abaOrd];
    if (!o || !valores[o.campo]) return lista;
    const v = valores[o.campo];
    return lista.slice().sort((a, b) => {
      const x = v(a), y = v(b);
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return o.dir * (typeof x === 'string' ? x.localeCompare(y, 'pt-BR', { numeric: true }) : x - y);
    });
  }
  // % do tanque: litros ÷ capacidade do tanque da placa (cadastro), como na Operação por motorista
  const pctTanque = (l) => (l.tanque ? l.litros / l.tanque : null);
  // Km/L colorido pelas faixas do % da meta da placa (as mesmas das outras telas) e a meta ao lado
  const kmlHtml = (kmL, meta) => (!kmL ? '—' : meta ? metaHtml(kmL / meta, fmt.d2(kmL)) : '<span class="num">' + fmt.d2(kmL) + '</span>');
  const VAL_ABAST = {
    data: (it) => it.l.dia * 86400 + (it.l.seg || 0), placa: (it) => it.l.placa, motorista: (it) => it.motorista, posto: (it) => it.l.fornecedor || '',
    hodo: (it) => it.l.hodometro, km: (it) => it.km, litros: (it) => it.l.litros, tanque: (it) => pctTanque(it.l), meta: (it) => it.l.meta || null, kml: (it) => (!it.fora && it.l.litros ? it.km / it.l.litros : null), prime: (it) => (it.fora ? 1 : 0),
  };
  // abastecimentos do mês de um motorista (os que entram e os tirados), para decidir pelo próprio ranking
  function abastecimentosDe(chave) {
    return calc.linhas.filter((it) => chaveNome(it.motorista) === chave || (it.fora && chaveNome(it.l.motorista) === chave));
  }
  function htmlDetalheMotorista(r) {
    const ed = editavel();
    const ls = abastecimentosDe(r.chave).sort((a, b) => a.l.dia - b.l.dia || (a.l.seg || 0) - (b.l.seg || 0));
    if (!ls.length) return '<div class="vazio">Nenhum abastecimento deste motorista no mês.</div>';
    return '<div class="pr-det-rolagem"><table class="dados pr-tabela pr-det-tab"><thead><tr><th><span>Abastecimento</span></th><th><span>Posto</span></th><th class="n"><span>Hodômetro</span></th><th class="n"><span>Km</span></th>' +
      '<th class="n"><span>Litros</span></th><th class="n"><span>% tanque</span></th><th class="n"><span>Km/L</span></th><th class="n"><span>Meta</span></th><th><span>PRIME</span></th></tr></thead><tbody>' +
      ls.map((it) => {
        const l = it.l, idx = calc.linhas.indexOf(it), kmL = !it.fora && l.litros ? it.km / l.litros : null;
        return '<tr' + attrSel(it) + '><td class="pr-abast-id"><strong>' + esc(l.placa) + '</strong> ' + seloCartao(l.cartao) + (l.tempoReal ? ' <span class="selo-tempo-real" title="Veio da API do cartão hoje; entra nos abastecimentos no dia seguinte (D-1)">API</span>' : '') +
          '<small class="cidade-linha num">' + esc(fmtDia(l.dia)) + ' ' + esc(hora(l.seg)) + '</small></td><td>' + esc(l.fornecedor || '—') + '</td>' +
          '<td class="n num">' + fmt.int(l.hodometro) + '</td>' +
          '<td class="n"><span class="num">' + fmt.int(it.fora ? l.km : it.km) + '</span>' + notaKm(it) + '</td>' +
          '<td class="n num">' + fmt.d2(l.litros) + '</td><td class="n num">' + fmt.pct(pctTanque(l)) + '</td><td class="n">' + kmlHtml(kmL, l.meta) + '</td><td class="n num">' + (l.meta ? fmt.d2(l.meta) : '—') + '</td>' +
          '<td class="pr-acao">' + seloPrime(it) + (ed ? botaoDecidir(it, idx) : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  // ----- seleção de abastecimentos (clique na linha; Ctrl soma, Shift pega o intervalo): média real x meta na barra de baixo -----
  // igual à Operação por motorista. Vale no detalhe do ranking e na aba Abastecimentos; a chave é a do abastecimento (it.chave).
  const selAb = new Set();
  let ancoraAb = null;
  const attrSel = (it) => {
    const s = selAb.has(it.chave);
    return ' class="pr-sel-linha' + (it.fora ? ' pr-fora' : '') + (s ? ' selecionado' : '') + '" data-ab="' + esc(it.chave) + '" tabindex="0" aria-selected="' + s + '"';
  };
  function selecionarAb(tr, e) {
    const k = tr.dataset.ab;
    const seq = [...tr.closest('tbody').querySelectorAll('tr[data-ab]')].map((r) => r.dataset.ab);
    const iA = ancoraAb === null ? -1 : seq.indexOf(ancoraAb), i = seq.indexOf(k);
    if (e.shiftKey && iA >= 0) {
      if (!(e.ctrlKey || e.metaKey)) selAb.clear();
      for (let x = Math.min(i, iA); x <= Math.max(i, iA); x++) selAb.add(seq[x]);
    } else if (e.ctrlKey || e.metaKey) {
      if (selAb.has(k)) selAb.delete(k); else selAb.add(k);
      ancoraAb = k;
    } else {
      const so = selAb.size === 1 && selAb.has(k);   // clicou de novo no único selecionado: limpa
      selAb.clear();
      if (!so) selAb.add(k);
      ancoraAb = k;
    }
    marcarSelecao();
  }
  // só troca as classes (sem redesenhar: a lista não pula) e refaz a barra
  function marcarSelecao() {
    el('pr-corpo').querySelectorAll('tr[data-ab]').forEach((r) => {
      const s = selAb.has(r.dataset.ab);
      r.classList.toggle('selecionado', s);
      r.setAttribute('aria-selected', s);
    });
    desenharFlutuante();
  }
  // barra fixa embaixo (no <body>: a .pagina é container de CSS e prenderia o position:fixed); sai junto com a tela
  const flutuante = document.createElement('div');
  flutuante.className = 'sel-flutuante oculto';
  flutuante.setAttribute('role', 'region');
  flutuante.setAttribute('aria-label', 'Média real dos abastecimentos selecionados contra a meta');
  flutuante.setAttribute('aria-live', 'polite');
  document.body.appendChild(flutuante);
  flutuante.addEventListener('click', (e) => { if (e.target.closest('[data-limpar-selecao]')) { selAb.clear(); ancoraAb = null; marcarSelecao(); } });
  function desenharFlutuante() {
    const its = calc ? calc.linhas.filter((it) => selAb.has(it.chave)) : [];
    const ver = its.length > 0;
    flutuante.classList.toggle('oculto', !ver);
    document.body.classList.toggle('com-sel-flutuante', ver);
    if (!ver) { flutuante.innerHTML = ''; return; }
    // média real: km do PRIME ÷ litros, só dos que entram (os tirados não entram na média); meta ponderada pelo km
    let km = 0, litros = 0, kmMeta = 0, litrosComMeta = 0, litrosMeta = 0;
    const conta = its.filter((it) => !it.fora && it.l.litros > 0);
    for (const it of conta) {
      km += it.km || 0; litros += it.l.litros;
      if (it.l.meta) { kmMeta += it.km || 0; litrosComMeta += it.l.litros; litrosMeta += (it.km || 0) / it.l.meta; }
    }
    const media = litros ? km / litros : null, metaMedia = litrosMeta ? kmMeta / litrosMeta : null;
    const mediaComMeta = litrosComMeta ? kmMeta / litrosComMeta : null, p = mediaComMeta && metaMedia ? mediaComMeta / metaMedia : null;
    const econ = litrosMeta - litrosComMeta, fora = its.length - conta.length, n = its.length;
    flutuante.innerHTML =
      '<div class="sf-media"><span class="sf-rot">Média real contra a meta</span>' +
        '<span class="sf-num"><strong class="num">' + (media ? fmt.d2(media) : '—') + '</strong> km/L' +
        (metaMedia ? '<small> · meta ' + fmt.d2(metaMedia) + '</small>' : '') + '</span></div>' +
      '<div class="sf-pct">' + (p !== null ? metaHtml(p, fmt.pct(p) + ' da meta') : '<span class="sem-dado">sem meta</span>') + '</div>' +
      '<div class="sf-det"><span>' + fmt.int(n) + (n === 1 ? ' abastecimento selecionado' : ' abastecimentos selecionados') + ' · ' + fmt.int(km) + ' km · ' + fmt.d2(litros) + ' L</span>' +
        (litrosMeta ? '<span>' + fmt.d2(Math.abs(econ)) + ' L ' + (econ >= 0 ? 'de economia' : 'gastos a mais') + '</span>' : '') +
        (fora ? '<span>' + fmt.int(fora) + (fora === 1 ? ' tirado do PRIME (fora da média)' : ' tirados do PRIME (fora da média)') + '</span>' : '') + '</div>' +
      '<div class="sf-acoes"><button type="button" class="link-acao" data-limpar-selecao>Limpar seleção</button></div>';
  }

  // texto do km embaixo do número, a pílula Entra/Fora e o botão de decidir (iguais no detalhe do ranking e na aba Abastecimentos)
  const notaKm = (it) => (it.completou ? '<small class="cidade-linha">completou o parcial de ' + esc(fmtDia(it.completou.l.dia).slice(0, 5)) + '; km conta, média não</small>'
      : it.parcialFim ? '<small class="cidade-linha">km conta, média não; o 1º do mês seguinte também sai da média</small>'
      : it.fora ? '<small class="cidade-linha">km conta, média não</small>' : '');
  const seloPrime = (it) => (it.fora ? '<span class="sit sit-ruim" title="' + esc(it.aviso || '') + '">Fora: ' + esc(it.motivo || '') + '</span>' : '');
  const botaoDecidir = (it, idx) => '<button type="button" class="btn-linha" data-decidir="' + idx + '" title="' + (it.completou ? 'Trocar o motorista' : it.fora ? 'Voltar para o PRIME, mudar o motivo ou o motorista' : 'Tirar do PRIME ou trocar o motorista') + '">' +
    (it.completou ? 'Motorista' : it.fora ? 'Mudar' : 'Tirar / trocar') + '</button>';
  const notaHtml = (r) => {
    if (r.nota === null || r.nota === undefined) return '<span class="sit sit-ruim" title="' + esc(r.porque || '') + '">sem nota</span>';
    return '<strong class="num">' + fmt.d2(r.nota) + '</strong> <span class="pr-estrelas" aria-label="' + r.estrelas + ' estrelas">' + estrelasTxt(r.estrelas) + '</span>' +
      (r.origem === 'manual' ? '<small class="cidade-linha">manual' + (r.tel && r.tel.pontos !== null ? ' · telemetria ' + fmt.d2(r.tel.pontos) : '') + '</small>' : '');
  };

  // economia de cada motorista (26/11/2026, pedido do usuário: colunas de litros e valor economizado no ranking), a mesma conta
  // do Resultado PRIME: litros = litros pela meta (km ÷ meta da placa) − litros abastecidos; negativo = gastou mais que a meta;
  // valor = litros × preço médio do diesel do mês no centro de custo do motorista (todos os abastecimentos de diesel do mês;
  // sem abastecimento no centro de custo, a média geral). Vale também para o mês fechado (o resultado gravado tem litros e litrosMeta).
  let precoCache = null;
  function precoDiesel() {
    if (precoCache && precoCache.mes === mes) return precoCache;
    const ini = inicioDoMes(mes), fim = inicioDoMes(mes + 1) - 1, por = new Map();
    let v = 0, l = 0;
    for (const x of dados.linhas) {
      if (x.dia < ini || x.dia > fim || !ehDiesel(x.combustivel) || !(x.litros > 0)) continue;
      const a = por.get(x.cc) || { v: 0, l: 0 };
      a.v += x.despesa || 0; a.l += x.litros; por.set(x.cc, a);
      v += x.despesa || 0; l += x.litros;
    }
    precoCache = { mes, por, geral: l ? v / l : null };
    return precoCache;
  }
  const litrosEcon = (r) => (r.litrosMeta ? r.litrosMeta - (r.litros || 0) : null);
  function valorEcon(r) {
    const e = litrosEcon(r);
    if (e === null) return null;
    const pr = precoDiesel(), a = pr.por.get(r.unidade), pm = a && a.l ? a.v / a.l : pr.geral;
    return pm ? e * pm : null;
  }
  const econHtml = (v, txt) => (v === null ? '—' : '<span class="num' + (v < 0 ? ' neg-txt' : '') + '">' + txt + '</span>');

  function desenharRanking(ranking) {
    el('pr-conta').textContent = fmt.int(ranking.length) + ' motoristas';
    if (!ranking.length) { el('pr-corpo').innerHTML = '<div class="vazio">Nenhum abastecimento de diesel neste mês.</div>'; return; }
    // # = posição no ranking (não muda ao ordenar por outra coluna); clicar no motorista abre os abastecimentos dele
    const pos = new Map(ranking.map((r, i) => [r.chave, i + 1]));
    const tb = chaveNome(buscaRank);
    const lista = ordenar(ranking.filter((r) => !tb || chaveNome(r.nome + ' ' + (r.unidade || '')).includes(tb)), 'ranking', { pos: (r) => pos.get(r.chave), nome: (r) => r.nome, nota: (r) => r.nota, km: (r) => r.km, media: (r) => r.media,
      pct: (r) => r.pct, econL: litrosEcon, econR: valorEcon, premioSS: (r) => r.premioSS, premioComb: (r) => r.premioComb, total: (r) => r.total });
    if (tb) el('pr-conta').textContent = fmt.int(lista.length) + ' de ' + fmt.int(ranking.length) + ' motoristas';
    el('pr-corpo').innerHTML = '<div class="tabela-ferramentas"><input type="search" id="pr-rank-busca" placeholder="Motorista ou unidade…" aria-label="Procurar motorista no ranking" value="' + esc(buscaRank) + '"></div>' +
      '<div class="tabela-rolagem tabela-alta pr-alta"><table class="dados pr-tabela pr-rank"><thead><tr>' + th('ranking', 'pos', '#', true) + th('ranking', 'nome', 'Motorista') + th('ranking', 'nota', 'Nota telemetria') +
      th('ranking', 'km', 'Km rodado', true) + th('ranking', 'media', 'Média (meta)', true) + th('ranking', 'pct', '% da meta') +
      th('ranking', 'econL', 'Litros economizados', true) + th('ranking', 'econR', 'Valor economizado', true) + th('ranking', 'premioSS', 'Prêmio telemetria', true) +
      th('ranking', 'premioComb', 'Prêmio combustível', true) + th('ranking', 'total', 'Total', true) + '</tr></thead><tbody>' +
      lista.map((r) => '<tr class="pr-linha-mot' + (abertoRank === r.chave ? ' selecionado' : '') + '" data-mot="' + esc(r.chave) + '" tabindex="0" aria-expanded="' + (abertoRank === r.chave) + '">' +
        '<td class="n num pr-pos">' + pos.get(r.chave) + '</td><td class="pr-nome"><strong>' + esc(r.nome) + '</strong><small class="cidade-linha">' + esc(r.unidade || '—') + '</small></td>' +
        '<td data-rot="Nota telemetria">' + notaHtml(r) + '</td><td class="n" data-rot="Km rodado"><span class="num">' + fmt.int(r.km) + '</span><small class="cidade-linha">' + (r.km < (calc.P.kmMinimo || 0) ? 'abaixo de ' + fmt.int(calc.P.kmMinimo) + ' km: sem prêmio' : r.faixa ? 'faixa ' + fmt.int(r.faixa) : 'abaixo de ' + fmt.int(Math.min(...calc.P.faixasKm))) + '</small></td>' +
        '<td class="n" data-rot="Média (meta)"><span class="num">' + (r.media ? fmt.d2(r.media) : '—') + '</span><small class="cidade-linha">meta ' + (r.meta ? fmt.d2(r.meta) : '—') + '</small></td>' +
        '<td data-rot="% da meta">' + (r.pct ? metaHtml(r.pct, pct2(r.pct)) : '—') + '</td>' +
        '<td class="n" data-rot="Litros economizados">' + econHtml(litrosEcon(r), fmt.d2(litrosEcon(r)) + ' L') + '</td>' +
        '<td class="n" data-rot="Valor economizado">' + econHtml(valorEcon(r), 'R$ ' + fmt.d2(valorEcon(r))) + '</td><td class="n num" data-rot="Prêmio telemetria">' + rs(r.premioSS) + '</td><td class="n num" data-rot="Prêmio combustível">' + rs(r.premioComb) + '</td>' +
        '<td class="n pr-total" data-rot="Total"><strong class="num">' + rs(r.total) + '</strong></td></tr>' +
        (abertoRank === r.chave ? '<tr class="pr-det"><td colspan="11">' + htmlDetalheMotorista(r) + '</td></tr>' : '')).join('') + '</tbody></table></div>';
  }

  // ----- abastecimentos -----
  function desenharAbastecimentos() {
    const t = chaveNome(filtroAb.busca);
    const lista = ordenar(calc.linhas.filter((it) => (filtroAb.situacao === 'todos' || (filtroAb.situacao === 'fora') === it.fora) &&
      (!t || chaveNome(it.l.placa + ' ' + it.motorista + ' ' + it.l.motorista + ' ' + it.l.fornecedor + ' ' + it.l.cc).includes(t))), 'abastecimentos', VAL_ABAST);
    el('pr-conta').textContent = fmt.int(lista.length) + ' abastecimentos';
    const ed = editavel();
    el('pr-corpo').innerHTML =
      '<div class="tabela-ferramentas"><input type="search" id="pr-busca" placeholder="Placa, motorista, posto ou unidade…" aria-label="Procurar abastecimento" value="' + esc(filtroAb.busca) + '">' +
      '<div class="segmentado" role="group" aria-label="Situação no PRIME">' + [['todos', 'Todos'], ['entra', 'Entram'], ['fora', 'Fora do PRIME']].map(([k, r]) =>
        '<button type="button" data-sit="' + k + '" aria-pressed="' + (filtroAb.situacao === k) + '">' + r + '</button>').join('') + '</div></div>' +
      '<div class="tabela-rolagem tabela-alta pr-alta"><table class="dados pr-tabela pr-abast"><thead><tr>' + th('abastecimentos', 'data', 'Abastecimento') + th('abastecimentos', 'hodo', 'Hodômetro', true) + th('abastecimentos', 'motorista', 'Motorista') +
      th('abastecimentos', 'posto', 'Posto') + th('abastecimentos', 'km', 'Km', true) + th('abastecimentos', 'litros', 'Litros', true) + th('abastecimentos', 'tanque', '% tanque', true) + th('abastecimentos', 'kml', 'Km/L', true) + th('abastecimentos', 'meta', 'Meta', true) +
      th('abastecimentos', 'prime', 'PRIME') + '</tr></thead><tbody>' +
      (lista.length ? lista.map((it) => {
        const l = it.l, idx = calc.linhas.indexOf(it);
        const kmL = !it.fora && l.litros ? it.km / l.litros : null;
        return '<tr' + attrSel(it) + '><td class="pr-abast-id"><strong>' + esc(l.placa) + '</strong> ' + seloCartao(l.cartao) + (l.tempoReal ? ' <span class="selo-tempo-real" title="Veio da API do cartão hoje; entra nos abastecimentos no dia seguinte (D-1)">API</span>' : '') +
          '<small class="cidade-linha num">' + esc(fmtDia(l.dia).slice(0, 5)) + ' ' + esc(hora(l.seg)) + '</small></td><td class="n num">' + fmt.int(l.hodometro) + '</td>' +
          '<td>' + esc(it.motorista) + (it.d && it.d.motorista_para ? '<small class="cidade-linha">nos abastecimentos: ' + esc(l.motorista) + '</small>' : '') + '</td>' +
          '<td>' + esc(l.fornecedor || '—') + '<small class="cidade-linha">' + esc(l.cc) + '</small></td>' +
          '<td class="n"><span class="num">' + fmt.int(it.fora ? l.km : it.km) + '</span>' + notaKm(it) + '</td>' +
          '<td class="n num">' + fmt.d2(l.litros) + '</td><td class="n num">' + fmt.pct(pctTanque(l)) + '</td><td class="n">' + kmlHtml(kmL, l.meta) + '</td><td class="n num">' + (l.meta ? fmt.d2(l.meta) : '—') + '</td>' +
          '<td class="pr-acao">' + seloPrime(it) + (ed ? botaoDecidir(it, idx) : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="10"><div class="vazio">Nenhum abastecimento com esse filtro.</div></td></tr>') + '</tbody></table></div>';
  }

  let decidindo = null;
  function abrirDecisao(it) {
    decidindo = it;
    const f = el('pr-form'), l = it.l;
    el('pr-dlg-sub').textContent = l.placa + ' · ' + fmtDia(l.dia) + ' ' + hora(l.seg) + ' · ' + l.motorista + ' · ' + fmt.int(l.km) + ' km · ' + fmt.d2(l.litros) + ' L · ' + (l.fornecedor || '');
    f.entra.value = it.completou ? '1' : it.fora ? '0' : (it.d && it.d.motorista_para ? '1' : '0');
    f.motivo.value = it.d && it.d.motivo ? it.d.motivo : MOTIVOS[0];
    f.aviso.value = it.d && it.d.aviso ? it.d.aviso : AVISO_PADRAO[f.motivo.value] || '';
    f.para.value = it.d && it.d.motorista_para ? it.d.motorista_para : '';
    el('pr-motoristas').innerHTML = nomesParaTroca().map((n) => '<option value="' + esc(n) + '">').join('');
    el('pr-dlg-erro').classList.add('oculto');
    pagina.querySelector('.pr-so-decidir').classList.toggle('oculto', !!it.completou);
    mostrarCamposFora();
    el('pr-dlg').showModal();
  }
  function mostrarCamposFora() {
    const fora = el('pr-form').entra.value === '0' && !(decidindo && decidindo.completou);
    pagina.querySelectorAll('.pr-so-fora').forEach((x) => x.classList.toggle('oculto', !fora));
    el('pr-dlg-titulo').textContent = decidindo && decidindo.completou ? 'Trocar motorista' : fora ? 'Tirar do PRIME' : 'Abastecimento no PRIME';
  }
  el('pr-form').entra.addEventListener('change', mostrarCamposFora);
  el('pr-form').motivo.addEventListener('change', (e) => {
    const f = el('pr-form');
    if (!f.aviso.value.trim() || Object.values(AVISO_PADRAO).includes(f.aviso.value)) f.aviso.value = AVISO_PADRAO[e.target.value] || '';
  });
  pagina.querySelector('#pr-dlg [data-fechar]').addEventListener('click', () => el('pr-dlg').close());
  el('pr-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!decidindo || ocupado) return;
    const f = el('pr-form'), entra = f.entra.value === '1' || !!decidindo.completou;
    if (!entra && !f.aviso.value.trim()) { el('pr-dlg-erro').textContent = 'Escreva o aviso que o motorista vai ver.'; el('pr-dlg-erro').classList.remove('oculto'); return; }
    ocupado = true; el('pr-dlg-ok').disabled = true;
    try {
      const l = decidindo.l, paraAntes = (decidindo.d && decidindo.d.motorista_para) || '', para = f.para.value.trim();
      await chamar('POST', { acao: 'decidir', itens: [{ chave: decidindo.chave, entra, motivo: f.motivo.value, aviso: f.aviso.value.trim(), motorista_para: para, motorista: l.motorista }] });
      // motorista trocado (ou a troca desfeita): corrige a coluna L da Base_copia; o resto do portal muda quando a Base for atualizada
      const novo = (para || l.motorista).toUpperCase();
      if (chaveNome(para) !== chaveNome(paraAntes) && chaveNome(novo) !== chaveNome(l.motorista) || (!para && paraAntes)) {
        try { await corrigirNaBaseCopia(l, 'L', novo); aviso('Motorista trocado no PRIME e nos abastecimentos (' + novo + '). Os dashboards mudam na próxima publicação.'); }
        catch (err) { if (err.message !== 'sessão') aviso('A troca ficou no PRIME, mas não foi para os abastecimentos: ' + err.message); }
      }
      el('pr-dlg').close();
      await carregar(true);   // sem o 'Carregando': a lista fica onde estava
    } catch (err) {
      if (err.message !== 'sessão') { el('pr-dlg-erro').textContent = err.message; el('pr-dlg-erro').classList.remove('oculto'); }
    } finally { ocupado = false; el('pr-dlg-ok').disabled = false; }
  });

  // ----- telemetria e notas -----
  const infoTel = (T) => fmt.int(T.linhas.length) + ' motoristas · enviada por ' + esc(T.usuario_nome || '—') + ' em ' +
    esc(new Date(T.enviado_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
  function desenharTelemetria() {
    const T = api.telemetria;
    const ed = editavel();
    const t = chaveNome(filtroTel.busca);
    let lista = calc.ranking.filter((r) => (filtroTel.ver === 'todos' || (filtroTel.ver === 'faltando' ? r.nota === null : filtroTel.ver === 'manual' ? r.origem === 'manual' : r.cobertura !== null && r.cobertura < calc.P.coberturaMin)) &&
      (!t || chaveNome(r.nome).includes(t)));
    lista = ordem.telemetria ? ordenar(lista, 'telemetria', { nome: (r) => r.nome, km: (r) => r.km, kmTel: (r) => (r.tel ? r.tel.km : null), cobertura: (r) => r.cobertura,
      pct: (r) => r.pct, notaTel: (r) => (r.tel ? r.tel.pontos : null), nota: (r) => r.nota })
      : lista.sort((a, b) => (a.nota === null) === (b.nota === null) ? a.nome.localeCompare(b.nome, 'pt-BR') : a.nota === null ? -1 : 1);   // padrão: sem nota primeiro
    el('pr-conta').textContent = fmt.int(lista.length) + ' motoristas';
    const cob = (r) => (r.cobertura === null ? '<span class="sem-dado">—</span>'
      : '<span class="num' + (r.cobertura < calc.P.coberturaMin ? ' pr-baixa' : '') + '">' + fmt.pct(r.cobertura) + '</span>');
    el('pr-corpo').innerHTML =
      (ed ? '<label class="cs-arquivo pr-arquivo' + (T ? ' pr-arquivo-ok' : '') + '" id="pr-zona"><input type="file" id="pr-arquivo" accept=".xlsx,.xls" class="sr">' +
        (T ? '<strong>✓ Telemetria anexada: ' + esc(T.arquivo || 'arquivo') + '</strong><span class="nota">' + infoTel(T) + ' · para substituir, arraste outro arquivo aqui ou clique</span>'
          : '<strong>Anexar a exportação da telemetria SS</strong><span class="nota">"Pontuação resumida" (com KM e Pontuação final) do mês. Arraste o arquivo aqui ou clique para escolher.</span>') + '</label>'
        : '<p class="nota">' + (T ? 'Telemetria: <strong>' + esc(T.arquivo || 'arquivo') + '</strong> · ' + infoTel(T) : 'Nenhuma telemetria anexada neste mês.') + '</p>') +
      '<p class="nota" id="pr-tel-info" role="status"></p>' +   // só mostra "Lendo arquivo…" enquanto anexa
      '<div class="tabela-ferramentas"><input type="search" id="pr-tel-busca" placeholder="Motorista…" aria-label="Procurar motorista" value="' + esc(filtroTel.busca) + '">' +
      '<div class="segmentado" role="group" aria-label="Mostrar">' + [['todos', 'Todos'], ['faltando', 'Sem nota'], ['baixa', 'Cobertura baixa'], ['manual', 'Nota manual']].map(([k, r]) =>
        '<button type="button" data-ver="' + k + '" aria-pressed="' + (filtroTel.ver === k) + '">' + r + '</button>').join('') + '</div></div>' +
      '<div class="tabela-rolagem tabela-alta pr-alta"><table class="dados pr-tabela"><thead><tr>' + th('telemetria', 'nome', 'Motorista') + th('telemetria', 'km', 'Km abastecimentos', true) + th('telemetria', 'kmTel', 'Km telemetria', true) +
      th('telemetria', 'cobertura', 'Cobertura', true) + th('telemetria', 'pct', '% da meta') + th('telemetria', 'notaTel', 'Nota telemetria', true) + th('telemetria', 'nota', 'Nota usada') + '</tr></thead><tbody>' +
      (lista.length ? lista.map((r) => '<tr><td class="pr-nome"><strong>' + esc(r.nome) + '</strong><small class="cidade-linha">' + esc(r.unidade || '—') +
        (r.cadastro ? '' : ' · <span class="aviso-linha">sem cadastro no portal</span>') + '</small></td>' +
        '<td class="n num">' + fmt.int(r.km) + '</td><td class="n num">' + (r.tel && r.tel.km !== null ? fmt.int(r.tel.km) : '<span class="sem-dado">—</span>') + '</td><td class="n">' + cob(r) + '</td>' +
        '<td data-rot="% da meta">' + (r.pct ? metaHtml(r.pct, pct2(r.pct)) : '<span class="sem-dado">—</span>') + '</td>' +   // igual ao Ranking
        '<td class="n">' + (r.tel && r.tel.pontos !== null ? '<span class="num' + (r.origem !== 'telemetria' ? ' pr-riscada' : '') + '">' + fmt.d2(r.tel.pontos) + '</span>' : '<span class="sem-dado">sem SS</span>') + '</td>' +
        '<td class="pr-nota">' + (ed
          ? '<input class="campo-tabela' + (r.nota === null ? ' pr-pendente' : '') + '" inputmode="decimal" data-nota="' + esc(r.chave) + '" aria-label="Nota manual de ' + esc(r.nome) + '" value="' + (r.manual ? esc(fmt.d2(r.manual.nota)) : '') + '" placeholder="' + (r.origem === 'telemetria' ? esc(fmt.d2(r.nota)) : 'nota') + '">'
          : '') + (r.nota === null ? '<small class="cidade-linha">' + esc(r.porque) + '</small>' : '<small class="cidade-linha">' + (r.origem === 'manual' ? 'manual' : 'da telemetria') + (r.porque ? ' · ' + esc(r.porque) : '') + ' · ' + estrelasTxt(r.estrelas) + '</small>') + '</td></tr>').join('')
        : '<tr><td colspan="7"><div class="vazio">Nenhum motorista com esse filtro.</div></td></tr>') + '</tbody></table></div>' +
      (calc.semRanking.length ? '<details class="nota nota-mais"><summary>' + calc.semRanking.length + ' nomes da telemetria sem abastecimento no mês (saíram, outro nome ou sem cadastro)</summary><p>' +
        calc.semRanking.map((x) => esc(x.nome) + ' (' + (x.pontos !== null ? fmt.d2(x.pontos) : '—') + ')').join(' · ') + '</p></details>' : '');
    const zona = el('pr-zona');
    if (zona) {
      el('pr-arquivo').addEventListener('change', (e) => { if (e.target.files[0]) anexar(e.target.files[0]); });
      zona.addEventListener('dragover', (e) => { e.preventDefault(); zona.classList.add('arrastando'); });
      zona.addEventListener('dragleave', () => zona.classList.remove('arrastando'));
      zona.addEventListener('drop', (e) => { e.preventDefault(); zona.classList.remove('arrastando'); if (e.dataTransfer.files[0]) anexar(e.dataTransfer.files[0]); });
    }
  }

  // lê a exportação da SS (texto nas células e sem endereço de linha: o SheetJS lê) -> [{nome, pontos, horas, km}]
  async function anexar(arquivo) {
    if (ocupado) return;
    ocupado = true;
    el('pr-tel-info').textContent = 'Lendo ' + arquivo.name + '…';
    try {
      const XLSX = await carregarSheetJS();
      const wb = XLSX.read(await arquivo.arrayBuffer(), { type: 'array' });
      const linhas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
      const iCab = linhas.findIndex((r) => r && r.some((c) => chaveNome(c) === 'CONDUTOR'));
      if (iCab < 0) throw new Error('Esse arquivo não é a exportação da telemetria (falta a coluna CONDUTOR).');
      const cab = linhas[iCab].map(chaveNome);
      const col = (...nomes) => cab.findIndex((c) => nomes.includes(c));
      const cNome = col('CONDUTOR'), cPont = col('PONTUACAO FINAL', 'PONTOS'), cHoras = col('HORAS'), cKm = col('KM');
      if (cPont < 0) throw new Error('A planilha não tem a coluna PONTUAÇÃO FINAL (ou PONTOS).');
      const n = (v) => (v === null || v === '' ? null : Number(String(v).replace(',', '.')));
      const lidas = [];
      let periodo = '';
      for (const r of linhas.slice(iCab + 1)) {
        if (!r) continue;
        const nome = r[cNome] === null ? '' : String(r[cNome]).trim();
        if (/^filtros aplicados/i.test(nome)) { periodo = nome.replace(/\s+/g, ' '); continue; }
        if (!nome || chaveNome(nome) === 'TOTAL' || n(r[cPont]) === null || !Number.isFinite(n(r[cPont]))) continue;
        lidas.push({ nome, pontos: n(r[cPont]), horas: cHoras >= 0 ? n(r[cHoras]) : null, km: cKm >= 0 ? n(r[cKm]) : null });
      }
      if (!periodo) for (const r of linhas) { const c = r && r.find((x) => /^filtros aplicados/i.test(String(x || ''))); if (c) periodo = String(c).replace(/\s+/g, ' '); }
      if (!lidas.length) throw new Error('Nenhum motorista com pontuação na planilha.');
      // o período do rodapé ("depois de 01/09/2026") tem que ser o mês escolhido
      const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(periodo);
      if (m && (+m[3]) * 12 + (+m[2]) - 1 !== mes && !await confirmar('A planilha é de ' + m[2] + '/' + m[3] + ', mas o mês escolhido é ' + fmtMes(mes, true) + '. Anexar mesmo assim?')) return;
      if (api.telemetria && !await confirmar('Substituir a telemetria já anexada em ' + fmtMes(mes, true) + '? As notas manuais continuam.')) return;
      if (cKm < 0 && !await confirmar('Esta planilha não tem a coluna KM (é a do ranking). Sem o KM não dá para conferir a cobertura. Anexar mesmo assim?')) return;
      await chamar('POST', { acao: 'telemetria', arquivo: arquivo.name, periodo, linhas: lidas });
      aviso('Telemetria anexada: ' + lidas.length + ' motoristas.');
      await carregar();
    } catch (e) {
      if (e.message !== 'sessão') { aviso(e.message); desenhar(); }
    } finally { ocupado = false; }
  }

  async function gravarNota(inp) {
    const r = calc.ranking.find((x) => x.chave === inp.dataset.nota);
    if (!r) return;
    const v = num(inp.value);
    if (v !== null && (!Number.isFinite(v) || v < -100 || v > 200)) { inp.classList.add('invalido'); return; }
    inp.classList.remove('invalido');
    const antes = r.manual ? r.manual.nota : null;
    if (v === antes) return;
    try {
      await chamar('POST', { acao: 'nota', motorista: r.nome, nota: v, motivo: v === null ? null : r.porque || 'ajuste manual' });
      api.notas = (api.notas || []).filter((n) => n.motorista !== r.chave);
      if (v !== null) api.notas.push({ motorista: r.chave, nota: v, motivo: r.porque || 'ajuste manual' });
      calc = calcular();
      const foco = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.nota : null;
      desenhar();
      if (foco) { const f = pagina.querySelector('[data-nota="' + CSS.escape(foco) + '"]'); if (f) f.focus(); }
    } catch (e) { if (e.message !== 'sessão') aviso(e.message); }
  }

  // ----- encarregados -----
  function desenharEncarregados() {
    const enc = fechado() && api.parametros && api.parametros.resultadoEncarregados ? api.parametros.resultadoEncarregados : calc.encarregados;
    el('pr-conta').textContent = enc.length + ' encarregados';
    el('pr-corpo').innerHTML = '<div class="tabela-rolagem"><table class="dados pr-tabela"><thead><tr>' + th('encarregados', 'nome', 'Encarregado') + th('encarregados', 'motoristas', 'Motoristas', true) + th('encarregados', 'nota', 'Nota telemetria') +
      th('encarregados', 'premioSS', 'Prêmio telemetria', true) + th('encarregados', 'pct', '% da meta') + th('encarregados', 'premioComb', 'Prêmio combustível', true) + th('encarregados', 'total', 'Total', true) +
      '</tr></thead><tbody>' +
      ordenar(enc, 'encarregados', { nome: (e) => e.nome, motoristas: (e) => e.motoristas, nota: (e) => e.nota, premioSS: (e) => e.premioSS, pct: (e) => e.pct,
        premioComb: (e) => e.premioComb, total: (e) => e.total }).map((e) => '<tr><td class="pr-nome"><strong>' + esc(e.nome) + '</strong><small class="cidade-linha">' + esc(e.unidades.join(', ')) + '</small></td><td class="n num">' + fmt.int(e.motoristas) + '</td>' +
        '<td>' + (e.nota === null ? '—' : '<strong class="num">' + fmt.d2(e.nota) + '</strong> <span class="pr-estrelas">' + estrelasTxt(e.estrelas) + '</span>') + '</td>' +
        '<td class="n num">' + rs(e.premioSS) + '</td><td>' + (e.pct ? metaHtml(e.pct, pct2(e.pct)) : '—') + '</td><td class="n num">' + rs(e.premioComb) + '</td>' +
        '<td class="n"><strong class="num">' + rs(e.total) + '</strong></td></tr>').join('') + '</tbody></table></div>';
  }

  // ----- parâmetros (gravados por mês) -----
  // unidades que aparecem na lista dos encarregados: as do mês (com a quantidade de abastecimentos) + as já configuradas
  function unidadesDoMes() {
    const qtd = new Map();
    for (const it of calc.linhas) { const u = String(it.l.cc || '').trim().toUpperCase(); if (u) qtd.set(u, (qtd.get(u) || 0) + 1); }
    for (const e of (rascunhoEnc || calc.P.encarregados)) for (const u of e.unidades) if (!qtd.has(u)) qtd.set(u, 0);
    return qtd;
  }
  const rotuloUnid = (us) => (!us.length ? 'Escolher unidades' : us.length === 1 ? us[0] : us.length + ' unidades');
  const chipsUnid = (us) => (us.length > 1 ? us.map((u) => '<span class="pr-chip">' + esc(u) + '</span>').join('') : '');
  const pctCampo = (x) => Math.round(x * 10000) / 100;   // 1,05 -> 105
  function desenharParametros() {
    const P = calc.P, ed = editavel();
    const v = (x) => esc(String(x).replace('.', ','));
    const campo = (nome, x, rot) => (ed ? '<input class="campo-tabela" inputmode="decimal" name="' + nome + '" value="' + v(x) + '" aria-label="' + esc(rot) + '">' : '<span class="num">' + v(x) + '</span>');
    const encs = rascunhoEnc || P.encarregados;
    el('pr-conta').textContent = '';
    el('pr-corpo').innerHTML = '<form id="pr-param" class="pr-param">' +
      '<section class="pr-sec pr-sec-ss"><h3>Prêmio telemetria do motorista</h3><p class="pr-sub">Valor pela nota da telemetria.</p>' +
        '<table class="dados pr-ptab"><thead><tr><th class="n"><span>Nota a partir de</span></th><th class="n"><span>Prêmio (R$)</span></th></tr></thead><tbody>' +
        P.ss.map((x, i) => '<tr><td class="n">' + campo('ss' + i + 'n', x[0], 'Nota da faixa ' + (i + 1)) + '</td><td class="n">' + campo('ss' + i + 'v', x[1], 'Prêmio da faixa ' + (i + 1)) + '</td></tr>').join('') + '</tbody></table>' +
        '</section>' +
      '<section class="pr-sec pr-sec-comb"><h3>Prêmio combustível do motorista</h3><p class="pr-sub">Valor (R$) pelo km rodado no mês e pelo % da meta de km/L.</p>' +
        '<div class="pr-rolar"><table class="dados pr-ptab"><thead><tr><th class="n"><span>Km a partir de</span></th>' + P.pctMeta.map((p) => '<th class="n"><span>≥ ' + fmt.pct(p) + ' da meta</span></th>').join('') + '</tr></thead><tbody>' +
        P.faixasKm.map((fk, i) => '<tr><td class="n">' + campo('fk' + i, fk, 'Km da faixa ' + (i + 1)) + '</td>' + P.combustivel[i].map((x, j) => '<td class="n">' + campo('c' + i + '_' + j, x, 'Prêmio da faixa ' + (i + 1) + ' com ' + fmt.pct(P.pctMeta[j]) + ' da meta') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div></section>' +
      '<section class="pr-sec pr-sec-enc"><h3>Encarregados</h3><p class="pr-sub">Unidades de cada encarregado (a nota e o % da meta dele vêm dos motoristas delas).</p>' +
        '<table class="dados pr-ptab pr-enc"><thead><tr><th><span>Encarregado</span></th><th><span>Unidades</span></th>' + (ed ? '<th class="pr-col-acao"><span class="sr">Excluir</span></th>' : '') + '</tr></thead><tbody>' +
        (encs.length ? encs.map((e, i) => '<tr><td>' + (ed ? '<input class="campo-tabela pr-texto" name="en' + i + '" value="' + esc(e.nome) + '" placeholder="Nome do encarregado" aria-label="Nome do encarregado ' + (i + 1) + '">' : esc(e.nome)) + '</td><td>' +
          (ed ? '<div class="pr-unid" data-unid="' + i + '"><input type="hidden" name="eu' + i + '" value="' + esc(e.unidades.join('|')) + '">' +
              '<button type="button" class="filtro-botao" aria-haspopup="dialog" aria-expanded="false" aria-label="Unidades de ' + esc(e.nome || 'encarregado ' + (i + 1)) + '"><span class="valor">' + esc(rotuloUnid(e.unidades)) + '</span><svg aria-hidden="true"><use href="#i-baixo"/></svg></button>' +
              '<div class="pr-chips">' + chipsUnid(e.unidades) + '</div></div>'
            : '<div class="pr-chips">' + (e.unidades.map((u) => '<span class="pr-chip">' + esc(u) + '</span>').join('') || '—') + '</div>') + '</td>' +
          (ed ? '<td class="pr-col-acao"><button type="button" class="btn-lixeira" data-rem-enc="' + i + '" aria-label="Excluir ' + esc(e.nome || 'encarregado') + '" title="Excluir encarregado"><svg aria-hidden="true"><use href="#i-lixeira"/></svg></button></td>' : '') + '</tr>').join('')
          : '<tr><td colspan="3"><div class="vazio">Nenhum encarregado.</div></td></tr>') + '</tbody></table>' +
        (ed ? '<button type="button" class="btn pr-add" data-add-enc><svg aria-hidden="true"><use href="#i-mais"/></svg><span class="txt">Adicionar encarregado</span></button>' : '') + '</section>' +
      '<section class="pr-sec pr-sec-fora"><h3>Fora do ranking</h3><p class="pr-sub">Um nome por linha. Não aparecem no ranking nem nos prêmios.</p>' +
        (ed ? '<textarea name="excluidos" rows="10" aria-label="Nomes fora do ranking">' + esc(P.excluidos.join('\n')) + '</textarea>' : '<p>' + (P.excluidos.map(esc).join('<br>') || '—') + '</p>') + '</section>' +
      '<section class="pr-sec pr-sec-meio"><h3>Prêmio dos encarregados</h3><p class="pr-sub">Pela nota ponderada e pelo % da meta das unidades.</p><div class="pr-duas">' +
        '<table class="dados pr-ptab"><thead><tr><th class="n"><span>Nota a partir de</span></th><th class="n"><span>Prêmio telemetria (R$)</span></th></tr></thead><tbody>' +
        P.encSS.map((x, i) => '<tr><td class="n">' + campo('es' + i + 'n', x[0], 'Nota da faixa ' + (i + 1) + ' do encarregado') + '</td><td class="n">' + campo('es' + i + 'v', x[1], 'Prêmio telemetria da faixa ' + (i + 1) + ' do encarregado') + '</td></tr>').join('') + '</tbody></table>' +
        '<table class="dados pr-ptab"><thead><tr><th class="n"><span>% da meta a partir de</span></th><th class="n"><span>Prêmio combustível (R$)</span></th></tr></thead><tbody>' +
        P.encComb.map((x, i) => '<tr><td class="n">' + campo('ec' + i + 'p', pctCampo(x[0]), '% da meta da faixa ' + (i + 1) + ' do encarregado') + '</td><td class="n">' + campo('ec' + i + 'v', x[1], 'Prêmio combustível da faixa ' + (i + 1) + ' do encarregado') + '</td></tr>').join('') + '</tbody></table>' +
      '</div></section>' +
      '<section class="pr-sec pr-sec-meio"><h3>Estrelas, cobertura e km mínimo</h3><p class="pr-sub">Estrelas pela nota usada. A nota da telemetria só vale se cobrir o km mínimo dos abastecimentos (ou se não der prêmio). Quem rodou menos que o km mínimo no mês perde todos os prêmios.</p><div class="pr-duas">' +
        '<table class="dados pr-ptab"><thead><tr><th><span>Estrelas</span></th><th class="n"><span>Nota a partir de</span></th></tr></thead><tbody>' +
        P.estrelas.map((x, i) => '<tr><td><span class="pr-estrelas" aria-label="' + (5 - i) + ' estrelas">' + estrelasTxt(5 - i) + '</span></td><td class="n">' + campo('st' + i, x, 'Nota mínima para ' + (5 - i) + ' estrelas') + '</td></tr>').join('') + '</tbody></table>' +
        '<table class="dados pr-ptab"><thead><tr><th><span>Regra</span></th><th class="n"><span>Valor</span></th></tr></thead><tbody>' +
        '<tr><td>Cobertura mínima do km da telemetria (%)</td><td class="n">' + campo('cob', pctCampo(P.coberturaMin), 'Cobertura mínima do km, em %') + '</td></tr>' +
        '<tr><td>Km mínimo no mês para ter prêmio</td><td class="n">' + campo('kmmin', P.kmMinimo, 'Km mínimo rodado no mês para ter prêmio') + '</td></tr></tbody></table>' +
      '</div></section>' +
      (ed ? '<div class="pr-param-acoes"><button type="submit" class="btn btn-principal">Gravar parâmetros de ' + esc(fmtMes(mes, true)) + '</button></div>' : '') + '</form>';
  }
  // lista suspensa (seleção múltipla) das unidades de um encarregado
  let painelUnid = null;
  function fecharUnid(focar) {
    if (!painelUnid) return;
    const { painel, botao } = painelUnid;
    painel.remove(); botao.setAttribute('aria-expanded', 'false');
    painelUnid = null;
    if (focar) botao.focus();
  }
  function abrirUnid(caixa) {
    const mesma = painelUnid && painelUnid.caixa === caixa;
    fecharUnid();
    if (mesma) return;
    const oculto = caixa.querySelector('input[type=hidden]'), botao = caixa.querySelector('.filtro-botao');
    const sel = new Set(oculto.value.split('|').filter(Boolean));
    const qtd = unidadesDoMes();
    const form = el('pr-param'), i = Number(caixa.dataset.unid);
    const dono = new Map();   // unidade -> outro encarregado que já tem ela
    for (let k = 0; form.elements['eu' + k]; k++) if (k !== i) for (const u of form.elements['eu' + k].value.split('|').filter(Boolean)) dono.set(u, form.elements['en' + k].value.trim() || 'outro encarregado');
    const valores = [...qtd.keys()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const painel = document.createElement('div');
    painel.className = 'painel-filtro pr-painel-unid';
    painel.setAttribute('role', 'dialog');
    painel.setAttribute('aria-label', 'Unidades');
    painel.innerHTML = '<input type="search" autocomplete="off" placeholder="Procurar unidade…" aria-label="Procurar unidade"><div class="opcoes" role="group"></div>' +
      '<div class="painel-rodape"><button type="button" class="link-acao" data-acao="limpar">Limpar</button><button type="button" class="link-acao" data-acao="ok">Pronto</button></div>';
    caixa.appendChild(painel);
    botao.setAttribute('aria-expanded', 'true');
    painelUnid = { caixa, painel, botao };
    const lista = painel.querySelector('.opcoes'), busca = painel.querySelector('input');
    const listar = () => {
      const t = busca.value.trim().toLowerCase();
      const vis = valores.filter((u) => !t || u.toLowerCase().includes(t));
      lista.innerHTML = vis.length ? vis.map((u) => '<button type="button" class="opcao' + (qtd.get(u) ? '' : ' indisponivel') + '" role="checkbox" aria-checked="' + sel.has(u) + '" data-v="' + esc(u) + '">' +
        '<span class="caixa"></span><span class="txt">' + esc(u) + (dono.has(u) ? '<small class="pr-dono">com ' + esc(dono.get(u)) + '</small>' : '') + '</span>' +
        '<span class="qtd" title="Abastecimentos no mês">' + fmt.int(qtd.get(u)) + '</span></button>').join('') : '<div class="vazio">Nenhuma unidade com esse texto.</div>';
    };
    const aplicar = () => {
      const us = valores.filter((u) => sel.has(u));
      oculto.value = us.join('|');
      botao.querySelector('.valor').textContent = rotuloUnid(us);
      caixa.querySelector('.pr-chips').innerHTML = chipsUnid(us);
    };
    listar();
    busca.addEventListener('input', listar);
    lista.addEventListener('click', (e) => {
      const b = e.target.closest('.opcao'); if (!b) return;
      if (sel.has(b.dataset.v)) sel.delete(b.dataset.v); else sel.add(b.dataset.v);
      b.setAttribute('aria-checked', String(sel.has(b.dataset.v)));
      aplicar();
    });
    painel.querySelector('.painel-rodape').addEventListener('click', (e) => {
      const a = e.target.closest('[data-acao]'); if (!a) return;
      if (a.dataset.acao === 'limpar') { sel.clear(); listar(); aplicar(); } else fecharUnid(true);
    });
    const r = painel.getBoundingClientRect();
    if (r.right > innerWidth - 8) painel.style.left = Math.min(0, innerWidth - 8 - r.right) + 'px';
    setTimeout(() => busca.focus(), 0);
  }
  pagina.addEventListener('mousedown', (e) => { if (painelUnid && !e.target.closest('.pr-unid')) fecharUnid(); });
  pagina.addEventListener('keydown', (e) => { if (e.key === 'Escape' && painelUnid) { e.stopPropagation(); fecharUnid(true); } });
  // linhas de encarregado do formulário (as que foram adicionadas também)
  function lerEncarregados(form) {
    const r = [];
    for (let i = 0; form.elements['en' + i]; i++) {
      r.push({ nome: form.elements['en' + i].value.trim(), unidades: form.elements['eu' + i].value.split('|').map((x) => x.trim().toUpperCase()).filter(Boolean) });
    }
    return r;
  }
  async function gravarParametros(form) {
    const P = calc.P, g = (n) => num(form.elements[n].value);
    const novo = {
      ss: P.ss.map((_, i) => [g('ss' + i + 'n'), g('ss' + i + 'v')]),
      faixasKm: P.faixasKm.map((_, i) => g('fk' + i)),
      combustivel: P.combustivel.map((linha, i) => linha.map((_, j) => g('c' + i + '_' + j))),
      encarregados: lerEncarregados(form).filter((e) => e.nome),
      excluidos: form.elements.excluidos.value.split('\n').map((s) => s.trim()).filter(Boolean),
      encSS: P.encSS.map((_, i) => [g('es' + i + 'n'), g('es' + i + 'v')]),
      encComb: P.encComb.map((_, i) => [g('ec' + i + 'p') / 100, g('ec' + i + 'v')]),
      estrelas: P.estrelas.map((_, i) => g('st' + i)),
      coberturaMin: g('cob') / 100,
      kmMinimo: g('kmmin'),
    };
    if ([...novo.ss.flat(), ...novo.faixasKm, ...novo.combustivel.flat(), ...novo.encSS.flat(), ...novo.encComb.flat(), ...novo.estrelas, novo.coberturaMin, novo.kmMinimo]
      .some((v) => v === null || !Number.isFinite(v))) { aviso('Preencha todos os valores com números.'); return; }
    try {
      const parametros = { ...(api.parametros || {}), ...novo };
      await chamar('POST', { acao: 'parametros', parametros });
      api.parametros = parametros;
      rascunhoEnc = null;
      aviso('Parâmetros de ' + fmtMes(mes, true) + ' gravados.');
      calc = calcular(); desenhar();
    } catch (e) { if (e.message !== 'sessão') aviso(e.message); }
  }

  // ----- fechar / reabrir -----
  el('pr-fechar').addEventListener('click', async () => {
    if (calc.faltando.length) { aba = 'telemetria'; filtroTel.ver = 'faltando'; desenhar(); return; }
    const tot = calc.ranking.reduce((s, r) => s + r.total, 0);
    if (!await confirmar('Fechar o PRIME de ' + fmtMes(mes, true) + '?\n\n' + calc.ranking.length + ' motoristas · R$ ' + fmt.int(tot) + ' em prêmios dos motoristas.\n\nDepois de fechado, só um administrador reabre.')) return;
    const resultado = calc.ranking.map((r) => ({ chave: r.chave, nome: r.nome, unidade: r.unidade, nota: r.nota, estrelas: r.estrelas, origem: r.origem, porque: r.porque,
      tel: r.tel ? { pontos: r.tel.pontos, km: r.tel.km } : null, cobertura: r.cobertura, km: r.km, litros: r.litros, kmMeta: r.kmMeta, litrosMeta: r.litrosMeta,
      meta: r.meta, media: r.media, pct: r.pct, faixa: r.faixa, premioSS: r.premioSS, premioComb: r.premioComb, total: r.total, qtd: r.qtd }));
    try {
      await chamar('POST', { acao: 'fechar', parametros: { ...(api.parametros || {}), ...calc.P, resultadoEncarregados: calc.encarregados }, resultado });
      aviso('PRIME de ' + fmtMes(mes, true) + ' fechado.');
      await carregar();
    } catch (e) { if (e.message !== 'sessão') aviso(e.message); }
  });
  el('pr-reabrir').addEventListener('click', async () => {
    if (!await confirmar('Reabrir o PRIME de ' + fmtMes(mes, true) + '? O resultado gravado no fechamento é apagado e a conta volta a usar os dados atuais.')) return;
    try { await chamar('POST', { acao: 'reabrir' }); await carregar(); } catch (e) { if (e.message !== 'sessão') aviso(e.message); }
  });

  ligarBaixar(el('pr-baixar'), () => {
    const ranking = fechado() && api.resultado ? api.resultado : calc.ranking;
    const n = (titulo, casas, largura) => ({ titulo, tipo: 'numero', casas, largura: largura || 11 });
    return {
      nome: 'programa-prime-' + ymDeMes(mes), aba: 'Ranking',
      // mesma ordem da planilha do fechamento (Unidade, Condutor, Pontuação, Estrelas, Variável SS, Km, metas, Variável combustível), por nome do motorista
      colunas: [{ titulo: 'Unidade', largura: 26 }, { titulo: 'Motorista', largura: 32 }, n('Nota', 2, 8), { titulo: 'Estrelas', largura: 9 }, { titulo: 'Prêmio telemetria', tipo: 'moeda', largura: 12 },
        n('Km rodado', 0), n('Meta média', 2), n('Média real', 2), { titulo: '% Meta', tipo: 'pct', casas: 4, largura: 9 }, { titulo: 'Prêmio combustível', tipo: 'moeda', largura: 14 },
        n('Faixa km', 0), { titulo: 'Total', tipo: 'moeda', largura: 12 }],
      linhas: [...ranking].sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'))
        .map((r) => [r.unidade, r.nome, r.nota, r.estrelas ? '★'.repeat(r.estrelas) : '', r.premioSS, r.km, r.meta, r.media, r.pct, r.premioComb, r.faixa, r.total]),
    };
  });

  // ----- eventos -----
  el('pr-mes').addEventListener('change', (e) => { mes = Number(e.target.value); limiteRank = PASSO; filtroAb.limite = PASSO; abertoRank = null; rascunhoEnc = null; abaDesenhada = null; selAb.clear(); ancoraAb = null; desenharFlutuante(); carregar(); });
  el('pr-abas').addEventListener('click', (e) => { const b = e.target.closest('[data-aba]'); if (!b) return; aba = b.dataset.aba; desenhar(); });
  el('pr-situacao').addEventListener('click', (e) => { if (e.target.closest('[data-ir-faltando]')) { aba = 'telemetria'; filtroTel.ver = 'faltando'; desenhar(); } });
  el('pr-faltando').addEventListener('click', (e) => { if (e.target.closest('[data-ir-faltando]')) { aba = 'telemetria'; filtroTel.ver = 'faltando'; desenhar(); } });
  el('pr-corpo').addEventListener('click', async (e) => {
    const ord = e.target.closest('[data-ord]');
    if (ord && !e.target.closest('.pr-det')) {
      const c = ord.dataset.ord, o = ordem[aba];
      ordem[aba] = o && o.campo === c ? { campo: c, dir: -o.dir } : { campo: c, dir: ['nome', 'motorista', 'posto', 'placa', 'pos'].includes(c) ? 1 : -1 };
      desenhar();
      const f = pagina.querySelector('#pr-corpo [data-ord="' + c + '"]'); if (f) f.focus();
      return;
    }
    const unid = e.target.closest('.pr-unid > .filtro-botao');
    if (unid) { abrirUnid(unid.parentElement); return; }
    const add = e.target.closest('[data-add-enc]'), rem = e.target.closest('[data-rem-enc]');
    if (add || rem) {
      const form = el('pr-param');
      rascunhoEnc = lerEncarregados(form);
      if (add) rascunhoEnc.push({ nome: '', unidades: [] });
      else if (await confirmar('Excluir o encarregado ' + (rascunhoEnc[Number(rem.dataset.remEnc)].nome || '(sem nome)') + '? Só vale depois de gravar os parâmetros.')) rascunhoEnc.splice(Number(rem.dataset.remEnc), 1);
      desenhar();
      if (add) { const f = pagina.querySelector('[name="en' + (rascunhoEnc.length - 1) + '"]'); if (f) f.focus(); }
      return;
    }
    const ab = e.target.closest('tr[data-ab]');
    if (ab && !e.target.closest('button, a, input, select')) { selecionarAb(ab, e); return; }
    const mot = e.target.closest('tr[data-mot]');
    if (mot && !e.target.closest('button, a, input')) { abertoRank = abertoRank === mot.dataset.mot ? null : mot.dataset.mot; desenhar(); return; }
    const sit = e.target.closest('[data-sit]');
    if (sit) { filtroAb.situacao = sit.dataset.sit; filtroAb.limite = PASSO; desenhar(); return; }
    const ver = e.target.closest('[data-ver]');
    if (ver) { filtroTel.ver = ver.dataset.ver; desenhar(); return; }
    const dec = e.target.closest('[data-decidir]');
    if (dec) { abrirDecisao(calc.linhas[Number(dec.dataset.decidir)]); return; }
    if (e.target.closest('#pr-mais [data-mais]')) { limiteRank += PASSO; desenhar(); return; }
    if (e.target.closest('#pr-mais [data-menos]')) { limiteRank = PASSO; desenhar(); return; }
    if (e.target.closest('#pr-mais-ab [data-mais]')) { filtroAb.limite += PASSO; desenhar(); return; }
    if (e.target.closest('#pr-mais-ab [data-menos]')) { filtroAb.limite = PASSO; desenhar(); }
  });
  let tBusca = null;
  el('pr-corpo').addEventListener('input', (e) => {
    if (e.target.id !== 'pr-busca' && e.target.id !== 'pr-tel-busca' && e.target.id !== 'pr-rank-busca') return;
    clearTimeout(tBusca);
    const id = e.target.id, v = e.target.value;
    tBusca = setTimeout(() => {
      if (id === 'pr-busca') { filtroAb.busca = v; filtroAb.limite = PASSO; } else if (id === 'pr-rank-busca') buscaRank = v; else filtroTel.busca = v;
      desenhar();
      const f = el(id); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
    }, 200);
  });
  el('pr-corpo').addEventListener('change', (e) => { if (e.target.dataset && e.target.dataset.nota !== undefined) gravarNota(e.target); });
  el('pr-corpo').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset && e.target.dataset.nota !== undefined) { e.preventDefault(); e.target.blur(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr[data-ab]')) { e.preventDefault(); selecionarAb(e.target, e); return; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr[data-mot]')) { e.preventDefault(); abertoRank = abertoRank === e.target.dataset.mot ? null : e.target.dataset.mot; desenhar(); }
  });
  // Shift+clique não seleciona o texto da tabela
  el('pr-corpo').addEventListener('mousedown', (e) => { if (e.shiftKey && e.target.closest('tr[data-ab]')) e.preventDefault(); });
  el('pr-corpo').addEventListener('submit', (e) => { if (e.target.id === 'pr-param') { e.preventDefault(); gravarParametros(e.target); } });

  // "Atualizar: dados novos" no topo: refaz a conta com os abastecimentos novos sem sair da tela (antes ficava com os da abertura)
  const aoAtualizarDados = () => carregarDados().then((d) => { dados = d; if (api) { calc = calcular(); desenhar(); } }).catch(() => {});
  window.addEventListener('dados-atualizados', aoAtualizarDados);
  await carregar();
  return { desmontar() { window.removeEventListener('dados-atualizados', aoAtualizarDados); const d = el('pr-dlg'); if (d && d.open) d.close(); flutuante.remove(); document.body.classList.remove('com-sel-flutuante'); } };
}
