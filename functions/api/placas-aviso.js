import { json } from '../../lib/auth.js';
import { normPlaca } from '../../lib/cartoes.js';
import { placasDesabilitadas } from './placas-desabilitadas.js';
import { lerCartoes } from '../../lib/cadastros-fonte.js';

// GET /api/placas-aviso?q=ABC1   sugestões de placa para o aviso de cartão faltando (página dos motoristas, sem login).
// Procura nas placas do controle de cartões (chave "cartoes" do KV) o que o motorista digitou: começo da placa, parte
// dela, placa antiga x Mercosul (ABC1234 = ABC1C34) e erro de digitação (1 ou 2 letras/números trocados).
// Para não entregar a lista inteira: só a partir de 3 caracteres, no máximo 5 sugestões, só pedidos do próprio site.
const MAX = 5;
const LETRAS = 'ABCDEFGHIJ';

// ABC1234 <-> ABC1C34 (o 5º caractere: 0..9 <-> A..J)
function outraForma(p) {
  if (/^[A-Z]{3}\d{4}$/.test(p)) return p.slice(0, 4) + LETRAS[Number(p[4])] + p.slice(5);
  if (/^[A-Z]{3}\d[A-J]\d{2}$/.test(p)) return p.slice(0, 4) + LETRAS.indexOf(p[4]) + p.slice(5);
  return null;
}

function distancia(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

// menor nota = melhor: 0 começa com o digitado, 1 contém, 2+ parecida (erro de digitação)
function nota(q, p) {
  if (p.startsWith(q)) return 0;
  if (p.includes(q)) return 1;
  if (q.length < 5) return null;
  const dist = distancia(q, q.length >= 7 ? p : p.slice(0, q.length));
  return dist <= (q.length >= 7 ? 2 : 1) ? 2 + dist : null;
}

export async function onRequestGet({ request, env }) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') return json({ erro: 'Origem não permitida.' }, 403);
  const q = normPlaca(new URL(request.url).searchParams.get('q')).slice(0, 7);
  if (q.length < 3) return json({ sugestoes: [], exata: false, controle: true });
  const dados = await lerCartoes(env).catch(() => null);
  const desab = await placasDesabilitadas(env);   // placa desabilitada no cadastro não é sugerida
  const lista = (dados && Array.isArray(dados.cartoes) ? dados.cartoes : []).filter((c) => c && c.placa && !desab.has(normPlaca(c.placa)));
  const consultas = [q, q.length === 7 ? outraForma(q) : null].filter(Boolean);
  const achadas = [];
  let exata = false, doControle = null;   // doControle: como a placa está no controle (ex.: digitou ABC1234, controle tem ABC1C34)
  for (const c of lista) {
    const placa = normPlaca(c.placa);
    const formas = [placa, outraForma(placa), ...(Array.isArray(c.apelidos) ? c.apelidos.map(normPlaca) : [])].filter(Boolean);
    if (q.length === 7 && formas.some((f) => consultas.includes(f))) { exata = true; doControle = placa; }
    let melhor = null;
    for (const f of formas) for (const cq of consultas) {
      const n = nota(cq, f);
      if (n !== null && (melhor === null || n < melhor)) melhor = n;
    }
    if (melhor !== null) achadas.push({ placa, n: melhor });
  }
  achadas.sort((a, b) => a.n - b.n || a.placa.localeCompare(b.placa));
  const sugestoes = [...new Set(achadas.map((a) => a.placa))].slice(0, MAX);
  // controle: false = lista dos cartões ainda não publicada (aí o celular não reclama da placa)
  return new Response(JSON.stringify({ sugestoes, exata, placa: doControle, controle: lista.length > 0 }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=60' },
  });
}
