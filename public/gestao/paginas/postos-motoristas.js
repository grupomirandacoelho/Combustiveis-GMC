// "Postos dos motoristas" na gestão: a lista que os motoristas veem (incluindo os bloqueados) e a edição dela.
// Cada alteração feita aqui vira uma linha nova na planilha "Gestão de negociações de preço" (aba "Base de dados
// de negociações"), gravada pelo vigia do computador da sincronização; em seguida a lista dos motoristas é republicada.
// "Adicionar posto" ligado ao "Preço postos externos": ao digitar o nome, sugere os postos que já tiveram negociação
// (dados.negPostos, a mesma planilha) e, ao escolher um, preenche com a última negociação dele (unidade, cidade, cartão,
// tipo, valor, combustível, aviso), a coordenada da LOCALIZAÇÃO DOS POSTOS e mostra o último preço pago nas transações.
import { esc, fmt, fmtDia, carregarDados } from '../lib/dados.js';
import { seloCartao } from '../lib/cartoes.js';
import { botoesMaisMenos } from '../lib/filtros.js';
import { carregarOpcoes as carregarOpcoesCadastro, listaEfetiva, temConfig, BOTAO_OPCOES, abrirOpcoes } from '../lib/opcoes.js';

const semAcento = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const chave = (s) => semAcento(s).toUpperCase().replace(/\s+/g, ' ').trim();
const COMBUSTIVEIS = ['DIESEL S-10 COMUM', 'DIESEL', 'DIESEL S-10 ADITIVADO'];
const NOME_ACAO = { adicionar: 'Adicionou', editar: 'Editou', bloquear: 'Bloqueou', autorizar: 'Autorizou' };
const NOME_ESTADO = { pendente: 'Aguardando gravação', aguardando: 'Aguardando gravação', aplicada: 'Gravada', erro: 'Erro ao gravar' };
const emAberto = (a) => a.estado === 'pendente' || a.estado === 'aguardando';

