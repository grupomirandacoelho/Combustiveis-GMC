// Consolidador de abastecimentos: núcleo copiado do "Consolidador de Abastecimentos.html" (pasta Alimentação base),
// IIFE CORE, sem mudança de regra. Diferenças só de encaixe no site:
//  - carregarBase recebe as linhas da aba Transações já remontadas a partir do histórico que o vigia publica
//    (Base.xlsx + CONTROLES\Base_copia.xlsx, scripts/consolidador_historico.py), em vez do arquivo da Base;
//  - postos marcados "deixar em branco" ficam gravados no banco e são comparados sem acento/maiúsculas (normKey);
//  - a planilha final não é gerada aqui: as linhas (buildRow, 48 colunas) vão para o vigia gravar na Base_copia.
// Os leitores dos arquivos das plataformas usam o SheetJS (global XLSX), que a página carrega do cdnjs.
/* global XLSX */

const FUEL_MAP = {
  "diesel s10": "DIESEL S-10 COMUM",
  "diesel s-10": "DIESEL S-10 COMUM",
  "diesel s-10 comum": "DIESEL S-10 COMUM",
  // "diesel" puro fundido em DIESEL S-10 COMUM: confirmado com o historico real (ex:
  // JQF6681) que varios veiculos alternam entre os dois rotulos no MESMO hodometro
  // continuo, sem quebra - e' o mesmo tanque, so o sistema de origem que muda o nome.
  "diesel": "DIESEL S-10 COMUM",
  "arla 32": "Arla 32",
  "arla32": "Arla 32",
  "gasolina comum": "GASOLINA COMUM",
  "gasolina aditivada": "GASOLINA ADITIVADA",
  "etanol": "ETANOL",
  "oleo diesel b s10 adit petrobras grid": "DIESEL S-10 COMUM",
  "diesel s-10 aditivado": "DIESEL S-10 COMUM",
  "diesel s10 aditivado": "DIESEL S-10 COMUM",
};

const VEHICLE_FIELDS = ["CODIGO CLIENTE","NOME REDUZIDO","TIPO FROTA","MODELO VEICULO","NUMERO FROTA",
  "ANO","SERVICO","INFORMACAO ADIDIONAL 1","INFORMACAO ADIDIONAL 2","INFORMACAO ADIDIONAL 3",
  "INFORMACAO ADIDIONAL 4","INFORMACAO ADIDIONAL 5","FORMA TRANSACAO",
  "CODIGO LIBERACAO RESTRICAO","SERIE POS","NUMERO CARTAO","FAMILIA VEICULO",
  "GRUPO RESTRICAO","CODIGO EMISSORA","RESPONSAVEL"];
const POSTO_FIELDS = ["CODIGO ESTABELECIMENTO","TIPO ESTABELECIMENTO","ENDERECO","BAIRRO","CIDADE","UF"];

function parseBrNumber(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return s;
  s = String(s).trim();
  if (s === "" || s.toUpperCase() === "N/A") return null;
  const neg = s.startsWith("-");
  let s2 = s.replace(/^[+-]/, "").trim();
  let num;
  if (s2.includes(",")) {
    const idx = s2.lastIndexOf(",");
    let intPart = s2.slice(0, idx);
    const decPart = s2.slice(idx + 1);
    intPart = intPart.replace(/\./g, "").replace(/,/g, "");
    num = parseFloat(intPart + "." + decPart);
  } else {
    num = parseFloat(s2);
  }
  if (Number.isNaN(num)) return null;
  return neg ? -num : num;
}

function excelSerialToDate(serial) {
  const utcDays = Math.floor(serial - 25569);
  const utcValue = utcDays * 86400;
  const dateInfo = new Date(utcValue * 1000);
  const fractionalDay = serial - Math.floor(serial) + 0.0000001;
  let totalSeconds = Math.floor(86400 * fractionalDay);
  const seconds = totalSeconds % 60;
  totalSeconds -= seconds;
  const hours = Math.floor(totalSeconds / (60 * 60));
  const minutes = Math.floor(totalSeconds / 60) % 60;
  return new Date(Date.UTC(dateInfo.getUTCFullYear(), dateInfo.getUTCMonth(), dateInfo.getUTCDate(), hours, minutes, seconds));
}

// Inverso de excelSerialToDate — recebe um Date "relogio ingenuo" (armazenado via
// Date.UTC, sem fuso real) e devolve o serial Excel correspondente. Necessario porque
// o SheetJS "community" (o que roda no navegador via CDN), ao gravar um objeto Date
// direto numa celula com cellDates:true, aplica sua PROPRIA conversao serial<->Date
// internamente na hora de escrever o .xlsx real — e essa conversao interna erra por
// ~3h0m28s (bug ja diagnosticado no lado da leitura; aqui e o mesmo problema no lado
// da escrita). Gravando o serial numerico direto, com t:"n" + formato de data, a
// gente nunca deixa o SheetJS reinterpretar a data - exatamente como ja era feito
// pra DATA REF (coluna sempre numerica, nunca um objeto Date).
function dateToSerial(date) {
  const epochDay = Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86400000);
  const serialDay = epochDay + 25569;
  const fractionalDay = (date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds()) / 86400;
  return serialDay + fractionalDay;
}

function parseBrDate(s) {
  if (s instanceof Date) return s;
  if (typeof s === "number") return excelSerialToDate(s);
  s = String(s).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (m) {
    const p = m.slice(1).map(Number);
    return new Date(Date.UTC(p[2], p[1] - 1, p[0], p[3], p[4], p[5]));
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const p = m.slice(1).map(Number);
    return new Date(Date.UTC(p[2], p[1] - 1, p[0], p[3], p[4], 0));
  }
  throw new Error("Data nao reconhecida: " + s);
}

