// Publica as rotinas da nuvem (Edge Functions do Supabase; passo 4 da migração, 19/11/2026, docs/MIGRACAO-PASSO4.md).
//   node scripts/nuvem_publicar.mjs                      copia os módulos compartilhados e publica todas as funções
//   node scripts/nuvem_publicar.mjs estornos-truckpag    só essa
//   node scripts/nuvem_publicar.mjs --segredos           também (re)envia os segredos e o Vault
//   node scripts/nuvem_publicar.mjs --copiar             só copia os módulos para supabase/functions/_shared (o teste confere)
// Segredos lidos de %LOCALAPPDATA%\GestaoCombustivel (supabase.json com access_token, apis-cartoes.json, sync-token.txt,
// nuvem-chave.txt) e nunca impressos.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const PROJETO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FUNCOES = path.join(PROJETO, 'supabase', 'functions');
const LOCAL = path.join(process.env.LOCALAPPDATA || '', 'GestaoCombustivel');
const SITE = process.env.SITE_URL || 'https://gestao-combustivel.pages.dev';

// módulos do portal/vigia usados também pelas funções: cópia fiel (tests/js/nuvem.test.mjs confere que estão iguais)
export const COPIAS = {
  'consolidador.js': 'public/gestao/lib/consolidador.js',
  'rateio.js': 'public/gestao/lib/rateio.js',
  'estornos.js': 'lib/nuvem/estornos.js',
  'cartoes.js': 'lib/nuvem/cartoes.js',
  'rateio-bomba.js': 'lib/nuvem/rateio-bomba.js',
  'conferencia.js': 'lib/nuvem/conferencia.js',
  'conciliacao.js': 'lib/nuvem/conciliacao.js',
};
// em _shared tudo fica na mesma pasta: os imports do portal passam a apontar para o lado
export const ajustarImports = (texto) => texto.replace(/'\.\.\/\.\.\/public\/gestao\/lib\/([\w-]+\.js)'/g, "'./$1'");
export function copiar() {
  for (const [destino, origem] of Object.entries(COPIAS)) {
    fs.writeFileSync(path.join(FUNCOES, '_shared', destino), ajustarImports(fs.readFileSync(path.join(PROJETO, origem), 'utf8')));
  }
}

const lerJson = (a) => JSON.parse(fs.readFileSync(a, 'utf8').replace(/^﻿/, ''));
const esconder = (s) => String(s).replace(/sbp_\w+|sb_secret_\w+|eyJ[\w.-]+/g, '***');

async function main() {
  const args = process.argv.slice(2);
  copiar();
  if (args.includes('--copiar')) return console.log('módulos copiados para supabase/functions/_shared');
  const sb = lerJson(path.join(LOCAL, 'supabase.json'));
  if (!sb.access_token) throw new Error('falta o access_token em supabase.json');
  const ref = new URL(sb.url).hostname.split('.')[0];
  const H = { Authorization: 'Bearer ' + sb.access_token, 'Content-Type': 'application/json' };
  const arqChave = path.join(LOCAL, 'nuvem-chave.txt');
  if (!fs.existsSync(arqChave)) fs.writeFileSync(arqChave, crypto.randomBytes(32).toString('hex'));
  const chave = fs.readFileSync(arqChave, 'utf8').trim();

  if (args.includes('--segredos')) {
    const cartoes = lerJson(path.join(LOCAL, 'apis-cartoes.json'));
    const segredos = {
      CHAVE_NUVEM: chave, SITE_URL: SITE, SYNC_TOKEN: fs.readFileSync(path.join(LOCAL, 'sync-token.txt'), 'utf8').trim(),
      TRUCKPAG_HOST: cartoes.truckpag.hosts[0], TRUCKPAG_TOKEN: cartoes.truckpag.token,
      TICKET_HOST: cartoes.ticket.host, TICKET_BASIC: cartoes.ticket.basic, TICKET_CLIENTES: JSON.stringify(cartoes.ticket.clientes),
      // login da API de títulos da TruckPag (Conciliação de NFs, 23/11/2026)
      ...(cartoes.truckpag.titulosUsuario ? { TRUCKPAG_TITULOS_USUARIO: cartoes.truckpag.titulosUsuario, TRUCKPAG_TITULOS_SENHA: cartoes.truckpag.titulosSenha } : {}),
    };
    const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/secrets`, { method: 'POST', headers: H,
      body: JSON.stringify(Object.entries(segredos).map(([name, value]) => ({ name, value }))) });
    console.log('segredos das funções:', r.status, Object.keys(segredos).join(', '));
    // Vault (o pg_cron lê daqui para chamar as funções): pelo psycopg, sem passar pela linha de comando
    const py = `import sys,json; sys.path.insert(0,'scripts'); import gestao_carga
d=json.loads(sys.stdin.read())
with gestao_carga.conectar() as c, c.cursor() as cur:
    for nome, valor in d.items():
        cur.execute("select id from vault.secrets where name=%s", (nome,)); r=cur.fetchone()
        if r: cur.execute("select vault.update_secret(%s, %s)", (r[0], valor))
        else: cur.execute("select vault.create_secret(%s, %s)", (valor, nome))
    c.commit()
print('vault ok')`;
    // site_url e sync_token: a varredura das filas (pg_cron) chama o portal com o token de sincronização (23/11/2026)
    const v = spawnSync('py', ['-c', py], { cwd: PROJETO, encoding: 'utf8',
      input: JSON.stringify({ chave_nuvem: chave, url_projeto: sb.url, site_url: SITE, sync_token: segredos.SYNC_TOKEN }) });
    console.log(esconder((v.stdout + v.stderr).trim()));
  }

  const nomes = args.filter((a) => !a.startsWith('--'));
  const todas = fs.readdirSync(FUNCOES).filter((n) => !n.startsWith('_') && fs.existsSync(path.join(FUNCOES, n, 'index.ts')));
  for (const nome of nomes.length ? nomes : todas) {
    const d = spawnSync('npx', ['--yes', 'supabase', 'functions', 'deploy', nome, '--yes', '--use-api', '--no-verify-jwt', '--remote=' + ref],
      { cwd: PROJETO, encoding: 'utf8', shell: true, env: { ...process.env, SUPABASE_ACCESS_TOKEN: sb.access_token } });
    console.log(`função ${nome}:`, d.status === 0 ? 'publicada' : 'FALHOU\n' + esconder((d.stdout + d.stderr).trim().split('\n').slice(-6).join('\n')));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(esconder(e.message || e)); process.exitCode = 1; });
}
