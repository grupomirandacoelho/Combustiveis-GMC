// Dashboard "Preço postos externos" — o preço pago nos postos de combustível contra o preço negociado:
//  - transações de diesel em postos externos: tudo menos ESTABELECIMENTO INTERNO e CAIS VIBRA (a bomba interna tem o
//    seu próprio painel; há transações com o tipo em branco na Base e elas contam como posto)
//  - os postos autorizados da lista dos motoristas aparecem na tabela mesmo sem abastecimento no período
//  - cada abastecimento é comparado com a negociação que valia no dia (planilha "Gestão de negociações de preço");
//    o posto da planilha é ligado ao estabelecimento das transações pelo nome
//  - Pago acima do negociado = soma de (preço pago − negociado) × litros, só quando pagou mais
//  - Situação da negociação: mesmas fórmulas da planilha (dias entre a negociação e a transação usada para o preço;
//    acima de S1 = desatualizada, acima de W1 = renegociação obrigatória)
//  - posto bloqueado (13/11/2026): o preço da última linha é o de quando foi bloqueado (ex.: AUTO POSTO BATISTELLA,
//    R$ 5,84 em 20/08/2025) e não entra na rodada; abastecimento com a negociação do dia bloqueada não é comparado
//    (não conta em "pago acima"), aparece como "abastecido em posto bloqueado"
import { carregarDados, fmt, esc, fmtDia, fmtMes, mesDoDia, chaveNome, ehDiesel } from '../lib/dados.js';
import { criarFiltros, htmlBomba, htmlApoio, agendador, botoesMaisMenos, statusHtml } from '../lib/filtros.js';
import { graficoPeriodo, emAndamento } from '../lib/graficos.js';
import { carregarOpcoes as carregarOpcoesCadastro, listaEfetiva, temConfig, BOTAO_OPCOES, abrirOpcoes } from '../lib/opcoes.js';

const DIESEL = { has: ehDiesel };   // todo tipo de diesel (lib/dados.js)
const TOLERANCIA = 0.005;   // R$/L: diferença de arredondamento não conta como "pagou acima"
const POR_PAGINA = 25;
const DIAS_GRAFICO_DIARIO = 100;   // até ~3 meses de dados, o gráfico mostra dia a dia
const ROTA = '#/preco-postos';

const DIMENSOES = [
  { id: 'periodo', rotulo: 'Período', periodo: true },
  { id: 'unidade', rotulo: 'Unidade', valor: (t) => t.unidade },
  { id: 'posto', rotulo: 'Posto', valor: (t) => t.posto },
  { id: 'cidade', rotulo: 'Cidade', valor: (t) => t.cidade },
  { id: 'cartao', rotulo: 'Cartão', valor: (t) => t.cartao },
  { id: 'combustivel', rotulo: 'Combustível', valor: (t) => t.combustivel },
  { id: 'negociacao', rotulo: 'Negociação', valor: (t) => (t.bloqueado ? 'Posto bloqueado' : t.negociado !== null ? 'Com preço negociado' : 'Sem negociação') },
];
const bloqueada = (n) => !!n && /BLOQUE/.test(n.status || '');

function situacaoNeg(n, lim) {
  if (!n || n.transDia === null) return { txt: 'Sem transação de referência', nivel: 0 };
  const dias = n.dia - n.transDia;
  if (dias > lim.diasRenegociacao) return { txt: 'Renegociação obrigatória', nivel: 2, dias };
  if (dias > lim.diasSemAtualizacao) return { txt: 'Desatualizada', nivel: 1, dias };
  return { txt: 'Atualizada', nivel: 0, dias };
}