function isoNoMs(dt) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}T${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`;
}

function normFuel(raw) {
  if (raw === null || raw === undefined) return [null, false];
  const key = String(raw).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(FUEL_MAP, key)) return [FUEL_MAP[key], true];
  return [String(raw).trim().toUpperCase(), false];
}

// chave da cadeia de hodômetro (KM rodado) por combustível: todo tipo de diesel (S-10, aditivado, comum...) é o mesmo
// tanque do caminhão e fica numa cadeia só; os demais (Arla, gasolina...) pelo nome normalizado
function chaveCadeia(fuel) {
  const k = normKey(fuel);
  return k.includes("DIESEL") ? "DIESEL" : k;
}

function normKey(s) {
  if (s === null || s === undefined) return "";
  // remove acentos (GONÇALVES x GONCALVES, JOSÉ x JOSE, etc.) - motorista, posto e
  // combustivel batem entre arquivos que digitam o mesmo nome com acentuacao
  // diferente. So afeta a CHAVE de comparacao; o texto exibido no arquivo final
  // continua exatamente como veio (da Base, quando reconhecido, ou do arquivo novo).
  return String(s).trim().toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/\s+/).filter(Boolean).join(" ");
}

// Similaridade estilo Ratcliff/Obershelp (via LCS) — usada só para SUGERIR
// postos parecidos; nunca decide dedup/KM/heranças. Nada é aplicado sozinho.
function similarityRatio(a, b) {
  a = a || ""; b = b || "";
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const n = a.length, m = b.length;
  const dp = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    let prev = 0;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) dp[j] = prev + 1;
      else dp[j] = Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return (2 * dp[m]) / (n + m);
}

const ALIASES_POSTO_CONFIRMADOS_RAW = [
  ["BOMBA INTERNA - RAJA LOG JEQUIE", "POSTO INT RAJA JEQUIE"],
  ["DP DIVISA ALEGRE 2", "DOM PEDRO DIVISA ALEGRE 2"],
  ["POSTO CARAVELAS - REDE HG", "POSTO CARAVELAS"],
  // confirmado pelo usuario: mesmo endereco exato (RODOVIA BR 232 KM 468, MIRANDIBA/PE,
  // codigo 12026781) - "REDE MAIS" e' so o nome que a Veloe usa pra essa bandeira/rede.
  ["REDE MAIS", "POSTO RAINHA 2"],
  ["POSTO BENDEGO - REDE HG", "POSTO BENDEGO"],
  ["RAINHA 2", "POSTO RAINHA 2"],
  ["POSTO BELO JARDIM", "AUTO POSTO BELO JARDIM"],
  ["AUTO POSTO REAL - GRUPO PEDRA DO POMBAL", "AUTO POSTO REAL"],
  ["POSTO PEDRA BRANCA II - REDE PEDRA BRANCA", "AUTO POSTO PEDRA BRANCA II"],
  ["POSTO DE COMBUSTIVEIS GOIANIRA - REDE Z+Z - RODOVIA", "POSTO DE COMBUSTIVEIS GOIANIRA LTDA"],
  ["AUTO POSTO FOSTEC - REDE Z+Z (RODOVIA)", "AUTO POSTO FOSTEC"],
  ["POSTO PEDRA BRANCA - REDE PEDRA BRANCA", "POSTO PEDRA BRANCA"],
  ["REDE MARAJO - ARAPORA", "MARAJO ARAPORA"],
  // confirmados pelo usuario nesta rodada - enderecos conferidos contra a Base:
  ["POSTO DOM PEDRO", "DOM PEDRO DIVISA ALEGRE 2"], // BR 116, DIVISA ALEGRE/MG, codigo 11717861
  ["POSTO CACHOEIRA III", "POSTO CACHOEIRA 3"], // BR 116 KM 213, TABULEIRO DO NORTE/CE, codigo 5025842
  ["POSTO PLANALTO II - REDE HG", "POSTO PLANALTO 2"], // AV RIO BAHIA KM 412, GOVERNADOR VALADARES/MG, codigo 11393080
  ["REDE MARAJO - MARAJO RIANAPOLIS", "MARAJO RIANAPOLIS"], // BR 153 KM 1102, RIANAPOLIS/GO, codigo 13024839
  ["DP IGARATINGA - REDE DOM PEDRO | MG-RODOVIA", "DOM PEDRO IGARATINGA"], // BR 262 KM 418, IGARATINGA/MG, codigo 11448100
  // esse e' o posto com endereco em Plus Code (32PQ+G2X) que o usuario pediu pra
  // resolver manualmente - confirmado contra a Base: "MARAJO TAILANDIA" (1080
  // lancamentos, ROD PA 150, TAILANDIA/PA, codigo 12192908), mesma cidade/rodovia.
  ["REDE MARAJO - POSTO MARAJO TAILANDIA", "MARAJO TAILANDIA"],
];
function buildAliasMap(extras) {
  const m = new Map();
  for (const [raw, canon] of ALIASES_POSTO_CONFIRMADOS_RAW) m.set(normKey(raw), normKey(canon));
  if (extras) for (const [raw, canon] of extras) m.set(normKey(raw), normKey(canon));
  return m;
}

function postoLookupKey(nome, aliasMap) {
  const k = normKey(nome);
  return aliasMap.has(k) ? aliasMap.get(k) : k;
}

// Pares JA CONFIRMADOS pelo usuario como POSTOS DIFERENTES (o parecido nao e o mesmo).
// Serve so pra a sugestao nao voltar a insistir nesse par especifico - nao impede que outro
// candidato, diferente desse, seja sugerido no lugar.
const POSTOS_DISTINTOS_CONFIRMADOS_RAW = [
  ["POSTO DO TREVO - TRES RIOS", "POSTO OLA TRES RIOS"],
  ["POSTO PETROMAXX - REDE Z+Z (RODOVIA)", "POSTO SAO JUDAS TADEU - REDE Z+Z (RODOVIA)"],
];
function buildDistintosSet(extras) {
  const s = new Set();
  const par = (a, b) => normKey(a) + "‖" + normKey(b);
  for (const [a, b] of POSTOS_DISTINTOS_CONFIRMADOS_RAW) s.add(par(a, b));
  if (extras) for (const [a, b] of extras) s.add(par(a, b));
  return s;
}

// Postos JA CONFIRMADOS pelo usuario como proprios/novos (sem equivalente na Base) - endereco
// fixo, sem codigo/tipo de estabelecimento (a Truckpag/Veloe nao informam isso).
const POSTOS_PROPRIOS_CONFIRMADOS = [
  { nome_cru: "AUTO POSTO MOCOCAO", endereco: "RUA CLAUDIO DE SOUZA XAVIER", cidade: "MOCOCA", uf: "SP" },
  { nome_cru: "POSTO DO TREVO - TRES RIOS", endereco: "ROD BR 040 0", cidade: "TRES RIOS", uf: "RJ" },
  // confirmados pelo usuario nesta rodada como postos proprios/novos (nao sao o candidato sugerido):
  { nome_cru: "POSTO PETROMAXX - REDE Z+Z (RODOVIA)", endereco: "ROD GO060 0", cidade: "GOIANIA", uf: "GO" },
  { nome_cru: "DP IBO - REDE DOM PEDRO | BA-RODOVIA", endereco: "RODOVIA BR 116 0", cidade: "ABARE", uf: "BA" },
];

function sugerirPostoParecido(nomeNovo, enderecoNovo, cidadeNovo, ufNovo, postoDir, distintosSet) {
  if (!ufNovo) return null;
  const nk = normKey(nomeNovo), ek = normKey(enderecoNovo), ck = normKey(cidadeNovo), ufk = normKey(ufNovo);
  let melhor = null;
  for (const [nomeB, info] of postoDir.entries()) {
    if (distintosSet && distintosSet.has(normKey(nomeNovo) + "‖" + normKey(nomeB))) continue;
    if (normKey(info.UF) !== ufk) continue;
    const cidSim = similarityRatio(normKey(info.CIDADE), ck);
    if (cidSim < 0.7) continue;
    const nameSim = similarityRatio(normKey(nomeB), nk);
    const endSim = similarityRatio(normKey(info.ENDERECO), ek);
    const score = 0.5 * nameSim + 0.3 * endSim + 0.2 * cidSim;
    if (score >= 0.65 && (melhor === null || score > melhor.score)) melhor = { score, nomeB, info };
  }
  return melhor;
}

// Correções manuais pontuais já confirmadas (placa, data ISO, hodômetro errado) -> certo
const CORRECOES_HODOMETRO = new Map([
  ["OWL6397|2026-08-29T15:15:02|826768", 926768],
]);

function latestBeforeEntry(histList, dt) {
  if (!histList || !histList.length) return null;
  let lo = 0, hi = histList.length;
  const t = dt.getTime();
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (histList[mid][0].getTime() < t) lo = mid + 1; else hi = mid;
  }
  if (lo === 0) return null;
  return histList[lo - 1]; // [data, valor]
}
function latestBefore(histList, dt) {
  const e = latestBeforeEntry(histList, dt);
  return e ? e[1] : null;
}
function insertSorted(histList, dt, value) {
  histList.push([dt, value]);
  histList.sort((a, b) => a[0].getTime() - b[0].getTime());
}

function sheetToRows(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Aba "${sheetName}" não encontrada no arquivo.`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
}

function parseCsvLineSemicolon(line) {
  const out = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
      else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ";") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// --- carrega o histórico completo da Base --------------------------------
