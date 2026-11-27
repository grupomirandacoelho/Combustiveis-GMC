// Operacional > Cartões frota: situação dos cartões (Ticket, TruckPag, Veloe) de cada placa, da planilha
// CONTROLES\CONTROLE CARTÕES FROTA.xlsx (aba CARTÕES), com a última transação de cada cartão na Base e os avisos
// dos motoristas (botão "Falta cartão no caminhão?" da página dos postos). Cada mudança fica pendente até o vigia
// do computador da sincronização gravá-la na planilha; depois a lista é publicada de novo (como em Placas e Motoristas).
import { carregarDados, esc, fmt, fmtDia } from '../lib/dados.js';
import { BOTAO_OPCOES, abrirOpcoes } from '../lib/opcoes.js';

const NOME_ESTADO = { pendente: 'Aguardando gravação', aguardando: 'Aguardando gravação', aplicada: 'Gravada', erro: 'Erro ao gravar' };
const emAberto = (a) => a.estado === 'pendente' || a.estado === 'aguardando';
const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const cmp = (a, b) => semAcento(a).localeCompare(semAcento(b), 'pt-BR', { numeric: true, sensitivity: 'base' });
const normPlaca = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// placa antiga (ABC1234) e Mercosul (ABC1C34) são o mesmo veículo: compara sempre no formato Mercosul
const mercosul = (v) => { const p = normPlaca(v); return /^[A-Z]{3}\d{4}$/.test(p) ? p.slice(0, 4) + 'ABCDEFGHIJ'[Number(p[4])] + p.slice(5) : p; };
const CLASSE_SIT = { 'ATIVO': 'sit-ok', 'QUEBRADO': 'sit-ruim', 'PERDIDO': 'sit-ruim', 'AGUARDANDO ENVIO': 'sit-alerta', 'ENVIO PARA BASE': 'sit-alerta' };
const quando = (iso) => { const d = new Date(iso); return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
const horaDoDia = (seg) => (seg === null || seg === undefined ? '' : ' ' + String(Math.floor(seg / 3600)).padStart(2, '0') + ':' + String(Math.floor(seg / 60) % 60).padStart(2, '0'));

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando o controle dos cartões…</div>';
  let info = null;
  const avisarMenu = () => window.dispatchEvent(new CustomEvent('alertas-cartoes', { detail: info.alertas.filter((a) => a.estado === 'aberto').length }));
  async function carregar() {
    const r = await fetch('/api/cartoes', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || 'Não foi possível ler o controle dos cartões. Recarregue a página.');
    info = j;
    avisarMenu();
  }
  try { await carregar(); } catch (e) {
    pagina.innerHTML = '<div class="vazio">' + esc(e.message) + '</div>';
    return {};
  }
  const CART = info.cartoes, SIT = info.situacoes, editar = info.podeEditar;
  // placas do cadastro que ficam no controle: ativas e com motor (categorias de lib/cartoes.js)
  const CATS_CARTAO = new Set(info.categoriasComCartao || []);
  const comCartao = (p) => !['DESABILITADA', 'VENDIDO'].includes(p.situacao || 'ATIVA') && CATS_CARTAO.has(String(p.categoria || '').toUpperCase());
  const rotuloCartao = Object.fromEntries(CART.map((c) => [c.id, c.rotulo]));
  ctx.definirSub(editar
    ? 'Cartões de cada placa, ligados ao cadastro de placas (placas ativas de cavalo, truck, toco, bitruck e 3/4). ' +
      'As mudanças feitas aqui valem na hora em todo o portal.'
    : 'Consulta dos cartões de cada placa, ligados ao cadastro de placas.');

  const estado = { busca: '', unidade: '', situacao: '', cartao: '', ordem: { col: 'placa', dir: 1 }, verResolvidos: false };
  let ultimas = null;          // 'mercosul|FORMA' -> {t, dia, seg, motorista}; null enquanto a Base carrega
  let semColunaCartao = false; // dados enviados antes da coluna "cartão": avisa em vez de mostrar vazio
  let erroBase = null;

  pagina.innerHTML = `
    <section class="painel cf-alertas oculto" id="cf-alertas" aria-labelledby="cf-alertas-titulo"></section>
    <dl class="apoio apoio-pilha" id="cf-resumo"></dl>
    <div class="aviso-pendencias oculto" id="cf-pendencias" role="status"></div>
    <section class="painel painel-tabela">
      <div class="painel-cab">
        <h2>Cartões por placa</h2>
        <div class="acoes-cab">
          ${editar ? '<button type="button" class="btn btn-principal" id="cf-adicionar"><svg aria-hidden="true"><use href="#i-mais"/></svg><span class="txt">Adicionar placa</span></button>' : ''}
        </div>
      </div>
      <div class="tabela-ferramentas cf-ferramentas">
        <input type="search" id="cf-busca" placeholder="Placa ou motorista…" aria-label="Procurar placa ou motorista" autocomplete="off">
        <label class="cf-filtro"><span>Unidade</span><select id="cf-unidade"></select></label>
        <label class="cf-filtro"><span>Cartão</span><select id="cf-cartao"><option value="">Todos</option>${CART.map((c) => '<option value="' + c.id + '">' + esc(c.rotulo) + '</option>').join('')}</select></label>
        <label class="cf-filtro"><span>Situação</span><select id="cf-situacao">
          <option value="">Todas</option><option value="__fora">Fora de ATIVO</option>
          ${SIT.map((s) => '<option value="' + esc(s) + '">' + esc(s) + '</option>').join('')}<option value="__sem">Sem cartão</option><option value="__foracad">Fora do cadastro de placas</option>
        </select></label>
        <span class="conta" id="cf-conta"></span>
      </div>
      <p class="nota" id="cf-nota-base">Carregando a última transação de cada cartão…</p>
      <div class="tabela-rolagem tabela-alta"><table class="dados cf-tabela" id="cf-tabela"></table></div>
    </section>
    ${editar ? `<section class="painel">
      <div class="painel-cab"><h2>Alterações feitas pelo portal</h2><span class="conta" id="cf-conta-hist"></span></div>
      <div class="tabela-rolagem tabela-historico"><table class="dados" id="cf-historico"></table></div>
    </section>` : ''}

    <dialog class="dialogo" id="cf-dialogo" aria-labelledby="cf-dlg-titulo">
      <form id="cf-form" novalidate>
        ${BOTAO_OPCOES}
        <h2 id="cf-dlg-titulo"></h2>
        <p class="dialogo-explica" id="cf-dlg-explica"></p>
        <p class="erro-form oculto" id="cf-erro" role="alert"></p>
        <div class="grade-form">
          <label class="campo-form largo" id="cf-campo-placa"><span>Placa</span>
            <input name="placa" autocomplete="off" spellcheck="false" placeholder="ABC1D23" maxlength="8"></label>
          ${CART.map((c) => '<label class="campo-form"><span>' + esc(c.rotulo) + '</span><select name="' + c.id + '"></select></label>').join('')}
        </div>
        <div class="dialogo-acoes">
          <button type="button" class="btn" id="cf-cancelar">Cancelar</button>
          <button type="submit" class="btn btn-principal" id="cf-salvar"></button>
        </div>
      </form>
    </dialog>`;
  const $ = (id) => pagina.querySelector('#' + id);
  const dlg = $('cf-dialogo'), form = $('cf-form');
  // engrenagem: aqui as listas são as do controle dos cartões (situações e categorias com cartão), fixas: só para consulta
  form.addEventListener('click', (e) => {
    if (!e.target.closest('[data-opcoes]')) return;
    abrirOpcoes({ tela: 'cartoes-frota', titulo: 'Opções do controle de cartões', podeEditar: false,
      campos: [{ id: 'situacao', rotulo: 'Situações dos cartões', valores: SIT, fixo: true, explica: 'Usadas nos avisos: não mudam por aqui.' },
        { id: 'categoria', rotulo: 'Categorias que entram no controle', valores: [...CATS_CARTAO], fixo: true, explica: 'As categorias do cadastro de placas que precisam de cartão. A categoria em si se configura no cadastro de placas.' }] });
  });

  // ---------- última transação de cada cartão (Base) ----------
  carregarDados({ tempoReal: true }).then((d) => {
    if (d.linhas.length && d.linhas[0].cartao === undefined) { semColunaCartao = true; ultimas = new Map(); desenhar(); return; }
    const m = new Map();
    for (const l of d.linhas) {
      if (!l.cartao) continue;
      const k = mercosul(l.placa) + '|' + l.cartao;
      const t = l.dia * 86400 + (l.seg || 0);
      const atual = m.get(k);
      if (!atual || t > atual.t) m.set(k, { t, dia: l.dia, seg: l.seg, motorista: l.motorista });
    }
    ultimas = m;
    desenhar();
  }).catch((e) => { erroBase = e.message; ultimas = new Map(); desenhar(); });

  function ultimaTransacao(r, c) {
    if (!ultimas) return null;
    let melhor = null;
    for (const p of [r.placa, ...(r.apelidos || [])]) {
      const u = ultimas.get(mercosul(p) + '|' + c.forma);
      if (u && (!melhor || u.t > melhor.t)) melhor = u;
    }
    return melhor;
  }

  // ---------- linhas: planilha + mudanças ainda não publicadas por cima ----------
  const semListaNova = (a) => a.estado === 'aplicada' && a.aplicada_em &&
    (!info.atualizadoEm || Date.parse(info.atualizadoEm) < Date.parse(a.aplicada_em));
  const naSobreposicao = (a) => emAberto(a) || semListaNova(a);
  const mesmaPlaca = (r, placa) => mercosul(r.placa) === mercosul(placa) || (r.apelidos || []).some((ap) => mercosul(ap) === mercosul(placa));
  function linhas() {
    const cadastro = new Map((info.placas || []).map((p) => [mercosul(p.placa), p]));
    const lista = (info.lista || []).map((r) => ({ ...r }));
    const naLista = new Set(lista.map((r) => normPlaca(r.placa)));
    for (const a of info.alteracoes.filter(naSobreposicao).slice().reverse()) {
      if (a.acao === 'editar') {
        const r = lista.find((x) => normPlaca(x.placa) === normPlaca(a.chave));
        if (!r) continue;
        Object.assign(r, a.dados);
        r._pendente = a;
      } else if (emAberto(a) || !naLista.has(normPlaca(a.chave))) {
        lista.push({ placa: a.chave, ticket: null, truckpag: null, veloe: null, ...a.dados, _pendente: a, _novo: true });
      }
    }
    // ligação com o cadastro de placas (o vigia acerta a planilha logo depois; aqui já aparece do jeito certo):
    // placa desabilitada ou de categoria sem cartão sai; placa ativa com motor que falta entra; placa que nunca esteve
    // no cadastro fica, com o aviso "fora do cadastro"
    const temCadastro = cadastro.size > 0;
    const doCadastro = (r) => [r.placa, ...(r.apelidos || [])].map((p) => cadastro.get(mercosul(p))).find(Boolean) || null;
    const final = [];
    for (const r of lista) {
      const p = doCadastro(r);
      if (temCadastro && p && !comCartao(p)) continue;
      r.unidade = p ? p.unidade : null;
      r.foraCadastro = temCadastro && !p;
      final.push(r);
    }
    if (temCadastro) {
      const presentes = new Set(final.flatMap((r) => [r.placa, ...(r.apelidos || [])].map(mercosul)));
      for (const p of info.placas) {
        if (comCartao(p) && !presentes.has(mercosul(p.placa))) {
          final.push({ placa: p.placa, ticket: null, truckpag: null, veloe: null, unidade: p.unidade, _entrando: true });
          presentes.add(mercosul(p.placa));
        }
      }
    }
    const abertos = info.alertas.filter((x) => x.estado === 'aberto');
    for (const r of final) r.alertas = abertos.filter((x) => mesmaPlaca(r, x.placa));
    return final;
  }

  // ---------- filtros ----------
  const unidades = [...new Set((info.placas || []).map((p) => p.unidade).filter(Boolean))].sort(cmp);
  $('cf-unidade').innerHTML = '<option value="">Todas</option>' + unidades.map((u) => '<option value="' + esc(u) + '">' + esc(u) + '</option>').join('') +
    '<option value="__sem">(sem unidade)</option>';
  function passa(r) {
    if (estado.unidade && (estado.unidade === '__sem' ? r.unidade : r.unidade !== estado.unidade)) return false;
    const ids = estado.cartao ? [estado.cartao] : CART.map((c) => c.id);
    if (estado.situacao === '__foracad') { if (!r.foraCadastro) return false; }
    else if (estado.situacao) {
      const ok = ids.some((id) => estado.situacao === '__fora' ? r[id] && r[id] !== 'ATIVO'
        : estado.situacao === '__sem' ? !r[id] : r[id] === estado.situacao);
      if (!ok) return false;
    }
    const t = semAcento(estado.busca.trim());
    if (t) {
      const tp = normPlaca(estado.busca);
      const naPlaca = tp && [r.placa, ...(r.apelidos || [])].some((p) => normPlaca(p).includes(tp) || mercosul(p).includes(mercosul(tp)));
      const noMotorista = CART.some((c) => { const u = ultimaTransacao(r, c); return u && semAcento(u.motorista).includes(t); });
      if (!naPlaca && !noMotorista) return false;
    }
    return true;
  }

  // ---------- desenho ----------
  let visiveis = [];
  function celulaCartao(r, c) {
    const s = r[c.id];
    const sel = s ? '<span class="sit ' + (CLASSE_SIT[s] || 'sit-alerta') + '">' + esc(s) + '</span>' : '<span class="sem-dado">sem cartão</span>';
    const alerta = r.alertas.some((a) => a.cartoes.includes(c.id)) ? ' <span class="cf-selo-alerta" title="Motorista avisou que este cartão está faltando">faltando</span>' : '';
    let ult = '';
    if (ultimas === null) ult = '<small class="cf-ult">…</small>';
    else if (!semColunaCartao && !erroBase) {
      const u = ultimaTransacao(r, c);
      ult = u ? '<small class="cf-ult" title="Última transação com este cartão">' + esc(fmtDia(u.dia) + horaDoDia(u.seg)) +
          '<span class="cf-ult-mot">' + esc(u.motorista) + '</span></small>'
        : '<small class="cf-ult cf-ult-nenhuma">sem transação</small>';
    }
    return sel + alerta + ult;
  }
  const ultimoUso = (r) => Math.max(0, ...CART.map((c) => (ultimaTransacao(r, c) || { t: 0 }).t));
  const valorOrdem = {
    placa: (r) => r.placa, unidade: (r) => r.unidade || '￿',
    ...Object.fromEntries(CART.map((c) => [c.id, (r) => (r[c.id] ? SIT.indexOf(r[c.id]) : 99)])),
    ultima: ultimoUso,
  };
  function desenhar() {
    const todas = linhas();
    // resumo (toda a planilha, sem os filtros)
    const conta = (s) => todas.reduce((n, r) => n + CART.filter((c) => r[c.id] === s).length, 0);
    const abertos = info.alertas.filter((a) => a.estado === 'aberto').length;
    const at = info.atualizadoEm ? new Date(info.atualizadoEm) : null;
    $('cf-resumo').innerHTML = [
      ['Placas', fmt.int(todas.length)], ['Avisos em aberto', fmt.int(abertos)],
      ...(todas.some((r) => r.foraCadastro) ? [['Fora do cadastro de placas', fmt.int(todas.filter((r) => r.foraCadastro).length)]] : []),
      ...SIT.map((s) => [s.charAt(0) + s.slice(1).toLowerCase(), fmt.int(conta(s))]),
      ['Lista atualizada em', at ? at.toLocaleDateString('pt-BR') + ' ' + at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'],
    ].map(([d, v]) => '<div><dt>' + esc(d) + '</dt><dd><span class="num">' + esc(v) + '</span></dd></div>').join('');

    const pend = info.alteracoes.filter(emAberto);
    const noExcel = pend.filter((a) => a.estado === 'aguardando').length;
    const gravadas = info.alteracoes.filter(semListaNova).length;
    const aviso = noExcel ? noExcel + (noExcel === 1 ? ' alteração espera' : ' alterações esperam') + ' a gravação.'
      : pend.length ? pend.length + (pend.length === 1 ? ' alteração sendo gravada' : ' alterações sendo gravadas') + '. A lista é atualizada logo em seguida.'
      : gravadas ? (gravadas === 1 ? 'Alteração gravada' : 'Alterações gravadas') + '. A lista é atualizada em instantes.' : '';
    $('cf-pendencias').classList.toggle('oculto', !aviso);
    $('cf-pendencias').innerHTML = aviso ? '<svg aria-hidden="true" class="girando"><use href="#i-atualizar"/></svg><span>' + esc(aviso) + '</span>' : '';

    $('cf-nota-base').textContent = !info.lista ? 'A lista ainda não está disponível; abra esta página de novo daqui a pouco.'
      : erroBase ? 'Não foi possível ler os abastecimentos para a última transação: ' + erroBase
      : semColunaCartao ? 'A última transação de cada cartão aparece depois da próxima atualização dos dados.'
      : ultimas === null ? 'Carregando a última transação de cada cartão…'
      : 'Embaixo de cada situação: a última transação com aquele cartão (data, hora e motorista).';

    const f = valorOrdem[estado.ordem.col];
    visiveis = todas.filter(passa).sort((a, b) => {
      const va = f(a), vb = f(b);
      const d = typeof va === 'number' ? va - vb : cmp(va, vb);
      return estado.ordem.dir * d || cmp(a.placa, b.placa);
    });
    $('cf-conta').textContent = visiveis.length + (visiveis.length === 1 ? ' placa' : ' placas');
    const th = (id, rotulo) => {
      const ativa = estado.ordem.col === id;
      return '<th aria-sort="' + (ativa ? (estado.ordem.dir > 0 ? 'ascending' : 'descending') : 'none') + '"><button type="button" data-col="' + id + '">' +
        esc(rotulo) + (ativa ? '<span class="seta">' + (estado.ordem.dir > 0 ? '▲' : '▼') + '</span>' : '') + '</button></th>';
    };
    $('cf-tabela').innerHTML = '<thead><tr>' + th('placa', 'Placa') + th('unidade', 'Unidade') + CART.map((c) => th(c.id, c.rotulo)).join('') +
      th('ultima', 'Último uso') + (editar ? '<th class="acoes-linha"><span>Ações</span></th>' : '') + '</tr></thead><tbody>' +
      (visiveis.length ? visiveis.map((r, i) => {
        const p = r._pendente;
        const selo = p ? '<span class="selo-pendente" title="' + esc(p.estado === 'aplicada' ? 'Gravada; a lista é atualizada em instantes' : NOME_ESTADO[p.estado]) + '">' +
          (p.estado === 'aguardando' ? 'aguardando' : p.estado === 'aplicada' ? 'gravada, atualizando lista' : 'aguardando gravação') + '</span>' : '';
        const ult = ultimoUso(r);
        return '<tr' + (r.alertas.length ? ' class="cf-linha-alerta"' : r._entrando ? ' class="linha-apagada"' : '') + '>' +
          '<td><strong>' + esc(r.placa) + '</strong>' + selo +
            (r._entrando ? '<span class="selo-pendente" title="Placa ativa no cadastro de placas; entra na lista dos cartões em instantes">entrando no controle</span>' : '') +
            (r.foraCadastro ? '<small class="cidade-linha cf-fora" title="Esta placa não está no cadastro de placas. Ela fica no controle até ser cadastrada.">fora do cadastro de placas</small>' : '') + '</td>' +
          '<td>' + (r.unidade ? esc(r.unidade) : '<span class="sem-dado">—</span>') + '</td>' +
          CART.map((c) => '<td class="cf-cel">' + celulaCartao(r, c) + '</td>').join('') +
          '<td>' + (ult ? '<span class="num">' + esc(fmtDia(Math.floor(ult / 86400))) + '</span>' : '<span class="sem-dado">—</span>') + '</td>' +
          (editar ? '<td class="acoes-linha">' + ((r._novo && emAberto(r._pendente)) || r._entrando ? '<span class="sem-dado">aguardando</span>'
            : '<button type="button" class="btn-linha" data-editar="' + i + '">Editar</button>') + '</td>' : '') + '</tr>';
      }).join('') : '<tr><td colspan="' + (CART.length + 4) + '"><div class="vazio">Nenhuma placa com esses filtros.</div></td></tr>') + '</tbody>';
    desenharAlertas();
    if (editar) desenharHistorico();
  }

  // ---------- avisos dos motoristas ----------
  function desenharAlertas() {
    const abertos = info.alertas.filter((a) => a.estado === 'aberto');
    const resolvidos = info.alertas.filter((a) => a.estado === 'resolvido');
    const caixa = $('cf-alertas');
    caixa.classList.toggle('oculto', !abertos.length && !resolvidos.length);
    const item = (a) => {
      const naLista = (info.lista || []).some((r) => mesmaPlaca(r, a.placa));
      return '<li class="cf-alerta' + (a.estado === 'resolvido' ? ' cf-alerta-resolvido' : '') + '">' +
        '<div class="cf-alerta-txt"><strong>' + esc(a.placa) + ' · falta ' + esc(a.cartoes.map((c) => rotuloCartao[c] || c).join(', ')) + '</strong>' +
        '<small>' + esc('Aviso de ' + a.motorista + (a.telefone ? ' (' + a.telefone + ')' : '') + ' em ' + quando(a.criado_em)) +
          (naLista ? '' : ' · placa fora da lista dos cartões') + '</small>' +
        (a.observacao ? '<small class="cf-alerta-obs">“' + esc(a.observacao) + '”</small>' : '') +
        (a.estado === 'resolvido' ? '<small>' + esc('Resolvido por ' + (a.resolvido_por || '—') + ' em ' + quando(a.resolvido_em)) + '</small>' : '') + '</div>' +
        (editar ? '<div class="cf-alerta-acoes">' + (a.estado === 'aberto'
          ? '<button type="button" class="btn-linha" data-alerta-editar="' + a.id + '">Atualizar situação</button>' +
            '<button type="button" class="btn-linha btn-linha-bom" data-alerta-resolver="' + a.id + '">Resolver</button>'
          : '<button type="button" class="btn-linha" data-alerta-reabrir="' + a.id + '">Reabrir</button>') + '</div>' : '') + '</li>';
    };
    caixa.innerHTML = '<div class="painel-cab"><h2 id="cf-alertas-titulo">' + (abertos.length
      ? '<svg aria-hidden="true" class="cf-sino"><use href="#i-alerta"/></svg>' + abertos.length + (abertos.length === 1 ? ' aviso de cartão faltando' : ' avisos de cartão faltando')
      : 'Avisos dos motoristas') + '</h2>' +
      (resolvidos.length ? '<button type="button" class="btn" id="cf-ver-resolvidos" aria-pressed="' + estado.verResolvidos + '">' +
        (estado.verResolvidos ? 'Esconder resolvidos' : 'Ver resolvidos (' + resolvidos.length + ')') + '</button>' : '') + '</div>' +
      (abertos.length ? '<ul class="cf-lista-alertas">' + abertos.map(item).join('') + '</ul>' : '<p class="nota">Nenhum aviso em aberto.</p>') +
      (estado.verResolvidos && resolvidos.length ? '<h3 class="cf-sub">Resolvidos nos últimos 30 dias</h3><ul class="cf-lista-alertas">' + resolvidos.map(item).join('') + '</ul>' : '');
  }
  async function mudarAlerta(id, acao, botao) {
    botao.disabled = true;
    try {
      const r = await fetch('/api/cartoes/alertas/' + id, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { location.href = '/?entrar=1'; return; }
      if (!r.ok) throw new Error(j.erro || 'Não foi possível salvar.');
      Object.assign(info.alertas.find((a) => a.id === id), j.alerta);
      avisarMenu();
      desenhar();
    } catch (e) {
      botao.disabled = false;
      const p = $('cf-pendencias');
      p.classList.remove('oculto');
      p.innerHTML = '<span>' + esc(e.message === 'Failed to fetch' ? 'Sem conexão com o servidor.' : e.message) + '</span>';
    }
  }
  $('cf-alertas').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'cf-ver-resolvidos') { estado.verResolvidos = !estado.verResolvidos; desenharAlertas(); return; }
    if (b.dataset.alertaResolver) { mudarAlerta(Number(b.dataset.alertaResolver), 'resolver', b); return; }
    if (b.dataset.alertaReabrir) { mudarAlerta(Number(b.dataset.alertaReabrir), 'reabrir', b); return; }
    if (b.dataset.alertaEditar) {
      const a = info.alertas.find((x) => x.id === Number(b.dataset.alertaEditar));
      const r = linhas().find((x) => mesmaPlaca(x, a.placa));
      abrir(r && !(r._novo && emAberto(r._pendente)) && !r._entrando ? r : null, a);
    }
  });

  // ---------- histórico ----------
  function desenharHistorico() {
    const alt = info.alteracoes;
    $('cf-conta-hist').textContent = alt.length ? fmt.int(alt.length) + ' mais recentes' : '';
    $('cf-historico').innerHTML = alt.length
      ? '<thead><tr><th><span>Quando</span></th><th><span>Quem</span></th><th><span>Placa</span></th><th><span>Alteração</span></th><th><span>Gravação</span></th></tr></thead><tbody>' +
        alt.map((a) => {
          const cls = a.estado === 'aplicada' ? 'selo-ok' : a.estado === 'erro' ? 'selo-bloq' : 'selo-espera';
          // troca do nome da placa (ex.: antiga -> Mercosul, 13/11/2026) + mudanças de situação dos cartões
          const trocaPlaca = a.acao === 'editar' && a.dados.placa ? 'Placa: ' + a.chave + ' → ' + a.dados.placa + (Object.keys(a.dados).length > 1 ? '; ' : '') : '';
          const txt = (a.acao === 'adicionar' ? 'Placa nova. ' : '') + trocaPlaca + Object.entries(a.dados).filter(([k]) => rotuloCartao[k])
            .map(([k, v]) => rotuloCartao[k] + ': ' + (a.acao === 'editar' ? ((a.antes || {})[k] || 'sem cartão') + ' → ' : '') + (v || 'sem cartão')).join('; ');
          return '<tr><td>' + esc(quando(a.criado_em)) + '</td><td>' + esc(a.usuario_nome) + '</td><td><strong>' + esc(a.chave) + '</strong></td>' +
            '<td class="trunc">' + esc(txt || '—') + '</td>' +
            '<td><span class="selo ' + cls + '">' + esc(NOME_ESTADO[a.estado]) + (a.linha ? ' (linha ' + a.linha + ')' : '') + '</span>' +
              (a.mensagem && a.estado !== 'aplicada' ? '<small class="cidade-linha">' + esc(a.mensagem) + '</small>' : '') + '</td></tr>';
        }).join('') + '</tbody>'
      : '<tbody><tr><td><div class="vazio">Nenhuma alteração feita pelo portal ainda.</div></td></tr></tbody>';
  }

  // ---------- formulário (situação dos cartões de uma placa, ou placa nova) ----------
  let editando = null;
  const opcao = (v, txt, sel) => '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(txt) + '</option>';
  function abrir(r, alerta) {
    editando = r;
    form.reset();
    $('cf-erro').classList.add('oculto');
    $('cf-campo-placa').hidden = !!r;
    $('cf-dlg-titulo').textContent = r ? 'Cartões da placa ' + r.placa : 'Adicionar placa';
    $('cf-salvar').textContent = r ? 'Salvar' : 'Adicionar placa';
    $('cf-dlg-explica').textContent = (alerta ? 'Aviso de ' + alerta.motorista + ': falta ' + alerta.cartoes.map((c) => rotuloCartao[c]).join(', ') + '. ' : '') +
      (r ? 'Só os cartões que você mudar são gravados' + (r.linha ? ' (linha ' + r.linha + ' da aba CARTÕES)' : '') + '.'
        : 'Placas do cadastro de placas (ativas, de cavalo, truck, toco, bitruck e 3/4) entram e saem sozinhas. ' +
          'Use aqui só para caminhão que ainda não está no cadastro; ele entra no fim da aba CARTÕES.');
    for (const c of CART) {
      const atual = r ? r[c.id] || '' : (alerta && alerta.cartoes.includes(c.id) ? 'AGUARDANDO ENVIO' : 'ATIVO');
      form[c.id].innerHTML = opcao('', '— sem cartão —', !atual) + (atual && !SIT.includes(atual) ? opcao(atual, atual + ' (atual)', true) : '') +
        SIT.map((s) => opcao(s, s, s === atual)).join('');
    }
    if (!r) form.placa.value = alerta ? alerta.placa : '';
    dlg.showModal();
    (r ? form[CART[0].id] : form.placa).focus();
  }
  if (editar) $('cf-adicionar').addEventListener('click', () => abrir(null));
  $('cf-cancelar').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('cf-erro');
    const falha = (t) => { erro.textContent = t; erro.classList.remove('oculto'); };
    const placa = editando ? editando.placa : normPlaca(form.placa.value);
    if (!editando && !/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(placa)) { falha('Placa inválida (ex.: ABC1D23 ou ABC1234).'); form.placa.focus(); return; }
    const dados = {};
    for (const c of CART) if (!editando || form[c.id].value !== (editando[c.id] || '')) dados[c.id] = form[c.id].value;
    if (!Object.keys(dados).length) { falha('Nada foi alterado.'); return; }
    const btn = $('cf-salvar'), rotulo = btn.textContent;
    btn.disabled = true; btn.textContent = 'Salvando…';
    try {
      const r = await fetch('/api/cartoes', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: editando ? 'editar' : 'adicionar', chave: placa, dados }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { location.href = '/?entrar=1'; return; }
      if (!r.ok) { falha(j.erro || 'Não foi possível salvar. Tente de novo.'); return; }
      info.alteracoes.unshift({ ...j.alteracao, mensagem: null, linha: null, aplicada_em: null });
      dlg.close();
      desenhar();
      acompanhar();
    } catch (err) {
      falha('Sem conexão com o servidor. Verifique a internet e tente de novo.');
    } finally {
      btn.disabled = false; btn.textContent = rotulo;
    }
  });

  // ---------- acompanha a gravação (10 s) e confere avisos novos dos motoristas (2 min) ----------
  let tAcomp = null;
  const esperandoLista = (a) => semListaNova(a) && Date.now() - Date.parse(a.aplicada_em) < 15 * 60 * 1000;
  function acompanhar() {
    clearTimeout(tAcomp);
    const rapido = info.alteracoes.some((a) => emAberto(a) || esperandoLista(a));
    tAcomp = setTimeout(async () => {
      if (!document.hidden && !dlg.open) { try { await carregar(); desenhar(); } catch (e) {} }
      acompanhar();
    }, rapido ? 10 * 1000 : 2 * 60 * 1000);
  }

  $('cf-tabela').addEventListener('click', (e) => {
    const col = e.target.closest('[data-col]');
    if (col) {
      const id = col.dataset.col;
      estado.ordem = estado.ordem.col === id ? { col: id, dir: -estado.ordem.dir } : { col: id, dir: id === 'ultima' ? -1 : 1 };
      desenhar();
      const novo = $('cf-tabela').querySelector('[data-col="' + id + '"]');
      if (novo) novo.focus();
      return;
    }
    const b = e.target.closest('[data-editar]');
    if (b) abrir(visiveis[Number(b.dataset.editar)]);
  });
  $('cf-busca').addEventListener('input', (e) => { estado.busca = e.target.value; desenhar(); });
  for (const [id, campo] of [['cf-unidade', 'unidade'], ['cf-cartao', 'cartao'], ['cf-situacao', 'situacao']]) {
    $(id).addEventListener('change', (e) => { estado[campo] = e.target.value; desenhar(); });
  }
  desenhar();
  acompanhar();
  return { desmontar() { clearTimeout(tAcomp); if (dlg.open) dlg.close(); } };
}
