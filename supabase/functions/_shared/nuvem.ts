// Esqueleto das rotinas do vigia na nuvem (passo 4 da migração, 19/11/2026; plano em docs/MIGRACAO-PASSO4.md).
// Cada Edge Function chama rotina(nome, fn): confere a chave (header x-chave-nuvem, segredo CHAVE_NUVEM; o pg_cron manda pelo
// Vault), lê modo e estado em public.nuvem_rotinas, roda fn em segundo plano e registra o resultado (gestao_nuvem_registrar).
// fn({modo, estado}) -> {estado, resultado}. Em modo 'simular' a rotina não grava nada fora do banco (só anota o que faria).
// Segredos: CHAVE_NUVEM, SYNC_TOKEN (token de sincronização do portal), SITE_URL, credenciais dos cartões. Nunca vão para o log.

export const env = (k: string) => Deno.env.get(k) ?? '';

async function chamarRpc(funcao: string, args: unknown, ms = 30000): Promise<string> {
  const chave = env('SUPABASE_SERVICE_ROLE_KEY');
  const r = await fetch(env('SUPABASE_URL') + '/rest/v1/rpc/' + funcao, {
    method: 'POST', signal: AbortSignal.timeout(ms),
    headers: { apikey: chave, Authorization: 'Bearer ' + chave, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(args ?? {}),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('banco ' + funcao + ': HTTP ' + r.status + ' ' + t.slice(0, 200));
  return t;
}
export const rpc = async (funcao: string, args?: unknown, ms?: number) => { const t = await chamarRpc(funcao, args, ms); return t ? JSON.parse(t) : null; };

// arquivo gerado no banco (public.dados_gerados: 'base-copia', 'consolidacao', ...)
export const gerado = (nome: string) => rpc('gestao_dados_gerados', { p_nome: nome }, 60000);

// chamada ao portal com o token de sincronização (as mesmas rotas que o vigia usa)
export async function portal(metodo: string, rota: string, corpo?: unknown) {
  const r = await fetch(env('SITE_URL').replace(/\/+$/, '') + rota, {
    method: metodo, signal: AbortSignal.timeout(60000),
    headers: { Authorization: 'Bearer ' + env('SYNC_TOKEN'), ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(metodo + ' ' + rota + ': ' + r.status + ' ' + t.slice(0, 200));
  return t ? JSON.parse(t) : {};
}

// cache de uma rotina em public.nuvem_cache (o que o vigia guarda em arquivos): lê tudo do prefixo de uma vez, grava item a item
export async function cacheNuvem(prefixo: string) {
  const dados: Record<string, unknown> = (await rpc('gestao_nuvem_cache_ler', { p_prefixo: prefixo }, 60000)) || {};
  return {
    ler: async (nome: string, padrao: unknown) => (nome in dados ? dados[nome] : padrao),
    gravar: async (nome: string, valor: unknown) => {
      dados[nome] = valor;
      await rpc('gestao_nuvem_cache_gravar', { p_nome: prefixo + nome, p_valor: valor }, 60000);
    },
  };
}
// prazo de uma execução (a função tem tempo limitado): depois dele, o que falta reler fica com a leitura anterior
export const prazo = (segundos: number) => { const inicio = Date.now(); return () => Date.now() - inicio < segundos * 1000; };
export const msLocal = (s: string) => Date.parse(s + '-03:00');   // 'AAAA-MM-DDTHH:MM:SS' no horário de Salvador

// dia no fuso do Brasil (as rotinas do vigia usam a hora do computador, em Salvador)
export function diaLocal(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
export const horaLocal = (ms = Date.now()) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bahia', hour: '2-digit', hour12: false }).format(new Date(ms))) % 24;

type Ctx = { modo: string; estado: Record<string, unknown> };
type Fn = (c: Ctx) => Promise<{ estado?: Record<string, unknown>; resultado: Record<string, unknown> }>;

export function rotina(nome: string, fn: Fn) {
  async function executar() {
    const r = await rpc('gestao_nuvem_rotina', { p_nome: nome });
    if (!r || r.modo === 'desligado') return { pulada: 'rotina desligada' };
    try {
      const { estado, resultado } = await fn({ modo: r.modo, estado: r.estado || {} });
      const res = { modo: r.modo, ...resultado };
      await rpc('gestao_nuvem_registrar', { p_nome: nome, p_ok: true, p_estado: estado ?? null, p_resultado: res, p_erro: null });
      return res;
    } catch (e) {
      const msg = String((e as Error)?.message || e).slice(0, 500);
      await rpc('gestao_nuvem_registrar', { p_nome: nome, p_ok: false, p_estado: null, p_resultado: { modo: r.modo }, p_erro: msg }).catch(() => {});
      return { erro: msg };
    }
  }
  Deno.serve(async (req) => {
    if (!env('CHAVE_NUVEM') || req.headers.get('x-chave-nuvem') !== env('CHAVE_NUVEM')) return new Response('não autorizado', { status: 401 });
    // x-esperar: 1 = espera terminar e devolve o resultado (teste à mão); o pg_cron não espera (roda em segundo plano)
    if (req.headers.get('x-esperar') === '1') return Response.json(await executar());
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil(executar());
    return Response.json({ ok: true, rotina: nome }, { status: 202 });
  });
}
