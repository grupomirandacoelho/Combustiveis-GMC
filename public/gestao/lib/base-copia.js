// Correção de um abastecimento da Base (dados.linhas) na CONTROLES\Base_copia.xlsx, pela mesma fila do Editar abastecimentos
// (/api/base-copia; o vigia grava na planilha). Usado pelo Programa PRIME (trocar motorista, coluna L) e pelo Mapa de calor
// (trocar a unidade / centro de custo, coluna AD = INFORMAÇÃO ADICIONAL 3). O resto do portal muda quando a Base for
// atualizada a partir da Base_copia; até lá as telas mostram a troca por cima (trocasPorMinuto).
const limparPlaca = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
let lista = null;   // promessa da lista da Base_copia (só baixa quando alguém vai corrigir)

function carregarLista() {
  if (!lista) {
    lista = fetch('/gestao/dados/base-copia.json', { credentials: 'same-origin' }).then(async (r) => {
      if (r.status === 401 || r.redirected) { location.href = '/?entrar=1'; throw new Error('sessão'); }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.erro || 'Não foi possível carregar a lista dos abastecimentos (' + r.status + ').');
      return j;
    }).catch((e) => { lista = null; throw e; });
  }
  return lista;
}

// chave placa + minuto do abastecimento (a mesma da Conferência com os cartões)
export const minutoDe = (l) => limparPlaca(l.placa) + '|' + Math.round((l.dia + 25569) * 1440 + (l.seg || 0) / 60);
const minutoSerial = (placa, serial) => limparPlaca(placa) + '|' + Math.round(serial * 1440);

// tipo do combustível para casar a linha (Arla e diesel do mesmo abastecimento têm o mesmo hodômetro e quase o mesmo minuto)
const tipoComb = (s) => { const t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  return t.includes('ARLA') ? 'ARLA' : t.includes('DIESEL') ? 'DIESEL' : t.includes('GASOLINA') ? 'GASOLINA' : t.includes('ETANOL') ? 'ETANOL' : t.split(/\s+/)[0]; };
// linha da Base_copia do abastecimento: mesma placa, dia e tipo de combustível; desempata pelo minuto, depois pelo hodômetro.
// Sem certeza (mais de uma candidata empatada), não escolhe: melhor recusar do que corrigir a linha errada.
function acharLinha(d, l) {
  const c = d.col, D = d.dic, txt = (k, i) => (c[k][i] === null ? null : D[k][c[k][i]]);
  const pl = limparPlaca(l.placa), tipo = tipoComb(l.combustivel), cands = [];
  for (let i = 0; i < c.linha.length; i++) {
    const serial = c.dt[i];
    if (Math.floor(serial + 1e-7) - 25569 !== l.dia || limparPlaca(txt('placa', i)) !== pl) continue;
    const fuel = String(txt('fuel', i) || '');
    if (tipo && tipoComb(fuel) !== tipo) continue;
    cands.push({ i, linha: c.linha[i], serial, hodo: c.hodo[i], fuel, mot: txt('mot', i), inf3: txt('inf3', i) });
  }
  if (cands.length <= 1) return cands[0] || null;
  const h = Math.round(l.hodometro || 0), m = Math.round((l.dia + 25569) * 1440 + (l.seg || 0) / 60);
  const unico = (f) => { const x = cands.filter(f); return x.length === 1 ? x[0] : null; };
  return unico((x) => Math.round(x.serial * 1440) === m && (!h || Math.round(x.hodo || 0) === h)) ||
    unico((x) => Math.round(x.serial * 1440) === m) || unico((x) => h && Math.round(x.hodo || 0) === h);
}

// grava a troca: col 'L' (motorista) ou 'AD' (unidade). Volta a alteração criada (estado 'pendente').
export async function corrigirNaBaseCopia(l, col, valor) {
  const d = await carregarLista();
  const x = acharLinha(d, l);
  if (!x) throw new Error(l.tempoReal
    ? 'Este abastecimento chegou hoje pela API do cartão e ainda não está nos abastecimentos (entra às 6h do dia seguinte). Troque depois disso.'
    : 'Este abastecimento não foi encontrado (pode ter sido corrigido ou excluído).');
  const antes = { L: x.mot, AD: x.inf3 }[col] ?? null;
  const r = await fetch('/api/base-copia', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itens: [{ linha: x.linha, placa: limparPlaca(l.placa), data: x.serial, acao: 'editar', celulas: { [col]: valor }, antes: { [col]: antes } }] }),
  });
  if (r.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Não foi possível gravar a correção (' + r.status + ').');
  return j.alteracoes[0];
}

// correções salvas (pendentes e dos últimos 7 dias) e se o acesso permite corrigir; sem acesso = {podeEditar: false}
export async function buscarCorrecoes() {
  try {
    const r = await fetch('/api/base-copia', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return { podeEditar: false, alteracoes: [] };
    return await r.json();
  } catch { return { podeEditar: false, alteracoes: [] }; }
}

// placa|minuto -> {L?, AD?, estado} das correções que ainda não erraram (a mais nova vale)
export function trocasPorMinuto(alteracoes) {
  const m = new Map();
  for (const a of [...(alteracoes || [])].sort((x, y) => x.id - y.id)) {
    if (a.acao === 'excluir' || a.estado === 'erro' || !a.celulas) continue;
    const k = minutoSerial(a.placa, a.data);
    m.set(k, { ...(m.get(k) || {}), ...a.celulas, estado: a.estado });
  }
  return m;
}
export const NOME_ESTADO = { pendente: 'aguardando gravação', aguardando: 'aguardando gravação', aplicada: 'gravada' };
