// Fiscal/Financeiro > Conciliação de NFs, parte do vigia: liga cada nota fiscal de serviço (NFS) que o cartão emite às notas dos
// postos daquela fatura, pelas APIs (só leitura); refaz a cada 6 horas e publica no KV "conciliacao-nfs". As regras ficam em
// lib/nuvem/conciliacao.js (passo 4 da migração, 23/11/2026: as mesmas da nuvem); aqui só o cache em .dados/cartoes-api/conciliacao
// e as credenciais deste computador (apis-cartoes.json: ticket; truckpag com titulosUsuario/titulosSenha para a API de títulos).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { processar as regras } from '../lib/nuvem/conciliacao.js';

const PROJETO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(process.env.LOCALAPPDATA || '', 'GestaoCombustivel', 'apis-cartoes.json');
const PASTA = path.join(PROJETO, '.dados', 'cartoes-api', 'conciliacao');
const SAIDA = path.join(PROJETO, '.dados', 'cartoes-api', 'conciliacao-nfs.json');
const lerJson = (a, p) => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch { return p; } };
const p2 = (x) => String(x).padStart(2, '0');
const diaLocal = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };
const arquivo = (nome) => (nome === 'saida' ? SAIDA : path.join(PASTA, nome + '.json'));

export async function processar({ kvPut, log, forcar }) {
  if (!fs.existsSync(CONFIG)) return;
  const cfg = lerJson(CONFIG, {});
  fs.mkdirSync(PASTA, { recursive: true });
  return regras({
    log, agora: () => Date.now(), diaLocal, msLocal: (s) => new Date(s).getTime(), ticket: cfg.ticket, truckpag: cfg.truckpag || {},
    md5: async (t) => crypto.createHash('md5').update(t).digest('hex'), base64: (t) => Buffer.from(t).toString('base64'),
    ler: async (nome, padrao) => lerJson(arquivo(nome), padrao),
    async gravar(nome, valor) { fs.writeFileSync(arquivo(nome), JSON.stringify(valor)); },
    async publicar(chave) { kvPut(chave, SAIDA); },   // o arquivo já foi gravado (gravar 'saida')
  }, { forcar });
}
