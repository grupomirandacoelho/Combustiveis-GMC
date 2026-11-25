"""Preços de revenda da ANP (Levantamento de Preços de Combustíveis) -> .dados/anp/anp.json, para o dashboard
"Preço x ANP". Só ÓLEO DIESEL S10, nos níveis Brasil, região, estado e município, semanal e mensal, desde 2023.

    py scripts/anp_precos.py atualizar          confere a ANP e refaz o arquivo se algo mudou
    py scripts/anp_precos.py atualizar --forcar baixa e processa tudo de novo

Quem chama é o vigia (scripts/sincronizar.mjs), de hora em hora. De onde vêm os dados (os mesmos do painel
Power BI da ANP):
  - série histórica (gov.br/anp ... /serie-historica-do-levantamento-de-precos): arquivos semanal-* e mensal-*;
  - últimas semanas pesquisadas (... /levantamento-de-precos-de-combustiveis-ultimas-semanas-pesquisadas):
    resumo_semanal_lpc_*.xlsx, que sai antes de a série histórica ser atualizada.
Cada arquivo só é baixado de novo quando o tamanho (ou ETag) informado pelo servidor muda; o resultado já
processado de cada um fica em .dados/anp/cache. Saída: uma linha JSON no stdout.
"""
import datetime as dt
import hashlib
import json
import os
import re
import sys
import unicodedata
import urllib.parse
import urllib.request

import openpyxl

PASTA_PROJETO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PASTA = os.path.join(PASTA_PROJETO, '.dados', 'anp')
CACHE = os.path.join(PASTA, 'cache')
ARQUIVOS = os.path.join(PASTA, 'arquivos')
ESTADO = os.path.join(PASTA, 'estado.json')
SAIDA = os.path.join(PASTA, 'anp.json')

BASE_ANP = 'https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/'
PAG_SERIE = BASE_ANP + 'precos-revenda-e-de-distribuicao-combustiveis/serie-historica-do-levantamento-de-precos'
PAG_SEMANAS = BASE_ANP + 'levantamento-de-precos-de-combustiveis-ultimas-semanas-pesquisadas'
DESDE = dt.date(2023, 1, 1)          # a Base de transações começa em fev/2023
PRODUTO = 'OLEO DIESEL S10'
VERSAO_FORMATO = 1                   # muda quando o processamento muda (refaz o cache)

# UF -> (nome como a ANP escreve, região)
UFS = {
    'AC': ('ACRE', 'NORTE'), 'AL': ('ALAGOAS', 'NORDESTE'), 'AP': ('AMAPA', 'NORTE'), 'AM': ('AMAZONAS', 'NORTE'),
    'BA': ('BAHIA', 'NORDESTE'), 'CE': ('CEARA', 'NORDESTE'), 'DF': ('DISTRITO FEDERAL', 'CENTRO OESTE'),
    'ES': ('ESPIRITO SANTO', 'SUDESTE'), 'GO': ('GOIAS', 'CENTRO OESTE'), 'MA': ('MARANHAO', 'NORDESTE'),
    'MT': ('MATO GROSSO', 'CENTRO OESTE'), 'MS': ('MATO GROSSO DO SUL', 'CENTRO OESTE'), 'MG': ('MINAS GERAIS', 'SUDESTE'),
    'PA': ('PARA', 'NORTE'), 'PB': ('PARAIBA', 'NORDESTE'), 'PR': ('PARANA', 'SUL'), 'PE': ('PERNAMBUCO', 'NORDESTE'),
    'PI': ('PIAUI', 'NORDESTE'), 'RJ': ('RIO DE JANEIRO', 'SUDESTE'), 'RN': ('RIO GRANDE DO NORTE', 'NORDESTE'),
    'RS': ('RIO GRANDE DO SUL', 'SUL'), 'RO': ('RONDONIA', 'NORTE'), 'RR': ('RORAIMA', 'NORTE'),
    'SC': ('SANTA CATARINA', 'SUL'), 'SP': ('SAO PAULO', 'SUDESTE'), 'SE': ('SERGIPE', 'NORDESTE'),
    'TO': ('TOCANTINS', 'NORTE'),
}
REGIOES = ['NORTE', 'NORDESTE', 'CENTRO OESTE', 'SUDESTE', 'SUL']


