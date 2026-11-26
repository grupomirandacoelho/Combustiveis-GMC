// "Rodada de preços": a atualização semanal do valor negociado de cada posto da lista dos motoristas.
// Mesma rotina feita antes fora do portal: para cada posto, a última transação de diesel depois da que foi usada
// na negociação anterior dá o preço novo. Variação acima do limite da planilha (U1, 10%) precisa ser confirmada.
// O portal registra; o vigia grava as linhas na aba "Base de dados de negociações" (contato "ATUALIZAÇÃO
// AUTOMÁTICA (BASE DE TRANSAÇÕES)", K = data e hora da transação, Q = variação).
import { carregarDados, esc, fmt, fmtDia, isoParaDia, chaveNome, momento, momentoIso, ehDiesel } from '../lib/dados.js';
import { htmlApoio, botoesMaisMenos } from '../lib/filtros.js';

const DIESEL = { has: ehDiesel };   // todo tipo de diesel (lib/dados.js)
const DATA_CORTE = isoParaDia('2026-09-15');   // mesma regra da lista dos motoristas (scripts/planilha_negociacao.py)
// bombas internas ficam fora da rodada (13/11/2026): o preço delas não vem da última transação e, sem o rateio pronto,
// sairia errado. Mesma lista em functions/api/postos/rodada.js
const FORA_DA_RODADA = new Set(['POSTO INT RAJA BELEM', 'POSTO INT RAJA JEQUIE', 'POSTO INT RAJA SALVADOR', 'POSTO INT RAJA SAO PAULO',
  'CAANA', 'CALAN', 'CABET', 'CAAPE']);
