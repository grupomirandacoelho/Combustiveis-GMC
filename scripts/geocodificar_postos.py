"""Busca automática de coordenadas dos postos sem coordenada (Mapa de calor), pelo OpenStreetMap.

    py scripts/geocodificar_postos.py rodar          tenta alguns postos (o vigia chama de hora em hora)
    py scripts/geocodificar_postos.py listar         só mostra os postos que seriam tentados (sem internet)

Postos considerados: os dos abastecimentos de DIESEL em postos externos (TIPO ESTABELECIMENTO = POSTO DE COMBUSTIVEL),
sem os do centro de custo RAJA ADM e sem os dos motoristas do administrativo (MOTORISTAS_FORA), que não estão na planilha
LOCALIZAÇÃO DOS POSTOS com uma coordenada válida (as suspeitas, longe da cidade, entram). Para cada um, procura no
Nominatim (busca do OpenStreetMap) pelo nome do posto na cidade dele (nome_limpo: sem "REDE xx", "LTDA"...; e com "POSTO"
na frente, se não tiver). Só grava sozinho quando é seguro: um lugar de posto (amenity fuel ou o estacionamento do posto)
a até 30 km da cidade com quase todo o nome igual (nota >= 0,75, com uma palavra própria de 4+ letras em comum, sem contar
o nome da cidade) e nenhum outro parecido em outro lugar. O resto fica para o cadastro no site (que mostra as mesmas buscas
como sugestão). Grava pela scripts/planilha_locais.py (cópia antes). Respeita o uso gratuito do Nominatim: no máximo
POR_RODADA postos por chamada, uma consulta a cada 1,2 s, e para ao primeiro "muitas consultas" (429/503/504). Posto sem
resultado é tentado de novo depois de 30 dias.
Saída: uma linha JSON no stdout.
"""
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

import consolidador_historico as ch   # leitura rápida da aba Transações (cópia)
import importar_base as ib            # coordenada(), sedes_municipios(), distancia_km(), LOCAIS_PADRAO
import planilha_cartoes as pc

PASTA_PROJETO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PASTA = os.path.join(PASTA_PROJETO, '.dados', 'geo')
CANDIDATOS = os.path.join(PASTA, 'candidatos.json')
ESTADO = os.path.join(PASTA, 'estado.json')
NOMINATIM = 'https://nominatim.openstreetmap.org/search'
NAVEGADOR = {'User-Agent': 'GestaoCombustivel/1.0 (gestao-combustivel.pages.dev; coordenadas de postos de frota)'}
MOTORISTAS_FORA = {'CAIO COELHO DUTRA', 'JACY RODRIGUES COELHO'}   # administrativo, não operação (pedido do usuário)
CC_FORA = {'RAJA ADM'}
TIPOS_POSTO = {'fuel', 'parking'}   # o posto ou o estacionamento dele ("Estacionamento Posto Ferrari")
KM_DA_CIDADE = 30
POR_RODADA = 15   # cerca de 30 consultas: a rodada segura o vigia por menos de 1 minuto
PAUSA_S = 1.2     # regra de uso do Nominatim: no máximo 1 consulta por segundo
REPETIR_DIAS = 30
NOTA_SEGURA, NOTA_PARECIDA = 0.75, 0.5
GENERICOS = {'POSTO', 'POSTOS', 'AUTO', 'DE', 'DO', 'DA', 'DOS', 'DAS', 'E', 'LTDA', 'COMERCIO', 'COMBUSTIVEIS', 'COMBUSTIVEL',
             'DERIVADOS', 'PETROLEO', 'REDE', 'SA', 'ME', 'EIRELI', 'EPP', 'CIA', 'SERVICOS', 'GAS', 'LTD'}
chave = ch.chave