function carregarBase(rows) {   // no site: linhas remontadas do histórico (carregarHistorico), não o arquivo da Base
  const vehicle_hist = new Map(), driver_hist = new Map(), posto_hist = new Map();
  const hodo_hist = new Map(), posto_dir = new Map();
  const preco_hist = new Map(); // posto normalizado -> [(data, vl_litro)] - so linhas VIBRA
  const motorista_por_veiculo_hist = new Map(); // placa -> [(data, {nome, matricula})] - todas as fontes
  const existing_keys = new Map(); // chave placa|hodometro|combustivel -> lista de datas da Base que bateram nela
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const placa = row[5];
    const dtRaw = row[4];
    const hodo = row[16];
    const fuel = row[13];
    // A Base guarda o combustivel exatamente como o sistema de origem mandou (ex:
    // "DIESEL S-10 ADITIVADO" em algumas linhas, "DIESEL S-10 COMUM" em outras, pro
    // MESMO veiculo) - se comparar cru, essas variantes viram cadeias de hodometro/
    // duplicidade/preco SEPARADAS entre si, quebrando o historico. Por isso a Base
    // tambem passa pelo mesmo normFuel() que ja normaliza os arquivos novos - assim
    // a chave da Base fica igual a chave que os eventos novos vao gerar.
    const fuelCanon = normFuel(fuel)[0];
    const forma_pag = row[1];
    const vl_litro = row[15];
    const nome_posto = row[21];
    if (!placa || (typeof dtRaw !== "number" && !(dtRaw instanceof Date))) continue;
    const dt = dtRaw instanceof Date ? dtRaw : excelSerialToDate(dtRaw);
    n++;
    if (hodo !== null && hodo !== undefined) {
      const chave = [placa, hodo, fuelCanon].join("§");
      if (!existing_keys.has(chave)) existing_keys.set(chave, []);
      existing_keys.get(chave).push(dt);
    }
    const vfields = {
      "CODIGO CLIENTE": row[2], "NOME REDUZIDO": row[3], "TIPO FROTA": row[6],
      "MODELO VEICULO": row[7], "NUMERO FROTA": row[8], "ANO": row[9], "SERVICO": row[12],
      "INFORMACAO ADIDIONAL 1": row[27], "INFORMACAO ADIDIONAL 2": row[28],
      "INFORMACAO ADIDIONAL 3": row[29], "INFORMACAO ADIDIONAL 4": row[30],
      "INFORMACAO ADIDIONAL 5": row[31], "FORMA TRANSACAO": row[32],
      "CODIGO LIBERACAO RESTRICAO": row[33], "SERIE POS": row[34], "NUMERO CARTAO": row[35],
      "FAMILIA VEICULO": row[36], "GRUPO RESTRICAO": row[37], "CODIGO EMISSORA": row[38],
      "RESPONSAVEL": row[39],
    };
    if (!vehicle_hist.has(placa)) vehicle_hist.set(placa, []);
    vehicle_hist.get(placa).push([dt, vfields]);
    if (hodo !== null && hodo !== undefined) {
      // KM rodado e' por combustivel: a Base guarda um "km desde o ultimo abastecimento
      // DESSE combustivel" - diesel e arla tem cadeias de hodometro totalmente separadas
      // (confirmado no historico real: arla so compara com o hodometro do arla anterior,
      // nunca com o diesel do meio). Se misturar tudo numa cadeia so, um arla logo antes
      // de um diesel "rouba" o km que deveria aparecer no diesel.
      const pkHodo = placa + "§" + chaveCadeia(fuelCanon);
      if (!hodo_hist.has(pkHodo)) hodo_hist.set(pkHodo, []);
      hodo_hist.get(pkHodo).push([dt, hodo]);
    }
    const motorista = row[11];
    if (motorista) {
      const dk = normKey(motorista);
      if (!driver_hist.has(dk)) driver_hist.set(dk, []);
      driver_hist.get(dk).push([dt, row[10]]);
      if (!motorista_por_veiculo_hist.has(placa)) motorista_por_veiculo_hist.set(placa, []);
      motorista_por_veiculo_hist.get(placa).push([dt, { nome: motorista, matricula: row[10] ?? null }]);
    }
    if (nome_posto) {
      const pk = normKey(nome_posto);
      const pfields = { "CODIGO ESTABELECIMENTO": row[20], "TIPO ESTABELECIMENTO": row[22],
        "ENDERECO": row[23], "BAIRRO": row[24], "CIDADE": row[25], "UF": row[26],
        "NOME ESTABELECIMENTO": nome_posto };
      if (!posto_hist.has(pk)) posto_hist.set(pk, []);
      posto_hist.get(pk).push([dt, pfields]);
      const prev_dir = posto_dir.get(nome_posto);
      if (!prev_dir || dt.getTime() > prev_dir._dt.getTime()) posto_dir.set(nome_posto, { ...pfields, _dt: dt });
      if (forma_pag === "VIBRA" && vl_litro !== null && vl_litro !== undefined) {
        // preco varia MUITO por combustivel (diesel ~6,30, arla ~1,90 no mesmo posto) -
        // a chave tem que incluir o combustivel, senao um abastecimento de arla logo
        // antes de um de diesel contamina o preco herdado do diesel.
        const pkPrecoCombustivel = pk + "§" + normKey(fuelCanon);
        if (!preco_hist.has(pkPrecoCombustivel)) preco_hist.set(pkPrecoCombustivel, []);
        preco_hist.get(pkPrecoCombustivel).push([dt, vl_litro]);
      }
    }
  }
  for (const m of [vehicle_hist, driver_hist, posto_hist, hodo_hist, preco_hist, motorista_por_veiculo_hist]) {
    for (const [, arr] of m.entries()) arr.sort((a, b) => a[0].getTime() - b[0].getTime());
  }
  return { vehicle_hist, driver_hist, posto_hist, hodo_hist, posto_dir, existing_keys, preco_hist, motorista_por_veiculo_hist, n };
}

function lerTicket(wbT) {
  const rows = sheetToRows(wbT, "Transações");
  const headers = rows[0];
  const eventos = [];
  const avisos = [];
  for (let r = 1; r < rows.length; r++) {
    const vals = rows[r];
    if (!vals) continue;
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? null; });
    if (!row["PLACA"] || !row["DATA TRANSACAO"]) continue;
    let dt = row["DATA TRANSACAO"];
    if (!(dt instanceof Date)) dt = parseBrDate(dt);
    const [fuel_norm, fuel_ok] = normFuel(row["TIPO COMBUSTIVEL"]);
    if (!fuel_ok) avisos.push(`TICKET: tipo de combustivel nao mapeado '${row["TIPO COMBUSTIVEL"]}' na placa ${row["PLACA"]} em ${dt.toISOString()}`);
    eventos.push({
      fonte: "TICKET",
      "CODIGO TRANSACAO": row["CODIGO TRANSACAO"], "FORMA DE PAGAMENTO": row["FORMA DE PAGAMENTO"],
      "CODIGO CLIENTE": row["CODIGO CLIENTE"], "NOME REDUZIDO": row["NOME REDUZIDO"],
      "DATA TRANSACAO": dt, "PLACA": row["PLACA"], "TIPO FROTA": row["TIPO FROTA"],
      "MODELO VEICULO": row["MODELO VEICULO"], "NUMERO FROTA": row["NUMERO FROTA"], "ANO": row["ANO"],
      "MATRICULA": row["MATRICULA"], "NOME MOTORISTA": row["NOME MOTORISTA"], "SERVICO": row["SERVICO"],
      "TIPO COMBUSTIVEL": fuel_norm, "LITROS": row["LITROS"], "VL/LITRO": row["VL/LITRO"],
      "HODOMETRO OU HORIMETRO": row["HODOMETRO OU HORIMETRO"],
      "KM RODADOS OU HORAS TRABALHADAS": row["KM RODADOS OU HORAS TRABALHADAS"],
      "KM/LITRO OU LITROS/HORA": row["KM/LITRO OU LITROS/HORA"], "VALOR EMISSAO": row["VALOR EMISSAO"],
      "CODIGO ESTABELECIMENTO": row["CODIGO ESTABELECIMENTO"], "NOME ESTABELECIMENTO": row["NOME ESTABELECIMENTO"],
      "TIPO ESTABELECIMENTO": row["TIPO ESTABELECIMENTO"], "ENDERECO": row["ENDERECO"], "BAIRRO": row["BAIRRO"],
      "CIDADE": row["CIDADE"], "UF": row["UF"],
      "INFORMACAO ADIDIONAL 1": row["INFORMACAO ADIDIONAL 1"], "INFORMACAO ADIDIONAL 2": row["INFORMACAO ADIDIONAL 2"],
      "INFORMACAO ADIDIONAL 3": row["INFORMACAO ADIDIONAL 3"], "INFORMACAO ADIDIONAL 4": row["INFORMACAO ADIDIONAL 4"],
      "INFORMACAO ADIDIONAL 5": row["INFORMACAO ADIDIONAL 5"], "FORMA TRANSACAO": row["FORMA TRANSACAO"],
      "CODIGO LIBERACAO RESTRICAO": row["CODIGO LIBERACAO RESTRICAO"], "SERIE POS": row["SERIE POS"],
      "NUMERO CARTAO": row["NUMERO CARTAO"], "FAMILIA VEICULO": row["FAMILIA VEICULO"],
      "GRUPO RESTRICAO": row["GRUPO RESTRICAO"], "CODIGO EMISSORA": row["CODIGO EMISSORA"], "RESPONSAVEL": row["RESPONSAVEL"],
      _precisa_km: false, _precisa_veiculo: false, _precisa_motorista: false, _precisa_posto: false,
    });
  }
  return { eventos, avisos };
}

