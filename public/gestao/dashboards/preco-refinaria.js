// Dashboard "Preço x Refinaria" — o preço que pagamos no diesel contra o preço da Petrobras às distribuidoras
// (tabela "Diesel S500 e S10" do portal precos.petrobras.com.br: sem tributos, à vista, por ponto de entrega e data de
// vigência). Mesmos recortes do "Preço x ANP": Brasil, região, estado, município e posto, semana a semana ou mês a mês.
// Dados: /gestao/dados/petrobras.json (scripts/petrobras_precos.py, enviado pelo vigia quando sai tabela nova).
//  - cada abastecimento de diesel é comparado com o ponto de entrega da Petrobras mais perto do município dele que
//    estava vendendo naquele dia (refinaria/terminal), no preço vigente no dia; modalidade EXA (retirada no ponto) e,
//    se o ponto não tiver EXA, a próxima da lista MODALIDADES
//  - todo diesel da Base conta como S10 (como no Preço x ANP)
//  - nosso preço e o preço da refinaria são PONDERADOS pelos litros (soma do valor ÷ soma dos litros; Σ litros × preço
//    da refinaria ÷ Σ litros); a diferença inclui tributos, biodiesel, frete e as margens da distribuidora e do posto
import { carregarDados, fmt, esc, fmtDia, fmtMes, mesDoDia, inicioDoMes, chaveNome } from '../lib/dados.js';
import { criarFiltros, htmlApoio, agendador, trocarEndereco } from '../lib/filtros.js';
import { graficoPeriodo, emAndamento } from '../lib/graficos.js';

const ROTA = '#/preco-refinaria';
const TOLERANCIA = 0.005;            // R$/L
const PRECO_MIN = 3, PRECO_MAX = 12; // R$/L: fora disso é erro de digitação na Base
const MODALIDADES = ['EXA', 'LPA', 'LCT', 'LPC', 'ETT', 'LPD', 'ETD', 'LTM', 'ETM'];
const NIVEIS = [['brasil', 'Brasil'], ['regiao', 'Região'], ['estado', 'Estado'], ['municipio', 'Município']];
const FILHO = { brasil: 'regiao', regiao: 'estado', estado: 'municipio', municipio: 'posto' };
const ORIGENS = [['externo', 'Postos externos'], ['interno', 'Bombas internas'], ['todos', 'Tudo']];
const REGIAO_UF = { AC: 'NORTE', AP: 'NORTE', AM: 'NORTE', PA: 'NORTE', RO: 'NORTE', RR: 'NORTE', TO: 'NORTE',
  AL: 'NORDESTE', BA: 'NORDESTE', CE: 'NORDESTE', MA: 'NORDESTE', PB: 'NORDESTE', PE: 'NORDESTE', PI: 'NORDESTE', RN: 'NORDESTE', SE: 'NORDESTE',
  DF: 'CENTRO OESTE', GO: 'CENTRO OESTE', MT: 'CENTRO OESTE', MS: 'CENTRO OESTE', ES: 'SUDESTE', MG: 'SUDESTE', RJ: 'SUDESTE', SP: 'SUDESTE',
  PR: 'SUL', RS: 'SUL', SC: 'SUL' };
