// Operacional > Editar abastecimentos: todos os abastecimentos da CONTROLES\Base_copia.xlsx, para corrigir o que veio
// errado das plataformas (principalmente o hodômetro). Editáveis: data e hora, placa, motorista, hodômetro, litros,
// vl/litro, valor total, informação adicional 1 e 3; e dá para excluir o abastecimento.
//  - data e hora nova (coluna E, 16/11/2026): o abastecimento muda de lugar na sequência da placa (como na troca de placa) e
//    o km/km por litro dele, do próximo e dos vizinhos de antes são recalculados. O pedido vai com a data que a planilha
//    tem no momento (com as correções salvas), porque o vigia acha o abastecimento por placa + data;
//  - hodômetro novo: o km rodado e o km/litro são recalculados nesta linha e na próxima da mesma placa e combustível
//    (a Base calcula o km pela diferença para o abastecimento anterior da mesma placa e combustível);
//  - placa nova: o abastecimento passa para a sequência da placa nova; recalcula km/km por litro dele (pelo anterior da
//    placa nova), do próximo da placa nova e do próximo da placa antiga (que agora conta do anterior dele);
//  - excluir: sai da sequência (o próximo passa a contar do anterior) e o vigia apaga a linha da Base_copia (as de
//    baixo sobem);
//  - vl/litro ou litros digitados: o valor total (litros × vl/litro) é recalculado (mesmo voltando ao número da planilha);
//  - valor total digitado (o do cartão): o vl/litro vira valor ÷ litros (até 4 casas);
//  - "Salvar alterações" grava no banco e o computador da sincronização escreve na Base_copia (cópia de segurança antes).
//    Até a lista ser publicada de novo, a página mostra as correções por cima dos valores da planilha.
import { fmt, esc, fmtDia, carregarDesabilitadas, placaDesabilitada } from '../lib/dados.js';
import { criarFiltros } from '../lib/filtros.js';
import { seloCartao as selo, nomeCartao } from '../lib/cartoes.js';
import { normFuel, normKey, chaveCadeia } from '../lib/consolidador.js';
import { carregarExcelJS, linhaPlanilha, montarPlanilha, confere } from '../lib/exportar-base.js';
import { salvar } from '../lib/baixar.js';
import { confirmar } from '../lib/confirmar.js';

