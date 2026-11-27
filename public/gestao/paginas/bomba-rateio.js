// Bomba interna > Rateio das NFs: cada nota de compra (Movimentações) é consumida pelos abastecimentos da bomba em ordem
// (lib/rateio.js, a mesma conta do vigia, que também lança o preço da nota nos abastecimentos).
// Quem edita confere cada nota fechada (data e hora, placa, motorista, litros, R$/L, valor e centro de custo, que pode
// ser corrigido) e valida; a foto validada é o rateio que o fiscal vê, baixa e marca como conferido.
import { esc } from '../lib/dados.js';
import { NOME_TANQUE, COMBUSTIVEL_DO_TANQUE } from '../lib/bomba.js';
import { ratear, agruparCC } from '../lib/rateio.js';
import { OUTPUT_HEADERS } from '../lib/consolidador.js';
import { planilhaRateio } from '../lib/xlsx-rateio.js';
import { ligarMenu } from '../lib/baixar.js';

async function obter(url) {
  const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (r.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Não foi possível carregar (' + r.status + ').');
  return j;
}
async function postar(corpo) {
  const r = await fetch('/api/bomba/rateio', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  if (r.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Não foi possível salvar.');
  return j;
}
const num = (v, c = 0) => (v === null || v === undefined || !isFinite(v) ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c }));
const p2 = (x) => String(x).padStart(2, '0');
const msDoQuando = (q) => { const [a, m, d, h, mi, s] = String(q).match(/\d+/g).map(Number); return Date.UTC(a, m - 1, d, h || 0, mi || 0, s || 0); };
const fmtMs = (ms, seg = true) => { const d = new Date(ms); return p2(d.getUTCDate()) + '/' + p2(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + (seg ? ':' + p2(d.getUTCSeconds()) : ''); };
const fmtQ = (q, seg) => (q ? fmtMs(msDoQuando(q), seg) : '—');
const fmtDia = (q) => (q ? q.slice(8, 10) + '/' + q.slice(5, 7) + '/' + q.slice(0, 4) : '—');
const fmtUtc = (iso) => { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
const quandoDoMs = (ms) => new Date(ms).toISOString().slice(0, 19);
const fmtCnpj = (c) => (c && c.length === 14 ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : c || '');
const NOMES_UNIDADE = { SP: 'São Paulo', GV: 'Governador Valadares', BELEM: 'Belém', JEQUIE: 'Jequié', SALVADOR: 'Salvador' };
const nomeUnidade = (u) => NOMES_UNIDADE[u] || u.charAt(0) + u.slice(1).toLowerCase();
const BOM = String.fromCharCode(0xfeff);   // o Excel abre o CSV em UTF-8

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando o rateio das notas…</div>';
  let d;
  async function carregar() { d = await obter('/api/bomba/rateio'); }
  try { await carregar(); } catch (e) {
    if (e.message !== 'sessão') pagina.innerHTML = '<div class="vazio">' + esc(e.message) + ' Recarregue a página para tentar de novo.</div>';
    return {};
  }
  const editor = d.podeEditar;
  ctx.definirSub(editor ? 'Rateio de cada nota de compra das bombas internas por empresa e centro de custo. Confira e valide cada nota fechada; o fiscal vê só as validadas.'
    : 'Rateio de cada nota de compra das bombas internas por empresa e centro de custo, validado pela gestão de combustível.');
  const comTanque = d.bases.filter((b) => b.tanques.length);
  if (!comTanque.length) { pagina.innerHTML = '<div class="vazio">Nenhuma base de bomba interna liberada para o seu acesso.</div>'; return {}; }

  const estado = { base: comTanque[0].id, tanque: comTanque[0].tanques.includes('diesel') ? 'diesel' : comTanque[0].tanques[0], nota: null, recolhidos: new Set() };   // recolhidos: centros de custo com as placas escondidas
  pagina.innerHTML = `
    <div class="tabela-ferramentas rt-topo">
      <select id="rt-base" class="campo-sel" aria-label="Base">${comTanque.map((b) => '<option value="' + b.id + '">' + esc(b.nome) + '</option>').join('')}</select>
      <div class="segmentado" id="rt-tanque" role="group" aria-label="Tanque"></div>
      
    </div>
    <section class="painel painel-tabela">
      <div class="painel-cab"><h2>Notas</h2><span class="conta" id="rt-conta"></span></div>
      <div class="tabela-rolagem"><table class="dados" id="rt-notas"></table></div>
    </section>
    <section class="painel painel-tabela oculto" id="rt-detalhe"></section>
    ${editor ? '<section class="painel painel-tabela oculto" id="rt-sem-nota"></section><section class="painel" id="rt-inicio"></section>' : ''}`;
  const el = (id) => pagina.querySelector('#' + id);
  const baseAtual = () => d.bases.find((b) => b.id === estado.base);
  el('rt-base').addEventListener('change', () => {
    estado.base = Number(el('rt-base').value);
    if (!baseAtual().tanques.includes(estado.tanque)) estado.tanque = baseAtual().tanques[0];
    estado.nota = null; desenhar();
  });
  el('rt-tanque').addEventListener('click', (e) => { const b = e.target.closest('[data-tanque]'); if (!b) return; estado.tanque = b.dataset.tanque; estado.nota = null; desenhar(); });

  // ---------- cálculo (só quem edita recebe a lista de abastecimentos) ----------
  function calcular() {
    const notas = d.notas.filter((n) => n.base_id === estado.base && n.tanque === estado.tanque);
    const ini = d.inicios.find((i) => i.base_id === estado.base && i.tanque === estado.tanque) || null;
    const lt = d.lista && d.lista.tanques.find((t) => t.base_id === estado.base && t.tanque === estado.tanque);
    const ccs = new Map((d.ccs || []).map((c) => [c.chave, c.cc]));
    const trs = (lt ? lt.transacoes : []).map((t) => ({ ...t, t: msDoQuando(t.quando), ccOriginal: t.cc, cc: ccs.has(t.id) ? ccs.get(t.id) : t.cc, ccCorrigido: ccs.has(t.id) }));
    const r = editor && ini ? ratear(trs, notas, { t: msDoQuando(ini.quando), placa: ini.placa, jaRateado: ini.ja_rateado }) : null;
    return { notas, ini, trs, r };
  }
  const validacao = (id) => d.validacoes.find((v) => v.mov_id === id);
  // fornecedor do cadastro do Preço bomba interna pelo CNPJ da nota
  const doCadastro = (n) => (n.cnpj ? (d.fornecedores || []).find((x) => x.cnpj === n.cnpj) : null);
  const nomeCad = (n) => { const x = doCadastro(n); return x ? x.fornecedor + ' (' + nomeUnidade(x.unidade) + ')' : ''; };
  const conferencias = (id) => d.conferencias.filter((c) => c.mov_id === id);

  function desenhar() {
    el('rt-base').value = String(estado.base);
    el('rt-tanque').innerHTML = baseAtual().tanques.map((t) => '<button type="button" data-tanque="' + t + '" aria-pressed="' + (t === estado.tanque) + '">' + NOME_TANQUE[t] + '</button>').join('');
    if (editor) ctx.definirSub(d.lista ? 'Abastecimentos atualizados em ' + fmtUtc(d.lista.geradoEm) + '.' : 'A lista de abastecimentos ainda não foi gerada.');
    const c = calcular();
    desenharNotas(c);
    desenharDetalhe(c);
    if (editor) { desenharSemNota(c); desenharInicio(c); }
  }

  function situacaoDe(n, calc) {
    const v = validacao(n.id);
    if (v) {
      const cf = conferencias(n.id);
      return '<span class="selo selo-ok">Validada</span> <small class="rt-quem">por ' + esc(v.usuario_nome) + ' em ' + esc(fmtUtc(v.validado_em)) + '</small>' +
        (cf.length ? '<br><small class="rt-quem">Conferida por ' + cf.map((x) => esc(x.usuario_nome)).join(', ') + '</small>' : '');
    }
    if (!editor) return '<span class="selo selo-espera">Em aberto</span> <small class="rt-quem">rateio ainda não fechado pela gestão de combustível</small>';
    if (!calc) return '<span class="selo selo-espera">Aguardando validação</span>';
    if (calc.situacao === 'fechada') return '<span class="selo selo-pendente">Fechada: validar</span>';
    if (calc.situacao === 'em uso') return '<span class="selo selo-espera">Em uso (' + num(calc.rateado / calc.litros * 100, 0) + '%)</span>';
    return '<span class="selo selo-espera">Aguardando abastecimentos</span>';
  }
  function desenharNotas(c) {
    const calcPorId = new Map(c.r ? c.r.notas.map((n) => [n.id, n]) : []);
    // quem edita: as do rateio do portal e as validadas; fiscal: as validadas e, "Em aberto" (sem abrir), as lançadas desde
    // o início do rateio do portal (todas, se o tanque ainda não tem início)
    const doPortal = (n) => (editor ? calcPorId.has(n.id) : !c.ini || String(n.quando).slice(0, 10) >= c.ini.quando.slice(0, 10));
    const lista = c.notas.filter((n) => validacao(n.id) || doPortal(n)).slice().reverse();
    el('rt-conta').textContent = num(lista.length) + (lista.length === 1 ? ' nota' : ' notas');
    el('rt-notas').innerHTML = '<thead><tr><th><span>NF</span></th><th><span>Fornecedor</span></th><th><span>Emissão</span></th><th><span>Entrada</span></th>' +
      '<th class="n"><span>Litros</span></th><th class="n"><span>R$/L</span></th><th class="n"><span>Valor total</span></th><th><span>Situação</span></th><th class="acoes-linha"><span>Rateio</span></th></tr></thead><tbody>' +
      (lista.length ? lista.map((n) => '<tr' + (estado.nota === n.id ? ' class="rt-sel"' : '') + '><td>' + esc(n.nf || '(sem número)') + '</td><td class="trunc" title="' + esc(n.fornecedor || '') + '">' + esc(n.fornecedor || nomeCad(n) || '—') +
        (n.fornecedor && nomeCad(n) ? '<br><small class="rt-quem">' + esc(nomeCad(n)) + '</small>' : '') + '</td>' +
        '<td>' + esc(fmtDia(n.emissao)) + '</td><td>' + esc(fmtQ(n.quando, false)) + '</td><td class="n">' + num(n.litros, 0) + '</td><td class="n">' + num(n.valor / n.litros, 4) + '</td>' +
        '<td class="n">R$ ' + num(n.valor, 2) + '</td><td>' + situacaoDe(n, calcPorId.get(n.id)) + '</td>' +
        '<td class="acoes-linha">' + (editor || validacao(n.id) ? '<button type="button" class="btn-linha" data-abrir="' + n.id + '">' + (estado.nota === n.id ? 'Aberto' : 'Abrir') + '</button>'
          : '<span class="rt-quem" title="O rateio desta nota ainda não foi validado">Em aberto</span>') + '</td></tr>').join('')
        : '<tr><td colspan="9"><div class="vazio">' + (editor ? (c.ini ? 'Nenhuma nota lançada em Movimentações para este tanque.' : 'Defina abaixo onde o rateio deste tanque começa.') : 'Nenhuma nota lançada ainda.') + '</div></td></tr>') + '</tbody>';
  }
  el('rt-notas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-abrir]'); if (!b) return;
    if (!editor && !validacao(Number(b.dataset.abrir))) return;   // em aberto: o fiscal não entra
    estado.nota = Number(b.dataset.abrir); desenhar();
    el('rt-detalhe').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ---------- detalhe de uma nota ----------
  const linhasDaNota = (calc) => calc.partes.map((p) => ({ id: p.tr.id, quando: quandoDoMs(p.tr.t), placa: p.tr.placa, motorista: p.tr.motorista || '',
    reduzido: p.tr.reduzido || '', cc: p.tr.cc || '', ccOriginal: p.tr.ccOriginal || '', ccCorrigido: p.tr.ccCorrigido, litros: p.litros, litrosTotal: p.tr.litros,
    preco: calc.preco, valor: p.valor, dividido: Math.abs(p.litros - p.tr.litros) > 0.005, completa: p.tr.completa || null }));
  const agrupado = (linhas) => agruparCC(linhas.map((l) => ({ tr: l, litros: l.litros, valor: l.valor })));
  // centro de custo -> placas; clicar no centro de custo esconde/mostra as placas dele
  function tabelaRateio(linhas) {
    const g = agrupado(linhas);
    const nums = (x) => '<td class="n">' + num(x.litros, 2) + '</td><td class="n">R$ ' + num(x.valor, 2) + '</td><td class="n">' + num(x.pct * 100, 2) + '%</td>';
    return '<table class="dados rt-rateio"><thead><tr><th><span>Centro de custo / placa</span></th><th class="n"><span>Litros</span></th><th class="n"><span>Valor</span></th><th class="n"><span>%</span></th></tr></thead><tbody>' +
      g.centros.map((c) => {
        const fechado = estado.recolhidos.has(c.cc);
        return '<tr class="rt-n2"><td><button type="button" class="rt-abre" data-cc="' + esc(c.cc) + '" aria-expanded="' + !fechado + '">' +
            '<span class="rt-seta" aria-hidden="true">' + (fechado ? '▸' : '▾') + '</span>' + esc(c.cc) + ' <small class="rt-quem">' + num(c.placas.length) + (c.placas.length === 1 ? ' placa' : ' placas') + '</small></button></td>' + nums(c) + '</tr>' +
          c.placas.map((p) => '<tr class="rt-n3" data-dono="' + esc(c.cc) + '"' + (fechado ? ' hidden' : '') + '><td>' + esc(p.placa) + '</td>' + nums(p) + '</tr>').join('');
      }).join('') +
      '<tr class="rt-total"><td>Total geral</td>' + nums({ litros: g.litros, valor: g.valor, pct: g.valor > 0 ? 1 : 0 }) + '</tr></tbody></table>';
  }
  function tabelaLinhas(linhas, editavel) {
    return '<table class="dados rt-linhas"><thead><tr><th><span>Data e hora</span></th><th><span>Placa</span></th><th><span>Motorista</span></th><th class="n"><span>Litros</span></th>' +
      '<th class="n"><span>R$/L</span></th><th class="n"><span>Valor total</span></th><th><span>Centro de custo (inf. adicional 3)</span></th><th><span>Empresa</span></th></tr></thead><tbody>' +
      linhas.map((l) => '<tr><td>' + esc(fmtQ(l.quando)) + '</td><td>' + esc(l.placa) + '</td><td class="trunc" title="' + esc(l.motorista) + '">' + esc(l.motorista) + '</td>' +
        '<td class="n">' + num(l.litros, 2) + (l.dividido ? '<br><small class="rt-quem" title="Abastecimento dividido entre duas notas">de ' + num(l.litrosTotal, 2) + ' L</small>' : '') + '</td>' +
        '<td class="n">' + num(l.preco, 4) + '</td><td class="n">R$ ' + num(l.valor, 2) + '</td>' +
        '<td>' + (editavel ? '<input class="rt-cc' + (l.ccCorrigido ? ' rt-cc-mudou' : '') + '" list="rt-ccs" data-chave="' + esc(l.id) + '" data-original="' + esc(l.ccOriginal) + '" value="' + esc(l.cc) + '" aria-label="Centro de custo de ' + esc(l.placa) + '"' +
          (l.ccCorrigido ? ' title="Original: ' + esc(l.ccOriginal || '(vazio)') + '"' : '') + '>' : esc(l.cc)) + '</td><td>' + esc(l.reduzido) + '</td></tr>').join('') + '</tbody></table>';
  }
  function desenharDetalhe(c) {
    const sec = el('rt-detalhe');
    const n = estado.nota && c.notas.find((x) => x.id === estado.nota);
    if (!n) { sec.classList.add('oculto'); sec.innerHTML = ''; return; }
    sec.classList.remove('oculto');
    const v = validacao(n.id), calc = c.r && c.r.notas.find((x) => x.id === n.id);
    const linhas = v ? v.dados.linhas : calc ? linhasDaNota(calc) : [];
    const litros = linhas.reduce((s, l) => s + l.litros, 0), valor = linhas.reduce((s, l) => s + l.valor, 0);
    const meu = conferencias(n.id).some((x) => x.usuario_id === d.euId);
    const cab = '<div class="painel-cab"><h2>NF ' + esc(n.nf || '(sem número)') + ' · ' + esc(n.fornecedor || 'fornecedor não informado') + '</h2>' +
      '<div class="acoes-cab"><span class="conta">' + num(linhas.length) + ' abastecimentos</span>' +
      '<button type="button" class="btn" id="rt-fechar"><svg aria-hidden="true"><use href="#i-x"/></svg><span class="txt">Fechar</span></button></div></div>' +
      '<dl class="apoio"><div><dt>CNPJ</dt><dd>' + esc(fmtCnpj(n.cnpj) || '—') + (nomeCad(n) ? ' <small class="rt-quem">' + esc(nomeCad(n)) + '</small>' : '') + '</dd></div><div><dt>Emissão</dt><dd>' + esc(fmtDia(n.emissao)) + '</dd></div>' +
      '<div><dt>Nota</dt><dd class="num">' + num(n.litros, 0) + ' L · R$ ' + num(n.valor, 2) + '</dd></div><div><dt>R$/L</dt><dd class="num">' + num(n.valor / n.litros, 4) + '</dd></div>' +
      '<div><dt>Rateado</dt><dd class="num">' + num(litros, 2) + ' L · R$ ' + num(valor, 2) + '</dd></div></dl>';
    let acoes = '';
    if (v) {
      acoes = '<p class="nota">Validado por ' + esc(v.usuario_nome) + ' em ' + esc(fmtUtc(v.validado_em)) + '.</p><div class="dialogo-acoes rt-acoes">' +
        (editor ? '<button type="button" class="btn" id="rt-reabrir">Reabrir para correção</button>' : '') +
        '<button type="button" class="btn" id="rt-baixar"><svg aria-hidden="true"><use href="#i-baixar"/></svg><span class="txt">Baixar</span></button>' +
        '<button type="button" class="btn ' + (meu ? '' : 'btn-principal') + '" id="rt-conferir">' + (meu ? 'Desfazer "conferido"' : 'Marcar como conferido') + '</button></div>';
    } else if (calc) {
      const fechada = calc.situacao === 'fechada';
      acoes = '<p class="nota">' + (fechada ? 'Confira as linhas e o centro de custo (pode corrigir na tabela; a correção vai também para os abastecimentos). Ao validar, o rateio fica disponível para o fiscal.'
        : 'A nota ainda está em uso: ' + num(calc.rateado, 2) + ' de ' + num(calc.litros, 0) + ' L rateados. A validação abre quando a nota fechar.') + '</p>' +
        '<div class="dialogo-acoes rt-acoes"><button type="button" class="btn btn-principal" id="rt-validar"' + (fechada ? '' : ' disabled') + '>Validar rateio</button></div>';
    }
    // todos os centros de custo da Base_copia (vigia) e os desta nota
    const ccsConhecidos = [...new Set(((d.lista && d.lista.centros) || []).concat(c.trs.map((t) => t.cc), c.trs.map((t) => t.ccOriginal)).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    sec.innerHTML = cab +
      (linhas.length ? '<h3 class="rt-sub">Rateio por centro de custo</h3><div class="tabela-rolagem">' + tabelaRateio(linhas) + '</div>' +
        '<h3 class="rt-sub">Abastecimentos</h3><div class="tabela-rolagem">' + tabelaLinhas(linhas, editor && !v) + '</div>' : '<div class="vazio">Nenhum abastecimento nesta nota ainda.</div>') +
      '<datalist id="rt-ccs">' + ccsConhecidos.map((x) => '<option value="' + esc(x) + '">').join('') + '</datalist>' + acoes;

    const bt = (id, fn) => { const b = sec.querySelector('#' + id); if (b) b.addEventListener('click', () => acao(b, fn)); };
    // fechar a nota: volta só para a lista de notas
    sec.querySelector('#rt-fechar').addEventListener('click', () => {
      const id = estado.nota;
      estado.nota = null; desenhar();
      const linha = el('rt-notas').querySelector('[data-abrir="' + id + '"]');
      if (linha) { linha.closest('tr').scrollIntoView({ block: 'center' }); linha.focus(); }
    });
    bt('rt-validar', async () => {
      if (!await confirmar('Validar o rateio da NF ' + (n.nf || '') + '? Ele fica disponível para o fiscal.')) return false;
      const dados = { nf: n.nf, fornecedor: n.fornecedor, cnpj: n.cnpj, emissao: n.emissao, litrosNota: n.litros, valorNota: n.valor, preco: n.valor / n.litros,
        litros, valor, linhas: linhas.map(({ ccCorrigido, ...l }) => l) };
      await postar({ acao: 'validar', mov_id: n.id, dados });
    });
    bt('rt-reabrir', async () => { if (!await confirmar('Reabrir o rateio da NF ' + (n.nf || '') + '? O fiscal deixa de vê-lo até a nova validação.')) return false; await postar({ acao: 'reabrir', mov_id: n.id }); });
    bt('rt-conferir', async () => { await postar({ acao: meu ? 'desconferir' : 'conferir', mov_id: n.id }); });
    ligarMenu(sec.querySelector('#rt-baixar'), [
      { rotulo: 'Planilha da nota com tabela dinâmica (XLSX)', acao: () => exportarAbastecimentos(n, v) },
      { rotulo: 'Rateio por centro de custo (CSV)', acao: () => exportarRateio(n, v) },
    ]);
    sec.querySelectorAll('.rt-abre').forEach((b) => b.addEventListener('click', () => {
      const cc = b.dataset.cc, fechar = !estado.recolhidos.has(cc);
      if (fechar) estado.recolhidos.add(cc); else estado.recolhidos.delete(cc);
      b.setAttribute('aria-expanded', String(!fechar));
      b.querySelector('.rt-seta').textContent = fechar ? '▸' : '▾';
      sec.querySelectorAll('tr.rt-n3').forEach((tr) => { if (tr.dataset.dono === cc) tr.hidden = fechar; });
    }));
    sec.querySelectorAll('.rt-cc').forEach((inp) => inp.addEventListener('change', async () => {
      const novo = inp.value.replace(/\s+/g, ' ').trim().toUpperCase();
      const cc = novo === (inp.dataset.original || '').toUpperCase() ? '' : novo;   // igual ao original: desfaz a correção
      inp.disabled = true;
      try {
        await postar({ acao: 'cc', chave: inp.dataset.chave, cc });
        d.ccs = (d.ccs || []).filter((x) => x.chave !== inp.dataset.chave);
        if (cc) d.ccs.push({ chave: inp.dataset.chave, cc });
        desenhar();
      } catch (e) { if (e.message !== 'sessão') { alert(e.message); inp.disabled = false; } }
    }));
  }
  async function acao(btn, fn) {
    btn.disabled = true;
    try {
      if ((await fn()) === false) { btn.disabled = false; return; }
      await carregar(); desenhar();
    } catch (e) { if (e.message !== 'sessão') alert(e.message); btn.disabled = false; }
  }
  const csvQ = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  const csvN = (x, c) => (x === null || x === undefined || x === '' ? '' : (c === undefined ? String(x) : Number(x).toFixed(c)).replace('.', ','));
  function baixarCsv(nome, linhas) { baixar(nome, new Blob([BOM + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' })); }
  function baixar(nome, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const nomeArq = (n, sufixo) => 'NF ' + String(n.nf || n.id).replace(/[^\w-]/g, '') + sufixo + '.csv';
  // linha da Base (40 colunas, A..AN) do abastecimento com a parte dele na nota: LITROS, VL/LITRO (preço da nota), VALOR
  // EMISSAO e INFORMAÇÃO ADICIONAL 3 (centro de custo validado) — como na aba de cada nota da planilha de rateio
  function linhaBase(l) {
    const r = Array.isArray(l.completa) ? l.completa.slice(0, 40) : [];
    while (r.length < 40) r.push(null);
    if (!Array.isArray(l.completa)) {   // abastecimento que ainda não estava na Base_copia: o que se sabe dele
      r[3] = l.reduzido || null; r[4] = msDoQuando(l.quando) / 864e5 + 25569; r[5] = l.placa; r[11] = l.motorista || null;
      r[12] = 'Abastecimento'; r[13] = COMBUSTIVEL_DO_TANQUE[estado.tanque] || null; r[21] = (baseAtual() || {}).posto || null;
    }
    r[14] = l.litros; r[15] = l.preco; r[19] = l.valor; r[29] = l.cc || null;
    return r;
  }
  // planilha da nota como a de rateio: aba com os abastecimentos (40 colunas) e aba "Rateio" com a tabela dinâmica
  // (centro de custo -> placa, soma do VALOR EMISSAO e %), que o Excel atualiza ao abrir
  function exportarAbastecimentos(n, v) {
    const linhas = v.dados.linhas.map((l) => { const r = linhaBase(l); if (!r[29]) r[29] = '(sem centro de custo)'; return r; });
    const nf = String(n.nf || n.id);
    baixar('NF ' + nf.replace(/[^\w-]/g, '') + '.xlsx', planilhaRateio({ aba: 'NF ' + nf, cabecalho: OUTPUT_HEADERS.slice(0, 40), linhas,
      col: { data: 4, placa: 5, cc: 29, valor: 19 },
      titulo: 'NF ' + nf + (n.fornecedor ? ' · ' + n.fornecedor : '') + ' · validado por ' + v.usuario_nome + ' em ' + fmtUtc(v.validado_em) }));
  }
  // o rateio já montado: centro de custo -> placa, valor e %
  function exportarRateio(n, v) {
    const g = agrupado(v.dados.linhas);
    const out = ['NF;' + csvQ(n.nf) + ';Fornecedor;' + csvQ(n.fornecedor) + ';CNPJ;' + csvQ(fmtCnpj(n.cnpj)) + ';Emissão;' + fmtDia(n.emissao),
      'Litros da nota;' + csvN(n.litros, 2) + ';Valor da nota;' + csvN(n.valor, 2) + ';R$/L;' + csvN(n.valor / n.litros, 4) + ';Validado por;' + csvQ(v.usuario_nome + ' em ' + fmtUtc(v.validado_em)), '',
      'Centro de custo;Placa;Litros;Valor;%'];
    for (const c of g.centros) {
      out.push([csvQ(c.cc), '', csvN(c.litros, 2), csvN(c.valor, 2), csvN(c.pct * 100, 2)].join(';'));
      for (const p of c.placas) out.push([csvQ(c.cc), csvQ(p.placa), csvN(p.litros, 2), csvN(p.valor, 2), csvN(p.pct * 100, 2)].join(';'));
    }
    out.push(['"Total geral"', '', csvN(g.litros, 2), csvN(g.valor, 2), '100,00'].join(';'));
    baixarCsv(nomeArq(n, ' - rateio'), out);
  }

  // ---------- abastecimentos que passaram das notas lançadas ----------
  function desenharSemNota(c) {
    const sec = el('rt-sem-nota');
    const sem = c.r ? c.r.semNota : [];
    if (!sem.length) { sec.classList.add('oculto'); sec.innerHTML = ''; return; }
    sec.classList.remove('oculto');
    const litros = sem.reduce((s, x) => s + x.litros, 0);
    sec.innerHTML = '<div class="painel-cab"><h2>Abastecimentos sem nota</h2><span class="conta">' + num(sem.length) + ' · ' + num(litros, 2) + ' L</span></div>' +
      '<p class="nota">Passaram dos litros das notas lançadas. Entram na próxima nota assim que ela for lançada em Movimentações; até lá o preço deles não muda.</p>' +
      '<div class="tabela-rolagem"><table class="dados"><thead><tr><th><span>Data e hora</span></th><th><span>Placa</span></th><th><span>Motorista</span></th><th class="n"><span>Litros</span></th><th><span>Centro de custo</span></th></tr></thead><tbody>' +
      sem.slice().reverse().map((x) => '<tr><td>' + esc(fmtMs(x.tr.t)) + '</td><td>' + esc(x.tr.placa) + '</td><td>' + esc(x.tr.motorista || '') + '</td><td class="n">' + num(x.litros, 2) + '</td><td>' + esc(x.tr.cc || '') + '</td></tr>').join('') +
      '</tbody></table></div>';
  }

  // ---------- início do rateio (quem edita) ----------
  function desenharInicio(c) {
    const sec = el('rt-inicio');
    const ini = c.ini;
    const opcoes = c.trs.slice().sort((a, b) => b.t - a.t).slice(0, 400);
    sec.innerHTML = '<div class="painel-cab"><h2>Início do rateio no portal</h2></div>' +
      (ini ? '<p class="nota">Começa no abastecimento de ' + esc(fmtQ(ini.quando)) + (ini.placa ? ' (' + esc(ini.placa) + ')' : '') + ', com ' + num(ini.ja_rateado, 2) +
        ' L dele na última nota da planilha. Definido por ' + esc(ini.usuario_nome) + ' em ' + esc(fmtUtc(ini.atualizado_em)) + '. Antes disso, o rateio ficou na planilha.</p>'
        : '<p class="nota">Este tanque ainda não tem início definido: o portal não muda o preço de nenhum abastecimento. Escolha o primeiro abastecimento da primeira nota do portal ' +
          '(o último da nota anterior, quando ele foi dividido) e quantos litros dele ficaram na nota anterior.</p>') +
      (opcoes.length ? '<details' + (ini ? '' : ' open') + '><summary>' + (ini ? 'Mudar o início' : 'Definir o início') + '</summary><form id="rt-ini-form" class="grade-form rt-ini">' +
        '<label class="campo-form largo"><span>Primeiro abastecimento</span><select name="tr">' + opcoes.map((t) => '<option value="' + esc(t.id) + '"' +
          (ini && quandoDoMs(t.t) === ini.quando && (!ini.placa || ini.placa === t.placa) ? ' selected' : '') + '>' + esc(fmtMs(t.t) + ' · ' + t.placa + ' · ' + num(t.litros, 2) + ' L · ' + (t.motorista || '')) + '</option>').join('') + '</select></label>' +
        '<label class="campo-form"><span>Litros dele na nota anterior</span><input name="ja" inputmode="decimal" value="' + (ini ? num(ini.ja_rateado, 2) : '0') + '"></label>' +
        '<div class="campo-form"><span>&nbsp;</span><button type="submit" class="btn btn-principal">Salvar início</button></div></form></details>'
        : '<p class="nota">Sem abastecimentos deste tanque na lista.</p>');
    const f = sec.querySelector('#rt-ini-form');
    if (!f) return;
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = c.trs.find((x) => x.id === f.tr.value);
      const ja = Number(String(f.ja.value).replace(/\./g, '').replace(',', '.')) || 0;
      if (!t) return;
      if (ja > t.litros) { alert('Os litros na nota anterior passam do abastecimento (' + num(t.litros, 2) + ' L).'); return; }
      if (!await confirmar('O rateio do portal passa a começar em ' + fmtMs(t.t) + ' (' + t.placa + '). Os preços dos abastecimentos a partir daí seguem as notas. Confirmar?')) return;
      acao(f.querySelector('button'), () => postar({ acao: 'inicio', base_id: estado.base, tanque: estado.tanque, quando: quandoDoMs(t.t), placa: t.placa, ja_rateado: ja }));
    });
  }

  desenhar();
  return {};
}