def chave(s):
    s = unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().upper()
    return ' '.join(s.replace('-', ' ').split())


UF_POR_NOME = {chave(nome): uf for uf, (nome, _) in UFS.items()}


def saida(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')


def pedido(url, cabecalhos=None, metodo='GET'):
    """Pedido ao gov.br. No GitHub Actions (variável ANP_PROXY) passa pela ponte em São Paulo (Edge Function proxy-anp, chave
    CHAVE_NUVEM): o gov.br derruba as conexões de fora do Brasil (25/11/2026). No vigia vai direto, como antes."""
    cab = {'User-Agent': 'Mozilla/5.0 (portal gestao-combustivel)', **(cabecalhos or {})}
    ponte = os.environ.get('ANP_PROXY')
    if ponte:
        cab.update({'x-chave-nuvem': os.environ.get('CHAVE_NUVEM', ''), 'x-region': 'sa-east-1'})
        url = ponte + ('&' if '?' in ponte else '?') + 'url=' + urllib.parse.quote(url, safe='')
    return urllib.request.Request(url, method=metodo, headers=cab)


def pedir(url, metodo='GET'):
    return urllib.request.urlopen(pedido(url, metodo=metodo), timeout=180)


def links(pagina, padrao):
    """Endereços de .xlsx da página que batem com o padrão."""
    with pedir(pagina) as r:
        html = r.read().decode('utf-8', 'ignore')
    return sorted({u for u in re.findall(r'href="(https://[^"]+?\.xlsx)"', html) if re.search(padrao, u)})


def arquivos_serie():
    """Arquivos .xlsx da série histórica que cobrem 2023 em diante (Brasil/regiões/estados desde 2013 e
    municípios por faixa de anos)."""
    escolhidos = []
    for u in links(PAG_SERIE, r'/shlp/(semanal|mensal)/[^/]+\.xlsx$'):
        nome = u.rsplit('/', 1)[-1].lower()
        anos = [int(a) for a in re.findall(r'(20\d\d)', nome)]
        if 'municip' in nome:
            if anos and max(anos) >= DESDE.year:
                escolhidos.append(u)
        elif re.search(r'(brasil|regioes|estados)', nome):
            escolhidos.append(u)
    return escolhidos


def data_do_nome(u):
    m = re.search(r'(\d{4})-(\d{2})-(\d{1,2})', u.rsplit('/', 1)[-1])
    return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def assinatura(u):
    """Tamanho total do arquivo no servidor, sem baixá-lo: o gov.br recusa HEAD (403), então pede 1 byte (Range)
    e lê o total em Content-Range. Os arquivos da série crescem a cada semana/mês publicado."""
    try:
        req = pedido(u, {'Range': 'bytes=0-0'})
        with urllib.request.urlopen(req, timeout=60) as r:
            total = (r.headers.get('Content-Range') or '').rsplit('/', 1)[-1] or r.headers.get('Content-Length')
            return '|'.join([total or '', r.headers.get('ETag') or '', r.headers.get('Last-Modified') or ''])
    except Exception:
        return None


def baixar(u):
    os.makedirs(ARQUIVOS, exist_ok=True)
    destino = os.path.join(ARQUIVOS, u.rsplit('/', 1)[-1])
    tmp = destino + '.baixando'
    with pedir(u) as r, open(tmp, 'wb') as f:
        while True:
            bloco = r.read(1 << 20)
            if not bloco:
                break
            f.write(bloco)
    os.replace(tmp, destino)
    return destino


def num(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    try:
        return float(str(v).replace(',', '.'))
    except (TypeError, ValueError):
        return None


def processar(caminho):
    """Linhas de ÓLEO DIESEL S10 de um arquivo da ANP: [per, nivel, local, inicio(ISO), preco, postos, min, max]."""
    wb = openpyxl.load_workbook(caminho, read_only=True, data_only=True)
    linhas = []
    try:
        for ws in wb.worksheets:
            if chave(ws.title).startswith('CAPITAIS'):
                continue   # o resumo semanal repete as capitais na aba de municípios
            cab = None
            for r in ws.iter_rows(values_only=True):
                if cab is None:
                    if r and any(isinstance(c, str) and chave(c) == 'PRODUTO' for c in r):
                        cab = [chave(c) for c in r]
                        col = lambda *nomes: next((cab.index(n) for n in nomes if n in cab), None)   # noqa: E731
                        i_ini, i_mes = col('DATA INICIAL'), col('MES')
                        i_reg, i_est, i_mun = col('REGIAO'), col('ESTADO', 'ESTADOS'), col('MUNICIPIO')
                        i_prod, i_postos = col('PRODUTO'), col('NUMERO DE POSTOS PESQUISADOS')
                        i_preco, i_min, i_max = col('PRECO MEDIO REVENDA'), col('PRECO MINIMO REVENDA'), col('PRECO MAXIMO REVENDA')
                        if i_preco is None or (i_ini is None and i_mes is None):
                            cab = None   # cabeçalho de outro tipo de tabela
                    continue
                if not r or chave(r[i_prod]) != PRODUTO:
                    continue
                quando = r[i_ini] if i_ini is not None else r[i_mes]
                if not isinstance(quando, dt.datetime) or quando.date() < DESDE:
                    continue
                preco = num(r[i_preco])
                if not preco or not (2 < preco < 20):
                    continue
                per = 'semanal' if i_ini is not None else 'mensal'
                if i_mun is not None:
                    uf = UF_POR_NOME.get(chave(r[i_est]))
                    if not uf:
                        continue
                    nivel, local = 'municipio', uf + '|' + chave(r[i_mun])
                elif i_est is not None:
                    uf = UF_POR_NOME.get(chave(r[i_est]))
                    if not uf:
                        continue
                    nivel, local = 'estado', uf
                elif i_reg is not None:
                    nivel, local = 'regiao', chave(r[i_reg])
                else:
                    nivel, local = 'brasil', 'BRASIL'
                inicio = quando.date() if per == 'semanal' else quando.date().replace(day=1)
                linhas.append([per, nivel, local, inicio.isoformat(), round(preco, 3),
                               int(num(r[i_postos]) or 0), num(r[i_min]) if i_min is not None else None,
                               num(r[i_max]) if i_max is not None else None])
    finally:
        wb.close()
    return linhas


def ler_estado():
    try:
        with open(ESTADO, encoding='utf-8') as f:
            e = json.load(f)
        if e.get('formato') == VERSAO_FORMATO:
            return e
    except (OSError, ValueError):
        pass
    return {'formato': VERSAO_FORMATO, 'arquivos': {}}


def cache_de(u):
    return os.path.join(CACHE, hashlib.sha1(u.encode()).hexdigest()[:16] + '.json')


def guardar_cache(u, linhas):
    with open(cache_de(u), 'w', encoding='utf-8') as f:
        json.dump(linhas, f)


def montar_saida(registros):
    """registros: {(per, nivel, local, inicio): [preco, postos, min, max]} -> formato colunar compacto."""
    dia = lambda iso: (dt.date.fromisoformat(iso) - dt.date(1970, 1, 1)).days   # noqa: E731
    mil = lambda v: None if v is None else round(v * 1000)                        # noqa: E731
    muns = sorted({k[2] for k in registros if k[1] == 'municipio'})
    idx = {
        'brasil': {'BRASIL': 0},
        'regiao': {r: i for i, r in enumerate(REGIOES)},
        'estado': {u: i for i, u in enumerate(sorted(UFS))},
        'municipio': {m: i for i, m in enumerate(muns)},
    }
    series = {}
    for (per, nivel, local, inicio), (preco, postos, mn, mx) in sorted(registros.items(), key=lambda x: (x[0][3], x[0][2])):
        i = idx[nivel].get(local)
        if i is None:
            continue
        s = series.setdefault(per, {}).setdefault(nivel, {'l': [], 'p': [], 'v': [], 'n': [], 'mn': [], 'mx': []})
        s['l'].append(i); s['p'].append(dia(inicio)); s['v'].append(mil(preco)); s['n'].append(postos)
        s['mn'].append(mil(mn)); s['mx'].append(mil(mx))
    resumo = {}
    for per, niveis in series.items():
        b = niveis.get('brasil')
        resumo[per] = {'ultimo': max(b['p']) if b else None, 'periodos': len(set(b['p'])) if b else 0}
    corpo = {
        'produto': 'ÓLEO DIESEL S10', 'desde': DESDE.isoformat(), 'unidade': 'R$/L x 1000',
        'locais': {
            'regiao': REGIOES,
            'estado': [[u, UFS[u][0], REGIOES.index(UFS[u][1])] for u in sorted(UFS)],
            'municipio': [m.split('|') for m in muns],
        },
        'series': series, 'resumo': resumo,
    }
    texto = json.dumps(corpo, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    return corpo, hashlib.sha1(texto.encode()).hexdigest()[:12]


def atualizar(forcar=False):
    os.makedirs(CACHE, exist_ok=True)
    estado = ler_estado()
    vistos = estado['arquivos']
    baixados = []
    try:
        serie = arquivos_serie()
    except Exception as e:
        return saida({'erro': f'Não consegui abrir a página da série histórica da ANP: {e}'})
    if not serie:
        return saida({'erro': 'A página da série histórica da ANP não trouxe nenhum arquivo (o site pode ter mudado).'})
    # 1) série histórica: baixa só o que mudou no servidor
    for u in serie:
        ass = assinatura(u)
        info = vistos.get(u)
        if not forcar and info and ass and info.get('assinatura') == ass and os.path.isfile(cache_de(u)):
            continue
        linhas = processar(baixar(u))
        guardar_cache(u, linhas)
        vistos[u] = {'assinatura': ass, 'linhas': len(linhas), 'em': dt.datetime.now().isoformat(timespec='seconds')}
        baixados.append(u.rsplit('/', 1)[-1])
    # 2) resumos das últimas semanas mais novos que a série histórica (a série demora alguns dias a incluir a semana)
    ultima_serie = None
    for u in serie:
        if '/semanal/' in u and os.path.isfile(cache_de(u)):
            with open(cache_de(u), encoding='utf-8') as f:
                for l in json.load(f):
                    if l[1] == 'brasil':
                        ultima_serie = max(ultima_serie or l[3], l[3])
    try:
        resumos = links(PAG_SEMANAS, r'resumo_semanal_lpc_[^/]+\.xlsx$')
    except Exception:
        resumos = []
    usados = []
    for u in resumos:
        d = data_do_nome(u)
        if not d or (ultima_serie and d.isoformat() <= ultima_serie):
            continue
        if forcar or u not in vistos or not os.path.isfile(cache_de(u)):
            guardar_cache(u, processar(baixar(u)))
            vistos[u] = {'em': dt.datetime.now().isoformat(timespec='seconds')}
            baixados.append(u.rsplit('/', 1)[-1])
        usados.append(u)
    # 3) junta tudo (resumo semanal por último: vale sobre a série para a mesma semana)
    registros = {}
    for u in serie + usados:
        try:
            with open(cache_de(u), encoding='utf-8') as f:
                for per, nivel, local, inicio, preco, postos, mn, mx in json.load(f):
                    registros[(per, nivel, local, inicio)] = [preco, postos, mn, mx]
        except (OSError, ValueError):
            continue
    if not registros:
        return saida({'erro': 'Nenhum preço de diesel S10 encontrado nos arquivos da ANP.'})
    corpo, versao = montar_saida(registros)
    mudou = forcar or versao != estado.get('versao') or not os.path.isfile(SAIDA)
    if mudou:
        corpo['versao'] = versao
        corpo['geradoEm'] = dt.datetime.now().isoformat(timespec='seconds')
        corpo['fontes'] = [PAG_SERIE, PAG_SEMANAS]
        tmp = SAIDA + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(corpo, f, ensure_ascii=False, separators=(',', ':'))
        os.replace(tmp, SAIDA)
    estado['versao'] = versao
    estado['conferidoEm'] = dt.datetime.now().isoformat(timespec='seconds')
    with open(ESTADO, 'w', encoding='utf-8') as f:
        json.dump(estado, f, ensure_ascii=False, indent=1)
    dia_iso = lambda d: (dt.date(1970, 1, 1) + dt.timedelta(days=d)).isoformat() if d is not None else None   # noqa: E731
    saida({'mudou': mudou, 'versao': versao, 'baixados': baixados,
           'ultimaSemana': dia_iso(corpo['resumo'].get('semanal', {}).get('ultimo')),
           'ultimoMes': dia_iso(corpo['resumo'].get('mensal', {}).get('ultimo')),
           'tamanho': os.path.getsize(SAIDA)})


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) >= 2 and sys.argv[1] == 'atualizar':
        atualizar('--forcar' in sys.argv)
    else:
        print(__doc__)
        sys.exit(1)