function lerTruckpag(wbTp) {
  const rows = sheetToRows(wbTp, "Worksheet");
  const headers = rows[0];
  const eventos = [];
  const avisos = [];
  for (let r = 1; r < rows.length; r++) {
    const vals = rows[r];
    if (!vals) continue;
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? null; });
    const placa = row["PLACA"];
    if (!placa || !row["DATA TRANSACAO"]) continue;
    const dt = parseBrDate(row["DATA TRANSACAO"]);
    const [fuel_norm, fuel_ok] = normFuel(row["TIPO DE COMBUSTIVEL"]);
    if (!fuel_ok) avisos.push(`TRUCKPAG: tipo de combustivel nao mapeado '${row["TIPO DE COMBUSTIVEL"]}' na placa ${placa} em ${dt.toISOString()}`);
    const litros = parseBrNumber(row["LITROS"]);
    const vl_litro = parseBrNumber(row["VL/LITRO"]);
    let hodo = row["HODOMETRO OU HORIMETRO"];
    hodo = (hodo !== null && hodo !== undefined) ? Math.trunc(Number(hodo)) : null;
    const corrKey = [placa, isoNoMs(dt), hodo].join("|");
    if (CORRECOES_HODOMETRO.has(corrKey)) {
      const hc = CORRECOES_HODOMETRO.get(corrKey);
      avisos.push(`CORRECAO MANUAL: placa ${placa} em ${dt.toISOString()} - hodometro corrigido de ${hodo} para ${hc} (confirmado pelo usuario).`);
      hodo = hc;
    }
    const motorista = (row["NOME MOTORISTA"] || "").toString().trim();
    eventos.push({
      fonte: "TRUCKPAG", "CODIGO TRANSACAO": null, "FORMA DE PAGAMENTO": "TRUCKPAG",
      "DATA TRANSACAO": dt, "PLACA": placa, "NOME MOTORISTA": motorista, "TIPO COMBUSTIVEL": fuel_norm,
      "LITROS": litros, "VL/LITRO": vl_litro, "HODOMETRO OU HORIMETRO": hodo,
      "NOME ESTABELECIMENTO": row["NOME ESTABELECIMENTO"],
      _raw_endereco: row["ENDERECO"], _raw_cidade: row["CIDADE"], _raw_uf: row["UF"],
      _precisa_km: true, _precisa_veiculo: true, _precisa_motorista: true, _precisa_posto: true,
    });
  }
  return { eventos, avisos };
}

function lerVeloe(texto) {
  const lines = texto.split(/\r\n|\n|\r/).filter(l => l.length > 0);
  const rows = lines.map(parseCsvLineSemicolon);
  const headers = rows[0];
  const eventos = [];
  const avisos = [];
  for (let r = 1; r < rows.length; r++) {
    const vals = rows[r];
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? null; });
    if (row["Tipo Transação"] !== "Compra" || row["Tipo Mercadoria"] !== "Combustível") continue;
    if (row["Status Transação"] !== "Aprovada") continue;
    const placa = (row["Placa"] || "").toString().trim();
    if (!placa || !row["Data/Hora Transação"]) continue;
    const dt = parseBrDate(row["Data/Hora Transação"]);
    const [fuel_norm, fuel_ok] = normFuel(row["Mercadoria"]);
    if (!fuel_ok) avisos.push(`VELOE: tipo de combustivel nao mapeado '${row["Mercadoria"]}' na placa ${placa} em ${dt.toISOString()}`);
    const litros = parseBrNumber(row["Qtd Mercadoria"]);
    const vl_litro = parseBrNumber(row["Valor Mercadoria"]);
    let hodo = parseBrNumber(row["Hodômetro - Dig. Motorista"]);
    hodo = (hodo !== null && hodo !== undefined) ? Math.trunc(hodo) : null;
    const motorista = (row["Nome Motorista"] || "").toString().trim();
    eventos.push({
      fonte: "VELOE", "CODIGO TRANSACAO": null, "FORMA DE PAGAMENTO": "VELOE",
      "DATA TRANSACAO": dt, "PLACA": placa, "NOME MOTORISTA": motorista, "TIPO COMBUSTIVEL": fuel_norm,
      "LITROS": litros, "VL/LITRO": vl_litro, "HODOMETRO OU HORIMETRO": hodo,
      "NOME ESTABELECIMENTO": row["Nome EC"],
      _raw_endereco: row["Logradouro EC"], _raw_cidade: row["Cidade EC"], _raw_uf: row["UF EC"],
      _precisa_km: true, _precisa_veiculo: true, _precisa_motorista: true, _precisa_posto: true,
    });
  }
  return { eventos, avisos };
}

// Cais da Vibra: extrato de tanque interno. Linha 1 do arquivo e titulo do relatorio,
// os cabecalhos de verdade vem na linha 2. Mistura linhas de "FECHAMENTO" (fechamento
// periodico do tanque, sem placa/motorista) com linhas de "ABASTECIMENTO" (evento real
// de veiculo) - so as de abastecimento interessam aqui. Nao vem preco nem litros/vl-litro
// separados: "Movimentacao" e o volume (negativo = saida do tanque); preco e herdado do
// ultimo abastecimento naquele mesmo posto (ver preco_hist em consolidar). Nao vem
// endereco/cidade/UF do posto (so os 4 codigos ja conhecidos: CALAN, CAAPE - CONE, CABET,
// CAANA) nem sempre vem nome de motorista.
function lerVibra(wbV) {
  const rows = sheetToRows(wbV, "Sheet1");
  const headers = rows[1]; // linha 0 = titulo, linha 1 = cabecalhos
  const eventos = [];
  const avisos = [];
  for (let r = 2; r < rows.length; r++) {
    const vals = rows[r];
    if (!vals) continue;
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? null; });
    if (row["Origem"] !== "ABASTECIMENTO") continue; // ignora fechamento de tanque
    const placa = (row["Placa"] || "").toString().trim();
    if (!placa || !row["Data de Ocorrência"]) continue;
    const dt = parseBrDate(row["Data de Ocorrência"]);
    const [fuel_norm, fuel_ok] = normFuel(row["Produto"]);
    if (!fuel_ok) avisos.push(`VIBRA: tipo de combustivel nao mapeado '${row["Produto"]}' na placa ${placa} em ${dt.toISOString()}`);
    let hodo = row["Hodômetro"];
    hodo = (typeof hodo === "number") ? Math.trunc(hodo) : parseBrNumber(hodo);
    hodo = (hodo !== null && hodo !== undefined) ? Math.trunc(hodo) : null;
    const movimentacao = parseBrNumber(row["Movimentação"]);
    const litros = movimentacao !== null ? Math.abs(movimentacao) : null;
    const motorista = (row["Motorista"] || "").toString().trim();
    eventos.push({
      fonte: "VIBRA", "CODIGO TRANSACAO": null, "FORMA DE PAGAMENTO": "VIBRA",
      "DATA TRANSACAO": dt, "PLACA": placa, "NOME MOTORISTA": motorista, "TIPO COMBUSTIVEL": fuel_norm,
      "LITROS": litros, "VL/LITRO": null, "HODOMETRO OU HORIMETRO": hodo,
      "NOME ESTABELECIMENTO": row["Ponto de Abastecimento"],
      _raw_endereco: null, _raw_cidade: null, _raw_uf: null,
      _precisa_km: true, _precisa_veiculo: true, _precisa_motorista: true, _precisa_posto: true, _precisa_preco: true,
    });
  }
  return { eventos, avisos };
}

