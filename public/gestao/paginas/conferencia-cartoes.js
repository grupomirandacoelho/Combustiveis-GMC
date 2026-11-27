// Operacional > Conferência com os cartões: o que a Ticket e a TruckPag mostram hoje (últimos 45 dias) comparado com a
// Base_copia, levando em conta as correções feitas no portal (functions/api/conferencia-cartoes). Nada é aplicado sozinho:
//  - Alterado no cartão: mudou lá e não foi corrigido aqui -> "Aplicar o do cartão" grava daqui (troca de placa abre o Editar);
//  - Conflito: corrigido aqui e o cartão também mudou para outro valor -> escolher (aplicar o do cartão ou manter o nosso);
//  - Falta na Base_copia: está no cartão e não na planilha -> "Incluir" (o vigia grava pelo mesmo lote do D-1) ou ignorar;
//  - Sumiu do cartão: está na planilha e a API não traz mais -> abrir no Editar (para excluir) ou manter;
//  - Corrigido no portal: o cartão continua com o valor original e a Base_copia com a correção (não é erro, só informação).
import { fmt, esc } from '../lib/dados.js';
import { normFuel, normKey, chaveCadeia } from '../lib/consolidador.js';
import { seloCartao } from '../lib/cartoes.js';
import { botoesMaisMenos } from '../lib/filtros.js';

const ROTULO = { F: 'Placa', Q: 'Hodômetro', O: 'Litros', T: 'Valor' };
const ABAS = [
  ['cartao', 'Alterado no cartão'], ['conflito', 'Conflito'], ['falta', 'Falta no portal'],
  ['sumiu', 'Sumiu do cartão'], ['corrigido', 'Corrigido no portal'], ['mantido', 'Mantidos'],
];
const NOME_PEDIDO = { pendente: 'Inclusão pedida, aguardando gravação', feito: 'Incluído', duplicado: 'Já estava no portal', erro: 'Não incluído' };

