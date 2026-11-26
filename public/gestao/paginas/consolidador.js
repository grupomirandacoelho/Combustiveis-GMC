// Operacional > Consolidador: réplica do "Consolidador de Abastecimentos.html" (pasta Alimentação base).
// Você envia só os arquivos das plataformas (Ticket, Truckpag, Veloe, Vibra); o histórico da Base vem pronto do
// computador da sincronização (Base.xlsx + CONTROLES\Base_copia.xlsx). O motor é o mesmo do HTML (lib/consolidador.js).
// As decisões sobre postos ficam gravadas (não pergunta de novo) e o resultado vai para a Base_copia pelo vigia.
import { esc, fmt } from '../lib/dados.js';
import * as CORE from '../lib/consolidador.js';
import { carregarSheetJS } from '../lib/sheetjs.js';

// arquivos das plataformas (os mesmos do "Consolidador de Abastecimentos.html"); cada um é opcional no consolidar()
const ARQUIVOS = [
  { id: 'ticket', rotulo: 'Ticket.xlsx', explica: 'exportação da Ticket Log', aceita: '.xlsx' },
  { id: 'truckpag', rotulo: 'Truckpag.xlsx', explica: 'exportação da Truckpag', aceita: '.xlsx' },
  { id: 'veloe', rotulo: 'Veloe.csv', explica: 'exportação da Veloe', aceita: '.csv' },
  { id: 'vibra', rotulo: 'Vibra.xlsx', explica: 'extrato do Cais da Vibra', aceita: '.xlsx' },
];
const NOME_ESTADO = { pendente: 'Aguardando gravação', aguardando: 'Base_copia aberta no Excel', aplicada: 'Gravado na Base_copia', erro: 'Erro ao gravar' };
const DECISAO = { mesmo: 'É o mesmo posto da Base', novo: 'Posto novo (endereço do arquivo)', ignorar: 'Deixar em branco' };

// datas do consolidador são "relógio ingênuo" guardado em UTC (como no HTML)
function fmtData(d) {
  if (!(d instanceof Date)) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}
