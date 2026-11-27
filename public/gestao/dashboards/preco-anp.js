// Dashboard "Preço x ANP" — o preço que pagamos no diesel contra a média de revenda da ANP (Levantamento de Preços,
// ÓLEO DIESEL S10), nos mesmos recortes do painel da ANP: Brasil, região, estado e município, semana a semana ou mês
// a mês. Dados da ANP: /gestao/dados/anp.json (scripts/anp_precos.py, enviado pelo vigia quando a ANP publica).
//  - nosso preço é o PONDERADO: soma do valor pago ÷ soma dos litros, no período e no local
//  - todo diesel da Base conta como S10 (DIESEL, S-10 COMUM, S-10 ADITIVADO, COMUM)
//  - média ANP do período = média dos preços ANP de cada semana/mês, pesada pelos nossos litros naquela semana/mês;
//    só entram na comparação as semanas/meses em que a ANP pesquisou aquele local
//  - semana da ANP: domingo a sábado (a mesma da "DATA INICIAL" dos arquivos dela); mês: do dia 1 ao último
import { carregarDados, fmt, esc, fmtDia, fmtMes, mesDoDia, inicioDoMes, chaveNome } from '../lib/dados.js';
import { criarFiltros, htmlApoio, agendador, statusHtml, trocarEndereco } from '../lib/filtros.js';
import { graficoPeriodo, emAndamento } from '../lib/graficos.js';

const ROTA = '#/preco-anp';
const TOLERANCIA = 0.005;            // R$/L: diferença de arredondamento não conta como acima/abaixo
const PRECO_MIN = 3, PRECO_MAX = 12; // R$/L: fora disso é erro de digitação na Base
const NIVEIS = [['brasil', 'Brasil'], ['regiao', 'Região'], ['estado', 'Estado'], ['municipio', 'Município']];
const FILHO = { brasil: 'regiao', regiao: 'estado', estado: 'municipio', municipio: 'posto' };
// só postos externos (decisão do usuário em 10/11/2026): a bomba interna é preço de compra no atacado, sem margem de posto, e
// contra a média de revenda da ANP sempre parecia "economia". O preço da bomba interna fica no Preço x Refinaria.
const NOME_REGIAO = { NORTE: 'Norte', NORDESTE: 'Nordeste', 'CENTRO OESTE': 'Centro-Oeste', SUDESTE: 'Sudeste', SUL: 'Sul' };
const NOME_UF = { AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo',
  GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná',
  PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima',
  SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins' };

// sem acento e com espaços simples, como os nomes dos arquivos da ANP (ex.: "SAO CAITANO")
const chaveLocal = (s) => chaveNome(s).replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
const semana = (dia) => dia - ((dia + 4) % 7);   // domingo da semana (1970-01-01 foi quinta-feira)
const titulo = (s) => String(s || '').toLowerCase().replace(/(^|\s|-)(\S)/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(De|Da|Do|Das|Dos|E)\b/g, (m) => m.toLowerCase());
const rs = (v) => (v === null || v === undefined ? '—' : 'R$ ' + fmt.d3(v));
const sinal = (v, f) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v)));