const REGIOES = ['NORTE', 'NORDESTE', 'CENTRO OESTE', 'SUDESTE', 'SUL'];
const NOME_REGIAO = { NORTE: 'Norte', NORDESTE: 'Nordeste', 'CENTRO OESTE': 'Centro-Oeste', SUDESTE: 'Sudeste', SUL: 'Sul' };
const NOME_UF = { AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo',
  GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná',
  PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima',
  SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins' };

const chaveLocal = (s) => chaveNome(s).replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
const semana = (dia) => dia - ((dia + 4) % 7);   // domingo da semana (1970-01-01 foi quinta-feira)
const titulo = (s) => String(s || '').toLowerCase().replace(/(^|\s|-)(\S)/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(De|Da|Do|Das|Dos|E)\b/g, (m) => m.toLowerCase());
const rs = (v) => (v === null || v === undefined ? '—' : 'R$ ' + fmt.d3(v));
const sinal = (v, f) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v)));
function km(a, b) {   // distância em linha reta (haversine)
  const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

let carregando = null;
function carregarPetrobras() {
  carregando ||= fetch('/gestao/dados/petrobras.json', { credentials: 'same-origin' }).then(async (r) => {
    if (r.status === 401 || r.redirected) { location.href = '/?entrar=1'; throw new Error('sessão'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || 'Não foi possível carregar os preços da Petrobras (' + r.status + ').');
    return j;
  }).catch((e) => { carregando = null; throw e; });
  return carregando;
}

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando os abastecimentos e os preços da Petrobras…</div>';
  let dados, petro, municipios;
  try {
    [dados, petro, municipios] = await Promise.all([carregarDados(), carregarPetrobras(),
      fetch('/gestao/mapas/municipios.json', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : [])).catch(() => [])]);
  } catch (e) {
    pagina.innerHTML = '<div class="vazio">' + esc(e.message) + ' Recarregue a página para tentar de novo.</div>';
    return {};
  }
  const nomeMun = new Map(municipios.map(([nome, uf]) => [uf + '|' + chaveLocal(nome), nome]));
  const coordMun = new Map(municipios.map(([nome, uf, lat, lon]) => [uf + '|' + chaveLocal(nome), [lat, lon]]));

  // ---------- pontos de entrega da Petrobras ----------
  let pontos, vigencias;
  const cacheRef = new Map();
  function usarPetrobras(p) {
    petro = p;
    const porLocal = new Map();
    for (const s of p.pontos) {
      if (!porLocal.has(s.local)) porLocal.set(s.local, { local: s.local, cidade: s.cidade, uf: s.uf, coord: s.lat === null ? null : [s.lat, s.lon], mods: {} });
      porLocal.get(s.local).mods[s.mod] = { d: s.d, p: s.p };
    }
    pontos = [...porLocal.values()].filter((x) => x.coord);
    vigencias = [...new Set(p.pontos.flatMap((s) => s.d))].sort((a, b) => a - b);
    cacheRef.clear();
  }
  // última vigência da tabela até o dia (o preço vale da data de vigência até a próxima)
  function vigenciaEm(dia) {
    let lo = 0, hi = vigencias.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (vigencias[m] <= dia) { r = m; lo = m + 1; } else hi = m - 1; }
    return r < 0 ? null : vigencias[r];
  }
  // preço (R$/L) de um ponto numa vigência: só se o ponto vendia naquela vigência (está na coluna dela)
  function precoNoPonto(pt, v) {
    for (const mod of MODALIDADES) {
      const s = pt.mods[mod];
      if (!s) continue;
      const i = s.d.lastIndexOf(v);
      if (i >= 0) return { v: s.p[i] / 1000, mod };
    }
    return null;
  }
  // referência de um município num dia: o ponto mais perto que estava vendendo
  function referencia(mun, dia) {
    const v = vigenciaEm(dia);
    if (v === null) return null;
    const k = mun + '|' + v;
    if (cacheRef.has(k)) return cacheRef.get(k);
    const c = coordMun.get(mun);
    let melhor = null;
    if (c) {
      for (const pt of pontos) {
        const pr = precoNoPonto(pt, v);
        if (!pr) continue;
        const dist = km(c, pt.coord);
        if (!melhor || dist < melhor.dist) melhor = { ponto: pt.local, dist, preco: pr.v, mod: pr.mod, vig: v };
      }
    }
    cacheRef.set(k, melhor);
    return melhor;
  }
  usarPetrobras(petro);

  // ---------- nossos abastecimentos de diesel ----------
  let base = [];
  function usarDados(d) {
    dados = d;
    base = [];
    for (const l of d.linhas) {
      if (!/^DIESEL/.test(l.combustivel || '') || !(l.litros > 0) || !(l.vlLitro >= PRECO_MIN && l.vlLitro <= PRECO_MAX)) continue;
      const m = /^(.*) - ([A-Z]{2})$/.exec(l.cidade || '');
      if (!m || !REGIAO_UF[m[2]]) continue;
      const mun = m[2] + '|' + chaveLocal(m[1]);
      base.push({
        dia: l.dia, sem: semana(l.dia), mes: inicioDoMes(mesDoDia(l.dia)),
        uf: m[2], regiao: REGIAO_UF[m[2]], mun, posto: l.fornecedor, litros: l.litros, valor: l.despesa > 0 ? l.despesa : l.litros * l.vlLitro,
        origem: l.tipoEstab === 'POSTO DE COMBUSTIVEL' ? 'externo' : 'interno', ref: referencia(mun, l.dia),
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
    origem: ORIGENS.some(([o]) => o === q.get('origem')) ? q.get('origem') : 'externo',
    ordem: { col: 'litros', dir: -1 },
  };
  if (!location.hash.includes('?')) trocarEndereco(ROTA, ROTA + '?periodo=3meses');

  pagina.innerHTML = `
    <div class="anp-controles">
      <div class="anp-grupo"><span class="filtro-rotulo">Agrupar por</span>
        <div class="segmentado" role="group" aria-label="Agrupar por" id="rf-per">
          <button type="button" data-per="semanal">Semana</button><button type="button" data-per="mensal">Mês</button></div></div>
      <div class="anp-grupo"><span class="filtro-rotulo">Recorte</span>
        <div class="segmentado" role="group" aria-label="Recorte" id="rf-nivel">${NIVEIS.map(([n, r]) => '<button type="button" data-nivel="' + n + '">' + r + '</button>').join('')}</div></div>
      <div class="anp-grupo anp-local"><label class="filtro-rotulo" for="rf-local">Local</label><select id="rf-local" class="campo-sel"></select></div>
      <div class="anp-grupo"><span class="filtro-rotulo">Nossos abastecimentos</span>
        <div class="segmentado" role="group" aria-label="Nossos abastecimentos" id="rf-origem">${ORIGENS.map(([o, r]) => '<button type="button" data-origem="' + o + '">' + r + '</button>').join('')}</div></div>
    </div>
    <section class="filtros" id="rf-filtros" aria-label="Período"></section>
    <div class="chips" id="rf-chips" aria-live="polite"></div>
    <nav class="anp-trilha" id="rf-trilha" aria-label="Recorte atual"></nav>
    <div class="abertura">
      <section class="bomba" aria-labelledby="rf-bomba-titulo">
        <h2 class="bomba-titulo" id="rf-bomba-titulo">Nosso preço contra a refinaria</h2>
        <dl class="bomba-registros" id="rf-bomba"></dl>
      </section>
      <dl class="apoio apoio-coluna" id="rf-resumo"></dl>
    </div>
    <dl class="apoio" id="rf-apoio"></dl>
    <section class="painel painel-largo">
      <div class="painel-cab">
        <h2 id="rf-grafico-titulo"></h2>
        <div class="legenda"><span><i class="leg-media"></i>Nosso preço ponderado</span><span><i class="leg-meta leg-tracejada"></i>Preço da Petrobras (refinaria)</span></div>
      </div>
      <p class="nota" id="rf-grafico-nota"></p>
      <div class="grafico" id="rf-grafico"></div>
    </section>
    <section class="painel painel-tabela">
      <div class="painel-cab"><h2 id="rf-reajustes-titulo">Reajustes da Petrobras no período</h2><span class="conta" id="rf-reajustes-conta"></span></div>
      <p class="nota" id="rf-reajustes-nota"></p>
      <div class="tabela-rolagem"><table class="dados" id="rf-reajustes"></table></div>
    </section>
    <section class="painel painel-tabela">
      <div class="painel-cab"><h2 id="rf-filhos-titulo"></h2><span class="conta" id="rf-filhos-conta"></span></div>
      <p class="nota" id="rf-filhos-nota"></p>
      <div class="tabela-rolagem"><table class="dados" id="rf-filhos"></table></div>
    </section>
    <section class="painel painel-tabela">
      <div class="painel-cab"><h2 id="rf-periodos-titulo"></h2></div>
      <div class="tabela-rolagem tabela-alta"><table class="dados" id="rf-periodos"></table></div>
    </section>
    <p class="nota anp-fonte" id="rf-fonte"></p>`;
  const el = (id) => pagina.querySelector('#' + id);

  const filtros = criarFiltros({
    dimensoes: [{ id: 'periodo', rotulo: 'Período', periodo: true }],
    filtrosEl: el('rf-filtros'), chipsEl: el('rf-chips'), rota: ROTA,
    obterBase: () => base, obterLimites: () => [dados.diaMin, dados.diaMax], aoMudar: () => atualizar(), prefixo: 'rf',
    extrasURL: () => ({ per: estado.per, nivel: estado.nivel, local: estado.nivel === 'brasil' ? '' : estado.local, origem: estado.origem }),
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
  const pai = (nivel, local) => (nivel === 'regiao' ? null : nivel === 'estado' ? ['regiao', REGIAO_UF[local]] : nivel === 'municipio' ? ['estado', local.split('|')[0]] : null);

  // ---------- recorte: período e origem ----------
  const campoPer = () => (estado.per === 'semanal' ? 'sem' : 'mes');
  const rotPer = (p) => (estado.per === 'semanal' ? fmtDia(p).slice(0, 5) : fmtMes(mesDoDia(p)));
  const rotPerLongo = (p) => (estado.per === 'semanal' ? 'Semana de ' + fmtDia(p).slice(0, 5) + ' a ' + fmtDia(p + 6) : fmtMes(mesDoDia(p), true));
  function linhasDoRecorte() {
    const { de, ate } = filtros.periodo;
    return base.filter((r) => (estado.origem === 'todos' || r.origem === estado.origem) &&
      (de === null || r.dia >= de) && (ate === null || r.dia <= ate));
  }

  // comparação de um conjunto de abastecimentos com a refinaria de cada um
  function comparar(rows) {
    const c = campoPer();
    const t = { litros: 0, valor: 0, lC: 0, vC: 0, rC: 0, porP: new Map(), pontos: new Map() };
    for (const r of rows) {
      t.litros += r.litros; t.valor += r.valor;
      const a = t.porP.get(r[c]) || { litros: 0, valor: 0, lC: 0, vC: 0, rC: 0 };
      a.litros += r.litros; a.valor += r.valor;
      if (r.ref) {
        t.lC += r.litros; t.vC += r.valor; t.rC += r.litros * r.ref.preco;
        a.lC += r.litros; a.vC += r.valor; a.rC += r.litros * r.ref.preco;
        const p = t.pontos.get(r.ref.ponto) || { litros: 0, dist: 0 };
        p.litros += r.litros; p.dist += r.litros * r.ref.dist;
        t.pontos.set(r.ref.ponto, p);
      }
      t.porP.set(r[c], a);
    }
    t.nosso = t.litros ? t.valor / t.litros : null;
    t.nossoC = t.lC ? t.vC / t.lC : null;
    t.ref = t.lC ? t.rC / t.lC : null;
    t.dif = t.lC ? t.nossoC - t.ref : null;
    t.pct = t.lC ? t.dif / t.ref : null;
    t.total = t.lC ? t.vC - t.rC : null;
    t.cobertura = t.litros ? t.lC / t.litros : null;
    t.principais = [...t.pontos.entries()].sort((a, b) => b[1].litros - a[1].litros)
      .map(([ponto, p]) => ({ ponto, litros: p.litros, dist: p.dist / p.litros }));
    return t;
  }

  // ---------- controles ----------
  function opcoesLocal(nivel) {
    const nossos = (campo) => [...new Set(base.map((r) => r[campo]))];
    if (nivel === 'regiao') return REGIOES.filter((r) => nossos('regiao').includes(r)).map((r) => ({ v: r, rot: NOME_REGIAO[r] }));
    // estados agrupados por região (cada região uma vez, de norte a sul; estados em ordem alfabética dentro dela);
    // municípios agrupados pelo estado (estados e cidades em ordem alfabética)
    const alfa = (a, b) => a.localeCompare(b, 'pt-BR');
    if (nivel === 'estado') return nossos('uf').sort((a, b) => REGIOES.indexOf(REGIAO_UF[a]) - REGIOES.indexOf(REGIAO_UF[b]) || alfa(NOME_UF[a], NOME_UF[b]))
      .map((uf) => ({ v: uf, rot: NOME_UF[uf] + ' (' + uf + ')', grupo: NOME_REGIAO[REGIAO_UF[uf]] }));
    if (nivel === 'municipio') return nossos('mun').sort((a, b) => alfa(NOME_UF[a.split('|')[0]] || a, NOME_UF[b.split('|')[0]] || b) || alfa(a, b))
      .map((m) => ({ v: m, rot: nomeLocal('municipio', m), grupo: NOME_UF[m.split('|')[0]] }));
    return [];
  }
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
    pagina.querySelectorAll('[data-origem]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.origem === estado.origem)));
    const ops = opcoesLocal(estado.nivel);
    el('rf-local').closest('.anp-grupo').classList.toggle('oculto', !ops.length);
    if (ops.length && !ops.some((o) => o.v === estado.local)) estado.local = localPadrao(estado.nivel, null);
    let grupo = null, html = '';
    for (const o of ops) {
      if (o.grupo !== grupo) { if (grupo) html += '</optgroup>'; if (o.grupo) html += '<optgroup label="' + esc(o.grupo) + '">'; grupo = o.grupo; }
      html += '<option value="' + esc(o.v) + '"' + (o.v === estado.local ? ' selected' : '') + '>' + esc(o.rot) + '</option>';
    }
    el('rf-local').innerHTML = html + (grupo ? '</optgroup>' : '');
    const partes = [];
    for (let at = estado.nivel === 'brasil' ? null : [estado.nivel, estado.local]; at; at = pai(at[0], at[1])) partes.unshift(at);
    partes.unshift(['brasil', '']);
    el('rf-trilha').innerHTML = partes.map(([n, l], i) => (i === partes.length - 1
      ? '<span aria-current="true">' + esc(nomeLocal(n, l)) + '</span>'
      : '<button type="button" class="link-acao" data-ir="' + n + '" data-local="' + esc(l) + '">' + esc(nomeLocal(n, l)) + '</button><span aria-hidden="true">›</span>')).join('');
  }
  function irPara(nivel, local) {
    const dentro = estado.nivel === 'brasil' ? null : { nivel: estado.nivel, local: estado.local };
    estado.nivel = nivel;
    estado.local = local !== undefined ? local : localPadrao(nivel, dentro);
    atualizar();
  }
  el('rf-per').addEventListener('click', (e) => { const b = e.target.closest('[data-per]'); if (b) { estado.per = b.dataset.per; atualizar(); } });
  el('rf-nivel').addEventListener('click', (e) => { const b = e.target.closest('[data-nivel]'); if (b && b.dataset.nivel !== estado.nivel) irPara(b.dataset.nivel); });
  el('rf-origem').addEventListener('click', (e) => { const b = e.target.closest('[data-origem]'); if (b) { estado.origem = b.dataset.origem; atualizar(); } });
  el('rf-local').addEventListener('change', (e) => { estado.local = e.target.value; atualizar(); });
  el('rf-trilha').addEventListener('click', (e) => { const b = e.target.closest('[data-ir]'); if (b) irPara(b.dataset.ir, b.dataset.local); });

  // ---------- desenho ----------
  const nomeOrigem = () => ({ externo: 'em postos externos', interno: 'nas bombas internas', todos: 'em postos externos e bombas internas' }[estado.origem]);
  const nomePontos = (t, n) => t.principais.slice(0, n).map((p) => p.ponto + ' (' + fmt.int(p.dist) + ' km)').join(', ') + (t.principais.length > n ? ' e mais ' + (t.principais.length - n) : '');
  function desenharTopo(t, rows) {
    const parcial = t.cobertura !== null && t.cobertura < 0.995;
    el('rf-bomba').innerHTML = [
      { rot: 'Nosso preço ponderado', ico: 'preco', uni: 'R$/L', val: t.nossoC === null ? (t.nosso === null ? '—' : fmt.d3(t.nosso)) : fmt.d3(t.nossoC), destaque: true },
      { rot: 'Preço da refinaria', ico: 'mercado', uni: 'R$/L', val: t.ref === null ? '—' : fmt.d3(t.ref) },
      { rot: 'Diferença', ico: 'comparar', uni: 'R$/L', val: sinal(t.dif, fmt.d3) },
    ].map((r) => '<div class="registro' + (r.destaque ? ' registro-principal' : '') + (r.ico ? ' ico-' + r.ico : '') + '"><dt>' + esc(r.rot) + '</dt><dd><span class="reg-num">' + esc(r.val) +
      '</span><span class="reg-uni">' + esc(r.uni) + '</span></dd></div>').join('');
    el('rf-resumo').innerHTML = htmlApoio([
      { rot: 'Pago acima do preço da refinaria', val: t.total === null ? '—' : fmt.moeda(t.total),
        det: t.pct === null ? '' : '<small class="anp-cobertura">' + fmt.pct(t.pct) + ' sobre o preço da refinaria</small>' },
      { rot: 'Refinaria / terminal de referência', val: t.principais.length ? t.principais[0].ponto : '—',
        det: t.principais.length ? '<small class="anp-cobertura">' + esc(fmt.int(t.principais[0].dist)) + ' km em média' +
          (t.principais.length > 1 ? '; e mais ' + (t.principais.length - 1) : '') + '</small>' : '' },
      { rot: 'Litros comparados', val: t.lC ? fmt.int(t.lC) + ' L' : '—',
        det: parcial ? '<small class="anp-cobertura">' + fmt.pct(t.cobertura) + ' dos litros do período</small>' : '' },
    ]);
    el('rf-apoio').innerHTML = htmlApoio([
      { rot: 'Preço ponderado de todo o período', val: rs(t.nosso) },
      { rot: 'Litros abastecidos', val: fmt.int(t.litros) },
      { rot: 'Valor pago', val: fmt.moeda(t.valor) },
      { rot: 'Postos / bombas usados', val: fmt.int(new Set(rows.map((r) => r.posto)).size) },
      { rot: 'Pontos da Petrobras usados', val: fmt.int(t.principais.length), det: t.principais.length ? '<small class="anp-cobertura">' + esc(nomePontos(t, 3)) + '</small>' : '' },
    ]);
  }

  function desenharGrafico(t) {
    const pts = [...t.porP.keys()].sort((a, b) => a - b).map((p) => {
      const a = t.porP.get(p);
      return { chave: p, rotulo: rotPer(p), rotuloLongo: rotPerLongo(p), nosso: a.litros ? a.valor / a.litros : null, ref: a.lC ? a.rC / a.lC : null, litros: a.litros,
        dif: a.lC ? a.vC / a.lC - a.rC / a.lC : null };
    });
    el('rf-grafico-titulo').textContent = 'Nosso preço e o preço da Petrobras, ' + (estado.per === 'semanal' ? 'semana a semana' : 'mês a mês') + ' · ' + nomeLocal(estado.nivel, estado.local);
    el('rf-grafico-nota').textContent = 'Nosso preço: soma do valor pago ÷ soma dos litros de diesel ' + nomeOrigem() + '. Refinaria: preço da Petrobras às distribuidoras ' +
      '(diesel S10 sem tributos, no ponto de entrega mais perto de cada abastecimento, vigente no dia), pesado pelos mesmos litros.';
    graficoPeriodo(el('rf-grafico'), pts, {
      linhas: [{ campo: 'ref', rot: 'Refinaria', cor: 'var(--tinta-2)', tracejada: true }, { campo: 'nosso', rot: 'Nosso ponderado', cor: 'var(--serie-1)' }],
      ultimoParcial: pts.length > 1 && (estado.per === 'semanal' ? emAndamento('semana', pts[pts.length - 1].chave) : emAndamento('mes', mesDoDia(pts[pts.length - 1].chave))),
      fmtV: rs, fmtEixo: fmt.d2,
      extras: (p) => [['Litros', fmt.int(p.litros)], ['Diferença', p.dif === null ? '—' : sinal(p.dif, fmt.d3) + ' R$/L']],
      rotulo: 'Nosso preço ponderado e preço da Petrobras às distribuidoras por período',
    });
  }

  // reajustes da Petrobras no ponto principal do recorte, com o nosso preço na semana antes e na semana depois
  function desenharReajustes(t, rows) {
    const ponto = t.principais.length ? pontos.find((p) => p.local === t.principais[0].ponto) : null;
    const { de, ate } = filtros.periodo;
    const ini = de === null ? dados.diaMin : de, fim = ate === null ? dados.diaMax : ate;
    const media = (a, b) => {
      let l = 0, s = 0;
      for (const r of rows) if (r.dia >= a && r.dia <= b) { l += r.litros; s += r.valor; }
      return l ? s / l : null;
    };
    const lista = [];
    if (ponto) {
      let ant = null;
      for (const v of vigencias) {
        const pr = precoNoPonto(ponto, v);
        if (!pr) { ant = null; continue; }
        if (ant !== null && Math.abs(pr.v - ant.v) > 0.0005 && v >= ini && v <= fim) {
          lista.push({ v, preco: pr.v, var: pr.v - ant.v, pct: (pr.v - ant.v) / ant.v, antes: media(v - 7, v - 1), depois: media(v, v + 6) });
        }
        ant = pr;
      }
    }
    lista.reverse();
    el('rf-reajustes-titulo').textContent = 'Reajustes da Petrobras no período' + (ponto ? ' · ' + ponto.local : '');
    el('rf-reajustes-conta').textContent = ponto ? lista.length + (lista.length === 1 ? ' reajuste' : ' reajustes') : '';
    el('rf-reajustes-nota').textContent = ponto
      ? 'Ponto de entrega da Petrobras que mais serve este recorte. Ao lado de cada reajuste, o nosso preço ponderado ' + nomeOrigem() +
        ' (neste recorte) nos 7 dias antes e nos 7 dias a partir da data, para ver se o reajuste chegou ao preço que pagamos.'
      : '';
    el('rf-reajustes').innerHTML = !ponto ? '<tbody><tr><td><div class="vazio">Sem abastecimentos com referência da Petrobras neste recorte.</div></td></tr></tbody>'
      : '<thead><tr><th><span>Vigência</span></th><th class="n"><span>Preço Petrobras</span></th><th class="n"><span>Reajuste R$/L</span></th><th class="n"><span>Reajuste %</span></th>' +
        '<th class="n"><span>Nosso preço 7 dias antes</span></th><th class="n"><span>Nosso preço 7 dias depois</span></th><th class="n"><span>Variação do nosso</span></th></tr></thead><tbody>' +
        (lista.length ? lista.map((x) => {
          const nossaVar = x.antes !== null && x.depois !== null ? x.depois - x.antes : null;
          return '<tr><td>' + esc(fmtDia(x.v)) + '</td><td class="n">' + rs(x.preco) + '</td>' +
            '<td class="n ' + (x.var > 0 ? 'anp-acima' : 'anp-abaixo') + '">' + sinal(x.var, fmt.d3) + '</td><td class="n">' + sinal(x.pct, fmt.pct) + '</td>' +
            '<td class="n">' + rs(x.antes) + '</td><td class="n">' + rs(x.depois) + '</td>' +
            '<td class="n' + (nossaVar === null ? '' : nossaVar > TOLERANCIA ? ' anp-acima' : nossaVar < -TOLERANCIA ? ' anp-abaixo' : '') + '">' + sinal(nossaVar, fmt.d3) + '</td></tr>';
        }).join('') : '<tr><td colspan="7"><div class="vazio">A Petrobras não mudou o preço deste ponto no período escolhido.</div></td></tr>') + '</tbody>';
  }

  const COLUNAS = [
    { id: 'nome', rot: '', v: (g) => g.nome },
    { id: 'litros', rot: 'Litros', n: true, v: (g) => g.t.litros, f: fmt.int },
    { id: 'nosso', rot: 'Nosso ponderado', n: true, v: (g) => (g.t.nossoC !== null ? g.t.nossoC : g.t.nosso), f: rs },
    { id: 'ref', rot: 'Refinaria', n: true, v: (g) => g.t.ref, f: rs },
    { id: 'dif', rot: 'Diferença R$/L', n: true, v: (g) => g.t.dif, f: (v) => sinal(v, fmt.d3) },
    { id: 'pct', rot: 'Diferença %', n: true, v: (g) => g.t.pct, f: (v) => sinal(v, fmt.pct) },
    { id: 'vsMedia', rot: 'Contra a média do recorte', n: true, v: (g) => g.vsMedia, f: (v) => sinal(v, fmt.d3) },
    { id: 'total', rot: 'Pago acima da refinaria', n: true, v: (g) => g.t.total, f: (v) => (v === null ? '—' : fmt.moeda(v)) },
  ];
  const NOME_NIVEL = { regiao: ['região', 'regiões'], estado: ['estado', 'estados'], municipio: ['município', 'municípios'], posto: ['posto', 'postos'] };
  function desenharFilhos(rows, tRecorte) {
    const nivelF = FILHO[estado.nivel];
    const grupos = new Map();
    for (const r of rows) {
      const k = chaveDe(r, nivelF);
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(r);
    }
    const lista = [...grupos.entries()].map(([k, rs2]) => {
      const t = comparar(rs2);
      return {
        k, nome: nivelF === 'posto' ? k : nomeLocal(nivelF, k), t,
        sub: nivelF === 'posto' ? (rs2[0].origem === 'interno' ? 'bomba interna' : 'posto externo')
          : t.principais.length ? 'refinaria: ' + nomePontos(t, 1) : 'sem referência da Petrobras',
        // diferença deste local menos a diferença do recorte: quem paga mais acima da refinaria que a média
        vsMedia: t.dif !== null && tRecorte.dif !== null ? t.dif - tRecorte.dif : null,
      };
    });
    const c = COLUNAS.find((x) => x.id === estado.ordem.col) || COLUNAS[1];
    lista.sort((a, b) => {
      const va = c.v(a), vb = c.v(b);
      if ((va === null) !== (vb === null)) return va === null ? 1 : -1;
      return estado.ordem.dir * (typeof va === 'string' ? va.localeCompare(vb, 'pt-BR') : va - vb) || b.t.litros - a.t.litros;
    });
    const [um, varios] = NOME_NIVEL[nivelF];
    el('rf-filhos-titulo').textContent = 'Por ' + um + (estado.nivel === 'brasil' ? '' : ' · ' + nomeLocal(estado.nivel, estado.local));
    el('rf-filhos-conta').textContent = lista.length + ' ' + (lista.length === 1 ? um : varios);
    el('rf-filhos-nota').textContent = 'Cada ' + um + ' comparado com a refinaria de cada abastecimento. "Contra a média do recorte": quanto a diferença dele fica acima (vermelho) ou abaixo ' +
      '(verde) da diferença de ' + nomeLocal(estado.nivel, estado.local) + '.' + (nivelF === 'posto' ? '' : ' Clique numa linha para abrir o detalhe.');
    const clicavel = nivelF !== 'posto';
    el('rf-filhos').classList.toggle('tabela-clicavel', clicavel);
    el('rf-filhos').innerHTML = '<thead><tr>' + COLUNAS.map((col) => {
      const ativa = estado.ordem.col === col.id;
      return '<th' + (col.n ? ' class="n"' : '') + ' aria-sort="' + (ativa ? (estado.ordem.dir > 0 ? 'ascending' : 'descending') : 'none') + '"><button type="button" data-col="' + col.id + '">' +
        esc(col.id === 'nome' ? titulo(um) : col.rot) + (ativa ? '<span class="seta">' + (estado.ordem.dir > 0 ? '▲' : '▼') + '</span>' : '') + '</button></th>';
    }).join('') + '</tr></thead><tbody>' + (lista.length ? lista.map((g) => {
      const tom = g.vsMedia === null ? '' : g.vsMedia > TOLERANCIA ? ' anp-acima' : g.vsMedia < -TOLERANCIA ? ' anp-abaixo' : '';
      return '<tr' + (clicavel ? ' data-filho="' + esc(g.k) + '" tabindex="0"' : '') + '>' + COLUNAS.map((col) => {
        if (col.id === 'nome') return '<td class="trunc"><strong>' + esc(g.nome) + '</strong>' + (g.sub ? '<small class="cidade-linha">' + esc(g.sub) + '</small>' : '') + '</td>';
        const v = col.v(g);
        return '<td class="n' + (col.id === 'vsMedia' ? tom : '') + '">' + esc(col.f(v)) + '</td>';
      }).join('') + '</tr>';
    }).join('') : '<tr><td colspan="' + COLUNAS.length + '"><div class="vazio">Nenhum abastecimento de diesel neste recorte e período.</div></td></tr>') + '</tbody>';
  }

  function desenharPeriodos(t) {
    const lista = [...t.porP.keys()].sort((a, b) => b - a);
    el('rf-periodos-titulo').textContent = (estado.per === 'semanal' ? 'Semana a semana' : 'Mês a mês') + ' · ' + nomeLocal(estado.nivel, estado.local);
    el('rf-periodos').innerHTML = '<thead><tr><th><span>' + (estado.per === 'semanal' ? 'Semana' : 'Mês') + '</span></th><th class="n"><span>Litros</span></th>' +
      '<th class="n"><span>Nosso ponderado</span></th><th class="n"><span>Refinaria</span></th><th class="n"><span>Diferença R$/L</span></th>' +
      '<th class="n"><span>Diferença %</span></th><th class="n"><span>Pago acima da refinaria</span></th></tr></thead><tbody>' +
      (lista.length ? lista.map((p) => {
        const a = t.porP.get(p);
        const nosso = a.lC ? a.vC / a.lC : a.valor / a.litros, ref = a.lC ? a.rC / a.lC : null, dif = ref === null ? null : nosso - ref;
        return '<tr><td>' + esc(rotPerLongo(p)) + '</td><td class="n">' + fmt.int(a.litros) + '</td><td class="n">' + rs(nosso) + '</td>' +
          '<td class="n">' + (ref === null ? '<span class="sem-dado">sem referência</span>' : rs(ref)) + '</td>' +
          '<td class="n">' + sinal(dif, fmt.d3) + '</td><td class="n">' + (dif === null ? '—' : sinal(dif / ref, fmt.pct)) + '</td>' +
          '<td class="n">' + (dif === null ? '—' : fmt.moeda(a.vC - a.rC)) + '</td></tr>';
      }).join('') : '<tr><td colspan="7"><div class="vazio">Sem dados neste período.</div></td></tr>') + '</tbody>';
  }

  function desenharFonte() {
    el('rf-fonte').innerHTML = 'Fonte: Petrobras, ' + esc(petro.titulo) + ' (precos.petrobras.com.br): preços de venda às distribuidoras, sem tributos, à vista, ' +
      'por ponto de entrega e data de vigência, desde ' + esc(fmtDia(petro.vigenciaMin)) + '. Última vigência: ' + esc(fmtDia(petro.vigenciaMax)) + '. ' +
      'Modalidade usada: EXA (retirada no ponto); onde não há EXA, a próxima disponível. A diferença para o nosso preço inclui tributos (ICMS, PIS/Cofins, CIDE), ' +
      'biodiesel, frete e as margens da distribuidora e do posto. Desde mai/2026 alguns preços da tabela têm desconto de subvenção federal ao diesel ' +
      '(MP 1.358, MP 1.363 e MP 1.391), por isso há saltos grandes em poucas semanas. A atualização automática confere o portal da Petrobras a cada 3 horas.';
    const g = new Date(dados.geradoEm);
    ctx.definirSub('Diesel ' + nomeOrigem() + ' contra o preço da Petrobras às distribuidoras (refinaria/terminal mais perto). Dados atualizados em ' +
      g.toLocaleDateString('pt-BR') + ' às ' + g.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '.');
  }

  const atualizar = agendador(() => {
    desenharControles();
    filtros.atualizarUI();
    const rows = linhasDoRecorte().filter((r) => pertence(r, estado.nivel, estado.local));
    const t = comparar(rows);
    desenharTopo(t, rows);
    desenharGrafico(t);
    desenharReajustes(t, rows);
    desenharFilhos(rows, t);
    desenharPeriodos(t);
    desenharFonte();
  });

  el('rf-filhos').addEventListener('click', (e) => {
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
  el('rf-filhos').addEventListener('keydown', (e) => {
    const tr = e.target.closest('[data-filho]');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); irPara(FILHO[estado.nivel], tr.dataset.filho); }
  });

  window.addEventListener('resize', atualizar);
  const aoAtualizarDados = () => {
    carregando = null;
    Promise.all([carregarDados(), carregarPetrobras()]).then(([d, p]) => { usarPetrobras(p); usarDados(d); atualizar(); }).catch(() => {});
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
