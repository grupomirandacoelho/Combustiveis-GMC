// Busca de coordenadas dos postos no OpenStreetMap (Nominatim) — as regras do scripts/geocodificar_postos.py, para a rotina da nuvem
// (Edge Function geo-postos; 15.3, 25/11/2026, pedido do usuário "Pode seguir"). Copiado para supabase/functions/_shared pelo
// scripts/nuvem_publicar.mjs (o teste confere).
// Só grava sozinho quando é seguro: um lugar de posto (amenity fuel ou o estacionamento do posto) a até 30 km da cidade com quase todo
// o nome igual (nota >= 0,75, com uma palavra própria de 4+ letras em comum, sem contar o nome da cidade) e nenhum outro parecido em
// outro lugar. Respeita o uso gratuito do Nominatim: no máximo 15 postos por rodada, uma consulta a cada 1,2 s, e para ao primeiro
// "muitas consultas" (429/503/504). Posto sem resultado é tentado de novo depois de 30 dias.

export const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
export const USER_AGENT = 'GestaoCombustivel/1.0 (gestao-combustivel.pages.dev; coordenadas de postos de frota)';
export const TIPOS_POSTO = new Set(['fuel', 'parking']);
export const KM_DA_CIDADE = 30, POR_RODADA = 15, PAUSA_MS = 1200, REPETIR_DIAS = 30, NOTA_SEGURA = 0.75, NOTA_PARECIDA = 0.5;
const GENERICOS = new Set(['POSTO', 'POSTOS', 'AUTO', 'DE', 'DO', 'DA', 'DOS', 'DAS', 'E', 'LTDA', 'COMERCIO', 'COMBUSTIVEIS', 'COMBUSTIVEL',
  'DERIVADOS', 'PETROLEO', 'REDE', 'SA', 'ME', 'EIRELI', 'EPP', 'CIA', 'SERVICOS', 'GAS', 'LTD']);

// consolidador_historico.chave: sem acento (NFKD + só ASCII), maiúsculas, espaços juntados
export const chave = (s) => String(s ?? '').normalize('NFKD').replace(/[^\x00-\x7F]/g, '').toUpperCase().split(/\s+/).filter(Boolean).join(' ');

export function palavras(s) {
  return new Set((chave(s).match(/[A-Z0-9]+/g) || []).filter((t) => t.length > 1 && !GENERICOS.has(t)));
}

// parte do nome da Base que aparece no nome do mapa (0 a 1); as palavras do nome da cidade não contam -> [nota, comuns]
export function nota(nomeBase, nomeMapa, cidade = '') {
  const cid = palavras(cidade), b = palavras(nomeMapa);
  const a = [...palavras(nomeBase)].filter((t) => !cid.has(t));
  const comuns = a.filter((t) => b.has(t));
  return [a.length ? comuns.length / a.length : 0, comuns];
}

// nome como as pessoas chamam o posto: sem "REDE xx", "LTDA" e o que vem depois de " - " ou " | "
export function nomeLimpo(nome) {
  let s = chave(nome);
  s = s.split(/\s[-|]\s|\s\|/)[0];
  s = s.replace(/\bREDE\b.*$/, '');
  s = s.replace(/\b(LTDA|ME|EIRELI|EPP|S A|SA|E CIA|CIA)\b/g, ' ');
  return s.split(/\s+/).filter(Boolean).join(' ') || chave(nome);
}

export function distanciaKm(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lng2 - lng1) * r / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

// consultas ao Nominatim para um posto (o nome limpo e, se não começar com POSTO, "POSTO " + nome)
export function consultas(p) {
  const limpo = nomeLimpo(p.nome);
  return { limpo, nomes: [limpo, ...(limpo.startsWith('POSTO') ? [] : ['POSTO ' + limpo])] };
}
export function urlBusca(nome, p) {
  const q = new URLSearchParams({ format: 'jsonv2', limit: '6', countrycodes: 'br', q: nome + ', ' + p.cidade + ', ' + p.uf });
  return NOMINATIM + '?' + q.toString();
}

