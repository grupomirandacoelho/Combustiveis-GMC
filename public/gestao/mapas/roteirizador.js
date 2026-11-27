// Mapa "Roteirizador SPOT" — adaptação do "Planejador de rota & abastecimentos" (rotas esporádicas, fora das bases).
// Mesma lógica do planejador original, com os dados da Base de transações do portal:
//  - preço do posto = abastecimento de diesel mais recente nele (preços fora de R$ 4 a R$ 10 são descartados)
//  - posto sem abastecimento de diesel há mais de 30 dias (contados da transação mais recente da Base) fica de fora
//  - coordenadas dos postos: planilha LOCALIZAÇÃO DOS POSTOS; tanque e ponto crítico (km/L): aba Metas
//  - autonomia = tanque × 85% × km/L do ponto crítico (15% de reserva nunca é usado)
//  - preço de referência = posto mais barato nos últimos 150 km da rota; em posto com preço até a referência
//    enche o tanque; nos mais caros, só o necessário até o próximo posto barato; mínimo de 30% do tanque por parada
//  - rota real de rodovia pelo OSRM; se o serviço não responder, linha direta × 1,25 (e avisa na tela)
import { carregarDados, esc, fmt, fmtDia, chaveNome, isoParaDia } from '../lib/dados.js';
import { htmlBomba, htmlApoio } from '../lib/filtros.js';

const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
// unidades (bases) da empresa no mapa; posto interno a até RAIO_BASE_KM delas aparece com o nome da base
const BASES = [
  { nome: 'RAJA BELEM', lat: -1.396863, lng: -48.418540 },
  { nome: 'RAJA JEQUIE', lat: -13.857862, lng: -40.116867 },
  { nome: 'RAJA SALVADOR', lat: -12.724494, lng: -38.595668 },
  { nome: 'RAJA SAO PAULO', lat: -22.539012, lng: -47.381021 },
  { nome: 'RAJA RECIFE', lat: -8.342522, lng: -35.001796 },
  { nome: 'RAJA ILHEUS', lat: -14.745345, lng: -39.069429 },
  { nome: 'RAJA VITORIA DA CONQUISTA', lat: -14.816831, lng: -40.811709 },
  { nome: 'RAJA TEIXEIRA DE FREITAS', lat: -14.529474, lng: -39.762301 },
  { nome: 'RAJA SERRA', lat: -20.194691, lng: -40.237956 },
  { nome: 'RAJA MARANHÃO', lat: -2.558909, lng: -44.340932 },
];
const RAIO_BASE_KM = 1.5;
const DIAS_VALIDADE = 30, PRECO_MIN = 4, PRECO_MAX = 10;
const RESERVA = 0.15, MIN_ABASTECIMENTO = 0.30, FAIXA_REFERENCIA_KM = 150;
const DESVIO_KM = 5, DESVIO_KM_ESTIMADO = 45, FATOR_RODOVIA = 1.25;
const DIESEL = { 'DIESEL S-10 COMUM': 'S-10', 'DIESEL S-10 ADITIVADO': 'S-10 aditivado', 'DIESEL': 'Comum', 'DIESEL COMUM': 'Comum' };

let carregandoLeaflet = null;
function carregarLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!carregandoLeaflet) {
    carregandoLeaflet = new Promise((ok, erro) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = LEAFLET + 'leaflet.min.css';
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = LEAFLET + 'leaflet.min.js';
      s.onload = () => ok(window.L);
      s.onerror = () => { carregandoLeaflet = null; erro(new Error('Não foi possível carregar o mapa. Verifique a internet e recarregue a página.')); };
      document.head.appendChild(s);
    });
  }
  return carregandoLeaflet;
}
let carregandoCidades = null;
const carregarCidades = () => (carregandoCidades ||= fetch('/gestao/mapas/cidades.json', { credentials: 'same-origin' })
  .then((r) => (r.ok ? r.json() : {})).catch(() => ({})));

// ---------- municípios: os 5.570 do IBGE com a coordenada da sede (mapas/municipios.json: [nome, UF, lat, lng]) ----------
// A cidade escolhida vai para a sede do município. Antes, cidade fora do dicionário pegava a coordenada de um posto
// dela (que pode estar na rodovia, longe do centro, ou errada na planilha).
// fábricas dos clientes (mapas/clientes.json: {empresa, nome, cidade, uf, lat, lng, confianca}); sem o arquivo, lista vazia
let carregandoClientes = null;
const carregarClientes = () => (carregandoClientes ||= fetch('/gestao/mapas/clientes.json', { credentials: 'same-origin' })
  .then((r) => (r.ok ? r.json() : [])).catch(() => []));
let carregandoMunicipios = null;
const carregarMunicipios = () => (carregandoMunicipios ||= fetch('/gestao/mapas/municipios.json', { credentials: 'same-origin' })
  .then((r) => (r.ok ? r.json() : [])).catch(() => { carregandoMunicipios = null; return []; }));