const quando = (iso) => { const d = new Date(iso); return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
const lerLatin1 = async (f) => new TextDecoder('iso-8859-1').decode(await f.arrayBuffer());
const fonteHtml = (f) => '<span class="cs-fonte cs-' + esc(String(f).toLowerCase()) + '">' + esc(f) + '</span>';

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando o histórico da Base…</div>';
  let historico, info;
  async function carregarInfo() {
    const r = await fetch('/api/consolidador', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || 'Não foi possível abrir o consolidador.');
    info = j;
  }
  try {
    const [h] = await Promise.all([
      fetch('/gestao/dados/consolidacao.json', { credentials: 'same-origin' }).then(async (r) => {
        if (r.status === 401 || r.redirected) { location.href = '/?entrar=1'; throw new Error('sessão'); }
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.erro || 'Não foi possível carregar o histórico da Base (' + r.status + ').');
        return j;
      }),
      carregarInfo(),
      carregarSheetJS(),
    ]);
    historico = h;
  } catch (e) {
    pagina.innerHTML = '<div class="vazio">' + esc(e.message) + '</div>';
    return {};
  }
  const editar = info.podeEditar;
  const g = new Date(historico.geradoEm);
  ctx.definirSub('Histórico da Base lido em ' + g.toLocaleDateString('pt-BR') + ' às ' + g.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) +
    ' (' + historico.fontes.map((f) => f.arquivo + ': ' + fmt.int(f.linhas) + ' linhas').join(' · ') + '). A Base nunca é alterada.');

  const estado = {
    arquivos: {},                      // id -> File
    ultimo: null,                      // resultado da última consolidação
    motoristas: new Map(),             // chave -> {nome, matricula} confirmados nesta tela
    trocas: new Map(),                 // nome do arquivo (normKey) -> {de, para}: motorista sem histórico trocado nesta tela
    sessaoPostos: new Map(),           // decisões desta tela (de quem só consulta)
    gravado: false,                    // o resultado atual já virou lote
  };

  pagina.innerHTML = `
    <section class="painel">
      <div class="painel-cab"><h2>1. Arquivos das plataformas</h2><span class="conta" id="cs-conta-arq">nenhum arquivo</span></div>

      <div class="cs-arquivos">${ARQUIVOS.map((a) => `
        <label class="cs-arquivo" id="cs-slot-${a.id}">
          <span class="cs-arq-rot">${esc(a.rotulo)}</span>
          <span class="cs-arq-nome" id="cs-nome-${a.id}">${esc(a.explica)}</span>
          <span class="cs-arq-selo" id="cs-selo-${a.id}">vazio</span>
          <input type="file" accept="${a.aceita}" data-arquivo="${a.id}">
        </label>`).join('')}
      </div>
      <div class="cs-acoes">
        <button type="button" class="btn btn-principal" id="cs-processar" disabled>Processar consolidação</button>
        <span class="nota" id="cs-status"></span>
      </div>
    </section>
    <div id="cs-resultado" class="oculto">
      <section class="painel"><div class="painel-cab"><h2>2. Resultado</h2><span class="conta" id="cs-total"></span></div>
        <dl class="apoio apoio-pilha" id="cs-tiles"></dl></section>
      <section class="painel"><div class="painel-cab"><h2>3. Transações ignoradas por duplicidade</h2><span class="conta" id="cs-dup-conta"></span></div>
        <p class="nota">Bateram com algo que já existe na Base (mesma placa + hodômetro + combustível) e <strong>não entram</strong>. Se a data na Base for muito anterior,
          pode ser só coincidência de hodômetro: confira no arquivo de origem.</p>
        <div class="tabela-rolagem cs-rolagem"><table class="dados" id="cs-dup"></table></div></section>
      <section class="painel"><div class="painel-cab"><h2>4. Motoristas sem histórico</h2><span class="conta" id="cs-mot-conta"></span></div>
        <p class="nota">Nomes sem matrícula na Base: contratado novo (aguarde o próximo cadastro na Ticket) ou erro de digitação no arquivo.
          Se o motorista está <strong>cadastrado errado no portal do cartão</strong>, escolha em "Trocar por" o motorista certo: a troca vale para todos os
          abastecimentos desse nome neste lote e a matrícula vem da Base. Corrija também o cadastro no portal do cartão.</p>
        <div class="tabela-rolagem"><table class="dados" id="cs-mot"></table></div>
        <p class="nota oculto" id="cs-mot-trocas"></p>
        <div class="cs-acoes"><button type="button" class="btn oculto" id="cs-mot-aplicar">Trocar motoristas e reprocessar</button></div></section>
      <section class="painel"><div class="painel-cab"><h2>5. Motoristas sugeridos (sem nome no arquivo)</h2><span class="conta" id="cs-sug-conta"></span></div>
        <p class="nota">A Vibra às vezes não informa o motorista. Sugestão = último motorista que abasteceu o veículo. Use a sugestão ou digite outro
          motorista (a matrícula vem da Base). A linha fica em branco até você confirmar.</p>
        <div class="cs-lista" id="cs-sug"></div>
        <datalist id="cs-mots"></datalist>
        <div class="cs-acoes"><button type="button" class="btn oculto" id="cs-sug-aplicar">Confirmar motoristas e reprocessar</button></div></section>
      <section class="painel"><div class="painel-cab"><h2>6. Postos pendentes de autorização</h2><span class="conta" id="cs-pend-conta"></span></div>
        <p class="nota">Postos que não estão na Base. ${editar ? 'Sua decisão <strong>fica gravada</strong>: nas próximas consolidações o posto já entra relacionado, sem perguntar de novo.'
          : 'Seu acesso é só de consulta: as decisões valem só nesta tela.'} Em "é outro posto já cadastrado", escolha o nome exato da Base (confira o endereço).</p>
        <div class="cs-lista" id="cs-pend"></div>
        <datalist id="cs-postos-base"></datalist>
        <div class="cs-acoes"><button type="button" class="btn oculto" id="cs-pend-aplicar">${editar ? 'Gravar decisões e reprocessar' : 'Aplicar e reprocessar'}</button></div></section>
      <section class="painel"><div class="painel-cab"><h2>7. Avisos</h2><span class="conta" id="cs-av-conta"></span></div>
        <div class="cs-log" id="cs-avisos"></div></section>
      ${editar ? `<section class="painel"><div class="painel-cab"><h2>8. Gravar na Base_copia</h2></div>
        <p class="nota">As linhas entram no fim da aba Transações da Base_copia. A Base.xlsx não é alterada.</p>
        <div class="cs-acoes"><button type="button" class="btn btn-principal" id="cs-gravar">Gravar na Base_copia</button><span class="nota" id="cs-gravar-nota"></span></div></section>` : ''}
    </div>
    <section class="painel"><div class="painel-cab"><h2>Lotes gravados na Base_copia</h2><span class="conta" id="cs-lotes-conta"></span></div>
      <div class="tabela-rolagem cs-rolagem"><table class="dados" id="cs-lotes"></table></div></section>
    <section class="painel"><div class="painel-cab"><h2>Postos já relacionados</h2><span class="conta" id="cs-rel-conta"></span></div>
      <p class="nota">Decisões gravadas em "6. Postos pendentes de autorização" (aparece depois de processar os arquivos). Valem em todas as próximas consolidações.${editar ? ' Remova uma se quiser decidir de novo.' : ''}</p>
      <div class="tabela-rolagem cs-rolagem"><table class="dados" id="cs-rel"></table></div></section>`;
  const $ = (id) => pagina.querySelector('#' + id);

  // ---------- arquivos ----------
  pagina.querySelectorAll('input[type="file"][data-arquivo]').forEach((inp) => inp.addEventListener('change', () => {
    const id = inp.dataset.arquivo, f = inp.files[0];
    if (!f) return;
    estado.arquivos[id] = f;
    $('cs-nome-' + id).textContent = f.name;
    $('cs-selo-' + id).textContent = 'carregado';
    $('cs-slot-' + id).classList.add('carregado');
    const n = ARQUIVOS.filter((a) => estado.arquivos[a.id]).length;
    $('cs-conta-arq').textContent = n + (n === 1 ? ' arquivo carregado' : ' arquivos carregados');
    $('cs-processar').disabled = n < 1;
    const faltam = ARQUIVOS.filter((a) => !a.opcional && !estado.arquivos[a.id]).map((a) => a.rotulo);
    $('cs-status').textContent = faltam.length ? 'Pronto para processar (ainda sem ' + faltam.join(' e ') + ').' : 'Pronto para processar.';
  }));

  // ---------- decisões de postos (gravadas + desta tela) ----------
  function decisoes() {
    const todas = new Map();
    for (const p of info.postos) todas.set(CORE.normKey(p.nome), p);
    for (const [k, p] of estado.sessaoPostos) todas.set(k, p);
    const aliasExtras = [], postosNovos = [], postosIgnorados = [];
    for (const p of todas.values()) {
      if (p.decisao === 'mesmo' && p.canonico) aliasExtras.push([p.nome, p.canonico]);
      else if (p.decisao === 'novo') postosNovos.push({ nome_cru: p.nome, endereco: p.endereco, cidade: p.cidade, uf: p.uf });
      else if (p.decisao === 'ignorar') postosIgnorados.push(p.nome);
    }
    return { aliasExtras, postosNovos, postosIgnorados };
  }

  // ---------- processamento ----------
  let entradas = null;
  async function lerArquivos() {
    const XLSX = await carregarSheetJS();
    // arquivo que não foi escolhido fica de fora (o consolidar() trata cada plataforma como opcional)
    const wb = async (id) => (estado.arquivos[id] ? XLSX.read(await estado.arquivos[id].arrayBuffer(), { type: 'array', cellDates: false, raw: true }) : undefined);
    entradas = { ticket: await wb('ticket'), truckpag: await wb('truckpag'),
      veloe: estado.arquivos.veloe ? await lerLatin1(estado.arquivos.veloe) : undefined, vibra: await wb('vibra') };
  }
  function rodar() {
    const base = CORE.carregarHistorico(historico);
    // abastecimentos já mandados para a Base_copia e que o histórico ainda não traz: também contam como duplicados
    for (const l of info.lotes) {
      if (l.estado === 'erro') continue;
      for (const [k, serial] of l.chaves) if (!base.existing_keys.has(k)) base.existing_keys.set(k, [CORE.excelSerialToDate(serial)]);
    }
    const r = CORE.consolidar({ base, ...entradas, ...decisoes(), motoristasConfirmados: estado.motoristas,
      motoristasTrocados: new Map([...estado.trocas].map(([k, t]) => [k, t.para])) });
    estado.ultimo = r;
    estado.gravado = false;
    desenharResultado(r, base);
  }
  $('cs-processar').addEventListener('click', async () => {
    const b = $('cs-processar');
    b.disabled = true; $('cs-status').textContent = 'Processando…';
    try {
      await lerArquivos();
      await new Promise((ok) => setTimeout(ok, 20));
      rodar();
      $('cs-status').textContent = 'Concluído: confira os avisos antes de gravar.';
    } catch (e) {
      console.error(e);
      $('cs-status').textContent = 'Erro ao processar: ' + e.message;
    } finally { b.disabled = false; }
  });

  // ---------- desenho do resultado ----------
  function desenharResultado(r, base) {
    $('cs-resultado').classList.remove('oculto');
    const s = r.resumo;
    $('cs-total').textContent = fmt.int(s.total) + ' linha(s) para gravar';
    $('cs-tiles').innerHTML = [
      ['Ticket', s.n_ticket], ['Truckpag', s.n_truckpag], ['Veloe (filtrado)', s.n_veloe], ['Vibra (filtrado)', s.n_vibra],
      ['Duplicados ignorados', s.n_dup], ['Total para gravar', s.total],
      ['Placas sem histórico', s.placas_sem_historico], ['Motoristas sem histórico', s.motoristas_sem_historico], ['Postos sem histórico', s.postos_sem_historico],
    ].map(([d, v]) => '<div><dt>' + esc(d) + '</dt><dd><span class="num">' + fmt.int(v) + '</span></dd></div>').join('');

    const dup = r.duplicados || [];
    $('cs-dup-conta').textContent = dup.length ? fmt.int(dup.length) + ' transação(ões)' : 'nenhuma';
    $('cs-dup').innerHTML = dup.length
      ? '<thead><tr><th><span>Fonte</span></th><th><span>Placa</span></th><th><span>Data no arquivo</span></th><th class="n"><span>Hodômetro</span></th>' +
        '<th><span>Combustível</span></th><th class="n"><span>Litros</span></th><th class="n"><span>Vl/litro</span></th><th><span>Já existe na Base em</span></th></tr></thead><tbody>' +
        dup.map((d) => '<tr><td>' + fonteHtml(d.fonte) + '</td><td>' + esc(d.placa || '—') + '</td>' +
          '<td class="num">' + esc(fmtData(d.data)) + '</td><td class="n">' + esc(d.hodometro ?? '—') + '</td><td>' + esc(d.combustivel || '—') + '</td>' +
          '<td class="n">' + esc(d.litros ?? '—') + '</td><td class="n">' + esc(d.vl_litro ?? '—') + '</td><td class="num">' + esc(d.datas_base.map(fmtData).join(' · ')) + '</td></tr>').join('') + '</tbody>'
      : '<tbody><tr><td><div class="vazio">Nenhuma transação dos arquivos coincidiu com a Base.</div></td></tr></tbody>';

    const mot = r.motoristas_pendentes || [];
    $('cs-mot-conta').textContent = mot.length ? fmt.int(mot.length) + ' motorista(s)' : 'nenhum';
    $('cs-mot').innerHTML = mot.length
      ? '<thead><tr><th><span>Motorista</span></th><th><span>Fonte</span></th><th><span>Placa</span></th><th><span>Primeira transação</span></th><th class="n"><span>Qtd.</span></th><th><span>Trocar por</span></th></tr></thead><tbody>' +
        mot.map((m, i) => '<tr><td><strong>' + esc(m.nome) + '</strong></td><td>' + fonteHtml(m.fonte) + '</td><td>' + esc(m.placa || '—') + '</td><td class="num">' + esc(fmtData(m.data)) + '</td><td class="n">' + m.count + '</td>' +
          '<td><input type="text" class="cs-manual cs-troca" data-troca="' + i + '" list="cs-mots" placeholder="motorista certo (vazio = manter)" autocomplete="off" spellcheck="false" maxlength="80" aria-label="Trocar ' + esc(m.nome) + ' por"></td></tr>').join('') + '</tbody>'
      : '<tbody><tr><td><div class="vazio">Todos os motoristas dos arquivos já têm matrícula na Base.</div></td></tr></tbody>';

    $('cs-mot-aplicar').classList.toggle('oculto', !mot.length);
    const trocas = [...estado.trocas.values()];
    $('cs-mot-trocas').classList.toggle('oculto', !trocas.length);
    $('cs-mot-trocas').innerHTML = trocas.length ? 'Trocados nesta tela: ' + trocas.map((t) => '<strong>' + esc(t.de) + '</strong> → <strong>' + esc(t.para) + '</strong> ' +
      '<button type="button" class="btn-linha" data-desfazer-troca="' + esc(CORE.normKey(t.de)) + '">desfazer</button>').join(' · ') : '';
    const sug = r.motoristas_sugestoes || [];
    $('cs-sug-conta').textContent = sug.length ? fmt.int(sug.length) + ' pendente(s)' : 'nenhuma pendência';
    $('cs-sug-aplicar').classList.toggle('oculto', !sug.length);
    // cada linha: usar a sugestão (último motorista do veículo) ou digitar outro motorista
    estado.baseAtual = base;
    if (!$('cs-mots').childElementCount) {
      $('cs-mots').innerHTML = [...new Set((historico.dic.mot || []).map((n) => String(n ?? '').trim().toUpperCase()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'pt-BR')).map((n) => '<option value="' + esc(n) + '">').join('');
    }
    $('cs-sug').innerHTML = sug.length ? sug.map((m, i) => {
      const nome = 'cs-sug-' + i;
      return '<div class="cs-pend"><div><strong>' + fonteHtml(m.fonte) + ' placa ' + esc(m.placa) + ' em ' + esc(fmtData(m.data)) + '</strong> — sem motorista no arquivo' +
        (m.sugestao_nome
          ? '<small>sugestão: <strong>' + esc(m.sugestao_nome) + '</strong> (matrícula ' + esc(m.sugestao_matricula || '—') + '), último abastecimento do veículo em ' + esc(fmtData(m.sugestao_data)) + '</small>'
          : '<small>o veículo não tem motorista anterior na Base: digite o motorista</small>') + '</div>' +
        '<div class="cs-decisao">' +
        (m.sugestao_nome ? '<label class="cs-opcao"><input type="radio" name="' + nome + '" value="sugestao" data-sug="' + i + '"> Usar a sugestão (' + esc(m.sugestao_nome) + ')</label>' : '') +
        '<label class="cs-opcao"><input type="radio" name="' + nome + '" value="outro" data-sug="' + i + '"> ' + (m.sugestao_nome ? 'Outro motorista:' : 'Motorista:') + '</label>' +
        '<input type="text" class="cs-manual" data-mot="' + i + '" list="cs-mots" placeholder="nome do motorista" autocomplete="off" spellcheck="false" maxlength="80">' +
        '</div></div>';
    }).join('')
      : '<p class="nota">Nenhum abastecimento sem motorista no arquivo (ou todos já foram confirmados).</p>';
    pagina.querySelectorAll('#cs-sug .cs-manual').forEach((inp) => inp.addEventListener('input', () => {
      const r2 = pagina.querySelector('input[name="cs-sug-' + inp.dataset.mot + '"][value="outro"]');
      if (r2 && inp.value.trim()) r2.checked = true;
    }));

    // nomes de posto da Base para o "é outro posto já cadastrado" (só vale nome que existe na Base)
    estado.nomesBase = new Map([...base.posto_dir.keys()].map((n) => [CORE.normKey(n), n]));
    $('cs-postos-base').innerHTML = [...base.posto_dir.keys()].sort((a, b) => String(a).localeCompare(String(b), 'pt-BR'))
      .map((n) => '<option value="' + esc(n) + '">').join('');
    const pend = r.postos_pendentes || [];
    $('cs-pend-conta').textContent = pend.length ? fmt.int(pend.length) + ' pendente(s)' : 'nenhuma pendência';
    $('cs-pend-aplicar').classList.toggle('oculto', !pend.length);
    $('cs-pend').innerHTML = pend.length ? pend.map((p, i) => {
      const cab = '<strong>' + fonteHtml(p.fonte) + ' "' + esc(p.nome_cru) + '"' +
        (p.temCandidato ? ' → "' + esc(p.candidato) + '"' : ' <span class="sem-dado">— sem candidato parecido na Base</span>') + '</strong>' +
        '<small>placa ' + esc(p.placa || '—') + ' · arquivo: ' + esc((p.endereco || '—') + ', ' + (p.cidade || '—') + '/' + (p.uf || '—')) +
        (p.temCandidato ? ' · Base: ' + esc((p.info.ENDERECO || '—') + ', ' + (p.info.CIDADE || '—') + '/' + (p.info.UF || '—')) + ' (código ' + esc(p.info['CODIGO ESTABELECIMENTO'] || '—') + ')' +
          ' · confiança ' + Math.round(p.score * 100) + '%' : '') + '</small>';
      const nome = 'cs-dec-' + i;
      return '<div class="cs-pend"><div>' + cab + '</div><div class="cs-decisao">' +
        (p.temCandidato ? '<label class="cs-opcao"><input type="radio" name="' + nome + '" value="mesmo"> É o mesmo posto</label>' : '') +
        '<label class="cs-opcao"><input type="radio" name="' + nome + '" value="novo"> ' + (p.temCandidato ? 'Não é: posto novo' : 'Cadastrar como posto novo') + '</label>' +
        '<label class="cs-opcao"><input type="radio" name="' + nome + '" value="manual"> É outro posto já cadastrado:</label>' +
        '<input type="text" class="cs-manual" data-manual="' + i + '" list="cs-postos-base" placeholder="nome exato do posto na Base" autocomplete="off">' +
        '<label class="cs-opcao"><input type="radio" name="' + nome + '" value="ignorar"> Deixar em branco (edito na Base depois)</label>' +
        '</div></div>';
    }).join('') : '<p class="nota">Nenhum posto novo para decidir' + (info.postos.length ? ' (os já relacionados entram sozinhos).' : '.') + '</p>';
    pagina.querySelectorAll('.cs-manual').forEach((inp) => inp.addEventListener('focus', () => {
      const r2 = pagina.querySelector('input[name="cs-dec-' + inp.dataset.manual + '"][value="manual"]');
      if (r2) r2.checked = true;
    }));

    const av = r.avisos;
    $('cs-av-conta').textContent = fmt.int(av.length) + ' aviso(s)';
    $('cs-avisos').innerHTML = av.length ? av.map((a) => {
      let cls = 'info', tag = 'info';
      if (a.startsWith('PEDIDO DE AUTORIZACAO')) { cls = 'alerta'; tag = 'autorização'; }
      else if (a.startsWith('SUGESTAO DE MOTORISTA')) { cls = 'alerta'; tag = 'motorista sugerido'; }
      else if (a.startsWith('MOTORISTA EM BRANCO')) { cls = 'alerta'; tag = 'motorista'; }
      else if (a.startsWith('MOTORISTA TROCADO')) tag = 'motorista trocado';
      else if (a.startsWith('POSTO CADASTRADO COMO NOVO')) tag = 'posto novo';
      else if (a.startsWith('POSTO DEIXADO EM BRANCO')) tag = 'deixado em branco';
      else if (a.startsWith('PLACA SEM HISTORICO') || a.startsWith('MOTORISTA SEM HISTORICO') || a.startsWith('POSTO SEM HISTORICO')) { cls = 'alerta'; tag = 'sem histórico'; }
      else if (a.startsWith('HODOMETRO RETROCEDEU')) { cls = 'ruim'; tag = 'hodômetro'; }
      else if (a.startsWith('CORRECAO MANUAL')) tag = 'correção';
      else if (a.includes('tipo de combustivel nao mapeado')) { cls = 'alerta'; tag = 'combustível'; }
      return '<div class="cs-aviso cs-aviso-' + cls + '"><span class="cs-aviso-tag">' + esc(tag) + '</span><span>' + esc(a) + '</span></div>';
    }).join('') : '<p class="nota">Nenhum aviso: todas as linhas encontraram histórico completo.</p>';
    desenharGravar();
  }

  // ---------- motoristas sugeridos ----------
  // matrícula do motorista digitado: a do último abastecimento dele na Base (vazia se ele não tem histórico)
  function matriculaDe(nome) {
    const hist = estado.baseAtual && estado.baseAtual.driver_hist.get(CORE.normKey(nome));
    if (!hist || !hist.length) return null;
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i][1] !== null && hist[i][1] !== undefined && hist[i][1] !== '') return hist[i][1];
    return null;
  }
  $('cs-sug-aplicar').addEventListener('click', async () => {
    const sug = estado.ultimo.motoristas_sugestoes, novos = [], faltaNome = [], semMatricula = [];
    pagina.querySelectorAll('#cs-sug input[type="radio"]:checked').forEach((c) => {
      const i = Number(c.dataset.sug), s = sug[i];
      if (c.value === 'sugestao') { novos.push([s.chave, { nome: s.sugestao_nome, matricula: s.sugestao_matricula }]); return; }
      const nome = String(pagina.querySelector('#cs-sug .cs-manual[data-mot="' + i + '"]').value || '').replace(/\s+/g, ' ').trim().toUpperCase();
      if (!nome) { faltaNome.push(s.placa); return; }
      const matricula = matriculaDe(nome);
      if (matricula === null) semMatricula.push(nome);
      novos.push([s.chave, { nome, matricula }]);
    });
    if (faltaNome.length) { alert('Digite o nome do motorista para a placa ' + faltaNome.join(', ') + '.'); return; }
    if (!novos.length) { alert('Escolha a sugestão ou digite o motorista em pelo menos uma linha.'); return; }
    if (semMatricula.length && !await confirmar('Sem matrícula na Base: ' + [...new Set(semMatricula)].join(', ') + '.\nO nome entra na linha com a matrícula em branco. Continuar?')) return;
    novos.forEach(([k, v]) => estado.motoristas.set(k, v));
    rodar();
  });

  // ---------- motoristas sem histórico: trocar pelo motorista certo (cadastro errado no portal do cartão) ----------
  $('cs-mot-aplicar').addEventListener('click', async () => {
    const mot = estado.ultimo.motoristas_pendentes || [], novas = [], semMatricula = [];
    pagina.querySelectorAll('#cs-mot .cs-troca').forEach((inp) => {
      const para = String(inp.value || '').replace(/\s+/g, ' ').trim().toUpperCase(), m = mot[Number(inp.dataset.troca)];
      if (!para || !m || CORE.normKey(para) === CORE.normKey(m.nome)) return;
      if (matriculaDe(para) === null) semMatricula.push(para);
      novas.push([CORE.normKey(m.nome), { de: m.nome, para }]);
    });
    if (!novas.length) { alert('Digite em "Trocar por" o motorista certo em pelo menos uma linha.'); return; }
    if (semMatricula.length && !await confirmar('Sem matrícula na Base: ' + [...new Set(semMatricula)].join(', ') + '.\nA troca entra com a matrícula em branco. Continuar?')) return;
    novas.forEach(([k, v]) => estado.trocas.set(k, v));
    rodar();
  });
  $('cs-mot-trocas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-desfazer-troca]');
    if (!b) return;
    estado.trocas.delete(b.dataset.desfazerTroca);
    rodar();
  });

  // ---------- postos pendentes: grava as decisões e reprocessa ----------
  $('cs-pend-aplicar').addEventListener('click', async () => {
    const pend = estado.ultimo.postos_pendentes, novas = [], faltaNome = [], semNaBase = [];
    pend.forEach((p, i) => {
      const marcada = pagina.querySelector('input[name="cs-dec-' + i + '"]:checked');
      if (!marcada) return;
      const base = { nome: p.nome_cru, endereco: p.endereco || null, cidade: p.cidade || null, uf: p.uf || null };
      if (marcada.value === 'mesmo') novas.push({ ...base, decisao: 'mesmo', canonico: p.candidato });
      else if (marcada.value === 'manual') {
        const digitado = (pagina.querySelector('.cs-manual[data-manual="' + i + '"]').value || '').trim();
        const nome = digitado && estado.nomesBase.get(CORE.normKey(digitado));   // o nome exato como está na Base
        if (!digitado) faltaNome.push(p.nome_cru);
        else if (!nome) semNaBase.push('"' + digitado + '" (para ' + p.nome_cru + ')');
        else novas.push({ ...base, decisao: 'mesmo', canonico: nome });
      } else novas.push({ ...base, decisao: marcada.value });
    });
    if (faltaNome.length) { alert('Digite o nome do posto da Base para: ' + faltaNome.join(', ')); return; }
    if (semNaBase.length) { alert('Estes nomes não existem na Base (escolha um da lista que aparece ao digitar): ' + semNaBase.join(', ')); return; }
    if (!novas.length) { alert('Marque a decisão de pelo menos um posto.'); return; }
    const b = $('cs-pend-aplicar');
    b.disabled = true;
    try {
      if (editar) {
        const r = await fetch('/api/consolidador/postos', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'salvar', decisoes: novas }) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 401) { location.href = '/?entrar=1'; return; }
        if (!r.ok) throw new Error(j.erro || 'Não foi possível gravar as decisões.');
        await carregarInfo();
        desenharRelacionados();
      } else {
        for (const d of novas) estado.sessaoPostos.set(CORE.normKey(d.nome), d);
      }
      rodar();
    } catch (e) {
      alert(e.message === 'Failed to fetch' ? 'Sem conexão com o servidor.' : e.message);
    } finally { b.disabled = false; }
  });

  // ---------- gravar na Base_copia ----------
  function desenharGravar() {
    if (!editar) return;
    const r = estado.ultimo, b = $('cs-gravar'), nota = $('cs-gravar-nota');
    const pendPostos = (r.postos_pendentes || []).length, pendMot = (r.motoristas_sugestoes || []).length;
    b.disabled = !r.eventos.length || estado.gravado;
    b.textContent = estado.gravado ? 'Lote enviado' : 'Gravar ' + fmt.int(r.eventos.length) + ' linha(s) na Base_copia';
    nota.textContent = !r.eventos.length ? 'Nada novo para gravar.'
      : estado.gravado ? 'Acompanhe abaixo, em "Lotes gravados na Base_copia".'
      : (pendPostos || pendMot) ? 'Atenção: ' + [pendPostos ? pendPostos + ' posto(s) pendente(s) ficam em branco' : '', pendMot ? pendMot + ' linha(s) sem motorista' : ''].filter(Boolean).join(' e ') + '.'
      : '';
  }
  if (editar) $('cs-gravar').addEventListener('click', async () => {
    const r = estado.ultimo, b = $('cs-gravar');
    if (!r || !r.eventos.length || estado.gravado) return;
    b.disabled = true; b.textContent = 'Enviando…';
    try {
      const linhas = r.eventos.map((ev) => [ev.fonte, ...CORE.buildRow(ev)]);
      const chaves = r.eventos.filter((ev) => ev['HODOMETRO OU HORIMETRO'] !== null && ev['HODOMETRO OU HORIMETRO'] !== undefined)
        .map((ev) => [[ev.PLACA, ev['HODOMETRO OU HORIMETRO'], ev['TIPO COMBUSTIVEL']].join('§'), CORE.dateToSerial(ev['DATA TRANSACAO'])]);
      const resumo = { ...r.resumo, arquivos: ARQUIVOS.map((a) => estado.arquivos[a.id] && estado.arquivos[a.id].name) };
      const resp = await fetch('/api/consolidador/lotes', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resumo, linhas, chaves }) });
      const j = await resp.json().catch(() => ({}));
      if (resp.status === 401) { location.href = '/?entrar=1'; return; }
      if (!resp.ok) throw new Error(j.erro || 'Não foi possível enviar o lote.');
      estado.gravado = true;
      info.lotes.unshift(j.lote);
      desenharLotes();
      acompanhar();
    } catch (e) {
      $('cs-gravar-nota').textContent = e.message === 'Failed to fetch' ? 'Sem conexão com o servidor.' : e.message;
    } finally { desenharGravar(); }
  });

  // ---------- lotes e postos relacionados ----------
  function desenharLotes() {
    const l = info.lotes;
    $('cs-lotes-conta').textContent = l.length ? fmt.int(l.length) + ' nos últimos 60 dias' : '';
    $('cs-lotes').innerHTML = l.length
      ? '<thead><tr><th><span>Quando</span></th><th><span>Quem</span></th><th class="n"><span>Linhas</span></th><th><span>Arquivos</span></th><th><span>Gravação</span></th></tr></thead><tbody>' +
        l.map((x) => {
          const cls = x.estado === 'aplicada' ? 'selo-ok' : x.estado === 'erro' ? 'selo-bloq' : 'selo-espera';
          return '<tr><td>' + esc(quando(x.criado_em)) + '</td><td>' + esc(x.usuario_nome) + '</td><td class="n">' + fmt.int(x.resumo.total) + '</td>' +
            '<td class="trunc">' + esc((x.resumo.arquivos || []).filter(Boolean).join(', ') || '—') + '</td>' +
            '<td><span class="selo ' + cls + '">' + esc(NOME_ESTADO[x.estado]) + (x.linha_inicial ? ' (linhas ' + x.linha_inicial + ' a ' + x.linha_final + ')' : '') + '</span>' +
            (x.mensagem ? '<small class="cidade-linha">' + esc(x.mensagem) + '</small>' : '') +
            // lote das APIs dos cartões: avisos do motor (posto novo, motorista sem matrícula...) para conferir depois
            (x.resumo.origem === 'api' && x.resumo.avisos && x.resumo.avisos.length
              ? '<small class="cidade-linha" title="' + esc(x.resumo.avisos.join('\n')) + '">' + x.resumo.avisos.length + ' aviso(s): ' + esc(x.resumo.avisos[0].slice(0, 110)) + '…</small>' : '') +
            '</td></tr>';
        }).join('') + '</tbody>'
      : '<tbody><tr><td><div class="vazio">Nenhum lote enviado ainda.</div></td></tr></tbody>';
  }
  function desenharRelacionados() {
    const p = info.postos;
    $('cs-rel-conta').textContent = p.length ? fmt.int(p.length) + ' posto(s)' : '';
    $('cs-rel').innerHTML = p.length
      ? '<thead><tr><th><span>Nome no arquivo</span></th><th><span>Decisão</span></th><th><span>Quem</span></th>' + (editar ? '<th class="acoes-linha"><span>Ações</span></th>' : '') + '</tr></thead><tbody>' +
        p.map((x) => '<tr><td><strong>' + esc(x.nome) + '</strong></td><td>' + esc(DECISAO[x.decisao]) +
          (x.decisao === 'mesmo' ? ': <strong>' + esc(x.canonico) + '</strong>' : x.decisao === 'novo' ? '<small class="cidade-linha">' + esc([x.endereco, [x.cidade, x.uf].filter(Boolean).join('/')].filter(Boolean).join(', ') || '—') + '</small>' : '') + '</td>' +
          '<td>' + esc(x.usuario_nome) + '<small class="cidade-linha">' + esc(quando(x.criado_em)) + '</small></td>' +
          (editar ? '<td class="acoes-linha"><button type="button" class="btn-lixeira" data-remover="' + esc(x.chave) + '" aria-label="Remover relação do posto" title="Remover relação do posto"><svg aria-hidden="true"><use href="#i-lixeira"/></svg></button></td>' : '') + '</tr>').join('') + '</tbody>'
      : '<tbody><tr><td><div class="vazio">Nenhum posto relacionado ainda.</div></td></tr></tbody>';
  }
  $('cs-rel').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-remover]');
    if (!b || !await confirmar('Remover esta decisão? Na próxima consolidação o posto volta a aparecer em "Postos pendentes".')) return;
    b.disabled = true;
    const r = await fetch('/api/consolidador/postos', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'remover', chave: b.dataset.remover }) });
    if (r.ok) { await carregarInfo(); desenharRelacionados(); if (estado.ultimo && entradas) rodar(); } else b.disabled = false;
  });

  // enquanto houver lote esperando o vigia, confere a cada 10 s
  let tAcomp = null;
  function acompanhar() {
    clearTimeout(tAcomp);
    if (!info.lotes.some((l) => l.estado === 'pendente' || l.estado === 'aguardando')) return;
    tAcomp = setTimeout(async () => {
      try { await carregarInfo(); desenharLotes(); } catch (e) {}
      acompanhar();
    }, 10 * 1000);
  }

  desenharLotes();
  desenharRelacionados();
  acompanhar();
  return { desmontar() { clearTimeout(tAcomp); } };
}