function lerCSV(texto) {
  if (texto.charCodeAt(0) === 0xFEFF) texto = texto.slice(1);
  const linhas = texto.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  const cab = linhas[0].split(';').map((h) => h.trim());
  return linhas.slice(1).map((l) => {
    const cols = l.split(';'), o = {};
    cab.forEach((h, i) => { o[h] = (cols[i] || '').trim(); });
    o.autorizado = o.Status.toUpperCase().includes('AUTORIZ');
    return o;
  });
}

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando os postos…</div>';
  let postos = [], alteracoes = [], opcoes = null, infoLista = null;

  async function carregar() {
    const [rc, ra] = await Promise.all([
      fetch('/postos.csv', { cache: 'no-cache' }),
      fetch('/api/postos/alteracoes', { credentials: 'same-origin', cache: 'no-store' }),
    ]);
    if (ra.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
    if (!rc.ok || !ra.ok) throw new Error('Não foi possível ler a lista de postos. Recarregue a página.');
    postos = lerCSV(await rc.text());
    const j = await ra.json();
    alteracoes = j.alteracoes; opcoes = j.opcoes; infoLista = j.lista;
  }
  try { await carregar(); } catch (e) {
    pagina.innerHTML = '<div class="vazio">' + esc(e.message) + '</div>';
    return {};
  }
  ctx.definirSub('A lista que os motoristas veem, incluindo os bloqueados. Alterações feitas aqui viram negociações e valem na hora para os motoristas.');

  // nome exibido da unidade -> código da planilha (Belém -> BELEM)
  const codigoUnidade = (nome) => opcoes.unidades.find((u) => chave(u) === chave(nome)) || chave(nome);
  const estado = { unidade: '', status: 'todos', cartao: '', tipo: '', busca: '', ordem: { col: 'unidade', dir: 1 } };
  // Tipo (coluna da planilha): POLO pode completar o tanque; MINIMO é posto de pernoite/auxiliar (só o mínimo)
  const NOME_TIPO = { POLO: 'Polo: pode completar', MINIMO: 'Mínimo: pernoite/auxiliar', '': 'Sem tipo' };
  const tipoDe = (p) => (p.Tipo === 'POLO' || p.Tipo === 'MINIMO' ? p.Tipo : '');

  pagina.innerHTML = `
    <dl class="apoio apoio-pilha" id="pm-resumo"></dl>
    <div class="aviso-pendencias oculto" id="pm-pendencias" role="status"></div>
    <section class="painel painel-tabela pm-lista">
      <div class="painel-cab">
        <h2>Lista de postos</h2>
        <div class="acoes-cab">
          <a class="btn" href="/" target="_blank" rel="noopener"><svg aria-hidden="true"><use href="#i-postos"/></svg><span class="txt">Página dos motoristas</span></a>
          <button type="button" class="btn btn-principal" id="pm-adicionar"><svg aria-hidden="true"><use href="#i-mais"/></svg><span class="txt">Adicionar posto</span></button>
        </div>
      </div>
      <div class="tabela-ferramentas">
        <input type="search" id="pm-busca" placeholder="Posto ou cidade…" aria-label="Procurar posto ou cidade" autocomplete="off">
        <select id="pm-unidade" class="campo-sel" aria-label="Unidade"></select>
        <select id="pm-cartao" class="campo-sel" aria-label="Cartão"></select>
        <select id="pm-tipo" class="campo-sel" aria-label="Tipo do posto">
          <option value="">Todos os tipos</option><option value="POLO">Polo: pode completar</option>
          <option value="MINIMO">Mínimo: pernoite/auxiliar</option><option value="-">Sem tipo</option>
        </select>
        <div class="segmentado" role="group" aria-label="Situação">
          <button type="button" data-st="todos" aria-pressed="true">Todos</button>
          <button type="button" data-st="ok" aria-pressed="false">Autorizados</button>
          <button type="button" data-st="bloq" aria-pressed="false">Bloqueados</button>
        </div>
        <span class="conta" id="pm-conta"></span>
      </div>
      <div class="tabela-rolagem"><table class="dados pm-tabela" id="pm-tabela"></table></div>
      <div id="pm-mais"></div>
    </section>
    <section class="painel">
      <div class="painel-cab"><h2>Alterações feitas pelo portal</h2><span class="conta" id="pm-conta-hist"></span></div>
      <div class="tabela-rolagem tabela-historico"><table class="dados" id="pm-historico"></table></div>
    </section>

    <dialog class="dialogo" id="pm-dialogo" aria-labelledby="pm-dlg-titulo">
      <form id="pm-form" novalidate>
        ${BOTAO_OPCOES}
        <h2 id="pm-dlg-titulo"></h2>
        <p class="dialogo-explica" id="pm-dlg-explica"></p>
        <p class="erro-form oculto" id="pm-erro" role="alert"></p>
        <div class="pm-neg oculto" id="pm-neg" role="status"></div>
        <datalist id="pm-sug-postos"></datalist><datalist id="pm-sug-avisos"></datalist>
        <div class="grade-form">
          <label class="campo-form"><span>Unidade</span><select name="unidade" required></select></label>
          <label class="campo-form"><span>Situação</span><select name="status" required></select></label>
          <label class="campo-form largo"><span>Nome do posto</span><input name="posto" required autocomplete="off" spellcheck="false" placeholder="Ex.: POSTO MAGNOLIA 06…"></label>
          <label class="campo-form largo"><span>Cidade</span><input name="cidade" required autocomplete="off" placeholder="Ex.: MARABA - PA…"></label>
          <label class="campo-form"><span>Cartão</span><select name="plataforma" required></select></label>
          <label class="campo-form"><span>Tipo</span><select name="tipo"></select></label>
          <label class="campo-form"><span>Valor negociado (R$/L)</span><input name="valor" inputmode="numeric" data-moeda="2" autocomplete="off" placeholder="Em branco: mantém o atual…"></label>
          <label class="campo-form"><span>Combustível</span><select name="combustivel"></select></label>
          <label class="campo-form largo"><span>Aviso para o motorista</span><input name="aviso" autocomplete="off" list="pm-sug-avisos" placeholder="Ex.: SEMPRE COMPLETAR…"></label>
          <label class="campo-form"><span>Latitude</span><input name="latitude" inputmode="decimal" autocomplete="off" placeholder="-4,9541…"></label>
          <label class="campo-form"><span>Longitude</span><input name="longitude" inputmode="decimal" autocomplete="off" placeholder="-47,5031…"></label>
        </div>
        <p class="nota">Latitude e longitude são opcionais; sem elas o motorista não vê o botão "Abrir no mapa".</p>
        <div class="dialogo-acoes">
          <button type="button" class="btn" id="pm-cancelar">Cancelar</button>
          <button type="submit" class="btn btn-principal" id="pm-salvar"></button>
        </div>
      </form>
    </dialog>`;
  const $ = (id) => pagina.querySelector('#' + id);
  const dlg = $('pm-dialogo'), form = $('pm-form');
  // avisos para o motorista: a lista configurada na engrenagem (tela "postos") ou os avisos que já existem nos postos
  let opcCadastro = { opcoes: {}, podeEditar: false };
  carregarOpcoesCadastro('postos').then((o) => { opcCadastro = o; });
  const avisosExistentes = () => [...new Set(postos.map((p) => String(p.Aviso || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const listaAvisos = () => listaEfetiva(opcCadastro, 'aviso', avisosExistentes());
  const encherAvisos = () => { $('pm-sug-avisos').innerHTML = listaAvisos().map((v) => '<option value="' + esc(v) + '">').join(''); };
  form.addEventListener('click', (e) => {
    if (!e.target.closest('[data-opcoes]')) return;
    abrirOpcoes({ tela: 'postos', titulo: 'Opções do cadastro de postos', podeEditar: opcCadastro.podeEditar,
      campos: [{ id: 'aviso', rotulo: 'Avisos para o motorista', valores: listaAvisos(), configurado: temConfig(opcCadastro, 'aviso') },
        ...(opcoes ? [{ id: 'unidade', rotulo: 'Unidade', valores: opcoes.unidades, fixo: true }, { id: 'status', rotulo: 'Situação', valores: opcoes.status, fixo: true },
          { id: 'plataforma', rotulo: 'Cartão', valores: opcoes.plataformas, fixo: true }, { id: 'tipo', rotulo: 'Tipo', valores: opcoes.tipos.filter(Boolean), fixo: true }] : []),
        { id: 'combustivel', rotulo: 'Combustível', valores: COMBUSTIVEIS, fixo: true }],
      aoSalvar: (novos) => { opcCadastro = { ...opcCadastro, opcoes: { ...opcCadastro.opcoes, ...novos } }; encherAvisos(); } });
  });
  // login só com "ver a lista": sem os botões de alterar (o servidor também recusa a gravação)
  // (modo consulta: a lista, os filtros e a busca continuam; somem as ações e o histórico de alterações)
  const consulta = ctx.pode && !ctx.pode('postos-editar');
  if (consulta) {
    $('pm-adicionar').classList.add('oculto');
    $('pm-tabela').classList.add('sem-edicao');
    $('pm-historico').closest('section').classList.add('oculto');
    ctx.definirSub('Consulta da lista que os motoristas veem, incluindo os bloqueados.');
  }

  const opt = (lista) => lista.map((v) => '<option value="' + esc(v) + '">' + esc(v || '(nenhum)') + '</option>').join('');
  form.unidade.innerHTML = opt(opcoes.unidades);
  form.status.innerHTML = opt(opcoes.status);
  form.plataforma.innerHTML = opt(opcoes.plataformas);
  form.tipo.innerHTML = opcoes.tipos.map((v) => '<option value="' + esc(v) + '">' + esc(NOME_TIPO[v] || v) + '</option>').join('');
  form.combustivel.innerHTML = opt(COMBUSTIVEIS);

  // ---------- ligação com o "Preço postos externos": postos já negociados ----------
  // última negociação de cada posto por unidade, coordenada da LOCALIZAÇÃO e último preço pago (transações de diesel)
  let negociados = null;   // chave(posto) -> [{...última negociação de cada unidade}]
  let locais = {}, ultimoPago = new Map();
  // postos com abastecimento de diesel na Base (com ou sem negociação): chave -> {posto, cidade, unidades, cartao, combustivel, ...}
  const abastecidos = new Map();
  // centro de custo da Base -> unidade da lista (RAJA LOG BELEM -> BELEM, KEMIGAS GV -> GOVERNADOR VALADARES)
  const unidadeDoCc = (cc) => {
    const c = chave(cc);
    return opcoes.unidades.find((u) => u && c.includes(chave(u))) || (/\bGV\b/.test(c) ? opcoes.unidades.find((u) => chave(u) === 'GOVERNADOR VALADARES') : '') || '';
  };
  // cartão da Base -> plataforma da lista (TICKET -> TICKETLOG)
  const plataformaDoCartao = (c) => (c ? opcoes.plataformas.find((x) => chave(x) === chave(c) || chave(x).startsWith(chave(c))) || '' : '');
  if (!consulta) {
    carregarDados({ tempoReal: true }).then((d) => {
      negociados = new Map();
      const ult = new Map();   // posto|unidade -> negociação mais recente (pela data; empate: a gravada depois)
      for (const n of d.negPostos) {
        if (!n.posto) continue;
        const k = chave(n.posto) + '|' + chave(n.unidade);
        const a = ult.get(k);
        if (!a || n.dia > a.dia || (n.dia === a.dia && n.ordem > a.ordem)) ult.set(k, n);
      }
      for (const n of ult.values()) {
        const k = chave(n.posto);
        if (!negociados.has(k)) negociados.set(k, []);
        negociados.get(k).push(n);
      }
      locais = d.locais || {};
      for (const l of d.linhas) {
        if (!/^DIESEL/.test(l.combustivel || '') || !(l.vlLitro > 0) || !l.fornecedor) continue;
        const k = chave(l.fornecedor), a = ultimoPago.get(k);
        const maisNovo = !a || l.dia > a.dia || (l.dia === a.dia && (l.seg || 0) > (a.seg || 0));
        if (maisNovo) ultimoPago.set(k, { dia: l.dia, seg: l.seg, preco: l.vlLitro });
        // dados do próprio posto na Base (só postos externos; bomba interna e cais ficam fora). Há abastecimentos com
        // o tipo do estabelecimento em branco na Base (ex.: POSTO SANTA TERESA D'AVILA | REDE Z+Z): contam como posto
        if (l.tipoEstab === 'ESTABELECIMENTO INTERNO' || l.tipoEstab === 'CAIS VIBRA') continue;
        let p = abastecidos.get(k);
        if (!p) abastecidos.set(k, p = { posto: String(l.fornecedor).trim().toUpperCase(), n: 0, unidades: new Map() });
        p.n++;
        const u = unidadeDoCc(l.cc);
        if (u) p.unidades.set(u, (p.unidades.get(u) || 0) + 1);
        if (maisNovo) Object.assign(p, { dia: l.dia, preco: l.vlLitro, cidade: l.cidade, cartao: l.cartao, combustivel: l.combustivel, placa: l.placa, motorista: l.motorista });
      }
      // sugestões: um item por posto e unidade negociados, com cidade e o último valor negociado; depois os postos
      // que só têm abastecimento (sem negociação), com a cidade e o último preço pago
      const soAbastecidos = [...abastecidos.entries()].filter(([k]) => !negociados.has(k)).map(([, p]) => p);
      $('pm-sug-postos').innerHTML = [...ult.values()].sort((a, b) => a.posto.localeCompare(b.posto, 'pt-BR')).map((n) =>
        '<option value="' + esc(n.posto) + '" label="' + esc([n.cidade, n.unidade, n.valor ? 'R$ ' + fmt.d3(n.valor) + ' em ' + fmtDia(n.dia) : ''].filter(Boolean).join(' · ')) + '"></option>').join('') +
        soAbastecidos.sort((a, b) => a.posto.localeCompare(b.posto, 'pt-BR')).map((p) =>
          '<option value="' + esc(p.posto) + '" label="' + esc([p.cidade, 'sem negociação', 'abastecido R$ ' + fmt.d3(p.preco) + ' em ' + fmtDia(p.dia)].filter(Boolean).join(' · ')) + '"></option>').join('');
    }).catch(() => { negociados = null; });   // sem acesso aos dados da Base: o formulário funciona como antes, sem sugestões
  }
  const valorBR = (v) => (v === null || v === undefined || v === '' ? '' : String(v).replace('.', ','));
  const conhecido = (nome) => negociados && (negociados.has(chave(nome)) || abastecidos.has(chave(nome)));
  const avisoNaLista = (posto) => {
    const naLista = postos.find((p) => chave(p.Posto) === chave(posto) && chave(codigoUnidade(p.Unidade)) === chave(form.unidade.value));
    return naLista ? '<br><span class="aviso-linha">Este posto já está na lista de ' + esc(naLista.Unidade) + ' como ' + esc(naLista.Status.toLowerCase()) +
      ': use "Editar" ou "Autorizar" na tabela em vez de adicionar de novo.</span>' : '';
  };
  // posto sem negociação, mas com abastecimento: preenche com o que a Base tem (cidade, unidade de quem mais abastece
  // nele, cartão, combustível e preço do último abastecimento) e a coordenada do mapa de calor (LOCALIZAÇÃO)
  function preencherDaBase(p, soUnidade) {
    const caixa = $('pm-neg');
    const porUso = [...p.unidades.entries()].sort((a, b) => b[1] - a[1]);
    if (!soUnidade) {
      form.posto.value = p.posto;
      if (porUso.length && !unidadeEscolhida) form.unidade.value = codigoUnidade(porUso[0][0]);
      if (p.cidade) form.cidade.value = p.cidade;
      const plat = plataformaDoCartao(p.cartao);
      if (plat) form.plataforma.value = plat;
      if (p.preco) form.valor.value = valorBR(Math.round(p.preco * 1000) / 1000);
      if (COMBUSTIVEIS.includes(p.combustivel)) form.combustivel.value = p.combustivel;
      const c = locais[chave(p.posto)];
      if (c && !form.latitude.value && !form.longitude.value) { form.latitude.value = valorBR(c[0]); form.longitude.value = valorBR(c[1]); }
    }
    const c = locais[chave(p.posto)];
    caixa.innerHTML = '<strong>Posto sem negociação: preenchido com os abastecimentos.</strong> ' +
      esc(fmt.int(p.n)) + (p.n === 1 ? ' abastecimento' : ' abastecimentos') + ' de diesel' +
      (porUso.length ? ' (' + esc(porUso.map(([u, q]) => u + ': ' + q).join(', ') +
        (p.n > porUso.reduce((s, x) => s + x[1], 0) ? ', outros centros de custo: ' + (p.n - porUso.reduce((s, x) => s + x[1], 0)) : '')) + ')' : '') + '. Último: <strong>R$ ' + esc(fmt.d3(p.preco)) + '</strong> em ' +
      esc(fmtDia(p.dia)) + (p.placa ? ', placa ' + esc(p.placa) : '') + (p.motorista ? ', ' + esc(p.motorista) : '') + (p.cartao ? ', cartão ' + esc(p.cartao) : '') + '.' +
      ' O valor negociado veio do último preço pago: troque pelo preço que você negociou.' +
      (c ? ' Coordenada do mapa de calor.' : ' Sem coordenada no mapa de calor.') +
      ' Escolha também a situação e o tipo.' + avisoNaLista(p.posto) + ' Confira os campos antes de salvar.';
    caixa.classList.remove('oculto');
  }
  // ao escolher (ou digitar exatamente) um posto já negociado no "Adicionar posto", preenche com a última negociação
  function preencherDoPosto(e) {
    const caixa = $('pm-neg');
    if (acaoAtual !== 'adicionar' || !negociados) { caixa.classList.add('oculto'); return; }
    const lista = negociados.get(chave(form.posto.value)) || [];
    if (!lista.length) {
      const p = abastecidos.get(chave(form.posto.value));
      if (p) preencherDaBase(p, e && e.target === form.unidade); else caixa.classList.add('oculto');
      return;
    }
    // a negociação da unidade escolhida; se não houver, a mais recente. A unidade só segue a negociação se a pessoa ainda não
    // escolheu uma: liberar o mesmo posto em outra unidade (ex.: negociado em Serra, liberar também em Teixeira) mantém a
    // unidade escolhida (26/11/2026; antes ela voltava sozinha para a unidade da negociação e não dava para liberar)
    const escolheu = unidadeEscolhida || (e && e.target === form.unidade);
    const daUnidade = lista.find((x) => chave(x.unidade) === chave(form.unidade.value));
    const n = daUnidade || [...lista].sort((a, b) => b.dia - a.dia)[0];
    form.posto.value = n.posto;
    if (!escolheu && opcoes.unidades.some((u) => chave(u) === chave(n.unidade))) form.unidade.value = codigoUnidade(n.unidade);
    const outraUnidade = escolheu && !daUnidade ? '<br><strong>Liberando em ' + esc(form.unidade.options[form.unidade.selectedIndex]?.text || form.unidade.value) +
      ':</strong> os campos vieram da negociação de ' + esc(n.unidade) + '; confira o valor e o cartão desta unidade.' : '';
    if (n.cidade) form.cidade.value = n.cidade;
    const plat = opcoes.plataformas.find((x) => chave(x) === chave(n.plataforma));
    if (plat) form.plataforma.value = plat;
    if (opcoes.tipos.includes(n.tipo || '')) form.tipo.value = n.tipo || '';
    if (n.valor) form.valor.value = valorBR(n.valor);
    if (COMBUSTIVEIS.includes(n.combustivel)) form.combustivel.value = n.combustivel;
    if (n.aviso) form.aviso.value = n.aviso;
    const c = locais[chave(n.posto)];
    if (c && !form.latitude.value && !form.longitude.value) { form.latitude.value = valorBR(c[0]); form.longitude.value = valorBR(c[1]); }
    const pago = ultimoPago.get(chave(n.posto));
    const naLista = postos.find((p) => chave(p.Posto) === chave(n.posto) && chave(codigoUnidade(p.Unidade)) === chave(form.unidade.value));
    caixa.innerHTML = '<strong>Preenchido com a última negociação deste posto</strong> (' + esc(n.unidade) + ', ' + esc(fmtDia(n.dia)) +
      (n.valor ? ', R$ ' + esc(fmt.d3(n.valor)) + '/L' : '') + (n.status ? ', ' + esc(n.status.toLowerCase()) : '') + ').' +
      (pago ? ' Último preço pago: <strong>R$ ' + esc(fmt.d3(pago.preco)) + '</strong> em ' + esc(fmtDia(pago.dia)) + '.' : ' Sem abastecimento de diesel nele.') +
      (c ? ' Coordenada cadastrada do posto.' : '') +
      (lista.length > 1 ? ' Também negociado em: ' + esc(lista.filter((x) => x !== n).map((x) => x.unidade).join(', ')) + ' (troque a unidade para usar a negociação dela).' : '') +
      (naLista ? '<br><span class="aviso-linha">Este posto já está na lista de ' + esc(naLista.Unidade) + ' como ' + esc(naLista.Status.toLowerCase()) +
        ': use "Editar" ou "Autorizar" na tabela em vez de adicionar de novo.</span>' : '') +
      outraUnidade + ' Confira os campos antes de salvar.';
    caixa.classList.remove('oculto');
  }
  // no "Adicionar" o nome puxa a negociação/abastecimentos; no "Editar" trocar o nome (ou a unidade) é corrigir o cadastro
  form.posto.addEventListener('change', (e) => { if (acaoAtual === 'editar') avisoTroca(); else preencherDoPosto(e); });
  form.posto.addEventListener('input', (e) => { if (acaoAtual === 'editar') avisoTroca(); else if (conhecido(form.posto.value)) preencherDoPosto(e); });
  form.unidade.addEventListener('change', (e) => {
    // o código da tela troca a unidade sem disparar evento: todo 'change' aqui é da pessoa (lista do portal ou do aparelho)
    unidadeEscolhida = true;   // escolhida pela pessoa: o preenchimento automático não troca mais
    if (acaoAtual === 'adicionar' && conhecido(form.posto.value)) preencherDoPosto(e);
    if (acaoAtual === 'editar') avisoTroca();
  });
  // edição com o nome e/ou a unidade trocados: explica o que acontece (e avisa se já existe um posto assim na lista)
  function avisoTroca() {
    const caixa = $('pm-neg');
    const nova = form.unidade.value, nomeNovo = form.posto.value.replace(/\s+/g, ' ').trim();
    const trocouUni = unidadeOriginal && chave(nova) !== chave(unidadeOriginal);
    const trocouNome = postoOriginal && nomeNovo && chave(nomeNovo) !== chave(postoOriginal);
    if (!trocouUni && !trocouNome) { caixa.classList.add('oculto'); return; }
    const nomeUni = (u) => (postos.find((p) => chave(codigoUnidade(p.Unidade)) === chave(u)) || {}).Unidade || u;
    const jaExiste = postos.find((p) => chave(p.Posto) === chave(nomeNovo) && chave(codigoUnidade(p.Unidade)) === chave(nova));
    const pago = abastecidos.get(chave(nomeNovo));
    const mudancas = [trocouNome ? 'nome "' + postoOriginal + '" → "' + nomeNovo.toUpperCase() + '"' : '',
      trocouUni ? 'unidade ' + nomeUni(unidadeOriginal) + ' → ' + nomeUni(nova) : ''].filter(Boolean).join('; ');
    caixa.innerHTML = '<strong>Correção de cadastro: ' + esc(mudancas) + '.</strong> Nas negociações, as linhas deste posto' +
      (trocouUni ? ' em ' + esc(nomeUni(unidadeOriginal)) : '') + ' passam a ' + (trocouNome ? 'ter o nome novo' : '') +
      (trocouNome && trocouUni ? ' e a ' : '') + (trocouUni ? 'ser de ' + esc(nomeUni(nova)) : '') + ', e a lista dos motoristas mostra só o cadastro corrigido.' +
      (trocouNome ? (pago ? ' O nome novo já aparece nos abastecimentos (' + esc(fmt.int(pago.n)) + ', último em ' + esc(fmtDia(pago.dia)) +
        '): o Preço postos externos passa a ligar a negociação a eles.' : ' <span class="aviso-linha">Ainda não há abastecimento com este nome; confira se está igual ao do portal do cartão.</span>') : '') +
      (jaExiste ? '<br><span class="aviso-linha">Já existe "' + esc(jaExiste.Posto) + '" na lista de ' + esc(jaExiste.Unidade) + ' (' + esc(jaExiste.Status.toLowerCase()) +
        '): as negociações dos dois ficam juntas e vale esta edição.</span>' : '');
    caixa.classList.remove('oculto');
  }

  // ---------- pendências (alterações ainda não gravadas) ----------
  const casa = (p, u, nome) => chave(nome) === chave(p.Posto) && chave(u) === chave(codigoUnidade(p.Unidade));
  const trocou = (a) => !!(a.dados.unidade_anterior || a.dados.posto_anterior);   // correção de unidade e/ou nome
  // a alteração mexe neste posto da lista: o cadastro novo ou, na correção, o cadastro de antes (que sai da lista)
  const mesmoPosto = (a, p) => casa(p, a.dados.unidade, a.dados.posto) ||
    (trocou(a) && casa(p, a.dados.unidade_anterior || a.dados.unidade, a.dados.posto_anterior || a.dados.posto));
  // gravada na planilha, mas a lista dos motoristas ainda não foi publicada (o vigia publica alguns segundos depois):
  // continua aparecendo como pendente e a página continua acompanhando (até 15 min, se a publicação falhar)
  const publicando = (a) => {
    const t = a.estado === 'aplicada' && a.aplicada_em ? Date.parse(a.aplicada_em) : NaN;
    if (!(Date.now() - t < 15 * 60e3)) return false;
    const lista = infoLista && infoLista.atualizadoEm ? Date.parse(infoLista.atualizadoEm) : NaN;
    return !(lista >= t);
  };
  const aberta = (a) => emAberto(a) || publicando(a);
  const pendentesDe = (p) => alteracoes.filter((a) => aberta(a) && mesmoPosto(a, p));
  function listaComPendencias() {
    // adicionados e os que trocaram de unidade: aparecem na unidade nova enquanto a lista não é publicada
    const novos = alteracoes.filter((a) => (a.acao === 'adicionar' || trocou(a)) && aberta(a) && !postos.some((p) => casa(p, a.dados.unidade, a.dados.posto)));
    return postos.concat(novos.map((a) => ({
      // nome da unidade como na lista (MARANHAO -> Maranhão)
      Unidade: (postos.find((p) => chave(codigoUnidade(p.Unidade)) === chave(a.dados.unidade)) || {}).Unidade || a.dados.unidade,
      Posto: a.dados.posto, Cidade: a.dados.cidade, Status: a.dados.status, Cartao: a.dados.plataforma,
      Aviso: a.dados.aviso, Latitude: a.dados.latitude ?? '', Longitude: a.dados.longitude ?? '',
      autorizado: a.dados.status.includes('AUTORIZ'), novoPendente: true, estadoPendente: a.estado, Tipo: a.dados.tipo,
    })));
  }

  // ---------- filtros e tabela ----------
  const COLUNAS = [
    { id: 'unidade', rot: 'Unidade', v: (p) => p.Unidade },
    { id: 'posto', rot: 'Posto', v: (p) => p.Posto },
    { id: 'cidade', rot: 'Cidade', v: (p) => p.Cidade },
    { id: 'situacao', rot: 'Situação', v: (p) => (p.autorizado ? 'Autorizado' : 'Bloqueado') },
    { id: 'cartao', rot: 'Cartão', v: (p) => p.Cartao },
    { id: 'tipo', rot: 'Tipo', v: (p) => NOME_TIPO[tipoDe(p)] },
    { id: 'negociado', rot: 'Última negociação', v: (p) => p.Negociado },
    { id: 'aviso', rot: 'Aviso ao motorista', v: (p) => p.Aviso },
    { id: 'mapa', rot: 'Mapa', v: (p) => (p.Latitude && p.Longitude ? 'Com localização' : 'Sem localização') },
  ];
  // data da última negociação e há quanto tempo (posto sem transação fica semanas sem linha nova)
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  function negociado(p) {
    if (p.novoPendente) return '<span class="sem-dado">hoje</span>';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.Negociado || '');
    if (!m) return '<span class="sem-dado">—</span>';
    const dias = Math.round((hoje - new Date(+m[1], m[2] - 1, +m[3])) / 864e5);
    const quando = dias <= 0 ? 'hoje' : dias === 1 ? 'há 1 dia' : 'há ' + dias + ' dias';
    return '<span class="num">' + m[3] + '/' + m[2] + '/' + m[1] + '</span><small class="cidade-linha' + (dias > 14 ? ' antigo' : '') + '">' + quando + '</small>';
  }
  const cmp = (a, b) => semAcento(a).localeCompare(semAcento(b), 'pt-BR', { numeric: true, sensitivity: 'base' });
  let visiveis = [];
  // a lista mostra 50 postos por vez ("Mostrar mais"); volta aos 50 primeiros quando um filtro muda
  const PASSO = 50;
  let limite = PASSO, assinatura = '';

  function desenharSeletores() {
    const lista = listaComPendencias();
    const uni = [...new Set(lista.map((p) => p.Unidade))].sort(cmp);
    const car = [...new Set(lista.map((p) => p.Cartao).filter(Boolean))].sort(cmp);
    $('pm-unidade').innerHTML = '<option value="">Todas as unidades</option>' + uni.map((u) => '<option' + (u === estado.unidade ? ' selected' : '') + '>' + esc(u) + '</option>').join('');
    $('pm-cartao').innerHTML = '<option value="">Todos os cartões</option>' + car.map((c) => '<option' + (c === estado.cartao ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
  }

  function desenhar() {
    const todos = listaComPendencias();
    const base = todos.filter((p) => !estado.unidade || p.Unidade === estado.unidade);
    const ok = base.filter((p) => p.autorizado).length;
    const pend = alteracoes.filter(aberta);
    const atualizada = infoLista && infoLista.atualizadoEm ? new Date(infoLista.atualizadoEm) : null;
    $('pm-resumo').innerHTML =
      '<div><dt>Autorizados</dt><dd><span class="num">' + fmt.int(ok) + '</span></dd></div>' +
      '<div><dt>Bloqueados</dt><dd><span class="num">' + fmt.int(base.length - ok) + '</span></dd></div>' +
      '<div><dt>Unidades</dt><dd><span class="num">' + fmt.int(new Set(base.map((p) => p.Unidade)).size) + '</span></dd></div>' +
      '<div><dt>Com aviso</dt><dd><span class="num">' + fmt.int(base.filter((p) => p.Aviso).length) + '</span></dd></div>' +
      '<div><dt>Lista publicada em</dt><dd><span class="num">' + (atualizada ? esc(atualizada.toLocaleDateString('pt-BR') + ' ' +
        atualizada.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })) : '—') + '</span></dd></div>';

    const noExcel = pend.filter((a) => a.estado === 'aguardando').length;
    $('pm-pendencias').classList.toggle('oculto', !pend.length);
    $('pm-pendencias').innerHTML = pend.length
      ? '<svg aria-hidden="true" class="girando"><use href="#i-atualizar"/></svg><span>' + esc(noExcel
        ? noExcel + (noExcel === 1 ? ' alteração espera' : ' alterações esperam') + ' a gravação.'
        : pend.every((a) => a.estado === 'aplicada')
          ? (pend.length === 1 ? 'Alteração gravada' : 'Alterações gravadas') + '; publicando a lista dos motoristas…'
          : pend.length + (pend.length === 1 ? ' alteração sendo gravada' : ' alterações sendo gravadas') + '. A lista dos motoristas é atualizada logo em seguida.') + '</span>'
      : '';

    const t = semAcento(estado.busca.trim()).toLowerCase();
    const c = COLUNAS.find((x) => x.id === estado.ordem.col);
    const lista = todos.filter((p) =>
      (!estado.unidade || p.Unidade === estado.unidade) && (!estado.cartao || p.Cartao === estado.cartao) &&
      (estado.status === 'todos' || (estado.status === 'ok') === p.autorizado) &&
      (!estado.tipo || (estado.tipo === '-' ? !tipoDe(p) : tipoDe(p) === estado.tipo)) &&
      (!t || semAcento(p.Posto).toLowerCase().includes(t) || semAcento(p.Cidade).toLowerCase().includes(t)))
      .sort((a, b) => {
        const va = c.v(a) || '', vb = c.v(b) || '';
        if (!va !== !vb) return va ? -1 : 1;
        return estado.ordem.dir * cmp(va, vb) || cmp(a.Unidade, b.Unidade) || cmp(a.Cidade, b.Cidade) || cmp(a.Posto, b.Posto);
      });
    visiveis = lista;
    const assin = JSON.stringify([estado.unidade, estado.cartao, estado.status, estado.tipo, estado.busca, estado.ordem]);
    if (assin !== assinatura) { assinatura = assin; limite = PASSO; }
    $('pm-conta').textContent = lista.length + (lista.length === 1 ? ' posto' : ' postos');
    // 6 colunas que cabem na largura da página (sem rolar para o lado): cidade e unidade embaixo do posto, o tipo embaixo
    // da situação e o mapa junto das ações. No celular cada posto vira um cartão (gestao.css .pm-tabela).
    const ordenar = (id, rot) => {
      const ativa = estado.ordem.col === id;
      return '<button type="button" data-col="' + id + '" aria-label="Ordenar por ' + esc(rot.toLowerCase()) + '">' + esc(rot) +
        (ativa ? '<span class="seta">' + (estado.ordem.dir > 0 ? '▲' : '▼') + '</span>' : '') + '</button>';
    };
    const th = (cols) => '<th' + (cols.some(([id]) => id === estado.ordem.col) ? ' aria-sort="' + (estado.ordem.dir > 0 ? 'ascending' : 'descending') + '"' : '') + '>' +
      cols.map(([id, rot]) => ordenar(id, rot)).join('<span class="pm-sep">·</span>') + '</th>';
    $('pm-tabela').innerHTML =
      '<thead><tr>' + th([['posto', 'Posto'], ['cidade', 'Cidade'], ['unidade', 'Unidade']]) + th([['situacao', 'Situação'], ['tipo', 'Tipo']]) +
      th([['cartao', 'Cartão']]) + th([['negociado', 'Última negociação']]) + th([['aviso', 'Aviso ao motorista']]) +
      '<th class="pm-acoes"><span>Ações</span></th></tr></thead><tbody>' +
      (lista.length ? lista.slice(0, limite).map((p, i) => {
        const pe = p.novoPendente ? [{ estado: p.estadoPendente || 'pendente' }] : pendentesDe(p);
        const ult = pe[pe.length - 1];
        const selo = ult ? '<span class="selo-pendente" title="' + esc(NOME_ESTADO[ult.estado]) + '">' +
          (ult.estado === 'aguardando' ? 'aguardando' : ult.estado === 'aplicada' ? 'publicando' : 'aguardando gravação') + '</span>' : '';
        const mapa = p.Latitude && p.Longitude
          ? '<a class="btn-linha pm-mapa" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(p.Latitude + ',' + p.Longitude) +
            '" title="Abrir a localização no Google Maps"><svg aria-hidden="true"><use href="#i-mapa"/></svg>Ver no mapa</a>'
          : '<span class="sem-dado pm-sem-mapa">Sem localização</span>';
        const situacao = p.autorizado
          ? '<span class="selo selo-ok"><span aria-hidden="true">✓</span>Autorizado</span>'
          : '<span class="selo selo-bloq"><span aria-hidden="true">×</span>' + (p.Status.toUpperCase().includes('NEGOCIA') ? 'Em negociação' : 'Bloqueado') + '</span>';
        const acoes = p.novoPendente ? '<span class="sem-dado">aguardando</span>'
          : '<button type="button" class="btn-linha" data-acao="editar" data-i="' + i + '">Editar</button>' +
            (p.autorizado
              ? '<button type="button" class="btn-linha btn-linha-ruim" data-acao="bloquear" data-i="' + i + '">Bloquear</button>'
              : '<button type="button" class="btn-linha btn-linha-bom" data-acao="autorizar" data-i="' + i + '">Autorizar</button>');
        return '<tr><td class="pm-posto"><strong>' + esc(p.Posto) + '</strong>' + selo + '<small class="cidade-linha">' + esc(p.Cidade) + ' · ' + esc(p.Unidade) + '</small></td>' +
          '<td class="pm-situacao">' + situacao + '<div>' + (tipoDe(p) ? '<span class="sit ' + (tipoDe(p) === 'POLO' ? 'sit-ok' : 'sit-alerta') + '">' + esc(NOME_TIPO[tipoDe(p)]) + '</span>'
            : '<span class="sem-dado">Sem tipo</span>') + '</div></td>' +
          '<td>' + seloCartao(p.Cartao) + '</td>' +
          '<td>' + negociado(p) + '</td>' +
          '<td class="pm-aviso">' + (p.Aviso ? esc(p.Aviso) : '<span class="sem-dado">Nenhum</span>') + '</td>' +
          '<td class="pm-acoes"><div>' + acoes + mapa + '</div></td></tr>';
      }).join('') : '<tr><td colspan="6"><div class="vazio">Nenhum posto com esses filtros.</div></td></tr>') + '</tbody>';
    $('pm-mais').innerHTML = botoesMaisMenos(lista.length, limite, PASSO);

    $('pm-conta-hist').textContent = alteracoes.length ? fmt.int(alteracoes.length) + ' mais recentes' : '';
    $('pm-historico').innerHTML = alteracoes.length
      ? '<thead><tr><th><span>Quando</span></th><th><span>Quem</span></th><th><span>O que</span></th><th><span>Posto</span></th><th><span>Gravação</span></th></tr></thead><tbody>' +
        alteracoes.map((a) => {
          const q = new Date(a.criado_em);
          const cls = a.estado === 'aplicada' ? 'selo-ok' : a.estado === 'erro' ? 'selo-bloq' : 'selo-espera';
          return '<tr><td>' + esc(q.toLocaleDateString('pt-BR') + ' ' + q.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })) + '</td>' +
            '<td>' + esc(a.usuario_nome) + '</td><td>' + esc(a.dados.rodada ? 'Rodada de preços' : NOME_ACAO[a.acao] || a.acao) + '</td>' +
            '<td class="trunc"><strong>' + esc(a.dados.posto) + '</strong>' + (a.dados.posto_anterior ? '<small class="cidade-linha">antes: ' + esc(a.dados.posto_anterior) + '</small>' : '') +
              '<small class="cidade-linha">' + esc((a.dados.unidade_anterior ? a.dados.unidade_anterior + ' → ' : '') + a.dados.unidade + ', ' + a.dados.status.toLowerCase()) + '</small></td>' +
            '<td><span class="selo ' + cls + '">' + esc(NOME_ESTADO[a.estado]) + (a.linha ? ' (linha ' + a.linha + ')' : '') + '</span>' +
              (a.mensagem && a.estado !== 'aplicada' ? '<small class="cidade-linha">' + esc(a.mensagem) + '</small>' : '') + '</td></tr>';
        }).join('') + '</tbody>'
      : '<tbody><tr><td><div class="vazio">Nenhuma alteração feita pelo portal ainda.</div></td></tr></tbody>';
  }

  // ---------- formulário ----------
  let acaoAtual = null;
  const TITULOS = { adicionar: 'Adicionar posto', editar: 'Editar posto', bloquear: 'Bloquear posto', autorizar: 'Autorizar posto' };
  const BOTOES = { adicionar: 'Adicionar posto', editar: 'Salvar alteração', bloquear: 'Bloquear posto', autorizar: 'Autorizar posto' };
  const EXPLICA = {
    adicionar: 'O posto entra na lista dos motoristas assim que a negociação for gravada.',
    editar: 'A alteração vira uma negociação nova, com a data de hoje.',
    bloquear: 'O posto some da lista dos motoristas. Se quiser, deixe um aviso explicando o motivo.',
    autorizar: 'O posto volta a aparecer para os motoristas da unidade.',
  };
  // na edição: a unidade e o nome com que o posto está na lista (trocar = corrigir o cadastro: unidade errada, ou o nome
  // que no portal do cartão é outro, descoberto quando sai a primeira transação)
  let unidadeOriginal = null, postoOriginal = null, unidadeEscolhida = false;
  function abrir(acao, p) {
    acaoAtual = acao;
    unidadeEscolhida = false;
    unidadeOriginal = p ? codigoUnidade(p.Unidade) : null;
    postoOriginal = p ? p.Posto : null;
    form.reset();
    $('pm-erro').classList.add('oculto');
    $('pm-dlg-titulo').textContent = TITULOS[acao];
    $('pm-salvar').textContent = BOTOES[acao];
    $('pm-salvar').classList.toggle('btn-perigo', acao === 'bloquear');
    $('pm-dlg-explica').textContent = EXPLICA[acao];
    if (p) {
      form.unidade.value = codigoUnidade(p.Unidade);
      form.posto.value = p.Posto;
      form.cidade.value = p.Cidade;
      form.plataforma.value = opcoes.plataformas.find((x) => chave(x) === chave(p.Cartao)) || opcoes.plataformas[0];
      form.tipo.value = tipoDe(p);   // mantém o tipo atual (antes ele voltava vazio ao editar)
      form.aviso.value = p.Aviso || '';
      form.latitude.value = p.Latitude || '';
      form.longitude.value = p.Longitude || '';
      form.status.value = acao === 'bloquear' ? 'POSTO BLOQUEADO' : acao === 'autorizar' ? 'POSTO AUTORIZADO'
        : (opcoes.status.find((x) => chave(x) === chave(p.Status)) || 'POSTO AUTORIZADO');
    } else {
      form.status.value = 'POSTO AUTORIZADO';
    }
    // na edição dá para trocar a unidade (posto cadastrado na unidade errada): as negociações dele passam para a nova
    form.unidade.disabled = acao === 'bloquear' || acao === 'autorizar';
    form.posto.readOnly = acao === 'bloquear' || acao === 'autorizar';
    // só no "Adicionar": o nome sugere os postos já negociados (lista do "Preço postos externos")
    // (no "Editar", as mesmas sugestões ajudam a escolher o nome exato que aparece nos abastecimentos)
    if (acao === 'adicionar' || acao === 'editar') form.posto.setAttribute('list', 'pm-sug-postos'); else form.posto.removeAttribute('list');
    $('pm-neg').classList.add('oculto');
    form.status.disabled = acao === 'bloquear' || acao === 'autorizar';
    encherAvisos();
    dlg.showModal();
    (acao === 'adicionar' ? form.posto : acao === 'editar' ? form.plataforma : form.aviso).focus();
  }

  $('pm-adicionar').addEventListener('click', () => abrir('adicionar', null));
  $('pm-mais').addEventListener('click', (e) => {
    if (e.target.closest('[data-mais]')) { limite += PASSO; desenhar(); }
    else if (e.target.closest('[data-menos]')) { limite = PASSO; desenhar(); $('pm-tabela').scrollIntoView({ block: 'start' }); }
  });
  $('pm-cancelar').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('pm-tabela').addEventListener('click', (e) => {
    const col = e.target.closest('[data-col]');
    if (col) {
      const id = col.dataset.col;
      estado.ordem = estado.ordem.col === id ? { col: id, dir: -estado.ordem.dir } : { col: id, dir: 1 };
      desenhar();
      const novo = $('pm-tabela').querySelector('[data-col="' + id + '"]');
      if (novo) novo.focus();
      return;
    }
    const b = e.target.closest('[data-acao]');
    if (b) abrir(b.dataset.acao, visiveis[Number(b.dataset.i)]);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('pm-erro');
    const dados = {
      unidade: form.unidade.value, posto: form.posto.value, cidade: form.cidade.value, status: form.status.value,
      plataforma: form.plataforma.value, tipo: form.tipo.value, valor: form.valor.value, combustivel: form.combustivel.value,
      aviso: form.aviso.value, latitude: form.latitude.value, longitude: form.longitude.value,
    };
    if (acaoAtual === 'editar' && unidadeOriginal && chave(dados.unidade) !== chave(unidadeOriginal)) dados.unidade_anterior = unidadeOriginal;
    if (acaoAtual === 'editar' && postoOriginal && dados.posto.trim() && chave(dados.posto) !== chave(postoOriginal)) dados.posto_anterior = postoOriginal;
    if (!dados.posto.trim() || !dados.cidade.trim()) {
      erro.textContent = 'Preencha o nome do posto e a cidade.';
      erro.classList.remove('oculto');
      (dados.posto.trim() ? form.cidade : form.posto).focus();
      return;
    }
    const btn = $('pm-salvar'), rotulo = btn.textContent;
    btn.disabled = true; btn.textContent = 'Salvando…';
    try {
      const r = await fetch('/api/postos/alteracoes', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: acaoAtual, dados }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { location.href = '/?entrar=1'; return; }
      if (!r.ok) { erro.textContent = j.erro || 'Não foi possível salvar. Tente de novo.'; erro.classList.remove('oculto'); return; }
      alteracoes.unshift({ ...j.alteracao, mensagem: null, linha: null });
      dlg.close();
      desenharSeletores(); desenhar();
      acompanhar();
    } catch (err) {
      erro.textContent = 'Sem conexão com o servidor. Verifique a internet e tente de novo.';
      erro.classList.remove('oculto');
    } finally {
      btn.disabled = false; btn.textContent = rotulo;
    }
  });

  // ---------- acompanha a gravação: enquanto houver pendência, confere a cada 10 s ----------
  let tAcomp = null;
  function acompanhar() {
    clearTimeout(tAcomp);
    if (!alteracoes.some(aberta)) return;
    tAcomp = setTimeout(async () => {
      try { await carregar(); desenharSeletores(); desenhar(); } catch (e) {}
      acompanhar();
    }, 10 * 1000);
  }

  $('pm-busca').addEventListener('input', (e) => { estado.busca = e.target.value; desenhar(); });
  $('pm-unidade').addEventListener('change', (e) => { estado.unidade = e.target.value; desenhar(); });
  $('pm-cartao').addEventListener('change', (e) => { estado.cartao = e.target.value; desenhar(); });
  $('pm-tipo').addEventListener('change', (e) => { estado.tipo = e.target.value; desenhar(); });
  pagina.querySelector('.segmentado').addEventListener('click', (e) => {
    const b = e.target.closest('[data-st]');
    if (!b) return;
    estado.status = b.dataset.st;
    pagina.querySelectorAll('[data-st]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    desenhar();
  });
  desenharSeletores();
  desenhar();
  acompanhar();
  return { desmontar() { clearTimeout(tAcomp); if (dlg.open) dlg.close(); } };
}
