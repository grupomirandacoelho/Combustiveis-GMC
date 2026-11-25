// Ponte para a ANP (gov.br), rodando em São Paulo (25/11/2026; 15.3, ANP pelo GitHub Actions): o gov.br derruba as conexões das
// máquinas do GitHub (EUA: "Connection reset by peer"). O workflow .github/workflows/precos-anp-petrobras.yml chama esta função com
// ?url=<endereço da ANP> e o cabeçalho x-region: sa-east-1; ela só repassa o pedido (com o Range, que o script usa para saber o
// tamanho do arquivo sem baixar) e devolve a resposta como veio, sem ler o conteúdo (quase nada de CPU; as planilhas são lidas no
// Actions por scripts/anp_precos.py). Só endereços https://www.gov.br/anp/ e só com a chave da nuvem (x-chave-nuvem).
const PERMITIDO = 'https://www.gov.br/anp/';
const REPASSA = ['content-type', 'content-length', 'content-range', 'etag', 'last-modified', 'accept-ranges'];

Deno.serve(async (req) => {
  const chave = Deno.env.get('CHAVE_NUVEM');
  if (!chave || req.headers.get('x-chave-nuvem') !== chave) return new Response('não autorizado', { status: 401 });
  const alvo = new URL(req.url).searchParams.get('url') || '';
  if (!alvo.startsWith(PERMITIDO)) return new Response('endereço fora da ANP', { status: 400 });
  const cab: Record<string, string> = { 'User-Agent': 'Mozilla/5.0 (portal gestao-combustivel)' };
  const range = req.headers.get('range');
  if (range) cab['Range'] = range;
  let r: Response;
  try {
    r = await fetch(alvo, { headers: cab, redirect: 'follow' });
  } catch (e) {
    return new Response('ANP sem resposta: ' + String((e as Error).message || e).slice(0, 200), { status: 502 });
  }
  const sai = new Headers();
  for (const h of REPASSA) { const v = r.headers.get(h); if (v) sai.set(h, v); }
  return new Response(r.body, { status: r.status, headers: sai });
});