// --- motor principal: heranças + KM ---------------------------------------
// motoristasTrocados (no site): Map nome do arquivo (normKey) -> nome certo, para motorista cadastrado errado no portal do cartão
function consolidar({ base, ticket, truckpag, veloe, vibra, aliasExtras, postosNovos, motoristasConfirmados, postosIgnorados, manuais, motoristasTrocados }) {
  const avisos = [];
  const add = (m) => avisos.push(m);
  const postosIgnoradosSet = new Set((postosIgnorados || []).map(normKey));   // no site: decisões gravadas, sem acento/maiúsculas

  const { vehicle_hist, driver_hist, posto_hist, hodo_hist, posto_dir, existing_keys, preco_hist, motorista_por_veiculo_hist } = base;
  // no site: os arquivos das plataformas são opcionais (a Inclusão de abastecimento manda só os lançados à mão: "manuais")
  const vazio = () => ({ eventos: [], avisos: [] });
  const rT = ticket ? lerTicket(ticket) : vazio(); rT.avisos.forEach(add);
  const rTp = truckpag ? lerTruckpag(truckpag) : vazio(); rTp.avisos.forEach(add);
  const rV = veloe ? lerVeloe(veloe) : vazio(); rV.avisos.forEach(add);
  const rVi = vibra ? lerVibra(vibra) : vazio(); rVi.avisos.forEach(add);

  // Postos que o usuario confirmou NAO serem o mesmo que o sugerido - tratados como
  // posto proprio, novo, usando o endereco/cidade/UF do proprio arquivo (sem codigo de
  // estabelecimento, que a Truckpag/Veloe nao informam). Data antiga garante que qualquer
  // transacao futura enxergue isso como "historico anterior".
  const EPOCA_ANTIGA = new Date(Date.UTC(1970, 0, 1));
  function seedPostoProprio(pn) {
    const pk = normKey(pn.nome_cru);
    const pfields = { "CODIGO ESTABELECIMENTO": null, "TIPO ESTABELECIMENTO": null,
      "ENDERECO": pn.endereco ?? null, "BAIRRO": null, "CIDADE": pn.cidade ?? null, "UF": pn.uf ?? null,
      "NOME ESTABELECIMENTO": pn.nome_cru };
    if (!posto_hist.has(pk)) posto_hist.set(pk, []);
    insertSorted(posto_hist.get(pk), EPOCA_ANTIGA, pfields);
    if (!posto_dir.has(pn.nome_cru)) posto_dir.set(pn.nome_cru, { ...pfields, _dt: EPOCA_ANTIGA });
  }
  // permanentes (ja confirmados em sessoes anteriores) - sem aviso, ja sao esperados
  for (const pn of POSTOS_PROPRIOS_CONFIRMADOS) seedPostoProprio(pn);
  // confirmados agora, nesta sessao - com aviso, pra ficar registrado no que foi decidido
  for (const pn of (postosNovos || [])) {
    seedPostoProprio(pn);
    add(`POSTO CADASTRADO COMO NOVO (confirmado pelo usuario - nao e o mesmo que o sugerido): "${pn.nome_cru}" - endereco ${pn.endereco || "—"}, ${pn.cidade || "—"}/${pn.uf || "—"}. Sem codigo de estabelecimento (a plataforma nao informa).`);
  }
  const distintosSet = buildDistintosSet();

  let eventos = [...rT.eventos, ...rTp.eventos, ...rV.eventos, ...rVi.eventos, ...(manuais || [])];
  const totalAntes = eventos.length;

  const filtrados = [];
  const duplicados = []; // transacoes descartadas por ja bater com algo na Base - guardadas pra conferencia
  for (const ev of eventos) {
    const key = [ev["PLACA"], ev["HODOMETRO OU HORIMETRO"], ev["TIPO COMBUSTIVEL"]].join("§");
    const datasBase = existing_keys.get(key);
    if (datasBase) {
      duplicados.push({
        fonte: ev.fonte, placa: ev["PLACA"], data: ev["DATA TRANSACAO"],
        hodometro: ev["HODOMETRO OU HORIMETRO"], combustivel: ev["TIPO COMBUSTIVEL"],
        litros: ev["LITROS"], vl_litro: ev["VL/LITRO"],
        datas_base: datasBase,
      });
      continue;
    }
    filtrados.push(ev);
  }
  const n_dup = totalAntes - filtrados.length;
  eventos = filtrados;
  if (n_dup) add(`${n_dup} transacoes dos arquivos novos ja estavam nos abastecimentos (mesma placa+hodometro+combustivel) e foram ignoradas automaticamente.`);

  eventos.sort((a, b) => (a["PLACA"] < b["PLACA"] ? -1 : a["PLACA"] > b["PLACA"] ? 1 : a["DATA TRANSACAO"] - b["DATA TRANSACAO"]));

  const aliasMap = buildAliasMap(aliasExtras);
  // no site: relacionamentos gravados pelo usuario (nome do arquivo -> posto da Base) e o cadastro mais recente de
  // cada posto da Base (qualquer data), para nao perguntar de novo quando o posto so aparece na Base depois
  const aliasGravado = new Map((aliasExtras || []).map(([raw, canon]) => [normKey(raw), canon]));
  const postoDirPorChave = new Map([...posto_dir.entries()].map(([nome, info]) => [normKey(nome), info]));
  const placas_sem_historico = new Set();
  const motoristas_sem_historico = new Map(); // nome motorista -> {count, fonte, placa, data (1a ocorrencia)}
  const postos_sem_historico = new Set();
  const postos_pendentes = []; // {nome_cru, endereco, cidade, uf, candidato, score, info}
  const postos_sem_sugestao = [];
  const motoristas_sugestoes = []; // {chave, placa, data, fonte, sugestao_nome, sugestao_matricula, sugestao_data}

  for (const ev of eventos) {
    const placa = ev["PLACA"];
    const dt = ev["DATA TRANSACAO"];
    const chaveMotorista = ev["CODIGO TRANSACAO"] ? `COD:${ev["CODIGO TRANSACAO"]}` : `${placa}|${isoNoMs(dt)}`;

    if (ev._precisa_veiculo) {
      const hist = vehicle_hist.get(placa) || [];
      const prev = latestBefore(hist, dt);
      if (!prev) { placas_sem_historico.add(placa); for (const f of VEHICLE_FIELDS) ev[f] = null; }
      else { for (const f of VEHICLE_FIELDS) ev[f] = prev[f] ?? null; }
    }

    if (ev._precisa_motorista) {
      const troca = motoristasTrocados && ev["NOME MOTORISTA"] ? motoristasTrocados.get(normKey(ev["NOME MOTORISTA"])) : null;
      if (troca) {
        add(`MOTORISTA TROCADO (confirmado pelo usuario) [${ev.fonte}, placa ${placa}]: "${ev["NOME MOTORISTA"]}" -> "${troca}" em ${isoNoMs(dt)}.`);
        ev["NOME MOTORISTA"] = troca;
      }
      const dk = normKey(ev["NOME MOTORISTA"]);
      if (dk) {
        const prev = latestBefore(driver_hist.get(dk) || [], dt);
        if (prev === null) {
          const nomeM = ev["NOME MOTORISTA"];
          if (!motoristas_sem_historico.has(nomeM)) {
            motoristas_sem_historico.set(nomeM, { count: 0, fonte: ev.fonte, placa: ev.PLACA, data: dt });
          }
          motoristas_sem_historico.get(nomeM).count++;
          ev["MATRICULA"] = null;
        } else {
          ev["MATRICULA"] = prev;
        }
      } else {
        // arquivo nao trouxe nome de motorista (comum na Vibra). So aplica se o usuario
        // ja confirmou essa sugestao especifica numa rodada anterior - senao fica em
        // branco e vira pendencia pro painel de confirmacao.
        const confirmado = motoristasConfirmados && motoristasConfirmados.get(chaveMotorista);
        if (confirmado) {
          ev["NOME MOTORISTA"] = confirmado.nome;
          ev["MATRICULA"] = confirmado.matricula ?? null;
        } else {
          const sugestaoEntry = latestBeforeEntry(motorista_por_veiculo_hist.get(placa) || [], dt);
          // no site: entra na lista mesmo sem sugestão (veículo sem motorista anterior), para o usuário digitar o nome
          motoristas_sugestoes.push({
            chave: chaveMotorista, placa, data: dt, fonte: ev.fonte,
            sugestao_nome: sugestaoEntry ? sugestaoEntry[1].nome : null, sugestao_matricula: sugestaoEntry ? sugestaoEntry[1].matricula : null,
            sugestao_data: sugestaoEntry ? sugestaoEntry[0] : null,
          });
          ev["NOME MOTORISTA"] = null;
          ev["MATRICULA"] = null;
        }
      }
    }

    if (ev._precisa_posto) {
      const pk = postoLookupKey(ev["NOME ESTABELECIMENTO"], aliasMap);
      let prev = latestBefore(posto_hist.get(pk) || [], dt);
      // no site: relacionamento gravado cujo posto da Base so tem registro DEPOIS desta data - usa o cadastro mais
      // recente dele (com aviso) em vez de pedir autorizacao de novo
      if (!prev && aliasGravado.has(normKey(ev["NOME ESTABELECIMENTO"]))) {
        const info = postoDirPorChave.get(normKey(aliasGravado.get(normKey(ev["NOME ESTABELECIMENTO"]))));
        if (info) {
          prev = info;
          add(`POSTO RELACIONADO (decisao gravada) [${ev.fonte}, placa ${ev.PLACA}]: "${ev["NOME ESTABELECIMENTO"]}" -> "${info["NOME ESTABELECIMENTO"]}" - o historico so tem esse posto em data posterior a esta transacao; usei o cadastro mais recente dele.`);
        }
      }
      if (!prev) {
        const nome_cru = ev["NOME ESTABELECIMENTO"];
        if (pk && !postos_sem_historico.has(nome_cru)) {
          postos_sem_historico.add(nome_cru);
          if (postosIgnoradosSet.has(normKey(nome_cru))) {
            // usuario ja revisou e marcou "deixar em branco" numa rodada anterior -
            // nao pede autorizacao de novo, so registra no log. Os campos do posto
            // continuam em branco (igual sempre foi) ate ele editar na Base.
            add(`POSTO DEIXADO EM BRANCO (revisao manual) [${ev.fonte}, placa ${ev.PLACA}]: "${nome_cru}" - endereco no arquivo: ${ev._raw_endereco || "—"}, ${ev._raw_cidade || "—"}/${ev._raw_uf || "—"}. Voce marcou pra nao pedir autorizacao de novo.`);
          } else {
            const sugestao = sugerirPostoParecido(nome_cru, ev._raw_endereco, ev._raw_cidade, ev._raw_uf, posto_dir, distintosSet);
            if (sugestao) {
              postos_pendentes.push({
                nome_cru, endereco: ev._raw_endereco, cidade: ev._raw_cidade, uf: ev._raw_uf,
                candidato: sugestao.nomeB, info: sugestao.info, score: sugestao.score,
                fonte: ev.fonte, placa: ev.PLACA,
              });
            } else {
              postos_sem_sugestao.push({
                nome_cru, endereco: ev._raw_endereco, cidade: ev._raw_cidade, uf: ev._raw_uf,
                fonte: ev.fonte, placa: ev.PLACA,
              });
            }
          }
        }
        for (const f of POSTO_FIELDS) ev[f] = null;
      } else {
        for (const f of POSTO_FIELDS) ev[f] = prev[f] ?? null;
        // Posto reconhecido como ja existente na Base (por historico direto ou por
        // confirmacao "e' o mesmo posto") - usa o nome tal como esta cadastrado na
        // Base, nao o nome como veio no arquivo novo. Evita "REDE MARAJO - POSTO
        // MARAJO TAILANDIA" (Truckpag) x "POSTO MARAJO TAILANDIA" (Base) virarem
        // dois nomes diferentes pro mesmo posto no arquivo final.
        if (prev["NOME ESTABELECIMENTO"]) ev["NOME ESTABELECIMENTO"] = prev["NOME ESTABELECIMENTO"];
      }
      // posto novo (sem histórico, cadastrado como novo ou deixado em branco) ou posto da Base com o tipo vazio:
      // o tipo do estabelecimento não pode ficar em branco (os dashboards de postos externos contam pelo tipo).
      // TruckPag/Veloe são postos de combustível; o arquivo da Vibra é o cais.
      if (!ev["TIPO ESTABELECIMENTO"]) ev["TIPO ESTABELECIMENTO"] = ev.fonte === "VIBRA" ? "CAIS VIBRA" : "POSTO DE COMBUSTIVEL";
    }

    if (ev._precisa_preco) {
      // Vibra nao informa preco - herda o ultimo VL/LITRO ja usado nesse mesmo posto
      // (so 4 postos fixos hoje). Sem aviso: o usuario concilia contra a nota fiscal
      // quando ela fecha.
      const pkPreco = postoLookupKey(ev["NOME ESTABELECIMENTO"], aliasMap) + "§" + normKey(ev["TIPO COMBUSTIVEL"]);
      ev["VL/LITRO"] = latestBefore(preco_hist.get(pkPreco) || [], dt);
    }

    // TICKET vem com "KM RODADOS" ja calculado pelo proprio sistema do cartao - mas
    // esse sistema so enxerga o historico DELE MESMO (Cartao Fisico/RFCV), sem saber
    // que o veiculo tambem abasteceu via Truckpag/Veloe/Vibra no meio do caminho.
    // Resultado: quando o veiculo troca de forma de pagamento, o KM que o Ticket
    // reporta pula direto pro ultimo abastecimento QUE ELE CONHECE, ignorando os
    // abastecimentos das outras fontes que aconteceram depois (confirmado com dado
    // real: RQS5J11 tinha Diesel via Truckpag/Vibra em 10/08, 17/08, 22/08 e 29/08,
    // mas o Ticket de 04/09 calculou KM contra o Diesel de 04/08, o ultimo que ELE
    // tinha visto - deu 5863 km ao inves de 1012). Por isso o KM/hodometro e'
    // SEMPRE recalculado contra a cadeia unificada (que inclui todas as fontes),
    // mesmo para Ticket - so o VALOR EMISSAO do Ticket continua sendo o valor
    // oficial cobrado (nao recalculado), pra nao divergir por arredondamento.
    if (ev._precisa_km || ev.fonte === "TICKET") {
      const hodo = ev["HODOMETRO OU HORIMETRO"];
      // km e' "desde o ultimo abastecimento DESSE combustivel" - diesel e arla tem
      // cadeias de hodometro separadas na Base (confirmado no historico real: um
      // abastecimento de arla so compara com o hodometro do arla anterior, nunca
      // com um diesel feito minutos antes no mesmo posto).
      const pkHodo = placa + "§" + chaveCadeia(ev["TIPO COMBUSTIVEL"]);
      const prevHodo = latestBefore(hodo_hist.get(pkHodo) || [], dt);
      if (prevHodo === null) {
        ev["KM RODADOS OU HORAS TRABALHADAS"] = null;
        ev["KM/LITRO OU LITROS/HORA"] = null;
        placas_sem_historico.add(placa);
      } else {
        const km = hodo !== null ? hodo - prevHodo : null;
        ev["KM RODADOS OU HORAS TRABALHADAS"] = km;
        ev["KM/LITRO OU LITROS/HORA"] = (km !== null && ev["LITROS"]) ? km / ev["LITROS"] : null;
        if (km !== null && km < 0) {
          add(`HODOMETRO RETROCEDEU: placa ${placa} em ${dt.toISOString()} (${ev.fonte}) - hodometro atual ${hodo} menor que o anterior ${prevHodo} (na transacao imediatamente anterior). KM ficou negativo: ${km}.`);
        }
      }
      if (ev._precisa_km) {
        ev["VALOR EMISSAO"] = (ev["LITROS"] != null && ev["VL/LITRO"] != null) ? ev["LITROS"] * ev["VL/LITRO"] : null;
      }
    }

    const hodo = ev["HODOMETRO OU HORIMETRO"];
    if (hodo !== null && hodo !== undefined) {
      const pkHodoNovo = placa + "§" + chaveCadeia(ev["TIPO COMBUSTIVEL"]);
      if (!hodo_hist.has(pkHodoNovo)) hodo_hist.set(pkHodoNovo, []);
      insertSorted(hodo_hist.get(pkHodoNovo), dt, hodo);
    }

    // atualiza pra frente o "ultimo motorista deste veiculo" (qualquer fonte) - assim uma
    // sugestao confirmada agora tambem alimenta eventos seguintes do mesmo veiculo no lote.
    if (ev["NOME MOTORISTA"]) {
      if (!motorista_por_veiculo_hist.has(placa)) motorista_por_veiculo_hist.set(placa, []);
      insertSorted(motorista_por_veiculo_hist.get(placa), dt, { nome: ev["NOME MOTORISTA"], matricula: ev["MATRICULA"] ?? null });
    }

    // idem pro preco por posto (so importa pra Vibra, inofensivo pras outras fontes)
    if (ev._precisa_preco && ev["VL/LITRO"] !== null && ev["VL/LITRO"] !== undefined) {
      const pkBase = postoLookupKey(ev["NOME ESTABELECIMENTO"], aliasMap);
      const pkPrecoNovo = pkBase ? (pkBase + "§" + normKey(ev["TIPO COMBUSTIVEL"])) : null;
      if (pkPrecoNovo) {
        if (!preco_hist.has(pkPrecoNovo)) preco_hist.set(pkPrecoNovo, []);
        insertSorted(preco_hist.get(pkPrecoNovo), dt, ev["VL/LITRO"]);
      }
    }

    if (ev.fonte === "TICKET") {
      const vfields = {}; VEHICLE_FIELDS.forEach(f => vfields[f] = ev[f] ?? null);
      if (!vehicle_hist.has(placa)) vehicle_hist.set(placa, []);
      insertSorted(vehicle_hist.get(placa), dt, vfields);
      const dk = normKey(ev["NOME MOTORISTA"]);
      if (dk) { if (!driver_hist.has(dk)) driver_hist.set(dk, []); insertSorted(driver_hist.get(dk), dt, ev["MATRICULA"]); }
      const pk = normKey(ev["NOME ESTABELECIMENTO"]);
      if (pk) {
        const pfields = {}; POSTO_FIELDS.forEach(f => pfields[f] = ev[f] ?? null);
        pfields["NOME ESTABELECIMENTO"] = ev["NOME ESTABELECIMENTO"] ?? null;
        if (!posto_hist.has(pk)) posto_hist.set(pk, []);
        insertSorted(posto_hist.get(pk), dt, pfields);
      }
    }
  }

  for (const p of [...placas_sem_historico].sort()) add(`PLACA SEM HISTORICO ANTERIOR: ${p} - provavelmente placa nova. KM/dados de veiculo ficaram em branco na primeira ocorrencia.`);
  for (const [nome, info] of [...motoristas_sem_historico.entries()].filter(([n]) => n).sort((a, b) => a[0].localeCompare(b[0]))) {
    add(`MOTORISTA SEM HISTORICO (matricula nao encontrada) [${info.fonte}, placa ${info.placa}]: "${nome}" - ${info.count} transacao(oes), primeira em ${info.data.toISOString()}.`);
  }
  for (const pp of postos_pendentes) {
    add(`PEDIDO DE AUTORIZACAO [${pp.fonte}, placa ${pp.placa}] - possivel mesmo posto: "${pp.nome_cru}" (endereco no arquivo: ${pp.endereco}, ${pp.cidade}/${pp.uf}) pode ser o mesmo que "${pp.candidato}" ja cadastrado no historico (endereco: ${pp.info.ENDERECO}, ${pp.info.CIDADE}/${pp.info.UF}, codigo ${pp.info["CODIGO ESTABELECIMENTO"]}). Confianca da comparacao: ${(pp.score * 100).toFixed(0)}%. NAO apliquei essa regra - os dados desse posto ficaram em branco nesta linha ate voce autorizar.`);
  }
  for (const p of postos_sem_sugestao) {
    add(`POSTO SEM HISTORICO [${p.fonte}, placa ${p.placa}] (nenhum candidato parecido encontrado por endereco): "${p.nome_cru}" - endereco ${p.endereco || "—"}, ${p.cidade || "—"}/${p.uf || "—"}.`);
  }
  for (const ms of motoristas_sugestoes) {
    if (!ms.sugestao_nome) { add(`MOTORISTA EM BRANCO [${ms.fonte}, placa ${ms.placa}] em ${ms.data.toISOString()}: arquivo nao trouxe nome e o veiculo nao tem motorista anterior. A linha ficou em branco ate voce informar o motorista.`); continue; }
    add(`SUGESTAO DE MOTORISTA [${ms.fonte}, placa ${ms.placa}] em ${ms.data.toISOString()}: arquivo nao trouxe nome - o ultimo a abastecer esse veiculo foi "${ms.sugestao_nome}" em ${ms.sugestao_data.toISOString()}. NAO apliquei essa sugestao - a linha ficou em branco ate voce confirmar.`);
  }

  eventos.sort((a, b) => a["DATA TRANSACAO"] - b["DATA TRANSACAO"]);

  // painel de decisao unificado: postos com candidato sugerido + postos sem nenhum candidato
  // (esses so tem a opcao de virar posto novo, nao ha nada pra "autorizar equivalencia")
  const postosParaDecidir = [
    ...postos_pendentes.map((p) => ({ ...p, temCandidato: true })),
    ...postos_sem_sugestao.map((p) => ({ ...p, temCandidato: false })),
  ];

  return {
    eventos, avisos,
    resumo: {
      n_ticket: rT.eventos.length, n_truckpag: rTp.eventos.length, n_veloe: rV.eventos.length,
      n_vibra: rVi.eventos.length,
      n_dup, total: eventos.length,
      placas_sem_historico: placas_sem_historico.size,
      motoristas_sem_historico: motoristas_sem_historico.size,
      postos_sem_historico: postos_sem_historico.size,
    },
    postos_pendentes: postosParaDecidir,
    duplicados,
    motoristas_pendentes: [...motoristas_sem_historico.entries()]
      .filter(([n]) => n)
      .map(([nome, info]) => ({ nome, ...info }))
      .sort((a, b) => a.nome.localeCompare(b.nome)),
    motoristas_sugestoes,
  };
}