async function chamar(metodo, corpo) {
  const r = await fetch('/api/conferencia-cartoes', {
    method: metodo, credentials: 'same-origin', cache: 'no-store',
    ...(corpo ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) } : {}),
  });
  if (r.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Não foi possível ' + (corpo ? 'salvar' : 'carregar') + ' (' + r.status + ').');
  return j;
}
const valor = (col, v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (col === 'F') return esc(v);
  if (col === 'Q') return fmt.int(v);
  if (col === 'O') return fmt.d2(v);
  return fmt.moeda(v);
};
const fmtQuando = (q) => (q ? q.slice(8, 10) + '/' + q.slice(5, 7) + '/' + q.slice(0, 4) + ' ' + q.slice(11, 16) : '—');
const fmtIso = (iso) => { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleDateString('pt-BR') + ' às ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
const selo = (c) => seloCartao(c);
// falta e sumiu resolvidos (ignorados, mantidos ou com inclusão pedida) vão para "Mantidos"
const abaDe = (i) => ((i.classe === 'falta' || i.classe === 'sumiu') && (i.decisao || (i.pedido && i.pedido.estado !== 'erro')) ? 'mantido' : i.classe);

// chaves de decisão de um item: as que ainda não têm decisão e as já decididas (corrigido no portal não precisa de decisão)
const pendentes = (i) => (i.campos ? i.campos.filter((c) => !c.decisao && c.classe !== 'corrigido').map((c) => c.chave) : i.decisao ? [] : [i.chave]);
const decididas = (i) => (i.campos ? i.campos.filter((c) => c.decisao).map((c) => c.chave) : i.decisao ? [i.chave] : []);
const sufixo = (n) => n + (n === 1 ? ' abastecimento' : ' abastecimentos');
const TODOS = {
  cartao: { rotulo: 'Manter o nosso em todos', acao: 'manter', pergunta: (n) => 'Manter o valor do portal em ' + sufixo(n) + ' de "Alterado no cartão"? Eles vão para "Mantidos", onde dá para desfazer.' },
  conflito: { rotulo: 'Manter o nosso em todos', acao: 'manter', pergunta: (n) => 'Manter o valor do portal em ' + sufixo(n) + ' de "Conflito"? Eles vão para "Mantidos", onde dá para desfazer.' },
  falta: { rotulo: 'Ignorar todos', acao: 'manter', pergunta: (n) => 'Ignorar ' + sufixo(n) + ' de "Falta no portal"? Eles vão para "Mantidos", onde dá para desfazer.' },
  sumiu: { rotulo: 'Manter todos', acao: 'manter', pergunta: (n) => 'Manter no portal ' + sufixo(n) + ' de "Sumiu do cartão"? Eles vão para "Mantidos", onde dá para desfazer.' },
  mantido: { rotulo: 'Desfazer todos', acao: 'desfazer', pergunta: (n) => 'Desfazer a decisão de ' + sufixo(n) + '? Eles voltam para as abas de origem.' },
};

// ---------- "Aplicar o do cartão" direto daqui: grava a correção na Base_copia pela mesma API do Editar abastecimentos,
// com as mesmas contas: hodômetro novo refaz KM rodados e KM/litro desta linha (pelo anterior da mesma placa e
// combustível) e da próxima; litros novos refazem o KM/litro e, sem valor do cartão, o valor total (litros × V/litro).
// Troca de placa continua indo para o Editar (mexe na sequência de duas placas e pede conferência).
const CAMPO = { F: 'placa', O: 'litros', P: 'vl', Q: 'hodo', R: 'km', S: 'kml', T: 'valor' };
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const limpa = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
let listaBase = null;   // /gestao/dados/base-copia.json (carregada no primeiro "Aplicar")
async function buscarJson(url, oque) {
  const r = await fetch(url, { credentials: 'same-origin', cache: url.startsWith('/api/') ? 'no-store' : 'default' });
  if (r.status === 401 || r.redirected) { location.href = '/?entrar=1'; throw new Error('sessão'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Não foi possível carregar ' + oque + ' (' + r.status + ').');
  return j;
}
async function correcaoDoCartao(item, valores) {
  if (!listaBase) listaBase = await buscarJson('/gestao/dados/base-copia.json', 'a lista dos abastecimentos');
  const { alteracoes } = await buscarJson('/api/base-copia', 'as correções salvas');
  const L = listaBase, c = L.col, D = L.dic, txt = (k, i) => (c[k][i] === null ? null : D[k][c[k][i]]);
  // correções salvas que a lista ainda não traz (como no Editar): ficam por cima dos valores da planilha
  const sobre = new Map(), excl = new Set();
  for (const a of [...alteracoes].sort((x, y) => x.id - y.id)) {
    if (!(a.estado === 'pendente' || a.estado === 'aguardando' || (a.estado === 'aplicada' && a.aplicada_em > L.geradoEm))) continue;
    if (a.acao === 'excluir') excl.add(a.linha); else sobre.set(a.linha, { ...(sobre.get(a.linha) || {}), ...a.celulas });
  }
  const linhas = [];
  for (let i = 0; i < c.linha.length; i++) {
    if (excl.has(c.linha[i])) continue;
    const l = { linha: c.linha[i], serial: c.dt[i], placaLista: txt('placa', i) || '', placa: txt('placa', i) || '', fuel: txt('fuel', i) || '',
      litros: c.litros[i], vl: c.vl[i], hodo: c.hodo[i], km: c.km[i], kml: c.kml[i], valor: c.valor[i] };
    for (const [k, v] of Object.entries(sobre.get(l.linha) || {})) if (CAMPO[k]) l[CAMPO[k]] = v;
    linhas.push(l);
  }
  const [pl, mi] = String(item.chave || '').split('|');
  const bate = (l) => !!l && limpa(l.placaLista) === pl && Math.round(l.serial * 1440) === Number(mi);
  const l = linhas.find((x) => x.linha === item.linha && bate(x)) || linhas.find(bate);
  if (!l) throw new Error('Não encontrei este abastecimento (pode ter sido excluído). Use "Abrir no Editar".');
  const cadeia = (x) => normKey(x.placa) + '§' + chaveCadeia(normFuel(x.fuel)[0] || '');
  const seq = linhas.filter((x) => cadeia(x) === cadeia(l)).sort((a, b) => a.serial - b.serial || a.linha - b.linha);
  const k = seq.indexOf(l), ant = seq[k - 1] || null, prox = seq[k + 1] || null;
  const novo = { ...l }, cel = {}, antes = {};
  const por = (col, v) => {
    const atual = l[CAMPO[col]] ?? null;
    if (v === atual || (typeof v === 'number' && typeof atual === 'number' && Math.abs(v - atual) < 1e-9)) return;
    cel[col] = v; antes[col] = atual; novo[CAMPO[col]] = v;
  };
  if ('Q' in valores) por('Q', valores.Q);
  if ('O' in valores) por('O', valores.O);
  if ('T' in valores) por('T', valores.T);
  else if ('O' in cel && typeof novo.vl === 'number' && typeof novo.litros === 'number') por('T', r6(novo.litros * novo.vl));
  if ('Q' in cel && ant && typeof ant.hodo === 'number' && typeof novo.hodo === 'number') por('R', novo.hodo - ant.hodo);
  if (('Q' in cel || 'O' in cel) && typeof novo.km === 'number') por('S', novo.litros > 0 ? r6(novo.km / novo.litros) : null);
  if (!Object.keys(cel).length) throw new Error('O portal já está com o valor do cartão; esta linha some na próxima conferência.');
  // KM impossível com o valor do cartão (negativo ou mais de 3.000 km): quase sempre é o cartão que está errado
  const estranho = (km) => typeof km === 'number' && (km < 0 || km > 3000);
  const alertas = [];
  if ('R' in cel && estranho(cel.R)) alertas.push('⚠ Com esse valor o KM rodado deste abastecimento fica ' + fmt.int(cel.R) + ' km.');
  const itens = [{ linha: l.linha, placa: l.placaLista, data: l.serial, acao: 'editar', celulas: cel, antes }];
  const proxima = [];
  if ('Q' in cel && prox && typeof prox.hodo === 'number') {
    const km = prox.hodo - novo.hodo, kml = prox.litros > 0 ? r6(km / prox.litros) : null, c2 = {}, a2 = {};
    if (km !== prox.km) { c2.R = km; a2.R = prox.km ?? null; }
    if (kml !== (prox.kml ?? null)) { c2.S = kml; a2.S = prox.kml ?? null; }
    if (Object.keys(c2).length) {
      itens.push({ linha: prox.linha, placa: prox.placaLista, data: prox.serial, acao: 'editar', celulas: c2, antes: a2 });
      proxima.push('KM rodados do abastecimento seguinte desta placa: ' + fmt.int(prox.km) + ' → ' + fmt.int(km));
      if (estranho(km)) alertas.push('⚠ E o do abastecimento seguinte fica ' + fmt.int(km) + ' km.');
    }
  }
  if (alertas.length) alertas.push('Confira se o valor do cartão está certo antes de aplicar (se o nosso estiver certo, use "Manter o nosso").');
  return { itens, novo, proxima, alertas };
}

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando a conferência com os cartões…</div>';
  let d;
  try { d = await chamar('GET'); } catch (e) {
    if (e.message !== 'sessão') pagina.innerHTML = '<div class="vazio">' + esc(e.message) + '</div>';
    return {};
  }
  let aba = (ABAS.find(([k]) => d.contagem[k]) || ABAS[0])[0];
  let ocupado = false;
  // 25 abastecimentos por vez ("Mostrar mais"); volta aos 25 primeiros ao trocar de aba
  const PASSO = 25;
  let limite = PASSO;

  pagina.innerHTML = `
    <section class="painel painel-tabela">
      <div class="painel-cab"><div class="segmentado" id="cc-abas" role="group" aria-label="Situação"></div><span class="cc-cab-dir"><span class="conta" id="cc-conta"></span><button type="button" class="btn oculto" id="cc-todos"></button></span></div>
      <div class="tabela-rolagem cc-rolagem"><table class="dados cc-tabela" id="cc-tabela"></table></div>
      <div id="cc-mais"></div>
    </section>`;
  const el = (id) => pagina.querySelector('#' + id);

  function desenhar() {
    const n = d.contagem;
    el('cc-abas').innerHTML = ABAS.map(([k, r]) => '<button type="button" data-aba="' + k + '" aria-pressed="' + (k === aba) + '">' + r +
      (n[k] ? ' (' + fmt.int(n[k]) + ')' : '') + '</button>').join('');
    const itens = d.itens.filter((i) => abaDe(i) === aba);
    el('cc-conta').textContent = itens.length ? fmt.int(itens.length) + (itens.length === 1 ? ' abastecimento' : ' abastecimentos') : '';
    const todos = TODOS[aba];
    el('cc-todos').textContent = todos ? todos.rotulo : '';
    el('cc-todos').classList.toggle('oculto', !(todos && d.podeEditar && itens.some((i) => (todos.acao === 'desfazer' ? decididas : pendentes)(i).length)));
    el('cc-todos').disabled = false;
    el('cc-mais').innerHTML = botoesMaisMenos(itens.length, limite, PASSO);
    if (!itens.length) { el('cc-tabela').innerHTML = '<tbody><tr><td class="vazio">Nada nesta situação.</td></tr></tbody>'; return; }
    // placa, cartão e data numa coluna só; as ações ficam presas na borda direita (e embaixo do cartão no celular)
    el('cc-tabela').innerHTML = '<thead><tr><th>Abastecimento</th><th>Estabelecimento</th><th>Diferença</th><th class="cc-acoes"><span class="sr">Ações</span></th></tr></thead><tbody>' +
      itens.slice(0, limite).map((i) => '<tr data-i="' + d.itens.indexOf(i) + '"><td class="cc-abast"><strong>' + esc(i.placa) + '</strong> ' + selo(i.cartao) +
        '<div class="nota num">' + fmtQuando(i.quando) + '</div></td><td class="cc-posto">' + esc(i.posto || '') + (i.motorista ? '<div class="nota">' + esc(i.motorista) + '</div>' : '') +
        '</td><td class="cc-dif">' + diferenca(i) + '</td><td class="cc-acoes">' + acoes(i) + '</td></tr>').join('') + '</tbody>';
  }

  function diferenca(i) {
    if (i.classe === 'falta') {
      const v = i.cartaoVals || {};
      return '<span class="cc-campo">' + (i.combustivel ? esc(i.combustivel) + ' · ' : '') + valor('O', v.O) + ' L · hodômetro ' + valor('Q', v.Q) + ' · ' + valor('T', v.T) + '</span>' +
        (i.pedido ? '<div class="nota">' + esc(NOME_PEDIDO[i.pedido.estado] || i.pedido.estado) + (i.pedido.mensagem ? ': ' + esc(i.pedido.mensagem) : '') + '</div>' : '') +
        (i.decisao ? '<div class="nota">Ignorado por ' + esc(i.decisao.usuario_nome || '—') + '</div>' : '');
    }
    if (i.classe === 'sumiu') {
      const v = i.nossos || {};
      return '<span class="cc-campo">No portal (linha ' + fmt.int(i.linha) + '): ' + (i.combustivel ? esc(i.combustivel) + ' · ' : '') + valor('O', v.O) + ' L · hodômetro ' +
        valor('Q', v.Q) + ' · ' + valor('T', v.T) + '</span>' + (i.decisao ? '<div class="nota">Mantido por ' + esc(i.decisao.usuario_nome || '—') + '</div>' : '');
    }
    return i.campos.map((c) => {
      const tit = '<b>' + ROTULO[c.col] + '</b> ';
      let t;
      if (c.classe === 'conflito') t = 'original ' + valor(c.col, c.original) + ' · nosso ' + valor(c.col, c.nosso) + ' · cartão <b>' + valor(c.col, c.cartao) + '</b>';
      else if (c.classe === 'corrigido') t = 'cartão ' + valor(c.col, c.cartao) + ' → corrigido para <b>' + valor(c.col, c.nosso) + '</b>';
      else t = valor(c.col, c.nosso) + ' → cartão <b>' + valor(c.col, c.cartao) + '</b>';
      return '<div class="cc-campo' + (c.decisao ? ' cc-decidido' : '') + '">' + tit + t + (c.decisao ? ' <span class="nota">(mantido o nosso por ' + esc(c.decisao.usuario_nome || '—') + ')</span>' : '') + '</div>';
    }).join('');
  }

  function linkAplicar(i, valores) {
    const p = new URLSearchParams({ aplicar: String(i.linha), ch: i.chave });
    for (const [c, v] of Object.entries(valores || {})) p.set('v' + c, v === null || v === undefined ? '' : String(v));
    return '#/abastecimentos?' + p.toString();
  }
  function acoes(i) {
    const b = [];
    if (i.classe === 'cartao' || i.classe === 'conflito') {
      const ativos = i.campos.filter((c) => !c.decisao && c.classe !== 'corrigido');
      // troca de placa: no Editar (a sequência de duas placas muda); o resto grava daqui mesmo
      if (d.podeAplicar && ativos.some((c) => c.col === 'F')) b.push('<a class="btn btn-principal" href="' + esc(linkAplicar(i, Object.fromEntries(ativos.map((c) => [c.col, c.cartao])))) + '" title="Troca de placa: confira a sequência no Editar abastecimentos">Aplicar no Editar</a>');
      else if (d.podeAplicar && ativos.length) b.push('<button type="button" class="btn btn-principal" data-aplicar>Aplicar o do cartão</button>');
      if (d.podeEditar) b.push('<button type="button" class="btn" data-manter>Manter o nosso</button>');
    } else if (i.classe === 'falta' && abaDe(i) === 'falta') {
      if (d.podeEditar) b.push('<button type="button" class="btn btn-principal" data-incluir>Incluir no portal</button><button type="button" class="btn" data-manter>Ignorar</button>');
    } else if (i.classe === 'sumiu' && abaDe(i) === 'sumiu') {
      if (d.podeAplicar) b.push('<a class="btn" href="' + esc(linkAplicar(i)) + '">Abrir no Editar</a>');
      if (d.podeEditar) b.push('<button type="button" class="btn" data-manter>Manter</button>');
    } else if (abaDe(i) === 'mantido' && d.podeEditar && (i.decisao || (i.campos || []).some((c) => c.decisao))) {
      b.push('<button type="button" class="btn" data-desfazer>Desfazer</button>');
    }
    return b.join('');
  }

  async function recarregar() {
    d = await chamar('GET');
    window.dispatchEvent(new CustomEvent('conferencia-cartoes', { detail: d.pendentes }));
    desenhar();
  }
  async function fazer(botao, corpos) {
    if (ocupado) return;
    ocupado = true;
    botao.disabled = true;
    try {
      for (const c of corpos) await chamar('POST', c);
      await recarregar();
    } catch (e) {
      if (e.message !== 'sessão') ctx.aviso ? ctx.aviso(e.message) : alert(e.message);
      botao.disabled = false;
    } finally { ocupado = false; }
  }

  // "Aplicar o do cartão": monta a correção (com KM rodados e KM/litro refeitos), confirma e grava na fila da Base_copia
  const NOME_COL = { Q: 'Hodômetro', O: 'Litros', T: 'Valor total', R: 'KM rodados', S: 'KM/litro' };
  const fmtCol = (col, v) => (v === null || v === undefined ? '—' : col === 'Q' || col === 'R' ? fmt.int(v) : col === 'T' ? fmt.moeda(v) : fmt.d2(v));
  async function aplicar(botao, i) {
    if (ocupado) return;
    const valores = Object.fromEntries(i.campos.filter((c) => !c.decisao && c.classe !== 'corrigido').map((c) => [c.col, c.cartao]));
    const rotulo = botao.textContent;
    ocupado = true; botao.disabled = true; botao.textContent = 'Preparando…';
    const voltar = () => { botao.disabled = false; botao.textContent = rotulo; };
    try {
      const r = await correcaoDoCartao(i, valores);
      const it = r.itens[0];
      const mudancas = Object.entries(it.celulas).map(([col, v]) => (NOME_COL[col] || col) + ': ' + fmtCol(col, it.antes[col]) + ' → ' + fmtCol(col, v));
      if (!await confirmar((r.alertas.length ? r.alertas.join('\n') + '\n\n' : '') + 'Aplicar o valor do cartão em ' + i.placa + ' (' + fmtQuando(i.quando) + ')?\n\n' + mudancas.concat(r.proxima).join('\n') +
        '\n\nA gravação leva alguns instantes.')) { voltar(); return; }
      botao.textContent = 'Gravando…';
      const resp = await fetch('/api/base-copia', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itens: r.itens }) });
      if (resp.status === 401) { location.href = '/?entrar=1'; return; }
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(j.erro || 'Não foi possível gravar a correção (' + resp.status + ').');
      if (ctx.aviso) ctx.aviso('Correção gravada: ' + i.placa + ' fica com o valor do cartão em instantes.');
      await recarregar();
    } catch (e) {
      if (e.message !== 'sessão') { if (ctx.aviso) ctx.aviso(e.message); else alert(e.message); }
      voltar();
    } finally { ocupado = false; }
  }

  el('cc-mais').addEventListener('click', (e) => {
    if (e.target.closest('[data-mais]')) { limite += PASSO; desenhar(); }
    else if (e.target.closest('[data-menos]')) { limite = PASSO; desenhar(); el('cc-tabela').scrollIntoView({ block: 'start' }); }
  });
  el('cc-abas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-aba]');
    if (!b) return;
    aba = b.dataset.aba;
    limite = PASSO;
    desenhar();
  });
  // botão do topo: a ação de cada linha em todas as linhas da aba de uma vez (a API aceita 200 chaves por chamada)
  el('cc-todos').addEventListener('click', async (e) => {
    const todos = TODOS[aba];
    if (!todos) return;
    const itens = d.itens.filter((i) => abaDe(i) === aba);
    const chaves = itens.flatMap(todos.acao === 'desfazer' ? decididas : pendentes);
    const n = itens.filter((i) => (todos.acao === 'desfazer' ? decididas : pendentes)(i).length).length;
    if (!chaves.length || !await confirmar(todos.pergunta(n))) return;
    const lotes = [];
    for (let k = 0; k < chaves.length; k += 200) lotes.push({ acao: todos.acao, chaves: chaves.slice(k, k + 200) });
    fazer(e.currentTarget, lotes);
  });
  el('cc-tabela').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    const tr = b && b.closest('tr[data-i]');
    if (!tr) return;
    const i = d.itens[Number(tr.dataset.i)];
    if (b.hasAttribute('data-aplicar')) {
      aplicar(b, i);
      return;
    }
    if (b.hasAttribute('data-manter')) {
      const chaves = i.campos ? i.campos.filter((c) => !c.decisao).map((c) => c.chave) : [i.chave];
      fazer(b, [{ acao: 'manter', chaves }]);
    } else if (b.hasAttribute('data-incluir')) {
      fazer(b, [{ acao: 'incluir', itens: [{ id: i.id, dia: i.dia, placa: i.placa, quando: i.quando }] }]);
    } else if (b.hasAttribute('data-desfazer')) {
      const chaves = i.campos ? i.campos.filter((c) => c.decisao).map((c) => c.chave) : [i.chave];
      fazer(b, [{ acao: 'desfazer', chaves }]);
    }
  });

  ctx.definirSub('Conferido em ' + fmtIso(d.geradoEm) + ', transações de ' + fmtQuando(d.desde + ' 00:00').slice(0, 10) + ' a ' + fmtQuando(d.ate + ' 00:00').slice(0, 10) +
    (d.lidos ? ' (' + fmt.int(d.lidos) + ' lidas da Ticket e da TruckPag)' : '') + '. Nada é alterado sem a sua confirmação.');
  desenhar();
  window.dispatchEvent(new CustomEvent('conferencia-cartoes', { detail: d.pendentes }));
  return {};
}