// achados = [{lat, lon, nome, categoria, tipo}] (sem repetidos) -> {seguro, resultado, detalhe, melhor}
export function escolher(p, limpo, achados, sede) {
  const mapa = achados.filter((m) => m.categoria === 'amenity' && TIPOS_POSTO.has(m.tipo) &&
    distanciaKm(m.lat, m.lon, sede[0], sede[1]) <= KM_DA_CIDADE);
  const notas = mapa.map((m) => { const [n, comuns] = nota(limpo, m.nome, p.cidade); return { n, comuns, m }; })
    .sort((x, y) => (y.n - x.n) || ((x.m.tipo !== 'fuel') - (y.m.tipo !== 'fuel')));
  const melhor = notas[0] || null;
  // o mesmo posto pode vir como posto e como estacionamento dele: só conta como "outro" se estiver a mais de 300 m
  const outros = melhor ? notas.slice(1).filter((x) => x.n >= NOTA_PARECIDA &&
    distanciaKm(x.m.lat, x.m.lon, melhor.m.lat, melhor.m.lon) > 0.3).length : 0;
  if (melhor && melhor.n >= NOTA_SEGURA && melhor.comuns.some((t) => t.length >= 4) && !outros) {
    return { seguro: true, resultado: 'seguro', detalhe: melhor.m.nome, melhor: melhor.m };
  }
  const detalhe = melhor ? 'melhor: ' + (melhor.m.nome || 'sem nome') + ' (' + melhor.n.toFixed(2) + ')' : 'nada com o nome "' + limpo + '" perto da cidade';
  return { seguro: false, resultado: outros ? 'ambiguo' : 'sem_match', detalhe, melhor: melhor ? melhor.m : null };
}

const dias = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
export function podeTentar(e, hoje) {
  if (!e) return true;
  // gravado mas ainda sem coordenada boa (gravação perdida): tenta de novo, a partir do dia seguinte (a lista de candidatos da nuvem
  // é refeita a cada 3 h; no vigia ela era lida na hora)
  if (e.resultado === 'gravado') return dias(e.tentado, hoje) >= 1;
  return dias(e.tentado, hoje) >= REPETIR_DIAS;
}

// Uma rodada. io: {candidatos(), ler(nome, padrao), gravar(nome, valor), buscarJson(url) -> lista do Nominatim (lança {status} em erro
// HTTP), esperar(ms), gravarLocal({nome, cidade, uf, lat, lon}) -> bool, hoje 'AAAA-MM-DD', ligado}
// Em simulação (ligado = false) nada é gravado: nem a coordenada nem o estado (senão o que seria gravado esperaria 30 dias).
export async function processar(io) {
  const candidatos = await io.candidatos();
  const estado = (await io.ler('estado', {})) || {};
  const fila = candidatos.filter((p) => podeTentar(estado[p.chave], io.hoje));
  const tentados = [], gravados = [], seguros = [];
  let parou = null;
  for (const p of fila.slice(0, POR_RODADA)) {
    if (!p.sede) {
      estado[p.chave] = { tentado: io.hoje, resultado: 'sem_cidade', detalhe: 'cidade não encontrada no IBGE' };
      continue;
    }
    const { limpo, nomes } = consultas(p);
    const vistos = new Set(), achados = [];
    let falha = null;
    for (let i = 0; i < nomes.length && !falha; i++) {
      if (i) await io.esperar(PAUSA_MS);
      try {
        for (const e of await io.buscarJson(urlBusca(nomes[i], p))) {
          if (vistos.has(e.place_id)) continue;
          vistos.add(e.place_id);
          achados.push({ lat: Number(e.lat), lon: Number(e.lon), nome: e.name || '', categoria: e.category, tipo: e.type });
        }
      } catch (err) { falha = err; }
    }
    if (falha) {
      if ([429, 503, 504].includes(falha.status)) { parou = 'OpenStreetMap ocupado (' + falha.status + '); continua na próxima rodada'; break; }
      if (falha.status) { estado[p.chave] = { tentado: io.hoje, resultado: 'erro', detalhe: 'HTTP ' + falha.status }; continue; }
      parou = 'sem resposta do OpenStreetMap (' + String(falha.message || falha).slice(0, 120) + '); continua na próxima rodada';
      break;
    }
    tentados.push(p.nome);
    const r = escolher(p, limpo, achados, p.sede);
    estado[p.chave] = { tentado: io.hoje, resultado: r.resultado, detalhe: r.detalhe };
    if (r.seguro) {
      const local = { nome: p.nome, cidade: p.cidade, uf: p.uf, lat: Math.round(r.melhor.lat * 1e6) / 1e6, lon: Math.round(r.melhor.lon * 1e6) / 1e6 };
      seguros.push({ ...local, mapa: r.melhor.nome });
      if (io.ligado) {
        if (await io.gravarLocal(local)) { estado[p.chave].resultado = 'gravado'; gravados.push({ nome: p.nome, mapa: r.melhor.nome }); }
        else delete estado[p.chave];   // não gravou: tenta de novo na próxima rodada
      }
    }
    await io.esperar(PAUSA_MS);
  }
  if (io.ligado) await io.gravar('estado', estado);
  return { candidatos: candidatos.length, naFila: Math.max(0, fila.length - tentados.length), tentados: tentados.length, seguros, gravados, aviso: parou };
}