function somar(ts) {
  const a = { despesa: 0, litros: 0, qtd: ts.length, litrosNeg: 0, pagoNeg: 0, negPond: 0, acima: 0, qtdAcima: 0, qtdNeg: 0 };
  for (const t of ts) {
    a.despesa += t.despesa; a.litros += t.litros;
    if (t.negociado !== null) {
      a.qtdNeg++;
      a.litrosNeg += t.litros;
      a.pagoNeg += t.vlLitro * t.litros;
      a.negPond += t.negociado * t.litros;
      const dif = t.vlLitro - t.negociado;
      if (dif > TOLERANCIA) { a.acima += dif * t.litros; a.qtdAcima++; }
    }
  }
  a.preco = a.litros ? a.despesa / a.litros : null;
  a.precoNeg = a.litrosNeg ? a.negPond / a.litrosNeg : null;
  a.pagoMedioNeg = a.litrosNeg ? a.pagoNeg / a.litrosNeg : null;
  a.dif = a.litrosNeg ? (a.pagoNeg - a.negPond) / a.litrosNeg : null;
  return a;
}

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando os abastecimentos…</div>';
  let dados;
  try { dados = await carregarDados(); } catch (e) {
    pagina.innerHTML = '<div class="vazio">' + esc(e.message) + ' Recarregue a página para tentar de novo.</div>';
    return {};
  }

  let base = [], negPorPosto = new Map();
  let internos = new Set();   // bombas internas e cais (ex.: POSTO INT RAJA BELEM): ficam fora mesmo estando na lista dos motoristas
  function usarDados(d) {
    dados = d;
    // negociações de cada posto em ordem de data (e de gravação, no mesmo dia)
    negPorPosto = new Map();
    for (const n of d.negPostos) {
      const k = chaveNome(n.posto);
      if (!negPorPosto.has(k)) negPorPosto.set(k, []);
      negPorPosto.get(k).push(n);
    }
    negPorPosto.forEach((l) => l.sort((a, b) => a.dia - b.dia || a.ordem - b.ordem));
    base = [];
    internos = new Set();
    const externos = new Set();   // já teve abastecimento como posto externo (ex.: BRITTS POSTO tem dos dois tipos)
    for (const l of d.linhas) {
      // posto externo: tudo menos a bomba interna e o cais (há abastecimentos com o tipo em branco na Base,
      // ex.: POSTO SANTA TERESA D'AVILA | REDE Z+Z, que antes ficavam de fora)
      if (l.tipoEstab === 'ESTABELECIMENTO INTERNO' || l.tipoEstab === 'CAIS VIBRA') { internos.add(chaveNome(l.fornecedor)); continue; }
      externos.add(chaveNome(l.fornecedor));
      if (!DIESEL.has(l.combustivel) || !(l.vlLitro > 0)) continue;
      const k = chaveNome(l.fornecedor);
      const negs = negPorPosto.get(k);
      let vigente = null;
      if (negs) for (const n of negs) { if (n.dia > l.dia) break; if (n.valor || bloqueada(n)) vigente = n; }
      const ultima = negs ? negs[negs.length - 1] : null;
      base.push({
        dia: l.dia, seg: l.seg, k, posto: l.fornecedor, cidade: l.cidade, combustivel: l.combustivel, placa: l.placa,
        litros: l.litros, despesa: l.despesa, vlLitro: l.vlLitro,
        negociado: vigente && !bloqueada(vigente) ? vigente.valor : null, bloqueado: bloqueada(vigente),
        unidade: ultima ? ultima.unidade : '(sem negociação)',
        cartao: ultima ? ultima.plataforma : '(sem negociação)',
      });
    }
    externos.forEach((k) => internos.delete(k));   // interno é só quem nunca abasteceu como posto externo
    const g = new Date(d.geradoEm);
    ctx.definirSub('Dados atualizados em ' + g.toLocaleDateString('pt-BR') + ' às ' +
      g.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '. Diesel em postos externos contra o preço negociado.');
  }
  usarDados(dados);
  // postos autorizados na lista dos motoristas (/postos.csv, publicada logo depois de gravar na planilha): entram na
  // tabela mesmo sem abastecimento no recorte (ex.: posto recém-negociado, que ainda não teve transação)
  let autorizadosLista = [];
  async function carregarLista() {
    try {
      const r = await fetch('/postos.csv', { cache: 'no-cache' });
      if (!r.ok) return;
      let txt = await r.text();
      if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
      const ls = txt.replace(/\r/g, '').split('\n').filter((l) => l.trim());
      const cab = ls[0].split(';').map((h) => h.trim());
      autorizadosLista = ls.slice(1).map((l) => {
        const c = l.split(';'), o = {};
        cab.forEach((h, i) => { o[h] = (c[i] || '').trim(); });
        return o;
      }).filter((o) => o.Posto && (o.Status || '').toUpperCase().includes('AUTORIZ'));
    } catch {}
  }
  if (!location.hash.includes('?')) history.replaceState(null, '', ROTA + '?periodo=3meses');

  let filtradas = base;
  let ordem = { campo: 'acima', dir: -1 };
  let busca = '';
  let limite = POR_PAGINA;

  pagina.innerHTML = `
    <section class="filtros" id="pp-filtros" aria-label="Filtros"></section>
    <div class="chips" id="pp-chips" aria-live="polite"></div>
    <div class="abertura">
      <section class="bomba" aria-labelledby="pp-bomba-titulo">
        <h2 class="bomba-titulo" id="pp-bomba-titulo">Abastecido em postos externos</h2>
        <dl class="bomba-registros" id="pp-bomba"></dl>
      </section>
      <dl class="apoio apoio-coluna" id="pp-resumo"></dl>
    </div>
    <dl class="apoio" id="pp-apoio"></dl>
    <section class="painel painel-largo">
      <div class="painel-cab">
        <h2 id="pp-grafico-titulo">Preço pago e preço negociado, mês a mês</h2>
        <div class="legenda"><span><i class="leg-media"></i>Pago (R$/L)</span><span><i class="leg-meta leg-tracejada"></i>Negociado (R$/L)</span></div>
      </div>
      <p class="nota">Cada abastecimento comparado com o negociado que valia no dia.</p>
      <div class="grafico" id="pp-grafico"></div>
    </section>
    <section class="painel painel-largo oculto" id="pp-historico-painel">
      <div class="painel-cab"><h2 id="pp-historico-titulo">Histórico de negociações</h2></div>
      <div class="tabela-rolagem tabela-historico"><table class="dados" id="pp-historico"></table></div>
    </section>
    <section class="painel painel-tabela">
      <div class="painel-cab"><h2>Preço por posto</h2><span class="conta" id="pp-conta"></span></div>

      <div class="tabela-ferramentas">
        <input type="search" id="pp-busca" placeholder="Posto ou cidade…" aria-label="Procurar posto" autocomplete="off">
      </div>
      <div class="tabela-rolagem"><table class="dados tabela-clicavel" id="pp-tabela"></table></div>
      <div id="pp-mais"></div>
    </section>
    <dialog class="dialogo" id="pp-dialogo" aria-labelledby="pp-dlg-titulo">
      <form id="pp-form" novalidate>
        <h2 id="pp-dlg-titulo">Atualizar preço</h2>
        <p class="dialogo-explica" id="pp-dlg-explica"></p>
        <p class="erro-form oculto" id="pp-erro" role="alert"></p>
        <dl class="rot-veiculo" id="pp-dlg-atual"></dl>
        <div class="grade-form">
          <label class="campo-form"><span>Preço novo (R$/L)</span><input name="valor" inputmode="numeric" data-moeda="2" autocomplete="off" required placeholder="0,00"></label>
          <label class="campo-form"><span>Variação</span><input name="variacao" readonly tabindex="-1"></label>
          <label class="campo-form largo"><span>Aviso para o motorista</span><input name="aviso" autocomplete="off" list="pp-sug-avisos"></label>
        </div>
        <datalist id="pp-sug-avisos"></datalist>
        <fieldset class="perm-bloco oculto" id="pp-unidades"><legend>Atualizar nas unidades</legend><div></div></fieldset>
        <p class="nota">Vira uma negociação nova, com a data de hoje e o momento do contato como referência do preço. Tipo, cartão e situação continuam os mesmos.</p>
        <div class="dialogo-acoes">
          <button type="button" class="btn" data-fechar>Cancelar</button>
          <button type="submit" class="btn btn-principal" id="pp-salvar">Gravar preço</button>
        </div>
      </form>
    </dialog>
    <dialog class="dialogo" id="pp-incluir" aria-labelledby="pp-inc-titulo">
      <form id="pp-inc-form" novalidate>
        ${BOTAO_OPCOES}
        <h2 id="pp-inc-titulo">Incluir negociação</h2>
        <p class="dialogo-explica" id="pp-inc-explica"></p>
        <p class="erro-form oculto" id="pp-inc-erro" role="alert"></p>
        <dl class="rot-veiculo" id="pp-inc-atual"></dl>
        <div class="grade-form">
          <label class="campo-form"><span>Preço negociado (R$/L)</span><input name="valor" inputmode="numeric" data-moeda="2" autocomplete="off" required placeholder="0,00"></label>
          <label class="campo-form"><span>Situação</span><select name="status"></select></label>
          <label class="campo-form"><span>Unidade</span><select name="unidade"></select></label>
          <label class="campo-form"><span>Cartão</span><select name="plataforma"></select></label>
          <label class="campo-form"><span>Tipo</span><select name="tipo"></select></label>
          <label class="campo-form"><span>Combustível</span><select name="combustivel"></select></label>
          <label class="campo-form largo"><span>Cidade</span><input name="cidade" required autocomplete="off" placeholder="Ex.: MARABA - PA…"></label>
          <label class="campo-form largo"><span>Aviso para o motorista</span><input name="aviso" autocomplete="off" list="pp-sug-avisos"></label>
        </div>
        <p class="nota">Vira a primeira negociação deste posto (a mesma do "Adicionar posto" em Postos dos motoristas). Como autorizado, ele entra na lista dos motoristas da unidade. Unidade, cidade, cartão e combustível vêm dos abastecimentos dele: confira.</p>
        <div class="dialogo-acoes">
          <button type="button" class="btn" data-fechar>Cancelar</button>
          <button type="submit" class="btn btn-principal" id="pp-inc-salvar">Incluir negociação</button>
        </div>
      </form>
    </dialog>`;
  const el = (id) => pagina.querySelector('#' + id);
  // avisos para o motorista: a lista configurada na engrenagem (tela "postos", a mesma de Postos dos motoristas) ou os que existem
  let opcCadastro = { opcoes: {}, podeEditar: false };
  carregarOpcoesCadastro('postos').then((o) => { opcCadastro = o; });
  const listaAvisos = () => listaEfetiva(opcCadastro, 'aviso',
    [...new Set(autorizadosLista.map((p) => String(p.Aviso || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR')));
  const encherAvisos = () => { el('pp-sug-avisos').innerHTML = listaAvisos().map((v) => '<option value="' + esc(v) + '">').join(''); };

  // ---------- atualizar o preço de um posto depois do contato (vira uma negociação nova na planilha) ----------
  const podeEditar = !!(ctx.pode && ctx.pode('postos-editar'));
  // postos com alteração ainda não refletida aqui: pendente/aguardando (o vigia ainda não gravou) ou gravada depois da
  // Base que está na tela (a negociação nova só aparece quando a Base é reenviada) -> não oferece o botão de novo
  let pendentes = new Set();
  let opcoes = null;   // listas da planilha (unidades, situações, cartões, tipos), as mesmas do "Adicionar posto"
  async function carregarPendentes() {
    if (!podeEditar) return;
    try {
      const r = await fetch('/api/postos/alteracoes', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      opcoes = j.opcoes || null;
      const baseEm = Date.parse(dados.geradoEm);
      pendentes = new Set(j.alteracoes.filter((a) => a.estado === 'pendente' || a.estado === 'aguardando' ||
        (a.estado === 'aplicada' && Date.parse(a.aplicada_em) > baseEm)).map((a) => chaveNome(a.dados.posto)));
    } catch {}
  }
  const numero = (s) => { const v = Number(String(s).replace(/\s/g, '').replace(',', '.')); return isFinite(v) && v > 0 && v < 50 ? v : null; };
  let editando = null;   // {k, porUnidade: [negociação mais recente de cada unidade]}
  function abrirPreco(k) {
    const negs = negPorPosto.get(k) || [];
    const porUnidade = [...new Map(negs.map((n) => [n.unidade, n])).values()];   // a última de cada unidade (lista em ordem)
    const ultima = negs[negs.length - 1];
    const tx = base.filter((t) => t.k === k).reduce((a, b) => (!a || b.dia > a.dia || (b.dia === a.dia && (b.seg || 0) > (a.seg || 0)) ? b : a), null);
    editando = { k, porUnidade, anterior: ultima };
    const f = el('pp-form');
    f.reset();
    el('pp-erro').classList.add('oculto');
    el('pp-dlg-titulo').textContent = 'Atualizar preço: ' + ultima.posto;
    el('pp-dlg-explica').textContent = ultima.cidade + ' · ' + ultima.status.toLowerCase() + (ultima.tipo ? ' · ' + ultima.tipo.toLowerCase() : '');
    el('pp-dlg-atual').innerHTML = htmlApoio([
      { rot: 'Negociado atual', val: fmt.moeda(ultima.valor), det: '<span class="medidor-meta">' + esc(fmtDia(ultima.dia)) + '</span>' },
      { rot: 'Último pago', val: tx ? fmt.moeda(tx.vlLitro) : '—', det: tx ? '<span class="medidor-meta">' + esc(fmtDia(tx.dia)) + '</span>' : '' },
    ]);
    f.aviso.value = ultima.aviso || '';
    const caixa = el('pp-unidades');
    caixa.classList.toggle('oculto', porUnidade.length < 2);
    caixa.querySelector('div').innerHTML = porUnidade.map((n, i) =>
      '<label class="opcao-linha"><input type="checkbox" name="unidade" value="' + i + '" checked> <span>' + esc(n.unidade) + ' · ' + esc(n.status.toLowerCase()) + '</span></label>').join('');
    encherAvisos();
    el('pp-dialogo').showModal();
    f.valor.focus();
  }
  el('pp-form').valor.addEventListener('input', (e) => {
    const v = numero(e.target.value), ant = editando && editando.anterior.valor;
    el('pp-form').variacao.value = v && ant ? (v >= ant ? '+' : '') + fmt.pct(v / ant - 1) : '';
  });
  el('pp-dialogo').querySelector('[data-fechar]').addEventListener('click', () => el('pp-dialogo').close());
  el('pp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = el('pp-form'), erro = el('pp-erro');
    const valor = numero(f.valor.value);
    if (!valor) { erro.textContent = 'Informe o preço novo em R$ por litro (ex.: 6,89).'; erro.classList.remove('oculto'); f.valor.focus(); return; }
    const escolhidas = editando.porUnidade.filter((_, i) => editando.porUnidade.length < 2 || f.querySelector('input[name="unidade"][value="' + i + '"]').checked);
    if (!escolhidas.length) { erro.textContent = 'Marque pelo menos uma unidade.'; erro.classList.remove('oculto'); return; }
    const agora = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const momento = agora.getFullYear() + '-' + p2(agora.getMonth() + 1) + '-' + p2(agora.getDate()) + 'T' + p2(agora.getHours()) + ':' + p2(agora.getMinutes()) + ':' + p2(agora.getSeconds());
    const quem = ctx.usuario && ctx.usuario.nome ? String(ctx.usuario.nome).toUpperCase() : 'PORTAL';
    const btn = el('pp-salvar');
    btn.disabled = true; btn.textContent = 'Gravando…';
    try {
      for (const n of escolhidas) {
        const r = await fetch('/api/postos/alteracoes', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ acao: 'editar', dados: {
            unidade: n.unidade, posto: n.posto, cidade: n.cidade, tipo: n.tipo || '', plataforma: n.plataforma, valor,
            combustivel: n.combustivel || 'DIESEL S-10 COMUM', status: n.status, aviso: f.aviso.value,
            contato: quem + ' (PORTAL) - CONTATO COM O POSTO',
            transacao: momento,   // coluna K: o preço vem do contato de agora (a contagem de "desatualizado" recomeça)
            variacao: n.valor ? Math.round((valor / n.valor - 1) * 1e6) / 1e6 : null,
          } }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.status === 401) { location.href = '/?entrar=1'; return; }
        if (!r.ok) throw new Error(j.erro || 'Não foi possível gravar. Tente de novo.');
      }
      pendentes.add(editando.k);
      el('pp-dialogo').close();
      desenharTabela();
    } catch (err) {
      erro.textContent = err.message; erro.classList.remove('oculto');
    } finally {
      btn.disabled = false; btn.textContent = 'Gravar preço';
    }
  });
  // ---------- incluir a primeira negociação de um posto que só tem abastecimento ----------
  const COMBUSTIVEIS = ['DIESEL S-10 COMUM', 'DIESEL', 'DIESEL S-10 ADITIVADO'];
  const NOME_TIPO = { '': 'Sem tipo', POLO: 'Polo: pode completar', MINIMO: 'Mínimo: pernoite/auxiliar' };
  // centro de custo da Base -> unidade da planilha (RAJA LOG BELEM -> BELEM, KEMIGAS GV -> GOVERNADOR VALADARES)
  const unidadeDoCc = (cc) => {
    const c = chaveNome(cc);
    return opcoes.unidades.find((u) => c.includes(chaveNome(u))) || (/\bGV\b/.test(c) ? 'GOVERNADOR VALADARES' : '');
  };
  // cartão da Base -> plataforma da planilha (TICKET -> TICKETLOG)
  const plataformaDoCartao = (c) => (c ? opcoes.plataformas.find((x) => chaveNome(x) === chaveNome(c) || chaveNome(x).startsWith(chaveNome(c))) || '' : '');
  const opt = (lista, rot) => lista.map((v) => '<option value="' + esc(v) + '">' + esc(rot ? rot(v) : v) + '</option>').join('');
  let incluindo = null;   // {k, posto}
  function abrirIncluir(k) {
    if (!opcoes) return;
    // abastecimentos de diesel do posto (qualquer período): unidade que mais abastece, cidade/cartão/combustível do último
    let ult = null, n = 0;
    const porUnidade = new Map();
    for (const l of dados.linhas) {
      if (chaveNome(l.fornecedor) !== k || !DIESEL.has(l.combustivel) || !(l.vlLitro > 0)) continue;
      n++;
      const u = unidadeDoCc(l.cc);
      if (u) porUnidade.set(u, (porUnidade.get(u) || 0) + 1);
      if (!ult || l.dia > ult.dia || (l.dia === ult.dia && (l.seg || 0) > (ult.seg || 0))) ult = l;
    }
    const daLista = autorizadosLista.find((p) => chaveNome(p.Posto) === k);
    const nome = ult ? String(ult.fornecedor).trim().toUpperCase() : daLista ? daLista.Posto : k;
    incluindo = { k, posto: nome };
    const f = el('pp-inc-form');
    f.reset();
    f.status.innerHTML = opt(opcoes.status);
    f.unidade.innerHTML = opt(opcoes.unidades);
    f.plataforma.innerHTML = opt(opcoes.plataformas);
    f.tipo.innerHTML = opt(opcoes.tipos, (v) => NOME_TIPO[v] || v);
    f.combustivel.innerHTML = opt(COMBUSTIVEIS);
    f.status.value = 'POSTO AUTORIZADO';
    const uni = [...porUnidade.entries()].sort((a, b) => b[1] - a[1])[0];
    if (uni) f.unidade.value = uni[0];
    else if (daLista && opcoes.unidades.includes(chaveNome(daLista.Unidade))) f.unidade.value = chaveNome(daLista.Unidade);
    f.cidade.value = ult ? ult.cidade || '' : daLista ? daLista.Cidade : '';
    const plat = plataformaDoCartao(ult && ult.cartao);
    if (plat) f.plataforma.value = plat;
    if (ult && COMBUSTIVEIS.includes(ult.combustivel)) f.combustivel.value = ult.combustivel;
    if (ult) f.valor.placeholder = 'Último pago: ' + fmt.d3(ult.vlLitro).replace('.', ',') + '…';
    el('pp-inc-erro').classList.add('oculto');
    el('pp-inc-titulo').textContent = 'Incluir negociação: ' + nome;
    el('pp-inc-explica').textContent = ult
      ? fmt.int(n) + (n === 1 ? ' abastecimento' : ' abastecimentos') + ' de diesel' +
        (porUnidade.size ? ' (' + [...porUnidade.entries()].sort((a, b) => b[1] - a[1]).map(([u, q]) => u + ': ' + q).join(', ') + ')' : '') + '.'
      : 'Sem abastecimento de diesel.';
    el('pp-inc-atual').innerHTML = htmlApoio([
      { rot: 'Negociado atual', val: '—', det: '<span class="medidor-meta">sem negociação</span>' },
      { rot: 'Último pago', val: ult ? fmt.moeda(ult.vlLitro) : '—', det: ult ? '<span class="medidor-meta">' + esc(fmtDia(ult.dia)) + (ult.placa ? ' · ' + esc(ult.placa) : '') + '</span>' : '' },
    ]);
    encherAvisos();
    el('pp-incluir').showModal();
    f.valor.focus();
  }
  el('pp-inc-form').addEventListener('click', (e) => {
    if (!e.target.closest('[data-opcoes]')) return;
    abrirOpcoes({ tela: 'postos', titulo: 'Opções do cadastro de postos', podeEditar: opcCadastro.podeEditar,
      campos: [{ id: 'aviso', rotulo: 'Avisos para o motorista', valores: listaAvisos(), configurado: temConfig(opcCadastro, 'aviso') },
        ...(opcoes ? [{ id: 'unidade', rotulo: 'Unidade', valores: opcoes.unidades, fixo: true }, { id: 'status', rotulo: 'Situação', valores: opcoes.status, fixo: true },
          { id: 'plataforma', rotulo: 'Cartão', valores: opcoes.plataformas, fixo: true }, { id: 'tipo', rotulo: 'Tipo', valores: opcoes.tipos.filter(Boolean), fixo: true }] : []),
        { id: 'combustivel', rotulo: 'Combustível', valores: COMBUSTIVEIS, fixo: true }],
      aoSalvar: (novos) => { opcCadastro = { ...opcCadastro, opcoes: { ...opcCadastro.opcoes, ...novos } }; encherAvisos(); } });
  });
  el('pp-incluir').querySelector('[data-fechar]').addEventListener('click', () => el('pp-incluir').close());
  el('pp-inc-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = el('pp-inc-form'), erro = el('pp-inc-erro');
    const valor = numero(f.valor.value);
    const falha = (msg, campo) => { erro.textContent = msg; erro.classList.remove('oculto'); if (campo) campo.focus(); };
    if (!valor) return falha('Informe o preço negociado em R$ por litro (ex.: 6,89).', f.valor);
    if (!f.cidade.value.trim()) return falha('Informe a cidade (ex.: MARABA - PA).', f.cidade);
    const c = dados.locais && dados.locais[incluindo.posto];   // coordenada do mapa de calor, se o posto já tiver
    const btn = el('pp-inc-salvar');
    btn.disabled = true; btn.textContent = 'Gravando…';
    try {
      const r = await fetch('/api/postos/alteracoes', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'adicionar', dados: {
          unidade: f.unidade.value, posto: incluindo.posto, cidade: f.cidade.value, status: f.status.value,
          plataforma: f.plataforma.value, tipo: f.tipo.value, valor, combustivel: f.combustivel.value, aviso: f.aviso.value,
          latitude: c ? c[0] : '', longitude: c ? c[1] : '',
        } }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { location.href = '/?entrar=1'; return; }
      if (!r.ok) return falha(j.erro || 'Não foi possível gravar. Tente de novo.');
      pendentes.add(incluindo.k);
      el('pp-incluir').close();
      desenharTabela();
    } catch (err) {
      falha('Sem conexão com o servidor. Verifique a internet e tente de novo.');
    } finally {
      btn.disabled = false; btn.textContent = 'Incluir negociação';
    }
  });

  Promise.all([carregarPendentes(), carregarLista()]).then(() => desenharTabela());

  const filtros = criarFiltros({
    dimensoes: DIMENSOES, filtrosEl: el('pp-filtros'), chipsEl: el('pp-chips'), rota: ROTA,
    obterBase: () => base, obterLimites: () => [dados.diaMin, dados.diaMax], aoMudar: () => { limite = POR_PAGINA; atualizar(); }, prefixo: 'pp',
  });

  function desenharTopo() {
    const a = somar(filtradas);
    el('pp-bomba').innerHTML = htmlBomba({ despesa: a.despesa, litros: a.litros, preco: a.preco });
    el('pp-resumo').innerHTML = htmlApoio([
      { rot: 'Pago acima do negociado', val: fmt.moeda(a.acima) },
      { rot: 'Diferença média paga', val: a.dif === null ? '—' : (a.dif > 0 ? '+' : '') + 'R$ ' + fmt.d3(a.dif) + '/L',
        det: a.dif === null ? '' : statusHtml(a.dif <= TOLERANCIA, a.dif <= TOLERANCIA ? 'no negociado ou abaixo' : 'acima do negociado') },
      { rot: 'Abastecimentos acima do negociado', val: a.qtdNeg ? fmt.pct(a.qtdAcima / a.qtdNeg) : '—',
        det: a.qtdNeg ? '<span class="medidor-meta">' + fmt.int(a.qtdAcima) + ' de ' + fmt.int(a.qtdNeg) + '</span>' : '' },
    ]);
    const postos = new Set(filtradas.map((t) => t.k));
    const litrosSem = filtradas.reduce((s, t) => s + (t.negociado === null && !t.bloqueado ? t.litros : 0), 0);
    const bloq = filtradas.filter((t) => t.bloqueado);
    const lim = dados.limitesNeg;
    let desat = 0, reneg = 0;
    postos.forEach((k) => {
      const negs = negPorPosto.get(k);
      if (!negs || bloqueada(negs[negs.length - 1])) return;   // bloqueado não é negociação desatualizada
      const s = situacaoNeg(negs[negs.length - 1], lim);
      if (s.nivel === 1) desat++; else if (s.nivel === 2) reneg++;
    });
    el('pp-apoio').innerHTML = htmlApoio([
      { rot: 'Preço médio negociado', val: a.precoNeg === null ? '—' : 'R$ ' + fmt.d3(a.precoNeg) },
      { rot: 'Preço médio pago (com negociação)', val: a.pagoMedioNeg === null ? '—' : 'R$ ' + fmt.d3(a.pagoMedioNeg) },
      { rot: 'Postos', val: fmt.int(postos.size) },
      { rot: 'Litros sem negociação', val: a.litros ? fmt.pct(litrosSem / a.litros) : '—' },
      { rot: 'Negociações desatualizadas', val: fmt.int(desat + reneg), det: reneg ? '<span class="status ruim">' + reneg + ' com renegociação obrigatória</span>' : '' },
    ].concat(bloq.length ? [{ rot: 'Abastecido em posto bloqueado', val: fmt.int(bloq.length),
      det: '<span class="status ruim">' + fmt.int(new Set(bloq.map((t) => t.k)).size) + ' postos · ' + fmt.int(bloq.reduce((s, t) => s + t.litros, 0)) + ' L</span>' }] : []));
  }

  function desenharGrafico() {
    const com = filtradas.filter((t) => t.negociado !== null);
    // período curto (este mês, últimos 3 meses...): dia a dia; mais longo: mês a mês
    let min = Infinity, max = -Infinity;
    for (const t of com) { if (t.dia < min) min = t.dia; if (t.dia > max) max = t.dia; }
    const porDia = com.length && max - min <= DIAS_GRAFICO_DIARIO;
    el('pp-grafico-titulo').textContent = 'Preço pago e preço negociado, ' + (porDia ? 'dia a dia' : 'mês a mês');
    const grupos = new Map();
    for (const t of com) {
      const k = porDia ? t.dia : mesDoDia(t.dia);
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(t);
    }
    const pts = [...grupos.entries()].sort((a, b) => a[0] - b[0]).map(([k, ts]) => {
      const a = somar(ts);
      return {
        rotulo: porDia ? fmtDia(k).slice(0, 5) : fmtMes(k), rotuloLongo: porDia ? fmtDia(k) : fmtMes(k, true),
        chave: k, pago: a.pagoMedioNeg, negociado: a.precoNeg, acima: a.acima, litros: a.litrosNeg,
      };
    });
    graficoPeriodo(el('pp-grafico'), pts, {
      linhas: [{ campo: 'negociado', rot: 'Negociado', cor: 'var(--tinta-2)', tracejada: true }, { campo: 'pago', rot: 'Pago', cor: 'var(--serie-1)' }],
      ultimoParcial: pts.length > 1 && emAndamento(porDia ? 'dia' : 'mes', pts[pts.length - 1].chave),
      fmtV: (v) => (v === null || v === undefined ? '—' : 'R$ ' + fmt.d3(v)), fmtEixo: fmt.d2,
      extras: (p) => [['Pago acima', fmt.moeda(p.acima)], ['Litros', fmt.int(p.litros)]],
      rotulo: 'Preço médio pago e preço médio negociado por mês',
    });
  }

  const COLUNAS = [
    { id: 'posto', rot: 'Posto', v: (a) => a.posto },
    { id: 'negociado', rot: 'Negociado atual', n: true, v: (a) => (a.neg && !bloqueada(a.neg) ? a.neg.valor : null) },
    { id: 'situacao', rot: 'Situação da negociação', v: (a) => (a.sit ? a.sit.nivel : null) },
    { id: 'ultimo', rot: 'Último pago', n: true, v: (a) => (a.ultimo ? a.ultimo.vlLitro : null) },
    { id: 'preco', rot: 'Preço médio pago', n: true, v: (a) => a.tot.preco },
    { id: 'dif', rot: 'Diferença média', n: true, v: (a) => a.tot.dif },
    { id: 'litros', rot: 'Litros', n: true, v: (a) => a.tot.litros },
    { id: 'acima', rot: 'Pago acima', n: true, v: (a) => a.tot.acima },
  ];
  function desenharTabela() {
    const grupos = new Map();
    for (const t of filtradas) {
      if (!grupos.has(t.k)) grupos.set(t.k, { k: t.k, posto: t.posto, cidade: t.cidade, ts: [] });
      grupos.get(t.k).ts.push(t);
    }
    const lim = dados.limitesNeg;
    let lista = [...grupos.values()].map((g) => {
      const negs = negPorPosto.get(g.k);
      const neg = negs ? negs[negs.length - 1] : null;
      let ultimo = g.ts[0];
      for (const t of g.ts) if (t.dia > ultimo.dia || (t.dia === ultimo.dia && (t.seg || 0) > (ultimo.seg || 0))) ultimo = t;
      return { ...g, neg, sit: !neg ? null : bloqueada(neg) ? { txt: 'Posto bloqueado', nivel: 2 } : situacaoNeg(neg, lim), ultimo, tot: somar(g.ts) };
    });
    // autorizados na lista dos motoristas sem abastecimento neste recorte (os filtros valem, menos o período)
    const vistos = new Set(lista.map((a) => a.k));
    for (const p of autorizadosLista) {
      const k = chaveNome(p.Posto);
      if (vistos.has(k) || internos.has(k)) continue;
      const negs = negPorPosto.get(k);
      const neg = negs ? negs[negs.length - 1] : null;
      const t = {
        posto: neg ? neg.posto : p.Posto, cidade: neg ? neg.cidade : p.Cidade, unidade: neg ? neg.unidade : chaveNome(p.Unidade),
        cartao: neg ? neg.plataforma : p.Cartao, combustivel: null, negociado: neg ? neg.valor : null,
      };
      if (!filtros.passa(t, 'periodo')) continue;
      vistos.add(k);
      lista.push({ k, posto: t.posto, cidade: t.cidade, ts: [], neg, sit: neg ? situacaoNeg(neg, lim) : null, ultimo: null, tot: somar([]) });
    }
    const b = chaveNome(busca);
    if (b) lista = lista.filter((a) => chaveNome(a.posto).includes(b) || chaveNome(a.cidade).includes(b));
    const c = COLUNAS.find((x) => x.id === ordem.campo);
    lista.sort((x, y) => {
      const va = c.v(x), vb = c.v(y);
      if (va === null || va === undefined) return 1; if (vb === null || vb === undefined) return -1;
      return ordem.dir * (typeof va === 'string' ? va.localeCompare(vb, 'pt-BR') : va - vb) || y.tot.litros - x.tot.litros;
    });
    const sel = filtros.sel.posto;
    el('pp-conta').textContent = fmt.int(lista.length) + (lista.length === 1 ? ' posto' : ' postos');
    const CLS = ['sit-ok', 'sit-alerta', 'sit-ruim'];
    el('pp-tabela').innerHTML =
      '<thead><tr>' + COLUNAS.map((col) => {
        const ativa = ordem.campo === col.id;
        return '<th class="' + (col.n ? 'n' : '') + '" aria-sort="' + (ativa ? (ordem.dir < 0 ? 'descending' : 'ascending') : 'none') + '">' +
          '<button type="button" data-col="' + col.id + '">' + esc(col.rot) + (ativa ? '<span class="seta">' + (ordem.dir < 0 ? '▼' : '▲') + '</span>' : '') + '</button></th>';
      }).join('') + (podeEditar ? '<th class="acoes-linha"><span>Preço</span></th>' : '') + '</tr></thead><tbody>' +
      (lista.length ? lista.slice(0, limite).map((a) => {
        const t = a.tot;
        const acao = !podeEditar ? '' : '<td class="acoes-linha">' + (pendentes.has(a.k) ? '<span class="selo-pendente">aguardando gravação</span>'
          : !a.neg ? '<button type="button" class="btn-linha btn-linha-bom" data-incluir="' + esc(a.k) + '">Incluir negociação</button>'
          : '<button type="button" class="btn-linha" data-preco="' + esc(a.k) + '">Atualizar preço</button>') + '</td>';
        const difTxt = t.dif === null ? '<span class="sem-dado">—</span>'
          : '<span class="' + (t.dif > TOLERANCIA ? 'var-alerta' : 'num') + '">' + (t.dif > 0 ? '+' : '') + esc(fmt.d3(t.dif)) + '</span>';
        return '<tr class="' + (sel.has(a.posto) ? 'selecionado' : '') + '" data-posto="' + esc(a.posto) + '">' +
          '<td class="trunc"><button type="button" class="link-botao nome-clicavel" data-posto="' + esc(a.posto) + '" aria-pressed="' + sel.has(a.posto) + '">' + esc(a.posto) + '</button>' +
            '<small class="cidade-linha">' + esc(a.cidade + (a.neg ? ' · ' + a.neg.unidade : '')) + '</small></td>' +
          '<td class="n">' + (a.neg && bloqueada(a.neg) ? '<span class="sem-dado">Bloqueado</span><small class="cidade-linha">desde ' + esc(fmtDia(a.neg.dia)) + '</small>'
            : a.neg ? '<span class="num">' + esc(fmt.moeda(a.neg.valor)) + '</span><small class="cidade-linha">' + esc(fmtDia(a.neg.dia)) + '</small>' : '<span class="sem-dado">Sem negociação</span>') + '</td>' +
          '<td>' + (a.sit ? '<span class="sit ' + CLS[a.sit.nivel] + '">' + esc(a.sit.txt) + '</span>' +
            (a.sit.dias !== undefined ? '<small class="cidade-linha">' + a.sit.dias + (a.sit.dias === 1 ? ' dia' : ' dias') + ' desde a transação usada</small>' : '') : '<span class="sem-dado">—</span>') + '</td>' +
          (a.ultimo
            ? '<td class="n"><span class="num">' + esc(fmt.moeda(a.ultimo.vlLitro)) + '</span><small class="cidade-linha">' + esc(fmtDia(a.ultimo.dia)) + '</small></td>' +
              '<td class="n">' + esc(fmt.moeda(t.preco)) + '</td><td class="n">' + difTxt + '</td>' +
              '<td class="n">' + esc(fmt.int(t.litros)) + '</td><td class="n">' + esc(fmt.moeda(t.acima)) + '</td>'
            : '<td class="n"><span class="sem-dado">Sem abastecimento</span><small class="cidade-linha">neste período</small></td>' +
              '<td class="n"><span class="sem-dado">—</span></td><td class="n"><span class="sem-dado">—</span></td>' +
              '<td class="n"><span class="sem-dado">—</span></td><td class="n"><span class="sem-dado">—</span></td>') + acao + '</tr>';
      }).join('') : '<tr><td colspan="' + (COLUNAS.length + (podeEditar ? 1 : 0)) + '"><div class="vazio">Nenhum abastecimento em posto externo neste recorte.</div></td></tr>') + '</tbody>';
    el('pp-mais').innerHTML = botoesMaisMenos(lista.length, limite, POR_PAGINA);
  }

  // um posto escolhido: todas as negociações dele, da mais recente para a mais antiga
  function desenharHistorico() {
    const sel = [...filtros.sel.posto];
    const painel = el('pp-historico-painel');
    const negs = sel.length === 1 ? negPorPosto.get(chaveNome(sel[0])) : null;
    painel.classList.toggle('oculto', !negs);
    if (!negs) return;
    el('pp-historico-titulo').textContent = 'Histórico de negociações: ' + sel[0];
    const lista = [...negs].reverse();
    el('pp-historico').innerHTML =
      '<thead><tr><th><span>Data</span></th><th class="n"><span>Valor</span></th><th class="n"><span>Variação</span></th><th><span>Transação usada</span></th>' +
      '<th><span>Unidade</span></th><th><span>Situação</span></th><th><span>Contato</span></th></tr></thead><tbody>' +
      lista.map((n, i) => {
        const ant = lista.slice(i + 1).find((x) => x.valor);
        const v = ant && n.valor ? n.valor / ant.valor - 1 : null;
        return '<tr><td>' + esc(fmtDia(n.dia)) + '</td><td class="n">' + esc(fmt.moeda(n.valor)) + '</td>' +
          '<td class="n">' + (v === null ? '<span class="sem-dado">—</span>' : '<span class="' + (Math.abs(v) > dados.limitesNeg.variacao ? 'var-alerta' : 'num') + '">' + (v > 0 ? '+' : '') + esc(fmt.pct(v)) + '</span>') + '</td>' +
          '<td>' + (n.transDia !== null ? esc(fmtDia(n.transDia)) : '<span class="sem-dado">—</span>') + '</td>' +
          '<td>' + esc(n.unidade) + '</td><td>' + esc(n.status.toLowerCase()) + '</td><td class="trunc">' + esc(n.contato) + '</td></tr>';
      }).join('') + '</tbody>';
  }

  el('pp-tabela').addEventListener('click', (e) => {
    const bp = e.target.closest('[data-preco]');
    if (bp) { abrirPreco(bp.dataset.preco); return; }
    const bi = e.target.closest('[data-incluir]');
    if (bi) { abrirIncluir(bi.dataset.incluir); return; }
    const b = e.target.closest('[data-col]');
    if (b) {
      const col = COLUNAS.find((x) => x.id === b.dataset.col);
      ordem = ordem.campo === col.id ? { campo: col.id, dir: -ordem.dir } : { campo: col.id, dir: col.n || col.id === 'situacao' ? -1 : 1 };
      desenharTabela();
      const novo = el('pp-tabela').querySelector('[data-col="' + col.id + '"]');
      if (novo) novo.focus();
      return;
    }
    const linha = e.target.closest('tr[data-posto]');
    if (linha) filtros.alternar('posto', linha.dataset.posto);
  });
  el('pp-mais').addEventListener('click', (e) => {
    if (e.target.closest('[data-mais]')) { limite += POR_PAGINA; desenharTabela(); return; }
    if (e.target.closest('[data-menos]')) { limite = POR_PAGINA; desenharTabela(); el('pp-tabela').scrollIntoView({ block: 'nearest' }); }
  });
  let tBusca = null;
  el('pp-busca').addEventListener('input', (e) => {
    clearTimeout(tBusca);
    tBusca = setTimeout(() => { busca = e.target.value; limite = POR_PAGINA; desenharTabela(); }, 150);
  });

  const atualizar = agendador(() => {
    filtradas = base.filter((t) => filtros.passa(t, null));
    filtros.atualizarUI();
    desenharTopo();
    desenharGrafico();
    desenharHistorico();
    desenharTabela();
  });
  atualizar();

  let tRedim = null;
  const aoRedimensionar = () => { clearTimeout(tRedim); tRedim = setTimeout(desenharGrafico, 120); };
  window.addEventListener('resize', aoRedimensionar);
  const aoAtualizarDados = () => Promise.all([carregarDados(), carregarLista()]).then(([d]) => { usarDados(d); return carregarPendentes(); }).then(() => atualizar());
  window.addEventListener('dados-atualizados', aoAtualizarDados);
  return {
    desmontar() {
      filtros.destruir();
      window.removeEventListener('resize', aoRedimensionar);
      window.removeEventListener('dados-atualizados', aoAtualizarDados);
    },
  };
}