def saida(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')


def palavras(s):
    return {t for t in re.findall(r'[A-Z0-9]+', chave(s)) if len(t) > 1 and t not in GENERICOS}


def nota(nome_base, nome_mapa, cidade=''):
    """Parte do nome da Base que aparece no nome do mapa (0 a 1); as palavras do nome da cidade não contam."""
    a, b = palavras(nome_base) - palavras(cidade), palavras(nome_mapa)
    return (len(a & b) / len(a)) if a else 0.0, a & b


def ler_json(caminho, padrao):
    try:
        with open(caminho, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return padrao


def gravar_json(caminho, obj):
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    with open(caminho, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False)


def candidatos():
    """Postos de diesel da operação (Base), refeitos só quando a Base muda: {NOME: {nome, cidade, uf, n}}."""
    st = os.stat(ch.BASE)
    assinatura = f'{st.st_mtime}|{st.st_size}'
    guardado = ler_json(CANDIDATOS, {})
    if guardado.get('assinatura') == assinatura:
        return guardado['postos']
    tmp = tempfile.mkdtemp(prefix='geo-')
    postos = {}
    try:
        for r in ch.ler(ch.BASE, tmp, 'base.xlsx'):
            # tipo do estabelecimento em branco também é posto externo (há abastecimentos assim na Base)
            if not r[21] or not chave(r[13]).startswith('DIESEL') or chave(r[22]) not in ('POSTO DE COMBUSTIVEL', ''):
                continue
            if chave(r[11]) in MOTORISTAS_FORA or chave(r[29]) in CC_FORA:
                continue
            p = postos.setdefault(chave(r[21]), {'nome': str(r[21]).strip().upper(), 'n': 0})
            p['n'] += 1
            p['cidade'], p['uf'] = str(r[25] or '').strip().upper(), str(r[26] or '').strip().upper()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    gravar_json(CANDIDATOS, {'assinatura': assinatura, 'postos': postos})
    return postos


def com_coordenada():
    """Nomes que já têm coordenada boa na LOCALIZAÇÃO (a mesma regra do importar_base: válida e perto da cidade)."""
    caminho = os.environ.get('PLANILHA_LOCAIS') or ib.LOCAIS_PADRAO
    tmp = tempfile.mkdtemp(prefix='geo-')
    try:
        copia = os.path.join(tmp, 'locais.xlsx')
        shutil.copy2(pc.legivel(caminho, 'locais')[0], copia)
        with zipfile.ZipFile(copia) as arq:
            textos, _ = pc.ler_compartilhados(arq)
            xml = arq.read(pc.caminho_aba(arq, 'Localização dos postos'))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    sedes = ib.sedes_municipios()
    bons = set()
    for r, v in pc.ler_aba(xml, textos, {'A', 'D', 'E', 'H', 'I'}).items():
        if r == 1 or not v.get('A'):
            continue
        lat, lon = ib.coordenada(v.get('H'), True), ib.coordenada(v.get('I'), False)
        if lat is None or lon is None:
            continue
        sede = sedes.get((ib.chave_cidade(v.get('D') or ''), str(v.get('E') or '').upper()))
        if sede and ib.distancia_km(lat, lon, sede[0], sede[1]) > ib.LIMITE_KM_CIDADE:
            continue
        bons.add(chave(v['A']))
    return bons


def nome_limpo(nome):
    """Nome da Base como as pessoas chamam o posto: sem "REDE xx", "LTDA" e o que vem depois de " - " ou " | "
    (ex.: "POSTO FERRARI REDE HG" -> "POSTO FERRARI"; "DP LEME - REDE DOM PEDRO | SP-RODOVIA" -> "DP LEME")."""
    s = chave(nome)
    s = re.split(r'\s[-|]\s|\s\|', s)[0]
    s = re.sub(r'\bREDE\b.*$', '', s)
    s = re.sub(r'\b(LTDA|ME|EIRELI|EPP|S A|SA|E CIA|CIA)\b', ' ', s)
    return ' '.join(s.split()) or chave(nome)


def buscar_por_nome(p):
    """Lugares do OpenStreetMap com o nome do posto na cidade dele (Nominatim, no máximo 2 consultas por posto)."""
    limpo = nome_limpo(p['nome'])
    consultas = [limpo] + ([] if limpo.startswith('POSTO') else ['POSTO ' + limpo])
    vistos, lista = set(), []
    for i, nome in enumerate(consultas):
        if i:
            time.sleep(PAUSA_S)
        q = urllib.parse.urlencode({'format': 'jsonv2', 'limit': 6, 'countrycodes': 'br', 'q': f"{nome}, {p['cidade']}, {p['uf']}"})
        with urllib.request.urlopen(urllib.request.Request(NOMINATIM + '?' + q, headers=NAVEGADOR), timeout=30) as r:
            for e in json.loads(r.read().decode('utf-8')):
                if e.get('place_id') in vistos:
                    continue
                vistos.add(e.get('place_id'))
                lista.append({'lat': float(e['lat']), 'lon': float(e['lon']), 'nome': e.get('name') or '',
                              'categoria': e.get('category'), 'tipo': e.get('type')})
    return limpo, lista


def rodar(so_listar=False):
    postos = candidatos()
    bons = com_coordenada()
    estado = ler_json(ESTADO, {})
    hoje = dt.date.today()

    def pode_tentar(k):
        e = estado.get(k)
        if not e:
            return True
        if e.get('resultado') == 'gravado':
            return True   # gravado mas sem coordenada na planilha (gravação perdida, ex.: planilha restaurada): tenta de novo
        return (hoje - dt.date.fromisoformat(e['tentado'])).days >= REPETIR_DIAS
    fila = sorted((p for k, p in postos.items() if k not in bons and pode_tentar(k)), key=lambda p: -p['n'])
    if so_listar:
        return saida({'semCoordenada': sum(1 for k in postos if k not in bons), 'naFila': len(fila),
                      'proximos': [f"{p['nome']} ({p['cidade']} - {p['uf']})" for p in fila[:POR_RODADA]]})
    sedes = ib.sedes_municipios()
    seguros, tentados, parou = [], [], None
    for p in fila[:POR_RODADA]:
        sede = sedes.get((ib.chave_cidade(p['cidade']), p['uf']))
        k = chave(p['nome'])
        if not sede:
            estado[k] = {'tentado': hoje.isoformat(), 'resultado': 'sem_cidade', 'detalhe': 'cidade não encontrada no IBGE'}
            continue
        try:
            limpo, achados = buscar_por_nome(p)
        except urllib.error.HTTPError as e:
            if e.code in (429, 503, 504):
                parou = f'OpenStreetMap ocupado ({e.code}); continua na próxima rodada'
                break
            estado[k] = {'tentado': hoje.isoformat(), 'resultado': 'erro', 'detalhe': f'HTTP {e.code}'}
            continue
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            parou = f'sem resposta do OpenStreetMap ({e}); continua na próxima rodada'
            break
        tentados.append(p['nome'])
        # só lugares de posto (o posto ou o estacionamento dele) perto da cidade contam
        mapa = [m for m in achados if m['categoria'] == 'amenity' and m['tipo'] in TIPOS_POSTO
                and ib.distancia_km(m['lat'], m['lon'], sede[0], sede[1]) <= KM_DA_CIDADE]
        notas = sorted(((*nota(limpo, m['nome'], p['cidade']), m) for m in mapa), key=lambda x: (-x[0], x[2]['tipo'] != 'fuel'))
        melhor = notas[0] if notas else None
        # o mesmo posto pode vir como posto e como estacionamento dele: só conta como "outro" se estiver a mais de 300 m
        outros_parecidos = sum(1 for n, _, m in notas[1:] if n >= NOTA_PARECIDA and
                               ib.distancia_km(m['lat'], m['lon'], melhor[2]['lat'], melhor[2]['lon']) > 0.3)
        if melhor and melhor[0] >= NOTA_SEGURA and any(len(t) >= 4 for t in melhor[1]) and not outros_parecidos:
            seguros.append({'id': -(len(seguros) + 1), 'nome': p['nome'], 'cidade': p['cidade'], 'uf': p['uf'],
                            'lat': round(melhor[2]['lat'], 6), 'lon': round(melhor[2]['lon'], 6), '_mapa': melhor[2]['nome']})
            estado[k] = {'tentado': hoje.isoformat(), 'resultado': 'seguro', 'detalhe': melhor[2]['nome']}
        else:
            det = (f"melhor: {melhor[2]['nome'] or 'sem nome'} ({melhor[0]:.2f})" if melhor else f'nada com o nome "{limpo}" perto da cidade')
            estado[k] = {'tentado': hoje.isoformat(), 'resultado': 'ambiguo' if outros_parecidos else 'sem_match', 'detalhe': det}
        time.sleep(PAUSA_S)
    gravados = []
    if seguros:
        arq = os.path.join(PASTA, 'seguros.json')
        gravar_json(arq, [{k: v for k, v in s.items() if not k.startswith('_')} for s in seguros])
        try:
            out = subprocess.run([sys.executable, os.path.join(PASTA_PROJETO, 'scripts', 'planilha_locais.py'), 'gravar', arq],
                                 capture_output=True, text=True, encoding='utf-8', cwd=PASTA_PROJETO, timeout=300)
            r = json.loads(out.stdout.strip().splitlines()[-1])
        finally:
            os.remove(arq)
        por_id = {i['id']: i for i in r.get('itens', [])}
        for s in seguros:
            i = por_id.get(s['id'], {})
            if i.get('estado') == 'aplicada':
                # cidade, UF e coordenada: o vigia manda também ao banco (/api/sync/locais/banco; 15.3, 25/11/2026)
                gravados.append({'nome': s['nome'], 'linha': i.get('linha'), 'mapa': s['_mapa'], 'cidade': s['cidade'], 'uf': s['uf'],
                                 'lat': s['lat'], 'lon': s['lon']})
                estado[chave(s['nome'])]['resultado'] = 'gravado'
            else:   # planilha aberta ou erro: tenta de novo na próxima rodada
                estado.pop(chave(s['nome']), None)
                parou = parou or i.get('mensagem')
    gravar_json(ESTADO, estado)
    saida({'tentados': len(tentados), 'gravados': gravados, 'naFila': max(0, len(fila) - len(tentados)), 'aviso': parou})


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) >= 2 and sys.argv[1] in ('rodar', 'listar'):
        try:
            rodar(sys.argv[1] == 'listar')
        except Exception as e:   # o vigia lê o erro na saída
            saida({'erro': str(e)})
    else:
        print(__doc__)
        sys.exit(1)
