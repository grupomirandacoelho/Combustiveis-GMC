"""Planilha dos cartões frota (pasta CONTROLES, "CONTROLE CARTÕES FROTA.xlsx") <-> portal.

    py scripts/planilha_cartoes.py gerar                      lista para o portal (.dados/cartoes.json)
    py scripts/planilha_cartoes.py gravar <alteracoes.json>   grava as alterações feitas no portal
    py scripts/planilha_cartoes.py sincronizar                acerta as placas pelo cadastro de placas (aba Carros)

Quem chama é o vigia (scripts/sincronizar.mjs).

Por que não usa o openpyxl: a aba CARTÕES tem ~180 placas, mas as colunas A:D estão formatadas até a linha
1.048.504. O XML dela tem 150 MB e o openpyxl leva quase 1 minuto só para ler (e não daria para regravar).
Aqui o arquivo é lido e alterado direto no XML: só as células das linhas mexidas mudam; o resto do arquivo
(aba Planilha1 com os PROCX na Base, formatação condicional, vínculos externos) fica igual.

Cuidados ao gravar (os mesmos da planilha de placas e motoristas):
  - a linha é achada pela placa (coluna A); placa nova vai para a primeira linha depois da última placa;
  - se a planilha estiver aberta no Excel, não grava e devolve "aguardando" (o vigia tenta de novo);
  - antes de gravar, guarda uma cópia em .dados\\copias-planilha (as 10 mais recentes: o arquivo tem 18 MB);
  - confere o cabeçalho (PLACA, TICKET, TRUCKPAG, VELOE): se as colunas mudaram de lugar, não grava nada;
  - depois de montar o arquivo novo, lê de novo e confere os valores antes de trocar o original.
Saída: uma linha JSON no stdout.
"""
import datetime as dt
import glob
import hashlib
import html
import json
import os
import re
import shutil
import sys
import time
import unicodedata
import zipfile

PASTA_PROJETO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COPIAS = os.path.join(PASTA_PROJETO, '.dados', 'copias-planilha')
SAIDA = os.path.join(PASTA_PROJETO, '.dados', 'cartoes.json')
ABA = 'CARTÕES'
ABA_PLACAS = 'Placas MERCOSUL'   # a mesma placa escrita de jeitos diferentes em cada sistema (Base, Ticket, TruckPag, Veloe)
# coluna -> campo do portal (lib/cartoes.js)
COLUNAS = [('A', 'PLACA', 'placa'), ('B', 'TICKET', 'ticket'), ('C', 'TRUCKPAG', 'truckpag'), ('D', 'VELOE', 'veloe')]
GUARDAR_COPIAS = 10
# ligação com o cadastro de placas (aba Carros): ficam no controle as placas ATIVAS destas categorias (as que têm motor).
# Mesma lista de lib/cartoes.js (CATEGORIAS_COM_CARTAO). Carreta e VENDA ficam fora (picape entrou em 06/10/2026).
CATEGORIAS_COM_CARTAO = {'CAVALO', 'TRUCK', 'TOCO', 'BITRUCK', '3/4', 'PICAPE'}
# placas que já apareceram no cadastro alguma vez: placa do controle fora do cadastro só sai se já esteve nele
# (caminhão novo, ainda não cadastrado, fica no controle com o aviso "fora do cadastro")
VISTAS = os.path.join(PASTA_PROJETO, '.dados', 'cartoes-placas-vistas.json')


def chave(s):
    return ' '.join(unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().upper().split())


def norm_placa(v):
    return re.sub(r'[^A-Z0-9]', '', str(v or '').upper())