let carregandoANP = null;
function carregarANP() {
  carregandoANP ||= fetch('/gestao/dados/anp.json', { credentials: 'same-origin' }).then(async (r) => {
    if (r.status === 401 || r.redirected) { location.href = '/?entrar=1'; throw new Error('sessão'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || 'Não foi possível carregar os preços da ANP (' + r.status + ').');
    return j;
  }).catch((e) => { carregandoANP = null; throw e; });
  return carregandoANP;
}

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando os abastecimentos e os preços da ANP…</div>';
  let dados, anp, municipios;
  try {
    [dados, anp, municipios] = await Promise.all([carregarDados(), carregarANP(),
      fetch('/gestao/mapas/municipios.json', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : [])).catch(() => [])]);
  } catch (e) {
    pagina.innerHTML = '<div class="vazio">' + esc(e.message) + ' Recarregue a página para tentar de novo.</div>';
    return {};
  }

  // ---------- locais e séries da ANP ----------
  let L, ufs, porUf, munANP, serie;
  function usarANP(a) {
    anp = a;
    L = a.locais;
    ufs = L.estado.map(([uf, nome, r]) => ({ uf, nome, regiao: L.regiao[r] }));
    porUf = new Map(ufs.map((e) => [e.uf, e]));
    munANP = new Set(L.municipio.map(([uf, nome]) => uf + '|' + nome));
    serie = {};   // per -> "nivel|local|inicio" -> {v, n, mn, mx}
    for (const [per, niveis] of Object.entries(a.series)) {
      const m = serie[per] = new Map();
      for (const [nivel, s] of Object.entries(niveis)) {
        const nome = (i) => (nivel === 'brasil' ? 'BRASIL' : nivel === 'regiao' ? L.regiao[i] : nivel === 'estado' ? L.estado[i][0] : L.municipio[i].join('|'));
        for (let i = 0; i < s.p.length; i++) {
          m.set(nivel + '|' + nome(s.l[i]) + '|' + s.p[i], {
            v: s.v[i] / 1000, n: s.n[i], mn: s.mn[i] === null ? null : s.mn[i] / 1000, mx: s.mx[i] === null ? null : s.mx[i] / 1000,
          });
        }
      }
    }
  }
  usarANP(anp);
  // nome oficial (com acento) de cada município pelo IBGE: "UF|SAO CAITANO" -> "São Caitano"
  const nomeMun = new Map(municipios.map(([nome, uf]) => [uf + '|' + chaveLocal(nome), nome]));
  // referência da ANP: município que a ANP não pesquisa é comparado com a média do estado dele
  const referencia = (nivel, local) => (nivel === 'municipio' && !munANP.has(local) ? ['estado', local.split('|')[0]] : [nivel, local]);
  const precoANP = (per, nivel, local, p) => serie[per] && serie[per].get(nivel + '|' + (nivel === 'brasil' ? 'BRASIL' : local) + '|' + p);
  const limitesANP = () => {
    const s = anp.series.semanal.brasil.p;
    return [Math.min(...s), Math.max(...s) + 6];
  };

  // ---------- nossos abastecimentos de diesel (todo diesel conta como S10) ----------
  let base = [];
  function usarDados(d) {
    dados = d;
    base = [];
    for (const l of d.linhas) {
      if (l.tipoEstab !== 'POSTO DE COMBUSTIVEL') continue;   // só postos externos
      if (!/^DIESEL/.test(l.combustivel || '') || !(l.litros > 0) || !(l.vlLitro >= PRECO_MIN && l.vlLitro <= PRECO_MAX)) continue;
      const m = /^(.*) - ([A-Z]{2})$/.exec(l.cidade || '');
      const est = m && porUf.get(m[2]);
      if (!est) continue;
      base.push({
        sem: semana(l.dia), mes: inicioDoMes(mesDoDia(l.dia)),
        uf: est.uf, regiao: est.regiao, mun: est.uf + '|' + chaveLocal(m[1]),
        posto: l.fornecedor, litros: l.litros, valor: l.despesa > 0 ? l.despesa : l.litros * l.vlLitro,
      });
    }
  }
  usarDados(dados);

  // ---------- escolha (fica no endereço da página) ----------
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const estado = {
    per: q.get('per') === 'mensal' ? 'mensal' : 'semanal',
    nivel: NIVEIS.some(([n]) => n === q.get('nivel')) ? q.get('nivel') : 'brasil',
    local: q.get('local') || '',
    ordem: { col: 'litros', dir: -1 },
  };
  if (!location.hash.includes('?')) trocarEndereco(ROTA, ROTA + '?periodo=3meses');

  pagina.innerHTML = `
    <div class="grupo-filtros">
    <div class="anp-controles">
      <div class="anp-grupo"><span class="filtro-rotulo">Preço da ANP</span>
        <div class="segmentado" role="group" aria-label="Preço da ANP" id="anp-per">
          <button type="button" data-per="semanal">Semanal</button><button type="button" data-per="mensal">Mensal</button></div></div>
      <div class="anp-grupo"><span class="filtro-rotulo">Recorte</span>
        <div class="segmentado" role="group" aria-label="Recorte" id="anp-nivel">${NIVEIS.map(([n, r]) => '<button type="button" data-nivel="' + n + '">' + r + '</button>').join('')}</div></div>
      <div class="anp-grupo anp-local"><label class="filtro-rotulo" for="anp-local">Local</label><select id="anp-local" class="campo-sel"></select></div>
    </div>
    <section class="filtros" id="anp-filtros" aria-label="Período"></section>
    </div>
    <div class="chips" id="anp-chips" aria-live="polite"></div>
    <nav class="anp-trilha" id="anp-trilha" aria-label="Recorte atual"></nav>
    <div class="abertura">
      <section class="bomba" aria-labelledby="anp-bomba-titulo">
        <h2 class="bomba-titulo" id="anp-bomba-titulo">Nosso preço contra a ANP</h2>
        <dl class="bomba-registros" id="anp-bomba"></dl>
      </section>
      <dl class="apoio apoio-coluna" id="anp-resumo"></dl>
    </div>
    <dl class="apoio" id="anp-apoio"></dl>
    <section class="painel painel-largo">
      <div class="painel-cab">
        <h2 id="anp-grafico-titulo"></h2>
        <div class="legenda"><span><i class="leg-media"></i>Nosso preço ponderado</span><span><i class="leg-meta leg-tracejada"></i>Média de revenda ANP</span></div>
      </div>
      <p class="nota" id="anp-grafico-nota"></p>
      <div class="grafico" id="anp-grafico"></div>
    </section>
    <section class="painel painel-tabela">
      <div class="painel-cab"><h2 id="anp-filhos-titulo"></h2><span class="conta" id="anp-filhos-conta"></span></div>
      <p class="nota" id="anp-filhos-nota"></p>
      <div class="tabela-rolagem"><table class="dados" id="anp-filhos"></table></div>
    </section>
    <section class="painel painel-tabela">
      <div class="painel-cab"><h2 id="anp-periodos-titulo"></h2></div>
      <div class="tabela-rolagem tabela-alta"><table class="dados" id="anp-periodos"></table></div>
    </section>
    <p class="nota anp-fonte" id="anp-fonte"></p>`;
  const el = (id) => pagina.querySelector('#' + id);

  const filtros = criarFiltros({
    dimensoes: [{ id: 'periodo', rotulo: 'Período', periodo: true }],
    filtrosEl: el('anp-filtros'), chipsEl: el('anp-chips'), rota: ROTA,
    obterBase: () => base, obterLimites: limitesANP, aoMudar: () => atualizar(), prefixo: 'anp',
    extrasURL: () => ({ per: estado.per, nivel: estado.nivel, local: estado.nivel === 'brasil' ? '' : estado.local }),
  });

  // ---------- nomes e hierarquia ----------
  function nomeLocal(nivel, local) {
    if (nivel === 'brasil') return 'Brasil';
    if (nivel === 'regiao') return NOME_REGIAO[local] || titulo(local);
    if (nivel === 'estado') return NOME_UF[local] || local;
    if (nivel === 'municipio') { const [uf, nome] = local.split('|'); return (nomeMun.get(local) || titulo(nome)) + ' - ' + uf; }
    return local;
  }
  const pertence = (r, nivel, local) => nivel === 'brasil' || (nivel === 'regiao' ? r.regiao === local : nivel === 'estado' ? r.uf === local
    : nivel === 'municipio' ? r.mun === local : r.posto === local);
  const chaveDe = (r, nivel) => (nivel === 'regiao' ? r.regiao : nivel === 'estado' ? r.uf : nivel === 'municipio' ? r.mun : nivel === 'posto' ? r.posto : 'BRASIL');
  const pai = (nivel, local) => (nivel === 'regiao' ? null : nivel === 'estado' ? ['regiao', porUf.get(local).regiao]
    : nivel === 'municipio' ? ['estado', local.split('|')[0]] : null);

  // ---------- recorte: período ----------
  const campoPer = () => (estado.per === 'semanal' ? 'sem' : 'mes');
  const chavePer = (dia) => (estado.per === 'semanal' ? semana(dia) : inicioDoMes(mesDoDia(dia)));
  const rotPer = (p) => (estado.per === 'semanal' ? fmtDia(p).slice(0, 5) : fmtMes(mesDoDia(p)));
  const rotPerLongo = (p) => (estado.per === 'semanal' ? 'Semana de ' + fmtDia(p).slice(0, 5) + ' a ' + fmtDia(p + 6) : fmtMes(mesDoDia(p), true));
  function faixa() {
    const { de, ate } = filtros.periodo;
    return [de === null ? -Infinity : chavePer(de), ate === null ? Infinity : chavePer(ate)];
  }
  function linhasDoRecorte() {
    const [pDe, pAte] = faixa(), c = campoPer();
    return base.filter((r) => r[c] >= pDe && r[c] <= pAte);
  }
  // períodos do recorte: os nossos e os que a ANP pesquisou naquele local
  function periodos(t) {
    const [pDe, pAte] = faixa();
    const ps = new Set(t.porP.keys());
    const [nRef, lRef] = referencia(estado.nivel, estado.local);
    const prefixo = nRef + '|' + (nRef === 'brasil' ? 'BRASIL' : lRef) + '|';
    for (const k of serie[estado.per].keys()) {
      if (!k.startsWith(prefixo)) continue;
      const p = +k.slice(prefixo.length);
      if (p >= pDe && p <= pAte) ps.add(p);
    }
    return [...ps].sort((a, b) => a - b);
  }

  // comparação de um conjunto de abastecimentos com o preço ANP de um local (nível de referência).
  // Brasil e Região: cada abastecimento contra a ANP do ESTADO dele (ponderado pelos litros). Antes, tudo ia contra a média
  // nacional/regional e a "economia" media a diferença de preço entre regiões (compramos mais no Nordeste e no Norte), não a
  // compra (10/11/2026). Por período: a.lC/vC/aC = litros, valor e valor à ANP só do que tem pesquisa; a.x = a ANP única
  // (só quando a referência é um local só; no misto não há mín./máx. de um local).
  function comparar(rows, nivelRef, localRef) {
    const c = campoPer(), misto = nivelRef === 'brasil' || nivelRef === 'regiao';
    const porP = new Map();
    for (const r of rows) {
      let a = porP.get(r[c]);
      if (!a) porP.set(r[c], (a = { litros: 0, valor: 0, porUf: new Map() }));
      a.litros += r.litros; a.valor += r.valor;
      const k = misto ? r.uf : '';
      const g = a.porUf.get(k) || { litros: 0, valor: 0 };
      g.litros += r.litros; g.valor += r.valor;
      a.porUf.set(k, g);
    }
    const t = { litros: 0, valor: 0, lC: 0, vC: 0, aC: 0, acima: 0, comparados: 0, porP, misto };
    for (const [p, a] of porP) {
      t.litros += a.litros; t.valor += a.valor;
      a.lC = 0; a.vC = 0; a.aC = 0; a.x = null;
      for (const [uf, g] of a.porUf) {
        const x = misto ? precoANP(estado.per, 'estado', uf, p) : precoANP(estado.per, nivelRef, localRef, p);
        if (!x) continue;
        a.lC += g.litros; a.vC += g.valor; a.aC += g.litros * x.v;
        if (!misto) a.x = x;
      }
      a.nosso = a.lC ? a.vC / a.lC : (a.litros ? a.valor / a.litros : null);
      a.anp = a.lC ? a.aC / a.lC : null;
      if (!a.lC) continue;
      t.lC += a.lC; t.vC += a.vC; t.aC += a.aC; t.comparados++;
      if (a.vC / a.lC > a.aC / a.lC + TOLERANCIA) t.acima++;
    }
    t.nosso = t.litros ? t.valor / t.litros : null;          // todo o período
    t.nossoC = t.lC ? t.vC / t.lC : null;                   // só semanas/meses com pesquisa da ANP (base da comparação)
    t.anp = t.lC ? t.aC / t.lC : null;
    t.dif = t.lC ? t.nossoC - t.anp : null;
    t.impacto = t.lC ? t.vC - t.aC : null;
    t.cobertura = t.litros ? t.lC / t.litros : null;
    return t;
  }

  // ---------- controles ----------
  // listas de escolha: regiões de norte a sul; estados agrupados por região (cada região uma vez, estados em ordem
  // alfabética dentro dela); municípios agrupados pelo estado (estados e cidades em ordem alfabética)
  const ORDEM_REGIAO = Object.keys(NOME_REGIAO);
  const porRegiao = (a, b) => ORDEM_REGIAO.indexOf(a) - ORDEM_REGIAO.indexOf(b);
  const alfa = (a, b) => a.localeCompare(b, 'pt-BR');
  function opcoesLocal(nivel) {
    if (nivel === 'regiao') return L.regiao.slice().sort(porRegiao).map((r) => ({ v: r, rot: nomeLocal('regiao', r) }));
    if (nivel === 'estado') return ufs.slice().sort((a, b) => porRegiao(a.regiao, b.regiao) || alfa(NOME_UF[a.uf], NOME_UF[b.uf]))
      .map((e) => ({ v: e.uf, rot: NOME_UF[e.uf] + ' (' + e.uf + ')', grupo: NOME_REGIAO[e.regiao] }));
    if (nivel === 'municipio') {
      const nossos = new Set(base.map((r) => r.mun));
      return [...new Set([...munANP, ...nossos])].sort((a, b) => alfa(NOME_UF[a.split('|')[0]] || a, NOME_UF[b.split('|')[0]] || b) || alfa(a, b)).map((m) => ({
        v: m, rot: nomeLocal('municipio', m) + (munANP.has(m) ? '' : ' · sem pesquisa da ANP') + (nossos.has(m) ? '' : ' · sem abastecimentos'),
        grupo: NOME_UF[m.split('|')[0]],
      }));
    }
    return [];
  }
  // ao trocar de recorte, fica dentro do local atual (Bahia -> o município da Bahia com mais litros)
  function localPadrao(nivel, dentro) {
    const ops = new Set(opcoesLocal(nivel).map((o) => o.v));
    if (!ops.size) return '';
    const litros = new Map();
    for (const r of base) {
      if (dentro && !pertence(r, dentro.nivel, dentro.local)) continue;
      const k = chaveDe(r, nivel);
      if (ops.has(k)) litros.set(k, (litros.get(k) || 0) + r.litros);
    }
    const melhor = [...litros.entries()].sort((a, b) => b[1] - a[1])[0];
    return melhor ? melhor[0] : [...ops][0];
  }
  function desenharControles() {
    pagina.querySelectorAll('[data-per]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.per === estado.per)));
    pagina.querySelectorAll('[data-nivel]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.nivel === estado.nivel)));
    const ops = opcoesLocal(estado.nivel);
    el('anp-local').closest('.anp-grupo').classList.toggle('oculto', !ops.length);
    if (ops.length && !ops.some((o) => o.v === estado.local)) estado.local = localPadrao(estado.nivel, null);
    let grupo = null, html = '';
    for (const o of ops) {
      if (o.grupo !== grupo) { if (grupo) html += '</optgroup>'; if (o.grupo) html += '<optgroup label="' + esc(o.grupo) + '">'; grupo = o.grupo; }
      html += '<option value="' + esc(o.v) + '"' + (o.v === estado.local ? ' selected' : '') + '>' + esc(o.rot) + '</option>';
    }
    el('anp-local').innerHTML = html + (grupo ? '</optgroup>' : '');
    // trilha: Brasil › Nordeste › Bahia › Salvador (cada parte volta para aquele recorte)
    const partes = [];
    for (let at = estado.nivel === 'brasil' ? null : [estado.nivel, estado.local]; at; at = pai(at[0], at[1])) partes.unshift(at);
    partes.unshift(['brasil', '']);
    el('anp-trilha').innerHTML = partes.map(([n, l], i) => (i === partes.length - 1
      ? '<span aria-current="true">' + esc(nomeLocal(n, l)) + '</span>'
      : '<button type="button" class="link-acao" data-ir="' + n + '" data-local="' + esc(l) + '">' + esc(nomeLocal(n, l)) + '</button><span aria-hidden="true">›</span>')).join('');
  }
  function irPara(nivel, local) {
    const dentro = estado.nivel === 'brasil' ? null : { nivel: estado.nivel, local: estado.local };
    estado.nivel = nivel;
    estado.local = local !== undefined ? local : localPadrao(nivel, dentro);
    atualizar();
  }
  el('anp-per').addEventListener('click', (e) => { const b = e.target.closest('[data-per]'); if (b) { estado.per = b.dataset.per; atualizar(); } });
  el('anp-nivel').addEventListener('click', (e) => { const b = e.target.closest('[data-nivel]'); if (b && b.dataset.nivel !== estado.nivel) irPara(b.dataset.nivel); });
  el('anp-local').addEventListener('change', (e) => { estado.local = e.target.value; atualizar(); });
  el('anp-trilha').addEventListener('click', (e) => { const b = e.target.closest('[data-ir]'); if (b) irPara(b.dataset.ir, b.dataset.local); });

  // ---------- desenho ----------
  const nomeOrigem = () => 'em postos externos';
  const nomePer = (plural) => (estado.per === 'semanal' ? (plural ? 'semanas' : 'semana') : (plural ? 'meses' : 'mês'));
  function desenharTopo(t, rows) {
    const acima = t.dif !== null && t.dif > TOLERANCIA, abaixo = t.dif !== null && t.dif < -TOLERANCIA;
    // os três números do mostrador usam a mesma base (semanas/meses com ANP), para a diferença bater com a conta
    const parcial = t.cobertura !== null && t.cobertura < 0.995;
    el('anp-bomba').innerHTML = [
      { rot: 'Nosso preço ponderado', ico: 'preco', uni: 'R$/L', val: t.nossoC === null ? (t.nosso === null ? '—' : fmt.d3(t.nosso)) : fmt.d3(t.nossoC), destaque: true },
      { rot: 'Média de revenda ANP', ico: 'mercado', uni: 'R$/L', val: t.anp === null ? '—' : fmt.d3(t.anp) },
      { rot: 'Diferença', ico: 'comparar', uni: 'R$/L', val: sinal(t.dif, fmt.d3) },
    ].map((r) => '<div class="registro' + (r.destaque ? ' registro-principal' : '') + (r.ico ? ' ico-' + r.ico : '') + '"><dt>' + esc(r.rot) + '</dt><dd><span class="reg-num">' + esc(r.val) +
      '</span><span class="reg-uni">' + esc(r.uni) + '</span></dd></div>').join('');
    el('anp-resumo').innerHTML = htmlApoio([
      { rot: acima ? 'Pago acima da média ANP' : 'Economia contra a média ANP', val: t.impacto === null ? '—' : fmt.moeda(Math.abs(t.impacto)),
        det: t.dif === null ? '' : statusHtml(!acima, acima ? fmt.pct(t.dif / t.anp) + ' acima da média' : abaixo ? fmt.pct(-t.dif / t.anp) + ' abaixo da média' : 'na média') },
      { rot: titulo(nomePer(true)) + ' acima da média', val: t.comparados ? fmt.int(t.acima) + ' de ' + fmt.int(t.comparados) : '—' },
      { rot: 'Litros comparados com a ANP', val: t.lC ? fmt.int(t.lC) + ' L' : '—',
        det: parcial ? '<small class="anp-cobertura">' + fmt.pct(t.cobertura) + ' dos litros do período</small>' : '' },
    ]);
    el('anp-apoio').innerHTML = htmlApoio([
      { rot: 'Preço ponderado de todo o período', val: rs(t.nosso),
        det: parcial ? '<small class="anp-cobertura">inclui ' + nomePer(true) + ' ainda sem pesquisa da ANP</small>' : '' },
      { rot: 'Litros abastecidos', val: fmt.int(t.litros) },
      { rot: 'Valor pago', val: fmt.moeda(t.valor) },
      { rot: 'Postos usados', val: fmt.int(new Set(rows.map((r) => r.posto)).size) },
      { rot: 'Média da ANP usada', val: estado.nivel === 'brasil' || estado.nivel === 'regiao' ? 'a do estado de cada abastecimento' : nomeLocal(...referencia(estado.nivel, estado.local)),
        det: referencia(estado.nivel, estado.local)[0] !== estado.nivel ? '<small class="anp-cobertura">a ANP não pesquisa este município; comparado com a média do estado</small>' : '' },
    ]);
  }

  function desenharGrafico(t) {
    const pts = periodos(t).map((p) => {
      const a = t.porP.get(p), x = a ? a.x : null;
      return { chave: p, rotulo: rotPer(p), rotuloLongo: rotPerLongo(p), nosso: a ? a.nosso : null, anp: a ? a.anp : null, litros: a ? a.litros : 0, x };
    });
    el('anp-grafico-titulo').textContent = 'Nosso preço e a média da ANP, ' + (estado.per === 'semanal' ? 'semana a semana' : 'mês a mês') + ' · ' + nomeLocal(estado.nivel, estado.local);
    el('anp-grafico-nota').textContent = 'Nosso preço: soma do valor pago ÷ soma dos litros de diesel ' + nomeOrigem() + ' em cada ' +
      (estado.per === 'semanal' ? 'semana (domingo a sábado, como a ANP)' : 'mês') + '. Todo diesel dos abastecimentos conta como S10. ANP: preço médio de revenda do óleo diesel S10' +
      (t.misto ? ' do estado de cada abastecimento, pesado pelos mesmos litros (assim a comparação não mistura a diferença de preço entre estados).' : '.');
    graficoPeriodo(el('anp-grafico'), pts, {
      linhas: [{ campo: 'anp', rot: 'Média ANP', cor: 'var(--tinta-2)', tracejada: true }, { campo: 'nosso', rot: 'Nosso ponderado', cor: 'var(--serie-1)' }],
      ultimoParcial: pts.length > 1 && (estado.per === 'semanal' ? emAndamento('semana', pts[pts.length - 1].chave) : emAndamento('mes', mesDoDia(pts[pts.length - 1].chave))),
      fmtV: rs, fmtEixo: fmt.d2,
      extras: (p) => [['Litros', fmt.int(p.litros)], ...(p.x ? [['ANP mín. – máx.', (p.x.mn ? fmt.d3(p.x.mn) : '—') + ' – ' + (p.x.mx ? fmt.d3(p.x.mx) : '—')],
        ['Postos pesquisados', fmt.int(p.x.n)]] : [])],
      rotulo: 'Nosso preço ponderado e média de revenda da ANP por período',
    });
  }

  const COLUNAS = [
    { id: 'nome', rot: '', v: (g) => g.nome },
    { id: 'litros', rot: 'Litros', n: true, v: (g) => g.t.litros, f: fmt.int },
    // com ANP: só as semanas/meses comparados (a diferença ao lado bate com a conta); sem ANP: todo o período
    { id: 'nosso', rot: 'Nosso ponderado', n: true, v: (g) => (g.t.nossoC !== null ? g.t.nossoC : g.t.nosso), f: rs },
    { id: 'anp', rot: 'Média ANP', n: true, v: (g) => g.t.anp, f: rs },
    { id: 'dif', rot: 'Diferença R$/L', n: true, v: (g) => g.t.dif, f: (v) => sinal(v, fmt.d3) },
    { id: 'pct', rot: 'Diferença %', n: true, v: (g) => (g.t.dif === null ? null : g.t.dif / g.t.anp), f: (v) => sinal(v, fmt.pct) },
    { id: 'impacto', rot: 'Acima (+) / economia (−)', n: true, v: (g) => g.t.impacto, f: (v) => sinal(v, fmt.moeda) },
    { id: 'cobertura', rot: 'Litros com ANP', n: true, v: (g) => g.t.cobertura, f: (v) => (v === null ? '—' : fmt.pct(v)) },
  ];
  const NOME_NIVEL = { regiao: ['região', 'regiões'], estado: ['estado', 'estados'], municipio: ['município', 'municípios'], posto: ['posto', 'postos'] };
  function desenharFilhos(rows) {
    const nivelF = FILHO[estado.nivel];
    const grupos = new Map();
    for (const r of rows) {
      const k = chaveDe(r, nivelF);
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(r);
    }
    const lista = [...grupos.entries()].map(([k, rs2]) => ({
      k, nome: nivelF === 'posto' ? k : nomeLocal(nivelF, k),
      sub: nivelF === 'posto' ? 'posto externo' : (nivelF === 'municipio' && !munANP.has(k) ? 'sem pesquisa da ANP no município: comparado com o estado' : ''),
      // posto: comparado com a ANP do município dele; os demais: com a ANP do próprio local
      t: comparar(rs2, ...referencia(nivelF === 'posto' ? estado.nivel : nivelF, nivelF === 'posto' ? estado.local : k)),
      // por município: onde abastecemos e a que preço (do maior volume para o menor), para saber com quem negociar
      postos: nivelF === 'municipio' ? postosDe(rs2, k) : null,
    }));
    const cols = nivelF === 'municipio' ? [COLUNAS[0], COL_POSTOS, ...COLUNAS.slice(1)] : COLUNAS;
    const c = COLUNAS.find((x) => x.id === estado.ordem.col) || COLUNAS[1];
    lista.sort((a, b) => {
      const va = c.v(a), vb = c.v(b);
      if ((va === null) !== (vb === null)) return va === null ? 1 : -1;
      return estado.ordem.dir * (typeof va === 'string' ? va.localeCompare(vb, 'pt-BR') : va - vb) || b.t.litros - a.t.litros;
    });
    const [um, varios] = NOME_NIVEL[nivelF];
    el('anp-filhos-titulo').textContent = 'Por ' + um + (estado.nivel === 'brasil' ? '' : ' · ' + nomeLocal(estado.nivel, estado.local));
    el('anp-filhos-conta').textContent = lista.length + ' ' + (lista.length === 1 ? um : varios);
    el('anp-filhos-nota').textContent = nivelF === 'posto'
      ? 'Cada posto comparado com a média da ANP do município. Só onde abastecemos no período.'
      : 'Cada ' + um + ' comparado com a média da ANP dele. Clique numa linha para abrir o detalhe. Só onde abastecemos no período.';
    const clicavel = nivelF !== 'posto';
    el('anp-filhos').classList.toggle('tabela-clicavel', clicavel);
    el('anp-filhos').innerHTML = '<thead><tr>' + cols.map((col) => {
      if (col.id === 'postos') return '<th><span>' + esc(col.rot) + '</span></th>';
      const ativa = estado.ordem.col === col.id;
      return '<th' + (col.n ? ' class="n"' : '') + ' aria-sort="' + (ativa ? (estado.ordem.dir > 0 ? 'ascending' : 'descending') : 'none') + '"><button type="button" data-col="' + col.id + '">' +
        esc(col.id === 'nome' ? titulo(um) : col.rot) + (ativa ? '<span class="seta">' + (estado.ordem.dir > 0 ? '▲' : '▼') + '</span>' : '') + '</button></th>';
    }).join('') + '</tr></thead><tbody>' + (lista.length ? lista.map((g) => {
      const tom = g.t.dif === null ? '' : g.t.dif > TOLERANCIA ? ' anp-acima' : g.t.dif < -TOLERANCIA ? ' anp-abaixo' : '';
      return '<tr' + (clicavel ? ' data-filho="' + esc(g.k) + '" tabindex="0"' : '') + '>' + cols.map((col) => {
        if (col.id === 'nome') return '<td class="trunc"><strong>' + esc(g.nome) + '</strong>' + (g.sub ? '<small class="cidade-linha">' + esc(g.sub) + '</small>' : '') + '</td>';
        if (col.id === 'postos') return '<td class="anp-postos">' + htmlPostos(g.postos) + '</td>';
        const v = col.v(g);
        return '<td class="n' + (['dif', 'pct', 'impacto'].includes(col.id) && v !== null ? tom : '') + '">' + esc(col.f(v)) + '</td>';
      }).join('') + '</tr>';
    }).join('') : '<tr><td colspan="' + cols.length + '"><div class="vazio">Nenhum abastecimento de diesel neste recorte e período.</div></td></tr>') + '</tbody>';
  }

  // postos de um município no recorte: preço ponderado de cada um, comparado com a mesma ANP do município
  const MAX_POSTOS = 3;
  const COL_POSTOS = { id: 'postos', rot: 'Onde abastecemos (preço pago)' };
  function postosDe(rows, mun) {
    const porPosto = new Map();
    for (const r of rows) {
      if (!porPosto.has(r.posto)) porPosto.set(r.posto, []);
      porPosto.get(r.posto).push(r);
    }
    return [...porPosto.entries()].map(([posto, rs2]) => {
      const t = comparar(rs2, ...referencia('municipio', mun));
      return { posto, interno: false, litros: t.litros, preco: t.nossoC !== null ? t.nossoC : t.nosso, dif: t.dif };
    }).sort((a, b) => b.litros - a.litros);
  }
  function htmlPostos(ps) {
    const linha = (p) => '<span class="anp-posto' + (p.dif !== null && p.dif > TOLERANCIA ? ' anp-posto-acima' : '') + '" title="' +
      esc(p.posto + ': ' + rs(p.preco) + '/L em ' + fmt.int(p.litros) + ' L' + (p.dif === null ? '' : ' (' + sinal(p.dif, fmt.d3) + ' contra a ANP)')) + '">' +
      '<b>' + esc(p.posto) + '</b>' + (p.interno ? ' <small>bomba interna</small>' : '') +
      '<span class="num">' + esc(rs(p.preco)) + ' · ' + esc(fmt.int(p.litros)) + ' L' + (p.dif === null ? '' : ' · ' + esc(sinal(p.dif, fmt.d3)) + ' vs ANP') + '</span></span>';
    return ps.slice(0, MAX_POSTOS).map(linha).join('') +
      (ps.length > MAX_POSTOS ? '<small class="cidade-linha">+ ' + (ps.length - MAX_POSTOS) + ' outro' + (ps.length - MAX_POSTOS > 1 ? 's' : '') + ' (clique no município)</small>' : '');
  }

  function desenharPeriodos(t) {
    const lista = periodos(t).reverse();
    el('anp-periodos-titulo').textContent = (estado.per === 'semanal' ? 'Semana a semana' : 'Mês a mês') + ' · ' + nomeLocal(estado.nivel, estado.local);
    el('anp-periodos').innerHTML = '<thead><tr><th><span>' + titulo(nomePer(false)) + '</span></th><th class="n"><span>Litros</span></th>' +
      '<th class="n"><span>Nosso ponderado</span></th><th class="n"><span>Média ANP</span></th><th class="n"><span>ANP mín. – máx.</span></th>' +
      '<th class="n"><span>Postos pesquisados</span></th><th class="n"><span>Diferença R$/L</span></th><th class="n"><span>Acima (+) / economia (−)</span></th></tr></thead><tbody>' +
      (lista.length ? lista.map((p) => {
        const a = t.porP.get(p), x = a ? a.x : null;
        const nosso = a ? a.nosso : null, anpP = a ? a.anp : null, dif = nosso !== null && anpP !== null ? nosso - anpP : null;
        const tom = dif === null ? '' : dif > TOLERANCIA ? ' anp-acima' : dif < -TOLERANCIA ? ' anp-abaixo' : '';
        return '<tr><td>' + esc(rotPerLongo(p)) + '</td><td class="n">' + (a ? fmt.int(a.litros) : '—') + '</td><td class="n">' + rs(nosso) + '</td>' +
          '<td class="n">' + (anpP !== null ? rs(anpP) : '<span class="sem-dado">sem pesquisa</span>') + '</td>' +
          '<td class="n">' + (x && x.mn ? fmt.d3(x.mn) + ' – ' + fmt.d3(x.mx) : '—') + '</td><td class="n">' + (x ? fmt.int(x.n) : '—') + '</td>' +
          '<td class="n' + tom + '">' + sinal(dif, fmt.d3) + '</td><td class="n' + tom + '">' + (dif === null ? '—' : sinal(a.vC - a.aC, fmt.moeda)) + '</td></tr>';
      }).join('') : '<tr><td colspan="8"><div class="vazio">Sem dados neste período.</div></td></tr>') + '</tbody>';
  }

  function desenharFonte() {
    const r = anp.resumo || {};
    const sem = r.semanal && r.semanal.ultimo, mes = r.mensal && r.mensal.ultimo;
    el('anp-fonte').innerHTML = 'Fonte: ANP, Levantamento de Preços de Combustíveis (preço médio de revenda do óleo diesel S10). ' +
      'Última semana publicada: ' + (sem ? esc(fmtDia(sem) + ' a ' + fmtDia(sem + 6)) : '—') + '; último mês: ' + (mes ? esc(fmtMes(mesDoDia(mes), true)) : '—') +
      '. A atualização automática confere a ANP a cada 3 horas e traz a semana nova quando ela publica.';
    const g = new Date(dados.geradoEm);
    ctx.definirSub('Diesel ' + nomeOrigem() + ' contra a média de revenda da ANP (diesel S10). Dados atualizados em ' + g.toLocaleDateString('pt-BR') + ' às ' +
      g.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '.');
  }

  const atualizar = agendador(() => {
    desenharControles();
    filtros.atualizarUI();
    const rows = linhasDoRecorte().filter((r) => pertence(r, estado.nivel, estado.local));
    const t = comparar(rows, ...referencia(estado.nivel, estado.local));
    desenharTopo(t, rows);
    desenharGrafico(t);
    desenharFilhos(rows);
    desenharPeriodos(t);
    desenharFonte();
  });

  el('anp-filhos').addEventListener('click', (e) => {
    const col = e.target.closest('[data-col]');
    if (col) {
      const id = col.dataset.col;
      estado.ordem = estado.ordem.col === id ? { col: id, dir: -estado.ordem.dir } : { col: id, dir: id === 'nome' ? 1 : -1 };
      atualizar();
      return;
    }
    const tr = e.target.closest('[data-filho]');
    if (tr) irPara(FILHO[estado.nivel], tr.dataset.filho);
  });
  el('anp-filhos').addEventListener('keydown', (e) => {
    const tr = e.target.closest('[data-filho]');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); irPara(FILHO[estado.nivel], tr.dataset.filho); }
  });

  window.addEventListener('resize', atualizar);
  const aoAtualizarDados = () => {
    carregandoANP = null;   // o botão Atualizar também busca a ANP de novo (o navegador só baixa se a versão mudou)
    Promise.all([carregarDados(), carregarANP()]).then(([d, a]) => { usarANP(a); usarDados(d); atualizar(); }).catch(() => {});
  };
  window.addEventListener('dados-atualizados', aoAtualizarDados);
  atualizar();
  return {
    desmontar() {
      filtros.destruir();
      window.removeEventListener('resize', atualizar);
      window.removeEventListener('dados-atualizados', aoAtualizarDados);
    },
  };
}