function buildRow(ev) {
  const dt = ev["DATA TRANSACAO"];
  const placa = ev["PLACA"];
  const hodo = ev["HODOMETRO OU HORIMETRO"];
  const forma_pag = ev["FORMA DE PAGAMENTO"];
  const cod_unid = (hodo !== null && hodo !== undefined) ? `${placa}${Math.trunc(hodo)}` : null;
  const col48 = forma_pag ? `${placa}${forma_pag}` : placa;
  return [
    ev["CODIGO TRANSACAO"] ?? null, forma_pag ?? null, ev["CODIGO CLIENTE"] ?? null, ev["NOME REDUZIDO"] ?? null,
    dateToSerial(dt), placa, ev["TIPO FROTA"] ?? null, ev["MODELO VEICULO"] ?? null, ev["NUMERO FROTA"] ?? null, ev["ANO"] ?? null,
    ev["MATRICULA"] ?? null, ev["NOME MOTORISTA"] ?? null, ev["SERVICO"] ?? null, ev["TIPO COMBUSTIVEL"] ?? null,
    ev["LITROS"] ?? null, ev["VL/LITRO"] ?? null, hodo ?? null, ev["KM RODADOS OU HORAS TRABALHADAS"] ?? null,
    ev["KM/LITRO OU LITROS/HORA"] ?? null, ev["VALOR EMISSAO"] ?? null, ev["CODIGO ESTABELECIMENTO"] ?? null,
    ev["NOME ESTABELECIMENTO"] ?? null, ev["TIPO ESTABELECIMENTO"] ?? null, ev["ENDERECO"] ?? null, ev["BAIRRO"] ?? null,
    ev["CIDADE"] ?? null, ev["UF"] ?? null, ev["INFORMACAO ADIDIONAL 1"] ?? null, ev["INFORMACAO ADIDIONAL 2"] ?? null,
    ev["INFORMACAO ADIDIONAL 3"] ?? null, ev["INFORMACAO ADIDIONAL 4"] ?? null, ev["INFORMACAO ADIDIONAL 5"] ?? null,
    ev["FORMA TRANSACAO"] ?? null, ev["CODIGO LIBERACAO RESTRICAO"] ?? null, ev["SERIE POS"] ?? null,
    ev["NUMERO CARTAO"] ?? null, ev["FAMILIA VEICULO"] ?? null, ev["GRUPO RESTRICAO"] ?? null,
    ev["CODIGO EMISSORA"] ?? null, ev["RESPONSAVEL"] ?? null,
    dt.getUTCFullYear(), dt.getUTCMonth() + 1, null, cod_unid, 0, null, null, col48,
  ];
}