def saida(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')


def planilha():
    if os.environ.get('PLANILHA_CARTOES'):
        return os.environ['PLANILHA_CARTOES']
    achados = [p for p in glob.glob(os.path.join(PASTA_PROJETO, 'CONTROLES', '*.xlsx'))
               if not os.path.basename(p).startswith('~$') and 'conflict' not in os.path.basename(p).lower() and 'CARTO' in chave(os.path.basename(p))]
    return sorted(achados)[0] if achados else None


def planilha_aberta(caminho):
    pasta, nome = os.path.split(caminho)
    if os.path.exists(os.path.join(pasta, '~$' + nome)) or os.path.exists(os.path.join(pasta, '~$' + nome[2:])):
        return True
    try:
        with open(caminho, 'r+b'):
            return False
    except PermissionError:
        return True


def _resumo(caminho):
    h = hashlib.sha256()
    with open(caminho, 'rb') as f:
        for bloco in iter(lambda: f.read(1 << 20), b''):
            h.update(bloco)
    return h.hexdigest()


def substituir(tmp, caminho, copia=None, tentativas=3):
    """Põe o arquivo gravado (tmp) no lugar da planilha e confere byte a byte. Na pasta do ownCloud a planilha já ficou
    com o conteúdo misturado depois de gravada (LOCALIZAÇÃO em 07/10/2026): se não bater, grava de novo; se continuar
    errado, volta a cópia de segurança (quando houver) e avisa com erro."""
    esperado = _resumo(tmp)
    for i in range(tentativas):
        if i:
            time.sleep(3)
        shutil.copyfile(tmp, caminho)
        try:
            # confere logo depois e de novo alguns segundos depois (o ownCloud já cortou arquivo depois de gravado)
            if all(not time.sleep(s) and _resumo(caminho) == esperado and zipfile.is_zipfile(caminho) for s in (1, 5)):
                return
        except OSError:
            pass
    if copia:
        shutil.copyfile(copia, caminho)
    raise OSError(f'a planilha {os.path.basename(caminho)} não ficou igual ao que foi gravado' +
                  (' (a cópia de segurança foi posta de volta)' if copia else ''))


def legivel(caminho, prefixo_copia):
    """A planilha, se ela abre como xlsx; senão a cópia de segurança mais recente (COPIAS/<prefixo>-*.xlsx) que abre.
    Devolve (caminho, aviso): o aviso diz que a planilha está estragada e de qual cópia os dados vieram."""
    if zipfile.is_zipfile(caminho):
        return caminho, None
    for c in sorted(glob.glob(os.path.join(COPIAS, prefixo_copia + '-*.xlsx')), reverse=True):
        if 'CORROMPIDA' not in c and zipfile.is_zipfile(c):
            return c, (f'a planilha {os.path.basename(caminho)} não abre (arquivo estragado); usando a cópia '
                       f'{os.path.basename(c)}. Restaure a planilha a partir dessa cópia.')
    return caminho, None


def guardar_copia(caminho):
    os.makedirs(COPIAS, exist_ok=True)
    destino = os.path.join(COPIAS, 'cartoes-' + dt.datetime.now().strftime('%Y%m%d-%H%M%S') + '.xlsx')
    shutil.copy2(caminho, destino)
    for velho in sorted(glob.glob(os.path.join(COPIAS, 'cartoes-*.xlsx')))[:-GUARDAR_COPIAS]:
        try:
            os.remove(velho)
        except OSError:
            pass
    return destino


# ---------------- leitura do pacote xlsx ----------------
def caminho_aba(z, nome):
    """Arquivo XML da aba pelo nome (workbook.xml + rels)."""
    wb = z.read('xl/workbook.xml').decode('utf-8')
    rels = z.read('xl/_rels/workbook.xml.rels').decode('utf-8')
    alvo = {}
    for m in re.finditer(r'<Relationship\b[^>]*>', rels):
        i, t = re.search(r'Id="([^"]+)"', m.group(0)), re.search(r'Target="([^"]+)"', m.group(0))
        if i and t:
            alvo[i.group(1)] = t.group(1)
    for m in re.finditer(r'<sheet\b[^>]*>', wb):
        n, rid = re.search(r'name="([^"]*)"', m.group(0)), re.search(r'r:id="([^"]*)"', m.group(0))
        if n and rid and chave(html.unescape(n.group(1))) == chave(nome):
            t = alvo[rid.group(1)].lstrip('/')
            return t if t.startswith('xl/') else 'xl/' + t
    raise ValueError(f'Aba "{nome}" não encontrada na planilha.')


def ler_compartilhados(z):
    try:
        xml = z.read('xl/sharedStrings.xml').decode('utf-8')
    except KeyError:
        return [], None
    textos = [html.unescape(''.join(re.findall(r'<t(?:\s[^>]*)?>(.*?)</t>', si.group(1), re.S)))
              for si in re.finditer(r'<si>(.*?)</si>', xml, re.S)]
    return textos, xml


RE_CELULA = re.compile(rb'<c r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)', re.S)


def valor_celula(attrs, corpo, textos):
    if corpo is None:
        return None
    t = re.search(rb'\bt="([^"]+)"', attrs)
    tipo = t.group(1).decode() if t else 'n'
    if tipo == 'inlineStr':
        return html.unescape(''.join(x.decode('utf-8') for x in re.findall(rb'<t(?:\s[^>]*)?>(.*?)</t>', corpo, re.S)))
    v = re.search(rb'<v>(.*?)</v>', corpo, re.S)
    if not v:
        return None
    bruto = v.group(1).decode('utf-8')
    if tipo == 's':
        return textos[int(bruto)]
    if tipo in ('str', 'e'):
        return html.unescape(bruto)
    try:
        n = float(bruto)
        return int(n) if n.is_integer() else n
    except ValueError:
        return bruto


def ler_aba(xml, textos, colunas):
    """{linha: {coluna: valor}} só das células com valor nas colunas pedidas."""
    linhas = {}
    for m in RE_CELULA.finditer(xml):
        if m.group(4) is None:
            continue
        col = m.group(1).decode()
        if col not in colunas:
            continue
        v = valor_celula(m.group(3), m.group(4), textos)
        if v is None or str(v).strip() == '':
            continue
        linhas.setdefault(int(m.group(2)), {})[col] = v
    return linhas


def conferir_cabecalho(celulas):
    cab = celulas.get(1, {})
    for col, titulo, _ in COLUNAS:
        if chave(cab.get(col)) != chave(titulo):
            raise ValueError(f'A coluna {col} da aba "{ABA}" deveria ser "{titulo}" e está "{cab.get(col) or "vazia"}". Nada foi gravado.')


def ler_cartoes(z):
    textos, _ = ler_compartilhados(z)
    xml = z.read(caminho_aba(z, ABA))
    celulas = ler_aba(xml, textos, {c for c, _, _ in COLUNAS})
    conferir_cabecalho(celulas)
    itens = []
    for r in sorted(celulas):
        if r == 1 or not norm_placa(celulas[r].get('A')):
            continue
        item = {'linha': r}
        for col, _, campo in COLUNAS:
            v = celulas[r].get(col)
            item[campo] = ' '.join(str(v).split()).upper() if v is not None else None
        item['placa'] = norm_placa(item['placa'])
        itens.append(item)
    return itens, xml, textos


def ler_apelidos(z):
    """Placa (referência) -> outras grafias da mesma placa (aba Placas MERCOSUL). Sem a aba, fica vazio."""
    try:
        textos, _ = ler_compartilhados(z)
        xml = z.read(caminho_aba(z, ABA_PLACAS))
    except (ValueError, KeyError):
        return {}
    apelidos = {}
    for r, cel in ler_aba(xml, textos, {'A', 'B', 'C', 'D', 'E'}).items():
        ref = norm_placa(cel.get('A'))
        if r == 1 or not ref:
            continue
        outras = sorted({norm_placa(v) for v in cel.values() if norm_placa(v)} - {ref})
        if outras:
            apelidos[ref] = outras
    return apelidos


def gerar():
    caminho = planilha()
    if not caminho or not os.path.isfile(caminho):
        return saida({'erro': 'Planilha dos cartões frota não encontrada na pasta CONTROLES.'})
    try:
        with zipfile.ZipFile(caminho) as z:
            itens, _, _ = ler_cartoes(z)
            apelidos = ler_apelidos(z)
    except (ValueError, zipfile.BadZipFile) as e:
        return saida({'erro': str(e)})
    for i in itens:
        if apelidos.get(i['placa']):
            i['apelidos'] = apelidos[i['placa']]
    d = {'cartoes': itens, 'arquivo': os.path.basename(caminho)}
    os.makedirs(os.path.dirname(SAIDA), exist_ok=True)
    with open(SAIDA, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False)
    saida({'cartoes': len(itens), 'arquivo': d['arquivo']})


# ---------------- gravação ----------------
class Compartilhados:
    """Textos compartilhados da planilha: reaproveita o índice de um texto que já existe ou acrescenta no fim."""

    def __init__(self, textos, xml):
        self.textos, self.xml, self.novos, self.usos = textos, xml, [], 0
        self.indice = {}
        for i, t in enumerate(textos):
            self.indice.setdefault(t, i)

    def __call__(self, texto):
        self.usos += 1
        if texto not in self.indice:
            self.indice[texto] = len(self.textos) + len(self.novos)
            self.novos.append(texto)
        return self.indice[texto]

    def xml_novo(self):
        if self.xml is None or not self.usos:
            return None
        x = self.xml
        if self.novos:
            extra = ''.join('<si><t xml:space="preserve">' + html.escape(t, quote=False) + '</t></si>' for t in self.novos)
            x = x.replace('</sst>', extra + '</sst>')
            x = re.sub(r'uniqueCount="\d+"', f'uniqueCount="{len(self.textos) + len(self.novos)}"', x, count=1)
        m = re.search(r'\bcount="(\d+)"', x)
        if m:
            x = x[:m.start()] + f'count="{int(m.group(1)) + self.usos}"' + x[m.end():]
        return x


def achar_linha(xml, r):
    """(início, fim, tag de abertura) do elemento <row r="N"> no XML; None se a linha não existe."""
    i = xml.find(b'<row r="%d"' % r)
    if i < 0:
        return None
    fim_tag = xml.find(b'>', i)
    tag = xml[i:fim_tag + 1]
    if tag.endswith(b'/>'):
        return i, fim_tag + 1, tag
    return i, xml.find(b'</row>', fim_tag) + len(b'</row>'), tag


def estilo(celula_xml):
    m = re.search(rb'\ss="(\d+)"', celula_xml or b'')
    return m.group(1).decode() if m else None


def criar_linha(xml, r, modelo):
    """A linha r ainda não existe no XML (a aba não tem linhas vazias formatadas): cria o elemento <row> vazio,
    com os atributos da linha modelo (altura, spans), no lugar certo, e devolve o XML novo."""
    tag = modelo[2] if modelo else b'<row r="0">'
    tag = re.sub(rb'\sr="\d+"', b' r="%d"' % r, tag, count=1)
    tag = tag[:-2] + b'>' if tag.endswith(b'/>') else tag
    novo = tag + b'</row>'
    depois = next((m.start() for m in re.finditer(rb'<row r="(\d+)"', xml) if int(m.group(1)) > r), None)
    pos = depois if depois is not None else xml.find(b'</sheetData>')
    if pos < 0:   # aba sem nenhuma linha: <sheetData/>
        return xml.replace(b'<sheetData/>', b'<sheetData>' + novo + b'</sheetData>', 1)
    return xml[:pos] + novo + xml[pos:]


def montar_linha(xml, r, valores, sst, estilos_padrao):
    """Novo XML da linha r com os valores {coluna: texto|None}; outras células e o formato ficam como estão."""
    pos = achar_linha(xml, r)
    if not pos:
        raise ValueError(f'A linha {r} não existe na aba "{ABA}".')
    ini, fim, tag = pos
    corpo = b'' if tag.endswith(b'/>') else xml[ini + len(tag):fim - len(b'</row>')]
    celulas = {m.group(1).decode(): m.group(0) for m in RE_CELULA.finditer(corpo)}
    for col, v in valores.items():
        s = estilo(celulas.get(col)) or estilos_padrao.get(col)
        attr = f' s="{s}"' if s else ''
        celulas[col] = (f'<c r="{col}{r}"{attr}/>' if v in (None, '') else f'<c r="{col}{r}"{attr} t="s"><v>{sst(v)}</v></c>').encode()
    ordem = sorted(celulas, key=lambda c: (len(c), c))
    abre = tag[:-2] + b'>' if tag.endswith(b'/>') else tag
    return ini, fim, abre + b''.join(celulas[c] for c in ordem) + b'</row>'


def placa_da(a):
    return norm_placa(a.get('chave') or (a.get('dados') or {}).get('placa'))


def gravar(arquivo_json):
    with open(arquivo_json, encoding='utf-8-sig') as f:
        alteracoes = json.load(f)
    if not alteracoes:
        return saida({'itens': []})
    caminho = planilha()
    if not caminho or not os.path.isfile(caminho):
        return saida({'itens': [{'id': a['id'], 'estado': 'erro', 'mensagem': 'Planilha dos cartões não encontrada na pasta CONTROLES.'} for a in alteracoes]})
    if planilha_aberta(caminho):
        return saida({'itens': [{'id': a['id'], 'estado': 'aguardando',
                                 'mensagem': 'A planilha está aberta no Excel. A alteração será gravada quando ela for fechada.'}
                                for a in alteracoes]})
    with zipfile.ZipFile(caminho) as z:
        try:
            itens_planilha, xml, textos = ler_cartoes(z)
            arq_aba = caminho_aba(z, ABA)
        except ValueError as e:
            return saida({'itens': [{'id': a['id'], 'estado': 'erro', 'mensagem': str(e)} for a in alteracoes]})
        _, xml_sst = ler_compartilhados(z)
        entradas = [(i, z.read(i.filename)) for i in z.infolist()]

    linhas = {i['placa']: i['linha'] for i in itens_planilha}
    ultima = max([i['linha'] for i in itens_planilha] + [1])
    # formato das células novas: o da última placa da aba
    pos = achar_linha(xml, ultima)
    estilos_padrao = {m.group(1).decode(): estilo(m.group(0)) for m in RE_CELULA.finditer(xml[pos[0]:pos[1]] if pos else b'')}
    sst = Compartilhados(textos, xml_sst)
    itens, esperado = [], {}
    for a in alteracoes:
        d = dict(a.get('dados') or {})
        placa = placa_da(a)
        nova = placa
        if a['acao'] == 'editar':
            r = linhas.get(placa)
            if not r:
                itens.append({'id': a['id'], 'estado': 'erro', 'mensagem': f'A placa {placa} não está mais na aba {ABA} (foi apagada ou alterada à mão).'})
                continue
            # troca do nome da placa na mesma linha (ex.: placa antiga -> Mercosul, 13/11/2026); os cartões ficam como estão
            if d.get('placa') and norm_placa(d['placa']) != placa:
                nova = norm_placa(d['placa'])
                if nova in linhas:
                    itens.append({'id': a['id'], 'estado': 'erro', 'mensagem': f'A placa {nova} já está em outra linha da aba {ABA}.'})
                    continue
                d['placa'] = nova
            else:
                d.pop('placa', None)
        else:
            if placa in linhas:
                itens.append({'id': a['id'], 'estado': 'erro', 'mensagem': f'A placa {placa} já está na aba {ABA}.'})
                continue
            r = ultima + 1
            d['placa'] = placa
            if not achar_linha(xml, r):
                xml = criar_linha(xml, r, achar_linha(xml, ultima))
        valores = {col: d[campo] for col, _, campo in COLUNAS if campo in d}
        try:
            ini, fim, novo = montar_linha(xml, r, valores, sst, estilos_padrao)
        except ValueError as e:
            itens.append({'id': a['id'], 'estado': 'erro', 'mensagem': str(e)})
            continue
        xml = xml[:ini] + novo + xml[fim:]   # a próxima linha é procurada de novo no XML já alterado
        if a['acao'] != 'editar':
            ultima = linhas[placa] = r
        elif nova != placa:
            linhas[nova] = linhas.pop(placa)
            esperado.pop(placa, None)
        esperado.setdefault(nova, {}).update({c: (d[c] or None) for _, _, c in COLUNAS[1:] if c in d})
        itens.append({'id': a['id'], 'estado': 'aplicada', 'linha': r})

    if not esperado:
        return saida({'itens': itens})
    # a área usada da aba (<dimension>) passa a cobrir a última linha gravada
    m = re.search(rb'<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"', xml)
    if m and int(m.group(3)) < ultima:
        xml = xml[:m.start()] + b'<dimension ref="%s:%s%d"' % (m.group(1), m.group(2), ultima) + xml[m.end():]
    trocas = {arq_aba: xml}
    novo_sst = sst.xml_novo()
    if novo_sst is not None:
        trocas['xl/sharedStrings.xml'] = novo_sst.encode('utf-8')
    copia = guardar_copia(caminho)
    tmp = os.path.join(os.path.dirname(COPIAS), 'gravando-cartoes.xlsx')
    with zipfile.ZipFile(tmp, 'w') as zout:
        for info, dados in entradas:
            zout.writestr(info, trocas.get(info.filename, dados), compress_type=info.compress_type)
    # confere que o arquivo novo abre e traz os valores gravados
    with zipfile.ZipFile(tmp) as z:
        lidos = {i['placa']: i for i in ler_cartoes(z)[0]}
    if any(placa not in lidos or any(lidos[placa][c] != v for c, v in campos.items()) for placa, campos in esperado.items()):
        os.remove(tmp)
        os.remove(copia)
        return saida({'itens': [{'id': i['id'], 'estado': 'erro', 'mensagem': 'A conferência depois de gravar falhou; a planilha não foi alterada.'}
                                if i['estado'] == 'aplicada' else i for i in itens]})
    if planilha_aberta(caminho):
        os.remove(tmp)
        return saida({'itens': [{'id': i['id'], 'estado': 'aguardando',
                                 'mensagem': 'A planilha foi aberta no Excel durante a gravação; tenta de novo quando ela for fechada.'}
                                if i['estado'] == 'aplicada' else i for i in itens]})
    try:
        substituir(tmp, caminho, copia)   # confere o arquivo depois de gravar (ownCloud)
    finally:
        os.remove(tmp)
    saida({'itens': itens, 'copia': copia})


# ---------------- ligação com o cadastro de placas ----------------
def mercosul(p):
    """Placa antiga (ABC1234) e Mercosul (ABC1C34) são o mesmo veículo: compara sempre no formato Mercosul."""
    p = norm_placa(p)
    return p[:4] + 'ABCDEFGHIJ'[int(p[4])] + p[5:] if re.fullmatch(r'[A-Z]{3}\d{4}', p) else p


def placas_do_cadastro():
    """Aba Carros da planilha de placas e motoristas (lida de uma cópia): {mercosul: {placa, categoria, situacao}}."""
    import openpyxl
    import planilha_cadastros as pcad
    caminho = pcad.planilha()
    if not caminho or not os.path.isfile(caminho):
        raise ValueError('Planilha de placas e motoristas não encontrada na pasta CONTROLES.')
    copia = os.path.join(os.path.dirname(COPIAS), 'lendo-cadastro-cartoes.xlsx')
    shutil.copy2(caminho, copia)
    try:
        lista = pcad.ler(openpyxl.load_workbook(copia), openpyxl.load_workbook(copia, data_only=True), 'placas')
    finally:
        os.remove(copia)
    return {mercosul(p['placa']): p for p in lista if norm_placa(p.get('placa'))}


def com_cartao(p):
    return (p.get('situacao') or 'ATIVA') not in ('DESABILITADA', 'VENDIDO') and chave(p.get('categoria')) in CATEGORIAS_COM_CARTAO


RE_LINHA = re.compile(rb'<row r="(\d+)"[^>]*?(?:/>|>.*?</row>)', re.S)


def renumerar(linha_xml, novo):
    """Muda o número da linha no <row r=".."> e nas células (A12 -> A7)."""
    linha_xml = re.sub(rb'^<row r="\d+"', b'<row r="%d"' % novo, linha_xml, count=1)
    return re.sub(rb'<c r="([A-Z]+)\d+"', lambda m: b'<c r="%s%d"' % (m.group(1), novo), linha_xml)


def sincronizar():
    """Deixa a aba CARTÕES igual ao cadastro: placa ativa com motor que falta entra (cartões vazios = sem cartão);
    placa desabilitada, de categoria sem cartão, ou que saiu do cadastro sai. As linhas que ficam sobem para não deixar
    buraco. Placa que nunca esteve no cadastro fica (aviso "fora do cadastro" no portal)."""
    caminho = planilha()
    if not caminho or not os.path.isfile(caminho):
        return saida({'erro': 'Planilha dos cartões frota não encontrada na pasta CONTROLES.'})
    try:
        cadastro = placas_do_cadastro()
    except ValueError as e:
        return saida({'erro': str(e)})
    if not cadastro:
        return saida({'erro': 'O cadastro de placas veio vazio; nada foi alterado no controle dos cartões.'})
    try:
        with open(VISTAS, encoding='utf-8') as f:
            vistas = set(json.load(f))
    except (OSError, ValueError):
        vistas = set()
    vistas |= set(cadastro)
    desejadas = {k: p for k, p in cadastro.items() if com_cartao(p)}

    with zipfile.ZipFile(caminho) as z:
        try:
            itens, xml, textos = ler_cartoes(z)
            arq_aba = caminho_aba(z, ABA)
        except ValueError as e:
            return saida({'erro': str(e)})
        apelidos = ler_apelidos(z)
        _, xml_sst = ler_compartilhados(z)
        entradas = [(i, z.read(i.filename)) for i in z.infolist()]

    manter, removidas, fora, cobertas = [], [], [], set()
    for i in itens:
        chaves = {mercosul(i['placa'])} | {mercosul(a) for a in apelidos.get(i['placa'], [])}
        if chaves & set(desejadas):
            manter.append(i['linha'])
            cobertas |= chaves & set(desejadas)
        elif chaves & set(cadastro) or chaves & vistas:
            removidas.append(i['placa'])
        else:
            manter.append(i['linha'])
            fora.append(i['placa'])
    adicionadas = [norm_placa(p['placa']) for k, p in desejadas.items() if k not in cobertas]
    resultado = {'adicionadas': adicionadas, 'removidas': removidas, 'foraDoCadastro': fora}

    def guardar_vistas():
        os.makedirs(os.path.dirname(VISTAS), exist_ok=True)
        with open(VISTAS, 'w', encoding='utf-8') as f:
            json.dump(sorted(vistas), f)

    if not adicionadas and not removidas:
        guardar_vistas()
        return saida(resultado)
    if planilha_aberta(caminho):
        return saida({**resultado, 'aguardando': True})

    # monta de novo as linhas de dados: cabeçalho igual, as que ficam renumeradas em sequência, as novas no fim
    ini_dados, fim_dados = xml.find(b'<sheetData>'), xml.find(b'</sheetData>')
    if ini_dados < 0 or fim_dados < 0:
        return saida({'erro': 'Não encontrei as linhas da aba CARTÕES no arquivo; nada foi alterado.'})
    linhas = {int(m.group(1)): m.group(0) for m in RE_LINHA.finditer(xml, ini_dados, fim_dados)}
    com_dado = {i['linha'] for i in itens}
    for r, lx in linhas.items():
        # linha que sairia sem ser placa do controle e tem algum valor (anotação embaixo da tabela?): não arrisca
        if r > 1 and r not in com_dado and re.search(rb'<(v|f|is)\b', lx):
            return saida({'erro': f'A linha {r} da aba CARTÕES tem dados sem placa na coluna A; ajuste a planilha. Nada foi alterado.'})
    modelo = linhas[max(com_dado)] if com_dado else linhas.get(1, b'<row r="1"></row>')
    estilos = {m.group(1).decode(): estilo(m.group(0)) for m in RE_CELULA.finditer(modelo)}
    sst = Compartilhados(textos, xml_sst)
    novo_corpo, n = [linhas[1]] if 1 in linhas else [], 1
    for r in manter:
        n += 1
        novo_corpo.append(renumerar(linhas[r], n))
    tag_modelo = re.match(rb'<row [^>]*?>', modelo).group(0) if re.match(rb'<row [^>]*?>', modelo) else b'<row r="0">'
    tag_modelo = tag_modelo[:-2] + b'>' if tag_modelo.endswith(b'/>') else tag_modelo
    for placa in adicionadas:
        n += 1
        tag = re.sub(rb'\sr="\d+"', b' r="%d"' % n, tag_modelo, count=1)
        celulas = []
        for col, _, campo in COLUNAS:
            s = estilos.get(col)
            attr = f' s="{s}"' if s else ''
            celulas.append(f'<c r="{col}{n}"{attr} t="s"><v>{sst(placa)}</v></c>' if campo == 'placa' else f'<c r="{col}{n}"{attr}/>')
        novo_corpo.append(tag + ''.join(celulas).encode() + b'</row>')
    xml = xml[:ini_dados] + b'<sheetData>' + b''.join(novo_corpo) + xml[fim_dados:]
    xml = re.sub(rb'<dimension ref="([A-Z]+\d+):([A-Z]+)\d+"', lambda m: b'<dimension ref="%s:%s%d"' % (m.group(1), m.group(2), n), xml, count=1)
    trocas = {arq_aba: xml}
    novo_sst = sst.xml_novo()
    if novo_sst is not None:
        trocas['xl/sharedStrings.xml'] = novo_sst.encode('utf-8')

    copia = guardar_copia(caminho)
    tmp = os.path.join(os.path.dirname(COPIAS), 'gravando-cartoes.xlsx')
    with zipfile.ZipFile(tmp, 'w') as zout:
        for info, dados in entradas:
            zout.writestr(info, trocas.get(info.filename, dados), compress_type=info.compress_type)
    # confere: ficaram exatamente as placas esperadas, com as situações de antes
    with zipfile.ZipFile(tmp) as z:
        depois = ler_cartoes(z)[0]
    antes = {i['placa']: i for i in itens}
    esperadas = [antes_i['placa'] for antes_i in itens if antes_i['linha'] in set(manter)] + adicionadas
    ok = [i['placa'] for i in depois] == esperadas and all(
        all(i[c] == antes[i['placa']][c] for c in ('ticket', 'truckpag', 'veloe')) for i in depois if i['placa'] in antes)
    if not ok:
        os.remove(tmp)
        os.remove(copia)
        return saida({'erro': 'A conferência depois de sincronizar com o cadastro falhou; a planilha não foi alterada.'})
    if planilha_aberta(caminho):
        os.remove(tmp)
        return saida({**resultado, 'aguardando': True})
    try:
        substituir(tmp, caminho, copia)   # confere o arquivo depois de gravar (ownCloud)
    finally:
        os.remove(tmp)
    guardar_vistas()
    saida({**resultado, 'copia': copia})


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) >= 2 and sys.argv[1] == 'gerar':
        gerar()
    elif len(sys.argv) >= 2 and sys.argv[1] == 'sincronizar':
        sincronizar()
    elif len(sys.argv) >= 3 and sys.argv[1] == 'gravar':
        gravar(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(1)
