// Cadastro de placas x TruckPag (16/11/2026, pedido do usuário): a unidade da placa no portal vira o centro de custo do
// veículo na TruckPag (PUT /api/integracao-clientes/veiculo/{id} {centro_custo_id}; só esse campo muda).
//  - processar(): chamado pelo vigia (só no computador com as credenciais). Placa editada ou adicionada no Cadastro >
//    Placas com unidade: a unidade vai para a TruckPag. Liga com "placasUnidade": true em
//    %LOCALAPPDATA%\GestaoCombustivel\motoristas-cartoes.json; a primeira vez ligado vale só daqui em diante.
//  - linha de comando: `node scripts/placas_truckpag.mjs conferir` lista as placas com centro de custo diferente da
//    unidade do cadastro; `... alinhar [PLACA ...] --gravar` grava (sem --gravar só mostra o que faria).
// As regras ficam em lib/nuvem/cadastros-cartoes.js (passo 4 da migração, 23/11/2026: as mesmas da nuvem).
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { processarPlacas, truckpagPlacas, aplicar } from '../lib/nuvem/cadastros-cartoes.js';
import { ioVigia, temConfig } from './motoristas_cartoes.mjs';

const PROJETO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const soPlaca = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------- vigia ----------
export async function processar({ api, log }) {
  if (!temConfig()) return;
  return processarPlacas(ioVigia({ api, log }));
}

// ---------- linha de comando: conferir / alinhar ----------
function placasDoCadastro() {
  const r = spawnSync('py', ['scripts/planilha_cadastros.py', 'gerar'], { cwd: PROJETO, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 5 * 60 * 1000 });
  const arq = path.join(PROJETO, '.dados', 'cadastros.json');
  try {
    if (r.status !== 0) throw new Error('planilha_cadastros.py gerar falhou');
    return JSON.parse(fs.readFileSync(arq, 'utf8')).placas || [];
  } finally { try { fs.unlinkSync(arq); } catch {} }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [cmd, ...resto] = process.argv.slice(2);
  const gravar = resto.includes('--gravar'), so = new Set(resto.filter((x) => !x.startsWith('--')).map(soPlaca));
  if (!['conferir', 'alinhar'].includes(cmd)) { console.log('Uso: node scripts/placas_truckpag.mjs conferir | alinhar [PLACA ...] [--gravar]'); process.exit(1); }
  const T = truckpagPlacas(ioVigia({ api: null, log: console.log }));
  const [centros, veiculos] = await Promise.all([T.centros(), T.veiculos()]);
  const placas = placasDoCadastro().filter((p) => !so.size || so.has(soPlaca(p.placa)));
  let n = 0;
  for (const p of placas) {
    const r = await aplicar(T, centros, veiculos, p.placa, p.unidade, cmd === 'alinhar' && gravar);
    if (r.igual || (r.pulou && r.msg === 'não está na TruckPag')) continue;
    n++;
    console.log(`${r.placa} (${p.unidade}): ${r.msg}`);
  }
  console.log(n + ' placa(s) ' + (cmd === 'alinhar' && gravar ? 'processada(s).' : 'diferente(s).'));
}