const OUTPUT_HEADERS = [
  "CODIGO TRANSACAO","FORMA DE PAGAMENTO","CODIGO CLIENTE","NOME REDUZIDO","DATA TRANSACAO",
  "PLACA","TIPO FROTA","MODELO VEICULO","NUMERO FROTA","ANO","MATRICULA","NOME MOTORISTA",
  "SERVICO","TIPO COMBUSTIVEL","LITROS","VL/LITRO","HODOMETRO OU HORIMETRO",
  "KM RODADOS OU HORAS TRABALHADAS","KM/LITRO OU LITROS/HORA","VALOR EMISSAO",
  "CODIGO ESTABELECIMENTO","NOME ESTABELECIMENTO","TIPO ESTABELECIMENTO","ENDERECO","BAIRRO",
  "CIDADE","UF","INFORMACAO ADIDIONAL 1","INFORMACAO ADIDIONAL 2","INFORMACAO ADIDIONAL 3",
  "INFORMACAO ADIDIONAL 4","INFORMACAO ADIDIONAL 5","FORMA TRANSACAO","CODIGO LIBERACAO RESTRICAO",
  "SERIE POS","NUMERO CARTAO","FAMILIA VEICULO","GRUPO RESTRICAO","CODIGO EMISSORA","RESPONSAVEL",
  "ANO","MÊS","CAMPANHA","COD UNID.","DATA REF","DEF POSTO", "", "",
];

