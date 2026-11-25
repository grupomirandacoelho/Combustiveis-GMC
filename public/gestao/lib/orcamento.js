// Leitura da planilha do orçamento da frota (Banco_Orçamento_Despesas_Frota.xlsx) no navegador, para o envio pela tela Real x Orçado
// (15.3, item 6, 25/11/2026; pedido do usuário "Pode seguir com o upload do orçamento"). Mesmas regras do vigia
// (scripts/importar_base.py ler_orcamento, num, data_iso): aba Base_Metas (Unidade, Natureza, Data, Valor) e aba BD_UND (UNIDADE,
// INF ADICIONAL e, se tiver, Centro de Custo). Recebe as abas já como listas de linhas (SheetJS sheet_to_json com header: 1), para
// poder ser testada sem o navegador.

const texto = (v) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());
const cab = (v) => texto(v).toUpperCase();

// número vindo do Excel: 1234.5, '1234,5', '1.234,5', 'R$ 1.234,56'; vazio ou inválido -> null
export function numero(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/R\$/g, '').replace(/\s/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const dois = (n) => String(n).padStart(2, '0');
// data vinda do Excel -> 'AAAA-MM-DD' ou null: Date (SheetJS com cellDates), número de série do Excel, 'dd/mm/aaaa' ou 'aaaa-mm-dd'
export function data(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.getFullYear() + '-' + dois(v.getMonth() + 1) + '-' + dois(v.getDate());
  if (typeof v === 'number' && v > 20000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000));
    return d.getUTCFullYear() + '-' + dois(d.getUTCMonth() + 1) + '-' + dois(d.getUTCDate());
  }
  const s = texto(v);
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: \d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (m) return valida(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/);
  if (m) return valida(+m[1], +m[2], +m[3]);
  return null;
}
function valida(a, m, d) {
  const x = new Date(Date.UTC(a, m - 1, d));
  return x.getUTCFullYear() === a && x.getUTCMonth() === m - 1 && x.getUTCDate() === d ? a + '-' + dois(m) + '-' + dois(d) : null;
}

// {baseMetas: linhas, bdUnd: linhas} -> {metas, unidades, ignoradas, resumo} ou {erro}
export function lerOrcamento({ baseMetas, bdUnd }) {
  if (!Array.isArray(baseMetas) || !baseMetas.length) return { erro: 'Não achei a aba Base_Metas na planilha.' };
  if (!Array.isArray(bdUnd) || !bdUnd.length) return { erro: 'Não achei a aba BD_UND na planilha.' };
  const c1 = (baseMetas[0] || []).map(cab);
  const im = Object.fromEntries(['UNIDADE', 'NATUREZA', 'DATA', 'VALOR'].map((k) => [k, c1.indexOf(k)]));
  if (Object.values(im).some((i) => i < 0)) return { erro: 'A aba Base_Metas precisa das colunas Unidade, Natureza, Data e Valor.' };
  const c2 = (bdUnd[0] || []).map(cab);
  const iu = c2.indexOf('UNIDADE'), ii = c2.indexOf('INF ADICIONAL'), ic = c2.indexOf('CENTRO DE CUSTO');
  if (iu < 0 || ii < 0) return { erro: 'A aba BD_UND precisa das colunas UNIDADE e INF ADICIONAL.' };

  const metas = [], ignoradas = [];
  baseMetas.slice(1).forEach((r, i) => {
    if (!r || r.every((v) => texto(v) === '')) return;   // linha em branco
    const l = { unidade: texto(r[im.UNIDADE]), natureza: texto(r[im.NATUREZA]).toUpperCase(), data: data(r[im.DATA]), valor: numero(r[im.VALOR]) };
    if (!l.unidade || !l.natureza || !l.data || l.valor === null) ignoradas.push(i + 2);
    else metas.push(l);
  });
  const unidades = bdUnd.slice(1).filter((r) => r && texto(r[iu])).map((r) => ({
    unidade: texto(r[iu]), inf_adicional: texto(r[ii]) || null, centro_de_custo: ic >= 0 ? texto(r[ic]) || null : null }));
  if (!metas.length) return { erro: 'A aba Base_Metas não tem nenhuma linha completa (unidade, natureza, data e valor).' };
  if (!unidades.length) return { erro: 'A aba BD_UND não tem nenhuma unidade.' };

  // resumo para conferir antes de enviar: meses, unidades e total por natureza
  const meses = metas.map((l) => l.data.slice(0, 7)).sort();
  const porNatureza = {};
  for (const l of metas) porNatureza[l.natureza] = (porNatureza[l.natureza] || 0) + l.valor;
  return { metas, unidades, ignoradas, resumo: { linhas: metas.length, unidades: new Set(metas.map((l) => l.unidade)).size,
    mesInicio: meses[0], mesFim: meses[meses.length - 1], porNatureza } };
}
