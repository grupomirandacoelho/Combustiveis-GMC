// Sincroniza a planilha Base com o site: se a Base mudou, gera os dados e envia para a Cloudflare.
//
//   node scripts/sincronizar.mjs            confere e envia só se a Base mudou (uso da tarefa agendada)
//   node scripts/sincronizar.mjs --forcar   gera e envia agora, mesmo sem mudança
//
// A Base nunca é alterada (o importador em Python lê uma cópia). Os dados vão para o Workers KV (binding DADOS):
//   chave "abastecimentos"  o arquivo .dados/abastecimentos.json gerado pelo importar_base.py
//   chave "versao"          {versao, geradoEm, linhas, origem}; o site usa para avisar que há dados novos
// O envio usa o login do Wrangler deste computador (npx wrangler login). Se existir o arquivo
// %LOCALAPPDATA%\GestaoCombustivel\cloudflare-token.txt, o token de API dele é usado no lugar.
//
// Por que Node e não Python: o Python da Microsoft Store isola a pasta AppData dos programas que ele abre,
// e o Wrangler aberto por ele não enxerga o login.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gerar as gerarPainelMotoristas } from './painel_motoristas.mjs';

const PROJETO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = path.join(path.dirname(PROJETO), 'Base.xlsx');
const LOCAIS = path.join(path.dirname(PROJETO), 'LOCALIZAÇÃO DOS POSTOS.xlsx');   // coordenadas do mapa
const ORCAMENTO = path.join(path.dirname(PROJETO), 'Banco_Orçamento_Despesas_Frota.xlsx');   // dashboard Real x Orçado
// negociações das bombas internas (Preço bomba interna): planilha própria desde 07/10/2026, também vai nos dados
const BOMBA = process.env.PLANILHA_BOMBA || path.join(PROJETO, 'CONTROLES', 'Negociação bomba interna.xlsx');
const GERADO = path.join(PROJETO, '.dados', 'abastecimentos.json');
const PASTA = path.join(process.env.LOCALAPPDATA || PROJETO, 'GestaoCombustivel');
const ESTADO = path.join(PASTA, 'estado.json');
const LOG = path.join(PASTA, 'sincronizacao.log');
const TRAVA = path.join(PASTA, 'sincronizando.trava');
const TOKEN = path.join(PASTA, 'cloudflare-token.txt');
const ESPERA_ESTAVEL = 20;        // s sem mudança na Base antes de ler (Excel/ownCloud terminando de gravar)
const INTERVALO_VIGIA = 10;       // s entre conferências no modo --vigiar
const TRAVA_VENCIDA = 20 * 60;    // s; trava mais velha que isso é de uma execução que caiu
// postos dos motoristas: o portal registra alterações; o vigia grava na planilha de negociações e publica a lista
const NEGOCIACOES = process.env.PLANILHA_NEGOCIACAO || path.join(path.dirname(PROJETO), 'Gestão de negociações de preço.xlsx');
const SITE = process.env.SITE_URL || 'https://gestao-combustivel.pages.dev';
const TOKEN_SYNC = path.join(PASTA, 'sync-token.txt');
const POSTOS_GERADO = path.join(PROJETO, '.dados', 'postos.csv');

fs.mkdirSync(PASTA, { recursive: true });

function log(msg) {
  try { if (fs.statSync(LOG).size > 1_000_000) fs.renameSync(LOG, LOG + '.1'); } catch {}
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const linha = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}  ${msg}`;
  fs.appendFileSync(LOG, linha + '\n', 'utf8');
  console.log(linha);
}

function rodar(cmd, args, extraEnv = {}) {
  const r = spawnSync(cmd, args, {
    cwd: PROJETO, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32',
    timeout: 10 * 60 * 1000, env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...extraEnv },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} falhou: ` + ((r.stderr || '') + (r.stdout || '')).trim().slice(-800));
  return r.stdout || '';
}

// conta da Cloudflare onde está o site: vai sempre explícita, para o login do Wrangler não escolher outra conta
// (aconteceu no computador reserva: o login dele tinha acesso a outra conta e o envio dava "namespace not found")
const CONTA_CLOUDFLARE = 'b28f3cec780adbc994189a364453bf20';
function envToken() {
  try {
    const t = fs.readFileSync(TOKEN, 'utf8').trim();
    return t ? { CLOUDFLARE_API_TOKEN: t, CLOUDFLARE_ACCOUNT_ID: CONTA_CLOUDFLARE } : { CLOUDFLARE_ACCOUNT_ID: CONTA_CLOUDFLARE };
  } catch { return { CLOUDFLARE_ACCOUNT_ID: CONTA_CLOUDFLARE }; }
}

function kvPut(chave, arquivo) {
  rodar('npx', ['--yes', 'wrangler@4', 'kv', 'key', 'put', chave, '--path', `"${arquivo}"`, '--binding', 'DADOS', '--remote'], envToken());
}