const emAberto = (a) => a.estado === 'pendente' || a.estado === 'aguardando';
const hora = (seg) => (seg === null || seg === undefined ? '' : String(Math.floor(seg / 3600)).padStart(2, '0') + ':' + String(Math.floor(seg / 60) % 60).padStart(2, '0'));
// valor no campo: pelo menos 2 casas (7,40) e até 4 quando a transação tem (6,0909)
const fValor = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4, useGrouping: false });
const numero = (s) => { const v = Number(String(s).replace(/\s/g, '').replace(',', '.')); return isFinite(v) && v > 0 ? v : null; };

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Montando a rodada…</div>';
  let dados, alteracoes = [], opcoes = null;
  async function carregar() {
    const [d, r] = await Promise.all([
      carregarDados(),
      fetch('/api/postos/alteracoes', { credentials: 'same-origin', cache: 'no-store' }),
    ]);
    if (r.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
    if (!r.ok) throw new Error('Não foi possível ler as alterações pendentes. Recarregue a página.');
    const j = await r.json();
    dados = d; alteracoes = j.alteracoes; opcoes = j.opcoes;
  }
  try { await carregar(); } catch (e) {
    pagina.innerHTML = '<div class="vazio">' + esc(e.message) + '</div>';
    return {};
  }
  if (!dados.negPostos.length) {
    pagina.innerHTML = '<div class="vazio">A planilha de negociações ainda não chegou ao site. Ela vai junto com a próxima sincronização da Base.</div>';
    return {};
  }

  const estado = { unidade: '', busca: '', ver: 'novas', enviados: new Set() };
  let linhas = [];            // uma por posto da lista
  const valores = new Map();  // chave -> valor digitado
  const marcados = new Map(); // chave -> escolha da pessoa

  function montarRodada() {
    const lim = dados.limitesNeg;
    // última negociação de cada (unidade, posto) desde a data de corte = lista dos motoristas
    const ult = new Map();
    for (const n of dados.negPostos) {
      const k = chaveNome(n.unidade) + '|' + chaveNome(n.posto);
      const a = ult.get(k);
      if (!a || n.dia > a.dia || (n.dia === a.dia && n.ordem > a.ordem)) ult.set(k, n);
    }
    // transações de diesel por posto (o nome do posto na planilha é o do estabelecimento nas transações)
    const porPosto = new Map();
    for (const l of dados.linhas) {
      if (!DIESEL.has(l.combustivel) || !(l.vlLitro > 0)) continue;
      const k = chaveNome(l.fornecedor);
      let a = porPosto.get(k);
      if (!a) porPosto.set(k, (a = []));
      a.push(l);
    }
    const pendentes = new Set(alteracoes.filter(emAberto).map((a) => chaveNome(a.dados.unidade) + '|' + chaveNome(a.dados.posto)));
    const validas = (n) => opcoes.plataformas.includes(n.plataforma) && opcoes.status.includes(n.status) && opcoes.tipos.includes(n.tipo || '');

    linhas = [];
    for (const [k, n] of ult) {
      if (n.dia < DATA_CORTE || FORA_DA_RODADA.has(chaveNome(n.posto))) continue;
      const desde = n.transDia !== null ? momento(n.transDia, n.transSeg) : -Infinity;
      const txs = porPosto.get(chaveNome(n.posto)) || [];
      let nova = null, ultimaQualquer = null;
      for (const t of txs) {
        const m = momento(t.dia, t.seg);
        if (!ultimaQualquer || m > momento(ultimaQualquer.dia, ultimaQualquer.seg)) ultimaQualquer = t;
        if (m <= desde) continue;
        // o preço negociado é do combustível da negociação (S-10 comum); outro diesel só se não houver dele
        const mesmo = t.combustivel === n.combustivel;
        if (!nova) { nova = t; continue; }
        const novaMesmo = nova.combustivel === n.combustivel;
        if ((mesmo && !novaMesmo) || (mesmo === novaMesmo && m > momento(nova.dia, nova.seg))) nova = t;
      }
      const valor = valores.has(k) ? valores.get(k) : nova ? Math.round(nova.vlLitro * 10000) / 10000 : null;
      const variacao = nova && n.valor && valor ? valor / n.valor - 1 : null;
      const alerta = variacao !== null && Math.abs(variacao) > lim.variacao;
      let bloqueio = null;
      if (estado.enviados.has(k)) bloqueio = 'Enviado nesta rodada';
      else if (pendentes.has(k)) bloqueio = 'Há uma alteração deste posto ainda não gravada';
      else if (!validas(n)) bloqueio = 'Cartão, tipo ou situação fora das opções da planilha: corrija em Postos dos motoristas';
      const padrao = !!nova && !alerta && !bloqueio && n.status !== 'POSTO BLOQUEADO';
      linhas.push({
        k, n, nova, ultimaQualquer, valor, variacao, alerta, bloqueio,
        marcado: !bloqueio && !!nova && (marcados.has(k) ? marcados.get(k) : padrao),
        diasNeg: dados.diaMax - n.dia,
      });
    }
    linhas.sort((a, b) => a.n.unidade.localeCompare(b.n.unidade, 'pt-BR') || a.n.posto.localeCompare(b.n.posto, 'pt-BR'));
  }

  ctx.definirSub('Atualiza o valor negociado de cada posto pelo preço da última transação. Nada é gravado até você enviar.');
  pagina.innerHTML = `
    <dl class="apoio apoio-pilha" id="rp-resumo"></dl>
    <div class="aviso-pendencias oculto" id="rp-aviso" role="status"></div>
    <section class="painel painel-tabela">
      <div class="painel-cab">
        <h2>Postos da lista</h2>
        <div class="acoes-cab">
          <button type="button" class="btn btn-principal" id="rp-enviar"><svg aria-hidden="true"><use href="#i-atualizar"/></svg><span class="txt">Gravar rodada</span></button>
        </div>
      </div>
      <span class="oculto" id="rp-regra"></span>
      <div class="tabela-ferramentas">
        <input type="search" id="rp-busca" placeholder="Posto ou cidade…" aria-label="Procurar posto ou cidade" autocomplete="off">
        <select id="rp-unidade" class="campo-sel" aria-label="Unidade"></select>
        <div class="segmentado" role="group" aria-label="Mostrar">
          <button type="button" data-ver="novas" aria-pressed="true">Com transação nova</button>
          <button type="button" data-ver="sem" aria-pressed="false">Sem transação nova</button>
          <button type="button" data-ver="todos" aria-pressed="false">Todos</button>
        </div>
        <span class="conta" id="rp-conta"></span>
      </div>
      <div class="tabela-rolagem"><table class="dados tabela-rodada" id="rp-tabela"></table></div>
      <div id="rp-mais"></div>
    </section>`;
  // 50 postos por vez ("Mostrar mais"); as marcações e os valores ficam guardados (marcados/valores), não na tabela
  const PASSO = 50;
  let limite = PASSO;
  const $ = (id) => pagina.querySelector('#' + id);
  const visivel = (l) => {
    const t = chaveNome(estado.busca);
    return (!estado.unidade || l.n.unidade === estado.unidade) &&
      (estado.ver === 'todos' || (estado.ver === 'novas') === !!l.nova) &&
      (!t || chaveNome(l.n.posto).includes(t) || chaveNome(l.n.cidade).includes(t));
  };
  const htmlVariacao = (l) => (l.variacao === null ? '<span class="sem-dado">—</span>'
    : '<span class="' + (l.alerta ? 'var-alerta' : 'num') + '">' + (l.variacao > 0 ? '+' : '') + esc(fmt.pct(l.variacao)) + '</span>' +
      (l.alerta ? '<small class="cidade-linha">marque para confirmar</small>' : ''));

  function desenhar() {
    const lim = dados.limitesNeg;
    const limTxt = fmt.pct(lim.variacao).replace(',0', '');
    $('rp-regra').title = 'Para cada posto, vale a última transação de diesel feita depois da transação usada na negociação anterior ' +
      '(de preferência do mesmo combustível). Variação acima de ' + limTxt + ' só entra se você marcar o posto, confirmando o preço.';
    ctx.definirSub('Dados da Base até ' + fmtDia(dados.diaMax) + '.');
    const novas = linhas.filter((l) => l.nova);
    const marc = linhas.filter((l) => l.marcado);
    $('rp-resumo').innerHTML = htmlApoio([
      { rot: 'Postos na lista', val: fmt.int(linhas.length) },
      { rot: 'Com transação nova', val: fmt.int(novas.length) },
      { rot: 'Variação acima de ' + limTxt, val: fmt.int(novas.filter((l) => l.alerta).length) },
      { rot: 'Sem transação nova', val: fmt.int(linhas.length - novas.length) },
      { rot: 'Marcados para gravar', val: fmt.int(marc.length) },
    ]);
    $('rp-enviar').disabled = !marc.length;
    $('rp-enviar').querySelector('.txt').textContent = marc.length ? 'Gravar rodada (' + marc.length + (marc.length === 1 ? ' posto)' : ' postos)') : 'Gravar rodada';

    const unidades = [...new Set(linhas.map((l) => l.n.unidade))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    $('rp-unidade').innerHTML = '<option value="">Todas as unidades</option>' +
      unidades.map((u) => '<option' + (u === estado.unidade ? ' selected' : '') + '>' + esc(u) + '</option>').join('');

    const vis = linhas.filter(visivel);
    $('rp-conta').textContent = vis.length + (vis.length === 1 ? ' posto' : ' postos');
    const marcaveis = vis.filter((l) => l.nova && !l.bloqueio);
    const tudo = marcaveis.length && marcaveis.every((l) => l.marcado);
    $('rp-tabela').innerHTML =
      '<thead><tr><th class="col-marca"><span><input type="checkbox" id="rp-todos" aria-label="Marcar todos os visíveis com transação nova"' +
        (tudo ? ' checked' : '') + (marcaveis.length ? '' : ' disabled') + '></span></th>' +
      '<th><span>Posto</span></th><th class="n"><span>Negociado hoje</span></th><th><span>Transação usada</span></th>' +
      '<th class="n"><span>Valor novo (R$/L)</span></th><th class="n"><span>Variação</span></th></tr></thead><tbody>' +
      (vis.length ? vis.slice(0, limite).map((l) => {
        const n = l.n, tx = l.nova;
        const id = 'rp-m-' + linhas.indexOf(l);
        const neg = '<span class="num">' + esc(fmt.moeda(n.valor)) + '</span><small class="cidade-linha">em ' + esc(fmtDia(n.dia)) +
          (l.diasNeg > lim.diasSemAtualizacao ? ' <b class="antigo">(' + l.diasNeg + ' dias)</b>' : '') + '</small>';
        const trans = tx
          ? '<span class="num">' + esc(fmtDia(tx.dia) + ' ' + hora(tx.seg)) + '</span><small class="cidade-linha">' +
            esc(tx.combustivel.toLowerCase() + ', ' + fmt.d2(tx.litros) + ' L, placa ' + tx.placa) + '</small>'
          : '<span class="sem-dado">Nenhuma desde ' + (n.transDia !== null ? esc(fmtDia(n.transDia)) : 'a negociação') + '</span>' +
            (l.ultimaQualquer ? '' : '<small class="cidade-linha">o nome do posto não aparece nas transações</small>');
        return '<tr class="' + (l.marcado ? 'selecionado' : '') + (l.bloqueio ? ' linha-apagada' : '') + '">' +
          '<td class="col-marca">' + (tx && !l.bloqueio
            ? '<input type="checkbox" id="' + id + '" data-k="' + esc(l.k) + '"' + (l.marcado ? ' checked' : '') + ' aria-label="Incluir ' + esc(n.posto) + ' na rodada">'
            : '') + '</td>' +
          '<td class="trunc"><label for="' + id + '"><strong>' + esc(n.posto) + '</strong></label><small class="cidade-linha">' +
            esc(n.unidade + ' · ' + n.cidade + (n.status === 'POSTO BLOQUEADO' ? ' · bloqueado' : '')) + '</small>' +
            (l.bloqueio ? '<small class="cidade-linha aviso-linha">' + esc(l.bloqueio) + '</small>' : '') + '</td>' +
          '<td class="n">' + neg + '</td><td>' + trans + '</td>' +
          '<td class="n">' + (tx && !l.bloqueio
            ? '<input class="campo-tabela" inputmode="numeric" data-moeda="2" autocomplete="off" data-valor="' + esc(l.k) + '" value="' + esc(fValor.format(l.valor)) + '" aria-label="Valor novo de ' + esc(n.posto) + '">'
            : '<span class="sem-dado">—</span>') + '</td>' +
          '<td class="n">' + htmlVariacao(l) + '</td></tr>';
      }).join('') : '<tr><td colspan="6"><div class="vazio">' + (estado.ver === 'novas'
        ? 'Nenhum posto com transação nova desde a última rodada. Quando a Base trouxer abastecimentos novos, eles aparecem aqui.'
        : 'Nenhum posto com esses filtros.') + '</div></td></tr>') + '</tbody>';
    $('rp-mais').innerHTML = botoesMaisMenos(vis.length, limite, PASSO);
  }

  function refazer() { montarRodada(); desenhar(); }
  refazer();

  $('rp-tabela').addEventListener('change', (e) => {
    if (e.target.id === 'rp-todos') {
      linhas.filter((l) => l.nova && !l.bloqueio && visivel(l)).forEach((l) => marcados.set(l.k, e.target.checked));
      refazer();
      $('rp-todos').focus();
      return;
    }
    const k = e.target.dataset.k;
    if (k) {
      marcados.set(k, e.target.checked);
      refazer();
      const b = [...$('rp-tabela').querySelectorAll('input[data-k]')].find((x) => x.dataset.k === k);
      if (b) b.focus();
    }
  });
  $('rp-tabela').addEventListener('input', (e) => {
    const k = e.target.dataset.valor;
    if (!k) return;
    const v = numero(e.target.value);
    const ruim = v === null || v >= 50;
    e.target.classList.toggle('invalido', ruim);
    e.target.setAttribute('aria-invalid', String(ruim));
    if (ruim) return;
    valores.set(k, v);
    // recalcula a variação sem redesenhar a tabela (o cursor continua no campo)
    const l = linhas.find((x) => x.k === k);
    l.valor = v;
    l.variacao = l.n.valor ? v / l.n.valor - 1 : null;
    l.alerta = l.variacao !== null && Math.abs(l.variacao) > dados.limitesNeg.variacao;
    e.target.closest('tr').lastElementChild.innerHTML = htmlVariacao(l);
  });
  $('rp-tabela').addEventListener('focusout', (e) => { if (e.target.dataset.valor) refazer(); });
  $('rp-busca').addEventListener('input', (e) => { estado.busca = e.target.value; limite = PASSO; desenhar(); });
  $('rp-unidade').addEventListener('change', (e) => { estado.unidade = e.target.value; limite = PASSO; desenhar(); });
  $('rp-mais').addEventListener('click', (e) => {
    if (e.target.closest('[data-mais]')) { limite += PASSO; desenhar(); }
    else if (e.target.closest('[data-menos]')) { limite = PASSO; desenhar(); $('rp-tabela').scrollIntoView({ block: 'start' }); }
  });
  pagina.querySelector('.segmentado').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ver]');
    if (!b) return;
    estado.ver = b.dataset.ver;
    limite = PASSO;
    pagina.querySelectorAll('[data-ver]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    desenhar();
  });

  function aviso(html, erro) {
    const a = $('rp-aviso');
    a.innerHTML = html;
    a.classList.toggle('oculto', !html);
    a.classList.toggle('aviso-erro', !!erro);
  }
  const pend = alteracoes.filter(emAberto).length;
  if (pend) aviso('<span>' + pend + (pend === 1 ? ' alteração de posto ainda não foi gravada' : ' alterações de posto ainda não foram gravadas') +
    ' na planilha. Os postos envolvidos ficam de fora desta rodada.</span>');

  $('rp-enviar').addEventListener('click', async () => {
    const marc = linhas.filter((l) => l.marcado);
    if (!marc.length) return;
    const btn = $('rp-enviar');
    btn.disabled = true;
    btn.querySelector('.txt').textContent = 'Enviando…';
    try {
      const r = await fetch('/api/postos/rodada', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          limitePct: dados.limitesNeg.variacao * 100,
          itens: marc.map((l) => ({
            unidade: l.n.unidade, posto: l.n.posto, cidade: l.n.cidade, tipo: l.n.tipo, plataforma: l.n.plataforma,
            valor: l.valor, combustivel: l.n.combustivel, status: l.n.status, aviso: l.n.aviso,
            transacao: momentoIso(l.nova.dia, l.nova.seg),
            variacao: l.variacao === null ? null : Math.round(l.variacao * 1e6) / 1e6,
            confirmado: l.alerta,
          })),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { location.href = '/?entrar=1'; return; }
      if (!r.ok) { aviso('<span>' + esc(j.erro || 'Não foi possível enviar a rodada. Tente de novo.') + '</span>', true); return; }
      marc.forEach((l) => estado.enviados.add(l.k));
      aviso('<span>' + j.postos + (j.postos === 1 ? ' posto enviado' : ' postos enviados') + '. O computador da sincronização grava as linhas na planilha ' +
        'de negociações em instantes (se ela estiver aberta no Excel, espera fechar). Acompanhe em ' +
        '<a href="#/postos-motoristas">Postos dos motoristas</a>.</span>');
    } catch (e) {
      aviso('<span>Sem conexão com o servidor. Verifique a internet e tente de novo.</span>', true);
    } finally {
      refazer();
    }
  });

  // dados novos (Base ou planilha de negociações sincronizada): refaz a rodada com as transações novas
  const aoAtualizar = () => carregar().then(() => { estado.enviados.clear(); refazer(); }).catch(() => {});
  window.addEventListener('dados-atualizados', aoAtualizar);
  return { desmontar() { window.removeEventListener('dados-atualizados', aoAtualizar); } };
}