const POR_PAGINA = 60;   // linhas desenhadas por vez; a tabela tem rolagem própria e carrega o próximo lote ao chegar no fim
const CAMPO = { E: 'serial', F: 'placa', L: 'mot', O: 'litros', P: 'vl', Q: 'hodo', R: 'km', S: 'kml', T: 'valor', AB: 'inf1', AD: 'inf3' };
const ROTULO = { E: 'Data e hora', F: 'Placa', L: 'Motorista', O: 'Litros', P: 'V/litro', Q: 'Hodômetro', R: 'KM rodados', S: 'KM/litro', T: 'Valor total', AB: 'Inf. adicional 1', AD: 'Inf. adicional 3' };
const PLACA_OK = /^[A-Z]{3}\d[A-Z0-9]\d{2}$/;   // ABC1234 ou ABC1D23
const limparPlaca = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const NOME_ESTADO = { pendente: 'Aguardando gravação', aguardando: 'Aguardando gravação', aplicada: 'Gravado', erro: 'Não gravado' };
const VAZIO = '(vazio)';
const r6 = (v) => Math.round(v * 1e6) / 1e6;   // como a Base: sem arredondar para 2 casas (só tira o ruído do ponto flutuante)
const fVl = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
// cartão usado (mesma regra do scripts/importar_base.py cartao_usado): FORMA DE PAGAMENTO "Cartao Fisico" é o Ticket;
// vazia antes de 28/06/2025 (só havia Ticket) também; vazia depois disso não dá para saber
const INICIO_OUTROS_CARTOES = Date.UTC(2025, 5, 28) / 864e5;
function cartaoDe(forma, dia) {
  const f = String(forma || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (f === 'CARTAO FISICO') return 'TICKET';
  if (!f) return dia < INICIO_OUTROS_CARTOES ? 'TICKET' : '';
  return f;
}
const seloCartao = (c) => (c ? selo(c, 'ea-cartao')
  : '<span class="sem-dado" title="Forma de pagamento vazia">—</span>');
const hora = (seg) => String(Math.floor(seg / 3600)).padStart(2, '0') + ':' + String(Math.floor(seg / 60) % 60).padStart(2, '0');
// data e hora da Base (número de série do Excel, hora local) <-> "16/11/2026 07:49:38"
const SERIE_MIN = 43831;   // 01/01/2020
function textoDeSerial(serial) {
  const d = new Date(Math.round((serial - 25569) * 86400) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}
// "16/11/2026 07:49", "16/11/26 7:49:38" -> série; inválida, antes de 2020 ou no futuro -> NaN
function serialDeTexto(s) {
  const m = String(s ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return NaN;
  const [d, mes, a0, h, mi, se = '0'] = m.slice(1);
  const a = a0.length === 2 ? 2000 + Number(a0) : Number(a0);
  const t = Date.UTC(a, mes - 1, d, h, mi, se), x = new Date(t);
  if (x.getUTCDate() !== Number(d) || x.getUTCMonth() !== mes - 1 || h > 23 || mi > 59 || se > 59) return NaN;
  const agora = new Date(), agoraLocal = Date.UTC(agora.getFullYear(), agora.getMonth(), agora.getDate(), agora.getHours(), agora.getMinutes()) + 3600e3;
  const serial = t / 864e5 + 25569;
  return serial < SERIE_MIN || t > agoraLocal ? NaN : serial;
}
const quando = (iso) => { const d = new Date(iso); return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
const igual = (a, b) => (a === null || a === undefined || a === '' ? null : a) === (b === null || b === undefined || b === '' ? null : b) ||
  (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);

// "932.706" / "932706" / "6,19" / "R$ 6,19" -> número; '' -> null; inválido -> NaN
function lerNumero(s, inteiro) {
  let t = String(s ?? '').replace(/R\$|\s/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t) && (inteiro || t.split('.').length > 2)) t = t.replace(/\./g, '');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return NaN;
  const n = Number(t);
  return inteiro && !Number.isInteger(n) ? NaN : n;
}

async function buscarLista() {
  const r = await fetch('/gestao/dados/base-copia.json', { credentials: 'same-origin' });
  if (r.status === 401 || r.redirected) { location.href = '/?entrar=1'; throw new Error('sessão'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Não foi possível carregar a lista dos abastecimentos (' + r.status + ').');
  return j;
}
async function buscarAlteracoes() {
  const r = await fetch('/api/base-copia', { credentials: 'same-origin', cache: 'no-store' });
  if (r.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Não foi possível buscar as alterações.');
  return j;
}

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando os abastecimentos…</div>';
  const desabPronto = carregarDesabilitadas();   // placas desabilitadas no cadastro: fora das sugestões de placa
  let lista, info;
  try { [lista, info] = await Promise.all([buscarLista(), buscarAlteracoes()]); } catch (e) {
    if (e.message !== 'sessão') pagina.innerHTML = '<div class="vazio">' + esc(e.message) + ' Recarregue a página para tentar de novo.</div>';
    return {};
  }
  const editar = info.podeEditar;
  let alteracoes = info.alteracoes;          // do banco (pendentes e dos últimos 7 dias)
  const rascunho = new Map();                // linha -> {coluna: valor} ainda não salvo
  const excluir = new Set();                 // linhas marcadas para excluir, ainda não salvas
  let servidor = new Map();                  // linha -> {coluna: valor} já salvo e ainda não na lista
  let servidorExcl = new Set();              // linhas com exclusão salva e ainda na lista
  let linhas = [], porLinha = new Map(), ordemData = [], diaMin = 0, diaMax = 0, opcoesInf = [], opcoesPlaca = [], opcoesMot = [];
  const excluida = (l) => !!l && (excluir.has(l.linha) || servidorExcl.has(l.linha));
  const naoSalvos = () => new Set([...rascunho.keys(), ...excluir]).size;   // abastecimentos mexidos e não salvos
  desabPronto.then(() => { opcoesPlaca = opcoesPlaca.filter((p) => !placaDesabilitada(p)); encherListas(); });
  function encherListas() {   // sugestões dos campos de placa e motorista
    const dl = pagina.querySelector('#ea-placas'), dm = pagina.querySelector('#ea-mots');
    if (dl) dl.innerHTML = opcoesPlaca.map((p) => '<option value="' + esc(p) + '">').join('');
    if (dm) dm.innerHTML = opcoesMot.map((m) => '<option value="' + esc(m) + '">').join('');
  }

  // ---------- lista ----------
  function usarLista(d) {
    lista = d;
    const c = d.col, D = d.dic, txt = (k, i) => (c[k][i] === null ? null : D[k][c[k][i]]);
    linhas = c.linha.map((linha, i) => {
      const serial = c.dt[i];
      const seg = Math.round((serial % 1) * 86400);
      const fuel = txt('fuel', i);
      return {
        i, linha, serial, dia: Math.floor(serial) - 25569 + (seg >= 86400 ? 1 : 0), seg: seg % 86400,
        placa: txt('placa', i) || '', mot: txt('mot', i) || '', fuel: fuel || '', posto: txt('posto', i) || '', forma: txt('forma', i) || '',
        cartao: cartaoDe(txt('forma', i), Math.floor(serial) - 25569),
        inf1: txt('inf1', i), inf3: txt('inf3', i), litros: c.litros[i], vl: c.vl[i], hodo: c.hodo[i], km: c.km[i], kml: c.kml[i], valor: c.valor[i],
        // todo tipo de diesel (S-10, aditivado, comum) fica numa cadeia só de KM
        combKey: chaveCadeia(normFuel(fuel)[0] || ''), cadeia: '', ant: null, prox: null, ant0: null,
      };
    });
    porLinha = new Map(linhas.map((l) => [l.linha, l]));
    // opções das informações adicionais: os nomes já usados em qualquer uma das duas colunas (unidades)
    opcoesInf = [...new Set([...D.inf1, ...D.inf3].map((s) => String(s ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    // sugestões para trocar placa e motorista: as que já aparecem na Base_copia
    opcoesPlaca = [...new Set(D.placa.map((s) => limparPlaca(s)).filter((p) => PLACA_OK.test(p) && !placaDesabilitada(p)))].sort();   // só placas de verdade, sem as desabilitadas
    opcoesMot = [...new Set(D.mot.map((s) => String(s ?? '').trim().toUpperCase()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    ordemData = [...linhas].sort((a, b) => a.serial - b.serial || a.linha - b.linha);
    refazerCadeias(true);
    linhas.forEach((l) => { l.ant0 = l.ant; });   // anterior como está na planilha (para saber se a sequência mudou)
    diaMin = linhas.reduce((m, l) => Math.min(m, l.dia), Infinity);
    diaMax = linhas.reduce((m, l) => Math.max(m, l.dia), -Infinity);
    const g = new Date(d.geradoEm);
    ctx.definirSub(fmt.int(d.linhas) + ' abastecimentos, lista atualizada em ' + g.toLocaleDateString('pt-BR') + ' às ' +
      g.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '. Para levar os dados à Base.xlsx, use Exportar.');
    montarServidor();
    refazerCadeias();
    calcularSuspeitos();
  }

  // sequência placa + combustível em ordem de data: anterior e próximo de cada abastecimento. Usa a placa efetiva
  // (com as trocas salvas e do rascunho) e deixa de fora os excluídos; puro = como está na planilha
  function refazerCadeias(puro) {
    const ultimo = new Map();
    // com data trocada (salva ou no rascunho), a sequência segue a data nova
    const dataMexida = !puro && [...rascunho.values(), ...servidor.values()].some((c) => c.E !== undefined);
    const ordem = dataMexida ? [...ordemData].sort((a, b) => ef(a).serial - ef(b).serial || a.linha - b.linha) : ordemData;
    for (const l of ordem) {
      l.ant = null; l.prox = null;
      l.cadeia = normKey(String((puro ? l.placa : ef(l).placa) || '')) + '§' + l.combKey;
      if (!puro && excluida(l)) continue;
      const a = ultimo.get(l.cadeia);
      if (a) { l.ant = a; a.prox = l; }
      ultimo.set(l.cadeia, l);
    }
  }

  // correções salvas que a lista ainda não traz: pendentes, aguardando e as gravadas depois da última leitura
  function montarServidor() {
    servidor = new Map();
    servidorExcl = new Set();
    [...alteracoes].sort((a, b) => a.id - b.id).forEach((a) => {
      const vale = (a.estado === 'pendente' || a.estado === 'aguardando' || (a.estado === 'aplicada' && a.aplicada_em > lista.geradoEm)) && porLinha.has(a.linha);
      if (!vale) return;
      if (a.acao === 'excluir') servidorExcl.add(a.linha);
      else servidor.set(a.linha, { ...(servidor.get(a.linha) || {}), ...a.celulas });
    });
  }
  const estadoDaLinha = (linha) => {
    const a = alteracoes.filter((x) => x.linha === linha).sort((x, y) => y.id - x.id)[0];
    return a && (servidor.has(linha) || servidorExcl.has(linha)) ? a.estado : null;
  };

  // valores efetivos: planilha + salvo (servidor) + rascunho
  function aplicar(l, cel) {
    const o = { ...l };
    for (const [c, v] of Object.entries(cel)) o[CAMPO[c]] = v;
    if (cel.E !== undefined) {   // data nova: dia e hora mostrados acompanham
      const seg = Math.round((o.serial % 1) * 86400);
      o.dia = Math.floor(o.serial) - 25569 + (seg >= 86400 ? 1 : 0); o.seg = seg % 86400;
    }
    return o;
  }
  function doServidor(l) { const s = servidor.get(l.linha); return s ? aplicar(l, s) : l; }
  function ef(l) {
    const s = servidor.get(l.linha), r = rascunho.get(l.linha);
    if (!s && !r) return l;
    return aplicar(l, { ...(s || {}), ...(r || {}) });
  }

  function definir(l, col, v) {
    const base = doServidor(l)[CAMPO[col]];
    const r = { ...(rascunho.get(l.linha) || {}) };
    if (igual(base, v)) delete r[col]; else r[col] = v;
    if (Object.keys(r).length) rascunho.set(l.linha, r); else rascunho.delete(l.linha);
  }
  function tirar(l, cols) {
    const r = rascunho.get(l.linha);
    if (!r) return;
    cols.forEach((c) => delete r[c]);
    if (!Object.keys(r).length) rascunho.delete(l.linha);
  }
  const mexido = (l, col) => !!l && ((rascunho.get(l.linha) || {})[col] !== undefined || (servidor.get(l.linha) || {})[col] !== undefined);
  // km rodados e km/litro pela diferença para o abastecimento anterior da mesma placa e combustível
  function recalcularKm(l) {
    if (!l || excluida(l)) return;
    const mudouAnt = l.ant !== l.ant0;   // placa trocada ou abastecimento excluído mudou a sequência
    if (!l.ant) {
      // primeiro abastecimento da sequência: sem anterior não há km rodado
      if (mudouAnt) { definir(l, 'R', null); definir(l, 'S', null); } else tirar(l, ['R', 'S']);
      return;
    }
    // nada mudou (edição desfeita): volta ao que está na planilha
    if (!mexido(l, 'Q') && !mexido(l.ant, 'Q') && !mexido(l, 'O') && !mudouAnt) { tirar(l, ['R', 'S']); return; }
    const h = ef(l).hodo, ha = ef(l.ant).hodo, litros = ef(l).litros;
    if (typeof h !== 'number' || typeof ha !== 'number') return;
    const km = h - ha;
    definir(l, 'R', km);
    definir(l, 'S', litros > 0 ? r6(km / litros) : null);
  }
  // valor total = litros × V/litro, sempre que litros ou V/litro são digitados. Antes, digitar de volta o V/litro da planilha
  // era tratado como "desfazer" e o valor total voltava ao da planilha, mesmo quando ele não batia com litros × V/litro
  // (linhas "valor diferente" da revisão de 12/11/2026). definir() já descarta o valor igual ao gravado.
  function recalcularValor(l) {
    const e = ef(l);
    if (typeof e.vl !== 'number' || typeof e.litros !== 'number') return;
    const novo = r6(e.litros * e.vl), gravado = doServidor(l).valor;
    // diferença de arredondamento (menos de 1 centavo) não é correção: fica o valor cobrado
    if (typeof gravado === 'number' && Math.abs(novo - gravado) < 0.01) { tirar(l, ['T']); return; }
    definir(l, 'T', novo);
  }
  // valor total digitado (o cobrado no cartão): o V/litro passa a ser valor ÷ litros (até 4 casas, como a bomba interna)
  function valorDigitado(l) {
    const e = ef(l);
    if (typeof e.valor === 'number' && e.litros > 0) definir(l, 'P', Math.round((e.valor / e.litros) * 10000) / 10000);
  }
  // troca de placa ou exclusão: refaz as sequências e recalcula quem mudou de anterior. Devolve as linhas mexidas.
  function mudarSequencia(l, fazer) {
    const antes = [l.ant, l.prox];
    fazer();
    refazerCadeias();
    const afetadas = [l, l.ant, l.prox, ...antes];
    [l, l.prox, ...antes].forEach(recalcularKm);
    return afetadas;
  }
  function editarCampo(l, col, v) {
    if (col === 'F' || col === 'E') return mudarSequencia(l, () => definir(l, col, v));
    definir(l, col, v);
    if (col === 'Q') { recalcularKm(l); recalcularKm(l.prox); }
    if (col === 'P') recalcularValor(l);
    if (col === 'O') { recalcularValor(l); recalcularKm(l); }   // litros novos: valor total e km/litro desta linha
    if (col === 'T') valorDigitado(l);
    return [l, l.ant, l.prox];
  }
  function alternarExclusao(l) {
    return mudarSequencia(l, () => { if (excluir.has(l.linha)) excluir.delete(l.linha); else excluir.add(l.linha); });
  }

  // ---------- km para conferir ----------
  let suspeitos = new Map();   // linha -> motivo
  function calcularSuspeitos() {
    const porCadeia = new Map();
    for (const l of linhas) {
      if (excluida(l)) continue;
      const e = ef(l);
      if (typeof e.kml === 'number' && e.kml > 0 && e.km > 0) {
        if (!porCadeia.has(l.cadeia)) porCadeia.set(l.cadeia, []);
        porCadeia.get(l.cadeia).push(e.kml);
      }
    }
    const mediana = new Map();
    for (const [k, v] of porCadeia) {
      if (v.length < 5) continue;
      v.sort((a, b) => a - b);
      mediana.set(k, v[Math.floor(v.length / 2)]);
    }
    suspeitos = new Map();
    for (const l of linhas) {
      if (excluida(l)) continue;
      const e = ef(l);
      let m = null;
      if (!(e.hodo > 0)) m = 'sem hodômetro';
      else if (l.ant && typeof e.km === 'number' && e.km < 0) m = 'hodômetro menor que o do abastecimento anterior';
      else if (typeof e.km === 'number' && e.km > 3000) m = 'mais de 3.000 km desde o abastecimento anterior';
      else if (l.ant && e.km === 0 && e.litros > 0) m = 'mesmo hodômetro do abastecimento anterior';
      else if (typeof e.kml === 'number' && e.kml > 0 && mediana.has(l.cadeia)) {
        const md = mediana.get(l.cadeia);
        if (e.kml > md * 2 || e.kml < md / 2) m = 'km/litro muito diferente do normal deste veículo (' + fmt.d2(md) + ')';
      }
      if (m) suspeitos.set(l.linha, m);
    }
  }

  usarLista(lista);

  // ---------- tela ----------
  pagina.innerHTML = `
    <section class="filtros" id="ea-filtros" aria-label="Filtros"></section>
    <div class="chips" id="ea-chips" aria-live="polite"></div>

    <section class="painel painel-tabela">
      <div class="painel-cab"><h2>Abastecimentos</h2><span class="conta" id="ea-conta"></span></div>
      <p class="nota ea-publicacao" id="ea-publicacao" aria-live="polite"></p>

      <div class="tabela-ferramentas">
        <label class="ea-alternar"><input type="checkbox" id="ea-suspeitos"> Só os KM para conferir <span class="ea-qtd" id="ea-qtd-suspeitos"></span></label>
        <label class="ea-alternar"><input type="checkbox" id="ea-alterados"> Só os alterados</label>
        <button type="button" class="btn ea-exportar" id="ea-exportar" title="Planilha no formato da Base.xlsx, só com os abastecimentos dos filtros">
          <svg aria-hidden="true"><use href="#i-baixar"/></svg><span class="txt">Exportar</span></button>
        ${editar ? `<button type="button" class="btn btn-principal ea-publicar" id="ea-publicar" title="Leva para os dashboards os abastecimentos até ontem, já validados">
          <svg aria-hidden="true"><use href="#i-atualizar"/></svg><span class="txt">Publicar nos dashboards</span></button>` : ''}
        ${editar ? `<div class="ea-barra oculto" id="ea-barra" role="region" aria-label="Alterações não salvas">
          <span id="ea-barra-txt"></span>
          <button type="button" class="btn" id="ea-descartar">Descartar</button>
          <button type="button" class="btn btn-principal" id="ea-salvar">Salvar alterações</button>
        </div>` : ''}
      </div>
      <div class="ea-foco oculto" id="ea-foco" role="status"></div>
      <div class="tabela-rolagem ea-rolagem"><table class="dados ea-tabela" id="ea-tabela"></table></div>
      <datalist id="ea-placas"></datalist><datalist id="ea-mots"></datalist>
      <div id="ea-mais"></div>
    </section>
    <section class="painel">
      <div class="painel-cab"><h2>Correções recentes</h2><span class="conta" id="ea-hist-conta"></span></div>
      <div class="tabela-rolagem tabela-historico"><table class="dados" id="ea-hist"></table></div>
    </section>`;
  const el = (id) => pagina.querySelector('#' + id);
  // ---------- Exportar (18/11/2026): planilha igual à Base_copia com os abastecimentos dos filtros (lib/exportar-base.js) ----------
  const LOTE_EXPORTAR = 5000;   // linhas por chamada (/api/abastecimentos/exportar)
  el('ea-exportar').addEventListener('click', async () => {
    const b = el('ea-exportar'), txt = b.querySelector('.txt');
    const nums = visiveis().map((l) => l.linha).sort((a, c) => a - c);
    if (!nums.length) { ctx.aviso('Nenhum abastecimento com esses filtros para exportar.'); return; }
    b.disabled = true;
    try {
      const ExcelJS = await carregarExcelJS();
      const banco = [];
      for (let i = 0; i < nums.length; i += LOTE_EXPORTAR) {
        txt.textContent = 'Exportando… ' + Math.round((i / nums.length) * 100) + '%';
        const r = await fetch('/api/abastecimentos/exportar', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linhas: nums.slice(i, i + LOTE_EXPORTAR) }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.erro || 'Não foi possível exportar (' + r.status + ').');
        banco.push(...j.linhas);
      }
      // cada linha do banco tem de ser o mesmo abastecimento da tela (placa, minuto e litros); senão a cópia do banco e a lista
      // da tela são de versões diferentes da Base_copia e a exportação sairia com linhas trocadas
      const trocadas = banco.filter((r) => !confere(r, porLinha.get(r[41]))).length;
      if (trocadas) throw new Error('A lista da tela e o banco estão em versões diferentes (' + fmt.int(trocadas) +
        ' abastecimento(s) não batem). Nada foi exportado: recarregue a página em alguns minutos e exporte de novo.');
      txt.textContent = 'Montando a planilha…';
      const linhasPl = banco.map(linhaPlanilha);
      const datas = linhasPl.map((l) => l[4]).filter(Boolean).sort((a, c) => a - c);
      const dia = (d) => d.toISOString().slice(0, 10).split('-').reverse().join('-');
      const nome = 'Abastecimentos ' + (datas.length ? dia(datas[0]) + (dia(datas[0]) !== dia(datas[datas.length - 1]) ? ' a ' + dia(datas[datas.length - 1]) : '') : 'exportada') + '.xlsx';
      const buf = await montarPlanilha(ExcelJS, linhasPl).xlsx.writeBuffer();
      salvar(nome, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const faltam = nums.length - banco.length;
      ctx.aviso(fmt.int(banco.length) + ' abastecimento(s) exportado(s) em "' + nome + '".' +
        (faltam > 0 ? ' ' + fmt.int(faltam) + ' não estavam no banco ainda (a lista da tela é mais nova que a cópia do banco); exporte de novo em alguns minutos.' : '') +
        (servidor.size || servidorExcl.size ? ' Correções ainda não gravadas saem como estavam antes.' : ''));
    } catch (e) {
      ctx.aviso(e.message);
    } finally {
      b.disabled = false; txt.textContent = 'Exportar';
    }
  });
  // ---------- Publicar nos dashboards (26/11/2026, decisão do usuário "Só ao publicar") ----------
  // Os dashboards ficam na última publicação; publicar leva tudo até ontem (D-1). O banco gera o arquivo em até ~2 min
  // (/api/abastecimentos/publicar; agendamento gestao_dados_painel_rodar).
  const dataBR = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—');
  const quandoBR = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('pt-BR') + ' às ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
  let tPublicacao = null;
  async function mostrarPublicacao(avisarAoTerminar) {
    clearTimeout(tPublicacao);
    const p = el('ea-publicacao');
    let info;
    try {
      const r = await fetch('/api/abastecimentos/publicar', { credentials: 'same-origin', cache: 'no-store' });
      info = await r.json();
      if (!r.ok) throw new Error(info.erro);
    } catch { p.textContent = ''; return; }
    if (!p.isConnected) return;
    if (info.pendente) {
      p.innerHTML = '<span class="aviso-linha">Publicando nos dashboards os abastecimentos até ' + esc(dataBR(info.ate)) + '… leva até 2 minutos.</span>';
      tPublicacao = setTimeout(() => mostrarPublicacao(true), 15000);
      return;
    }
    p.textContent = info.ate ? 'Dashboards publicados até ' + dataBR(info.ate) + (info.publicadoEm ? ' (' + quandoBR(info.publicadoEm) + (info.publicadoPor ? ', ' + info.publicadoPor : '') + ').' : '.') +
      ' Os abastecimentos depois disso aparecem aqui, mas só entram nos dashboards na próxima publicação.' : '';
    if (avisarAoTerminar) ctx.aviso('Publicado: os dashboards já têm os abastecimentos até ' + dataBR(info.ate) + '. Quem estiver com um painel aberto vê o botão "Atualizar".');
  }
  mostrarPublicacao(false);
  if (editar) {
    el('ea-publicar').addEventListener('click', async () => {
      if (naoSalvos()) { ctx.aviso('Salve (ou descarte) as alterações antes de publicar, para elas entrarem nos dashboards.'); return; }
      const ontem = new Date(Date.now() - 27 * 3600e3).toISOString().slice(0, 10);   // ontem no horário da Bahia (UTC-3)
      if (!(await confirmar('Publicar nos dashboards todos os abastecimentos até ' + dataBR(ontem) + '? Os de hoje ficam para a próxima publicação.',
        { titulo: 'Publicar nos dashboards', ok: 'Publicar' }))) return;
      const b = el('ea-publicar'), txt = b.querySelector('.txt');
      b.disabled = true; txt.textContent = 'Publicando…';
      try {
        const r = await fetch('/api/abastecimentos/publicar', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.erro || 'Não foi possível publicar (' + r.status + ').');
        mostrarPublicacao(false);
      } catch (e) { ctx.aviso(e.message); }
      finally { b.disabled = false; txt.textContent = 'Publicar nos dashboards'; }
    });
  }

  const estado = { limite: POR_PAGINA, suspeitos: false, alterados: false, ordem: { campo: 'data', dir: -1 } };
  // colunas da tabela: [id, título, largura mínima em px, numérica, valor para ordenar]. A tabela estica nas telas largas e
  // rola para o lado nas estreitas, sem cortar o conteúdo (Data e Placa ficam presas à esquerda); o cartão aparece embaixo da placa
  const COLUNAS = [
    ['data', 'Data', editar ? 146 : 74, false, (l) => ef(l).serial],   // editando: campo "dd/mm/aaaa hh:mm:ss"
    ['placa', 'Placa · cartão', 108, false, (l) => ef(l).placa],
    ['mot', 'Motorista', 132, false, (l) => ef(l).mot],
    ['posto', 'Estabeleci­mento', 120, false, (l) => l.posto],   // ­: hífen só se precisar quebrar
    ['fuel', 'Combus­tível', 86, false, (l) => l.fuel],
    ['inf1', 'Inf. adic. 1', 112, false, (l) => ef(l).inf1],
    ['inf3', 'Inf. adic. 3', 112, false, (l) => ef(l).inf3],
    ['hodo', 'Hodômetro', 98, true, (l) => ef(l).hodo],
    ['km', 'KM rod.', 74, true, (l) => ef(l).km],
    ['litros', 'Litros', 72, true, (l) => ef(l).litros],
    ['kml', 'KM/L', 54, true, (l) => ef(l).kml],
    ['vl', 'V/litro', 74, true, (l) => ef(l).vl],
    ['valor', 'Valor total (R$)', 84, true, (l) => ef(l).valor],
    ...(editar ? [['acao', 'Excluir', 42, false, null]] : []),   // lixeira (não ordena)
  ];

  const v = (x) => (x === null || x === undefined || x === '' ? VAZIO : String(x));
  const DIMENSOES = [
    { id: 'periodo', rotulo: 'Período', periodo: true },
    { id: 'placa', rotulo: 'Placa', valor: (l) => v(l.placa) },
    { id: 'motorista', rotulo: 'Motorista', valor: (l) => v(l.mot) },
    { id: 'combustivel', rotulo: 'Combustível', valor: (l) => v(l.fuel) },
    { id: 'posto', rotulo: 'Estabelecimento', valor: (l) => v(l.posto) },
    { id: 'cartao', rotulo: 'Cartão', valor: (l) => (l.cartao ? nomeCartao(l.cartao) : VAZIO) },
    { id: 'inf1', rotulo: 'Inf. adicional 1', valor: (l) => v(ef(l).inf1) },
    { id: 'inf3', rotulo: 'Inf. adicional 3', valor: (l) => v(ef(l).inf3) },
  ];
  const filtros = criarFiltros({
    dimensoes: DIMENSOES, filtrosEl: el('ea-filtros'), chipsEl: el('ea-chips'), rota: '#/abastecimentos',
    obterBase: () => linhas, obterLimites: () => [diaMin, diaMax], aoMudar: () => { estado.limite = POR_PAGINA; desenhar(); }, prefixo: 'ea', recolher: true,
  });
  // vindo da Conferência com os cartões: #/abastecimentos?aplicar=<linha>&ch=<placa|minuto>&vQ=...&vO=...
  const daConferencia = new URLSearchParams(location.hash.split('?')[1] || '');
  let msgConferencia = '';
  // primeira vez na tela: começa no mês atual (60 mil linhas de uma vez não ajudam a conferir)
  if (!location.hash.includes('?') || daConferencia.has('aplicar')) {
    const desde = diaMax - 30;
    filtros.periodo.de = desde; filtros.periodo.ate = null; filtros.periodo.preset = 'personalizado';
  }

  function visiveis() {
    let ls = linhas.filter((l) => filtros.passa(l));
    if (estado.suspeitos) ls = ls.filter((l) => suspeitos.has(l.linha));
    if (estado.alterados) ls = ls.filter((l) => rascunho.has(l.linha) || servidor.has(l.linha) || excluida(l));
    // ordem da coluna escolhida; empate: mais recente primeiro (na placa: em ordem de data, para ver a sequência)
    const { campo: id, dir } = estado.ordem;
    const val = COLUNAS.find((c) => c[0] === id)[4];
    const desempate = id === 'placa' ? (a, b) => a.serial - b.serial : (a, b) => b.serial - a.serial;
    return ls.sort((a, b) => {
      const va = val(a), vb = val(b);
      const na = va === null || va === undefined || va === '', nb = vb === null || vb === undefined || vb === '';
      if (na || nb) return na === nb ? desempate(a, b) : na ? 1 : -1;   // vazios sempre no fim
      const c = typeof va === 'string' ? va.localeCompare(vb, 'pt-BR', { numeric: true }) : va - vb;
      return c ? dir * c : desempate(a, b);
    });
  }

  function campo(l, col, valor, tipo) {
    const alterado = rascunho.has(l.linha) && col in rascunho.get(l.linha);
    const salvo = !alterado && servidor.has(l.linha) && col in servidor.get(l.linha);
    const cls = 'campo-tabela ea-campo' + (tipo === 't' ? ' ea-texto' : '') + (alterado ? ' ea-alterado' : salvo ? ' ea-salvo' : '');
    const rotulo = esc(ROTULO[col] + ' de ' + l.placa + ' em ' + fmtDia(l.dia));
    if (tipo === 't') {   // informação adicional: escolher numa lista (sem digitar)
      const atual = String(valor ?? '').trim();
      const opcoes = atual && !opcoesInf.includes(atual) ? [atual, ...opcoesInf] : opcoesInf;
      return '<select class="' + cls + '" data-linha="' + l.linha + '" data-col="' + col + '" aria-label="' + rotulo + '" title="' + esc(atual) + '">' +
        '<option value=""' + (atual ? '' : ' selected') + '>—</option>' +
        opcoes.map((o) => '<option' + (o === atual ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
    }
    if (tipo === 'd') {   // data e hora: "16/11/2026 07:49:38"
      const txt = textoDeSerial(valor);
      return '<input class="' + cls + ' ea-texto ea-dataHora" autocomplete="off" spellcheck="false" maxlength="19" inputmode="numeric" data-linha="' + l.linha +
        '" data-col="E" value="' + esc(txt) + '" title="Data e hora (dd/mm/aaaa hh:mm:ss)" aria-label="' + rotulo + '">';
    }
    if (tipo === 'p' || tipo === 'm') {   // placa / motorista: texto com sugestões dos que já existem na Base_copia
      return '<input class="' + cls + ' ea-texto ea-' + (tipo === 'p' ? 'placa' : 'mot') + '" list="ea-' + (tipo === 'p' ? 'placas' : 'mots') + '"' +
        ' autocomplete="off" spellcheck="false" maxlength="' + (tipo === 'p' ? 8 : 80) + '" data-linha="' + l.linha + '" data-col="' + col +
        '" value="' + esc(valor ?? '') + '" title="' + esc(valor ?? '') + '" aria-label="' + rotulo + '">';
    }
    // valor total aparece com 2 casas (a Base guarda sem arredondar, como litros × V/litro)
    const mostrado = valor === null || valor === undefined ? '' : tipo === 'h' ? String(valor) : col === 'T' ? fmt.d2(valor) : tipo === 'v' ? fVl.format(valor) : String(valor);
    // V/litro com máscara de valor (bomba interna tem preço com 4 casas)
    const moeda = col === 'P' ? ' data-moeda="' + (l.cartao === 'BOMBA INTERNA' ? 4 : 2) + '"' : col === 'T' ? ' data-moeda="2"' : '';
    return '<input class="' + cls + '" ' + (tipo === 't' ? 'maxlength="200"' : 'inputmode="decimal"') + moeda + ' autocomplete="off" data-linha="' + l.linha +
      '" data-col="' + col + '" value="' + esc(mostrado) + '" aria-label="' + esc(ROTULO[col] + ' de ' + l.placa + ' em ' + fmtDia(l.dia)) + '">';
  }
  function marcaCalc(l, col) {
    const r = rascunho.get(l.linha), s = servidor.get(l.linha);
    if (r && col in r) return ' ea-calc-alterado';
    if (s && col in s) return ' ea-calc-salvo';
    return '';
  }

  function linhaHtml(l) {
    const e = ef(l), sus = suspeitos.get(l.linha), st = estadoDaLinha(l.linha);
    const antH = l.ant ? ef(l.ant).hodo : null;
    const txt = (val) => (val === null || val === undefined || val === '' ? '<span class="sem-dado">—</span>' : esc(val));
    const curto = (s) => '<td title="' + esc(s) + '"><span class="ea-trunc">' + txt(s) + '</span></td>';
    const exc = excluida(l), rasc = excluir.has(l.linha);
    const edita = editar && !exc;   // excluído: só mostra (com "Desfazer" enquanto não salvo)
    const estadoTxt = st ? '<small class="cidade-linha ea-st-' + st + '">' + esc(servidorExcl.has(l.linha) ? (st === 'aplicada' ? 'Excluído' : 'Exclusão: ' + NOME_ESTADO[st].toLowerCase()) : NOME_ESTADO[st]) + '</small>'
      : rasc ? '<small class="cidade-linha ea-st-excluir">Será excluído ao salvar</small>' : '';
    const acao = !editar ? '' : '<td class="ea-acao">' + (servidorExcl.has(l.linha) ? ''
      : '<button type="button" class="ea-excluir' + (rasc ? ' ea-desfazer' : '') + '" data-excluir="' + l.linha + '" title="' + (rasc ? 'Desfazer a exclusão' : 'Excluir este abastecimento') +
        '" aria-label="' + esc((rasc ? 'Desfazer a exclusão do abastecimento de ' : 'Excluir o abastecimento de ') + e.placa + ' em ' + fmtDia(l.dia)) + '">' +
        (rasc ? '↶' : '<svg aria-hidden="true"><use href="#i-lixeira"/></svg>') + '</button>') + '</td>';
    return '<tr data-linha="' + l.linha + '" class="' + (rascunho.has(l.linha) ? 'ea-tr-alterada' : '') + (exc ? ' ea-tr-excluida' : '') + (estado.destaque === l.linha ? ' selecionado' : '') + '">' +
      (edita ? '<td class="ea-data" title="Linha ' + l.linha + '">' + campo(l, 'E', e.serial, 'd') + '</td>'
        : '<td class="ea-data" title="Linha ' + l.linha + '">' + esc(fmtDia(e.dia).replace(/\/(\d{2})(\d{2})$/, '/$2')) +
        '<small class="cidade-linha">' + esc(hora(e.seg)) + '</small></td>') +
      '<td>' + (edita ? campo(l, 'F', e.placa, 'p') : '<strong>' + esc(e.placa) + '</strong>') + '<div class="ea-placa-cartao">' + seloCartao(l.cartao) + '</div>' + estadoTxt + '</td>' +
      (edita ? '<td>' + campo(l, 'L', e.mot, 'm') + '</td>' : curto(e.mot)) + curto(l.posto) + curto(l.fuel) +
      (edita ? '<td>' + campo(l, 'AB', e.inf1, 't') + '</td><td>' + campo(l, 'AD', e.inf3, 't') + '</td>' : curto(e.inf1) + curto(e.inf3)) +
      '<td class="n">' + (edita ? campo(l, 'Q', e.hodo, 'h') : fmt.int(e.hodo)) +
        (sus ? '<small class="cidade-linha aviso-linha ea-conferir" title="Conferir: ' + esc(sus) + '">⚠ conferir</small>' : '') + '</td>' +
      '<td class="n' + marcaCalc(l, 'R') + '">' + (typeof e.km === 'number' ? fmt.int(e.km) : '<span class="sem-dado">—</span>') +
        (antH !== null && antH !== undefined ? '<small class="cidade-linha" title="Hodômetro do abastecimento anterior desta placa e combustível">ant. ' + fmt.int(antH) + '</small>' : '') + '</td>' +
      '<td class="n">' + (edita ? campo(l, 'O', e.litros, 'v') : fmt.d2(e.litros)) + '</td>' +
      '<td class="n' + marcaCalc(l, 'S') + '">' + fmt.d2(e.kml) + '</td>' +
      '<td class="n">' + (edita ? campo(l, 'P', e.vl, 'v') : (typeof e.vl === 'number' ? fVl.format(e.vl) : '—')) + '</td>' +
      '<td class="n' + marcaCalc(l, 'T') + '">' + (edita ? campo(l, 'T', e.valor, 'v') : fmt.d2(e.valor)) + '</td>' + acao + '</tr>';
  }

  function desenhar() {
    filtros.atualizarUI();
    const ls = visiveis();
    const noFiltro = linhas.filter((l) => filtros.passa(l));

    el('ea-qtd-suspeitos').textContent = '(' + fmt.int(noFiltro.filter((l) => suspeitos.has(l.linha)).length) + ')';
    el('ea-conta').textContent = fmt.int(ls.length) + (ls.length === 1 ? ' abastecimento' : ' abastecimentos');
    const { campo: ordId, dir } = estado.ordem;
    el('ea-tabela').innerHTML =
      '<colgroup>' + COLUNAS.map((c) => '<col style="width:' + c[2] + 'px">').join('') + '</colgroup>' +
      '<thead><tr>' + COLUNAS.map(([id, rot, , num]) => {
        if (id === 'acao') return '<th class="ea-acao"><span class="om-sr">' + esc(rot) + '</span></th>';
        const ativa = ordId === id;
        return '<th class="' + (num ? 'n' : '') + '" aria-sort="' + (ativa ? (dir < 0 ? 'descending' : 'ascending') : 'none') + '">' +
          '<button type="button" data-ordem="' + id + '">' + esc(rot) + (ativa ? '<span class="seta">' + (dir < 0 ? '▼' : '▲') + '</span>' : '') + '</button></th>';
      }).join('') + '</tr></thead><tbody>' +
      (ls.length ? ls.slice(0, estado.limite).map(linhaHtml).join('')
        : '<tr><td colspan="' + COLUNAS.length + '"><div class="vazio">Nenhum abastecimento com esse filtro.</div></td></tr>') + '</tbody>';
    listaAtual = ls;
    rodapeLista();
    desenharFoco();
    desenharBarra();
    desenharHistorico();
  }

  function desenharBarra() {
    if (!editar) return;
    const n = naoSalvos();
    el('ea-barra').classList.toggle('oculto', !n);
    el('ea-barra-txt').classList.remove('aviso-linha');
    el('ea-barra-txt').textContent = (n === 1 ? '1 abastecimento alterado, ainda não salvo' : fmt.int(n) + ' abastecimentos alterados, ainda não salvos') +
      (excluir.size ? ' (' + (excluir.size === 1 ? '1 exclusão' : fmt.int(excluir.size) + ' exclusões') + ')' : '') + '.';
  }

  function desenharHistorico() {
    const ls = [...alteracoes].sort((a, b) => b.id - a.id);
    el('ea-hist-conta').textContent = ls.length ? fmt.int(ls.length) + (ls.length === 1 ? ' correção' : ' correções') : '';
    const valor = (c, x) => (x === null || x === undefined || x === '' ? '(vazio)' : c === 'E' ? textoDeSerial(x) : c === 'Q' || c === 'R' ? fmt.int(x) : c === 'P' ? fVl.format(x)
      : c === 'T' ? fmt.moeda(x) : c === 'S' ? fmt.d2(x) : String(x));
    el('ea-hist').innerHTML = ls.length
      ? '<thead><tr><th><span>Quando</span></th><th><span>Quem</span></th><th><span>Abastecimento</span></th><th><span>O que mudou</span></th><th><span>Situação</span></th></tr></thead><tbody>' +
        ls.map((a) => {
          const dia = Math.floor(a.data) - 25569;
          const an = a.antes || {};
          const mud = a.acao === 'excluir'
            ? '<strong>Abastecimento excluído</strong><small class="cidade-linha">' + esc([an.L, an.Q !== undefined && an.Q !== null ? 'hodômetro ' + fmt.int(an.Q) : '', an.O ? fmt.d2(an.O) + ' L' : ''].filter(Boolean).join(' · ')) + '</small>'
            : Object.entries(a.celulas).map(([c, x]) => esc(ROTULO[c] || c) + ': ' + esc(valor(c, an[c])) + ' → <strong>' + esc(valor(c, x)) + '</strong>').join('<br>');
          return '<tr><td>' + esc(quando(a.criado_em)) + '</td><td>' + esc(a.usuario_nome) + '</td>' +
            '<td>' + esc(a.placa) + ' · ' + esc(fmtDia(dia)) + '<small class="cidade-linha">linha ' + a.linha + '</small></td><td class="ea-mud">' + mud + '</td>' +
            '<td><span class="ea-st ea-st-' + a.estado + '">' + esc(NOME_ESTADO[a.estado] || a.estado) + '</span>' +
            (a.mensagem ? '<small class="cidade-linha">' + esc(a.mensagem) + '</small>' : '') + '</td></tr>';
        }).join('') + '</tbody>'
      : '<tbody><tr><td><div class="vazio">Nenhuma correção nos últimos 7 dias.</div></td></tr></tbody>';
  }

  // ---------- edição ----------
  // redesenha só as linhas mexidas (a tabela não pula e o foco continua no lugar)
  function redesenharLinhas(ls) {
    for (const l of ls) {
      if (!l) continue;
      const tr = el('ea-tabela').querySelector('tr[data-linha="' + l.linha + '"]');
      if (!tr) continue;
      const tmp = document.createElement('tbody');
      tmp.innerHTML = linhaHtml(l);
      tr.replaceWith(tmp.firstChild);
    }
  }
  el('ea-tabela').addEventListener('change', (e) => {
    const inp = e.target.closest('tbody [data-col]');
    if (!inp) return;
    const l = porLinha.get(Number(inp.dataset.linha)), col = inp.dataset.col;
    if (!l) return;
    let val;
    if (col === 'AB' || col === 'AD') val = inp.value || null;   // lista de opções
    else if (col === 'E') {
      val = serialDeTexto(inp.value);
      if (Number.isNaN(val)) {
        inp.classList.add('invalido');
        inp.title = 'Data e hora: dd/mm/aaaa hh:mm (os segundos são opcionais), de 2020 até agora (ex.: 15/11/2026 14:30).';
        return;
      }
    } else if (col === 'F') {
      val = limparPlaca(inp.value);
      if (!PLACA_OK.test(val)) {
        inp.classList.add('invalido');
        inp.title = 'Placa: 3 letras e 4 caracteres (ex.: TLB2I85 ou ABC1234).';
        return;
      }
    } else if (col === 'L') {
      val = String(inp.value || '').replace(/\s+/g, ' ').trim().toUpperCase();
      if (val.length < 3) {
        inp.classList.add('invalido');
        inp.title = 'Motorista: escreva o nome (escolha um da lista se já existir).';
        return;
      }
    } else {
      val = lerNumero(inp.value, col === 'Q');
      if (Number.isNaN(val) || (val !== null && val < 0) || (col === 'O' && !(val > 0))) {
        inp.classList.add('invalido');
        inp.title = col === 'Q' ? 'Hodômetro: só números inteiros (ex.: 932706).' : col === 'O' ? 'Litros: número maior que zero, com vírgula (ex.: 152,30).'
          : col === 'T' ? 'Valor total: o valor cobrado no cartão, com vírgula (ex.: 709,00).' : 'V/litro: número com vírgula (ex.: 6,19).';
        return;
      }
    }
    inp.classList.remove('invalido');
    const proximo = (() => { const ins = [...el('ea-tabela').querySelectorAll('tbody [data-col]')]; const i = ins.indexOf(inp); return ins[i + 1] ? [ins[i + 1].dataset.linha, ins[i + 1].dataset.col] : null; })();
    const afetadas = editarCampo(l, col, val);
    calcularSuspeitos();
    const foco = document.activeElement && document.activeElement.dataset ? [document.activeElement.dataset.linha, document.activeElement.dataset.col] : null;
    redesenharLinhas([...new Set(afetadas)]);
    const alvo = foco && foco[0] ? foco : proximo;
    if (alvo && document.activeElement === document.body) {
      const f = el('ea-tabela').querySelector('[data-linha="' + alvo[0] + '"][data-col="' + alvo[1] + '"]');
      if (f) f.focus();
    }
    desenharBarra();
  });
  // lixeira: marca/desmarca o abastecimento para excluir (só vale ao salvar)
  el('ea-tabela').addEventListener('click', (e) => {
    const b = e.target.closest('[data-excluir]');
    if (!b) return;
    const l = porLinha.get(Number(b.dataset.excluir));
    if (!l) return;
    const afetadas = alternarExclusao(l);
    calcularSuspeitos();
    redesenharLinhas([...new Set(afetadas)]);
    const nb = el('ea-tabela').querySelector('[data-excluir="' + l.linha + '"]');
    if (nb) nb.focus();
    desenharBarra();
  });
  // Enter vai para o mesmo campo da linha de baixo (como no Excel)
  el('ea-tabela').addEventListener('keydown', (e) => {
    const inp = e.target.closest('input[data-col]');
    if (!inp || e.key !== 'Enter') return;
    e.preventDefault();
    const ins = [...el('ea-tabela').querySelectorAll('input[data-col="' + inp.dataset.col + '"]')];
    const prox = ins[ins.indexOf(inp) + (e.shiftKey ? -1 : 1)];
    inp.blur();
    if (prox) { const f = el('ea-tabela').querySelector('input[data-linha="' + prox.dataset.linha + '"][data-col="' + prox.dataset.col + '"]'); if (f) { f.focus(); f.select(); } }
  });
  // rolagem própria da tabela: perto do fim, acrescenta o próximo lote de linhas (sem redesenhar as que já estão na tela)
  var listaAtual;   // var sem valor: desenhar() pode rodar antes desta linha e já ter preenchido a lista
  function rodapeLista() {
    const n = (listaAtual || []).length, vis = Math.min(n, estado.limite);
    el('ea-mais').innerHTML = n > vis ? '<p class="nota ea-rodape">' + fmt.int(vis) + ' de ' + fmt.int(n) + ' · role a tabela para ver mais</p>' : '';
  }
  function maisLinhas() {
    if (!listaAtual || estado.limite >= listaAtual.length) return;
    const tb = el('ea-tabela').tBodies[0];
    if (!tb) return;
    tb.insertAdjacentHTML('beforeend', listaAtual.slice(estado.limite, estado.limite + POR_PAGINA).map(linhaHtml).join(''));
    estado.limite += POR_PAGINA;
    rodapeLista();
  }
  const rolagem = pagina.querySelector('.ea-rolagem');
  rolagem.addEventListener('scroll', () => {
    if (rolagem.scrollTop + rolagem.clientHeight > rolagem.scrollHeight - 300) maisLinhas();
  }, { passive: true });

  el('ea-suspeitos').addEventListener('change', (e) => { estado.suspeitos = e.target.checked; estado.limite = POR_PAGINA; desenhar(); });
  el('ea-alterados').addEventListener('change', (e) => { estado.alterados = e.target.checked; estado.limite = POR_PAGINA; desenhar(); });
  // ---------- clique numa linha: todos os abastecimentos da placa com o mesmo combustível ----------
  // O filtro de antes fica guardado (um só: cliques seguidos em outras linhas não o trocam) para o botão Voltar.
  let antes = null, foco = null;
  const copiarFiltro = () => ({
    sel: Object.fromEntries(Object.entries(filtros.sel).map(([k, s]) => [k, new Set(s)])), periodo: { ...filtros.periodo },
    suspeitos: estado.suspeitos, alterados: estado.alterados, ordem: { ...estado.ordem }, limite: estado.limite,
  });
  function aplicarFiltro(f) {
    for (const [k, s] of Object.entries(filtros.sel)) { s.clear(); (f.sel[k] || []).forEach((x) => s.add(x)); }
    Object.assign(filtros.periodo, f.periodo);
    estado.suspeitos = f.suspeitos; estado.alterados = f.alterados; estado.ordem = { ...f.ordem }; estado.limite = f.limite;
    el('ea-suspeitos').checked = f.suspeitos; el('ea-alterados').checked = f.alterados;
  }
  function focarCadeia(l) {
    if (!antes) antes = copiarFiltro();
    // mesma cadeia do recálculo do KM (placa + combustível normalizado: "DIESEL" e "DIESEL S-10 COMUM" juntos)
    const mesma = linhas.filter((x) => x.cadeia === l.cadeia);
    aplicarFiltro({
      sel: { placa: new Set(mesma.map((x) => v(x.placa))), combustivel: new Set(mesma.map((x) => v(x.fuel))) },
      periodo: { de: null, ate: null, preset: 'tudo' }, suspeitos: false, alterados: false, ordem: { campo: 'data', dir: -1 }, limite: POR_PAGINA,
    });
    foco = { placa: l.placa, fuel: l.fuel, total: mesma.length };
    estado.destaque = l.linha;
    const i = visiveis().indexOf(l);   // abre a tabela até a página onde está a linha clicada
    estado.limite = Math.max(POR_PAGINA, Math.ceil((i + 1) / POR_PAGINA) * POR_PAGINA);
    desenhar();
    const tr = el('ea-tabela').querySelector('tr[data-linha="' + l.linha + '"]');
    if (tr) tr.scrollIntoView({ block: 'nearest' });
  }
  function voltarFiltro() {
    if (!antes) return;
    aplicarFiltro(antes);
    antes = null; foco = null; msgConferencia = '';
    desenhar();
    const tr = estado.destaque && el('ea-tabela').querySelector('tr[data-linha="' + estado.destaque + '"]');
    if (tr) tr.scrollIntoView({ block: 'nearest' }); else el('ea-foco').closest('.painel').scrollIntoView({ block: 'nearest' });
  }
  function desenharFoco() {
    const caixa = el('ea-foco');
    caixa.classList.toggle('oculto', !antes);
    if (!antes) { caixa.innerHTML = ''; return; }
    caixa.innerHTML = (msgConferencia ? '<span class="ea-conferencia">' + msgConferencia + '</span>' : '') + '<span>Mostrando todos os abastecimentos de <strong>' + esc(foco.placa) + '</strong> com <strong>' + esc(foco.fuel || 'combustível vazio') +
      '</strong> (' + fmt.int(foco.total) + ', todo o período), para conferir a sequência do hodômetro.</span>' +
      '<button type="button" class="btn btn-principal" data-voltar>Voltar ao filtro anterior</button>';
  }
  el('ea-foco').addEventListener('click', (e) => { if (e.target.closest('[data-voltar]')) voltarFiltro(); });
  el('ea-tabela').addEventListener('click', (e) => {
    if (e.target.closest('input, select, button, a, label, [data-ordem]')) return;
    const tr = e.target.closest('tbody tr[data-linha]');
    const l = tr && porLinha.get(Number(tr.dataset.linha));
    if (l) focarCadeia(l);
  });

  // ordenar pelo título da coluna (de novo na mesma coluna inverte); números e data começam do maior
  el('ea-tabela').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ordem]');
    if (!b) return;
    const id = b.dataset.ordem, col = COLUNAS.find((c) => c[0] === id);
    estado.ordem = estado.ordem.campo === id ? { campo: id, dir: -estado.ordem.dir } : { campo: id, dir: col[3] || id === 'data' ? -1 : 1 };
    estado.limite = POR_PAGINA;
    desenhar();
    const n = el('ea-tabela').querySelector('[data-ordem="' + id + '"]');
    if (n) n.focus();
  });

  function avisar(texto, erro) {
    const t = el('ea-barra-txt');
    if (t) { t.textContent = texto; t.classList.toggle('aviso-linha', !!erro); }
  }
  if (editar) {
    el('ea-descartar').addEventListener('click', async () => {
      if (!await confirmar('Descartar as alterações que ainda não foram salvas?')) return;
      rascunho.clear(); excluir.clear(); refazerCadeias(); calcularSuspeitos(); desenhar();
    });
    el('ea-salvar').addEventListener('click', async () => {
      // abastecimento marcado para excluir: vai só a exclusão (as outras mudanças dele não importam)
      // data: a que a planilha terá quando o vigia gravar (com a troca de data salva antes, se houver); o vigia acha a linha por ela
      const itens = [...rascunho.entries()].filter(([linha]) => !excluir.has(linha)).map(([linha, celulas]) => {
        const l = porLinha.get(linha), base = doServidor(l);
        return { linha, placa: l.placa, data: base.serial, acao: 'editar', celulas, antes: Object.fromEntries(Object.keys(celulas).map((c) => [c, base[CAMPO[c]] ?? null])) };
      });
      for (const linha of excluir) {
        const l = porLinha.get(linha), e = doServidor(l);
        itens.push({ linha, placa: l.placa, data: e.serial, acao: 'excluir', celulas: {}, antes: { F: e.placa, L: e.mot, Q: e.hodo ?? null, O: l.litros ?? null } });
      }
      if (!itens.length) return;
      if (excluir.size && !await confirmar((excluir.size === 1 ? 'Excluir 1 abastecimento' : 'Excluir ' + excluir.size + ' abastecimentos') +
        '? Eles saem dos abastecimentos do portal.')) return;
      const b = el('ea-salvar');
      b.disabled = true; b.textContent = 'Salvando…';
      try {
        const r = await fetch('/api/base-copia', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itens }) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 401) { location.href = '/?entrar=1'; return; }
        if (!r.ok) throw new Error(j.erro || 'Não foi possível salvar (' + r.status + ').');
        alteracoes = [...j.alteracoes, ...alteracoes];
        rascunho.clear(); excluir.clear();
        montarServidor(); refazerCadeias(); calcularSuspeitos(); desenhar();
        vigiar();
      } catch (e) {
        avisar(e.message, true);
      } finally {
        b.disabled = false; b.textContent = 'Salvar alterações';
      }
    });
  }

  // ---------- acompanhamento: gravação na planilha e lista nova ----------
  let timer = null, parado = false;
  async function conferir() {
    timer = null;
    if (parado) return;
    try {
      const j = await buscarAlteracoes();
      alteracoes = j.alteracoes;
      const pend = new Set([...servidor.keys(), ...servidorExcl]);
      montarServidor();
      refazerCadeias();
      // gravadas e a lista ainda é a de antes: busca a lista de novo (o navegador só baixa se a versão mudou)
      if (alteracoes.some((a) => a.estado === 'aplicada' && a.aplicada_em > lista.geradoEm)) {
        const nova = await buscarLista();
        if (nova.versao !== lista.versao) { usarLista(nova); encherListas(); }
      }
      const agora = new Set([...servidor.keys(), ...servidorExcl]);
      const mudou = pend.size !== agora.size || [...pend].some((k) => !agora.has(k));
      if (mudou || alteracoes.some((a) => pend.has(a.linha))) { calcularSuspeitos(); if (!pagina.contains(document.activeElement) || !document.activeElement.matches('tbody [data-col]')) desenhar(); else desenharHistorico(); }
    } catch (e) { /* sem conexão: tenta na próxima */ }
    vigiar();
  }
  function vigiar() {
    if (parado || timer) return;
    if (servidor.size || servidorExcl.size) timer = setTimeout(conferir, 10 * 1000);
  }

  encherListas();
  desenhar();
  vigiar();
  if (daConferencia.has('aplicar')) {
    // a linha pode ter mudado de número (exclusões): confere pela placa + minuto e, se não bater, procura por eles
    const [pl, mi] = String(daConferencia.get('ch') || '').split('|');
    const bate = (x) => !!x && limparPlaca(x.placa) === pl && Math.round(x.serial * 1440) === Number(mi);
    let l = porLinha.get(Number(daConferencia.get('aplicar')));
    if (!bate(l)) l = linhas.find(bate) || null;
    history.replaceState(null, '', '#/abastecimentos');   // recarregar a página não aplica de novo
    if (!l) ctx.aviso('O abastecimento da conferência não foi encontrado (pode já ter sido excluído).');
    else {
      const valores = [...daConferencia.entries()].filter(([k]) => /^v(F|Q|O|T)$/.test(k)).map(([k, x]) => [k.slice(1), k === 'vF' ? x : x === '' ? null : Number(x)]);
      const ordem = ['F', 'Q', 'O', 'T'];   // o valor do cartão por último (litros novos recalculam o valor)
      valores.sort((a, b) => ordem.indexOf(a[0]) - ordem.indexOf(b[0]));
      if (editar && valores.length) {
        valores.forEach(([col, x]) => editarCampo(l, col, x));
        refazerCadeias(); calcularSuspeitos();
        msgConferencia = 'Valores do cartão colocados (' + valores.map(([c]) => esc(ROTULO[c])).join(', ') + '). Confira e clique em <strong>Salvar alterações</strong>.';
      } else if (!valores.length) msgConferencia = 'Este abastecimento não aparece mais na API do cartão. Confira e, se for o caso, exclua.';
      focarCadeia(l);
    }
  }
  const antesDeSair = (e) => { if (naoSalvos()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', antesDeSair);
  return {
    desmontar() {
      parado = true; clearTimeout(timer);
      window.removeEventListener('beforeunload', antesDeSair);
      filtros.destruir();
    },
  };
}
