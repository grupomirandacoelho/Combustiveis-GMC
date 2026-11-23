// Cadastro de motoristas integrado aos cartões (Ticket Log e TruckPag), parte do vigia (só no computador com as credenciais).
// As regras ficam em lib/nuvem/cadastros-cartoes.js (passo 4 da migração, 23/11/2026: as mesmas da nuvem); aqui só o encaixe com
// este computador: credenciais e interruptores em %LOCALAPPDATA%\GestaoCombustivel (apis-cartoes.json, motoristas-cartoes.json:
// "criar", "editar", "editarTicket"), a lista dos motoristas da planilha (planilha_cadastros.py, apagada logo depois de ler) e
// o estado em arquivo. Desde 12/11/2026 CPF, nascimento e CNH só existem na alteração até irem aos cartões (nada em disco aqui).
//  1) criarNovos(): motorista ADICIONADO pelo portal é cadastrado na Ticket (cliente 245364) e na TruckPag;
//  2) editarTruckpag(): edição de nome ou senha TruckPag (e, com "editarTicket", na Ticket) repetida nos cartões.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as R from '../lib/nuvem/cadastros-cartoes.js';

export { ehTeste } from '../lib/nuvem/cadastros-cartoes.js';
const PROJETO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = path.join(process.env.LOCALAPPDATA || '', 'GestaoCombustivel');
const CONFIG = path.join(LOCAL, 'apis-cartoes.json');
const CHAVE_CRIAR = path.join(LOCAL, 'motoristas-cartoes.json');
const ARQ = {
  'motoristas-novos': path.join(PROJETO, '.dados', 'cartoes-api', 'motoristas-novos.json'),   // id da alteração -> {ticket, truckpag}
  'motoristas-edicao': path.join(LOCAL, 'motoristas-edicao-truckpag.json'),                    // {desde}
  placas: path.join(LOCAL, 'placas-truckpag.json'),                                            // {desde}
};
const lerJson = (a, p) => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch { return p; } };

// lista dos motoristas da planilha (sem dados pessoais): o mesmo arquivo do Cadastro, apagado logo depois de ler
function motoristasDaPlanilha() {
  const r = spawnSync('py', ['scripts/planilha_cadastros.py', 'gerar'], { cwd: PROJETO, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 5 * 60 * 1000 });
  const arq = path.join(PROJETO, '.dados', 'cadastros.json');
  try {
    if (r.status !== 0) throw new Error('planilha_cadastros.py gerar falhou');
    return JSON.parse(fs.readFileSync(arq, 'utf8')).motoristas || [];
  } finally { try { fs.unlinkSync(arq); } catch {} }
}

// io do vigia (também usado por scripts/placas_truckpag.mjs)
export function ioVigia({ api, log }) {
  const cfg = lerJson(CONFIG, {});
  return {
    api, log, agora: () => Date.now(), chaves: lerJson(CHAVE_CRIAR, {}), ticket: cfg.ticket, truckpag: cfg.truckpag,
    fetchCartao: (url, opcoes) => fetch(url, opcoes), motoristas: async () => motoristasDaPlanilha(),
    ler: async (nome, padrao) => lerJson(ARQ[nome], padrao),
    async gravar(nome, valor) { fs.mkdirSync(path.dirname(ARQ[nome]), { recursive: true }); fs.writeFileSync(ARQ[nome], JSON.stringify(valor)); },
  };
}

export async function criarNovos(a) { if (fs.existsSync(CONFIG)) return R.criarNovos(ioVigia(a)); }
export async function editarTruckpag(a) { if (fs.existsSync(CONFIG)) return R.editarTruckpag(ioVigia(a)); }
export const temConfig = () => fs.existsSync(CONFIG);
