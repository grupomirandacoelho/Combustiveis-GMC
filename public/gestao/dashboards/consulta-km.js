// "Consulta de KM" — para a manutenção: último hodômetro de cada placa e a data da leitura, a partir dos
// abastecimentos da Base (o hodômetro é informado a cada abastecimento). Ao clicar na placa, o histórico de leituras.
//  - leitura menor que uma anterior (hodômetro digitado errado ou trocado) é sinalizada para conferir
//  - todos os combustíveis contam (Arla também traz o hodômetro)
//  - hodômetro que passou de 999.999 e voltou a zero: no histórico da placa dá para marcar a "virada" (/api/km-viradas);
//    a partir dela as leituras contam com +1.000.000 km nas comparações (o hodômetro mostrado continua o real)
//  - correções do "Editar abastecimentos" (hodômetro, placa, exclusão; /api/km-correcoes) valem por cima da Base
//    enquanto a Base ainda tiver o valor antigo
import { carregarDados, fmt, esc, fmtDia, diaIso, placaDesabilitada } from '../lib/dados.js';
import { htmlApoio, botoesMaisMenos } from '../lib/filtros.js';
import { ligarBaixar } from '../lib/baixar.js';

const POR_PAGINA = 50;
const MILHAO = 1000000;
// queda que parece virada: a leitura anterior passava de 900 mil e a nova é menor que 200 mil
const pareceVirada = (antes, depois) => antes >= 900000 && depois < 200000;
const hora = (seg) => (seg === null || seg === undefined ? '' : String(Math.floor(seg / 3600)).padStart(2, '0') + ':' + String(Math.floor(seg / 60) % 60).padStart(2, '0'));
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando as leituras de hodômetro…</div>';
  let dados, viradas = [], correcoes = [];
  const buscarCorrecoes = () => fetch('/api/km-correcoes', { credentials: 'same-origin', cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : { correcoes: [] })).then((j) => j.correcoes || []).catch(() => []);
  try {
    [dados, viradas, correcoes] = await Promise.all([carregarDados({ tempoReal: true }),
      fetch('/api/km-viradas', { credentials: 'same-origin', cache: 'no-store' }).then((r) => (r.ok ? r.json() : { viradas: [] }))
        .then((j) => j.viradas || []).catch(() => []),
      buscarCorrecoes()]);
  } catch (e) {
    pagina.innerHTML = '<div class="vazio">' + esc(e.message) + ' Recarregue a página para tentar de novo.</div>';
    return {};
  }

  let placas = [];   // [{placa, km, dia, seg, leituras:[...], alerta, viradas, candidata, modelo, unidade, categoria}]
  // Correções do "Editar abastecimentos" (gravadas na Base_copia) por cima da Base: hodômetro novo, placa nova ou
  // abastecimento excluído. Cada uma só vale enquanto a Base ainda tem o valor de antes da correção (se a Base já foi
  // corrigida direto, vale a Base). Devolve cópias: os dados carregados são os mesmos das outras páginas.
  const normPlaca = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  function comCorrecoes(linhas) {
    if (!correcoes.length) return linhas;
    const chave = (placa, dia, seg) => normPlaca(placa) + '|' + dia + '|' + seg;
    const porChave = new Map(linhas.map((l, i) => [chave(l.placa, l.dia, l.seg || 0), i]));
    const saida = linhas.slice(), fora = new Set();
    for (const c of correcoes) {
      let seg = Math.round((c.data % 1) * 86400), dia = Math.floor(c.data) - 25569;
      if (seg >= 86400) { seg -= 86400; dia++; }
      const i = porChave.get(chave(c.placa, dia, seg));
      if (i === undefined) continue;
      const l = saida[i], an = c.antes || {}, ce = c.celulas || {};
      if (c.acao === 'excluir') {
        if (an.Q === undefined || an.Q === null || an.Q === l.hodometro) fora.add(i);
        continue;
      }
      const novo = { ...l };
      if (ce.Q !== undefined && ce.Q !== null && an.Q === l.hodometro) { novo.hodometro = ce.Q; novo.corrigido = true; }
      if (ce.F && (!an.F || normPlaca(an.F) === normPlaca(l.placa))) { novo.placa = ce.F; novo.corrigido = true; }
      if (novo.corrigido) saida[i] = novo;
    }
    return saida.filter((_, i) => !fora.has(i));
  }
  function usarDados(d) {
    dados = d;
    const por = new Map();
    for (const l of comCorrecoes(d.linhas)) {
      if (!(l.hodometro > 0)) continue;
      if (!por.has(l.placa)) por.set(l.placa, []);
      por.get(l.placa).push(l);
    }
    const viradasDe = new Map();
    for (const v of viradas) {
      if (!viradasDe.has(v.placa)) viradasDe.set(v.placa, []);
      viradasDe.get(v.placa).push(v);
    }
    placas = [...por.entries()].map(([placa, ls]) => {
      ls.sort((a, b) => a.dia - b.dia || (a.seg || 0) - (b.seg || 0));
      const vs = viradasDe.get(placa) || [];
      // km "corrido": +1 milhão por virada marcada até a leitura (no próprio dia da virada, só as leituras já baixas)
      const corrido = (l) => l.hodometro + MILHAO * vs.filter((v) => l.dia > v.dia || (l.dia === v.dia && l.hodometro < 500000)).length;
      ls.forEach((l) => { l.kmCorrido = corrido(l); });
      const ult = ls[ls.length - 1];
      const maiorL = ls.reduce((m, l) => (l.kmCorrido > m.kmCorrido ? l : m), ls[0]);
      const v = d.veiculos[placa] || {};
      const trinta = ls.filter((l) => l.dia > ult.dia - 30);
      // queda que parece virada e ainda não foi marcada (a mais recente)
      let candidata = null;
      for (let i = 1; i < ls.length; i++) {
        if (pareceVirada(ls[i - 1].hodometro, ls[i].hodometro) && !vs.some((x) => x.dia === ls[i].dia)) candidata = { antes: ls[i - 1], depois: ls[i] };
      }
      return {
        placa, km: ult.hodometro, dia: ult.dia, seg: ult.seg, leituras: ls,
        maior: maiorL.hodometro, alerta: maiorL.kmCorrido > ult.kmCorrido,   // a última leitura é menor que alguma anterior
        rodado30: trinta.length > 1 ? ult.kmCorrido - trinta[0].kmCorrido : null,
        viradas: vs, candidata,
        modelo: v.modelo || '', unidade: v.unidade || '', categoria: v.categoria || '',
      };
    });
    ctx.definirSub('Último hodômetro informado nos abastecimentos de cada placa. Abastecimentos até ' + fmtDia(d.diaMax) + '.');
  }
  usarDados(dados);

  const estado = { busca: '', unidade: '', categoria: '', ordem: { campo: 'placa', dir: 1 }, limite: POR_PAGINA, aberta: null };

  pagina.innerHTML = `
    <dl class="apoio apoio-pilha" id="km-resumo"></dl>
    <section class="painel painel-tabela">
      <div class="painel-cab"><h2>Quilometragem por placa</h2><span class="conta" id="km-conta"></span></div>

      <div class="tabela-ferramentas">
        <input type="search" id="km-busca" placeholder="Placa ou modelo…" aria-label="Procurar placa ou modelo" autocomplete="off">
        <select id="km-unidade" class="campo-sel" aria-label="Unidade"></select>
        <select id="km-categoria" class="campo-sel" aria-label="Categoria"></select>
        <button type="button" class="btn so-edicao" id="km-exportar"><svg aria-hidden="true"><use href="#i-baixar"/></svg><span class="txt">Baixar</span></button>
      </div>
      <div class="tabela-rolagem"><table class="dados tabela-clicavel km-tabela" id="km-tabela"></table></div>
      <div id="km-mais"></div>
    </section>
    <section class="painel painel-largo oculto" id="km-historico-painel">
      <div class="painel-cab"><h2 id="km-historico-titulo">Leituras</h2>
        <div class="acoes-cab">
          <button type="button" class="btn so-edicao" id="km-exportar-hist"><svg aria-hidden="true"><use href="#i-baixar"/></svg><span class="txt">Baixar leituras</span></button>
          <button type="button" class="btn" id="km-fechar">Fechar</button>
        </div>
      </div>
      <div class="km-virada oculto" id="km-virada" role="status"></div>
      <div class="tabela-rolagem tabela-alta"><table class="dados" id="km-historico"></table></div>
    </section>`;
  const el = (id) => pagina.querySelector('#' + id);

  function preencherSeletores() {
    const opc = (campo, todos) => '<option value="">' + todos + '</option>' +
      [...new Set(placas.map((p) => p[campo]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'))
        .map((v) => '<option' + (v === estado[campo] ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
    el('km-unidade').innerHTML = opc('unidade', 'Todas as unidades');
    el('km-categoria').innerHTML = opc('categoria', 'Todas as categorias');
  }
  preencherSeletores();

  const COLUNAS = [
    // o que se consulta vem logo depois da placa (KM, data e rodado); modelo e unidade por último, numa coluna só
    { id: 'placa', rot: 'Placa', v: (p) => p.placa },
    { id: 'km', rot: 'Km (hodômetro)', n: true, v: (p) => p.km },
    { id: 'dia', rot: 'Data da leitura', n: true, v: (p) => p.dia * 86400 + (p.seg || 0) },
    { id: 'rodado30', rot: 'Rodado em 30 dias', n: true, v: (p) => p.rodado30 },
    { id: 'modelo', rot: 'Modelo · unidade', v: (p) => p.modelo },
  ];
  function visiveis() {
    const t = semAcento(estado.busca.trim());
    const lista = placas.filter((p) => !placaDesabilitada(p.placa) && (!estado.unidade || p.unidade === estado.unidade) && (!estado.categoria || p.categoria === estado.categoria) &&
      (!t || semAcento(p.placa).includes(t) || semAcento(p.modelo).includes(t)));
    const c = COLUNAS.find((x) => x.id === estado.ordem.campo);
    return lista.sort((a, b) => {
      const va = c.v(a), vb = c.v(b);
      if (va === null || va === '') return 1; if (vb === null || vb === '') return -1;
      return estado.ordem.dir * (typeof va === 'string' ? va.localeCompare(vb, 'pt-BR', { numeric: true }) : va - vb);
    });
  }

  function desenhar() {
    const lista = visiveis();
    const recentes = lista.filter((p) => p.dia > dados.diaMax - 30).length;
    el('km-resumo').innerHTML = htmlApoio([
      { rot: 'Placas', val: fmt.int(lista.length) },
      { rot: 'Com leitura nos últimos 30 dias', val: fmt.int(recentes) },
      { rot: 'Sem leitura há mais de 30 dias', val: fmt.int(lista.length - recentes) },
      { rot: 'Leituras para conferir', val: fmt.int(lista.filter((p) => p.alerta).length) },
    ]);
    el('km-conta').textContent = fmt.int(lista.length) + (lista.length === 1 ? ' placa' : ' placas');
    el('km-tabela').innerHTML =
      '<thead><tr>' + COLUNAS.map((col) => {
        const ativa = estado.ordem.campo === col.id;
        return '<th class="' + (col.n ? 'n' : '') + '" aria-sort="' + (ativa ? (estado.ordem.dir < 0 ? 'descending' : 'ascending') : 'none') + '">' +
          '<button type="button" data-col="' + col.id + '">' + esc(col.rot) + (ativa ? '<span class="seta">' + (estado.ordem.dir < 0 ? '▼' : '▲') + '</span>' : '') + '</button></th>';
      }).join('') + '</tr></thead><tbody>' +
      (lista.length ? lista.slice(0, estado.limite).map((p) => {
        const dias = dados.diaMax - p.dia;
        return '<tr class="' + (estado.aberta === p.placa ? 'selecionado' : '') + '" data-placa="' + esc(p.placa) + '">' +
          '<td><button type="button" class="link-botao nome-clicavel" data-placa="' + esc(p.placa) + '">' + esc(p.placa) + '</button></td>' +
          '<td class="n km-km"><strong class="num">' + fmt.int(p.km) + '</strong>' +
            (p.alerta ? '<small class="cidade-linha aviso-linha">menor que a leitura de ' + fmt.int(p.maior) + ' km: conferir' +
              (p.candidata ? ' (o hodômetro pode ter virado 1 milhão; clique na placa)' : '') + '</small>'
              : p.viradas.length ? '<small class="cidade-linha">hodômetro virou 1 milhão em ' + esc(fmtDia(p.viradas[p.viradas.length - 1].dia)) + '</small>' : '') + '</td>' +
          '<td class="n">' + esc(fmtDia(p.dia)) + ' ' + esc(hora(p.seg)) + '<small class="cidade-linha' + (dias > 30 ? ' antigo' : '') + '">' +
            (dias <= 0 ? 'hoje' : dias === 1 ? 'há 1 dia' : 'há ' + dias + ' dias') + '</small></td>' +
          '<td class="n">' + (p.rodado30 === null ? '<span class="sem-dado">—</span>' : fmt.int(p.rodado30) + ' km') + '</td>' +
          '<td class="km-modelo">' + esc(p.modelo || '—') + (p.categoria ? ' <span class="sem-dado">' + esc(p.categoria.toLowerCase()) + '</span>' : '') +
            '<small class="cidade-linha">' + esc(p.unidade || '—') + '</small></td></tr>';
      }).join('') : '<tr><td colspan="' + COLUNAS.length + '"><div class="vazio">Nenhuma placa com esse filtro.</div></td></tr>') + '</tbody>';
    el('km-mais').innerHTML = botoesMaisMenos(lista.length, estado.limite, POR_PAGINA);
  }

  function desenharHistorico() {
    const p = placas.find((x) => x.placa === estado.aberta);
    el('km-historico-painel').classList.toggle('oculto', !p);
    if (!p) return;
    el('km-historico-titulo').textContent = 'Leituras de ' + p.placa + (p.modelo ? ' · ' + p.modelo : '');
    // virada do hodômetro: sugerir a marcação (queda de mais de 900 mil para menos de 200 mil) ou mostrar a já marcada
    const caixa = el('km-virada');
    const partes = p.viradas.map((v) => '<span>Hodômetro virou 1 milhão em <strong>' + esc(fmtDia(v.dia)) + '</strong> (marcado por ' + esc(v.usuario_nome) +
      '): a partir dessa data as leituras contam +1.000.000 km nas comparações.</span>' +
      '<button type="button" class="btn" data-desfazer-virada="' + v.dia + '">Desfazer</button>');
    if (p.candidata) {
      const c = p.candidata;
      partes.unshift('<span>Em <strong>' + esc(fmtDia(c.depois.dia)) + '</strong> o hodômetro foi de ' + fmt.int(c.antes.hodometro) + ' para ' + fmt.int(c.depois.hodometro) +
        ' km. Se ele passou de 999.999 e voltou a zero, marque a virada: o aviso some e as leituras seguintes contam +1.000.000 km.</span>' +
        '<button type="button" class="btn btn-principal" data-virada="' + c.depois.dia + '">O hodômetro virou 1 milhão</button>');
    }
    caixa.innerHTML = partes.map((h) => '<div class="km-virada-linha">' + h + '</div>').join('') + '<p class="erro-form oculto" id="km-virada-erro" role="alert"></p>';
    caixa.classList.toggle('oculto', !partes.length);
    const ls = [...p.leituras].reverse();
    el('km-historico').innerHTML =
      '<thead><tr><th><span>Data</span></th><th class="n"><span>Km (hodômetro)</span></th><th class="n"><span>Desde a anterior</span></th>' +
      '<th><span>Posto</span></th><th><span>Motorista</span></th></tr></thead><tbody>' +
      ls.map((l, i) => {
        const ant = ls[i + 1];
        const dif = ant ? l.kmCorrido - ant.kmCorrido : null;   // com a virada marcada, a diferença passa pelo milhão
        const virou = ant && l.kmCorrido - l.hodometro > ant.kmCorrido - ant.hodometro;
        return '<tr><td>' + esc(fmtDia(l.dia) + ' ' + hora(l.seg)) + (l.tempoReal ? '<span class="selo-tempo-real" title="Veio da API do cartão hoje; entra nos abastecimentos no dia seguinte (D-1)">API</span>' : '') + '</td><td class="n"><strong class="num">' + fmt.int(l.hodometro) + '</strong>' +
          (l.corrigido ? '<small class="cidade-linha" title="Corrigido no Editar abastecimentos">corrigido</small>' : '') +
          (virou ? '<small class="cidade-linha">virou 1 milhão</small>' : '') + '</td>' +
          '<td class="n">' + (dif === null ? '<span class="sem-dado">—</span>' : dif < 0 ? '<span class="var-alerta">' + fmt.int(dif) + ' km</span>' : '+' + fmt.int(dif) + ' km') + '</td>' +
          '<td class="trunc">' + esc(l.fornecedor) + '</td><td class="trunc">' + esc(l.motorista) + '</td></tr>';
      }).join('') + '</tbody>';
  }
  el('km-virada').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-virada], [data-desfazer-virada]');
    if (!b) return;
    const desfazer = b.hasAttribute('data-desfazer-virada');
    const dia = Number(desfazer ? b.dataset.desfazerVirada : b.dataset.virada);
    if (desfazer && !await confirmar('Desfazer a virada do hodômetro de ' + estado.aberta + '? O aviso de leitura menor volta a aparecer.')) return;
    b.disabled = true;
    try {
      const r = await fetch('/api/km-viradas', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placa: estado.aberta, dia, desfazer }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { location.href = '/?entrar=1'; return; }
      if (!r.ok) throw new Error(j.erro || 'Não foi possível salvar (' + r.status + ').');
      viradas = j.viradas;
      usarDados(dados);
      desenhar(); desenharHistorico();
    } catch (err) {
      b.disabled = false;
      const m = el('km-virada-erro');
      if (m) { m.textContent = err.message; m.classList.remove('oculto'); }
    }
  });

  el('km-tabela').addEventListener('click', (e) => {
    const b = e.target.closest('[data-col]');
    if (b) {
      const col = COLUNAS.find((x) => x.id === b.dataset.col);
      estado.ordem = estado.ordem.campo === col.id ? { campo: col.id, dir: -estado.ordem.dir } : { campo: col.id, dir: col.n ? -1 : 1 };
      desenhar();
      const n = el('km-tabela').querySelector('[data-col="' + col.id + '"]');
      if (n) n.focus();
      return;
    }
    const linha = e.target.closest('tr[data-placa]');
    if (!linha) return;
    estado.aberta = estado.aberta === linha.dataset.placa ? null : linha.dataset.placa;
    desenhar(); desenharHistorico();
    if (estado.aberta) el('km-historico-painel').scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  el('km-fechar').addEventListener('click', () => { estado.aberta = null; desenhar(); desenharHistorico(); });
  el('km-mais').addEventListener('click', (e) => {
    if (e.target.closest('[data-mais]')) { estado.limite += POR_PAGINA; desenhar(); return; }
    if (e.target.closest('[data-menos]')) { estado.limite = POR_PAGINA; desenhar(); el('km-tabela').scrollIntoView({ block: 'nearest' }); }
  });
  let tBusca = null;
  el('km-busca').addEventListener('input', (e) => { clearTimeout(tBusca); tBusca = setTimeout(() => { estado.busca = e.target.value; estado.limite = POR_PAGINA; desenhar(); }, 150); });
  el('km-unidade').addEventListener('change', (e) => { estado.unidade = e.target.value; estado.limite = POR_PAGINA; desenhar(); });
  el('km-categoria').addEventListener('change', (e) => { estado.categoria = e.target.value; estado.limite = POR_PAGINA; desenhar(); });

  // baixar (CSV ou XLSX)
  ligarBaixar(el('km-exportar'), () => ({
    nome: 'km-por-placa-' + diaIso(dados.diaMax), aba: 'Km por placa',
    colunas: [{ titulo: 'Placa', largura: 10 }, { titulo: 'Modelo', largura: 24 }, { titulo: 'Unidade', largura: 20 }, { titulo: 'Categoria', largura: 16 },
      { titulo: 'Km (hodômetro)', tipo: 'numero', casas: 0, largura: 15 }, { titulo: 'Data da leitura', largura: 17 }, { titulo: 'Rodado em 30 dias', tipo: 'numero', casas: 0, largura: 17 }, { titulo: 'Conferir', largura: 10 }],
    linhas: visiveis().map((p) => [p.placa, p.modelo, p.unidade, p.categoria, p.km, fmtDia(p.dia) + ' ' + hora(p.seg), p.rodado30 ?? null, p.alerta ? 'Sim' : '']),
  }));
  ligarBaixar(el('km-exportar-hist'), () => {
    const p = placas.find((x) => x.placa === estado.aberta);
    return {
      nome: 'leituras-' + (p ? p.placa : ''), aba: 'Leituras',
      colunas: [{ titulo: 'Placa', largura: 10 }, { titulo: 'Data', largura: 17 }, { titulo: 'Km (hodômetro)', tipo: 'numero', casas: 0, largura: 15 }, { titulo: 'Posto', largura: 32 }, { titulo: 'Motorista', largura: 30 }],
      linhas: p ? [...p.leituras].reverse().map((l) => [p.placa, fmtDia(l.dia) + ' ' + hora(l.seg), l.hodometro, l.fornecedor, l.motorista]) : [],
    };
  });

  desenhar();
  const aoAtualizarDados = () => Promise.all([carregarDados({ tempoReal: true }), buscarCorrecoes()])
    .then(([d, c]) => { correcoes = c; usarDados(d); preencherSeletores(); desenhar(); desenharHistorico(); });
  window.addEventListener('dados-atualizados', aoAtualizarDados);
  return { desmontar() { window.removeEventListener('dados-atualizados', aoAtualizarDados); } };
}