function lerEstado() { try { return JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch { return {}; } }

// "2026-09-30T09:10:05" no horário local — mesmo formato do geradoEm dos dados
function horaLocal(ms = Date.now()) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Avisa o site do andamento (chave "status"): o botão Atualizar mostra "a Base está sendo enviada"
function avisarSite(status) {
  try {
    const arq = path.join(PASTA, 'status.json');
    fs.writeFileSync(arq, JSON.stringify(status));
    kvPut('status', arq);
  } catch (e) {
    log('Aviso: não foi possível informar o andamento ao site (' + String(e.message || e).slice(0, 160) + ')');
  }
}

let avisadoHaPouco = null;   // no modo vigia, avisa "alterada há pouco" uma vez por gravação, não a cada volta

function verificar(forcar) {
  if (!fs.existsSync(BASE)) { log('Base não encontrada: ' + BASE); return 1; }
  const st = fs.statSync(BASE);
  let stLoc = null, stNeg = null, stOrc = null, stBomba = null;
  try { stLoc = fs.statSync(LOCAIS); } catch {}
  try { stNeg = fs.statSync(NEGOCIACOES); } catch {}   // preços negociados dos postos externos também vão nos dados
  try { stOrc = fs.statSync(ORCAMENTO); } catch {}     // orçamento da frota também vai nos dados
  try { stBomba = fs.statSync(BOMBA); } catch {}       // negociações das bombas internas também vão nos dados
  const estado = lerEstado();
  const mudou = estado.mtime !== st.mtimeMs || estado.tamanho !== st.size ||
    (stLoc && (estado.mtimeLocais !== stLoc.mtimeMs || estado.tamanhoLocais !== stLoc.size)) ||
    (stNeg && (estado.mtimeNegDados !== stNeg.mtimeMs || estado.tamanhoNegDados !== stNeg.size)) ||
    (stOrc && (estado.mtimeOrc !== stOrc.mtimeMs || estado.tamanhoOrc !== stOrc.size)) ||
    (stBomba && (estado.mtimeBomba !== stBomba.mtimeMs || estado.tamanhoBomba !== stBomba.size));
  if (!forcar && !mudou) return 0;                           // nada novo: sai em silêncio
  const maisRecente = Math.max(st.mtimeMs, stLoc ? stLoc.mtimeMs : 0, stNeg ? stNeg.mtimeMs : 0, stOrc ? stOrc.mtimeMs : 0, stBomba ? stBomba.mtimeMs : 0);
  if (!forcar && (Date.now() - maisRecente) / 1000 < ESPERA_ESTAVEL) {
    if (avisadoHaPouco !== maisRecente) {
      log('Base alterada; esperando terminar de gravar para ler.');
      avisadoHaPouco = maisRecente;
    }
    return 0;
  }
  try {
    const dono = Number(fs.readFileSync(TRAVA, 'utf8'));
    let vivo = dono !== process.pid;   // trava deste mesmo processo não bloqueia
    if (vivo) { try { process.kill(dono, 0); } catch { vivo = false; } }   // o processo que travou já terminou
    if (vivo && (Date.now() - fs.statSync(TRAVA).mtimeMs) / 1000 < TRAVA_VENCIDA) {
      log('Outra sincronização em andamento; esta rodada foi pulada.');
      return 0;
    }
  } catch {}
  fs.writeFileSync(TRAVA, String(process.pid));
  const baseSalvaEm = horaLocal(maisRecente);
  try {
    log(forcar ? 'Sincronização manual; gerando dados…' : 'Base alterada; gerando dados…');
    avisarSite({ estado: 'processando', desde: horaLocal(), baseSalvaEm });
    const saida = rodar('py', ['scripts/importar_base.py', `"${BASE}"`]);
    saida.trim().split(/\r?\n/).forEach((l) => log('  ' + l));
    const d = JSON.parse(fs.readFileSync(GERADO, 'utf8'));
    const info = { versao: d.versao, geradoEm: d.geradoEm, linhas: d.linhas, origem: 'planilha Base', baseSalvaEm };

    log('Enviando para a Cloudflare…');
    kvPut('abastecimentos', GERADO);
    // migração 100% nuvem (19/11/2026): os abastecimentos dos painéis passam a vir do banco (public.dados_painel); as partes
    // que ainda vêm das planilhas (negociações, coordenadas, orçamento) vão à parte e o portal junta (functions/gestao/dados)
    const arqExtras = path.join(PASTA, 'abastecimentos-extras.json');
    fs.writeFileSync(arqExtras, JSON.stringify({ negociacao: d.negociacao ?? null, fornecedoresBomba: d.fornecedoresBomba ?? null,
      locais: d.locais || {}, locaisSuspeitos: d.locaisSuspeitos || [], negPostos: d.negPostos ?? null, orcamento: d.orcamento ?? null }));
    kvPut('abastecimentos-extras', arqExtras);
    // cadastro dos fornecedores das bombas internas (com CNPJ) à parte: Movimentações e Rateio das NFs leem sem os dados todos
    const arqForn = path.join(PASTA, 'fornecedores-bomba.json');
    fs.writeFileSync(arqForn, JSON.stringify({ fornecedores: d.fornecedoresBomba || [], geradoEm: d.geradoEm }));
    kvPut('fornecedores-bomba', arqForn);
    // área do motorista (/motorista/): abastecimentos separados por motorista, para o site entregar a cada um só os dele
    try {
      const pm = gerarPainelMotoristas(GERADO, path.join(PASTA, 'painel-motoristas.json'));
      rodar('npx', ['--yes', 'wrangler@4', 'kv', 'bulk', 'put', `"${pm.arquivo}"`, '--binding', 'DADOS', '--remote'], envToken());
      log(`  Área do motorista: ${pm.motoristas} motoristas (${pm.linhas} abastecimentos dos últimos meses).`);
    } catch (e) { log('  Área do motorista: não foi possível publicar (' + String(e.message || e).slice(0, 200) + ').'); }
    const arqVersao = path.join(PASTA, 'versao.json');
    fs.writeFileSync(arqVersao, JSON.stringify(info));
    kvPut('versao', arqVersao);   // por último: o site só vê a carga nova quando os dados já estão lá

    fs.writeFileSync(ESTADO, JSON.stringify({
      ...lerEstado(),   // mantém o que é da planilha de negociações (mtimeNeg/tamanhoNeg)
      mtime: st.mtimeMs, tamanho: st.size,
      mtimeLocais: stLoc ? stLoc.mtimeMs : null, tamanhoLocais: stLoc ? stLoc.size : null,
      mtimeNegDados: stNeg ? stNeg.mtimeMs : null, tamanhoNegDados: stNeg ? stNeg.size : null,
      mtimeOrc: stOrc ? stOrc.mtimeMs : null, tamanhoOrc: stOrc ? stOrc.size : null,
      mtimeBomba: stBomba ? stBomba.mtimeMs : null, tamanhoBomba: stBomba ? stBomba.size : null,
      versao: info.versao, enviadoEm: new Date().toISOString(),
    }));
    log(`Pronto: versão ${info.versao} no ar. Quem estiver com o site aberto vê o botão "Atualizar: dados novos".`);
    avisarSite({ estado: 'ok', desde: horaLocal(), baseSalvaEm, versao: info.versao });
    return 0;
  } catch (e) {
    const msg = String(e.message || e).replace(/\x1b\[[0-9;]*m/g, '');
    log('ERRO: ' + msg);
    avisarSite({ estado: 'erro', desde: horaLocal(), baseSalvaEm, mensagem: msg.slice(0, 300) });
    return 1;
  } finally {
    try { fs.unlinkSync(TRAVA); } catch {}
  }
}

// ---------------- postos dos motoristas (planilha de negociações) ----------------
function tokenSync() {
  if (process.env.SYNC_TOKEN) return process.env.SYNC_TOKEN;
  try { return fs.readFileSync(TOKEN_SYNC, 'utf8').trim(); } catch { return ''; }
}

async function api(metodo, rota, corpo, tipo = 'application/json') {
  const r = await fetch(SITE + rota, {
    method: metodo,
    headers: { Authorization: 'Bearer ' + tokenSync(), ...(corpo !== undefined ? { 'Content-Type': tipo } : {}) },
    body: corpo === undefined ? undefined : (tipo === 'application/json' ? JSON.stringify(corpo) : corpo),
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`${metodo} ${rota}: ${r.status} ${texto.slice(0, 200)}`);
  return texto ? JSON.parse(texto) : {};
}

function rodarPython(args) {
  const saida = rodar('py', ['scripts/planilha_negociacao.py', ...args]);
  const ultima = saida.trim().split(/\r?\n/).pop();
  return JSON.parse(ultima);
}

async function publicarPostos(motivo) {
  const r = rodarPython(['gerar-postos']);
  const csv = fs.readFileSync(POSTOS_GERADO, 'utf8');
  await api('PUT', '/api/sync/postos', csv, 'text/csv; charset=utf-8');
  try {
    const st = fs.statSync(NEGOCIACOES);
    let stLoc = null;
    try { stLoc = fs.statSync(LOCAIS); } catch {}
    const e = lerEstado();
    fs.writeFileSync(ESTADO, JSON.stringify({ ...e, mtimeNeg: st.mtimeMs, tamanhoNeg: st.size,
      mtimeLocPostos: stLoc ? stLoc.mtimeMs : null, tamanhoLocPostos: stLoc ? stLoc.size : null }));
  } catch {}
  log(`Lista dos motoristas publicada (${r.postos} postos negociados desde ${r.desde})${motivo ? ': ' + motivo : ''}.`);
}

const ultimoEstadoInformado = new Map();   // id -> "estado|mensagem" (evita escrever no banco a cada volta)
// correção única pendente (scripts/planilha_negociacao.py corrigir-portal): roda quando a planilha estiver fechada
const CORRECAO_PENDENTE = path.join(PROJETO, '.dados', 'corrigir-portal.pendente');
function correcaoPendente() {
  if (!fs.existsSync(CORRECAO_PENDENTE)) return;
  const r = rodarPython(['corrigir-portal']);
  if (r.erro) return;   // planilha aberta no Excel: tenta na próxima volta
  fs.unlinkSync(CORRECAO_PENDENTE);
  log(`Correção da planilha de negociações aplicada: ${r.valores_preenchidos.length} valores preenchidos (linhas ${r.valores_preenchidos.join(', ') || '-'}), ` +
    `${r.linhas_marcadas_sim} linhas marcadas "Sim" em "Novo contato feito?". Cópia de segurança: ${r.copia}`);
}

async function processarPostos() {
  try { correcaoPendente(); } catch (e) { log('ERRO na correção da planilha: ' + String(e.message || e).slice(0, 300)); }
  if (!tokenSync()) return;
  const { pendentes } = await api('GET', '/api/sync/pendentes');
  if (pendentes && pendentes.length) {
    // na pasta do projeto: o Python da Microsoft Store não enxerga o que o Node grava no AppData
    const arq = path.join(PROJETO, '.dados', 'alteracoes-pendentes.json');
    fs.writeFileSync(arq, JSON.stringify(pendentes));
    const r = rodarPython(['gravar', `"${arq}"`]);
    const mudaram = r.itens.filter((i) => ultimoEstadoInformado.get(i.id) !== i.estado + '|' + (i.mensagem || ''));
    if (mudaram.length) {
      await api('POST', '/api/sync/resultado', { itens: mudaram });
      mudaram.forEach((i) => ultimoEstadoInformado.set(i.id, i.estado + '|' + (i.mensagem || '')));
    }
    const gravadas = r.itens.filter((i) => i.estado === 'aplicada');
    if (gravadas.length) {
      log(`${gravadas.length} alteração(ões) do portal gravada(s) na planilha de negociações (linhas ${gravadas.map((i) => i.linha).join(', ')}).`);
      await publicarPostos();
      return;
    }
    if (mudaram.some((i) => i.estado === 'aguardando')) log('Alterações do portal aguardando: a planilha de negociações está aberta no Excel.');
  }
  // planilha editada à mão: republica a lista dos motoristas quando ela para de mudar
  try {
    const st = fs.statSync(NEGOCIACOES);
    const e = lerEstado();
    if ((e.mtimeNeg !== st.mtimeMs || e.tamanhoNeg !== st.size) && (Date.now() - st.mtimeMs) / 1000 >= ESPERA_ESTAVEL) {
      await publicarPostos('planilha de negociações alterada');
      return;
    }
    // coordenadas novas na LOCALIZAÇÃO (mapa de calor, busca automática ou à mão) também vão para a lista dos motoristas
    const sl = fs.statSync(LOCAIS);
    if ((e.mtimeLocPostos !== sl.mtimeMs || e.tamanhoLocPostos !== sl.size) && (Date.now() - sl.mtimeMs) / 1000 >= ESPERA_ESTAVEL) {
      await publicarPostos('coordenadas da LOCALIZAÇÃO alteradas');
    }
  } catch {}
}

// ---------------- placas e motoristas (planilha da pasta CONTROLES) ----------------
// o portal registra alterações; o vigia grava na planilha e publica a lista (chave "cadastros" do KV)
function planilhaCadastros() {
  try {
    const pasta = path.join(PROJETO, 'CONTROLES');
    const nome = fs.readdirSync(pasta).filter((n) => /\.xlsx$/i.test(n) && !n.startsWith('~$') && !/conflict/i.test(n) && /motorista/i.test(n)).sort()[0];
    return nome ? path.join(pasta, nome) : null;
  } catch { return null; }
}
const CADASTROS_GERADO = path.join(PROJETO, '.dados', 'cadastros.json');

async function publicarCadastros(motivo) {
  const saida = rodar('py', ['scripts/planilha_cadastros.py', 'gerar']).trim().split(/\r?\n/).pop();
  const r = JSON.parse(saida);
  if (r.erro) throw new Error(r.erro);
  try {
    // texto já em JSON: com "; charset" o api() envia como está (sem JSON.stringify de novo)
    await api('PUT', '/api/sync/cadastros', fs.readFileSync(CADASTROS_GERADO, 'utf8'), 'application/json; charset=utf-8');
  } finally {
    try { fs.unlinkSync(CADASTROS_GERADO); } catch {}   // tem as senhas dos cartões: não fica no disco
  }
  const arq = planilhaCadastros();
  if (arq) {
    const st = fs.statSync(arq);
    fs.writeFileSync(ESTADO, JSON.stringify({ ...lerEstado(), mtimeCad: st.mtimeMs, tamanhoCad: st.size }));
  }
  log(`Placas e motoristas publicados (${r.placas} placas, ${r.motoristas} motoristas)${motivo ? ': ' + motivo : ''}.`);
}

const ultimoEstadoCadastro = new Map();
async function processarCadastros() {
  if (!tokenSync()) return;
  const arq = planilhaCadastros();
  if (!arq) return;
  const { pendentes } = await api('GET', '/api/sync/cadastros/pendentes');
  if (pendentes && pendentes.length) {
    const tmp = path.join(PROJETO, '.dados', 'cadastros-pendentes.json');
    fs.writeFileSync(tmp, JSON.stringify(pendentes));
    let r;
    try {
      r = JSON.parse(rodar('py', ['scripts/planilha_cadastros.py', 'gravar', `"${tmp}"`]).trim().split(/\r?\n/).pop());
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
    const mudaram = r.itens.filter((i) => ultimoEstadoCadastro.get(i.id) !== i.estado + '|' + (i.mensagem || ''));
    if (mudaram.length) {
      await api('POST', '/api/sync/cadastros/resultado', { itens: mudaram });
      mudaram.forEach((i) => ultimoEstadoCadastro.set(i.id, i.estado + '|' + (i.mensagem || '')));
    }
    mudaram.filter((i) => i.estado === 'erro').forEach((i) => log(`Alteração ${i.id} de placas/motoristas não gravada: ${i.mensagem}`));
    const gravadas = r.itens.filter((i) => i.estado === 'aplicada');
    if (gravadas.length) {
      log(`${gravadas.length} alteração(ões) de placas/motoristas gravada(s) na planilha (linhas ${gravadas.map((i) => i.linha).join(', ')}).`);
      await publicarCadastros();
      return;
    }
    if (mudaram.some((i) => i.estado === 'aguardando')) log('Alterações de placas/motoristas aguardando: a planilha está aberta no Excel.');
  }
  // planilha editada à mão (ou ainda não publicada): publica quando ela para de mudar
  const st = fs.statSync(arq);
  const e = lerEstado();
  if ((e.mtimeCad !== st.mtimeMs || e.tamanhoCad !== st.size) && (Date.now() - st.mtimeMs) / 1000 >= ESPERA_ESTAVEL) {
    await publicarCadastros('planilha de placas e motoristas alterada');
  }
}

// ---------------- cartões frota (planilha CONTROLES\CONTROLE CARTÕES FROTA.xlsx) ----------------
// mesmo caminho de placas/motoristas: o portal registra a mudança, o vigia grava na planilha (planilha_cartoes.py,
// que mexe só nas células alteradas) e publica a lista de novo (chave "cartoes" do KV)
function planilhaCartoes() {
  try {
    const pasta = path.join(PROJETO, 'CONTROLES');
    const nome = fs.readdirSync(pasta).filter((n) => /\.xlsx$/i.test(n) && !n.startsWith('~$') && !/conflict/i.test(n) && /cart[oõ]es/i.test(n)).sort()[0];
    return nome ? path.join(pasta, nome) : null;
  } catch { return null; }
}
const CARTOES_GERADO = path.join(PROJETO, '.dados', 'cartoes.json');

async function publicarCartoes(motivo) {
  const r = JSON.parse(rodar('py', ['scripts/planilha_cartoes.py', 'gerar']).trim().split(/\r?\n/).pop());
  if (r.erro) throw new Error(r.erro);
  await api('PUT', '/api/sync/cartoes', fs.readFileSync(CARTOES_GERADO, 'utf8'), 'application/json; charset=utf-8');
  const arq = planilhaCartoes();
  if (arq) {
    const st = fs.statSync(arq);
    fs.writeFileSync(ESTADO, JSON.stringify({ ...lerEstado(), mtimeCart: st.mtimeMs, tamanhoCart: st.size }));
  }
  log(`Cartões frota publicados (${r.cartoes} placas)${motivo ? ': ' + motivo : ''}.`);
}

const ultimoEstadoCartao = new Map();
async function processarCartoes() {
  if (!tokenSync()) return;
  const arq = planilhaCartoes();
  if (!arq) return;
  const { pendentes } = await api('GET', '/api/sync/cartoes/pendentes');
  if (pendentes && pendentes.length) {
    const tmp = path.join(PROJETO, '.dados', 'cartoes-pendentes.json');
    fs.writeFileSync(tmp, JSON.stringify(pendentes));
    let r;
    try {
      r = JSON.parse(rodar('py', ['scripts/planilha_cartoes.py', 'gravar', `"${tmp}"`]).trim().split(/\r?\n/).pop());
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
    const mudaram = r.itens.filter((i) => ultimoEstadoCartao.get(i.id) !== i.estado + '|' + (i.mensagem || ''));
    if (mudaram.length) {
      await api('POST', '/api/sync/cartoes/resultado', { itens: mudaram });
      mudaram.forEach((i) => ultimoEstadoCartao.set(i.id, i.estado + '|' + (i.mensagem || '')));
    }
    mudaram.filter((i) => i.estado === 'erro').forEach((i) => log(`Alteração ${i.id} dos cartões frota não gravada: ${i.mensagem}`));
    const gravadas = r.itens.filter((i) => i.estado === 'aplicada');
    if (gravadas.length) {
      log(`${gravadas.length} alteração(ões) dos cartões frota gravada(s) na planilha (linhas ${gravadas.map((i) => i.linha).join(', ')}).`);
      await publicarCartoes();
      return;
    }
    if (mudaram.some((i) => i.estado === 'aguardando')) log('Alterações dos cartões frota aguardando: a planilha está aberta no Excel.');
  }
  // ligação com o cadastro de placas: quando a planilha de placas ou a dos cartões muda (e para de mudar), acerta as
  // placas do controle (entra placa ativa com motor; sai a desabilitada, a sem motor e a que saiu do cadastro)
  if (await sincronizarCartoesComCadastro(arq)) return;
  // planilha editada à mão (ou ainda não publicada): publica quando ela para de mudar
  const st = fs.statSync(arq);
  const e = lerEstado();
  if ((e.mtimeCart !== st.mtimeMs || e.tamanhoCart !== st.size) && (Date.now() - st.mtimeMs) / 1000 >= ESPERA_ESTAVEL) {
    await publicarCartoes('planilha dos cartões frota alterada');
  }
}

let avisoSincCartoes = null, sincCartoesDepois = 0;
async function sincronizarCartoesComCadastro(arqCartoes) {
  const cad = planilhaCadastros();
  if (!cad || Date.now() < sincCartoesDepois) return false;
  const stCad = fs.statSync(cad), stCart = fs.statSync(arqCartoes);
  const assinatura = (a, b) => [a.mtimeMs, a.size, b.mtimeMs, b.size].join('|');
  if (lerEstado().sincCartoes === assinatura(stCad, stCart)) return false;
  if ((Date.now() - Math.max(stCad.mtimeMs, stCart.mtimeMs)) / 1000 < ESPERA_ESTAVEL) return false;   // ainda sendo salva
  const r = JSON.parse(rodar('py', ['scripts/planilha_cartoes.py', 'sincronizar']).trim().split(/\r?\n/).pop());
  if (r.erro || r.aguardando) {
    const msg = r.erro || 'a planilha dos cartões está aberta no Excel; tenta de novo quando ela for fechada';
    if (avisoSincCartoes !== msg) log('Cartões frota x cadastro de placas: ' + msg);
    avisoSincCartoes = msg;
    sincCartoesDepois = Date.now() + (r.erro ? 5 * 60 * 1000 : 30 * 1000);   // erro: tenta de novo em 5 min
    return false;
  }
  avisoSincCartoes = null;
  const mudou = r.adicionadas.length || r.removidas.length;
  if (mudou) {
    log('Cartões frota ligados ao cadastro de placas: ' +
      (r.adicionadas.length ? 'entraram ' + r.adicionadas.join(', ') : 'nenhuma entrou') + '; ' +
      (r.removidas.length ? 'saíram ' + r.removidas.join(', ') : 'nenhuma saiu') + '.');
  }
  fs.writeFileSync(ESTADO, JSON.stringify({ ...lerEstado(), sincCartoes: assinatura(fs.statSync(cad), fs.statSync(arqCartoes)) }));
  if (mudou) await publicarCartoes('ligação com o cadastro de placas');
  return !!mudou;
}

// ---------------- Consolidador de abastecimentos (Operacional > Consolidador) ----------------
// 1) lotes consolidados no site -> acrescenta na CONTROLES\Base_copia.xlsx (planilha_base_copia.py; a Base.xlsx não é tocada)
// 2) Base.xlsx ou Base_copia mudou (e parou de mudar) -> publica o histórico que o site usa no lugar do upload da Base
//    (consolidador_historico.py -> chaves "consolidacao" e "consolidacao-versao" do KV)
function planilhaBaseCopia() {
  try {
    const pasta = path.join(PROJETO, 'CONTROLES');
    const nome = fs.readdirSync(pasta).filter((n) => /\.xlsx$/i.test(n) && !n.startsWith('~$') && !/conflict/i.test(n) && /^base/i.test(n)).sort()[0];
    return nome ? path.join(pasta, nome) : null;
  } catch { return null; }
}
// 15.2 passo 3 (19/11/2026): aplica no banco (Supabase) os pedidos das filas que ficaram sem aplicar (o portal já aplica ao gravar;
// isto cobre banco fora do ar). Roda antes de a planilha ser gravada, uma vez por minuto; o agendador na nuvem assume no passo 4.
let ultimaVarreduraBanco = 0;
async function processarFilasBanco() {
  if (!tokenSync() || Date.now() - ultimaVarreduraBanco < 60_000) return;
  if (await nuvemLigada('varredura-filas')) return;   // passo 4 (23/11/2026): o pg_cron do banco chama a varredura a cada 2 min
  ultimaVarreduraBanco = Date.now();
  const r = await api('POST', '/api/sync/banco/aplicar', {});
  if (r && (r.aplicados || r.erros)) log(`Banco: ${r.aplicados} pedido(s) das filas aplicado(s)${r.erros ? `, ${r.erros} com erro (ver banco_mensagem)` : ''}.`);
}
// Passo 4 (19/11/2026): rotina que já roda na nuvem (Edge Function, public.nuvem_rotinas modo 'ligado') não roda aqui, para as duas
// nunca gravarem ao mesmo tempo. Consulta o banco no máximo 1x por minuto por rotina; sem banco ou com erro, o vigia segue rodando.
const MODOS_NUVEM = new Map();
// chamada a uma função do banco (Supabase) com a chave secreta de %LOCALAPPDATA%GestaoCombustivelsupabase.json; null se falhar
async function rpcBanco(funcao, args, ms = 30_000) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(PASTA, 'supabase.json'), 'utf8').replace(/^\uFEFF/, ''));
    const r = await fetch(c.url + '/rest/v1/rpc/' + funcao, { method: 'POST', signal: AbortSignal.timeout(ms),
      headers: { apikey: c.service_role, Authorization: 'Bearer ' + c.service_role, 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
async function nuvemLigada(nome) {
  const m = MODOS_NUVEM.get(nome);
  if (m && Date.now() - m.em < 60_000) return m.ligada;
  let ligada = false;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(PASTA, 'supabase.json'), 'utf8').replace(/^\uFEFF/, ''));
    const r = await fetch(c.url + '/rest/v1/rpc/gestao_nuvem_modo', { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { apikey: c.service_role, Authorization: 'Bearer ' + c.service_role, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_nome: nome }) });
    if (r.ok) ligada = (await r.json()) === 'ligado';
  } catch { ligada = (m && m.ligada) || false; }
  MODOS_NUVEM.set(nome, { em: Date.now(), ligada });
  return ligada;
}
const CONSOLIDACAO_GERADO = path.join(PROJETO, '.dados', 'consolidacao.json');
const ultimoEstadoLote = new Map();
async function processarConsolidador() {
  if (!tokenSync()) return;
  const copia = planilhaBaseCopia();
  if (copia) {
    const { pendentes } = await api('GET', '/api/sync/consolidador/pendentes');
    if (pendentes && pendentes.length) {
      const tmp = path.join(PROJETO, '.dados', 'consolidador-lotes.json');
      fs.writeFileSync(tmp, JSON.stringify(pendentes.map((l) => ({ id: l.id, linhas: l.linhas }))));
      let r;
      try { r = JSON.parse(rodar('py', ['scripts/planilha_base_copia.py', 'gravar', `"${tmp}"`]).trim().split(/\r?\n/).pop()); }
      finally { try { fs.unlinkSync(tmp); } catch {} }
      const mudaram = r.itens.filter((i) => ultimoEstadoLote.get(i.id) !== i.estado + '|' + (i.mensagem || ''));
      if (mudaram.length) {
        await api('POST', '/api/sync/consolidador/resultado', { itens: mudaram });
        mudaram.forEach((i) => ultimoEstadoLote.set(i.id, i.estado + '|' + (i.mensagem || '')));
      }
      // linhas gravadas: o abastecimento seguinte da mesma placa pode precisar do km recalculado (scripts/km_recalcular.mjs)
      const aplicados = new Set(mudaram.filter((i) => i.estado === 'aplicada').map((i) => i.id));
      if (aplicados.size) {
        // passo 4 (23/11/2026): com 'km-recalcular' ligado na nuvem, o recálculo é feito pelo portal ao aplicar o lote no banco
        if (!(await nuvemLigada('km-recalcular'))) try { (await import('./km_recalcular.mjs')).anotar(pendentes.filter((l) => aplicados.has(l.id)).flatMap((l) => l.linhas)); }
        catch (e) { log('Recálculo do KM: não foi possível anotar o lote (' + String(e.message || e).slice(0, 160) + ').'); }
      }
      for (const i of mudaram) {
        if (i.estado === 'aplicada') log(`Consolidador: lote ${i.id} gravado na Base_copia (${i.gravadas} linha(s)${i.linha_inicial ? ', linhas ' + i.linha_inicial + ' a ' + i.linha_final : ''}${i.ignoradas ? '; ' + i.ignoradas + ' já estavam lá' : ''}).`);
        else if (i.estado === 'erro') log(`Consolidador: lote ${i.id} não gravado: ${i.mensagem}`);
        else log('Consolidador: lote aguardando, a Base_copia está aberta no Excel.');
      }
    }
  }
  // histórico para o site
  let stBase = null, stCopia = null;
  try { stBase = fs.statSync(BASE); } catch { return; }
  try { if (copia) stCopia = fs.statSync(copia); } catch {}
  const assinatura = [stBase.mtimeMs, stBase.size, stCopia ? stCopia.mtimeMs : 0, stCopia ? stCopia.size : 0].join('|');
  if (lerEstado().consolidacao === assinatura) return;
  if ((Date.now() - Math.max(stBase.mtimeMs, stCopia ? stCopia.mtimeMs : 0)) / 1000 < ESPERA_ESTAVEL) return;   // ainda sendo salva
  const r = JSON.parse(rodar('py', ['scripts/consolidador_historico.py']).trim().split(/\r?\n/).pop());
  if (r.erro) throw new Error(r.erro);
  try {
    kvPut('consolidacao', CONSOLIDACAO_GERADO);
    const arq = path.join(PASTA, 'consolidacao-versao.json');
    fs.writeFileSync(arq, JSON.stringify({ versao: r.versao, linhas: r.linhas, enviadoEm: new Date().toISOString() }));
    kvPut('consolidacao-versao', arq);
  } finally {
    // fica uma cópia para a integração das APIs dos cartões (scripts/cartoes_api.mjs monta as linhas com este histórico)
    try { fs.mkdirSync(path.dirname(HISTORICO_APIS), { recursive: true }); fs.renameSync(CONSOLIDACAO_GERADO, HISTORICO_APIS); }
    catch { try { fs.unlinkSync(CONSOLIDACAO_GERADO); } catch {} }
  }
  fs.writeFileSync(ESTADO, JSON.stringify({ ...lerEstado(), consolidacao: assinatura }));
  log(`Histórico do consolidador publicado (${r.linhas} linhas: ${r.fontes.map((f) => f.arquivo + ' ' + f.linhas).join(', ')}).`);
}

// ---------------- Editar abastecimentos (Operacional > Editar abastecimentos) ----------------
// 1) correções salvas no site -> grava nas células da CONTROLES\Base_copia.xlsx (planilha_base_copia.py editar)
// 2) Base_copia mudou (e parou de mudar) -> publica a lista que a página mostra (base_copia_lista.py -> chaves
//    "base-copia" e "base-copia-versao" do KV)
const LISTA_BASE_COPIA = path.join(PROJETO, '.dados', 'base-copia.json');
// APIs dos cartões (Ticket Log e TruckPag; scripts/cartoes_api.mjs): a cada 5 min publica no site as transações que a Base
// ainda não tem (tempo real) e, a partir das 6h, manda o dia anterior para a Base_copia como lote do Consolidador (D-1).
// Só roda neste computador se ele tiver as credenciais (%LOCALAPPDATA%\GestaoCombustivel\apis-cartoes.json).
const HISTORICO_APIS = path.join(PROJETO, '.dados', 'cartoes-api', 'historico.json');
const LISTA_APIS = path.join(PROJETO, '.dados', 'cartoes-api', 'base-copia.json');   // lista da Base_copia para o rateio
let proximaApis = 0;
async function processarApisCartoes(forcar) {
  if ((!forcar && Date.now() < proximaApis) || !tokenSync()) return;
  proximaApis = Date.now() + 5 * 60 * 1000;
  const m = await import('./cartoes_api.mjs');
  if (!m.temConfig()) return;
  // tempo real comparado com o banco (19/11/2026: a Base.xlsx parou de ser a base dos painéis). Com a rotina da nuvem ligada
  // (23/11/2026) só esta parte é pulada: estornos, cadastros nos cartões, Conciliação e Conferência abaixo seguem cada um com o seu interruptor
  if (!(await nuvemLigada('cartoes-api'))) await m.processar({ api, kvPut, log, chavesBanco: (desde) => rpcBanco('gestao_chaves_tempo_real', { p_desde: desde }), gerarHistorico: () => {
    rodar('py', ['scripts/consolidador_historico.py']);
    fs.mkdirSync(path.dirname(HISTORICO_APIS), { recursive: true });
    fs.renameSync(CONSOLIDACAO_GERADO, HISTORICO_APIS);
  } });
  // estornos feitos na TruckPag depois do D-1: exclui da Base_copia (scripts/estornos_truckpag.mjs; a cada 6 horas)
  if (!(await nuvemLigada('estornos-truckpag'))) try { await (await import('./estornos_truckpag.mjs')).processar({ api, log }); }
  catch (e) { log('Estornos TruckPag: ' + String(e.message || e).slice(0, 200)); }
  // cadastro de motoristas x cartões (scripts/motoristas_cartoes.mjs): cria os novos e repete as edições (se ligado), com os
  // dados pessoais digitados no portal, que são apagados depois do envio. O "completar pela Ticket" (CNH etc.) saiu em
  // 12/11/2026: o portal não guarda mais CPF, nascimento nem CNH
  // passo 4 (23/11/2026): com 'cadastros-cartoes' ligado na nuvem, motoristas e placas nos cartões saem de lá
  const cadastrosNaNuvem = await nuvemLigada('cadastros-cartoes');
  if (!cadastrosNaNuvem) try {
    const mc = await import('./motoristas_cartoes.mjs');
    await mc.criarNovos({ api, log });
    await mc.editarTruckpag({ api, log });
  } catch (e) { log('Cadastro x cartões: ' + String(e.message || e).slice(0, 200)); }
  // cadastro de placas x TruckPag (scripts/placas_truckpag.mjs, 16/11/2026): unidade nova da placa vira o centro de custo
  // do veículo na TruckPag (se ligado: "placasUnidade" em motoristas-cartoes.json)
  if (!cadastrosNaNuvem) try { await (await import('./placas_truckpag.mjs')).processar({ api, log }); }
  catch (e) { log('Placas x TruckPag: ' + String(e.message || e).slice(0, 200)); }
  // conciliação de NFs (Fiscal/Financeiro): NFS dos cartões x notas dos postos, a cada 6 horas
  if (!(await nuvemLigada('conciliacao-nfs'))) try { await (await import('./conciliacao_nfs.mjs')).processar({ kvPut, log, forcar }); }
  catch (e) { log('Conciliação de NFs: ' + String(e.message || e).slice(0, 200)); }
  // conferência com os cartões (Operacional): Base_copia x APIs, últimos 45 dias, a cada 3 horas; pedidos de inclusão a cada volta
  if (!(await nuvemLigada('conferencia-cartoes'))) try { await (await import('./conferencia_cartoes.mjs')).processar({ api, kvPut, log, forcar }); }
  catch (e) { log('Conferência com os cartões: ' + String(e.message || e).slice(0, 200)); }
}

const ultimoEstadoEdicao = new Map();
async function processarEdicaoBase() {
  if (!tokenSync()) return;
  const copia = planilhaBaseCopia();
  if (!copia) return;
  // km do abastecimento seguinte aos lotes gravados (usa a lista da Base_copia já publicada com as linhas novas)
  if (!(await nuvemLigada('km-recalcular'))) try { await (await import('./km_recalcular.mjs')).recalcular({ api, log }); }
  catch (e) { log('Recálculo do KM: ' + String(e.message || e).slice(0, 200)); }
  const { pendentes } = await api('GET', '/api/sync/base-copia/pendentes');
  if (pendentes && pendentes.length) {
    const tmp = path.join(PROJETO, '.dados', 'base-copia-edicoes.json');
    fs.writeFileSync(tmp, JSON.stringify(pendentes.map((p) => ({ id: p.id, itens: [{ linha: p.linha, placa: p.placa, data: p.data, acao: p.acao || 'editar', celulas: p.celulas, tanque: p.tanque || null }] }))));
    let r;
    try { r = JSON.parse(rodar('py', ['scripts/planilha_base_copia.py', 'editar', `"${tmp}"`]).trim().split(/\r?\n/).pop()); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
    const mudaram = r.itens.filter((i) => ultimoEstadoEdicao.get(i.id) !== i.estado + '|' + (i.mensagem || ''));
    if (mudaram.length) {
      await api('POST', '/api/sync/base-copia/resultado', { itens: mudaram });
      mudaram.forEach((i) => ultimoEstadoEdicao.set(i.id, i.estado + '|' + (i.mensagem || '')));
    }
    const ok = mudaram.filter((i) => i.estado === 'aplicada').length;
    const excl = new Set(pendentes.filter((p) => p.acao === 'excluir').map((p) => p.id));
    const okExcl = mudaram.filter((i) => i.estado === 'aplicada' && excl.has(i.id)).length;
    if (ok - okExcl) log(`Editar abastecimentos: ${ok - okExcl} correção(ões) gravada(s) na Base_copia.`);
    if (okExcl) log(`Editar abastecimentos: ${okExcl} abastecimento(s) excluído(s) da Base_copia (linha apagada).`);
    mudaram.filter((i) => i.estado === 'erro').forEach((i) => log(`Editar abastecimentos: correção ${i.id} não gravada: ${i.mensagem}`));
    if (mudaram.some((i) => i.estado === 'aguardando')) log('Editar abastecimentos: correções aguardando, a Base_copia está aberta no Excel.');
  }
  // lista para o site
  let st;
  try { st = fs.statSync(copia); } catch { return; }
  const assinatura = [st.mtimeMs, st.size].join('|');
  if (lerEstado().listaBaseCopia === assinatura) return;
  if ((Date.now() - st.mtimeMs) / 1000 < ESPERA_ESTAVEL) return;   // ainda sendo salva
  const g = JSON.parse(rodar('py', ['scripts/base_copia_lista.py']).trim().split(/\r?\n/).pop());
  if (g.erro) throw new Error(g.erro);
  try {
    kvPut('base-copia', LISTA_BASE_COPIA);
    const arq = path.join(PASTA, 'base-copia-versao.json');
    fs.writeFileSync(arq, JSON.stringify({ versao: g.versao, linhas: g.linhas, enviadoEm: new Date().toISOString() }));
    kvPut('base-copia-versao', arq);
  } finally {
    // fica uma cópia para o Rateio das NFs (scripts/cartoes_api.mjs aplica o preço das notas às linhas da Base_copia)
    try { fs.mkdirSync(path.dirname(LISTA_APIS), { recursive: true }); fs.renameSync(LISTA_BASE_COPIA, LISTA_APIS); }
    catch { try { fs.unlinkSync(LISTA_BASE_COPIA); } catch {} }
  }
  fs.writeFileSync(ESTADO, JSON.stringify({ ...lerEstado(), listaBaseCopia: assinatura }));
  log(`Lista da Base_copia publicada (${g.linhas} abastecimentos) para a página Editar abastecimentos.`);
}

// ---------------- preços da ANP (dashboard "Preço x ANP") ----------------
// Confere a ANP de hora em hora (scripts/anp_precos.py só baixa o que mudou no gov.br) e, quando sai semana ou mês
// novo, envia para o KV: chave "anp" (dados) e "anp-versao" (versão, para o navegador saber que mudou).
const ANP_GERADO = path.join(PROJETO, '.dados', 'anp', 'anp.json');
const INTERVALO_ANP = 60 * 60 * 1000;
let proximaANP = 0;
function processarANP(forcar = false) {
  if (!forcar && Date.now() < proximaANP) return;
  proximaANP = Date.now() + INTERVALO_ANP;
  const r = JSON.parse(rodar('py', ['scripts/anp_precos.py', 'atualizar']).trim().split(/\r?\n/).pop());
  if (r.erro) throw new Error(r.erro);
  if (!r.mudou && !forcar) return;
  kvPut('anp', ANP_GERADO);
  const arq = path.join(PASTA, 'anp-versao.json');
  fs.writeFileSync(arq, JSON.stringify({ versao: r.versao, ultimaSemana: r.ultimaSemana, ultimoMes: r.ultimoMes, enviadoEm: new Date().toISOString() }));
  kvPut('anp-versao', arq);
  log(`Preços da ANP enviados: semana até ${r.ultimaSemana}, mês até ${r.ultimoMes}` + (r.baixados.length ? ` (baixados: ${r.baixados.join(', ')})` : '') + '.');
}

// ---------------- Preço bomba interna (Operacional): negociações e fornecedores lançados no site ----------------
// Grava na CONTROLES\Negociação bomba interna.xlsx (scripts/planilha_bomba.py gravar) e, de hora em hora, repete o
// preço do Arla dos fornecedores ativos até hoje (planilha_bomba.py arla). A planilha muda e o verificar() reenvia a Base.
const ultimoEstadoBomba = new Map();
let proximaArla = 0;
async function processarBomba() {
  if (!fs.existsSync(BOMBA)) return;
  if (tokenSync()) {
    const { pendentes } = await api('GET', '/api/sync/bomba-interna/pendentes');
    if (pendentes && pendentes.length) {
      const tmp = path.join(PROJETO, '.dados', 'bomba-pendentes.json');
      fs.writeFileSync(tmp, JSON.stringify(pendentes));
      let r;
      try { r = JSON.parse(rodar('py', ['scripts/planilha_bomba.py', 'gravar', `"${tmp}"`]).trim().split(/\r?\n/).pop()); }
      finally { try { fs.unlinkSync(tmp); } catch {} }
      const mudaram = r.itens.filter((i) => ultimoEstadoBomba.get(i.id) !== i.estado + '|' + (i.mensagem || ''));
      if (mudaram.length) {
        await api('POST', '/api/sync/bomba-interna/resultado', { itens: mudaram });
        mudaram.forEach((i) => ultimoEstadoBomba.set(i.id, i.estado + '|' + (i.mensagem || '')));
        const ok = mudaram.filter((i) => i.estado === 'aplicada').length;
        if (ok) log(`Preço bomba interna: ${ok} lançamento(s) do site gravado(s) na planilha de negociações.`);
        mudaram.filter((i) => i.estado === 'erro').forEach((i) => log(`Preço bomba interna: lançamento ${i.id} não gravado: ${i.mensagem}`));
        if (mudaram.some((i) => i.estado === 'aguardando')) log('Preço bomba interna: aguardando, a planilha de negociações está aberta no Excel.');
      }
    }
  }
  if (Date.now() < proximaArla) return;
  const a = JSON.parse(rodar('py', ['scripts/planilha_bomba.py', 'arla']).trim().split(/\r?\n/).pop());
  if (a.erro) throw new Error(a.erro);
  if (a.aguardando) { proximaArla = Date.now() + 5 * 60 * 1000; return; }   // planilha aberta: tenta em 5 min
  proximaArla = Date.now() + 60 * 60 * 1000;
  if (a.novas && a.novas.length) {
    log(`Preço bomba interna: Arla repetido em ${a.novas.length} linha(s) (último preço de cada fornecedor ativo até hoje)` +
      (a.criouFornecedores ? '; aba Fornecedores criada a partir do histórico' : '') + '.');
  }
}

// ---------------- coordenadas de postos (Mapa de calor > Postos sem coordenadas) ----------------
// Grava na LOCALIZAÇÃO DOS POSTOS (scripts/planilha_locais.py). A planilha muda e o verificar() reenvia a Base, com o
// posto já no mapa.
const ultimoEstadoLocal = new Map();
async function processarLocais() {
  if (!tokenSync()) return;
  const { pendentes } = await api('GET', '/api/sync/locais/pendentes');
  if (!pendentes || !pendentes.length) return;
  const tmp = path.join(PROJETO, '.dados', 'locais-pendentes.json');
  fs.writeFileSync(tmp, JSON.stringify(pendentes));
  let r;
  try { r = JSON.parse(rodar('py', ['scripts/planilha_locais.py', 'gravar', `"${tmp}"`]).trim().split(/\r?\n/).pop()); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
  const mudaram = r.itens.filter((i) => ultimoEstadoLocal.get(i.id) !== i.estado + '|' + (i.mensagem || ''));
  if (!mudaram.length) return;
  await api('POST', '/api/sync/locais/resultado', { itens: mudaram });
  mudaram.forEach((i) => ultimoEstadoLocal.set(i.id, i.estado + '|' + (i.mensagem || '')));
  const ok = mudaram.filter((i) => i.estado === 'aplicada');
  if (ok.length) log(`Coordenadas de ${ok.length} posto(s) gravadas na LOCALIZAÇÃO DOS POSTOS (linhas ${ok.map((i) => i.linha).join(', ')}).`);
  mudaram.filter((i) => i.estado === 'erro').forEach((i) => log(`Coordenada ${i.id} não gravada: ${i.mensagem}`));
  if (mudaram.some((i) => i.estado === 'aguardando')) log('Coordenadas aguardando: a LOCALIZAÇÃO DOS POSTOS está aberta no Excel.');
}

// busca automática de coordenadas pelo OpenStreetMap (scripts/geocodificar_postos.py): 15 postos a cada 15 min enquanto
// houver fila (depois, de hora em hora, para os postos novos); só grava na LOCALIZAÇÃO quando o nome bate com segurança
let proximaGeo = 0;
async function processarGeocodificacao(forcar = false) {
  if (!forcar && Date.now() < proximaGeo) return;
  proximaGeo = Date.now() + INTERVALO_ANP;
  const r = JSON.parse(rodar('py', ['scripts/geocodificar_postos.py', 'rodar']).trim().split(/\r?\n/).pop());
  if (r.erro) throw new Error(r.erro);
  if (r.naFila > 0 && !r.aviso) proximaGeo = Date.now() + 15 * 60 * 1000;
  if (r.gravados && r.gravados.length) {
    log(`Coordenadas encontradas no OpenStreetMap e gravadas na LOCALIZAÇÃO: ${r.gravados.map((g) => g.nome + ' (linha ' + g.linha + ', "' + g.mapa + '")').join('; ')}.`);
    // 15.3 (25/11/2026): também no banco (depois da virada a planilha não é mais recopiada)
    try {
      const b = await api('POST', '/api/sync/locais/banco', { itens: r.gravados.map(({ nome, cidade, uf, lat, lon }) => ({ nome, cidade, uf, lat, lon })) });
      if (b && b.erros) log(`Coordenadas do OpenStreetMap no banco: ${b.gravados} gravada(s), ${b.erros} com erro.`);
    } catch (e) { log('Coordenadas do OpenStreetMap: não foi possível gravar no banco (' + String(e.message || e).slice(0, 160) + ').'); }
  }
}

// ---------------- preços da Petrobras às distribuidoras (dashboard "Preço x Refinaria") ----------------
// Confere o portal precos.petrobras.com.br de hora em hora (scripts/petrobras_precos.py só baixa o PDF quando o portal
// aponta para uma tabela nova) e envia para o KV: chave "petrobras" (histórico por ponto de entrega) e "petrobras-versao".
const PETROBRAS_GERADO = path.join(PROJETO, '.dados', 'petrobras', 'petrobras.json');
let proximaPetrobras = 0;
function processarPetrobras(forcar = false) {
  if (!forcar && Date.now() < proximaPetrobras) return;
  proximaPetrobras = Date.now() + INTERVALO_ANP;
  const r = JSON.parse(rodar('py', ['scripts/petrobras_precos.py', 'atualizar', ...(forcar ? ['--forcar'] : [])]).trim().split(/\r?\n/).pop());
  if (r.erro) throw new Error(r.erro);
  if (!r.mudou) return;
  kvPut('petrobras', PETROBRAS_GERADO);
  const arq = path.join(PASTA, 'petrobras-versao.json');
  fs.writeFileSync(arq, JSON.stringify({ versao: r.versao, titulo: r.titulo, ultimaVigencia: r.ultimaVigencia, enviadoEm: new Date().toISOString() }));
  kvPut('petrobras-versao', arq);
  log(`Preços da Petrobras enviados: ${r.titulo} (${r.pontos} pontos de entrega, ${r.vigencias} vigências, última ${r.ultimaVigencia})` +
    (r.semCoordenadas && r.semCoordenadas.length ? `; sem coordenadas: ${r.semCoordenadas.join(', ')}` : '') + '.');
}

// ---------------- reajustes dos contratos com o cliente (dashboard "Contratos x ANP") ----------------
// Pasta "Reajustes SGB" (só leitura): vale o arquivo com a data mais nova no nome. Quando entra arquivo novo ou o
// mais recente é salvo (e para de mudar por 20 s), scripts/reajustes.py relê e o vigia envia (chave "reajustes").
const PASTA_REAJUSTES = path.join(path.dirname(path.dirname(PROJETO)), 'Reajustes SGB');
const REAJUSTES_GERADO = path.join(PROJETO, '.dados', 'reajustes.json');
function assinaturaReajustes() {
  try {
    const arqs = fs.readdirSync(PASTA_REAJUSTES).filter((n) => /\.xlsx$/i.test(n) && !n.startsWith('~$'));
    let mais = 0;
    const partes = arqs.sort().map((n) => { const st = fs.statSync(path.join(PASTA_REAJUSTES, n)); mais = Math.max(mais, st.mtimeMs); return n + ':' + st.size + ':' + st.mtimeMs; });
    return { assinatura: partes.join('|'), mtime: mais };
  } catch { return null; }
}
function processarReajustes(forcar = false) {
  const a = assinaturaReajustes();
  if (!a) return;
  const e = lerEstado();
  if (!forcar && e.reajustes === a.assinatura) return;
  if (!forcar && (Date.now() - a.mtime) / 1000 < ESPERA_ESTAVEL) return;   // ainda sendo salvo
  const r = JSON.parse(rodar('py', ['scripts/reajustes.py']).trim().split(/\r?\n/).pop());
  if (r.erro) throw new Error(r.erro);
  kvPut('reajustes', REAJUSTES_GERADO);
  const arq = path.join(PASTA, 'reajustes-versao.json');
  fs.writeFileSync(arq, JSON.stringify({ versao: r.versao, arquivo: r.arquivo, enviadoEm: new Date().toISOString() }));
  kvPut('reajustes-versao', arq);
  fs.writeFileSync(ESTADO, JSON.stringify({ ...lerEstado(), reajustes: a.assinatura }));
  log(`Reajustes enviados: ${r.arquivo} (${r.contratos} contratos)` + (r.avisos.length ? `; avisos: ${r.avisos.join(' ')}` : '') + '.');
}

// ---------------- revezamento entre computadores (principal e reserva) ----------------
// Só um vigia trabalha por vez. Cada computador tem uma prioridade em %LOCALAPPDATA%\GestaoCombustivel\vigia.json
// ({"prioridade": 1} = principal; 2 = reserva). O site (/api/sync/plantao) diz quem está de plantão: o principal
// sempre que estiver ligado; o reserva só quando o principal para de dar sinal, e devolve quando ele volta.
const CONFIG_VIGIA = path.join(PASTA, 'vigia.json');
function configVigia() {
  try { const c = JSON.parse(fs.readFileSync(CONFIG_VIGIA, 'utf8')); return { prioridade: Number(c.prioridade) || 1, maquina: c.nome || os.hostname() }; }
  catch { return { prioridade: 1, maquina: os.hostname() }; }
}
const RENOVAR = 50 * 1000;      // de plantão: confirma com o site no máximo a cada 50 s
const ESPERA_RESERVA = 30 * 1000; // em espera: pergunta a cada 30 s se precisa assumir
let ultimoPlantao = { ativo: false, em: 0, de: null };
async function plantao() {
  if (!tokenSync()) return true;   // sem token, não há com quem combinar: trabalha como antes
  const agora = Date.now();
  if (ultimoPlantao.ativo && agora - ultimoPlantao.em < RENOVAR) return true;
  if (!ultimoPlantao.ativo && agora - ultimoPlantao.em < ESPERA_RESERVA) return false;
  const c = configVigia();
  let r;
  try { r = await api('POST', '/api/sync/plantao', { maquina: c.maquina, prioridade: c.prioridade }); }
  catch (e) {
    if (ultimoPlantao.erro !== true) log('Sem contato com o site para combinar o plantão; fica em espera: ' + String(e.message || e).slice(0, 160));
    ultimoPlantao = { ativo: false, em: agora, de: ultimoPlantao.de, erro: true };
    return false;
  }
  if (r.ativo !== ultimoPlantao.ativo || r.plantao !== ultimoPlantao.de) {
    log(r.ativo ? `Plantão: este computador (${c.maquina}, prioridade ${c.prioridade}) assumiu a sincronização.`
      : `Plantão: em espera; quem sincroniza agora é ${r.plantao || 'ninguém (assume na próxima conferência)'}.`);
  }
  ultimoPlantao = { ativo: !!r.ativo, em: agora, de: r.plantao };
  return !!r.ativo;
}

// Supabase (banco de dados novo, 12/11/2026): planilha que mudou é recarregada na tabela dela (scripts/supabase_sync.py).
// Roda em segundo plano (a Base_copia leva ~1 min) para não atrasar o resto da volta; uma de cada vez, no máximo a cada 60 s.
// Sem %LOCALAPPDATA%\GestaoCombustivel\supabase.json (ex.: computador reserva sem credencial) o script só responde "pulado".
// Banco da Cloudflare (D1) -> Supabase (scripts/supabase_d1.py): a cada 5 min, só as tabelas que mudaram.
const SUPABASE = {
  planilhas: { script: 'scripts/supabase_sync.py', intervalo: 60 * 1000, rodando: false, proximo: 0, ultimoErro: '' },
  d1: { script: 'scripts/supabase_d1.py', intervalo: 5 * 60 * 1000, rodando: false, proximo: 0, ultimoErro: '' },
};
function rodarSupabase(s, rotulo) {
  if (s.rodando || Date.now() < s.proximo) return;
  s.rodando = true;
  s.proximo = Date.now() + s.intervalo;
  let out = '';
  const p = spawn('py', [s.script, 'sincronizar'], { cwd: PROJETO, windowsHide: true, shell: process.platform === 'win32',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const fim = setTimeout(() => { try { p.kill(); } catch {} }, 15 * 60 * 1000);
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', () => {
    clearTimeout(fim);
    s.rodando = false;
    let r = null;
    try { r = JSON.parse(out.trim().split(/\r?\n/).pop()); } catch {}
    if (!r) { const m = 'Supabase (' + rotulo + '): falhou (' + out.trim().slice(-200) + ')'; if (m !== s.ultimoErro) log(m); s.ultimoErro = m; return; }
    if (r.tabelas && r.tabelas.length) {
      log('Supabase (' + rotulo + '): ' + r.tabelas.map((t) => t.tabela + ' (' + t.linhas + ' linhas)').join(', ') + ' atualizada(s).');
      // tabelas que só registram o revezamento do vigia não mudam o modelo
      if (r.tabelas.some((t) => !['vigias', 'plantao'].includes(t.tabela))) MODELO.pendente = true;
    }
    const m = (r.erros || []).map((e) => e.tabela + ': ' + e.erro).join('; ');
    if (m && m !== s.ultimoErro) log('Supabase (' + rotulo + '): erro em ' + m);
    s.ultimoErro = m;
  });
  p.on('error', () => { clearTimeout(fim); s.rodando = false; });
}
// Modelo relacional `gestao` (17/11/2026): depois que o espelho (planilhas ou D1) muda, o vigia recarrega o modelo
// (scripts/gestao_carga.py carregar, ~4 min) em segundo plano, um de cada vez e no máximo a cada 5 min (usuário, 17/11). É de onde o site
// passa a ler (cadastro de placas primeiro); sem ele o site continua com a lista publicada pela planilha.
const MODELO = { pendente: true, rodando: false, proximo: 0, intervalo: 5 * 60 * 1000, ultimoErro: '' };
function rodarModelo() {
  if (!MODELO.pendente || MODELO.rodando || Date.now() < MODELO.proximo) return;
  if (SUPABASE.planilhas.rodando || SUPABASE.d1.rodando) return;   // espera o espelho terminar de gravar
  MODELO.rodando = true;
  MODELO.pendente = false;
  MODELO.proximo = Date.now() + MODELO.intervalo;
  let out = '';
  const p = spawn('py', ['scripts/gestao_carga.py', 'carregar', '--json'], { cwd: PROJETO, windowsHide: true, shell: process.platform === 'win32',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const fim = setTimeout(() => { try { p.kill(); } catch {} }, 20 * 60 * 1000);
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', () => {
    clearTimeout(fim);
    MODELO.rodando = false;
    let r = null;
    try { r = JSON.parse(out.trim().split(/\r?\n/).pop()); } catch {}
    if (!r || !r.ok) {
      MODELO.pendente = true;   // tenta de novo na próxima janela
      const m = 'Modelo do banco: falhou (' + (r && r.erro ? r.erro : out.trim().slice(-200)) + ')';
      if (m !== MODELO.ultimoErro) log(m);
      MODELO.ultimoErro = m;
      return;
    }
    MODELO.ultimoErro = '';
    log('Modelo do banco recarregado: ' + r.abastecimentos + ' abastecimentos' + (r.diferencas ? ', ATENÇÃO: ' + r.diferencas + ' total(is) diferente(s) do espelho' : ', totais iguais ao espelho') + '.');
  });
  p.on('error', () => { clearTimeout(fim); MODELO.rodando = false; MODELO.pendente = true; });
}
// Virada de 19/11/2026: base_transacoes deixou de ser recopiada da planilha (o portal grava direto no banco). A Base_copia segue
// recebendo os mesmos pedidos, então a mudança dela ainda serve de sinal para recarregar o modelo.
let mtimeBaseCopia = 0;
function baseCopiaMudou() {
  try { const m = fs.statSync(planilhaBaseCopia()).mtimeMs; if (m !== mtimeBaseCopia) { const antes = mtimeBaseCopia; mtimeBaseCopia = m; return antes !== 0; } } catch {}
  return false;
}
// Comparação diária banco x planilha (15.2 passo 3, item 2; teste até 01/12/2026): uma vez por dia, a partir das 7h.
const COMPARACAO = { dia: '', rodando: false };
function rodarComparacao() {
  const agora = new Date(), dia = agora.toISOString().slice(0, 10);
  if (COMPARACAO.rodando || COMPARACAO.dia === dia || agora.getHours() < 7) return;
  COMPARACAO.rodando = true;
  let out = '';
  const p = spawn('py', ['scripts/comparar_base.py'], { cwd: PROJETO, windowsHide: true, shell: process.platform === 'win32',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const fim = setTimeout(() => { try { p.kill(); } catch {} }, 15 * 60 * 1000);
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', () => {
    clearTimeout(fim);
    COMPARACAO.rodando = false;
    let r = null;
    try { r = JSON.parse(out.trim().split(/\r?\n/).pop()); } catch {}
    if (!r) { log('Comparação banco x planilha: falhou (' + out.trim().slice(-200) + ')'); return; }
    COMPARACAO.dia = dia;
    log(r.igual ? `Comparação banco x planilha: iguais (${r.banco} abastecimentos).`
      : `Comparação banco x planilha: ATENÇÃO, ${r.so_na_planilha} só na planilha, ${r.so_no_banco} só no banco, ${r.diferentes} diferente(s) (${r.relatorio}).`);
    compararCadastros();
  });
  p.on('error', () => { clearTimeout(fim); COMPARACAO.rodando = false; });
}
// 15.3 (virada de placas, motoristas e cartões frota em 25/11/2026): mesma conferência diária para as planilhas de cadastro
function compararCadastros() {
  let out = '';
  const p = spawn('py', ['scripts/comparar_cadastros.py'], { cwd: PROJETO, windowsHide: true, shell: process.platform === 'win32',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const fim = setTimeout(() => { try { p.kill(); } catch {} }, 10 * 60 * 1000);
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', () => {
    clearTimeout(fim);
    let r = null;
    try { r = JSON.parse(out.trim().split(/\r?\n/).pop()); } catch {}
    if (!r) { log('Comparação dos cadastros banco x planilha: falhou (' + out.trim().slice(-200) + ')'); return; }
    log(r.igual ? `Comparação dos cadastros banco x planilha: iguais (${r.placas} placas, ${r.motoristas} motoristas, ${r.cartoes} cartões, ${r.precosBomba} preços da bomba, ${r.postos} postos, ${r.negociacoes} negociações, ${r.localizacao} coordenadas).`
      : `Comparação dos cadastros banco x planilha: ATENÇÃO, ${r.diferencas} diferença(s) (${r.relatorio}).`);
  });
  p.on('error', () => clearTimeout(fim));
}
function processarSupabase() {
  rodarSupabase(SUPABASE.planilhas, 'planilhas');
  rodarSupabase(SUPABASE.d1, 'banco da Cloudflare');
  if (baseCopiaMudou()) MODELO.pendente = true;
  rodarModelo();
  if (!SUPABASE.planilhas.rodando && !MODELO.rodando) rodarComparacao();
}

// --vigiar: fica rodando e confere a cada 10 s (a tarefa agendada inicia no logon e religa se cair)
if (process.argv.includes('--vigiar')) {
  const c = configVigia();
  log(`Vigia iniciado em ${c.maquina} (prioridade ${c.prioridade}: ${c.prioridade === 1 ? 'principal' : 'reserva'}); confere a cada ${INTERVALO_VIGIA} s.`);
  const erro = (onde, e) => log('ERRO ' + onde + ': ' + String(e.message || e).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 300));
  const volta = async () => {
    // cada etapa só roda se este computador continua de plantão (o principal pode ter voltado no meio)
    if (await plantao()) {
      try { await processarPostos(); } catch (e) { erro('nos postos', e); }
      if (await plantao()) { try { await processarCadastros(); } catch (e) { erro('em placas/motoristas', e); } }
      if (await plantao()) { try { await processarCartoes(); } catch (e) { erro('nos cartões frota', e); } }
      if (await plantao()) { try { await processarFilasBanco(); } catch (e) { erro('nas filas do banco', e); } }
      if (await plantao()) { try { await processarConsolidador(); } catch (e) { erro('no consolidador', e); } }
      if (await plantao()) { try { await processarEdicaoBase(); } catch (e) { erro('em editar abastecimentos', e); } }
      if (await plantao()) { try { await processarApisCartoes(); } catch (e) { erro('nas APIs dos cartões', e); } }
      // 15.3 (25/11/2026): com 'precos-anp' ligado, o GitHub Actions baixa e publica a ANP e a Petrobras; o vigia pula
      const precosNaNuvem = await nuvemLigada('precos-anp');
      if (!precosNaNuvem && await plantao()) { try { processarANP(); } catch (e) { erro('nos preços da ANP', e); } }
      if (!precosNaNuvem && await plantao()) { try { processarPetrobras(); } catch (e) { erro('nos preços da Petrobras', e); } }
      if (await plantao()) { try { processarReajustes(); } catch (e) { erro('nos reajustes', e); } }
      if (await plantao()) { try { await processarBomba(); } catch (e) { erro('no preço da bomba interna', e); } }
      if (await plantao()) { try { await processarLocais(); } catch (e) { erro('nas coordenadas dos postos', e); } }
      // 15.3 (25/11/2026): com 'geo-postos' ligado, a busca no OpenStreetMap roda na nuvem; o vigia pula
      if (!(await nuvemLigada('geo-postos')) && await plantao()) { try { await processarGeocodificacao(); } catch (e) { erro('na busca de coordenadas (OpenStreetMap)', e); } }
      if (await plantao()) { try { verificar(false); } catch (e) { erro('na vigia', e); } }
      if (await plantao()) { try { processarSupabase(); } catch (e) { erro('no Supabase', e); } }
    }
    setTimeout(volta, INTERVALO_VIGIA * 1000);
  };
  volta();
} else if (process.argv.includes('--reajustes')) {
  try { processarReajustes(true); } catch (e) { log('ERRO nos reajustes: ' + e.message); process.exitCode = 1; }
} else if (process.argv.includes('--bomba')) {
  processarBomba().catch((e) => { log('ERRO no preço da bomba interna: ' + e.message); process.exitCode = 1; });
} else if (process.argv.includes('--geocodificar')) {
  processarGeocodificacao(true).catch((e) => { log('ERRO na busca de coordenadas: ' + e.message); process.exitCode = 1; });
} else if (process.argv.includes('--locais')) {
  processarLocais().catch((e) => { log('ERRO nas coordenadas dos postos: ' + e.message); process.exitCode = 1; });
} else if (process.argv.includes('--petrobras')) {
  try { processarPetrobras(true); } catch (e) { log('ERRO nos preços da Petrobras: ' + e.message); process.exitCode = 1; }
} else if (process.argv.includes('--anp')) {
  try { processarANP(true); } catch (e) { log('ERRO nos preços da ANP: ' + e.message); process.exitCode = 1; }
} else if (process.argv.includes('--editar-base')) {
  processarEdicaoBase().catch((e) => { log('ERRO em editar abastecimentos: ' + e.message); process.exitCode = 1; });
} else if (process.argv.includes('--apis')) {
  processarApisCartoes(true).catch((e) => { log('ERRO nas APIs dos cartões: ' + e.message); process.exitCode = 1; });
} else if (process.argv.includes('--consolidador')) {
  processarConsolidador().catch((e) => { log('ERRO no consolidador: ' + e.message); process.exitCode = 1; });
} else if (process.argv.includes('--cartoes')) {
  processarCartoes().then(() => publicarCartoes('manual')).catch((e) => { log('ERRO nos cartões frota: ' + e.message); process.exitCode = 1; });
} else if (process.argv.includes('--cadastros')) {
  processarCadastros().then(() => publicarCadastros('manual')).catch((e) => { log('ERRO em placas/motoristas: ' + e.message); process.exitCode = 1; });
} else if (process.argv.includes('--postos')) {
  processarPostos().then(() => publicarPostos('manual')).catch((e) => { log('ERRO nos postos: ' + e.message); process.exitCode = 1; });
} else {
  process.exitCode = verificar(process.argv.includes('--forcar'));
}
