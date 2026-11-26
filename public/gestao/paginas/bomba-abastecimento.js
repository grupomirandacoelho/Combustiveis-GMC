// Bomba interna > Inclusão de abastecimento: lança na Base_copia os abastecimentos das bombas internas (em vez de virem
// pelos arquivos do consolidador). Rápido: unidade, combustível (os tanques da unidade), placa, KM e litragem, com a hora de
// agora; Detalhado: o mesmo com data e hora (para quem não lançou na hora). A linha da Base (48 colunas) é montada com o
// mesmo motor do Consolidador (lib/consolidador.js: veículo, matrícula, posto e KM rodado herdados do histórico) e vai
// como um lote para o vigia gravar na Base_copia. Preço por litro = preço médio do estoque do tanque (lib/bomba.js).
import { carregarDados, esc, placaDesabilitada } from '../lib/dados.js';
import { NOME_TANQUE, COMBUSTIVEL_DO_TANQUE, calcularEstoque, tanqueDe, minutosDe, minutosDaLinha, normPlaca, fmtMinutos, fmtQuando, agoraLocal } from '../lib/bomba.js';

const PLACA_OK = /^[A-Z]{3}\d[A-Z0-9]\d{2}$/;
const SEM_MOTORISTA = '(sem motorista)';
const ESTADO = { pendente: 'Aguardando gravação', aguardando: 'Base_copia aberta no Excel', aplicada: 'Gravado na Base_copia', erro: 'Não gravado' };
async function obter(url) {
  const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (r.status === 401 || r.redirected) { location.href = '/?entrar=1'; throw new Error('sessão'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Não foi possível carregar (' + r.status + ').');
  return j;
}
const num = (v, c = 0) => (v === null || v === undefined || !isFinite(v) ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c }));
const lerNum = (s, inteiro) => {
  let t = String(s ?? '').trim().replace(/\s/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (inteiro || /^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando as bombas internas…</div>';
  let dados, bases, todasBases, movs, manuais, pode;
  try {
    const [d, b, m, a] = await Promise.all([carregarDados({ tempoReal: true }), obter('/api/bomba/bases'), obter('/api/bomba/movimentacoes'), obter('/api/bomba/abastecimentos')]);
    dados = d; todasBases = b.bases; bases = b.bases.filter((x) => x.ativo); movs = m.movimentacoes; manuais = a.abastecimentos; pode = a.pode;
  } catch (e) {
    if (e.message !== 'sessão') pagina.innerHTML = '<div class="vazio">' + esc(e.message) + ' Recarregue a página para tentar de novo.</div>';
    return {};
  }
  // histórico da Base para montar a linha (o mesmo do Consolidador); carregado em segundo plano
  let historico = null, baseHist = null, CORE = null;
  const buscarHistorico = () => Promise.all([obter('/gestao/dados/consolidacao.json'), import('../lib/consolidador.js')])
    .then(([h, c]) => { historico = h; CORE = c; }).catch((e) => { historico = { erro: e.message }; });
  let preparar = buscarHistorico();

  // última leitura de cada placa (para o motorista sugerido e o KM anterior)
  const ultMotorista = new Map(), ultHodo = new Map();
  for (const l of dados.linhas) {
    const p = normPlaca(l.placa), t = minutosDaLinha(l);
    if (l.motorista && l.motorista !== SEM_MOTORISTA) { const u = ultMotorista.get(p); if (!u || t > u.t) ultMotorista.set(p, { t, nome: l.motorista }); }
    const tq = tanqueDe(l.combustivel);
    if (tq && l.hodometro > 0) { const k = p + '|' + tq, u = ultHodo.get(k); if (!u || t > u.t) ultHodo.set(k, { t, km: l.hodometro, posto: l.fornecedor }); }
  }
  const placas = [...new Set(dados.linhas.filter((l) => l.dia > dados.diaMax - 400).map((l) => normPlaca(l.placa)).filter((p) => PLACA_OK.test(p) && !placaDesabilitada(p)))].sort();   // sem as desabilitadas no cadastro
  const motoristas = [...new Set([...ultMotorista.values()].map((m) => m.nome))].sort((a, b) => a.localeCompare(b, 'pt-BR'));

  pagina.innerHTML = !pode ? '<div class="vazio">Seu acesso não inclui o lançamento de abastecimentos.</div>' : !bases.length
    ? '<div class="vazio">Nenhuma base cadastrada. Cadastre a bomba interna em Bomba interna > Estoque.</div>' : `
    <div class="ba-msg oculto" id="ba-msg" role="status"></div>
    <section class="painel painel-tabela">
      <div class="painel-cab">
        <h2>Abastecimentos lançados</h2>
        <div class="ba-novo">
          <button type="button" class="btn btn-principal" id="ba-novo" aria-haspopup="menu" aria-expanded="false" aria-controls="ba-novo-menu">
            <svg aria-hidden="true"><use href="#i-mais"/></svg><span class="txt">Adicionar abastecimento</span></button>
          <div class="ba-novo-menu oculto" id="ba-novo-menu" role="menu" aria-label="Tipo de abastecimento">
            <button type="button" role="menuitem" data-modo="rapido"><strong>Rápido</strong><small>Na hora do abastecimento: data e horário de agora</small></button>
            <button type="button" role="menuitem" data-modo="detalhado"><strong>Detalhado</strong><small>Feito antes e não lançado: informe a data e o horário</small></button>
          </div>
        </div>
      </div>
      <div class="tabela-ferramentas">
        <input type="search" id="ba-busca" placeholder="Placa, motorista, unidade, data…" aria-label="Pesquisar abastecimentos" autocomplete="off">
        <span class="conta" id="ba-conta"></span>
      </div>
      <p class="nota">Últimos 90 dias. Editar e excluir liberam depois que o abastecimento entra na Base_copia.</p>
      <div class="tabela-rolagem"><table class="dados" id="ba-lista"></table></div>
    </section>
    <dialog class="dialogo" id="ba-dlg-novo" aria-labelledby="ba-novo-titulo">
      <form id="ba-form" novalidate>
        <h2 id="ba-novo-titulo">Abastecimento rápido</h2>
        <p class="dialogo-explica" id="ba-explica"></p>
        <p class="erro-form oculto" id="ba-erro" role="alert"></p>
        <div class="grade-form">
          <label class="campo-form"><span>Unidade</span><select name="base" required>${bases.map((b) => '<option value="' + b.id + '">' + esc(b.nome) + '</option>').join('')}</select></label>
          <div class="campo-form"><span id="ba-comb-rot">Combustível</span><div class="segmentado" role="group" aria-labelledby="ba-comb-rot" id="ba-comb"></div></div>
          <label class="campo-form"><span>Placa</span><input name="placa" list="ba-placas" required autocomplete="off" spellcheck="false" maxlength="8" placeholder="Ex.: TLB2I85"></label>
          <label class="campo-form"><span>KM (hodômetro)</span><input name="km" inputmode="numeric" required autocomplete="off" placeholder="Ex.: 481687"></label>
          <label class="campo-form"><span>Litragem (L)</span><input name="litros" inputmode="decimal" required autocomplete="off" placeholder="Ex.: 340,24"></label>
          <label class="campo-form largo"><span>Motorista</span><input name="motorista" list="ba-mots" autocomplete="off" spellcheck="false" maxlength="80"></label>
          <label class="campo-form ba-det oculto"><span>Data</span><input name="data" type="date"></label>
          <label class="campo-form ba-det oculto"><span>Horário</span><input name="hora" type="time"></label>
        </div>
        <div class="ba-resumo" id="ba-resumo" role="status"></div>
        <div class="dialogo-acoes">
          <button type="button" class="btn" data-fechar>Cancelar</button>
          <button type="submit" class="btn btn-principal" id="ba-salvar">Lançar abastecimento</button>
        </div>
      </form>
    </dialog>
    <datalist id="ba-placas">${placas.map((p) => '<option value="' + p + '">').join('')}</datalist>
    <datalist id="ba-mots">${motoristas.map((m) => '<option value="' + esc(m) + '">').join('')}</datalist>
    <dialog class="dialogo" id="ba-dlg" aria-labelledby="ba-dlg-titulo">
      <form id="ba-form-ed" novalidate>
        <h2 id="ba-dlg-titulo">Editar abastecimento</h2>
        <p class="dialogo-explica">A correção vai para a Base_copia pela mesma fila do "Editar abastecimentos". Se mudar o KM, a placa, o
          combustível ou a data, o km rodado do próximo abastecimento da placa também é refeito.</p>
        <p class="erro-form oculto" id="ba-ed-erro" role="alert"></p>
        <div class="grade-form">
          <label class="campo-form"><span>Unidade</span><select name="base" required>${bases.map((b) => '<option value="' + b.id + '">' + esc(b.nome) + '</option>').join('')}</select></label>
          <div class="campo-form"><span id="ba-ed-comb-rot">Combustível</span><div class="segmentado" role="group" aria-labelledby="ba-ed-comb-rot" id="ba-ed-comb"></div></div>
          <label class="campo-form"><span>Data</span><input name="data" type="date" required></label>
          <label class="campo-form"><span>Horário</span><input name="hora" type="time" required></label>
          <label class="campo-form"><span>Placa</span><input name="placa" list="ba-placas" required autocomplete="off" spellcheck="false" maxlength="8"></label>
          <label class="campo-form"><span>KM (hodômetro)</span><input name="km" inputmode="numeric" required autocomplete="off"></label>
          <label class="campo-form"><span>Litragem (L)</span><input name="litros" inputmode="decimal" required autocomplete="off"></label>
          <label class="campo-form"><span>Motorista</span><input name="motorista" list="ba-mots" autocomplete="off" spellcheck="false" maxlength="80"></label>
        </div>
        <div class="dialogo-acoes">
          <button type="button" class="btn" data-fechar>Cancelar</button>
          <button type="submit" class="btn btn-principal" id="ba-ed-salvar">Salvar correção</button>
        </div>
      </form>
    </dialog>`;
  if (!pode || !bases.length) return {};
  const el = (id) => pagina.querySelector('#' + id);
  const f = el('ba-form');
  ctx.definirSub('Lança os abastecimentos das bombas internas direto na Base_copia, como o Consolidador.');
  let modo = 'rapido', tanque = null;

  function desenharCombustivel() {
    const b = bases.find((x) => x.id === Number(f.base.value));
    const ts = ['diesel', 'arla'].filter((t) => b && b.tanques[t]);
    if (!ts.includes(tanque)) tanque = ts[0] || null;
    el('ba-comb').innerHTML = ts.map((t) => '<button type="button" data-tanque="' + t + '" aria-pressed="' + (t === tanque) + '">' + NOME_TANQUE[t] + '</button>').join('');
  }
  function quando() {
    if (modo === 'rapido') return agoraLocal();
    return f.data.value && f.hora.value ? f.data.value + 'T' + f.hora.value.slice(0, 5) : '';
  }
  function estoqueAgora() {
    const b = bases.find((x) => x.id === Number(f.base.value));
    return b && tanque ? calcularEstoque(b, tanque, { linhas: dados.linhas, movimentacoes: movs, manuais }) : null;
  }
  // resumo antes de lançar: KM anterior, km rodado, média, preço e estoque
  function resumo() {
    const placa = normPlaca(f.placa.value), km = lerNum(f.km.value, true), litros = lerNum(f.litros.value);
    const e = estoqueAgora();
    const partes = [];
    if (e) partes.push('Estoque de ' + NOME_TANQUE[tanque] + ': <strong>' + num(e.volume, 0) + ' L</strong>' + (litros > 0 ? ' → ' + num(e.volume - litros, 0) + ' L depois deste' : '') +
      ' · preço médio <strong>' + (e.preco === null ? '—' : 'R$ ' + num(e.preco, 2)) + '</strong>' + (e.preco !== null && litros > 0 ? ' (R$ ' + num(e.preco * litros, 2) + ' no total)' : ''));
    if (PLACA_OK.test(placa) && tanque) {
      const u = ultHodo.get(placa + '|' + tanque);
      if (u) {
        const rod = km > 0 ? km - u.km : null;
        partes.push('Último ' + NOME_TANQUE[tanque] + ' de ' + esc(placa) + ': ' + esc(fmtMinutos(u.t)) + ', KM ' + num(u.km) + ' (' + esc(u.posto || '') + ')' +
          (rod !== null ? ' · rodou <strong class="' + (rod < 0 ? 'neg-txt' : '') + '">' + num(rod) + ' km</strong>' + (rod > 0 && litros > 0 ? ' · média <strong>' + num(rod / litros, 2) + ' km/L</strong>' : '') : ''));
        if (rod !== null && rod < 0) partes.push('<span class="aviso-linha">O KM está menor que o do último abastecimento desta placa: confira.</span>');
        if (rod !== null && rod > 3000) partes.push('<span class="aviso-linha">Mais de 3.000 km desde o último abastecimento: confira o KM.</span>');
      } else partes.push('Sem abastecimento anterior de ' + NOME_TANQUE[tanque] + ' para ' + esc(placa) + ' na Base: o KM rodado fica em branco.');
    } else if (f.placa.value && !PLACA_OK.test(placa)) partes.push('<span class="aviso-linha">Placa no formato ABC1234 ou ABC1D23.</span>');
    if (e && litros > 0 && litros > e.volume) partes.push('<span class="aviso-linha">A litragem passa do estoque calculado do tanque.</span>');
    el('ba-resumo').innerHTML = partes.map((p) => '<p>' + p + '</p>').join('');
  }
  function sugerirMotorista() {
    const u = ultMotorista.get(normPlaca(f.placa.value));
    if (u && (!f.motorista.value || f.motorista.dataset.sugerido === '1')) { f.motorista.value = u.nome; f.motorista.dataset.sugerido = '1'; }
  }
  // "+ Adicionar abastecimento": menu com os dois tipos; cada um abre o formulário numa janela
  const dlgNovo = el('ba-dlg-novo'), menu = el('ba-novo-menu'), botaoNovo = el('ba-novo');
  function abrirMenu(abrir) {
    menu.classList.toggle('oculto', !abrir);
    botaoNovo.setAttribute('aria-expanded', String(abrir));
    if (abrir) menu.querySelector('[data-modo]').focus();
  }
  botaoNovo.addEventListener('click', () => abrirMenu(menu.classList.contains('oculto')));
  document.addEventListener('click', fecharMenuFora);
  function fecharMenuFora(e) { if (!menu.classList.contains('oculto') && !e.target.closest('.ba-novo')) abrirMenu(false); }
  menu.addEventListener('keydown', (e) => {
    const itens = [...menu.querySelectorAll('[data-modo]')], i = itens.indexOf(document.activeElement);
    if (e.key === 'Escape') { abrirMenu(false); botaoNovo.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); itens[(i + (e.key === 'ArrowDown' ? 1 : itens.length - 1)) % itens.length].focus(); }
  });
  menu.addEventListener('click', (e) => { const b = e.target.closest('[data-modo]'); if (b) { abrirMenu(false); abrirNovo(b.dataset.modo); } });
  function abrirNovo(m) {
    modo = m;
    f.placa.value = ''; f.km.value = ''; f.litros.value = ''; f.motorista.value = ''; f.motorista.dataset.sugerido = '1';
    el('ba-erro').classList.add('oculto');
    pagina.querySelectorAll('.ba-det').forEach((x) => x.classList.toggle('oculto', m !== 'detalhado'));
    el('ba-novo-titulo').textContent = m === 'rapido' ? 'Abastecimento rápido' : 'Abastecimento detalhado';
    el('ba-explica').textContent = m === 'rapido'
      ? 'Na hora do abastecimento: a data e o horário são os de agora.'
      : 'Para abastecimento feito antes e não lançado na hora: informe a data e o horário em que ele foi feito.';
    if (m === 'detalhado') { const a = agoraLocal(); f.data.value = a.slice(0, 10); f.hora.value = a.slice(11, 16); }
    desenharCombustivel();
    resumo();
    dlgNovo.showModal();
    f.placa.focus();
  }
  const mensagem = (html) => { const m = el('ba-msg'); m.innerHTML = html; m.classList.toggle('oculto', !html); };
  el('ba-comb').addEventListener('click', (e) => { const b = e.target.closest('[data-tanque]'); if (b) { tanque = b.dataset.tanque; desenharCombustivel(); resumo(); } });
  f.base.addEventListener('change', () => { desenharCombustivel(); resumo(); });
  f.placa.addEventListener('input', () => { sugerirMotorista(); resumo(); });
  f.motorista.addEventListener('input', () => { f.motorista.dataset.sugerido = '0'; });
  f.km.addEventListener('input', resumo);
  f.litros.addEventListener('input', resumo);

  const falha = (msg, campo) => { const er = el('ba-erro'); er.textContent = msg; er.classList.remove('oculto'); if (campo) campo.focus(); };
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    el('ba-erro').classList.add('oculto');
    const b = bases.find((x) => x.id === Number(f.base.value));
    const placa = normPlaca(f.placa.value), km = lerNum(f.km.value, true), litros = lerNum(f.litros.value);
    const motorista = String(f.motorista.value || '').replace(/\s+/g, ' ').trim().toUpperCase();
    const q = quando();
    if (!b || !tanque) return falha('Escolha a unidade e o combustível.', f.base);
    if (!PLACA_OK.test(placa)) return falha('Placa no formato ABC1234 ou ABC1D23.', f.placa);
    if (!(Number.isInteger(km) && km > 0)) return falha('Informe o KM (hodômetro), só números.', f.km);
    if (!(litros > 0 && litros <= 5000)) return falha('Informe a litragem.', f.litros);
    if (!q) return falha('Informe a data e o horário.', f.data);
    if (minutosDe(q) > minutosDe(agoraLocal()) + 5) return falha('A data e o horário não podem ser no futuro.', f.data);
    const u = ultHodo.get(placa + '|' + tanque);
    if (u && km < u.km && !await confirmar('O KM ' + num(km) + ' é menor que o do último abastecimento desta placa (' + num(u.km) + '). Lançar assim mesmo?')) return;
    const est = estoqueAgora();
    const preco = est && est.preco !== null ? Math.round(est.preco * 10000) / 10000 : null;
    const btn = el('ba-salvar');
    btn.disabled = true; btn.textContent = historico ? 'Lançando…' : 'Preparando o histórico da Base…';
    try {
      if (historico && historico.erro) preparar = buscarHistorico();   // falhou antes: tenta de novo
      await preparar;
      if (!historico || historico.erro) throw new Error('Não foi possível carregar o histórico da Base' + (historico && historico.erro ? ': ' + historico.erro.replace(/\.$/, '') : '') + '. Recarregue a página em alguns minutos.');
      if (!baseHist) baseHist = CORE.carregarHistorico(historico);
      const ev = CORE.eventoManual({ quando: q, placa, km, litros, combustivel: COMBUSTIVEL_DO_TANQUE[tanque], posto: b.posto, motorista, preco });
      // consolidar() acrescenta o evento ao histórico em memória (cadeia de KM): em caso de falha o histórico é refeito
      let r;
      try { r = CORE.consolidar({ base: baseHist, manuais: [ev] }); } catch (x) { baseHist = null; throw x; }
      if (r.duplicados.length || !r.eventos.length) throw new Error('Já existe um abastecimento de ' + placa + ' com o KM ' + num(km) + ' e este combustível (na Base ou lançado agora).');
      const pronto = r.eventos[0];
      const linha = ['MANUAL', ...CORE.buildRow(pronto)];
      const resp = await fetch('/api/bomba/abastecimentos', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_id: b.id, tanque, quando: q, placa, km, litros, motorista, preco, linha }) });
      const j = await resp.json().catch(() => ({}));
      if (resp.status === 401) { location.href = '/?entrar=1'; return; }
      if (!resp.ok) { baseHist = null; throw new Error(j.erro || 'Não foi possível lançar.'); }
      // o lançamento já está na cadeia de KM em memória; marca a chave para não lançar duas vezes
      const chave = [placa, km, COMBUSTIVEL_DO_TANQUE[tanque]].join('§');
      if (!baseHist.existing_keys.has(chave)) baseHist.existing_keys.set(chave, []);
      baseHist.existing_keys.get(chave).push(ev['DATA TRANSACAO']);
      manuais = [j.abastecimento, ...manuais];
      ultHodo.set(placa + '|' + tanque, { t: minutosDe(q), km, posto: b.posto });
      if (motorista) ultMotorista.set(placa, { t: minutosDe(q), nome: motorista });
      const rodado = pronto['KM RODADOS OU HORAS TRABALHADAS'];
      dlgNovo.close();
      mensagem('<p class="ba-ok"><strong>Lançado:</strong> ' + esc(placa) + ', ' + num(litros, 2) + ' L de ' + NOME_TANQUE[tanque] + ' em ' + esc(fmtQuando(q)) +
        (typeof rodado === 'number' ? ', ' + num(rodado) + ' km rodados' : '') +
        '. O computador da sincronização grava na Base_copia em instantes.</p>');
      desenharLista();
      vigiar();
      botaoNovo.focus();
    } catch (err) {
      falha(err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Lançar abastecimento';
    }
  });

  // situação na Base_copia: a do lançamento ou, depois de uma correção/exclusão, a dela
  const emEspera = (e) => !e || e === 'pendente' || e === 'aguardando';
  function situacao(a) {
    if (a.excluido) {
      if (!a.alt_estado) return '<span class="ea-st ea-st-excluir">Excluído</span><small class="cidade-linha">não estava na Base_copia</small>';
      return '<span class="ea-st ea-st-' + esc(a.alt_estado) + '">' + (emEspera(a.alt_estado) ? 'Exclusão aguardando gravação' : a.alt_estado === 'aplicada' ? 'Excluído da Base_copia' : 'Exclusão não gravada') + '</span>' +
        (a.alt_mensagem && a.alt_estado !== 'aplicada' ? '<small class="cidade-linha">' + esc(a.alt_mensagem) + '</small>' : '');
    }
    if (a.alt_acao === 'editar' && a.alt_estado && a.alt_estado !== 'aplicada') {
      return '<span class="ea-st ea-st-' + esc(a.alt_estado) + '">' + (emEspera(a.alt_estado) ? 'Correção aguardando gravação' : 'Correção não gravada') + '</span>' +
        (a.alt_mensagem ? '<small class="cidade-linha">' + esc(a.alt_mensagem) + '</small>' : '');
    }
    return '<span class="ea-st ea-st-' + esc(a.estado || 'pendente') + '">' + esc(ESTADO[a.estado || 'pendente'] || a.estado) + (a.linha_inicial ? ' (linha ' + a.linha_inicial + ')' : '') + '</span>' +
      (a.mensagem && a.estado !== 'aplicada' ? '<small class="cidade-linha">' + esc(a.mensagem) + '</small>' : '') +
      (a.editado_em ? '<small class="cidade-linha">corrigido por ' + esc(a.editado_por || '') + '</small>' : '');
  }
  // editar/excluir: só depois de gravado na Base_copia (lote com erro: só excluir) e sem correção esperando
  function acoes(a) {
    if (a.excluido) return '';
    if (a.alt_estado && emEspera(a.alt_estado)) return '<small class="cidade-linha">aguardando a correção</small>';
    const gravado = a.estado === 'aplicada';
    if (!gravado && a.estado !== 'erro') return '<small class="cidade-linha">aguardando gravação</small>';
    return (gravado ? '<button type="button" class="btn-linha" data-editar="' + a.id + '">Editar</button>' : '') +
      '<button type="button" class="btn-lixeira" data-excluir="' + a.id + '" aria-label="Excluir abastecimento" title="Excluir abastecimento"><svg aria-hidden="true"><use href="#i-lixeira"/></svg></button>';
  }
  // pesquisa: placa, motorista, unidade, combustível, data, quem lançou (sem acento, maiúsculas ou espaços)
  let busca = '';
  const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  el('ba-busca').addEventListener('input', (e) => { busca = semAcento(e.target.value.trim()); desenharLista(); });
  function desenharLista() {
    const nomeBase = (id) => (todasBases.find((b) => b.id === id) || {}).nome || '—';
    const todos = manuais;
    const ativos = todos.filter((a) => !a.excluido).length;
    const termos = busca.split(/\s+/).filter(Boolean);
    const visiveis = termos.length ? todos.filter((a) => {
      const t = semAcento([a.placa, a.motorista, nomeBase(a.base_id), NOME_TANQUE[a.tanque], fmtQuando(a.quando), a.usuario_nome, a.km].join(' '));
      return termos.every((p) => t.includes(p) || (p.replace(/[^a-z0-9]/g, '') && t.replace(/[^a-z0-9 ]/g, '').includes(p.replace(/[^a-z0-9]/g, ''))));
    }) : todos;
    el('ba-conta').textContent = termos.length ? num(visiveis.length) + ' de ' + num(todos.length) : num(ativos) + (ativos === 1 ? ' abastecimento' : ' abastecimentos');
    el('ba-lista').innerHTML = '<thead><tr><th><span>Data e hora</span></th><th><span>Unidade</span></th><th><span>Combustível</span></th><th><span>Placa</span></th>' +
      '<th class="n"><span>KM</span></th><th class="n"><span>Litros</span></th><th class="n"><span>R$/L</span></th><th><span>Motorista</span></th><th><span>Lançado por</span></th><th><span>Base_copia</span></th>' +
      '<th class="acoes-linha"><span>Ações</span></th></tr></thead><tbody>' +
      (visiveis.length ? visiveis.map((a) => '<tr class="' + (a.excluido ? 'linha-apagada' : '') + '"><td>' + esc(fmtQuando(a.quando)) + '</td><td>' + esc(nomeBase(a.base_id)) + '</td><td>' + esc(NOME_TANQUE[a.tanque]) + '</td>' +
        '<td><strong>' + esc(a.placa) + '</strong></td><td class="n">' + num(a.km) + '</td><td class="n">' + num(a.litros, 2) + '</td><td class="n">' + (a.preco ? num(a.preco, 2) : '—') + '</td>' +
        '<td class="trunc">' + esc(a.motorista || '') + '</td><td>' + esc(a.usuario_nome) + '</td>' +
        '<td>' + situacao(a) + '</td><td class="acoes-linha">' + acoes(a) + '</td></tr>').join('')
        : '<tr><td colspan="11"><div class="vazio">' + (termos.length ? 'Nenhum abastecimento com esse texto.'
          : 'Nenhum abastecimento lançado pelo site nos últimos 90 dias. Use "Adicionar abastecimento" para lançar.') + '</div></td></tr>') + '</tbody>';
  }

  // ---------- editar e excluir ----------
  const fe = el('ba-form-ed'), dlg = el('ba-dlg');
  let editando = null, tanqueEd = null;
  pagina.querySelectorAll('[data-fechar]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  function desenharCombEd() {
    const b = bases.find((x) => x.id === Number(fe.base.value));
    const ts = ['diesel', 'arla'].filter((t) => b && b.tanques[t]);
    if (!ts.includes(tanqueEd)) tanqueEd = ts[0] || null;
    el('ba-ed-comb').innerHTML = ts.map((t) => '<button type="button" data-tanque="' + t + '" aria-pressed="' + (t === tanqueEd) + '">' + NOME_TANQUE[t] + '</button>').join('');
  }
  el('ba-ed-comb').addEventListener('click', (e) => { const b = e.target.closest('[data-tanque]'); if (b) { tanqueEd = b.dataset.tanque; desenharCombEd(); } });
  fe.base.addEventListener('change', desenharCombEd);
  const falhaEd = (msg, campo) => { const er = el('ba-ed-erro'); er.textContent = msg; er.classList.remove('oculto'); if (campo) campo.focus(); };
  function abrirEdicao(a) {
    if (!bases.some((b) => b.id === a.base_id)) { alert('A unidade deste abastecimento está inativa. Reative a base no Estoque para editar.'); return; }
    editando = a;
    el('ba-ed-erro').classList.add('oculto');
    el('ba-dlg-titulo').textContent = 'Editar abastecimento de ' + a.placa;
    fe.base.value = String(a.base_id); tanqueEd = a.tanque; desenharCombEd();
    fe.data.value = a.quando.slice(0, 10); fe.hora.value = a.quando.slice(11, 16);
    fe.placa.value = a.placa; fe.km.value = String(a.km ?? ''); fe.litros.value = String(a.litros).replace('.', ',');
    fe.motorista.value = a.motorista || '';
    dlg.showModal();
    fe.km.focus();
  }

  // lista da Base_copia (linha de cada abastecimento na planilha e os seguintes da mesma placa e combustível)
  let copia = null;
  async function listaCopia() {
    if (copia) return copia;
    const d = await obter('/gestao/dados/base-copia.json');
    const c = d.col, D = d.dic, txt = (k, i) => (c[k][i] === null ? null : D[k][c[k][i]]);
    copia = c.linha.map((linha, i) => ({
      linha, serial: c.dt[i], placa: normPlaca(txt('placa', i)), fk: CORE.chaveCadeia(CORE.normFuel(txt('fuel', i) || '')[0] || ''),
      hodo: c.hodo[i], litros: c.litros[i], km: c.km[i], kml: c.kml[i],
    })).sort((a, b) => a.serial - b.serial || a.linha - b.linha);
    return copia;
  }
  const serialDe = (q) => minutosDe(q) / 1440 + 25569;
  const chaveFuel = (t) => CORE.chaveCadeia(CORE.normFuel(COMBUSTIVEL_DO_TANQUE[t])[0]);
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  // a linha do abastecimento na Base_copia e os seguintes (da cadeia antiga e da nova) cujo km rodado muda
  async function vizinhosDe(antigo, novo) {
    let lista;
    try { lista = await listaCopia(); } catch { return { linha: null, vizinhos: [], semLista: true }; }
    const sAnt = serialDe(antigo.quando), fkAnt = chaveFuel(antigo.tanque);
    const propria = lista.find((r) => r.placa === antigo.placa && r.fk === fkAnt && Math.abs(r.serial - sAnt) < 30 / 86400);
    const resto = lista.filter((r) => r !== propria);
    const cadeia = (placa, fk) => resto.filter((r) => r.placa === placa && r.fk === fk);
    const sNovo = novo ? serialDe(novo.quando) : null, fkNovo = novo ? chaveFuel(novo.tanque) : null;
    const candidatos = [];
    const seguinte = (placa, fk, s) => cadeia(placa, fk).find((r) => r.serial > s);
    const a = seguinte(antigo.placa, fkAnt, sAnt); if (a) candidatos.push(a);
    if (novo) { const b = seguinte(novo.placa, fkNovo, sNovo); if (b && b !== a) candidatos.push(b); }
    const vizinhos = [];
    for (const c of candidatos) {
      if (typeof c.hodo !== 'number') continue;
      const antes = cadeia(c.placa, c.fk).filter((r) => r.serial < c.serial && typeof r.hodo === 'number');
      const prev = antes.length ? antes[antes.length - 1] : null;
      let prevHodo = prev ? prev.hodo : null;
      if (novo && novo.placa === c.placa && fkNovo === c.fk && sNovo < c.serial && (!prev || sNovo > prev.serial)) prevHodo = novo.km;
      const R = prevHodo === null ? null : c.hodo - prevHodo;
      const S = R !== null && c.litros > 0 ? r6(R / c.litros) : null;
      if (R === c.km) continue;
      vizinhos.push({ linha: c.linha, placa: c.placa, data: c.serial, celulas: { R, S }, antes: { R: c.km ?? null, S: c.kml ?? null } });
    }
    return { linha: propria ? propria.linha : null, vizinhos };
  }
  async function enviarCorrecao(corpo) {
    const resp = await fetch('/api/bomba/abastecimentos', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    const j = await resp.json().catch(() => ({}));
    if (resp.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
    if (!resp.ok) throw new Error(j.erro || 'Não foi possível salvar.');
    manuais = manuais.map((x) => (x.id === j.abastecimento.id ? j.abastecimento : x));
    baseHist = null; copia = null;   // o histórico e a lista mudam com a correção
    desenharLista(); resumo(); vigiar();
    return j;
  }
  async function prepararMotor() {
    if (historico && historico.erro) preparar = buscarHistorico();
    await preparar;
    if (!historico || historico.erro) throw new Error('Não foi possível carregar o histórico da Base' + (historico && historico.erro ? ': ' + historico.erro.replace(/\.$/, '') : '') + '. Recarregue a página em alguns minutos.');
  }

  fe.addEventListener('submit', async (e) => {
    e.preventDefault();
    el('ba-ed-erro').classList.add('oculto');
    const a = editando, b = bases.find((x) => x.id === Number(fe.base.value));
    const placa = normPlaca(fe.placa.value), km = lerNum(fe.km.value, true), litros = lerNum(fe.litros.value);
    const motorista = String(fe.motorista.value || '').replace(/\s+/g, ' ').trim().toUpperCase();
    const q = fe.data.value && fe.hora.value ? fe.data.value + 'T' + fe.hora.value.slice(0, 5) : '';
    if (!b || !tanqueEd) return falhaEd('Escolha a unidade e o combustível.', fe.base);
    if (!q) return falhaEd('Informe a data e o horário.', fe.data);
    if (minutosDe(q) > minutosDe(agoraLocal()) + 5) return falhaEd('A data e o horário não podem ser no futuro.', fe.data);
    if (!PLACA_OK.test(placa)) return falhaEd('Placa no formato ABC1234 ou ABC1D23.', fe.placa);
    if (!(Number.isInteger(km) && km > 0)) return falhaEd('Informe o KM (hodômetro), só números.', fe.km);
    if (!(litros > 0 && litros <= 5000)) return falhaEd('Informe a litragem.', fe.litros);
    // preço: o do lançamento; trocando a unidade ou o combustível, o preço médio do estoque do outro tanque
    let preco = a.preco;
    if (b.id !== a.base_id || tanqueEd !== a.tanque) {
      const est = calcularEstoque(b, tanqueEd, { linhas: dados.linhas, movimentacoes: movs, manuais });
      preco = est && est.preco !== null ? Math.round(est.preco * 10000) / 10000 : null;
    }
    const btn = el('ba-ed-salvar');
    btn.disabled = true; btn.textContent = 'Salvando…';
    try {
      await prepararMotor();
      // linha remontada sem o próprio abastecimento no histórico (senão ele é o "anterior" dele mesmo)
      const hist = CORE.carregarHistorico(historico);
      CORE.tirarDoHistorico(hist, { placa: a.placa, combustivel: COMBUSTIVEL_DO_TANQUE[a.tanque], quando: a.quando });
      const ev = CORE.eventoManual({ quando: q, placa, km, litros, combustivel: COMBUSTIVEL_DO_TANQUE[tanqueEd], posto: b.posto, motorista, preco });
      const r = CORE.consolidar({ base: hist, manuais: [ev] });
      if (r.duplicados.length || !r.eventos.length) throw new Error('Já existe outro abastecimento de ' + placa + ' com o KM ' + num(km) + ' e este combustível.');
      const linha = ['MANUAL', ...CORE.buildRow(r.eventos[0])];
      const novo = { placa, km, tanque: tanqueEd, quando: q };
      const mexeuCadeia = placa !== a.placa || km !== a.km || tanqueEd !== a.tanque || q !== a.quando;
      const viz = await vizinhosDe(a, novo);
      if (!mexeuCadeia) viz.vizinhos = [];
      await enviarCorrecao({ id: a.id, acao: 'editar', base_id: b.id, tanque: tanqueEd, quando: q, placa, km, litros, motorista, preco, linha,
        linha_planilha: viz.linha, vizinhos: viz.vizinhos });
      dlg.close();
      mensagem('<p class="ba-ok"><strong>Correção salva:</strong> ' + esc(placa) + ' em ' + esc(fmtQuando(q)) +
        (viz.vizinhos.length ? ' (e o km rodado de ' + viz.vizinhos.length + ' abastecimento(s) seguinte(s) da placa)' : '') + '. O computador da sincronização grava na Base_copia em instantes.' +
        (viz.semLista && mexeuCadeia ? ' Não consegui ler a lista da Base_copia: confira o km rodado do próximo abastecimento desta placa em Editar abastecimentos.' : '') + '</p>');
    } catch (err) {
      if (err.message !== 'sessão') falhaEd(err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Salvar correção';
    }
  });

  async function excluirLancamento(a) {
    const gravado = a.estado === 'aplicada';
    if (!await confirmar('Excluir o abastecimento de ' + a.placa + ' (' + fmtQuando(a.quando) + ', ' + num(a.litros, 2) + ' L)?' +
      (gravado ? '\nA linha sai da Base_copia e o km rodado do próximo abastecimento da placa é refeito.' : '\nEle não chegou a ser gravado na Base_copia; só sai do site.'))) return;
    try {
      if (gravado) await prepararMotor();   // normKey/normFuel para achar a cadeia na lista da Base_copia
      const viz = gravado ? await vizinhosDe(a, null) : { linha: null, vizinhos: [] };
      await enviarCorrecao({ id: a.id, acao: 'excluir', linha_planilha: viz.linha, vizinhos: viz.vizinhos });
      mensagem('<p class="ba-ok"><strong>Excluído:</strong> ' + esc(a.placa) + ' em ' + esc(fmtQuando(a.quando)) +
        (gravado ? '. O computador da sincronização tira a linha da Base_copia em instantes.' : '.') + '</p>');
    } catch (err) {
      if (err.message !== 'sessão') alert(err.message);
    }
  }
  el('ba-lista').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-editar]'), ex = e.target.closest('[data-excluir]');
    const id = Number(ed ? ed.dataset.editar : ex ? ex.dataset.excluir : NaN);
    const a = manuais.find((x) => x.id === id);
    if (!a) return;
    if (ed) abrirEdicao(a); else excluirLancamento(a);
  });

  // acompanha a gravação na Base_copia (a cada 15 s enquanto houver lançamento ou correção pendente)
  let timer = null, parado = false;
  async function acompanhar() {
    timer = null;
    if (parado || !manuais.some((a) => (!a.excluido && emEspera(a.estado)) || (a.alt_estado && emEspera(a.alt_estado)))) return;
    try { manuais = (await obter('/api/bomba/abastecimentos')).abastecimentos; desenharLista(); } catch {}
    if (!parado) timer = setTimeout(acompanhar, 15000);
  }
  function vigiar() { if (!timer && !parado) timer = setTimeout(acompanhar, 15000); }

  desenharCombustivel();
  desenharLista();
  vigiar();
  return { desmontar() { parado = true; clearTimeout(timer); document.removeEventListener('click', fecharMenuFora); } };
}
