// Conferência com os cartões (Operacional), parte do vigia: relê os últimos 45 dias da Ticket Log e da TruckPag (APIs) e compara
// com a Base_copia; publica no KV "conferencia-cartoes" o que está diferente, o que falta e o que sumiu do cartão, e atende os
// pedidos de inclusão da tela. As regras ficam em lib/nuvem/conferencia.js (passo 4 da migração, 23/11/2026: as mesmas da nuvem);
// aqui só os arquivos (.dados/cartoes-api/conferencia, a lista da Base_copia, o histórico) e as credenciais deste computador.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { processar as regras } from '../lib/nuvem/conferencia.js';
import { buscarTicket, buscarTruckpag, temConfig, HISTORICO } from './cartoes_api.mjs';

const PROJETO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(PROJETO, '.dados', 'cartoes-api', 'conferencia');
const LISTA = path.join(PROJETO, '.dados', 'cartoes-api', 'base-copia.json');
const SAIDA = path.join(PROJETO, '.dados', 'cartoes-api', 'conferencia-cartoes.json');
const CONFIG = path.join(process.env.LOCALAPPDATA || '', 'GestaoCombustivel', 'apis-cartoes.json');
const p2 = (x) => String(x).padStart(2, '0');
const diaLocal = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };
const lerJson = (arq, padrao) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return padrao; } };
const arquivo = (nome) => (nome.startsWith('dia:') ? path.join(CACHE, nome.slice(4) + '.json') : path.join(CACHE, 'estado.json'));

// relatório analítico de transações da TruckPag (situação de cada transação: estornada, recusada, vazamento)
async function truckpagAnalitico(desde, ate) {
  const c = lerJson(CONFIG, {}).truckpag || {};
  const host = (c.hosts || []).find((h) => /prd/.test(h)) || 'https://api.prd.truckpag.com.br';
  const r = await fetch(host + '/api/integracao-clientes/relatorios/analitico-transacao', { method: 'POST', signal: AbortSignal.timeout(180_000),
    headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ data_inicial: desde, data_final: ate }) });
  const j = await r.json();
  if (!Array.isArray(j.data)) throw new Error('HTTP ' + r.status);
  return j.data;
}

export async function processar({ api, kvPut, log, forcar }) {
  if (!temConfig()) return;
  return regras({
    api, log, agora: () => Date.now(), diaLocal, buscarTicket, buscarTruckpag, truckpagAnalitico,
    lista: async () => lerJson(LISTA, null), historico: async () => lerJson(HISTORICO, null),
    ler: async (nome, padrao) => lerJson(arquivo(nome), padrao),
    async gravar(nome, valor) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(arquivo(nome), JSON.stringify(valor)); },
    async publicar(chave, objeto) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(SAIDA, JSON.stringify(objeto)); kvPut(chave, SAIDA); },
  }, { forcar });
}
