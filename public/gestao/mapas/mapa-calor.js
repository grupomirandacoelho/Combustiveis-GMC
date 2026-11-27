// Mapa "Mapa de calor" — mesmas regras da aba "Mapa Calor" do Power BI:
//  - só diesel; o centro de custo RAJA ADM fica de fora (como nos visuais do BI)
//  - bolha por posto: tamanho = litros abastecidos; cor = preço médio contra a mediana dos postos do recorte
//  - coordenadas vêm da planilha LOCALIZAÇÃO DOS POSTOS (pelo nome do estabelecimento)
//  - "postos sem coordenadas": postos do recorte filtrado ausentes da planilha de localização (seguem os filtros);
//    clicando num deles abre o cadastro do posto para inserir a coordenada (/api/locais): o vigia grava na LOCALIZAÇÃO
//    DOS POSTOS (scripts/planilha_locais.py) e, enquanto isso, o posto já aparece no mapa com a coordenada nova
//  - como o mapa do BI (16/11/2026): a cada filtro (unidade, período, estabelecimento) o mapa enquadra sozinho os postos
//    do recorte; posto escolhido (na tabela ou na bolha, Ctrl/Cmd soma) deixa no mapa só os escolhidos, enquadrados
//  - abastecimentos do recorte (ou do posto clicado) numa tabela ao lado dos postos, com o motorista; quem pode editar
//    abastecimentos troca a unidade (INFORMAÇÃO ADICIONAL 3) pela fila do Editar abastecimentos (lib/base-copia.js)
import { carregarDados, fmt, esc, fmtDia, ehDiesel } from '../lib/dados.js';
import { criarFiltros, htmlApoio, agendador } from '../lib/filtros.js';
import { corrigirNaBaseCopia, buscarCorrecoes, trocasPorMinuto, minutoDe, NOME_ESTADO as ESTADO_BC } from '../lib/base-copia.js';
import { seloCartao, nomeCartao } from '../lib/cartoes.js';