// ---------- encaixe no site ----------
// colunas do histórico (mesmos índices da aba Transações que o carregarBase lê)
const COL_VEICULO = [2, 3, 6, 7, 8, 9, 12, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39];
const COL_POSTO = [20, 22, 23, 24, 25, 26];

// histórico publicado pelo vigia -> o mesmo resultado do carregarBase(arquivo da Base)
function carregarHistorico(h) {
  const { dic, col } = h;
  const rows = [null];   // linha 0 = cabeçalho (o carregarBase começa da 1)
  for (let i = 0; i < h.linhas; i++) {
    const r = new Array(40).fill(null);
    r[1] = dic.forma[col.forma[i]]; r[4] = col.dt[i]; r[5] = dic.placa[col.placa[i]];
    r[10] = dic.mat[col.mat[i]]; r[11] = dic.mot[col.mot[i]]; r[13] = dic.fuel[col.fuel[i]];
    r[15] = col.vl[i]; r[16] = col.hodo[i]; r[21] = dic.posto[col.posto[i]];
    const v = h.veiculos[col.v[i]], p = h.postos[col.p[i]];
    COL_VEICULO.forEach((c, j) => { r[c] = v[j]; });
    COL_POSTO.forEach((c, j) => { r[c] = p[j]; });
    rows.push(r);
  }
  return carregarBase(rows);
}

// Bomba interna > Inclusão de abastecimento: um abastecimento lançado à mão vira o mesmo "evento" que os leitores das
// plataformas montam; o consolidar() herda veículo, matrícula do motorista e dados do posto do histórico e calcula o KM
// rodado e o km/litro pela cadeia da placa e combustível. quando = 'AAAA-MM-DDTHH:MM' (hora local, como na Base).
function eventoManual({ quando, placa, km, litros, combustivel, posto, motorista, preco }) {
  const [a, m, d, h, mi] = quando.match(/\d+/g).map(Number);
  return {
    fonte: 'MANUAL', 'CODIGO TRANSACAO': null, 'FORMA DE PAGAMENTO': 'BOMBA INTERNA',
    'DATA TRANSACAO': new Date(Date.UTC(a, m - 1, d, h, mi, 0)), PLACA: placa, 'NOME MOTORISTA': motorista || null,
    'TIPO COMBUSTIVEL': combustivel, LITROS: litros, 'VL/LITRO': preco ?? null, 'HODOMETRO OU HORIMETRO': km,
    'NOME ESTABELECIMENTO': posto, _raw_endereco: null, _raw_cidade: null, _raw_uf: null,
    _precisa_km: true, _precisa_veiculo: true, _precisa_motorista: true, _precisa_posto: true,
  };
}

// Bomba interna > editar um lançado pelo site: tira do histórico em memória esse abastecimento (placa + combustível +
// data, ao minuto) para remontar a linha sem ele (senão ele vira o "anterior" dele mesmo e conta como duplicado).
function tirarDoHistorico(base, { placa, combustivel, quando }) {
  const [a, m, d, h, mi] = quando.match(/\d+/g).map(Number);
  const t = Date.UTC(a, m - 1, d, h, mi, 0);
  const fuel = normFuel(combustivel)[0];
  const mesmo = (dt) => Math.floor(dt.getTime() / 60000) === t / 60000;   // mesmo minuto (a Base pode trazer os segundos)
  const cadeia = base.hodo_hist.get(placa + "§" + chaveCadeia(fuel));
  if (cadeia) { const i = cadeia.findIndex((e) => mesmo(e[0])); if (i >= 0) cadeia.splice(i, 1); }
  for (const [k, datas] of base.existing_keys) {
    if (!k.startsWith(placa + "§") || !k.endsWith("§" + fuel)) continue;
    const i = datas.findIndex(mesmo);
    if (i >= 0) { datas.splice(i, 1); if (!datas.length) base.existing_keys.delete(k); }
  }
}

export { carregarHistorico, carregarBase, consolidar, buildRow, OUTPUT_HEADERS, normFuel, normKey, excelSerialToDate, dateToSerial, parseBrDate, eventoManual, tirarDoHistorico, chaveCadeia,
  buildAliasMap, postoLookupKey };
