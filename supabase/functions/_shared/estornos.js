// Regras puras dos estornos da TruckPag e da exclusão com km do seguinte (sem arquivos nem rede), usadas pelo vigia
// (scripts/estornos_truckpag.mjs, scripts/km_recalcular.mjs) e pela nuvem (supabase/functions/estornos-truckpag, cópia em
// supabase/functions/_shared feita por scripts/nuvem_publicar.mjs). Migração 100% nuvem, passo 4 (19/11/2026): só mudaram de
// lugar, nenhuma regra mudou. lista = lista colunar da Base_copia ({col, dic}, base_copia_lista.py ou gestao_gerar_base_copia).
const normKey = (s) => String(s ?? '').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(Boolean).join(' ');
export const cadeia = (fuel) => { const k = normKey(fuel); return k.includes('DIESEL') ? 'DIESEL' : k; };   // igual ao chaveCadeia do Consolidador
export const placaK = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// "AAAA-MM-DD HH:MM:SS(.mmm)" (hora local) -> número serial do Excel, como a coluna E da Base_copia
export function serial(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 864e5 + 25569 : null;
}

// lista = base-copia.json; estornadas = transações ESTORNADA; aprovadas = as válidas (COMPRA/MANUAL APROVADA) do mesmo
// período -> {indices, ambiguos: [transação], semLinha: [transação], refeitas: [transação] (canceladas que foram refeitas: não apagam)}.
// O posto costuma desfazer e refazer na hora (mesma litragem e hodômetro, segundos depois): a linha é achada pelo segundo
// exato (±5 s); sem ela, até 1,5 min, mas nunca uma linha que bate (±5 s) com uma transação aprovada.
export function acharNaBase(lista, estornadas, aprovadas = []) {
  const { col, dic } = lista;
  const SEG = 5 / 86400, MIN = 1.5 / 1440;
  const indices = [], ambiguos = [], semLinha = [];
  const candidatas = (t, janela) => {
    const dt = serial(t.transacao_data), litros = Number(t.litragem), km = Number(t.quilometragem);
    if (dt === null || !(litros > 0)) return [];
    const r = [];
    for (let i = 0; i < col.linha.length; i++) {
      if (Math.abs(col.dt[i] - dt) > janela || Math.abs((col.litros[i] || 0) - litros) > 0.011) continue;
      if (String(dic.forma[col.forma[i]] || '').toUpperCase() !== 'TRUCKPAG') continue;
      if (col.hodo[i] !== km && placaK(dic.placa[col.placa[i]]) !== placaK(t.veiculo_placa)) continue;
      r.push(i);
    }
    return r;
  };
  const deAprovada = new Set(aprovadas.flatMap((a) => candidatas(a, SEG)));
  // Refeita (26/11/2026; caso RND0H44 de 12/11: lançada duas vezes, 08:30:18 e 08:30:40, e a TruckPag cancelou uma): a importação
  // guarda uma linha só por placa + minuto + litros, então a linha do portal pode ser a da transação cancelada e representar a
  // que continua válida. Se há transação válida igual (mesmos litros, mesmo hodômetro ou placa, até 2 min), só se apaga uma linha
  // quando o portal tem mais linhas do que as válidas; senão a cancelada fica como refeita e nada sai.
  const GEMEA = 2 / 1440, refeitas = [];
  const gemeas = (t) => {
    const dt = serial(t.transacao_data), litros = Number(t.litragem), km = Number(t.quilometragem);
    return aprovadas.filter((a) => { const da = serial(a.transacao_data); return da !== null && dt !== null && Math.abs(da - dt) <= GEMEA &&
      Math.abs(Number(a.litragem) - litros) <= 0.011 && (Number(a.quilometragem) === km || placaK(a.veiculo_placa) === placaK(t.veiculo_placa)); });
  };
  for (const t of estornadas) {
    const g = gemeas(t);
    if (g.length && candidatas(t, GEMEA).length <= g.length) { refeitas.push(t); continue; }
    let achadas = candidatas(t, SEG).filter((i) => !deAprovada.has(i));
    if (!achadas.length) achadas = candidatas(t, MIN).filter((i) => !deAprovada.has(i));
    if (achadas.length === 1) indices.push(achadas[0]);
    else if (achadas.length > 1) ambiguos.push(t);
    else semLinha.push(t);
  }
  return { indices: [...new Set(indices)], ambiguos, semLinha, refeitas };
}

// Exclusão de linhas da Base_copia (estorno, duplicado) + km do abastecimento seguinte de cada uma: o seguinte que contava
// o trecho a partir da linha excluída passa a contar do abastecimento anterior a ela.
// lista = base-copia.json (colunar); indices = posições na lista. Devolve os itens para /api/sync/base-copia/automaticas.
export function itensExclusao(lista, indices) {
  const { col, dic } = lista;
  const fora = new Set(indices), itens = [];
  const chaveDe = (i) => placaK(dic.placa[col.placa[i]]) + '§' + cadeia(dic.fuel[col.fuel[i]]);
  const cadeias = new Map();
  for (let i = 0; i < col.linha.length; i++) {
    if (num(col.dt[i]) === null || num(col.hodo[i]) === null) continue;
    const k = chaveDe(i);
    if (!cadeias.has(k)) cadeias.set(k, []);
    cadeias.get(k).push(i);
  }
  for (const c of cadeias.values()) c.sort((a, b) => col.dt[a] - col.dt[b] || col.hodo[a] - col.hodo[b]);
  for (const i of indices) {
    itens.push({ acao: 'excluir', linha: col.linha[i], placa: dic.placa[col.placa[i]], data: col.dt[i], celulas: {}, antes: {} });
    const c = cadeias.get(chaveDe(i));
    if (!c) continue;
    const pos = c.indexOf(i);
    if (pos < 0) continue;
    // anterior e seguinte que ficam (pula as outras linhas excluídas)
    let a = pos - 1; while (a >= 0 && fora.has(c[a])) a--;
    let s = pos + 1; while (s < c.length && fora.has(c[s])) s++;
    if (a < 0 || s >= c.length) continue;
    const seg = c[s], kmAtual = num(col.km[seg]);
    const kmNovo = Math.round((col.hodo[seg] - col.hodo[c[a]]) * 100) / 100;
    // só se o km do seguinte vinha da linha excluída (ou de outra excluída entre elas)
    const vinhaDeExcluida = c.slice(a + 1, s).some((x) => kmAtual !== null && Math.abs(kmAtual - (col.hodo[seg] - col.hodo[x])) < 0.5);
    if (kmNovo < 0 || !vinhaDeExcluida || Math.abs(kmAtual - kmNovo) < 0.5 || itens.some((x) => x.linha === col.linha[seg] && x.acao !== 'excluir')) continue;
    const litros = num(col.litros[seg]);
    itens.push({ linha: col.linha[seg], placa: dic.placa[col.placa[seg]], data: col.dt[seg],
      celulas: { R: kmNovo, S: litros ? Math.round(kmNovo / litros * 10000) / 10000 : null }, antes: { R: kmAtual, S: num(col.kml[seg]) } });
  }
  return itens;
}