// Campo com busca e lista suspensa (combobox acessível): filtra enquanto digita, setas + Enter para escolher.
// obterOpcoes(texto) -> [{grupo}] ou [{rotulo, sub, valor}]; a opção escolhida fica em input._escolha.
let combos = 0;
function criarCombo(input, obterOpcoes) {
  const id = 'rt-combo-' + (++combos);
  const lista = document.createElement('ul');
  lista.className = 'rot-combo-lista oculto';
  lista.id = id;
  lista.setAttribute('role', 'listbox');
  input.after(lista);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', id);
  let opcoes = [], ativo = -1;
  const escolhiveis = () => opcoes.filter((o) => !o.grupo);
  function fechar() { lista.classList.add('oculto'); input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); ativo = -1; }
  function desenhar() {
    let n = -1;
    lista.innerHTML = opcoes.length ? opcoes.map((o) => (o.grupo
      ? '<li class="rot-combo-grupo" role="presentation">' + esc(o.grupo) + '</li>'
      : '<li role="option" id="' + id + '-' + (++n) + '" data-n="' + n + '" aria-selected="' + (n === ativo) + '" class="' + (n === ativo ? 'ativo' : '') + '">' +
        '<span>' + esc(o.rotulo) + '</span>' + (o.sub ? '<small>' + esc(o.sub) + '</small>' : '') + '</li>')).join('')
      : '<li class="rot-combo-grupo" role="presentation">Nada encontrado. Confira o nome ou escreva "Cidade, UF".</li>';
    lista.classList.remove('oculto');
    input.setAttribute('aria-expanded', 'true');
    if (ativo >= 0) {
      input.setAttribute('aria-activedescendant', id + '-' + ativo);
      const li = lista.querySelector('[data-n="' + ativo + '"]');
      if (li) li.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function abrir() { opcoes = obterOpcoes(input.value); ativo = -1; desenhar(); }
  function escolher(o) { input.value = o.rotulo; input._escolha = o; fechar(); }
  input.addEventListener('input', () => { input._escolha = null; abrir(); });
  input.addEventListener('focus', abrir);
  input.addEventListener('blur', () => setTimeout(fechar, 150));
  input.addEventListener('keydown', (e) => {
    const es = escolhiveis();
    if (e.key === 'ArrowDown') { if (lista.classList.contains('oculto')) abrir(); ativo = Math.min(es.length - 1, ativo + 1); desenhar(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { ativo = Math.max(0, ativo - 1); desenhar(); e.preventDefault(); }
    else if (e.key === 'Enter' && !lista.classList.contains('oculto') && es.length) { escolher(es[ativo >= 0 ? ativo : 0]); e.preventDefault(); }
    else if (e.key === 'Escape') fechar();
  });
  lista.addEventListener('mousedown', (e) => {
    const li = e.target.closest('[data-n]');
    if (!li) return;
    e.preventDefault();
    escolher(escolhiveis()[+li.dataset.n]);
  });
  return { atualizar() { if (!lista.classList.contains('oculto')) abrir(); } };
}

// ---------- geografia ----------
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const normCidade = (s) => chaveNome(s).replace(/[^A-Z\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Situação de cada posto na lista dos motoristas (planilha de negociações): última negociação de cada unidade
// desde a data de corte da lista. Bloqueado nunca entra na rota; POLO pode completar o tanque; MÍNIMO (coluna Tipo,
// ou aviso começando com "MINIMO") é posto de pernoite/auxiliar: só o necessário até o próximo posto que completa.
const DATA_CORTE_LISTA = isoParaDia('2026-09-15');   // a mesma de scripts/planilha_negociacao.py
const FORCA_CLASSE = { polo: 3, autorizado: 2, minimo: 1, bloqueado: 0 };
function situacaoDosPostos(negPostos) {
  const ult = new Map();
  for (const n of negPostos) {
    if (n.dia < DATA_CORTE_LISTA) continue;
    const k = chaveNome(n.unidade) + '|' + chaveNome(n.posto);
    const a = ult.get(k);
    if (!a || n.dia > a.dia || (n.dia === a.dia && n.ordem > a.ordem)) ult.set(k, n);
  }
  const porPosto = new Map();   // nome do posto -> {classe, aviso, valor, dia}
  for (const n of ult.values()) {
    let classe;
    if (n.status === 'POSTO BLOQUEADO') classe = 'bloqueado';
    else if (n.status !== 'POSTO AUTORIZADO') continue;   // em negociação: fica como posto fora da lista
    else if (n.tipo === 'POLO') classe = 'polo';
    else if (n.tipo === 'MINIMO' || /^MINIMO/.test(chaveNome(n.aviso))) classe = 'minimo';
    else classe = 'autorizado';
    const k = chaveNome(n.posto), a = porPosto.get(k);
    // o mesmo posto em duas unidades: vale a situação mais permissiva (autorizado em alguma unidade = autorizado)
    if (!a || FORCA_CLASSE[classe] > FORCA_CLASSE[a.classe]) porPosto.set(k, { classe, aviso: n.aviso, valor: n.valor, dia: n.dia });
  }
  return porPosto;
}

// postos com preço, a partir das transações da Base
function montarPostos(dados, dias) {
  const corte = dados.diaMax - dias;
  const porPosto = new Map();
  for (const l of dados.linhas) {
    const tipo = DIESEL[l.combustivel];
    if (!tipo || !(l.vlLitro >= PRECO_MIN && l.vlLitro <= PRECO_MAX)) continue;
    const nome = String(l.fornecedor || '').toUpperCase().trim();
    const coord = dados.locais[nome];
    if (!coord) continue;
    const m = (l.dia * 86400) + (l.seg || 0);
    let p = porPosto.get(nome);
    if (!p) porPosto.set(nome, (p = { nome, chave: nome, lat: coord[0], lng: coord[1], cidade: l.cidade, n: 0, m: -1 }));
    p.n++;
    if (m > p.m) { p.m = m; p.dia = l.dia; p.preco = l.vlLitro; p.tipo = tipo; p.cidade = l.cidade; }
  }
  const postos = [...porPosto.values()];
  const lista = situacaoDosPostos(dados.negPostos || []);
  const mercado = indiceMercado(dados);
  postos.forEach((p) => {
    const s = lista.get(chaveNome(p.nome));
    p.classe = s ? s.classe : 'livre';
    p.aviso = s ? s.aviso : '';
    p.negValor = s ? s.valor : null; p.negDia = s ? s.dia : null;   // última negociação (mostrada ao clicar no posto)
    // posto interno no mesmo lugar de uma base: no mapa e no plano aparece o nome da base
    const base = BASES.find((b) => haversine(b.lat, b.lng, p.lat, p.lng) <= RAIO_BASE_KM);
    p.base = base ? base.nome : null;
    p.exibe = base ? base.nome + ' (base)' : p.nome;
    p.fonte = 'abastecimento';
    p.diaTx = p.dia; p.precoTx = p.preco;   // última transação (mostrada ao clicar no posto)
    // posto autorizado com negociação mais nova que o último abastecimento: vale o preço negociado
    if (s && s.classe !== 'bloqueado' && s.valor > 0 && s.dia > p.dia) { p.preco = s.valor; p.dia = s.dia; p.fonte = 'negociação'; }
    p.desatualizado = p.dia < corte;
    // preço trazido para hoje pela variação do mercado desde a data dele (preço antigo de um posto não parece barato só por ser antigo)
    p.idade = dados.diaMax - p.dia;
    p.precoAj = p.idade > 15 ? p.preco * mercado.atual / mercado.em(p.dia) : p.preco;   // até 15 dias, vale o preço como está
  });
  return postos;
}

// Índice do preço do diesel nos postos externos, pelas transações da própria frota, encadeado por quinzena:
// a variação de uma quinzena para a seguinte é a mediana da variação dos MESMOS postos nas duas (assim a troca de
// postos não parece alta ou baixa de mercado). Serve para comparar preços de datas diferentes.
const QUINZENA = 14;
function indiceMercado(dados) {
  const mediana = (v) => { const o = [...v].sort((a, b) => a - b); return o[Math.floor(o.length / 2)]; };
  const precos = new Map();   // quinzena -> posto -> [preços]
  for (const l of dados.linhas) {
    if (!DIESEL[l.combustivel] || l.tipoEstab !== 'POSTO DE COMBUSTIVEL' || !(l.vlLitro >= PRECO_MIN && l.vlLitro <= PRECO_MAX)) continue;
    const q = Math.floor(l.dia / QUINZENA);
    if (!precos.has(q)) precos.set(q, new Map());
    const m = precos.get(q);
    if (!m.has(l.fornecedor)) m.set(l.fornecedor, []);
    m.get(l.fornecedor).push(l.vlLitro);
  }
  const qs = [...precos.keys()].sort((a, b) => a - b);
  const indice = new Map();
  let acumulado = 1, anterior = null;
  for (const q of qs) {
    const atual = new Map([...precos.get(q)].map(([f, v]) => [f, mediana(v)]));
    if (anterior) {
      const razoes = [];
      for (const [f, p] of atual) if (anterior.has(f)) razoes.push(p / anterior.get(f));
      if (razoes.length >= 5) acumulado *= mediana(razoes);   // poucos postos em comum: considera estável
    }
    indice.set(q, acumulado);
    anterior = atual;
  }
  const em = (dia) => {
    let q = Math.floor(dia / QUINZENA);
    while (!indice.has(q) && q > qs[0]) q--;
    return indice.get(q) || 1;
  };
  return { em, atual: em(dados.diaMax) };
}

// A escolha é sempre pelo menor preço (já corrigido pela data). A situação na lista só desempata preços iguais;
// quando um posto da lista está bem perto do escolhido, o plano avisa (ALERTA_PROXIMO).
const ALERTA_PROXIMO = 0.05;    // R$/L: autorizado/polo até isso mais caro que o escolhido gera alerta
const ALERTA_AJUSTE = 0.10;     // R$/L: correção de preço antigo a partir da qual o plano avisa
const ROTULO_CLASSE = {
  polo: ['Polo · pode completar', 'sit-ok'],
  autorizado: ['Autorizado', 'sit-ok'],
  minimo: ['Mínimo · pernoite/auxiliar', 'sit-alerta'],
  livre: ['Fora da lista', 'sit-livre'],
};
const COR_PINO = '#1C2226';   // pino das paradas: escuro nos dois temas (o número é branco)
const COR_CLASSE = { polo: '--bom', autorizado: '--cat-1', minimo: '--faixa', livre: '--eixo' };

// cidades para localizar origem/destino: sede de cada município (IBGE); o dicionário do planejador só completa o que
// faltar (ex.: distritos). Os postos não dão mais coordenada de cidade: só marcam "cidade com postos da frota".
function montarCidades(municipios, base, postos) {
  const c = new Map();
  for (const [nome, uf, lat, lng] of municipios) c.set(normCidade(nome) + '|' + uf, { nome, uf, lat, lng });
  for (const [k, v] of Object.entries(base)) {
    const [cid, uf] = k.split('|');
    const kk = normCidade(cid) + '|' + uf;
    if (!c.has(kk)) c.set(kk, { nome: cid, uf, lat: v[0], lng: v[1] });
  }
  for (const p of postos) {
    const m = /^(.*) - ([A-Z]{2})$/.exec(p.cidade || '');
    const x = m && c.get(normCidade(m[1]) + '|' + m[2]);
    if (x) x.frota = true;
  }
  return c;
}
function localizarNaLista(cidades, texto) {
  const partes = String(texto || '').split(/[,/]| - /);
  const cid = normCidade(partes[0]);
  const uf = partes.length > 1 ? normCidade(partes[partes.length - 1]).slice(0, 2) : null;
  if (!cid) return null;
  const todas = [...cidades.entries()];
  const achar = (f) => todas.find(([k, v]) => f(k.split('|')[0]) && (!uf || v.uf === uf));
  const r = achar((n) => n === cid) || achar((n) => n.startsWith(cid)) || achar((n) => n.includes(cid));
  return r ? { lat: r[1].lat, lng: r[1].lng, rotulo: r[1].nome + '/' + r[1].uf } : null;
}
async function localizar(cidades, texto) {
  const local = localizarNaLista(cidades, texto);
  if (local) return local;
  try {   // cidade fora da lista: pergunta ao OpenStreetMap (Nominatim)
    const q = texto.trim() + (/brasil|brazil/i.test(texto) ? '' : ', Brasil');
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    return j.length ? { lat: +j[0].lat, lng: +j[0].lon, rotulo: j[0].display_name.split(',').slice(0, 2).join(',') } : null;
  } catch { return null; }
}

// ---------- rota ----------
function rotaEstimada(pontos) {
  const coords = []; let dist = 0;
  for (let i = 0; i < pontos.length - 1; i++) {
    const a = pontos[i], b = pontos[i + 1];
    const km = haversine(a.lat, a.lng, b.lat, b.lng) * FATOR_RODOVIA;
    dist += km;
    const n = Math.max(20, Math.round(km / 8));
    for (let j = 0; j < n; j++) coords.push([a.lng + (b.lng - a.lng) * (j / n), a.lat + (b.lat - a.lat) * (j / n)]);
  }
  const u = pontos[pontos.length - 1];
  coords.push([u.lng, u.lat]);
  return { coords, km: dist, minutos: dist, estimada: true };
}
// até 3 caminhos (rotas alternativas do OSRM; com paradas no meio ele devolve só um)
async function tracarRotas(pontos) {
  try {
    const c = pontos.map((p) => p.lng + ',' + p.lat).join(';');
    const r = await fetch('https://router.project-osrm.org/route/v1/driving/' + c + '?overview=full&geometries=geojson&steps=false&alternatives=3');
    if (!r.ok) throw new Error('osrm');
    const j = await r.json();
    if (!j.routes || !j.routes.length) throw new Error('sem rota');
    return j.routes.slice(0, 3).map((x) => ({ coords: x.geometry.coordinates, km: x.distance / 1000, minutos: x.duration / 60, estimada: false }));
  } catch { return [rotaEstimada(pontos)]; }
}
function acumulado(coords) {
  const cum = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  return cum;
}

// postos a até N km da rota, com o km em que ficam
function postosNaRota(rota, postos, excluidos, desvio) {
  const raio = rota.estimada ? Math.max(desvio, DESVIO_KM_ESTIMADO) : desvio;
  const lista = [];
  // caixa em volta da rota para não medir distância de todos os postos a todos os pontos
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const [lng, lat] of rota.coords) { minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat); minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng); }
  const folga = raio / 100 + 0.05;
  for (const p of postos) {
    if (excluidos.has(p.chave)) continue;
    if (p.lat < minLat - folga || p.lat > maxLat + folga || p.lng < minLng - folga || p.lng > maxLng + folga) continue;
    let d = Infinity, idx = -1;
    for (let i = 0; i < rota.coords.length; i++) {
      const x = haversine(p.lat, p.lng, rota.coords[i][1], rota.coords[i][0]);
      if (x < d) { d = x; idx = i; }
    }
    if (d <= raio) lista.push({ posto: p, km: rota.cum[idx], desvio: d, preco: p.preco, precoAj: p.precoAj });
  }
  return lista.sort((a, b) => a.km - b.km);
}

// abastecimentos: estratégia do planejador original + lista dos motoristas (polo/autorizado/mínimo) + litros redondos
const LITROS_PASSO = 10;   // o motorista recebe sempre múltiplos de 10 L
const efetivo = (s) => s.precoAj;   // preço corrigido para hoje
const completa = (s) => s.posto.classe !== 'minimo';
const da_lista = (s) => s.posto.classe === 'polo' || s.posto.classe === 'autorizado';
// menor preço; empate (diferença de menos de 1 centavo) fica com o posto da lista
const maisBarato = (a, b) => {
  const d = efetivo(b) - efetivo(a);
  if (Math.abs(d) < 0.01) return FORCA_CLASSE[b.posto.classe] > FORCA_CLASSE[a.posto.classe] ? b : a;
  return d < 0 ? b : a;
};
// alertas de uma parada: posto da lista quase no mesmo preço; preço antigo corrigido; posto que parecia mais barato
function alertasDaParada(alvo, candidatos, litros) {
  const al = [];
  if (!da_lista(alvo)) {
    const lista = candidatos.filter((s) => s !== alvo && da_lista(s));
    const melhor = lista.length ? lista.reduce(maisBarato) : null;
    if (melhor && efetivo(melhor) - efetivo(alvo) <= ALERTA_PROXIMO) {
      al.push('Posto da lista quase no mesmo preço: ' + melhor.posto.exibe + ' (' + ROTULO_CLASSE[melhor.posto.classe][0].toLowerCase() + ', km ' +
        fmt.int(melhor.km) + '), R$ ' + fmt.d2(efetivo(melhor) - efetivo(alvo)) + '/L mais caro: cerca de ' + fmt.moeda((efetivo(melhor) - efetivo(alvo)) * litros) + ' a mais nesta parada.');
    }
  }
  if (alvo.posto.idade > 15 && Math.abs(alvo.precoAj - alvo.preco) >= ALERTA_AJUSTE) {
    al.push('Preço de ' + fmtDia(alvo.posto.dia) + ' (' + alvo.posto.idade + ' dias): R$ ' + fmt.d3(alvo.preco) + ', corrigido pela variação do mercado para R$ ' +
      fmt.d3(alvo.precoAj) + '. Confirme o preço antes de abastecer.');
  }
  // postos que pareciam mais baratos pelo preço registrado, mas o preço é antigo e corrigido fica mais caro (ex.: polo sem transação recente)
  const enganosos = candidatos.filter((s) => s !== alvo && s.preco < alvo.preco && efetivo(s) > efetivo(alvo) && s.precoAj - s.preco >= ALERTA_AJUSTE);
  if (enganosos.length) {
    const s = enganosos.reduce((a, b) => (b.preco < a.preco ? b : a));
    al.push(s.posto.exibe + ' (' + ROTULO_CLASSE[s.posto.classe][0].toLowerCase() + ') tem preço registrado menor, R$ ' + fmt.d3(s.preco) + ', mas é de ' +
      fmtDia(s.posto.dia) + ' (' + s.posto.idade + ' dias). Corrigido pela variação do mercado ficaria R$ ' + fmt.d3(s.precoAj) + ', acima deste.');
  }
  return al;
}
function planejar(v, pctInicial, totalKm, postos) {
  const cap = v.tanque, kml = v.pc;
  const autonomia = (1 - RESERVA) * cap * kml;
  const minKm = MIN_ABASTECIMENTO * cap * kml;
  // referência: o posto que pode completar mais barato (já com a preferência) nos últimos 150 km da rota
  const cheios = postos.filter(completa);
  const perto = cheios.filter((s) => s.km >= totalKm - FAIXA_REFERENCIA_KM);
  const ref = perto.length ? perto.reduce(maisBarato) : cheios[cheios.length - 1] || null;
  const precoRef = ref ? efetivo(ref) : Infinity;
  let alcance = Math.max(0, (pctInicial / 100 - RESERVA) * cap * kml);
  let km = 0, custo = 0, litros = 0, voltas = 0;
  const paradas = [];
  while (km < totalKm) {
    if (++voltas > 300) return { erro: 'Não foi possível montar o plano (muitas paradas).' };
    if (alcance >= totalKm - km) break;
    const minRodar = Math.max(0, alcance + minKm - autonomia);
    const aoAlcance = (s) => s.km > km + 0.5 && s.km <= km + alcance;
    // 1º: postos que completam e permitem os 30% mínimos; 2º: os que completam, aceitando menos que 30%;
    // 3º: postos de mínimo (pernoite/auxiliar), só quando não há outro ao alcance
    let alcancaveis = postos.filter((s) => aoAlcance(s) && completa(s) && s.km > km + Math.max(0.5, minRodar));
    let reduzido = false;
    if (!alcancaveis.length) {
      alcancaveis = postos.filter((s) => aoAlcance(s) && completa(s));
      reduzido = alcancaveis.length > 0;
    }
    if (!alcancaveis.length) alcancaveis = postos.filter((s) => aoAlcance(s) && !completa(s));
    if (!alcancaveis.length) {
      const prox = postos.find((s) => s.km > km + 0.5);
      const fim = prox ? prox.km : totalKm;
      return { erro: 'Faltam postos com preço conhecido entre o km ' + fmt.int(km) + ' e o km ' + fmt.int(fim) +
        ' (' + fmt.int(fim - km) + ' km sem posto em que a frota tenha abastecido, mais que o alcance de ' + fmt.int(alcance) + ' km a partir dali). ' +
        'Aumente "Preço válido por" ou o "Desvio máximo", inclua uma parada numa cidade com posto conhecido, ou cadastre um posto nesse trecho.',
        paradas, lacuna: { de: km, ate: fim } };
    }
    const baratos = alcancaveis.filter((s) => efetivo(s) <= precoRef);
    const alvo = (baratos.length ? baratos : alcancaveis).reduce(maisBarato);
    alcance -= alvo.km - km;
    km = alvo.km;
    const ate = (lim) => (totalKm - km <= lim ? totalKm - km + 1 : null);   // dá para chegar ao destino?
    let encherAte, enche = false;
    if (!completa(alvo)) {
      // posto de mínimo: só o necessário até o próximo posto que pode completar (ou até o destino)
      const prox = postos.find((s) => s.km > km + 0.5 && s.km <= km + autonomia && completa(s));
      encherAte = prox ? prox.km - km + 1 : ate(autonomia) ?? autonomia;
    } else if (efetivo(alvo) <= precoRef) {
      encherAte = ate(autonomia) ?? autonomia;
      enche = true;
    } else {
      const proxBarato = postos.find((s) => s.km > km + 0.5 && s.km <= km + autonomia && completa(s) && efetivo(s) <= precoRef);
      encherAte = proxBarato ? proxBarato.km - km + 1 : ate(autonomia) ?? autonomia;
    }
    encherAte = Math.min(encherAte, autonomia);
    let somar = encherAte - alcance;
    if (completa(alvo) && somar < minKm) { somar = Math.min(minKm, autonomia - alcance); encherAte = alcance + somar; }
    if (reduzido && somar < 1) {   // tanque já cheio: vai ao posto mais distante ao alcance sem abastecer
      const longe = alcancaveis[alcancaveis.length - 1];
      alcance -= longe.km - km; km = longe.km;
      continue;
    }
    if (somar <= 0) continue;
    // litros redondos, de 10 em 10: arredonda para cima; se não couber no tanque, para baixo
    const espaco = (autonomia - alcance) / kml;
    let l = Math.ceil(somar / kml / LITROS_PASSO) * LITROS_PASSO;
    if (l > espaco) l = Math.floor(espaco / LITROS_PASSO) * LITROS_PASSO;
    if (l < LITROS_PASSO) continue;   // não cabe nem 10 L: segue sem parar aqui
    encherAte = alcance + l * kml;
    // custo estimado pelo preço corrigido para hoje; o preço registrado aparece junto
    paradas.push({
      posto: alvo.posto, km, desvio: alvo.desvio, preco: alvo.precoAj, precoRegistrado: alvo.preco, litros: l, custo: l * alvo.precoAj, enche,
      alertas: alertasDaParada(alvo, alcancaveis, l),
      reduzido: completa(alvo) && l < MIN_ABASTECIMENTO * cap - LITROS_PASSO,
      chegada: RESERVA + alcance / kml / cap, chegadaKm: alcance, saida: RESERVA + encherAte / kml / cap,
    });
    custo += l * alvo.precoAj; litros += l;
    alcance = encherAte;
  }
  return { paradas, custo, litros, autonomia, precoRef, ref };
}

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando o roteirizador…</div>';
  let dados, L, baseCidades, municipios;
  try { [dados, L, baseCidades, municipios] = await Promise.all([carregarDados(), carregarLeaflet(), carregarCidades(), carregarMunicipios()]); } catch (e) {
    pagina.innerHTML = '<div class="vazio">' + esc(e.message) + '</div>';
    return {};
  }
  const estado = { paradas: [], excluidos: new Set(), rotas: [], sel: null, rota: null, plano: null, naRota: [], veiculo: null, pct: 100, rotulos: null,
    dias: DIAS_VALIDADE, desvio: DESVIO_KM };
  let viaveis = [], bloqueados = [], daLista = [], cidades = new Map(), veiculos = [], clientes = [];
  let autorizadosMapa = [], postoDaBase = new Map(), mapaPronto = false;
  function usarPostos() {
    const postos = montarPostos(dados, estado.dias);
    // marcados no mapa o tempo todo: postos da lista (polo, autorizado, mínimo); os que ficam numa base vão no marcador dela
    autorizadosMapa = postos.filter((p) => ['polo', 'autorizado', 'minimo'].includes(p.classe) && !p.base);
    postoDaBase = new Map(postos.filter((p) => p.base).map((p) => [p.base, p]));
    if (mapaPronto) desenharFixos();
    // postos da lista dos motoristas (polo, autorizado, mínimo): podem ser origem, parada ou destino
    const ORDEM = { polo: 0, autorizado: 1, minimo: 2 };
    daLista = postos.filter((p) => p.classe in ORDEM).sort((a, b) => ORDEM[a.classe] - ORDEM[b.classe] || a.exibe.localeCompare(b.exibe, 'pt-BR'));
    viaveis = postos.filter((p) => !p.desatualizado && p.classe !== 'bloqueado');
    bloqueados = postos.filter((p) => p.classe === 'bloqueado');   // nunca entram na rota (só são contados)
    cidades = montarCidades(municipios, baseCidades, postos);
    const conta = (c) => viaveis.filter((p) => p.classe === c).length;
    ctx.definirSub(fmt.int(viaveis.length) + ' postos com preço ' + (estado.dias > 9999 ? 'de qualquer data' : 'dos últimos ' + estado.dias + ' dias') + ' (' + conta('polo') + ' polo, ' +
      (conta('autorizado') + conta('minimo')) + ' outros autorizados, ' + conta('livre') + ' fora da lista); ' +
      fmt.int(bloqueados.length) + ' bloqueados ficam de fora. Abastecimentos até ' + fmtDia(dados.diaMax) + '.');
  }
  function usarDados(d) {
    dados = d;
    veiculos = Object.entries(d.veiculos).filter(([, v]) => v.tanque > 0 && v.pc > 0)
      .map(([placa, v]) => ({ placa, ...v })).sort((a, b) => (a.unidade || '').localeCompare(b.unidade || '', 'pt-BR') || a.placa.localeCompare(b.placa));
    usarPostos();
  }
  usarDados(dados);

  pagina.innerHTML = `
    <details class="rot-suspeitos oculto" id="rt-suspeitos"></details>
    <div class="rot-grade">
      <form class="rot-form" id="rt-form" novalidate>
        <h2 class="rot-passo">1. Rota</h2>
        <div class="campo-form"><label for="rt-origem">Origem: cidade, posto ou cliente</label>
          <div class="rot-combo"><input id="rt-origem" autocomplete="off" spellcheck="false" placeholder="Digite a cidade, o posto ou o cliente…"></div></div>
        <div class="campo-form"><span>Paradas no caminho (opcional)</span>
          <div id="rt-paradas" class="rot-paradas"></div>
          <button type="button" class="link-acao rot-add" id="rt-add">+ Adicionar parada</button>
        </div>
        <div class="campo-form"><label for="rt-destino">Destino: cidade, posto ou cliente</label>
          <div class="rot-combo"><input id="rt-destino" autocomplete="off" spellcheck="false" placeholder="Digite a cidade, o posto ou o cliente…"></div></div>
        <h2 class="rot-passo">2. Veículo</h2>
        <label class="campo-form"><span>Placa</span><select id="rt-placa"></select></label>
        <dl class="rot-veiculo" id="rt-veiculo"></dl>
        <label class="campo-form"><span>Tanque na saída: <b id="rt-pct-val">100%</b></span>
          <input type="range" id="rt-pct" min="15" max="100" step="5" value="100" aria-describedby="rt-pct-dica"></label>
        <small class="rot-dica" id="rt-pct-dica">15% é a reserva, que o plano nunca usa.</small>
        <h2 class="rot-passo">3. Postos considerados</h2>
        <div class="grade-form rot-opcoes">
          <label class="campo-form"><span>Preço válido por</span><select id="rt-dias">
            <option value="30" selected>30 dias</option><option value="60">60 dias</option><option value="90">90 dias</option>
            <option value="365">1 ano</option><option value="100000">Sem limite (preço pode estar antigo)</option></select></label>
          <label class="campo-form"><span>Desvio máximo</span><select id="rt-desvio">
            <option value="5" selected>5 km da rota</option><option value="10">10 km</option><option value="20">20 km</option></select></label>
        </div>
        <small class="rot-dica">Só entram postos em que a frota abasteceu diesel dentro desse prazo (preço do abastecimento mais recente).</small>
        <button type="submit" class="btn btn-principal rot-botao" id="rt-planejar"><svg aria-hidden="true"><use href="#i-mapa"/></svg><span class="txt">Planejar rota</span></button>
        <p class="rot-status oculto" id="rt-status" role="status"></p>
      </form>
      <section class="mapa-bloco" aria-label="Mapa da rota">
        <div class="mapa rot-mapa" id="rt-mapa"></div>
        <div class="mapa-legenda rot-legenda" id="rt-legenda">
          <div class="rot-legenda-cab">
            <p class="mapa-legenda-titulo">Legenda</p>
            <button type="button" class="link-acao" id="rt-legenda-botao" aria-expanded="true" aria-controls="rt-legenda-corpo">Minimizar</button>
          </div>
          <div id="rt-legenda-corpo">
            <ul>
              <li><span class="rot-num rot-num-mini" style="background:#1C2226">1</span>Abastecimento sugerido (O origem, D destino)</li>
              <li><span class="rot-base-mini" aria-hidden="true">R</span>Unidade (base) da empresa</li>
              <li><i style="background:var(--bom)"></i>Posto polo (pode completar)</li>
              <li><i style="background:var(--cat-1)"></i>Autorizado</li>
              <li><i style="background:var(--faixa)"></i>Mínimo: pernoite/auxiliar</li>
              <li><i style="background:var(--eixo)"></i>Fora da lista (só na rota)</li>
            </ul>
            <label class="opcao-linha"><input type="checkbox" id="rt-ver-autorizados" checked> <span>Mostrar postos autorizados</span></label>
            <label class="opcao-linha"><input type="checkbox" id="rt-ver-bases" checked> <span>Mostrar unidades</span></label>
            <p class="rot-dica">Clique num posto ou numa unidade para ver os detalhes. Postos bloqueados não aparecem nem entram no plano.</p>
          </div>
        </div>
      </section>
    </div>
    <div id="rt-resultado" class="oculto">
      <section class="painel rot-rotas-painel" id="rt-rotas-painel" aria-labelledby="rt-rotas-titulo">
        <div class="painel-cab"><h2 id="rt-rotas-titulo">Rotas</h2><span class="conta" id="rt-rotas-conta"></span></div>
        <div class="rot-rotas" id="rt-rotas" role="radiogroup" aria-labelledby="rt-rotas-titulo"></div>
      </section>
      <div class="abertura">
        <section class="bomba" aria-labelledby="rt-bomba-titulo">
          <h2 class="bomba-titulo" id="rt-bomba-titulo">Custo estimado dos abastecimentos</h2>
          <dl class="bomba-registros" id="rt-bomba"></dl>
        </section>
        <dl class="apoio apoio-coluna" id="rt-resumo"></dl>
      </div>
      <section class="painel rot-envio oculto" id="rt-envio" aria-labelledby="rt-envio-titulo">
        <div class="painel-cab"><h2 id="rt-envio-titulo">Enviar ao motorista</h2>
          <div class="acoes-cab">
            <a class="btn btn-principal" id="rt-maps" target="_blank" rel="noopener"><svg aria-hidden="true"><use href="#i-mapa"/></svg><span class="txt">Abrir no Google Maps</span></a>
            <button type="button" class="btn" id="rt-copiar"><svg aria-hidden="true"><use href="#i-baixar"/></svg><span class="txt">Copiar para o motorista</span></button>
            <a class="btn" id="rt-whats" target="_blank" rel="noopener"><span class="txt">Enviar pelo WhatsApp</span></a>
          </div>
        </div>
        <p class="nota" id="rt-envio-nota"></p>
        <pre class="rot-texto" id="rt-texto"></pre>
      </section>
      <div class="aviso-pendencias oculto" id="rt-excluidos"></div>
      <section class="painel painel-tabela">
        <div class="painel-cab"><h2>Sequência de paradas</h2><span class="conta" id="rt-conta"></span></div>
        <p class="nota" id="rt-regra"></p>
        <div class="tabela-rolagem"><table class="dados" id="rt-tabela"></table></div>
      </section>
    </div>`;
  const $ = (id) => pagina.querySelector('#' + id);

  // postos com coordenada longe da cidade da própria linha na planilha LOCALIZAÇÃO DOS POSTOS: ficam fora do mapa
  function desenharSuspeitos() {
    const s = dados.locaisSuspeitos || [];
    const el = $('rt-suspeitos');
    el.classList.toggle('oculto', !s.length);
    el.innerHTML = s.length
      // resumo de uma linha (recolhido); a explicação e a lista abrem ao clicar
      ? '<summary>⚠ ' + s.length + (s.length === 1 ? ' posto fora do mapa' : ' postos fora do mapa') + ' (coordenada errada no cadastro) · ver quais</summary>' +
        '<p class="nota">A coordenada cadastrada do posto está longe da cidade informada. Corrija a coordenada no Mapa de calor (ou a cidade em Postos dos motoristas).</p><ul>' +
        s.map((x) => '<li><strong>' + esc(x.nome) + '</strong> · ' + esc(x.cidade + ' - ' + x.uf) + ': a coordenada ' +
          '<a class="link-tabela" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=' + x.lat + ',' + x.lng + '">' +
          esc(String(x.lat).replace('.', ',') + '; ' + String(x.lng).replace('.', ',')) + '</a> fica a ' + fmt.int(x.km) + ' km da cidade</li>').join('') + '</ul>'
      : '';
  }
  desenharSuspeitos();

  // opções do campo de local: postos da lista dos motoristas, fábricas dos clientes e todas as cidades (IBGE),
  // filtradas pelo que foi digitado
  const norm = (s) => chaveNome(s).replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const NOME_CLASSE_CURTO = { polo: 'Posto polo', autorizado: 'Posto autorizado', minimo: 'Posto mínimo' };
  function opcoesLocal(texto) {
    let q = norm(texto), uf = null;
    const m = /^(.*?)[\s,/-]+([A-Z]{2})$/.exec(q);
    if (m && m[1]) { q = m[1].trim(); uf = m[2]; }
    const pontua = (nome) => { const n = norm(nome); if (!q) return 0; if (n.startsWith(q)) return 0; if ((' ' + n).includes(' ' + q)) return 1; return n.includes(q) ? 2 : -1; };
    // achado só pela cidade fica atrás das cidades (quem digita "belem" quer a cidade primeiro)
    const nota = (nome, cidade) => Math.min(...[pontua(nome), pontua(cidade) >= 0 ? pontua(cidade) + 3 : -1].filter((x) => x >= 0).concat(9));
    const ufDe = (cidade) => (/ - ([A-Z]{2})$/.exec(cidade || '') || [])[1];
    const ps = daLista.map((p) => ({ p, s: nota(p.exibe, p.cidade) }))
      .filter((x) => x.s < 9 && (!uf || ufDe(x.p.cidade) === uf)).sort((a, b) => a.s - b.s).slice(0, q ? 10 : 400)
      .map(({ p, s }) => ({ tipo: 'posto', rotulo: p.exibe, sub: NOME_CLASSE_CURTO[p.classe] + ' · ' + p.cidade, cidade: p.cidade, lat: p.lat, lng: p.lng, s }));
    const cl = clientes.map((c) => ({ c, s: Math.min(nota(c.nome, c.cidade + ' ' + c.uf), pontua(c.empresa) >= 0 ? pontua(c.empresa) : 9) }))
      .filter((x) => x.s < 9 && (!uf || x.c.uf === uf)).sort((a, b) => a.s - b.s || a.c.nome.localeCompare(b.c.nome, 'pt-BR')).slice(0, q ? 12 : 200)
      .map(({ c, s }) => ({ tipo: 'cliente', rotulo: c.nome, sub: 'Fábrica · ' + c.cidade + ' - ' + c.uf + (c.confianca === 'baixa' ? ' · localização aproximada' : ''),
        cidade: c.cidade + ' - ' + c.uf, lat: c.lat, lng: c.lng, s }));
    const cs = [];
    for (const [nome, u] of municipios) {
      if (uf && u !== uf) continue;
      const s = pontua(nome);
      if (s >= 0) cs.push({ s, nome, u, frota: !!(cidades.get(normCidade(nome) + '|' + u) || {}).frota });
    }
    // cidades onde a frota já abastece vêm primeiro (quem digita "sal" quer Salvador antes de Saldanha Marinho)
    cs.sort((a, b) => a.s - b.s || b.frota - a.frota || a.nome.localeCompare(b.nome, 'pt-BR'));
    const limite = q ? 60 : 150;
    const grupos = [];
    if (ps.length) grupos.push({ s: ps[0].s, itens: [{ grupo: 'Postos da lista dos motoristas' }, ...ps] });
    if (cl.length) grupos.push({ s: cl[0].s, itens: [{ grupo: 'Clientes (fábricas)' }, ...cl] });
    if (cs.length || !grupos.length) {
      grupos.push({ s: cs.length ? cs[0].s - 0.5 : 9, itens: [{ grupo: q ? 'Cidades' : 'Cidades (digite para filtrar entre ' + fmt.int(municipios.length) + ')' },
        ...cs.slice(0, limite).map((c) => ({ tipo: 'cidade', rotulo: c.nome + ', ' + c.u, sub: c.frota ? 'cidade com postos da frota' : '', nome: c.nome, uf: c.u }))] });
    }
    // sem texto: postos, clientes, cidades; com texto, vem antes o grupo que bate melhor (empate: cidades)
    if (q) grupos.sort((a, b) => a.s - b.s);
    return grupos.flatMap((g) => g.itens);
  }
  const comboOrigem = criarCombo($('rt-origem'), opcoesLocal);
  const comboDestino = criarCombo($('rt-destino'), opcoesLocal);
  carregarClientes().then((l) => { clientes = l; comboOrigem.atualizar(); comboDestino.atualizar(); });

  // local escolhido (ou digitado) -> coordenadas
  async function resolverLocal(input, nome) {
    const txt = input.value.trim();
    const e = input._escolha && input._escolha.rotulo === txt ? input._escolha : null;
    if (e && (e.tipo === 'posto' || e.tipo === 'cliente')) return { lat: e.lat, lng: e.lng, rotulo: e.rotulo + ' (' + e.cidade + ')', posto: e.tipo === 'posto' };
    if (e && e.tipo === 'cidade') {
      const k = normCidade(e.nome) + '|' + e.uf;
      const c = cidades.get(k);
      if (c) return { lat: c.lat, lng: c.lng, rotulo: e.nome + '/' + e.uf };
    }
    const g = await localizar(cidades, e ? e.nome + ', ' + e.uf : txt);
    if (!g) throw new Error(nome + ' "' + txt + '" não encontrada. Escolha uma opção da lista ou escreva "Cidade, UF" (ex.: Salvador, BA).');
    return g;
  }

  function preencherListas() {
    const grupos = new Map();
    veiculos.forEach((v) => { const u = v.unidade || 'Sem unidade'; if (!grupos.has(u)) grupos.set(u, []); grupos.get(u).push(v); });
    $('rt-placa').innerHTML = '<option value="">Escolha a placa…</option>' + [...grupos.entries()].map(([u, vs]) =>
      '<optgroup label="' + esc(u) + '">' + vs.map((v) => '<option value="' + esc(v.placa) + '"' + (estado.veiculo && estado.veiculo.placa === v.placa ? ' selected' : '') + '>' +
        esc(v.placa + ' · ' + (v.categoria || v.modelo || '') + ' · ' + fmt.int(v.tanque) + ' L') + '</option>').join('') + '</optgroup>').join('');
  }
  function desenharVeiculo() {
    const v = estado.veiculo;
    $('rt-veiculo').innerHTML = v ? htmlApoio([
      { rot: 'Tanque', val: fmt.int(v.tanque) + ' L' },
      { rot: 'km/L crítico', val: fmt.d2(v.pc) },
      { rot: 'Autonomia', val: fmt.int((1 - RESERVA) * v.tanque * v.pc) + ' km' },
    ]) : '';
  }
  preencherListas();
  $('rt-placa').addEventListener('change', (e) => { estado.veiculo = veiculos.find((v) => v.placa === e.target.value) || null; desenharVeiculo(); });
  $('rt-pct').addEventListener('input', (e) => { estado.pct = +e.target.value; $('rt-pct-val').textContent = estado.pct + '%'; });
  // mudar prazo ou desvio refaz o plano da rota já traçada (sem consultar o serviço de rotas de novo)
  $('rt-dias').addEventListener('change', (e) => { estado.dias = +e.target.value; usarPostos(); if (estado.rota) recalcular(); });
  $('rt-desvio').addEventListener('change', (e) => { estado.desvio = +e.target.value; if (estado.rota) recalcular(); });

  // paradas: cada uma com o mesmo campo de busca (cidade, posto ou cliente); o texto e a escolha ficam em estado.paradas
  function desenharParadas() {
    $('rt-paradas').innerHTML = estado.paradas.map((p, i) =>
      '<div class="rot-parada"><div class="rot-combo"><input autocomplete="off" spellcheck="false" data-i="' + i + '" value="' + esc(p.texto) + '" aria-label="Parada ' + (i + 1) +
        ': cidade, posto ou cliente" placeholder="Cidade, posto ou cliente da parada…"></div>' +
      '<button type="button" class="btn-lixeira" data-rm="' + i + '" aria-label="Remover parada ' + (i + 1) + '" title="Remover parada"><svg aria-hidden="true"><use href="#i-lixeira"/></svg></button></div>').join('');
    $('rt-paradas').querySelectorAll('input').forEach((inp) => {
      inp._escolha = estado.paradas[+inp.dataset.i].escolha;
      criarCombo(inp, opcoesLocal);
    });
  }
  $('rt-add').addEventListener('click', () => {
    estado.paradas.push({ texto: '', escolha: null });
    desenharParadas();
    const campos = $('rt-paradas').querySelectorAll('input');
    campos[campos.length - 1].focus();
  });
  // guarda o texto e a escolha de cada parada (para redesenhar ao remover uma delas)
  const guardarParada = (e) => { const i = e.target.dataset.i; if (i !== undefined) estado.paradas[+i] = { texto: e.target.value, escolha: e.target._escolha || null }; };
  $('rt-paradas').addEventListener('input', guardarParada);
  $('rt-paradas').addEventListener('focusout', guardarParada);
  $('rt-paradas').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { estado.paradas.splice(+b.dataset.rm, 1); desenharParadas(); } });

  function status(txt, tipo) {
    const s = $('rt-status');
    s.textContent = txt || '';
    s.className = 'rot-status' + (txt ? ' ' + (tipo || 'info') : ' oculto');
  }

  // detalhe do posto ao clicar (no mapa): situação na lista, última transação, preço usado e preço corrigido
  function detalhePosto(p, km) {
    const linha = (r, v) => '<div class="linha-dica"><span>' + esc(r) + '</span><b>' + v + '</b></div>';
    return '<strong>' + esc(p.exibe) + '</strong><br><small>' + esc(p.cidade) + (km !== undefined ? ' · km ' + fmt.int(km) + ' da rota' : '') +
        (p.base ? '<br>posto: ' + esc(p.nome) : '') + '</small>' +
      linha('Situação', esc(ROTULO_CLASSE[p.classe] ? ROTULO_CLASSE[p.classe][0] : p.classe)) +
      linha('Preço considerado', 'R$ ' + fmt.d3(p.precoAj) + (Math.abs(p.precoAj - p.preco) >= 0.005 ? ' (corrigido de R$ ' + fmt.d3(p.preco) + ')' : '')) +
      (p.negValor ? linha('Último negociado', 'R$ ' + fmt.d3(p.negValor) + ' em ' + fmtDia(p.negDia)) : linha('Último negociado', 'sem negociação')) +
      linha('Última transação', fmtDia(p.diaTx) + ' · R$ ' + fmt.d3(p.precoTx) + ' (' + (dados.diaMax - p.diaTx) + ' dias)') +
      (p.desatualizado ? '<div class="linha-dica"><span>Sem preço dentro do prazo escolhido: não entra no plano.</span></div>' : '') +
      (p.aviso ? '<div class="linha-dica"><span>Aviso: ' + esc(p.aviso) + '</span></div>' : '');
  }
  function detalheBase(b) {
    const p = postoDaBase.get(b.nome);
    return p ? detalhePosto(p) : '<strong>' + esc(b.nome) + '</strong><br><small>Unidade da empresa (sem posto interno com preço nos abastecimentos)</small>';
  }

  // ---------- mapa ----------
  const mapa = L.map($('rt-mapa'), { zoomControl: true, preferCanvas: true }).setView([-13.5, -44], 5);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">colaboradores do OpenStreetMap</a>',
  }).addTo(mapa);
  const camadaAutorizados = L.layerGroup().addTo(mapa);   // postos da lista, sempre (pode desligar na legenda)
  const camadaBases = L.layerGroup().addTo(mapa);         // unidades da empresa
  const camada = L.layerGroup().addTo(mapa);              // rota e plano (por cima)
  const cor = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const pino = (txt, fundo) => L.divIcon({ className: 'rot-pino', html: '<span style="background:' + fundo + '">' + esc(txt) + '</span>', iconSize: [28, 28], iconAnchor: [14, 14] });
  const iconeBase = L.divIcon({ className: 'rot-base', html: '<span>R</span>', iconSize: [26, 26], iconAnchor: [13, 13] });
  function desenharFixos() {
    camadaAutorizados.clearLayers();
    camadaBases.clearLayers();
    for (const p of autorizadosMapa) {
      L.circleMarker([p.lat, p.lng], { radius: 6, color: cor('--superficie'), weight: 1.5, fillColor: cor(COR_CLASSE[p.classe]),
        fillOpacity: p.desatualizado ? 0.45 : 1 })
        .bindTooltip('<strong>' + esc(p.exibe) + '</strong><br>' + esc(ROTULO_CLASSE[p.classe][0]) + ' · R$ ' + fmt.d3(p.precoAj) + '/L<br><small>Clique para ver os detalhes</small>', { className: 'dica-mapa' })
        .bindPopup(detalhePosto(p), { className: 'dica-mapa', maxWidth: 320 })
        .on('popupopen', (e) => e.target.closeTooltip())
        .addTo(camadaAutorizados);
    }
    for (const b of BASES) {
      L.marker([b.lat, b.lng], { icon: iconeBase, title: b.nome, zIndexOffset: 500 })
        .bindTooltip('<strong>' + esc(b.nome) + '</strong><br><small>Unidade · clique para ver os detalhes</small>', { className: 'dica-mapa' })
        .bindPopup(detalheBase(b), { className: 'dica-mapa', maxWidth: 320 })
        .on('popupopen', (e) => e.target.closeTooltip())
        .addTo(camadaBases);
    }
  }
  mapaPronto = true;
  desenharFixos();
  const verAutorizados = () => mapa.hasLayer(camadaAutorizados);
  $('rt-ver-autorizados').addEventListener('change', (e) => { if (e.target.checked) camadaAutorizados.addTo(mapa); else mapa.removeLayer(camadaAutorizados); desenharMapa(); });
  $('rt-ver-bases').addEventListener('change', (e) => { if (e.target.checked) camadaBases.addTo(mapa); else mapa.removeLayer(camadaBases); });
  // legenda minimizável (o navegador lembra)
  function legenda(aberta) {
    $('rt-legenda').classList.toggle('minimizada', !aberta);
    $('rt-legenda-corpo').hidden = !aberta;
    $('rt-legenda-botao').textContent = aberta ? 'Minimizar' : 'Mostrar';
    $('rt-legenda-botao').setAttribute('aria-expanded', String(aberta));
    try { localStorage.setItem('rot-legenda', aberta ? 'aberta' : 'fechada'); } catch {}
  }
  let legendaSalva = 'aberta';
  try { legendaSalva = localStorage.getItem('rot-legenda') || 'aberta'; } catch {}
  legenda(legendaSalva !== 'fechada');
  $('rt-legenda-botao').addEventListener('click', () => legenda($('rt-legenda-corpo').hidden));
  function desenharMapa() {
    camada.clearLayers();
    const r = estado.rota;
    if (!r) return;
    const linha = r.coords.map(([lng, lat]) => [lat, lng]);
    // alternativas em cinza, por baixo; clicar numa delas passa a mostrar o plano dela
    estado.rotas.forEach((alt, i) => {
      if (alt === r) return;
      L.polyline(alt.coords.map(([lng, lat]) => [lat, lng]), { color: cor('--eixo'), weight: 5, opacity: 0.85 })
        .bindTooltip('Rota ' + (i + 1) + ': ' + fmt.int(alt.km) + ' km' + (alt.plano.erro ? ', sem plano viável' : ', ' + fmt.moeda(alt.plano.custo)) + '. Clique para ver.', { className: 'dica-mapa', sticky: true })
        .on('click', () => { estado.sel = i; mostrarRota(); })
        .addTo(camada);
    });
    L.polyline(linha, { color: '#ffffff', weight: 8, opacity: 0.8 }).addTo(camada);
    L.polyline(linha, { color: cor('--serie-1'), weight: 4, dashArray: r.estimada ? '8 8' : null }).addTo(camada);
    const plano = estado.plano && estado.plano.paradas ? estado.plano.paradas : [];   // com erro, mostra até onde deu
    if (estado.plano && estado.plano.lacuna) {   // trecho sem posto conhecido, em vermelho
      const { de, ate } = estado.plano.lacuna;
      const trecho = linha.filter((_, i) => r.cum[i] >= de && r.cum[i] <= ate);
      if (trecho.length > 1) L.polyline(trecho, { color: cor('--ruim'), weight: 6, opacity: 0.9 }).bindTooltip('Trecho sem posto conhecido', { className: 'dica-mapa' }).addTo(camada);
    }
    const usados = new Set(plano.map((p) => p.posto.chave));
    for (const s of estado.naRota) {
      if (usados.has(s.posto.chave)) continue;
      // posto da lista já marcado na camada fixa: não desenha de novo
      if (verAutorizados() && s.posto.classe !== 'livre' && !s.posto.base) continue;
      L.circleMarker([s.posto.lat, s.posto.lng], { radius: s.posto.classe === 'livre' ? 4.5 : 6, color: cor('--superficie'), weight: 1.5,
        fillColor: cor(COR_CLASSE[s.posto.classe]), fillOpacity: 1 })
        .bindTooltip('<strong>' + esc(s.posto.exibe) + '</strong><br>' + esc(ROTULO_CLASSE[s.posto.classe][0]) + ' · R$ ' + fmt.d3(s.precoAj) + '/L · km ' + fmt.int(s.km) +
          '<br><small>Clique para ver as datas</small>', { className: 'dica-mapa' })
        .bindPopup(detalhePosto(s.posto, s.km), { className: 'dica-mapa', maxWidth: 300 })
        .addTo(camada);
    }
    plano.forEach((p, i) => {
      L.marker([p.posto.lat, p.posto.lng], { icon: pino(String(i + 1), COR_PINO), title: p.posto.exibe })
        .bindTooltip('<strong>' + (i + 1) + '. ' + esc(p.posto.exibe) + '</strong><br>' + fmt.int(p.litros) + ' L a R$ ' + fmt.d3(p.preco) + ' = ' + fmt.moeda(p.custo) +
          '<br><small>Clique para ver as datas</small>', { className: 'dica-mapa' })
        .bindPopup(detalhePosto(p.posto, p.km), { className: 'dica-mapa', maxWidth: 300 }).addTo(camada);
    });
    L.marker(linha[0], { icon: pino('O', cor('--bom')), title: 'Origem' }).bindTooltip(esc(estado.rotulos.origem), { className: 'dica-mapa' }).addTo(camada);
    L.marker(linha[linha.length - 1], { icon: pino('D', cor('--ruim')), title: 'Destino' }).bindTooltip(esc(estado.rotulos.destino), { className: 'dica-mapa' }).addTo(camada);
    mapa.invalidateSize();
    mapa.fitBounds(L.latLngBounds(linha), { padding: [30, 30], animate: false });
  }
  const ro = new ResizeObserver(() => mapa.invalidateSize());
  ro.observe($('rt-mapa'));

  // ---------- resultado ----------
  function desenharResultado() {
    const r = estado.rota, pl = estado.plano;
    $('rt-resultado').classList.remove('oculto');
    // rotas: a principal e as alternativas, com o custo de cada uma
    const baratas = estado.rotas.filter((x) => !x.plano.erro).map((x) => x.plano.custo);
    const menor = baratas.length ? Math.min(...baratas) : null;
    $('rt-rotas-conta').textContent = estado.rotas.length > 1 ? estado.rotas.length + ' caminhos encontrados' : 'O serviço de rotas não sugeriu alternativas para este trajeto';
    $('rt-rotas').innerHTML = estado.rotas.map((x, i) => {
      const hh = Math.floor(x.minutos / 60), mm = Math.round(x.minutos - hh * 60);
      const det = x.plano.erro ? '<span class="status ruim">sem plano viável</span>'
        : fmt.moeda(x.plano.custo) + ' · ' + x.plano.paradas.length + (x.plano.paradas.length === 1 ? ' parada' : ' paradas') +
          (x.plano.custo === menor && baratas.length > 1 ? ' <span class="sit sit-ok">menor custo</span>' : '');
      return '<button type="button" class="rot-rota" role="radio" aria-checked="' + (i === estado.sel) + '" data-rota="' + i + '">' +
        '<strong>Rota ' + (i + 1) + '</strong><span>' + fmt.int(x.km) + ' km' + (x.estimada ? ' (estimada)' : ' · ' + (hh ? hh + 'h ' + mm + 'min' : mm + 'min')) + '</span>' +
        '<span>' + det + '</span></button>';
    }).join('');
    const temPlano = pl && !pl.erro;
    const preco = temPlano && pl.litros ? pl.custo / pl.litros : null;
    $('rt-bomba').innerHTML = htmlBomba({ despesa: temPlano ? pl.custo : null, litros: temPlano ? pl.litros : null, preco });
    const h = Math.floor(r.minutos / 60), m = Math.round(r.minutos - h * 60);
    $('rt-resumo').innerHTML = htmlApoio([
      { rot: 'Distância', val: fmt.int(r.km) + ' km', det: r.estimada ? '<span class="status ruim">estimada</span>' : '' },
      { rot: 'Tempo de direção', val: r.estimada ? '—' : (h ? h + 'h ' + m + 'min' : m + 'min') },
      { rot: 'Abastecimentos', val: temPlano ? fmt.int(pl.paradas.length) : '—' },
      { rot: 'Postos na rota', val: fmt.int(estado.naRota.length),
        det: estado.bloqueadosNaRota ? '<span class="medidor-meta">+ ' + estado.bloqueadosNaRota + (estado.bloqueadosNaRota === 1 ? ' bloqueado ignorado' : ' bloqueados ignorados') + '</span>' : '' },
    ]);
    const ex = [...estado.excluidos];
    $('rt-excluidos').classList.toggle('oculto', !ex.length);
    $('rt-excluidos').innerHTML = ex.length
      ? '<span>Fora do plano: ' + ex.map((k) => '<button type="button" class="btn-linha" data-volta="' + esc(k) + '" aria-label="Voltar a usar ' + esc(k) + '">' + esc(k) + ' ×</button>').join(' ') +
        '</span><button type="button" class="btn-linha" data-restaurar>Usar todos de novo</button>'
      : '';
    $('rt-regra').textContent = temPlano
      ? 'Sempre o posto mais barato, comparando os preços já corrigidos para hoje pela variação do mercado (um preço antigo não parece ' +
        'barato só por ser antigo). Quando um polo ou autorizado está a até R$ ' + fmt.d2(ALERTA_PROXIMO) + '/L do escolhido, aparece um alerta. ' +
        'Postos de mínimo (pernoite/auxiliar) só entram sem outra opção e recebem só o necessário até o próximo posto que completa. ' +
        'Referência para encher o tanque: ' + (pl.ref ? 'R$ ' + fmt.d3(pl.ref.precoAj) + ' (' + pl.ref.posto.exibe + ')' : '—') +
        '. Litros de 10 em 10. Autonomia de ' + fmt.int(pl.autonomia) + ' km. Clique num posto no mapa para ver as datas; use "Não usar" para tirar um posto e recalcular.'
      : '';
    $('rt-conta').textContent = temPlano ? pl.paradas.length + (pl.paradas.length === 1 ? ' parada' : ' paradas') : '';
    const linha = (pin, fundo, nome, sub, km, chegada, abast, precoL, custo, acao) =>
      '<tr><td><span class="rot-num" style="background:' + fundo + '">' + pin + '</span></td>' +
      '<td class="trunc"><strong>' + nome + '</strong><small class="cidade-linha">' + sub + '</small></td>' +
      '<td class="n">' + km + '</td><td class="n">' + chegada + '</td><td class="n">' + abast + '</td><td class="n">' + precoL + '</td><td class="n">' + custo + '</td><td class="acoes-linha">' + acao + '</td></tr>';
    $('rt-tabela').innerHTML = !temPlano
      ? '<tbody><tr><td><div class="vazio">' + esc(pl ? pl.erro : 'Sem plano.') + '</div></td></tr></tbody>'
      : '<thead><tr><th><span></span></th><th><span>Posto</span></th><th class="n"><span>km da origem</span></th><th class="n"><span>Tanque na chegada</span></th>' +
        '<th class="n"><span>Abastecer</span></th><th class="n"><span>Preço/L</span></th><th class="n"><span>Custo</span></th><th class="acoes-linha"><span></span></th></tr></thead><tbody>' +
        linha('O', 'var(--bom)', 'Origem', esc(estado.rotulos.origem), '0', estado.pct + '%', '—', '—', '—', '') +
        pl.paradas.map((p, i) => linha(i + 1, COR_PINO, esc(p.posto.exibe) +
            ' <span class="sit ' + ROTULO_CLASSE[p.posto.classe][1] + '">' + esc(ROTULO_CLASSE[p.posto.classe][0]) + '</span>' +
            (p.enche ? ' <span class="sit sit-ok">preço bom: enche</span>' : '') +
            (p.reduzido ? ' <span class="sit sit-alerta">menos de 30% do tanque</span>' : ''),
          esc(p.posto.cidade + ' · desvio de ' + fmt.d1(p.desvio) + ' km · última transação em ' + fmtDia(p.posto.diaTx) +
            (p.posto.fonte === 'negociação' ? ' · negociado em ' + fmtDia(p.posto.dia) : '')) +
            (p.posto.aviso ? '<br>Aviso: ' + esc(p.posto.aviso) : ''),
          fmt.int(p.km), fmt.int(p.chegada * 100) + '%<small class="cidade-linha">' + fmt.int(p.chegadaKm) + ' km de alcance</small>',
          '<strong>' + fmt.int(p.litros) + ' L</strong><small class="cidade-linha">' + fmt.int(p.chegada * 100) + '% → ' + fmt.int(p.saida * 100) + '%</small>',
          fmt.moeda(p.preco) + (Math.abs(p.preco - p.precoRegistrado) >= 0.005
            ? '<small class="cidade-linha">registrado ' + fmt.moeda(p.precoRegistrado) + ' em ' + fmtDia(p.posto.dia) + '</small>' : ''),
          fmt.moeda(p.custo),
          '<button type="button" class="btn-linha btn-linha-ruim" data-excluir="' + esc(p.posto.chave) + '">Não usar</button>') +
          (p.alertas && p.alertas.length ? '<tr class="linha-alerta"><td></td><td colspan="7">' +
            p.alertas.map((a) => '<p><svg aria-hidden="true"><use href="#i-x"/></svg>' + esc(a) + '</p>').join('') + '</td></tr>' : '')).join('') +
        linha('D', 'var(--ruim)', 'Destino', esc(estado.rotulos.destino), fmt.int(r.km), '—', '—', '—', '—', '') + '</tbody>';
  }

  // ---------- envio ao motorista: link do Google Maps com as paradas na ordem do caminho + texto com os abastecimentos ----------
  const MAX_PARADAS_MAPS = 9;   // o link de rota do Google Maps aceita até 9 pontos intermediários
  function montarEnvio() {
    const r = estado.rota, pl = estado.plano;
    const caixa = $('rt-envio');
    const ok = pl && !pl.erro && estado.pontos;
    caixa.classList.toggle('oculto', !ok);
    if (!ok) return;
    const kmDoPonto = (p) => {   // km do ponto (parada pedida) ao longo da rota
      let i = 0, d = Infinity;
      r.coords.forEach(([lng, lat], j) => { const x = haversine(p.lat, p.lng, lat, lng); if (x < d) { d = x; i = j; } });
      return r.cum[i];
    };
    const pontos = estado.pontos;
    const meio = [
      ...pontos.slice(1, -1).map((p) => ({ km: kmDoPonto(p), lat: p.lat, lng: p.lng, texto: 'Parada: ' + p.rotulo })),
      ...pl.paradas.map((s) => ({ km: s.km, lat: s.posto.lat, lng: s.posto.lng, s })),
    ].sort((a, b) => a.km - b.km);
    const c = (p) => p.lat.toFixed(6) + ',' + p.lng.toFixed(6);
    const noLink = meio.slice(0, MAX_PARADAS_MAPS);
    const url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=' + encodeURIComponent(c(pontos[0])) +
      '&destination=' + encodeURIComponent(c(pontos[pontos.length - 1])) +
      (noLink.length ? '&waypoints=' + encodeURIComponent(noLink.map(c).join('|')) : '');
    const h = Math.floor(r.minutos / 60), m = Math.round(r.minutos - h * 60);
    const v = estado.veiculo;
    let n = 0;
    const linhas = [
      'ROTA ' + estado.rotulos.origem + ' → ' + estado.rotulos.destino,
      fmt.int(r.km) + ' km' + (r.estimada ? ' (estimado)' : ', cerca de ' + (h ? h + 'h ' + m + 'min' : m + 'min') + ' dirigindo'),
      'Veículo ' + v.placa + ' · saindo com ' + estado.pct + '% do tanque',
      '',
      pl.paradas.length ? 'ABASTECIMENTOS:' : 'Sem abastecimento no caminho: o tanque cobre a rota.',
      ...meio.map((x) => (x.s
        ? (++n) + '. ' + x.s.posto.exibe + ' (' + x.s.posto.cidade + ') · km ' + fmt.int(x.km) + ' · abastecer ' + fmt.int(x.s.litros) + ' L' +
          (x.s.enche ? ' (pode completar)' : '') + (x.s.posto.aviso ? ' · ' + x.s.posto.aviso : '')
        : '   ' + x.texto + ' · km ' + fmt.int(x.km))),
      '',
      'Mapa da rota: ' + url,
    ];
    const texto = linhas.join('\n');
    $('rt-texto').textContent = texto;
    $('rt-maps').href = url;
    $('rt-whats').href = 'https://wa.me/?text=' + encodeURIComponent(texto);
    $('rt-envio-nota').textContent = 'O link abre o Google Maps passando pelas paradas e pelos postos de abastecimento, na ordem do caminho. ' +
      'O Google pode escolher estradas um pouco diferentes entre um ponto e outro.' +
      (meio.length > MAX_PARADAS_MAPS ? ' Atenção: o link aceita só ' + MAX_PARADAS_MAPS + ' paradas; as demais estão só no texto.' : '');
  }
  $('rt-copiar').addEventListener('click', async () => {
    const b = $('rt-copiar').querySelector('.txt');
    try { await navigator.clipboard.writeText($('rt-texto').textContent); b.textContent = 'Copiado'; }
    catch { b.textContent = 'Selecione o texto e copie'; }
    setTimeout(() => { b.textContent = 'Copiar para o motorista'; }, 2500);
  });

  // plano de cada rota (a principal e as alternativas); a escolhida de início é a de menor custo que dá certo
  function recalcular() {
    for (const r of estado.rotas) {
      r.naRota = postosNaRota(r, viaveis, estado.excluidos, estado.desvio);
      r.bloqueadosNaRota = postosNaRota(r, bloqueados, new Set(), estado.desvio).length;
      r.plano = planejar(estado.veiculo, estado.pct, r.km, r.naRota);
      if (r.plano.lacuna) {   // diz entre quais cidades fica o trecho sem posto
        const cidadeNoKm = (alvoKm) => {
          let i = 0;
          while (i < r.cum.length - 1 && r.cum[i] < alvoKm) i++;
          const [lng, lat] = r.coords[i];
          let melhor = null, dist = Infinity;
          for (const c of cidades.values()) { const x = haversine(lat, lng, c.lat, c.lng); if (x < dist) { dist = x; melhor = c; } }
          return melhor ? melhor.nome + '/' + melhor.uf : 'km ' + fmt.int(alvoKm);
        };
        r.plano.erro += ' O trecho fica entre ' + cidadeNoKm(r.plano.lacuna.de) + ' e ' + cidadeNoKm(r.plano.lacuna.ate) + ' (em vermelho no mapa).';
      }
    }
    if (estado.sel === null || !estado.rotas[estado.sel]) {
      const ok = estado.rotas.map((r, i) => [r, i]).filter(([r]) => !r.plano.erro);
      estado.sel = ok.length ? ok.reduce((a, b) => (b[0].plano.custo < a[0].plano.custo ? b : a))[1] : 0;
    }
    mostrarRota();
  }
  function mostrarRota() {
    const r = estado.rotas[estado.sel];
    estado.rota = r; estado.naRota = r.naRota; estado.bloqueadosNaRota = r.bloqueadosNaRota; estado.plano = r.plano;
    const alertas = r.plano.paradas ? r.plano.paradas.reduce((s, p) => s + (p.alertas ? p.alertas.length : 0), 0) : 0;
    if (r.plano.erro) status(r.plano.erro, 'erro');
    else if (!r.plano.paradas.length) status('O tanque cobre os ' + fmt.int(r.km) + ' km sem abastecer.', 'ok');
    else status('Plano pronto: ' + r.plano.paradas.length + (r.plano.paradas.length === 1 ? ' parada' : ' paradas') + ', ' + fmt.moeda(r.plano.custo) + '.' +
      (alertas ? ' ' + alertas + (alertas === 1 ? ' alerta' : ' alertas') + ' para conferir na tabela.' : '') +
      (r.estimada ? ' O serviço de rotas não respondeu: distância estimada em linha reta × 1,25.' : ''), r.estimada || alertas ? 'aviso' : 'ok');
    desenharMapa();
    desenharResultado();
    montarEnvio();
  }

  $('rt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const origem = $('rt-origem').value.trim(), destino = $('rt-destino').value.trim();
    if (!origem) { status('Informe a cidade de origem.', 'erro'); $('rt-origem').focus(); return; }
    if (!destino) { status('Informe a cidade de destino.', 'erro'); $('rt-destino').focus(); return; }
    if (!estado.veiculo) { status('Escolha a placa do veículo.', 'erro'); $('rt-placa').focus(); return; }
    const btn = $('rt-planejar');
    btn.disabled = true; btn.querySelector('.txt').textContent = 'Planejando…';
    try {
      status('Localizando a origem, as paradas e o destino…');
      const campos = [[$('rt-origem'), 'Origem'],
        ...[...$('rt-paradas').querySelectorAll('input')].filter((i) => i.value.trim()).map((i, n) => [i, 'Parada ' + (n + 1)]),
        [$('rt-destino'), 'Destino']];
      const pontos = [];
      for (const [inp, nome] of campos) pontos.push(await resolverLocal(inp, nome));
      estado.pontos = pontos;
      status('Traçando a rota e as alternativas…');
      estado.rotas = await tracarRotas(pontos);
      estado.rotas.forEach((r) => { r.cum = acumulado(r.coords); });
      estado.sel = null;   // recalcular escolhe a mais barata
      estado.rotulos = { origem: pontos[0].rotulo, destino: pontos[pontos.length - 1].rotulo };
      estado.excluidos.clear();
      recalcular();
    } catch (err) {
      status(err.message || 'Não foi possível planejar a rota.', 'erro');
    } finally {
      btn.disabled = false; btn.querySelector('.txt').textContent = 'Planejar rota';
    }
  });

  $('rt-tabela').addEventListener('click', (e) => {
    const b = e.target.closest('[data-excluir]');
    if (!b) return;
    const k = b.dataset.excluir;
    estado.excluidos.add(k);
    recalcular();
    if (estado.plano.erro) {   // sem alternativa: desfaz, como no planejador original
      estado.excluidos.delete(k);
      recalcular();
      status('Não dá para tirar "' + k + '": não há outro posto viável nesse trecho da rota.', 'erro');
    }
  });
  $('rt-rotas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rota]');
    if (!b) return;
    estado.sel = +b.dataset.rota;
    mostrarRota();
    const n = $('rt-rotas').querySelector('[data-rota="' + estado.sel + '"]');
    if (n) n.focus();
  });
  $('rt-excluidos').addEventListener('click', (e) => {
    const b = e.target.closest('[data-volta]');
    if (b) { estado.excluidos.delete(b.dataset.volta); recalcular(); return; }
    if (e.target.closest('[data-restaurar]')) { estado.excluidos.clear(); recalcular(); }
  });

  const aoAtualizarDados = () => carregarDados().then((d) => { usarDados(d); preencherListas(); desenharSuspeitos(); if (estado.rota) recalcular(); });
  window.addEventListener('dados-atualizados', aoAtualizarDados);
  return {
    desmontar() {
      ro.disconnect();
      mapa.remove();
      window.removeEventListener('dados-atualizados', aoAtualizarDados);
    },
  };
}