const hora = (seg) => (seg === null || seg === undefined ? '' : String(Math.floor(seg / 3600)).padStart(2, '0') + ':' + String(Math.floor(seg / 60) % 60).padStart(2, '0'));
const chaveCidade = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
function km(a, b) {
  const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
// "-13.857123, -40.083456", "-13,857123; -40,083456" ou o endereço do Google Maps (".../@-13.85,-40.08,15z") -> [lat, lon]
function lerPar(t) {
  const s = String(t || '');
  const m = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(s) || /(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)/.exec(s) ||
    /(-?\d{1,2},\d+)\s*(?:;|\s|,\s)\s*(-?\d{1,3},\d+)/.exec(s);
  return m ? [Number(m[1].replace(',', '.')), Number(m[2].replace(',', '.'))] : null;
}
const lerNum = (t) => { const s = String(t || '').trim().replace(',', '.'); return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null; };
const noBrasil = (lat, lon) => lat > -35 && lat < 6 && lon > -75 && lon < -30;
const LIMITE_KM_CIDADE = 100;   // o mesmo do importar_base.py: mais longe que isso da cidade, a coordenada fica fora do mapa
const NOME_ESTADO = { pendente: 'aguardando gravação', aguardando: 'aguardando gravação', aplicada: 'gravada', erro: 'não gravada' };

const DIESEL = { has: ehDiesel };   // todo tipo de diesel (lib/dados.js)
const CC_FORA = new Set(['RAJA ADM']);
// motoristas do administrativo (não da operação): fora do mapa, como o centro de custo RAJA ADM (pedido do usuário, 07/10/2026)
const MOTORISTAS_FORA = new Set(['CAIO COELHO DUTRA', 'JACY RODRIGUES COELHO']);
// postos de combustível do OpenStreetMap perto da cidade (sugestões no cadastro); a busca vai do navegador ao Overpass
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const RAIO_OSM = 25000;   // metros
// nome como as pessoas chamam o posto (o mesmo do scripts/geocodificar_postos.py): sem "REDE xx", "LTDA" e o que vem
// depois de " - " ou " | " ("POSTO FERRARI REDE HG" -> "POSTO FERRARI")
function nomeLimpo(nome) {
  let s = String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
  s = s.split(/\s[-|]\s|\s\|/)[0].replace(/\bREDE\b.*$/, '').replace(/\b(LTDA|ME|EIRELI|EPP|S A|SA|E CIA|CIA)\b/g, ' ');
  return s.replace(/\s+/g, ' ').trim() || String(nome || '').toUpperCase();
}
const GENERICOS = new Set(['POSTO', 'POSTOS', 'AUTO', 'DE', 'DO', 'DA', 'DOS', 'DAS', 'E', 'LTDA', 'COMERCIO', 'COMBUSTIVEIS', 'COMBUSTIVEL',
  'DERIVADOS', 'PETROLEO', 'REDE', 'SA', 'ME', 'EIRELI', 'EPP', 'CIA', 'SERVICOS', 'GAS', 'LTD']);
const palavras = (s) => new Set((String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().match(/[A-Z0-9]+/g) || [])
  .filter((t) => t.length > 1 && !GENERICOS.has(t)));
// quanto do nome da Base aparece no nome/bandeira/operador do OpenStreetMap (0 a 1); o nome da cidade não conta
// (todo posto de Peritoró pode ter "Peritoró" no nome)
function parecido(nomeBase, nomeOsm, cidade) {
  const fora = palavras(cidade);
  const a = new Set([...palavras(nomeBase)].filter((t) => !fora.has(t))), b = palavras(nomeOsm);
  if (!a.size) return 0;
  let n = 0;
  a.forEach((t) => { if (b.has(t)) n++; });
  return n / a.size;
}
const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';

// escala divergente do preço (azul = mais barato, cinza = na mediana, vermelho = mais caro), 5 faixas com texto
const FAIXAS = [
  { ate: -0.04, cor: 'var(--div-1)', txt: '4% ou mais abaixo' },
  { ate: -0.015, cor: 'var(--div-2)', txt: '1,5% a 4% abaixo' },
  { ate: 0.015, cor: 'var(--div-3)', txt: 'perto da mediana' },
  { ate: 0.04, cor: 'var(--div-4)', txt: '1,5% a 4% acima' },
  { ate: Infinity, cor: 'var(--div-5)', txt: '4% ou mais acima' },
];

const DIMENSOES = [
  { id: 'cc', rotulo: 'Unidade', valor: (l) => l.cc },
  { id: 'periodo', rotulo: 'Período', periodo: true },
  { id: 'estabelecimento', rotulo: 'Estabelecimento', valor: (l) => l.tipoEstab },
];

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

const corCss = (v) => getComputedStyle(document.documentElement).getPropertyValue(v.slice(4, -1)).trim();
const escuro = () => (document.documentElement.getAttribute('data-theme') ||
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando o mapa…</div>';
  let dados, L, infoLocais, correcoes;
  const buscarLocais = () => fetch('/api/locais', { credentials: 'same-origin', cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : { podeEditar: false, alteracoes: [] })).catch(() => ({ podeEditar: false, alteracoes: [] }));
  try { [dados, L, infoLocais, correcoes] = await Promise.all([carregarDados(), carregarLeaflet(), buscarLocais(), buscarCorrecoes()]); } catch (e) {
    pagina.innerHTML = '<div class="vazio">' + esc(e.message) + '</div>';
    return {};
  }
  const podeEditar = infoLocais.podeEditar;
  // coordenadas cadastradas pelo site que a Base publicada ainda não traz: valem no mapa desde já
  let coordSite = new Map();
  function usarLocais(info) {
    infoLocais = info;
    coordSite = new Map();
    for (const a of [...info.alteracoes].sort((x, y) => x.id - y.id)) {
      if (a.estado === 'erro') continue;
      coordSite.set(a.nome, { coord: [a.lat, a.lon], estado: a.estado, mensagem: a.mensagem });
    }
  }
  usarLocais(infoLocais);
  let municipios = null;   // carregado só quando o cadastro abre
  const carregarMunicipios = () => municipios || (municipios = fetch('/gestao/mapas/municipios.json', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : [])).then((l) => new Map(l.map(([n, uf, lat, lon]) => [uf + '|' + chaveCidade(n), [lat, lon]]))).catch(() => new Map()));

  let base = [];
  let suspeitos = new Map();   // posto com coordenada na planilha longe da cidade (fora do mapa até corrigir)
  // unidades trocadas por esta tela (ou pelo Editar abastecimentos) que a Base ainda não traz: valem já no filtro, no mapa e nos
  // totais desta tela (cópia da linha com a unidade nova; ccBase guarda a da Base para o "era …")
  let trocas = trocasPorMinuto(correcoes.alteracoes);
  const comTroca = (l) => { const t = trocas.get(minutoDe(l)); return t && t.AD && t.AD !== l.cc ? { ...l, cc: t.AD, ccBase: l.cc, ccEstado: t.estado } : l; };
  let anteriorDe = new Map();   // abastecimento -> o anterior no mesmo posto (preço antes)
  function usarDados(d) {
    dados = d;
    base = d.linhas.filter((l) => DIESEL.has(l.combustivel) && !MOTORISTAS_FORA.has(l.motorista)).map(comTroca).filter((l) => !CC_FORA.has(l.cc));
    anteriorDe = new Map();
    const hist = new Map();
    for (const l of base) if (l.vlLitro > 0) (hist.get(l.fornecedor) || hist.set(l.fornecedor, []).get(l.fornecedor)).push(l);
    for (const ls of hist.values()) {
      ls.sort((a, b) => a.dia - b.dia || (a.seg ?? 0) - (b.seg ?? 0));
      for (let i = 1; i < ls.length; i++) anteriorDe.set(ls[i], ls[i - 1]);
    }
    suspeitos = new Map((d.locaisSuspeitos || []).map((s) => [s.nome, s]));
    ctx.definirSub('Diesel. Tamanho da bolha: litros abastecidos. Cor: preço médio contra a mediana dos postos do recorte.');
  }
  usarDados(dados);

  let ordem = { campo: 'litros', dir: -1 };
  let postos = [];

  pagina.innerHTML = `
    <section class="filtros" id="mc-filtros" aria-label="Filtros"></section>
    <div class="chips" id="mc-chips" aria-live="polite"></div>
    <dl class="apoio apoio-pilha" id="mc-apoio"></dl>
    <div class="mapa-grade mc-grade">
      <section class="mapa-bloco" aria-label="Mapa dos postos">
        <div class="mapa" id="mc-mapa"></div>
        <div class="mapa-legenda" id="mc-legenda"></div>
      </section>
      <div class="mc-lado">
        <section class="painel mapa-lista conter">
          <div class="painel-cab"><h2>Postos no mapa</h2><span class="conta" id="mc-conta"></span></div>
          <p class="nota">Clique num posto (na tabela ou no mapa) para ver só os abastecimentos dele.</p>
          <div class="tabela-rolagem mc-postos-alta"><table class="dados" id="mc-tabela"></table></div>
        </section>
        <section class="painel mapa-lista conter" aria-labelledby="mc-ab-titulo">
          <div class="painel-cab"><div><h2 id="mc-ab-titulo">Abastecimentos</h2><p class="nota" id="mc-ab-sub"></p></div>
            <button type="button" class="btn oculto" id="mc-ab-todos"><svg aria-hidden="true"><use href="#i-x"/></svg><span class="txt">Todos os postos</span></button></div>
          <div class="tabela-rolagem mc-ab-alta"><table class="dados" id="mc-ab-tabela"></table></div>
        </section>
      </div>
    </div>
    <section class="painel painel-tabela" id="mc-sem-coord-bloco">
      <div class="painel-cab"><h2>Postos sem coordenadas</h2><span class="conta" id="mc-sem-conta"></span></div>
      ${podeEditar ? '<p class="nota">Clique num posto para cadastrar a coordenada e colocá-lo no mapa.</p>' : ''}
      <div class="tabela-ferramentas">
        <input type="search" id="mc-sem-busca" placeholder="Posto ou cidade…" aria-label="Procurar posto sem coordenada" autocomplete="off">
      </div>
      <div class="tabela-rolagem tabela-alta"><table class="dados tabela-clicavel" id="mc-sem-tabela"></table></div>
    </section>
    <dialog class="dialogo" id="mc-un-dlg" aria-labelledby="mc-un-titulo">
      <form method="dialog" id="mc-un-form">
        <h2 id="mc-un-titulo">Trocar a unidade do abastecimento</h2>
        <p class="dialogo-explica" id="mc-un-sub"></p>
        <label class="campo-form largo"><span>Unidade (centro de custo)</span><select name="un" class="campo-sel mc-un-sel"></select></label>
        <p class="nota">A troca vai para os abastecimentos (INFORMAÇÃO ADICIONAL 3), como no Editar abastecimentos. O mapa e os outros painéis mudam na próxima publicação dos dashboards; até lá a tabela mostra a unidade nova.</p>
        <p class="erro-form oculto" id="mc-un-erro" role="alert"></p>
        <div class="dialogo-acoes"><button type="button" class="btn" id="mc-un-cancelar">Cancelar</button><button type="submit" class="btn btn-principal" id="mc-un-ok">Trocar unidade</button></div>
      </form>
    </dialog>
    <dialog class="dialogo" id="mc-dialogo" aria-labelledby="mc-dlg-titulo">
      <form method="dialog" id="mc-form" novalidate>
        <h2 id="mc-dlg-titulo">Cadastro do posto</h2>
        <dl class="mc-ficha" id="mc-ficha"></dl>
        <p class="erro-form oculto" id="mc-erro" role="alert"></p>
        <p class="nota mc-mini-nota">Clique no posto certo no mapa (os pontos são os postos de combustível que o OpenStreetMap conhece perto da
          cidade) ou em qualquer lugar do mapa para marcar a posição.</p>
        <div class="mc-mini" id="mc-mini" aria-label="Mapa para escolher a posição do posto"></div>
        <div class="mc-osm" id="mc-osm" aria-live="polite"></div>
        <div class="grade-form">
          <label class="campo-form largo"><span>Colar do Google Maps <small>(as duas coordenadas juntas ou o endereço do mapa)</small></span>
            <input name="par" autocomplete="off" placeholder="-13.857123, -40.083456"></label>
          <label class="campo-form"><span>Latitude</span><input name="lat" inputmode="decimal" autocomplete="off" placeholder="-13,857123"></label>
          <label class="campo-form"><span>Longitude</span><input name="lon" inputmode="decimal" autocomplete="off" placeholder="-40,083456"></label>
        </div>
        <p class="nota" id="mc-conferencia"></p>
        <p class="nota"><a id="mc-google" target="_blank" rel="noopener noreferrer">Procurar o posto no Google Maps</a> · no Google Maps, clique com o
          botão direito no posto e depois nas coordenadas para copiá-las.</p>
        <div class="dialogo-acoes">
          <button type="button" class="btn" id="mc-cancelar">Cancelar</button>
          <button type="submit" class="btn btn-principal" id="mc-salvar">Salvar coordenada</button>
        </div>
      </form>
    </dialog>`;
  const el = (id) => pagina.querySelector('#' + id);

  // postos vindos do link do aviso de preço alto (#/mapa-calor?...&postos=A|B): lidos antes de os filtros reescreverem o endereço
  const postosURL = (new URLSearchParams(location.hash.split('?')[1] || '').get('postos') || '').split('|').filter(Boolean);
  const filtros = criarFiltros({
    dimensoes: DIMENSOES, filtrosEl: el('mc-filtros'), chipsEl: el('mc-chips'), rota: '#/mapa-calor',
    // filtro novo: o mapa volta a enquadrar os postos do recorte (zoom automático, como no BI)
    obterBase: () => base, obterLimites: () => [dados.diaMin, dados.diaMax], aoMudar: () => { mexeu = false; atualizar(); }, prefixo: 'mc', periodoPadrao: 'mes',
  });

  // ---------- mapa ----------
  const mapa = L.map(el('mc-mapa'), { zoomControl: true, attributionControl: true, preferCanvas: true }).setView([-13.5, -44], 5);
  // fundo: mapa aberto do OpenStreetMap (no tema escuro o CSS escurece os blocos com um filtro)
  let camadaFundo = null;
  function fundo() {
    if (camadaFundo) return;
    camadaFundo = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">colaboradores do OpenStreetMap</a>',
    }).addTo(mapa);
  }
  fundo();
  const camadaBolhas = L.layerGroup().addTo(mapa);
  const marcadores = new Map();
  let enquadrado = false;

  function faixa(desvio) { return FAIXAS.find((f) => desvio <= f.ate); }

  function calcular(filtradas) {
    const m = new Map();
    for (const l of filtradas) {
      const k = l.fornecedor || '(sem nome)';
      let a = m.get(k);
      if (!a) m.set(k, (a = { nome: k, cidade: l.cidade, litros: 0, despesa: 0, qtd: 0, ultDia: -Infinity, ultSeg: -1, ultPreco: null, ultPlaca: '' }));
      a.litros += l.litros; a.despesa += l.despesa; a.qtd++;
      // último abastecimento: o mais recente pelo dia e pela hora
      const seg = l.seg ?? -1;
      if (l.dia > a.ultDia || (l.dia === a.ultDia && seg >= a.ultSeg)) { a.ultDia = l.dia; a.ultSeg = seg; a.ultPreco = l.vlLitro; a.ultPlaca = l.placa || ''; }
    }
    const lista = [...m.values()];
    const totalLitros = lista.reduce((s, a) => s + a.litros, 0);
    lista.forEach((a) => {
      a.preco = a.litros ? a.despesa / a.litros : null;
      a.pct = totalLitros ? a.litros / totalLitros : 0;
      const site = coordSite.get(a.nome.toUpperCase());
      a.coord = dados.locais[a.nome.toUpperCase()] || (site ? site.coord : null);
      a.doSite = !dados.locais[a.nome.toUpperCase()] && site ? site : null;   // coordenada nova, ainda não na Base publicada
    });
    const precos = lista.filter((a) => a.coord && a.preco).map((a) => a.preco).sort((x, y) => x - y);
    const mediana = precos.length ? (precos[Math.floor((precos.length - 1) / 2)] + precos[Math.ceil((precos.length - 1) / 2)]) / 2 : null;
    lista.forEach((a) => { a.desvio = mediana && a.preco ? a.preco / mediana - 1 : 0; });
    return { lista, mediana, totalLitros };
  }

  let ultimoR = null;
  function desenharMapa(r, animar) {
    ultimoR = r;
    camadaBolhas.clearLayers();
    marcadores.clear();
    const comCoord = r.lista.filter((a) => a.coord).sort((a, b) => b.litros - a.litros);   // grandes embaixo
    // postos escolhidos: só eles no mapa (como o filtro cruzado do BI); escolhidos sem coordenada: fica o recorte todo
    const escolhidos = postosSel.size ? comCoord.filter((a) => postosSel.has(a.nome)) : [];
    const noMapa = escolhidos.length ? escolhidos : comCoord;
    const max = comCoord.length ? comCoord[0].litros : 0;   // tamanho da bolha pelo recorte todo (não muda ao escolher)
    const anel = corCss('var(--superficie)');
    noMapa.forEach((a) => {
      const f = faixa(a.desvio);
      const c = L.circleMarker(a.coord, {
        radius: 4 + 24 * Math.sqrt(max ? a.litros / max : 0),
        color: anel, weight: 1.5, fillColor: corCss(f.cor), fillOpacity: 0.85,
      });
      c.bindTooltip(
        '<strong>' + esc(a.nome) + '</strong><br>' + esc(a.cidade || '') +
        '<div class="linha-dica"><span>Litros</span><b>' + esc(fmt.int(a.litros)) + ' (' + esc(fmt.pct(a.pct)) + ')</b></div>' +
        '<div class="linha-dica"><span>Preço médio</span><b>' + esc(fmt.moeda(a.preco)) + '</b></div>' +
        '<div class="linha-dica"><span>Contra a mediana</span><b>' + (a.desvio >= 0 ? '+' : '') + esc(fmt.pct(a.desvio)) + '</b></div>' +
        '<div class="linha-dica"><span>Último preço pago</span><b>' + esc(fmt.moeda(a.ultPreco)) + ' em ' + esc(fmtDia(a.ultDia) + ' ' + hora(a.ultSeg < 0 ? null : a.ultSeg)) + '</b></div>' +
        '<div class="linha-dica"><span>Última placa</span><b>' + esc(a.ultPlaca || '—') + '</b></div>' +
        (a.doSite ? '<div class="linha-dica"><span>Coordenada</span><b>' + esc(NOME_ESTADO[a.doSite.estado] || '') + '</b></div>' : ''),
        { direction: 'top', className: 'dica-mapa', opacity: 1 });
      c.on('click', (ev) => escolherPosto(a.nome, !!(ev.originalEvent && (ev.originalEvent.ctrlKey || ev.originalEvent.metaKey))));   // clique na bolha: filtra a tabela ao lado (Ctrl soma postos)
      c.addTo(camadaBolhas);
      marcadores.set(a.nome, c);
    });
    limites = noMapa.length ? L.latLngBounds(noMapa.map((a) => a.coord)).pad(0.08) : null;
    enquadrar(animar);
    if (escolhidos.length === 1) marcadores.get(escolhidos[0].nome).openTooltip();
  }
  // enquadra os postos quando o mapa já tem tamanho real; depois que a pessoa mexe no mapa, só volta a enquadrar
  // quando muda o filtro ou a escolha de postos
  let limites = null, mexeu = false;
  const semAnimacao = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function enquadrar(animar) {
    // fora da tela (27/11/2026): o setTimeout, o ResizeObserver e a recarga dos dados podem chegar depois do desmontar, com o
    // mapa já fora da página (era o erro "Cannot read properties of null (reading 'clientHeight')")
    const caixa = el('mc-mapa');
    if (parado || mexeu || !limites || !caixa || !caixa.clientHeight) return;
    mapa.invalidateSize();
    mapa.fitBounds(limites, { animate: !!animar && !semAnimacao(), maxZoom: 13 });   // um posto só: zoom de cidade
    enquadrado = true;
  }
  mapa.on('dragstart zoomstart', (e) => { if (enquadrado && e.originalEvent !== undefined) mexeu = true; });
  el('mc-mapa').addEventListener('pointerdown', () => { if (enquadrado) mexeu = true; });
  el('mc-mapa').addEventListener('wheel', () => { if (enquadrado) mexeu = true; }, { passive: true });

  function desenharLegenda(r) {
    el('mc-legenda').innerHTML =
      '<p class="mapa-legenda-titulo">Preço médio contra a mediana' + (r.mediana ? ' (' + esc(fmt.moeda(r.mediana)) + ')' : '') + '</p>' +
      '<ul>' + FAIXAS.map((f) => '<li><i style="background:' + f.cor + '"></i>' + esc(f.txt) + '</li>').join('') + '</ul>' +
      '<p class="mapa-legenda-titulo">Tamanho: litros abastecidos</p>';
  }

  function desenharApoio(r, semCoord) {
    const noMapa = r.lista.filter((a) => a.coord);
    const litrosMapa = noMapa.reduce((s, a) => s + a.litros, 0);
    const litrosSem = semCoord.reduce((s, a) => s + a.litros, 0);
    el('mc-apoio').innerHTML = htmlApoio([
      { rot: 'Postos no mapa', val: fmt.int(noMapa.length) + ' de ' + fmt.int(r.lista.length) },
      { rot: 'Litros no mapa', val: fmt.int(litrosMapa) },
      { rot: 'Preço médio', val: fmt.moeda(r.lista.reduce((s, a) => s + a.despesa, 0) / (r.totalLitros || 1)) },
      { rot: 'Mediana entre postos', val: fmt.moeda(r.mediana) },
      { rot: 'Sem coordenadas', val: fmt.int(semCoord.length) + (r.totalLitros ? ' (' + fmt.pct(litrosSem / r.totalLitros) + ' dos litros)' : '') },
    ]);
  }

  // ---------- tabelas (postos no mapa e postos sem coordenadas usam o mesmo desenho) ----------
  const COL = [
    { id: 'nome', rot: 'Posto', v: (a) => a.nome },
    { id: 'litros', rot: 'Litros', n: true, v: (a) => a.litros },
    { id: 'pct', rot: '% litros', n: true, v: (a) => a.pct, opc: 2 },
    { id: 'preco', rot: 'Preço médio', n: true, v: (a) => a.preco },
    { id: 'ult', rot: 'Último pago', n: true, v: (a) => a.ultPreco, opc: 1 },
    { id: 'dia', rot: 'Último abastecimento', n: true, v: (a) => a.ultDia * 86400 + Math.max(a.ultSeg, 0), opc: 1 },
    { id: 'placa', rot: 'Última placa', v: (a) => a.ultPlaca, opc: 1 },
  ];
  // colunas que somem quando o cartão é estreito (lista ao lado do mapa): opc 1 primeiro, opc 2 depois (gestao.css .col-opc)
  const opc = (id) => { const c = COL.find((x) => x.id === id); return c && c.opc ? ' col-opc' + c.opc : ''; };
  let ordemSem = { campo: 'litros', dir: -1 };
  let buscaSem = '';
  const semAcento = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  function ordenar(lista, o) {
    const c = COL.find((x) => x.id === o.campo);
    return lista.slice().sort((a, b) => {
      const va = c.v(a), vb = c.v(b);
      if (va === null) return 1; if (vb === null) return -1;
      return o.dir * (typeof va === 'string' ? va.localeCompare(vb, 'pt-BR') : va - vb) || b.litros - a.litros;
    });
  }
  function htmlTabela(lista, o, noMapa, vazio) {
    return '<thead><tr>' + COL.map((col) => {
      const ativa = o.campo === col.id;
      return '<th class="' + (col.n ? 'n' : '') + opc(col.id) + '" aria-sort="' + (ativa ? (o.dir < 0 ? 'descending' : 'ascending') : 'none') + '">' +
        '<button type="button" data-col="' + col.id + '">' + esc(col.rot) + (ativa ? '<span class="seta">' + (o.dir < 0 ? '▼' : '▲') + '</span>' : '') + '</button></th>';
    }).join('') + '</tr></thead><tbody>' +
    (lista.length ? lista.map((a) => {
      const f = faixa(a.desvio);
      const susp = !noMapa && suspeitos.get(a.nome.toUpperCase());
      const site = !noMapa ? coordSite.get(a.nome.toUpperCase()) : a.doSite;
      return '<tr' + (noMapa ? ' data-posto="' + esc(a.nome) + '" tabindex="0" title="Ver no mapa e filtrar os abastecimentos"' + (postosSel.has(a.nome) ? ' class="selecionado" aria-selected="true"' : '') : ' data-cadastrar="' + esc(a.nome) + '" tabindex="0"') + '><td class="trunc">' + (noMapa
          ? '<span class="link-botao nome-clicavel"><i class="ponto-faixa" style="background:' + f.cor + '" aria-hidden="true"></i>' + esc(a.nome) + '</span>'
          : '<button type="button" class="link-tabela link-botao">' + esc(a.nome) + '</button>') +
        '<small class="cidade-linha">' + esc(a.cidade || '') + '</small>' +
        (susp ? '<small class="cidade-linha aviso-linha">no cadastro: coordenada a ' + esc(fmt.int(susp.km)) + ' km da cidade (fora do mapa)</small>' : '') +
        (site ? '<small class="cidade-linha mc-site-' + esc(site.estado) + '">coordenada ' + esc(NOME_ESTADO[site.estado] || '') + '</small>' : '') + '</td>' +
        '<td class="n">' + esc(fmt.int(a.litros)) + '</td><td class="n' + opc('pct') + '">' + esc(fmt.pct(a.pct)) + '</td>' +
        '<td class="n">' + esc(fmt.moeda(a.preco)) + '</td><td class="n' + opc('ult') + '">' + esc(fmt.moeda(a.ultPreco)) + '</td>' +
        '<td class="n' + opc('dia') + '">' + esc(fmtDia(a.ultDia)) + (a.ultSeg >= 0 ? '<small class="cidade-linha">' + esc(hora(a.ultSeg)) + '</small>' : '') + '</td>' +
        '<td class="' + opc('placa').trim() + '">' + (a.ultPlaca ? '<strong>' + esc(a.ultPlaca) + '</strong>' : '<span class="sem-dado">—</span>') + '</td></tr>';
    }).join('') : '<tr><td colspan="' + COL.length + '"><div class="vazio">' + esc(vazio) + '</div></td></tr>') + '</tbody>';
  }
  function trocarOrdem(o, id) {
    const c = COL.find((x) => x.id === id);
    return o.campo === c.id ? { campo: c.id, dir: -o.dir } : { campo: c.id, dir: c.n ? -1 : 1 };
  }

  function desenharTabela() {
    const lista = ordenar(postos.filter((a) => a.coord), ordem);
    el('mc-conta').textContent = fmt.int(lista.length) + (lista.length === 1 ? ' posto' : ' postos');
    el('mc-tabela').innerHTML = htmlTabela(lista, ordem, true, 'Nenhum posto com coordenada neste recorte.');
  }
  el('mc-tabela').addEventListener('click', (e) => {
    const col = e.target.closest('[data-col]');
    if (col) {
      ordem = trocarOrdem(ordem, col.dataset.col);
      desenharTabela();
      el('mc-tabela').querySelector('[data-col="' + col.dataset.col + '"]').focus();
      return;
    }
    const tr = e.target.closest('tr[data-posto]');
    if (tr) irAoPosto(tr.dataset.posto, e.ctrlKey || e.metaKey);
  });
  el('mc-tabela').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-posto]')) { e.preventDefault(); irAoPosto(e.target.dataset.posto, e.ctrlKey || e.metaKey); }
  });
  // clique na linha: leva o mapa até o posto e filtra os abastecimentos dele (clicar de novo volta a todos);
  // Ctrl/Cmd + clique soma ou tira o posto da seleção (como na Operação por motorista)
  // (o mapa passa a mostrar só os escolhidos, enquadrados: escolherPosto redesenha o mapa)
  function irAoPosto(nome, somar) {
    escolherPosto(nome, somar);
  }

  // ---------- abastecimentos do recorte ou do posto escolhido (tabela ao lado dos postos) ----------
  let filtradasAtual = [];
  const postosSel = new Set(postosURL);        // postos escolhidos (vazio = todos os postos do recorte)
  let ordemAb = { campo: 'data', dir: -1 };
  let abLista = [];                            // linhas desenhadas (o lápis aponta para o índice)
  const podeTrocarUnidade = !!correcoes.podeEditar;
  const unidadeDe = (l) => l.cc;   // a linha já vem com a troca aplicada (comTroca)
  // ordem inicial: mais recente primeiro (seta na coluna Data); a coluna Placa ordena pela placa (e a data dentro dela)
  // preço anterior no mesmo posto e a variação, embaixo do R$/L
  const precoAntes = (l) => {
    const a = anteriorDe.get(l);
    if (!a || !(a.vlLitro > 0) || !(l.vlLitro > 0)) return '';
    const d = l.vlLitro / a.vlLitro - 1;
    return '<small class="cidade-linha' + (d > 0.0005 ? ' aviso-linha' : '') + '">antes ' + esc(fmt.moeda(a.vlLitro)) + ' (' + (d >= 0 ? '+' : '−') + esc(fmt.pct(Math.abs(d))) + ')</small>';
  };
  const POR_DATA = { id: 'data', v: (l) => l.dia * 86400 + (l.seg ?? 0) };
  let abSel = null;                            // abastecimento clicado (placa|minuto|combustível), destacado na tabela
  // placa e data em colunas separadas, cada uma ordenável (16/11/2026); cartão usado no abastecimento
  const COL_AB = [
    { id: 'data', rot: 'Data', n: true, v: POR_DATA.v },
    { id: 'placa', rot: 'Placa', v: (l) => l.placa || '' },
    { id: 'cartao', rot: 'Cartão', v: (l) => (l.cartao ? nomeCartao(l.cartao) : '') },
    { id: 'motorista', rot: 'Motorista', v: (l) => l.motorista || '' },
    { id: 'posto', rot: 'Posto', v: (l) => l.fornecedor || '', soTodos: true, opc: 1 },
    { id: 'unidade', rot: 'Unidade', v: (l) => unidadeDe(l) || '' },
    { id: 'litros', rot: 'Litros', n: true, v: (l) => l.litros },
    { id: 'vl', rot: 'R$/L', n: true, v: (l) => l.vlLitro, opc: 1 },
  ];
  function escolherPosto(nome, somar) {
    if (nome === null) postosSel.clear();
    else if (somar) { if (postosSel.has(nome)) postosSel.delete(nome); else postosSel.add(nome); }
    else if (postosSel.size === 1 && postosSel.has(nome)) postosSel.clear();
    else { postosSel.clear(); postosSel.add(nome); }
    // mapa: só os escolhidos (ou todos de novo), enquadrados
    mexeu = false;
    if (ultimoR) desenharMapa(ultimoR, true);
    desenharTabela();
    desenharAbastecimentos();
  }
  function desenharAbastecimentos() {
    const cols = COL_AB.filter((c) => !(c.soTodos && postosSel.size === 1));
    const c = COL_AB.find((x) => x.id === ordemAb.campo) || POR_DATA;
    abLista = filtradasAtual.filter((l) => !postosSel.size || postosSel.has(l.fornecedor || '(sem nome)')).sort((a, b) => {
      const x = c.v(a), y = c.v(b);
      if (x === null || x === undefined) return 1; if (y === null || y === undefined) return -1;
      return ordemAb.dir * (typeof x === 'string' ? x.localeCompare(y, 'pt-BR', { numeric: true }) : x - y) || b.dia - a.dia || (b.seg ?? 0) - (a.seg ?? 0);
    });
    const litros = abLista.reduce((s, l) => s + l.litros, 0), valor = abLista.reduce((s, l) => s + l.despesa, 0);
    el('mc-ab-titulo').textContent = postosSel.size === 1 ? 'Abastecimentos em ' + [...postosSel][0] : postosSel.size ? 'Abastecimentos em ' + postosSel.size + ' postos' : 'Abastecimentos';
    el('mc-ab-sub').textContent = (postosSel.size > 1 ? [...postosSel].join(' · ') + ' · ' : postosSel.size ? '' : 'Todos os postos do recorte · ') + fmt.int(abLista.length) + (abLista.length === 1 ? ' abastecimento' : ' abastecimentos') +
      ' · ' + fmt.int(litros) + ' L · preço médio ' + fmt.moeda(litros ? valor / litros : null);
    el('mc-ab-todos').classList.toggle('oculto', !postosSel.size);
    const opcAb = (col) => (col.opc && !(col.id === 'vl' && postosSel.size) ? ' col-opc' + col.opc : '');   // com posto escolhido o R$/L aparece sempre
    el('mc-ab-tabela').innerHTML = '<thead><tr>' + cols.map((col) => {
      const ativa = ordemAb.campo === col.id;
      return '<th class="' + (col.n ? 'n' : '') + opcAb(col) + '" aria-sort="' + (ativa ? (ordemAb.dir < 0 ? 'descending' : 'ascending') : 'none') + '">' +
        '<button type="button" data-col-ab="' + col.id + '">' + esc(col.rot) + (ativa ? '<span class="seta">' + (ordemAb.dir < 0 ? '▼' : '▲') + '</span>' : '') + '</button></th>';
    }).join('') + '</tr></thead><tbody>' +
    (abLista.length ? abLista.map((l, i) => {
      const un = unidadeDe(l);
      const celula = {
        data: '<td class="mc-ab-data num">' + esc(fmtDia(l.dia)) + (l.seg !== null && l.seg !== undefined ? '<small class="cidade-linha">' + esc(hora(l.seg)) + '</small>' : '') + '</td>',
        placa: '<td class="mc-ab-id"><strong>' + esc(l.placa || '—') + '</strong></td>',
        cartao: '<td class="mc-ab-cartao">' + (l.cartao ? seloCartao(l.cartao) : '<span class="sem-dado" title="Cartão não informado">—</span>') +
          (l.tempoReal ? ' <span class="selo-tempo-real" title="Veio da API do cartão hoje; entra nos abastecimentos no dia seguinte (D-1)">API</span>' : '') + '</td>',
        motorista: '<td class="mc-ab-mot">' + esc(l.motorista || '—') + '</td>',
        posto: '<td class="mc-ab-posto col-opc1">' + esc(l.fornecedor || '—') + '</td>',
        unidade: '<td class="mc-ab-un"><div class="mc-un"><span>' + esc(un || '—') +
            (l.ccBase ? '<small class="cidade-linha">' + esc(ESTADO_BC[l.ccEstado] || '') + ' · era ' + esc(l.ccBase) + '</small>' : '') + '</span>' +
            (podeTrocarUnidade ? (l.tempoReal
              ? '<button type="button" class="btn-lixeira btn-editar" disabled aria-label="Ainda não dá para trocar: abastecimento da API, entra nos abastecimentos às 6h do dia seguinte" title="Veio da API do cartão: entra nos abastecimentos às 6h do dia seguinte; troque depois disso"><svg aria-hidden="true"><use href="#i-lapis"/></svg></button>'
              : '<button type="button" class="btn-lixeira btn-editar" data-un="' + i + '" aria-label="Trocar a unidade do abastecimento de ' + esc(l.placa) + ' em ' + esc(fmtDia(l.dia)) + '" title="Trocar a unidade"><svg aria-hidden="true"><use href="#i-lapis"/></svg></button>') : '') +
          '</div></td>',
        litros: '<td class="n num">' + esc(fmt.d2(l.litros)) + '</td>',
        vl: '<td class="n num' + (postosSel.size ? '' : ' col-opc1') + '">' + esc(fmt.moeda(l.vlLitro)) + precoAntes(l) + '</td>',
      };
      const sel = abSel === minutoDe(l) + '|' + (l.combustivel || '');
      return '<tr class="mc-ab-linha' + (sel ? ' selecionado' : '') + '" data-ab="' + i + '" tabindex="0" title="Ver o posto no mapa"' + (sel ? ' aria-selected="true"' : '') + '>' +
        cols.map((col) => celula[col.id]).join('') + '</tr>';
    }).join('') : '<tr><td colspan="' + cols.length + '"><div class="vazio">Nenhum abastecimento neste recorte.</div></td></tr>') + '</tbody>';
  }
  el('mc-ab-todos').addEventListener('click', () => escolherPosto(null));
  el('mc-ab-tabela').addEventListener('click', (e) => {
    const col = e.target.closest('[data-col-ab]');
    if (col) {
      const id = col.dataset.colAb, c = COL_AB.find((x) => x.id === id);
      ordemAb = ordemAb.campo === id ? { campo: id, dir: -ordemAb.dir } : { campo: id, dir: c.n ? -1 : 1 };
      desenharAbastecimentos();
      el('mc-ab-tabela').querySelector('[data-col-ab="' + id + '"]').focus();
      return;
    }
    const b = e.target.closest('[data-un]');
    if (b) { abrirTrocaUnidade(abLista[Number(b.dataset.un)], b); return; }
    const tr = e.target.closest('tr[data-ab]');
    if (tr) destacarPostoDo(abLista[Number(tr.dataset.ab)], tr);
  });
  el('mc-ab-tabela').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-ab]')) { e.preventDefault(); destacarPostoDo(abLista[Number(e.target.dataset.ab)], e.target); }
  });
  // clique num abastecimento: leva o mapa até o posto dele e destaca o posto (como na lista de postos), sem filtrar a tabela
  function destacarPostoDo(l, tr) {
    if (!l) return;
    abSel = minutoDe(l) + '|' + (l.combustivel || '');
    el('mc-ab-tabela').querySelectorAll('tr.selecionado').forEach((x) => { x.classList.remove('selecionado'); x.removeAttribute('aria-selected'); });
    tr.classList.add('selecionado'); tr.setAttribute('aria-selected', 'true');
    const nome = l.fornecedor || '(sem nome)', m = marcadores.get(nome);
    el('mc-tabela').querySelectorAll('tr.mc-destaque').forEach((x) => x.classList.remove('mc-destaque'));
    if (!m) { ctx.aviso(nome + ' não tem coordenada: não aparece no mapa (veja em "Postos sem coordenadas").'); return; }
    mexeu = true;
    mapa.flyTo(m.getLatLng(), Math.max(mapa.getZoom(), 11), { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 0.6 });
    m.openTooltip();
    const linhaPosto = el('mc-tabela').querySelector('tr[data-posto="' + CSS.escape(nome) + '"]');
    if (linhaPosto) { linhaPosto.classList.add('mc-destaque'); linhaPosto.scrollIntoView({ block: 'nearest' }); }
  }

  // ---------- trocar a unidade (centro de custo) de um abastecimento ----------
  let trocando = null, botaoTroca = null;
  const unidades = () => [...new Set(dados.linhas.map((l) => l.cc).filter((u) => u && !/^\(sem /.test(u)))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  function abrirTrocaUnidade(l, botao) {
    if (!l) return;
    trocando = l; botaoTroca = botao;
    const f = el('mc-un-form'), atual = unidadeDe(l);
    el('mc-un-sub').textContent = l.placa + ' · ' + fmtDia(l.dia) + (l.seg !== null && l.seg !== undefined ? ' ' + hora(l.seg) : '') + ' · ' + (l.motorista || '—') + ' · ' + (l.fornecedor || '') + ' · ' + fmt.d2(l.litros) + ' L';
    f.un.innerHTML = unidades().map((u) => '<option' + (u === atual ? ' selected' : '') + '>' + esc(u) + '</option>').join('');
    el('mc-un-erro').classList.add('oculto');
    el('mc-un-dlg').showModal();
    f.un.focus();
  }
  el('mc-un-cancelar').addEventListener('click', () => el('mc-un-dlg').close());
  el('mc-un-dlg').addEventListener('close', () => { if (botaoTroca && document.contains(botaoTroca)) botaoTroca.focus(); });
  el('mc-un-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const l = trocando, nova = el('mc-un-form').un.value, ok = el('mc-un-ok');
    if (!l) return;
    if (nova === unidadeDe(l)) { el('mc-un-dlg').close(); return; }
    ok.disabled = true; ok.textContent = 'Gravando…';
    try {
      const a = await corrigirNaBaseCopia(l, 'AD', nova);
      correcoes.alteracoes = [a, ...correcoes.alteracoes];
      trocas = trocasPorMinuto(correcoes.alteracoes);
      el('mc-un-dlg').close();
      usarDados(dados);   // o filtro, o mapa e os totais já passam a usar a unidade nova
      atualizar();
      ctx.aviso('Unidade trocada para ' + nova + '. Já vale nesta tela e nos abastecimentos; os outros painéis mudam na próxima publicação dos dashboards.');
    } catch (err) {
      if (err.message !== 'sessão') { el('mc-un-erro').textContent = err.message; el('mc-un-erro').classList.remove('oculto'); }
    } finally { ok.disabled = false; ok.textContent = 'Trocar unidade'; }
  });

  let semCoord = [];
  function desenharSemCoord() {
    const t = semAcento(buscaSem.trim());
    const lista = ordenar(semCoord.filter((a) => !t || semAcento(a.nome).includes(t) || semAcento(a.cidade).includes(t)), ordemSem);
    el('mc-sem-conta').textContent = fmt.int(lista.length) + (lista.length === 1 ? ' posto' : ' postos') +
      (t && lista.length !== semCoord.length ? ' de ' + fmt.int(semCoord.length) : '');
    el('mc-sem-tabela').innerHTML = htmlTabela(lista, ordemSem, false,
      semCoord.length ? 'Nenhum posto sem coordenada com esse nome ou cidade.' : 'Todos os postos deste recorte têm coordenadas.');
  }
  el('mc-sem-tabela').addEventListener('click', (e) => {
    const col = e.target.closest('[data-col]');
    if (col) {
      ordemSem = trocarOrdem(ordemSem, col.dataset.col);
      desenharSemCoord();
      el('mc-sem-tabela').querySelector('[data-col="' + col.dataset.col + '"]').focus();
      return;
    }
    const tr = e.target.closest('[data-cadastrar]');
    if (tr) abrirCadastro(tr.dataset.cadastrar);
  });
  el('mc-sem-tabela').addEventListener('keydown', (e) => {
    const tr = e.target.closest('[data-cadastrar]');
    if (tr && (e.key === 'Enter' || e.key === ' ') && e.target === tr) { e.preventDefault(); abrirCadastro(tr.dataset.cadastrar); }
  });

  // ---------- cadastro do posto: inserir a coordenada ----------
  const dlg = el('mc-dialogo'), form = el('mc-form');
  let aberto = null;   // posto do cadastro aberto
  const cidadeUf = (c) => { const m = /^(.*) - ([A-Z]{2})$/.exec(c || ''); return m ? { cidade: m[1], uf: m[2] } : { cidade: c || '', uf: '' }; };
  function erroCad(msg) { el('mc-erro').textContent = msg || ''; el('mc-erro').classList.toggle('oculto', !msg); }
  function coordDoForm() {
    const lat = lerNum(form.lat.value), lon = lerNum(form.lon.value);
    return lat !== null && lon !== null ? [lat, lon] : null;
  }
  async function conferir() {
    const c = coordDoForm(), nota = el('mc-conferencia');
    marcarMini(c && noBrasil(c[0], c[1]) ? c : null);
    if (!c) { nota.textContent = ''; return; }
    if (!noBrasil(c[0], c[1])) { nota.innerHTML = '<span class="aviso-linha">Essa coordenada fica fora do Brasil: confira a ordem (latitude primeiro) e o sinal de menos.</span>'; return; }
    const { cidade, uf } = cidadeUf(aberto.cidade);
    const sede = (await carregarMunicipios()).get(uf + '|' + chaveCidade(cidade));
    if (!sede) { nota.textContent = ''; return; }
    const d = km(c, sede);
    nota.innerHTML = d > LIMITE_KM_CIDADE
      ? '<span class="aviso-linha">Esse ponto fica a ' + esc(fmt.int(d)) + ' km de ' + esc(cidade) + ': o mapa trata coordenada a mais de ' + LIMITE_KM_CIDADE +
        ' km da cidade como erro e deixa o posto de fora. Confira antes de salvar.</span>'
      : 'Fica a ' + esc(fmt.int(d)) + ' km do centro de ' + esc(cidade) + '.';
  }
  function abrirCadastro(nome) {
    const a = postos.find((x) => x.nome === nome);
    if (!a) return;
    aberto = a;
    const susp = suspeitos.get(nome.toUpperCase()), site = coordSite.get(nome.toUpperCase());
    el('mc-ficha').innerHTML = [
      ['Posto', a.nome], ['Cidade', a.cidade || '—'], ['Endereço nos abastecimentos', dados.enderecos[a.nome.toUpperCase()] || '—'],
      ['Último abastecimento', fmtDia(a.ultDia) + (a.ultSeg >= 0 ? ' ' + hora(a.ultSeg) : '') + (a.ultPlaca ? ' · placa ' + a.ultPlaca : '')],
      ['Litros no recorte', fmt.int(a.litros) + ' L · preço médio ' + fmt.moeda(a.preco)],
      ...(susp ? [['No cadastro hoje', susp.lat + ', ' + susp.lng + ' (a ' + fmt.int(susp.km) + ' km da cidade, fora do mapa)']] : []),
      ...(site ? [['Cadastrada pelo site', site.coord.join(', ') + ' · ' + (NOME_ESTADO[site.estado] || '') + (site.mensagem ? ' · ' + site.mensagem : '')]] : []),
    ].map(([t, v]) => '<div><dt>' + esc(t) + '</dt><dd>' + esc(v) + '</dd></div>').join('');
    form.reset();
    if (site) { form.lat.value = String(site.coord[0]).replace('.', ','); form.lon.value = String(site.coord[1]).replace('.', ','); }
    el('mc-google').href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(a.nome + ' ' + (a.cidade || ''));
    erroCad(podeEditar ? '' : 'Seu acesso ao mapa de calor é só de consulta: peça a um administrador para inserir a coordenada.');
    form.querySelectorAll('input').forEach((i) => { i.disabled = !podeEditar; });
    el('mc-salvar').disabled = !podeEditar;
    el('mc-conferencia').textContent = '';
    dlg.showModal();
    montarMini(a);
    conferir();
    if (podeEditar) form.par.focus();
  }

  // ---------- mapinha do cadastro: postos do OpenStreetMap perto da cidade ----------
  let mini = null, camadaOsm = null, marcaEscolha = null;
  const cacheOsm = new Map();   // "lat,lon" da cidade -> lista de postos do OpenStreetMap (só nesta tela)
  function usarPonto(lat, lon) {
    if (!podeEditar) return;
    form.lat.value = String(+lat.toFixed(6)).replace('.', ',');
    form.lon.value = String(+lon.toFixed(6)).replace('.', ',');
    erroCad('');
    conferir();
  }
  function marcarMini(c) {
    if (!mini) return;
    if (!c) { if (marcaEscolha) { marcaEscolha.remove(); marcaEscolha = null; } return; }
    if (!marcaEscolha) {
      marcaEscolha = L.marker(c, { draggable: podeEditar, title: 'Posição escolhida', zIndexOffset: 1000 }).addTo(mini);
      marcaEscolha.on('dragend', () => { const p = marcaEscolha.getLatLng(); usarPonto(p.lat, p.lng); });
    } else marcaEscolha.setLatLng(c);
  }
  // postos de combustível do OpenStreetMap num quadrado em volta da cidade (Overpass; tenta os servidores um depois do outro)
  async function buscarPerto(sede) {
    const k = 'perto|' + sede.map((x) => x.toFixed(3)).join(',');
    if (cacheOsm.has(k)) return cacheOsm.get(k);
    const d = RAIO_OSM / 111000;
    const bb = [sede[0] - d, sede[1] - d, sede[0] + d, sede[1] + d].map((x) => x.toFixed(5)).join(',');
    const q = '[out:json][timeout:20];(node["amenity"="fuel"](' + bb + ');way["amenity"="fuel"](' + bb + '););out center tags;';
    let ultimo = null;
    for (const url of OVERPASS) {
      try {
        const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 25000);
        const r = await fetch(url + '?data=' + encodeURIComponent(q), { signal: ctl.signal }).finally(() => clearTimeout(t));
        if (!r.ok) { ultimo = r.status; continue; }
        const j = await r.json();
        const lista = (j.elements || []).map((e) => {
          const tg = e.tags || {};
          return { lat: e.lat ?? (e.center && e.center.lat), lon: e.lon ?? (e.center && e.center.lon), nome: tg.name || '', bandeira: tg.brand || '',
            operador: tg.operator || '', endereco: [tg['addr:street'], tg['addr:housenumber']].filter(Boolean).join(', ') };
        }).filter((p) => p.lat !== undefined && p.lon !== undefined && km([p.lat, p.lon], sede) <= RAIO_OSM / 1000);
        cacheOsm.set(k, lista);
        return lista;
      } catch (e) { ultimo = e.name === 'AbortError' ? 'demorou demais' : e.message; }
    }
    throw new Error('A lista de postos por perto do OpenStreetMap não respondeu agora (' + ultimo + ').');
  }
  // lugares do OpenStreetMap com o nome do posto na cidade dele (Nominatim, 1 consulta por segundo no máximo)
  async function buscarNome(a, cidade, uf, sede) {
    const k = 'nome|' + a.nome;
    if (cacheOsm.has(k)) return cacheOsm.get(k);
    const limpo = nomeLimpo(a.nome);
    const consultas = [limpo, ...(/^POSTO\b/.test(limpo) ? [] : ['POSTO ' + limpo])];
    const vistos = new Set(), lista = [];
    for (let i = 0; i < consultas.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1100));
      const r = await fetch(NOMINATIM + '?' + new URLSearchParams({ format: 'jsonv2', limit: '6', countrycodes: 'br', q: consultas[i] + ', ' + cidade + ', ' + uf }));
      if (!r.ok) throw new Error('A busca pelo nome no OpenStreetMap não respondeu (' + r.status + ').');
      for (const e of await r.json()) {
        if (vistos.has(e.place_id)) continue;
        vistos.add(e.place_id);
        const p = { lat: Number(e.lat), lon: Number(e.lon), nome: e.name || '', bandeira: '', operador: '', endereco: e.display_name.split(',').slice(1, 3).join(',').trim(),
          tipo: e.category === 'amenity' ? ({ fuel: 'posto de combustível', parking: 'estacionamento' }[e.type] || e.type) : e.type };
        if (km([p.lat, p.lon], sede) <= 30 && parecido(limpo, p.nome, cidade) > 0) lista.push(p);
      }
    }
    cacheOsm.set(k, lista);
    return lista;
  }
  async function montarMini(a) {
    const caixa = el('mc-osm');
    const { cidade, uf } = cidadeUf(a.cidade);
    const sede = (await carregarMunicipios()).get(uf + '|' + chaveCidade(cidade));
    const centro = coordDoForm() || sede || [-13.5, -44];
    if (!mini) {
      mini = L.map(el('mc-mini'), { zoomControl: true, attributionControl: true }).setView(centro, sede ? 12 : 5);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(mini);
      camadaOsm = L.layerGroup().addTo(mini);
      mini.on('click', (e) => usarPonto(e.latlng.lat, e.latlng.lng));
    } else mini.setView(centro, sede ? 12 : 5);
    setTimeout(() => mini.invalidateSize(), 50);   // o diálogo acabou de abrir
    camadaOsm.clearLayers();
    if (marcaEscolha) { marcaEscolha.remove(); marcaEscolha = null; }
    if (!sede) { caixa.innerHTML = '<p class="nota">Não achei a cidade do posto no IBGE para buscar os postos por perto. Marque a posição clicando no mapa.</p>'; return; }
    // duas listas: os lugares com o nome do posto (mais certeiros) e os postos de combustível por perto
    const cands = [];   // todos os candidatos desenhados (o botão "Usar" aponta para o índice)
    const html = { nome: '<p class="nota">Procurando "' + esc(nomeLimpo(a.nome)) + '" no OpenStreetMap…</p>', perto: '<p class="nota">Buscando os postos de combustível perto de ' + esc(cidade) + '…</p>' };
    const desenhar = () => { if (aberto === a) caixa.innerHTML = '<h3 class="mc-osm-titulo">Encontrados pelo nome</h3>' + html.nome + '<h3 class="mc-osm-titulo">Postos de combustível por perto</h3>' + html.perto; };
    const item = (p) => '<li><span><strong>' + esc(p.rot) + '</strong>' + (p.nota >= 0.5 ? ' <em class="mc-parecido">nome parecido</em>' : '') +
      '<small class="cidade-linha">' + esc([p.tipo, p.endereco, fmt.int(p.dist) + ' km do centro'].filter(Boolean).join(' · ')) + '</small></span>' +
      (podeEditar ? '<button type="button" class="btn-linha" data-osm="' + p.i + '">Usar</button>' : '') + '</li>';
    function adicionar(lista, verde) {
      return lista.map((p) => {
        const c = { ...p, rot: [p.nome, p.bandeira && p.bandeira !== p.nome ? p.bandeira : ''].filter(Boolean).join(' · ') || 'Posto sem nome no mapa',
          nota: parecido(nomeLimpo(a.nome), [p.nome, p.bandeira, p.operador].join(' '), cidade), dist: km([p.lat, p.lon], sede), i: cands.length };
        cands.push(c);
        const destaque = verde || c.nota >= 0.5;
        L.circleMarker([c.lat, c.lon], { radius: destaque ? 9 : 6, color: '#fff', weight: 1.5,
          fillColor: destaque ? corCss('var(--placa)') : corCss('var(--tinta-3)'), fillOpacity: 0.9 })
          .bindTooltip(esc(c.rot) + (c.endereco ? '<br>' + esc(c.endereco) : '') + '<br>' + esc(fmt.int(c.dist)) + ' km do centro', { direction: 'top' })
          .on('click', (e) => { L.DomEvent.stopPropagation(e); usarPonto(c.lat, c.lon); })
          .addTo(camadaOsm);
        return c;
      });
    }
    desenhar();
    const porNome = buscarNome(a, cidade, uf, sede).then((lista) => {
      if (aberto !== a) return;
      const cs = adicionar(lista, true).sort((x, y) => y.nota - x.nota || x.dist - y.dist);
      html.nome = cs.length ? '<ul class="mc-osm-lista">' + cs.map(item).join('') + '</ul>'
        : '<p class="nota">Nada com o nome "' + esc(nomeLimpo(a.nome)) + '" perto de ' + esc(cidade) + ' no OpenStreetMap.</p>';
      if (cs.length) mini.setView([cs[0].lat, cs[0].lon], 15);
    }).catch((e) => { html.nome = '<p class="nota aviso-linha">' + esc(e.message) + '</p>'; }).finally(desenhar);
    const perto = buscarPerto(sede).then((lista) => {
      if (aberto !== a) return;
      const cs = adicionar(lista, false).sort((x, y) => y.nota - x.nota || x.dist - y.dist);
      html.perto = cs.length ? '<p class="nota">' + fmt.int(cs.length) + ' postos a até ' + RAIO_OSM / 1000 + ' km do centro (em verde, os de nome parecido; no mapa os nomes costumam ser o comercial, não a razão social):</p>' +
        '<ul class="mc-osm-lista">' + cs.slice(0, 10).map(item).join('') + '</ul>'
        : '<p class="nota">O OpenStreetMap não tem postos mapeados a até ' + RAIO_OSM / 1000 + ' km de ' + esc(cidade) + '.</p>';
    }).catch((e) => { html.perto = '<p class="nota">' + esc(e.message) + ' Dá para marcar clicando no mapa ou colar do Google Maps.</p>'; }).finally(desenhar);
    caixa.onclick = (e) => {
      const b = e.target.closest('[data-osm]');
      if (!b) return;
      const p = cands[Number(b.dataset.osm)];
      usarPonto(p.lat, p.lon);
      mini.setView([p.lat, p.lon], Math.max(mini.getZoom(), 16));
    };
    await Promise.allSettled([porNome, perto]);
  }
  form.par.addEventListener('input', () => {
    const p = lerPar(form.par.value);
    if (p) { form.lat.value = String(p[0]).replace('.', ','); form.lon.value = String(p[1]).replace('.', ','); conferir(); }
  });
  form.lat.addEventListener('input', conferir);
  form.lon.addEventListener('input', conferir);
  el('mc-cancelar').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = coordDoForm();
    if (!c) { erroCad('Preencha a latitude e a longitude (ou cole as duas do Google Maps).'); form.par.focus(); return; }
    if (!noBrasil(c[0], c[1])) { erroCad('Essa coordenada fica fora do Brasil. Confira a latitude, a longitude e o sinal de menos.'); return; }
    const b = el('mc-salvar');
    b.disabled = true; b.textContent = 'Salvando…';
    try {
      const { cidade, uf } = cidadeUf(aberto.cidade);
      const r = await fetch('/api/locais', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: aberto.nome, cidade, uf, lat: c[0], lon: c[1] }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { location.href = '/?entrar=1'; return; }
      if (!r.ok) throw new Error(j.erro || 'Não foi possível salvar (' + r.status + ').');
      infoLocais.alteracoes = [j.alteracao, ...infoLocais.alteracoes.filter((x) => x.id !== j.alteracao.id)];
      usarLocais(infoLocais);
      dlg.close();
      atualizar();
      vigiar();
    } catch (err) {
      erroCad(err.message);
    } finally {
      b.disabled = !podeEditar; b.textContent = 'Salvar coordenada';
    }
  });
  // enquanto houver coordenada esperando a planilha, confere a cada 15 s (situação da gravação)
  let timer = null, parado = false;
  function vigiar() {
    if (parado || timer || ![...coordSite.values()].some((s) => s.estado === 'pendente' || s.estado === 'aguardando')) return;
    timer = setTimeout(async () => {
      timer = null;
      usarLocais(await buscarLocais());
      atualizar();
      vigiar();
    }, 15000);
  }
  vigiar();
  let tBusca = null;
  el('mc-sem-busca').addEventListener('input', (e) => {
    clearTimeout(tBusca);
    tBusca = setTimeout(() => { buscaSem = e.target.value; desenharSemCoord(); }, 150);
  });

  // ---------- ciclo ----------
  const atualizar = agendador(() => {
    const filtradas = base.filter((l) => filtros.passa(l, null));
    filtradasAtual = filtradas;
    filtros.atualizarUI();
    const r = calcular(filtradas);
    postos = r.lista;
    semCoord = r.lista.filter((a) => !a.coord);   // segue os filtros (unidade, período, estabelecimento)
    desenharApoio(r, semCoord);
    desenharLegenda(r);
    for (const n of [...postosSel]) if (!postos.some((a) => a.nome === n)) postosSel.delete(n);
    desenharMapa(r);
    desenharTabela();
    desenharAbastecimentos();
    desenharSemCoord();
  });
  atualizar();
  const tEnquadrar = setTimeout(enquadrar, 60);

  const aoTema = () => atualizar();   // recolore o anel das bolhas; o fundo escurece pelo CSS
  window.addEventListener('tema', aoTema);
  const ro = new ResizeObserver(() => { if (parado) return; mapa.invalidateSize(); if (!mexeu) enquadrar(); });
  ro.observe(el('mc-mapa'));
  const aoAtualizarDados = () => carregarDados().then((d) => { if (parado) return; usarDados(d); atualizar(); });
  window.addEventListener('dados-atualizados', aoAtualizarDados);
  return {
    desmontar() {
      parado = true; clearTimeout(timer); clearTimeout(tEnquadrar);
      if (mini) mini.remove();
      filtros.destruir();
      window.removeEventListener('tema', aoTema);
      window.removeEventListener('dados-atualizados', aoAtualizarDados);
      ro.disconnect();
      mapa.remove();
    },
  };
}
