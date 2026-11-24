"""Grava os abastecimentos consolidados no site na planilha CONTROLES\\Base_copia.xlsx (aba Transações).

    py scripts/planilha_base_copia.py gravar <lotes.json>
    py scripts/planilha_base_copia.py editar <edicoes.json>   (página Editar abastecimentos; ver editar())

lotes.json = [{"id": 1, "linhas": [[fonte, ...48 colunas da Base], ...]}, ...] (o que o Consolidador do site montou).
Quem chama é o vigia (scripts/sincronizar.mjs). A Base.xlsx original nunca é tocada.

Como a aba tem ~60 mil linhas (XML de ~100 MB), o arquivo é alterado direto no XML (como a planilha dos cartões):
  - as linhas novas entram em ordem de data e hora (coluna E): o trecho final da aba, a partir da primeira linha mais
    nova que alguma das novas (ou fora de ordem), é reordenado junto com elas — os lotes da API (D-1) entram antes dos
    que o usuário grava pelo Consolidador e, sem isso, os manuais ficavam fora de ordem; o trecho só é reordenado se
    for contínuo, com data em todas as linhas e sem fórmula (senão as novas vão para o fim, como antes);
  - cada coluna recebe o mesmo formato (cor, fonte, número) da última linha da aba com a mesma FORMA DE PAGAMENTO
    (Cartao Fisico, TRUCKPAG, VELOE, VIBRA), igual às linhas que já estão lá;
  - abastecimento que já está na aba (mesma placa, data, hodômetro e combustível) não é gravado de novo;
  - o filtro da aba passa a cobrir as linhas novas;
  - planilha aberta no Excel: não grava e devolve "aguardando"; antes de gravar, guarda uma cópia (as 5 mais recentes).
Saída: uma linha JSON no stdout.
"""
import bisect
import collections
import datetime as dt
import glob
import json
import os
import re
import shutil
import sys
import unicodedata
import zipfile

import planilha_cartoes as pc   # leitura do pacote xlsx, textos compartilhados, planilha aberta

PASTA_PROJETO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COPIAS = os.path.join(PASTA_PROJETO, '.dados', 'copias-planilha')
GUARDAR_COPIAS = 5
ABA = 'Transações'
CABECALHO = ["CODIGO TRANSACAO", "FORMA DE PAGAMENTO", "CODIGO CLIENTE", "NOME REDUZIDO", "DATA TRANSACAO",
             "PLACA", "TIPO FROTA", "MODELO VEICULO", "NUMERO FROTA", "ANO", "MATRICULA", "NOME MOTORISTA",
             "SERVICO", "TIPO COMBUSTIVEL", "LITROS", "VL/LITRO", "HODOMETRO OU HORIMETRO",
             "KM RODADOS OU HORAS TRABALHADAS", "KM/LITRO OU LITROS/HORA", "VALOR EMISSAO",
             "CODIGO ESTABELECIMENTO", "NOME ESTABELECIMENTO", "TIPO ESTABELECIMENTO", "ENDERECO", "BAIRRO",
             "CIDADE", "UF"]   # as primeiras 27 colunas são conferidas antes de gravar


def chave(s):
    return ' '.join(unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().upper().split())


def letra(i):
    s, i = '', i + 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


COLS = [letra(i) for i in range(48)]


def planilha():
    if os.environ.get('PLANILHA_BASE_COPIA'):
        return os.environ['PLANILHA_BASE_COPIA']
    achados = [p for p in glob.glob(os.path.join(PASTA_PROJETO, 'CONTROLES', '*.xlsx'))
               if not os.path.basename(p).startswith('~$') and 'conflict' not in os.path.basename(p).lower() and chave(os.path.basename(p)).startswith('BASE')]
    return sorted(achados)[0] if achados else None


def saida(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')


def guardar_copia(caminho):
    os.makedirs(COPIAS, exist_ok=True)
    destino = os.path.join(COPIAS, 'base-copia-' + dt.datetime.now().strftime('%Y%m%d-%H%M%S') + '.xlsx')
    shutil.copy2(caminho, destino)
    for velho in sorted(glob.glob(os.path.join(COPIAS, 'base-copia-*.xlsx')))[:-GUARDAR_COPIAS]:
        try:
            os.remove(velho)
        except OSError:
            pass
    return destino


def chave_abastecimento(placa, data, hodo):
    """Mesma transação: placa + data (ao segundo) + hodômetro."""
    try:
        d = round(float(data) * 86400)
    except (TypeError, ValueError):
        d = None
    try:
        h = int(float(hodo)) if hodo not in (None, '') else None
    except (TypeError, ValueError):
        h = None
    return (pc.norm_placa(placa), d, h)


def cadeia_comb(fuel):
    """Combustível para a chave de duplicidade: diesel (qualquer tipo) junto, Arla à parte. Na bomba interna o diesel e o Arla
    do mesmo caminhão são lançados no mesmo minuto e com o mesmo hodômetro: sem o combustível na chave, o segundo era
    descartado como "já está na planilha" (achado em 09/11/2026: 21 abastecimentos fora da Base_copia)."""
    k = chave(fuel)
    return 'DIESEL' if 'DIESEL' in k else k


def erro_todos(lotes, msg, estado='erro'):
    return saida({'itens': [{'id': l['id'], 'estado': estado, 'mensagem': msg} for l in lotes]})


def gravar(arquivo_json):
    with open(arquivo_json, encoding='utf-8-sig') as f:
        lotes = json.load(f)
    if not lotes:
        return saida({'itens': []})
    caminho = planilha()
    if not caminho or not os.path.isfile(caminho):
        return erro_todos(lotes, 'Planilha Base_copia não encontrada na pasta CONTROLES.')
    if pc.planilha_aberta(caminho):
        return erro_todos(lotes, 'A Base_copia está aberta no Excel. Os abastecimentos serão gravados quando ela for fechada.', 'aguardando')
    with zipfile.ZipFile(caminho) as z:
        try:
            arq_aba = pc.caminho_aba(z, ABA)
        except ValueError as e:
            return erro_todos(lotes, str(e))
        textos, xml_sst = pc.ler_compartilhados(z)
        xml = z.read(arq_aba)
        wb_xml = z.read('xl/workbook.xml').decode('utf-8')
        entradas = [(i, z.read(i.filename)) for i in z.infolist()]

    ini_dados, fim_dados = xml.find(b'<sheetData>'), xml.find(b'</sheetData>')
    linhas = list(re.finditer(rb'<row r="(\d+)"[^>]*?(?:/>|>(.*?)</row>)', xml[ini_dados:fim_dados], re.S))
    if not linhas:
        return erro_todos(lotes, 'A aba Transações da Base_copia está vazia.')
    cab = {m.group(1).decode(): pc.valor_celula(m.group(3), m.group(4), textos)
           for m in pc.RE_CELULA.finditer(linhas[0].group(2) or b'')}
    for i, titulo in enumerate(CABECALHO):
        if chave(cab.get(COLS[i])) != chave(titulo):
            return erro_todos(lotes, f'A coluna {COLS[i]} da aba Transações deveria ser "{titulo}" e está "{cab.get(COLS[i]) or "vazia"}". Nada foi gravado.')

    # última linha com dado, modelo de formato por FORMA DE PAGAMENTO e abastecimentos que já estão na aba
    ultima, ultima_pos, modelos, existentes, dados_aba = 1, None, {}, set(), []
    for m in linhas[1:]:
        corpo = m.group(2) or b''
        if not re.search(rb'<(v|f|is)\b', corpo):
            continue
        cel = {}
        for c in pc.RE_CELULA.finditer(corpo):
            col = c.group(1).decode()
            if col in ('B', 'E', 'F', 'N', 'Q'):
                cel[col] = pc.valor_celula(c.group(3), c.group(4), textos)
        ultima, ultima_pos = int(m.group(1)), m
        dados_aba.append((int(m.group(1)), cel.get('E'), m))
        existentes.add(chave_abastecimento(cel.get('F'), cel.get('E'), cel.get('Q')) + (cadeia_comb(cel.get('N')),))
        if cel.get('B') is not None:
            modelos[chave(cel['B'])] = m          # fica a última linha de cada forma de pagamento
    if ultima_pos is None:
        return erro_todos(lotes, 'A aba Transações não tem nenhuma linha de dado para servir de modelo.')
    # linhas vazias (só formato) depois da última com dado saem, para as novas entrarem logo em seguida
    if any(re.search(rb'<(v|f|is)\b', m.group(2) or b'') for m in linhas if int(m.group(1)) > ultima):
        return erro_todos(lotes, 'Há dados abaixo da última linha da aba Transações; confira a planilha. Nada foi gravado.')

    sst = pc.Compartilhados(textos, xml_sst)

    def estilos(m):
        return {c.group(1).decode(): pc.estilo(c.group(0)) for c in pc.RE_CELULA.finditer(m.group(2) or b'')}

    def tag_linha(m, n):
        tag = re.match(rb'<row [^>]*?>', m.group(0)).group(0)
        tag = tag[:-2] + b'>' if tag.endswith(b'/>') else tag
        return re.sub(rb'\sr="\d+"', b' r="%d"' % n, tag, count=1)

    def num(v):
        return repr(float(v)) if isinstance(v, float) and not v.is_integer() else str(int(v))

    def linha_xml(valores, m, n):
        st = estilos(m)
        celulas = []
        for i, v in enumerate(valores):
            col, s = COLS[i], st.get(COLS[i])
            attr = f' s="{s}"' if s else ''
            if v is None or v == '':
                if s:
                    celulas.append(f'<c r="{col}{n}"{attr}/>')
            elif isinstance(v, bool):
                celulas.append(f'<c r="{col}{n}"{attr} t="b"><v>{int(v)}</v></c>')
            elif isinstance(v, (int, float)):
                celulas.append(f'<c r="{col}{n}"{attr}><v>{num(v)}</v></c>')
            else:
                celulas.append(f'<c r="{col}{n}"{attr} t="s"><v>{sst(str(v))}</v></c>')
        return tag_linha(m, n) + ''.join(celulas).encode('utf-8') + b'</row>'

    novas, itens = [], []   # novas: (data, ordem, valores, linha-modelo, índice do lote)
    for li, lote in enumerate(lotes):
        gravadas, ignoradas = 0, 0
        for linha in lote['linhas']:
            fonte, valores = linha[0], (list(linha[1:]) + [None] * 48)[:48]
            k = chave_abastecimento(valores[5], valores[4], valores[16]) + (cadeia_comb(valores[13]),)   # + combustível
            if k in existentes:
                ignoradas += 1          # já está na aba (lote gravado antes ou digitado à mão)
                continue
            existentes.add(k)
            m = modelos.get(chave(valores[1])) or modelos.get(chave('Cartao Fisico' if fonte == 'TICKET' else fonte)) or ultima_pos
            novas.append((valores[4], len(novas), valores, m, li))
            gravadas += 1
        itens.append({'id': lote['id'], 'estado': 'aplicada', 'gravadas': gravadas, 'ignoradas': ignoradas})

    if not novas:
        return saida({'itens': [{**i, 'linha_inicial': None, 'linha_final': None,
                                 'mensagem': 'Todos os abastecimentos deste lote já estavam na Base_copia.'} for i in itens]})

    xml, n, linhas_lote, reordenadas = intercalar(xml, ini_dados, fim_dados, dados_aba, ultima_pos, novas, linha_xml)
    for li, it in enumerate(itens):
        ls = linhas_lote.get(li)
        it['linha_inicial'], it['linha_final'] = (min(ls), max(ls)) if ls else (None, None)
    xml = re.sub(rb'<dimension ref="([A-Z]+\d+):([A-Z]+)\d+"', lambda mm: b'<dimension ref="%s:%s%d"' % (mm.group(1), mm.group(2), n), xml, count=1)
    xml = re.sub(rb'(<autoFilter ref="[A-Z]+\d+:[A-Z]+)\d+"', lambda mm: mm.group(1) + b'%d"' % n, xml, count=1)
    wb_xml = re.sub(r'(<definedName name="_xlnm\._FilterDatabase"[^>]*>[^<]*?\$[A-Z]+\$)\d+(</definedName>)',
                    lambda mm: mm.group(1) + str(n) + mm.group(2), wb_xml, count=1)
    trocas = {arq_aba: xml, 'xl/workbook.xml': wb_xml.encode('utf-8')}
    novo_sst = sst.xml_novo()
    if novo_sst is not None:
        trocas['xl/sharedStrings.xml'] = novo_sst.encode('utf-8')

    copia = guardar_copia(caminho)
    tmp = os.path.join(os.path.dirname(COPIAS), 'gravando-base-copia.xlsx')
    with zipfile.ZipFile(tmp, 'w') as zout:
        for info, dados in entradas:
            zout.writestr(info, trocas.get(info.filename, dados), compress_type=info.compress_type)
    # confere: a última linha está lá, com a placa; a aba tem as linhas novas a mais; o trecho reordenado está em ordem
    with zipfile.ZipFile(tmp) as z:
        x2 = z.read(arq_aba)
        t2, _ = pc.ler_compartilhados(z)
    pos = pc.achar_linha(x2, n)
    placa_ok = bool(pos) and any(c.group(1) == b'F' and pc.valor_celula(c.group(3), c.group(4), t2)
                                 for c in pc.RE_CELULA.finditer(x2[pos[0]:pos[1]]))
    placa_ok = placa_ok and x2.count(b'<row ') == len(linhas) + len(novas) and em_ordem(x2, t2, reordenadas, n)
    if not placa_ok:
        os.remove(tmp)
        os.remove(copia)
        return erro_todos(lotes, 'A conferência depois de gravar falhou; a Base_copia não foi alterada.')
    if pc.planilha_aberta(caminho):
        os.remove(tmp)
        return erro_todos(lotes, 'A Base_copia foi aberta no Excel durante a gravação; tenta de novo quando ela for fechada.', 'aguardando')
    try:
        pc.substituir(tmp, caminho, copia)   # confere o arquivo depois de gravar (ownCloud)
    finally:
        os.remove(tmp)
    saida({'itens': itens, 'copia': copia})


def data_num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def intercalar(xml, ini_dados, fim_dados, dados_aba, ultima_pos, novas, linha_xml):
    """Põe as linhas novas na ordem de data e hora. Acha o início do trecho final a reordenar (a primeira linha com data
    maior que a menor data de tudo o que vem depois dela, contando as novas), junta esse trecho com as novas, ordena
    (empate: fica a ordem em que estavam) e renumera. Se o trecho não puder ser reordenado com segurança (linha sem
    data, com fórmula ou buraco na numeração), as novas entram no fim, ordenadas entre si.
    Devolve (xml novo, última linha, {índice do lote: [linhas]}, primeira linha reordenada ou None)."""
    datas_novas = [data_num(d) for d, *_ in novas]
    menor_nova = min((d for d in datas_novas if d is not None), default=None)
    # sufixo mínimo das datas da aba (de baixo para cima) junto com a menor data nova
    p, menor = len(dados_aba), menor_nova if menor_nova is not None else float('inf')
    for k in range(len(dados_aba) - 1, -1, -1):
        d = data_num(dados_aba[k][1])
        if d is not None and d > menor + 1e-9:
            p = k
        if d is not None:
            menor = min(menor, d)
    trecho = dados_aba[p:]
    seguro = all(data_num(e) is not None and b'<f' not in (m.group(2) or b'') for _, e, m in trecho) and \
        all(trecho[i][0] == trecho[0][0] + i for i in range(len(trecho)))
    if not seguro or any(d is None for d in datas_novas):
        p, trecho = len(dados_aba), []
    primeira = trecho[0][0] if trecho else ultima_pos and int(ultima_pos.group(1)) + 1
    # itens: (data, 0 = já estava / 1 = nova, ordem, conteúdo)
    itens = [(data_num(e), 0, i, ('velha', m)) for i, (_, e, m) in enumerate(trecho)]
    itens += [(d if d is not None else float('inf'), 1, o, ('nova', (valores, m, li))) for (d, o, valores, m, li) in
              [(datas_novas[j], *novas[j][1:]) for j in range(len(novas))]]
    itens.sort(key=lambda x: (x[0], x[1], x[2]))
    blocos, linhas_lote, n = [], {}, primeira - 1
    for _, _, _, (tipo, dado) in itens:
        n += 1
        if tipo == 'velha':
            bloco = dado.group(0)
            bloco = re.sub(rb'(<row r=")\d+', lambda x: x.group(1) + str(n).encode(), bloco, count=1)
            bloco = re.sub(rb'(<c r="[A-Z]+)\d+"', lambda x: x.group(1) + str(n).encode() + b'"', bloco)
            blocos.append(bloco)
        else:
            valores, m, li = dado
            blocos.append(linha_xml(valores, m, n))
            linhas_lote.setdefault(li, []).append(n)
    ini_troca = ini_dados + (trecho[0][2].start() if trecho else ultima_pos.end())
    fim_troca = ini_dados + ultima_pos.end()
    return xml[:ini_troca] + b''.join(blocos) + xml[fim_troca:], n, linhas_lote, (primeira if trecho else None)


def em_ordem(x2, t2, desde, ate):
    """Confere que as datas (coluna E) das linhas `desde`..`ate` estão em ordem crescente (sem trecho reordenado: ok)."""
    if desde is None:
        return True
    ini = pc.achar_linha(x2, desde)
    if not ini:
        return False
    fim = pc.achar_linha(x2, ate)
    anterior = None
    for m in re.finditer(rb'<row r="(\d+)"[^>]*?(?:/>|>(.*?)</row>)', x2[ini[0]:fim[1]], re.S):
        e = next((pc.valor_celula(c.group(3), c.group(4), t2) for c in pc.RE_CELULA.finditer(m.group(2) or b'') if c.group(1) == b'E'), None)
        d = data_num(e)
        if d is None or (anterior is not None and d < anterior - 1e-9):
            return False
        anterior = d
    return True


VEICULO = ('G', 'H', 'I', 'J')   # TIPO FROTA, MODELO VEICULO, NUMERO FROTA, ANO: acompanham a placa
MATRICULA, MOTORISTA = 'K', 'L'

# ---------------- apagar linhas (as de baixo sobem, como o "Excluir linha" do Excel) ----------------
# Referência de célula numa fórmula / sqref: A1, $A$1, AV60294 (não pega nome de função como LOG10( ).
RE_REF = re.compile(rb'(?<![A-Za-z_$\d.])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_])')
RE_AREA = re.compile(rb'(\$?[A-Z]{1,3})(\$?)(\d+)(?::(\$?[A-Z]{1,3})(\$?)(\d+))?')


class Renumerar:
    """Linha antiga -> linha nova depois de apagar as linhas `apagadas` (None = a linha foi apagada)."""

    def __init__(self, apagadas):
        self.ap = sorted(apagadas)

    def n(self, r):
        i = bisect.bisect_left(self.ap, r)
        return None if i < len(self.ap) and self.ap[i] == r else r - i

    def faixa(self, r1, r2):
        a, b = r1, r2
        while a <= b and self.n(a) is None:
            a += 1
        while b >= a and self.n(b) is None:
            b -= 1
        return None if a > b else (self.n(a), self.n(b))

    def formula(self, txt):
        """Referências de uma fórmula: abaixo da apagada sobem uma linha; para a própria apagada vira #REF!."""
        def troca(m):
            nr = self.n(int(m.group(4)))
            return b'#REF!' if nr is None else m.group(1) + m.group(2) + m.group(3) + str(nr).encode()
        return RE_REF.sub(troca, txt)

    def area(self, s):
        """"A5" ou "A5:C9" -> área nova (encolhe se perdeu linhas); None se todas as linhas da área foram apagadas."""
        m = RE_AREA.fullmatch(s)
        if not m:
            return s
        if m.group(4) is None:
            nr = self.n(int(m.group(3)))
            return None if nr is None else m.group(1) + m.group(2) + str(nr).encode()
        f = self.faixa(int(m.group(3)), int(m.group(6)))
        if f is None:
            return None
        return m.group(1) + m.group(2) + str(f[0]).encode() + b':' + m.group(4) + m.group(5) + str(f[1]).encode()

    def sqref(self, s):
        partes = [self.area(t) for t in s.split()]
        partes = [p for p in partes if p]
        return b' '.join(partes) if partes else None

    def celula_ou_proxima(self, s):
        """Célula de seleção/rolagem: se a linha dela foi apagada, fica na de baixo (que subiu)."""
        m = RE_AREA.fullmatch(s)
        if not m or m.group(4) is not None:
            return self.sqref(s) or b'A1'
        r = int(m.group(3))
        while self.n(r) is None:
            r += 1
        return m.group(1) + m.group(2) + str(self.n(r)).encode()


def remover_linhas(xml, wb_xml, apagadas):
    """Apaga as linhas `apagadas` da aba (XML) e ajusta tudo o que aponta para número de linha: as linhas e células de
    baixo, as fórmulas (inclusive os grupos de fórmula compartilhada: se a linha-mestre sai, a seguinte assume),
    a formatação condicional, o filtro, a ordenação, a dimensão, a seleção e o _FilterDatabase do workbook.xml.
    Devolve (xml novo, workbook.xml novo)."""
    mp = Renumerar(apagadas)
    primeira = min(apagadas)
    ini, fim = xml.find(b'<sheetData>'), xml.find(b'</sheetData>')
    dados = xml[ini:fim]

    # grupos de fórmula compartilhada: linhas de cada grupo e a mestre (com o texto e a área)
    grupos = {}
    for fm in re.finditer(rb'<f t="shared"([^>]*?)(/>|>([^<]*)</f>)', dados):
        attrs = fm.group(1)
        si = re.search(rb'si="(\d+)"', attrs).group(1)
        cini = dados.rfind(b'<c r="', 0, fm.start())
        cm = re.match(rb'<c r="([A-Z]+)(\d+)"', dados[cini:cini + 30])
        g = grupos.setdefault(si, {'linhas': [], 'mestre': None})
        g['linhas'].append(int(cm.group(2)))
        ref = re.search(rb'ref="([^"]+)"', attrs)
        if ref:
            g['mestre'] = (int(cm.group(2)), cm.group(1), ref.group(1), fm.group(3) or b'')
    # mestre apagada: a próxima linha do grupo passa a ser a mestre (as fórmulas do grupo só usam a própria linha)
    promover = {}   # linha antiga -> (si, texto na numeração antiga, área na numeração antiga)
    for si, g in grupos.items():
        if not g['mestre'] or mp.n(g['mestre'][0]) is not None:
            continue
        resto = sorted(r for r in g['linhas'] if mp.n(r) is not None)
        if not resto:
            continue
        rm, col, ref, txt = g['mestre']
        nova = resto[0]
        txt_nova = RE_REF.sub(lambda m: m.group(0) if m.group(3) else m.group(1) + m.group(2) + str(nova).encode(), txt)
        a = RE_AREA.fullmatch(ref)
        ref_nova = a.group(1) + a.group(2) + str(nova).encode() + (b':' + a.group(4) + a.group(5) + a.group(6) if a.group(4) else b'')
        promover[nova] = (si, txt_nova, ref_nova)

    def linha(m):
        r = int(m.group(1))
        nr = mp.n(r)
        if nr is None:
            return b''
        bloco = m.group(0)
        if r in promover:
            si, txt, ref = promover[r]
            bloco = bloco.replace(b'<f t="shared" si="' + si + b'"/>', b'<f t="shared" ref="' + ref + b'" si="' + si + b'">' + txt + b'</f>', 1)
        tem_formula = b'<f>' in bloco or b'<f t="shared" ref=' in bloco or re.search(rb'<f [^>]*>[^<]', bloco)
        if r < primeira and not tem_formula:
            return bloco   # acima da primeira apagada e sem fórmula: nada muda
        if r >= primeira:
            bloco = re.sub(rb'(<row r=")\d+', lambda x: x.group(1) + str(nr).encode(), bloco, count=1)
            bloco = re.sub(rb'(<c r="[A-Z]+)\d+"', lambda x: x.group(1) + str(nr).encode() + b'"', bloco)
        if tem_formula:
            bloco = re.sub(rb'(<f(?: [^>]*)?>)([^<]*)(</f>)', lambda x: x.group(1) + mp.formula(x.group(2)) + x.group(3), bloco)
            bloco = re.sub(rb'(<f [^>]*?\bref=")([^"]+)(")', lambda x: x.group(1) + (mp.area(x.group(2)) or x.group(2)) + x.group(3), bloco)
        return bloco

    novos = re.sub(rb'<row r="(\d+)"[^>]*?(?:/>|>.*?</row>)', linha, dados, flags=re.S)
    cab, rodape = xml[:ini], xml[fim:]

    def attr(texto, elemento, nome, f):
        return re.sub(rb'(<' + elemento + rb'\b[^>]*?\b' + nome + rb'=")([^"]+)(")', lambda x: x.group(1) + (f(x.group(2)) or x.group(2)) + x.group(3), texto)

    cab = attr(cab, b'dimension', b'ref', mp.area)
    cab = attr(cab, b'pane', b'topLeftCell', mp.celula_ou_proxima)
    cab = attr(cab, b'selection', b'activeCell', mp.celula_ou_proxima)
    cab = attr(cab, b'selection', b'sqref', mp.celula_ou_proxima)
    rodape = attr(rodape, b'autoFilter', b'ref', mp.area)
    rodape = attr(rodape, b'sortState', b'ref', mp.area)
    rodape = attr(rodape, b'sortCondition', b'ref', mp.area)

    def cf(x):
        sq = mp.sqref(x.group(1))
        if sq is None:
            return b''   # a formatação valia só para linhas apagadas
        corpo = re.sub(rb'(<formula>)([^<]*)(</formula>)', lambda y: y.group(1) + mp.formula(y.group(2)) + y.group(3), x.group(2))
        return b'<conditionalFormatting sqref="' + sq + b'">' + corpo + b'</conditionalFormatting>'
    rodape = re.sub(rb'<conditionalFormatting sqref="([^"]+)">(.*?)</conditionalFormatting>', cf, rodape, flags=re.S)

    def nome(x):
        planilha_, area = x.group(2).rsplit('!', 1) if '!' in x.group(2) else ('', x.group(2))
        if chave(planilha_.strip("'")) != chave(ABA):
            return x.group(0)
        nova = mp.area(area.encode())
        return x.group(1) + planilha_ + '!' + (nova.decode() if nova else area) + x.group(3)
    wb_xml = re.sub(r'(<definedName[^>]*>)([^<]*)(</definedName>)', nome, wb_xml)
    # recalcula ao abrir (fórmulas que apontavam para as linhas apagadas)
    wb_xml = re.sub(r'<calcPr\b(?![^>]*fullCalcOnLoad)', '<calcPr fullCalcOnLoad="1"', wb_xml, count=1)
    return cab + novos + rodape, wb_xml


def sem_calcchain(entradas, trocas):
    """Tira o calcChain.xml (lista de células com fórmula na ordem de cálculo; o Excel refaz sozinho) do pacote."""
    for info, dados in entradas:
        if info.filename == '[Content_Types].xml':
            trocas[info.filename] = re.sub(rb'<Override[^>]*calcChain[^>]*/>', b'', trocas.get(info.filename, dados))
        elif info.filename == 'xl/_rels/workbook.xml.rels':
            trocas[info.filename] = re.sub(rb'<Relationship[^>]*calcChain[^>]*/>', b'', trocas.get(info.filename, dados))
    return [(i, d) for i, d in entradas if i.filename != 'xl/calcChain.xml']


def tanque_da_linha(combustivel):
    """TIPO COMBUSTIVEL (coluna N) -> 'arla' / 'diesel' / None (mesma regra do vigia: scripts/bomba_rateio.mjs tanqueDe)."""
    t = str(combustivel or '').upper()
    return 'arla' if 'ARLA' in t else 'diesel' if t.strip().startswith('DIESEL') else None


def escolher_linha(it, achadas, comb_da_linha, data_da_linha, por_data, kd):
    """Linha da Base_copia de um pedido de correção. Com tanque no pedido (Rateio das NFs, desde 17/11/2026) só vale linha
    daquele combustível: o diesel e o Arla do mesmo caminhão são lançados no mesmo segundo e a linha anotada no pedido pode
    ter virado a do outro combustível (lote ou exclusão no meio da planilha)."""
    tq = it.get('tanque')
    ok = (lambda r: tanque_da_linha(comb_da_linha.get(r)) == tq) if tq in ('diesel', 'arla') else (lambda r: True)
    achadas = [r for r in achadas if ok(r)]
    r = it['linha'] if it['linha'] in achadas else (achadas[0] if len(achadas) == 1 else None)
    if r is None and kd is not None and data_da_linha.get(it['linha']) == kd and ok(it['linha']):
        r = it['linha']   # placa da linha já trocada por uma correção anterior: mesma linha e mesma data
    if r is None and kd is not None:
        mesmas = [x for x in por_data.get(kd, []) if ok(x)]
        if len(mesmas) == 1:
            r = mesmas[0]   # placa trocada e linha mudou de lugar (exclusão acima): único com a mesma data
    return r


def editar(arquivo_json):
    """Edições da página Operacional > Editar abastecimentos.
    edicoes.json = [{"id": 1, "itens": [{"linha": 60100, "placa": "ABC1D23", "data": 46299.93, "acao": "editar",
                                          "celulas": {"Q": 123456, "R": 512}}]}]
    Cada item só é gravado se a linha ainda for o mesmo abastecimento (placa + data); se a linha mudou de lugar (linhas
    inseridas/apagadas à mão), procura pela placa + data. Se a placa da linha já foi trocada por uma correção anterior,
    vale a linha informada quando a data (ao segundo) é a mesma. O formato de cada célula fica como estava.
      - placa nova (F): tipo de frota, modelo, número de frota e ano (G a J) vêm do último abastecimento da placa nova;
      - motorista novo (L): a matrícula (K) vem do último abastecimento desse motorista;
      - acao "excluir": a linha é apagada e as de baixo sobem (remover_linhas ajusta fórmulas, formatação condicional,
        filtro etc.). As edições do mesmo lote são feitas antes, na numeração antiga."""
    with open(arquivo_json, encoding='utf-8-sig') as f:
        lotes = json.load(f)
    if not lotes:
        return saida({'itens': []})
    caminho = planilha()
    if not caminho or not os.path.isfile(caminho):
        return erro_todos(lotes, 'Planilha Base_copia não encontrada na pasta CONTROLES.')
    if pc.planilha_aberta(caminho):
        return erro_todos(lotes, 'A Base_copia está aberta no Excel. As alterações serão gravadas quando ela for fechada.', 'aguardando')
    with zipfile.ZipFile(caminho) as z:
        try:
            arq_aba = pc.caminho_aba(z, ABA)
        except ValueError as e:
            return erro_todos(lotes, str(e))
        textos, xml_sst = pc.ler_compartilhados(z)
        xml = z.read(arq_aba)
        wb_xml = z.read('xl/workbook.xml').decode('utf-8')
        entradas = [(i, z.read(i.filename)) for i in z.infolist()]
    ini_dados, fim_dados = xml.find(b'<sheetData>'), xml.find(b'</sheetData>')
    # placa + data -> linhas (para achar o abastecimento se a linha mudou de lugar); data de cada linha; último
    # abastecimento de cada placa (G a J) e de cada motorista (K), para completar a troca de placa/motorista
    por_chave, data_da_linha, por_data, ult_placa, ult_mot, comb_da_linha = {}, {}, {}, {}, {}, {}
    quer = {b'E', b'F', b'N'} | {c.encode() for c in VEICULO} | {MATRICULA.encode(), MOTORISTA.encode()}
    for m in re.finditer(rb'<row r="(\d+)"[^>]*?(?:/>|>(.*?)</row>)', xml[ini_dados:fim_dados], re.S):
        cel = {c.group(1).decode(): pc.valor_celula(c.group(3), c.group(4), textos)
               for c in pc.RE_CELULA.finditer(m.group(2) or b'') if c.group(1) in quer}
        r = int(m.group(1))
        k = chave_abastecimento(cel.get('F'), cel.get('E'), None)[:2]
        comb_da_linha[r] = cel.get('N')
        por_chave.setdefault(k, []).append(r)
        data_da_linha[r] = k[1]
        if k[1] is not None:
            por_data.setdefault(k[1], []).append(r)
        if k[0] and k[1] is not None:
            if k[1] >= ult_placa.get(k[0], (-1,))[0]:
                ult_placa[k[0]] = (k[1], {c: cel.get(c) for c in VEICULO})
            km = chave(cel.get(MOTORISTA))
            if km and cel.get(MATRICULA) not in (None, '') and k[1] >= ult_mot.get(km, (-1,))[0]:
                ult_mot[km] = (k[1], cel.get(MATRICULA))
    sst = pc.Compartilhados(textos, xml_sst)
    ordem = lambda c: (len(c), c)

    def num(v):
        return repr(float(v)) if isinstance(v, float) and not v.is_integer() else str(int(v))

    # resolve as linhas de todos os itens; vários itens na mesma linha se juntam (vale o último); excluir vence
    por_linha, excluir, resultado = {}, set(), []
    for lote in lotes:
        erros, ok, sem_acao = [], 0, False
        for it in lote['itens']:
            if 'acao' not in it and not it.get('celulas'):
                # exclusão vinda de um vigia antigo (que não manda a ação): não marca como gravada sem ter excluído;
                # fica "aguardando" e é refeita quando um vigia atualizado pegar o pedido
                erros.append(f'{it["placa"]} (linha {it["linha"]}): pedido sem a ação; reinicie o vigia deste computador.')
                sem_acao = True
                continue
            achadas = por_chave.get(chave_abastecimento(it['placa'], it['data'], None)[:2], [])
            kd = chave_abastecimento(None, it['data'], None)[1]
            r = escolher_linha(it, achadas, comb_da_linha, data_da_linha, por_data, kd)
            if r is None:
                erros.append(f'{it["placa"]} (linha {it["linha"]}): não encontrei o abastecimento na planilha.')
                continue
            if it.get('acao') == 'excluir':
                excluir.add(r)
                ok += 1
                continue
            novas = {c: v for c, v in it['celulas'].items() if c in COLS}
            if novas.get('F') and not any(c in novas for c in VEICULO):
                info = ult_placa.get(pc.norm_placa(novas['F']))
                if info:
                    novas.update({c: v for c, v in info[1].items()})
            if novas.get(MOTORISTA) and MATRICULA not in novas:
                info = ult_mot.get(chave(novas[MOTORISTA]))
                novas[MATRICULA] = info[1] if info else None   # motorista sem matrícula conhecida: fica vazia
            por_linha.setdefault(r, {}).update(novas)
            # data nova (E, 16/11/2026): os pedidos seguintes da mesma linha vêm com essa data (a página manda a data que a
            # planilha terá); registra a linha também por ela, para achá-la ainda nesta passada
            if isinstance(novas.get('E'), (int, float)) and not isinstance(novas.get('E'), bool):
                kn = chave_abastecimento(novas.get('F') or it['placa'], novas['E'], None)[:2]
                por_chave.setdefault(kn, []).append(r)
                data_da_linha[r] = kn[1]
                por_data.setdefault(kn[1], []).append(r)
            ok += 1
        resultado.append({'id': lote['id'], 'estado': ('aguardando' if sem_acao else 'erro') if erros and not ok else 'aplicada',
                          'mensagem': ' '.join(erros)[:300] if erros else None, 'gravados': ok})
    for r in excluir:
        por_linha.pop(r, None)
    if not por_linha and not excluir:
        return saida({'itens': resultado})

    # remonta o XML numa passada só, trocando as linhas editadas (na numeração de antes das exclusões)
    partes, pos_atual = [], 0
    for r in sorted(por_linha):
        ini, fim, tag = pc.achar_linha(xml, r)
        corpo = b'' if tag.endswith(b'/>') else xml[ini + len(tag):fim - len(b'</row>')]
        celulas = {m.group(1).decode(): m.group(0) for m in pc.RE_CELULA.finditer(corpo)}
        for col, v in por_linha[r].items():
            s = pc.estilo(celulas.get(col))
            attr = f' s="{s}"' if s else ''
            if v is None or v == '':
                celulas[col] = f'<c r="{col}{r}"{attr}/>'.encode()
            elif isinstance(v, (int, float)) and not isinstance(v, bool):
                celulas[col] = f'<c r="{col}{r}"{attr}><v>{num(v)}</v></c>'.encode()
            else:
                celulas[col] = f'<c r="{col}{r}"{attr} t="s"><v>{sst(str(v))}</v></c>'.encode()
        abre = tag[:-2] + b'>' if tag.endswith(b'/>') else tag
        partes += [xml[pos_atual:ini], abre, b''.join(celulas[c] for c in sorted(celulas, key=ordem)), b'</row>']
        pos_atual = fim
    partes.append(xml[pos_atual:])
    xml = b''.join(partes)

    trocas = {}
    # exclusões: as linhas saem e as de baixo sobem (abastecimentos apagados: placa + data, para conferir depois)
    apagados = collections.Counter()
    linhas_antes = xml.count(b'<row ')
    if excluir:
        for r in excluir:
            pos = pc.achar_linha(xml, r)
            cel = {c.group(1).decode(): pc.valor_celula(c.group(3), c.group(4), textos)
                   for c in pc.RE_CELULA.finditer(xml[pos[0]:pos[1]]) if c.group(1) in (b'E', b'F')}
            apagados[chave_abastecimento(cel.get('F'), cel.get('E'), None)[:2]] += 1
        xml, wb_xml = remover_linhas(xml, wb_xml, excluir)
        trocas['xl/workbook.xml'] = wb_xml.encode('utf-8')
        entradas = sem_calcchain(entradas, trocas)
    mapa = Renumerar(excluir)
    trocas[arq_aba] = xml
    novo_sst = sst.xml_novo()
    if novo_sst is not None:
        trocas['xl/sharedStrings.xml'] = novo_sst.encode('utf-8')
    copia = guardar_copia(caminho)
    tmp = os.path.join(os.path.dirname(COPIAS), 'gravando-base-copia.xlsx')
    with zipfile.ZipFile(tmp, 'w') as zout:
        for info, dados in entradas:
            zout.writestr(info, trocas.get(info.filename, dados), compress_type=info.compress_type)
    # confere: cada linha editada (no lugar novo, se subiu) continua com a placa e tem os valores novos
    with zipfile.ZipFile(tmp) as z:
        x2 = z.read(arq_aba)
        t2, _ = pc.ler_compartilhados(z)
    falhou = False
    for r0, cel_novas in por_linha.items():
        r = mapa.n(r0)
        pos = pc.achar_linha(x2, r)
        lidas = {c.group(1).decode(): pc.valor_celula(c.group(3), c.group(4), t2)
                 for c in pc.RE_CELULA.finditer(x2[pos[0]:pos[1]])} if pos else {}
        if not lidas.get('F') or any(str(lidas.get(c) if lidas.get(c) is not None else '') != str(v if v is not None else '')
                                     and not (isinstance(v, (int, float)) and isinstance(lidas.get(c), (int, float)) and abs(lidas[c] - v) < 1e-9)
                                     for c, v in cel_novas.items()):
            falhou = True
            break
    # excluídas: a aba tem as linhas a menos e cada abastecimento apagado saiu (uma vez cada)
    if excluir and not falhou:
        if x2.count(b'<row ') != linhas_antes - len(excluir):
            falhou = True
        else:
            restantes = collections.Counter()
            i2, f2 = x2.find(b'<sheetData>'), x2.find(b'</sheetData>')
            for m in re.finditer(rb'<row r="(\d+)"[^>]*?(?:/>|>(.*?)</row>)', x2[i2:f2], re.S):
                cel = {c.group(1).decode(): pc.valor_celula(c.group(3), c.group(4), t2)
                       for c in pc.RE_CELULA.finditer(m.group(2) or b'') if c.group(1) in (b'E', b'F')}
                k = chave_abastecimento(cel.get('F'), cel.get('E'), None)[:2]
                if k in apagados:
                    restantes[k] += 1
            antes = collections.Counter(k for k in por_chave for _ in por_chave[k] if k in apagados)
            falhou = any(restantes[k] != antes[k] - n for k, n in apagados.items())
    if falhou:
        os.remove(tmp)
        os.remove(copia)
        return erro_todos(lotes, 'A conferência depois de gravar falhou; a Base_copia não foi alterada.')
    if pc.planilha_aberta(caminho):
        os.remove(tmp)
        return erro_todos(lotes, 'A Base_copia foi aberta no Excel durante a gravação; tenta de novo quando ela for fechada.', 'aguardando')
    try:
        pc.substituir(tmp, caminho, copia)   # confere o arquivo depois de gravar (ownCloud)
    finally:
        os.remove(tmp)
    saida({'itens': resultado, 'copia': copia})


def ordenar():
    """Põe em ordem de data e hora o trecho final da aba que estiver fora de ordem (mesma regra da gravação).
    py scripts/planilha_base_copia.py ordenar"""
    caminho = planilha()
    if not caminho or not os.path.isfile(caminho):
        return saida({'erro': 'Planilha Base_copia não encontrada na pasta CONTROLES.'})
    if pc.planilha_aberta(caminho):
        return saida({'erro': 'A Base_copia está aberta no Excel. Feche e rode de novo.'})
    with zipfile.ZipFile(caminho) as z:
        arq_aba = pc.caminho_aba(z, ABA)
        textos, _ = pc.ler_compartilhados(z)
        xml = z.read(arq_aba)
        entradas = [(i, z.read(i.filename)) for i in z.infolist()]
    ini_dados, fim_dados = xml.find(b'<sheetData>'), xml.find(b'</sheetData>')
    linhas = list(re.finditer(rb'<row r="(\d+)"[^>]*?(?:/>|>(.*?)</row>)', xml[ini_dados:fim_dados], re.S))
    dados_aba, ultima_pos = [], None
    for m in linhas[1:]:
        corpo = m.group(2) or b''
        if not re.search(rb'<(v|f|is)\b', corpo):
            continue
        e = next((pc.valor_celula(c.group(3), c.group(4), textos) for c in pc.RE_CELULA.finditer(corpo) if c.group(1) == b'E'), None)
        dados_aba.append((int(m.group(1)), e, m))
        ultima_pos = m
    if ultima_pos is None:
        return saida({'erro': 'A aba Transações está vazia.'})
    xml, n, _, primeira = intercalar(xml, ini_dados, fim_dados, dados_aba, ultima_pos, [], None)
    if primeira is None:
        return saida({'reordenadas': 0, 'mensagem': 'A aba já está em ordem de data e hora (ou o trecho não pode ser reordenado com segurança).'})
    copia = guardar_copia(caminho)
    tmp = os.path.join(os.path.dirname(COPIAS), 'gravando-base-copia.xlsx')
    with zipfile.ZipFile(tmp, 'w') as zout:
        for info, dados in entradas:
            zout.writestr(info, xml if info.filename == arq_aba else dados, compress_type=info.compress_type)
    with zipfile.ZipFile(tmp) as z:
        x2 = z.read(arq_aba)
        t2, _ = pc.ler_compartilhados(z)
    if x2.count(b'<row ') != len(linhas) or not em_ordem(x2, t2, primeira, n):
        os.remove(tmp)
        os.remove(copia)
        return saida({'erro': 'A conferência depois de ordenar falhou; a Base_copia não foi alterada.'})
    if pc.planilha_aberta(caminho):
        os.remove(tmp)
        return saida({'erro': 'A Base_copia foi aberta no Excel durante a gravação. Feche e rode de novo.'})
    try:
        pc.substituir(tmp, caminho, copia)
    finally:
        os.remove(tmp)
    saida({'reordenadas': n - primeira + 1, 'de': primeira, 'ate': n, 'copia': copia})


def compactar(linhas_txt):
    """Apaga linhas que ficaram vazias (exclusões da versão que só esvaziava a linha), subindo as de baixo.
    py scripts/planilha_base_copia.py compactar 60230,60242 — só apaga as que estiverem mesmo vazias (sem data,
    placa, litros e hodômetro)."""
    pedidas = sorted({int(x) for x in linhas_txt.split(',') if x.strip()})
    caminho = planilha()
    if not caminho or not os.path.isfile(caminho):
        return saida({'erro': 'Planilha Base_copia não encontrada na pasta CONTROLES.'})
    if pc.planilha_aberta(caminho):
        return saida({'erro': 'A Base_copia está aberta no Excel. Feche e rode de novo.'})
    with zipfile.ZipFile(caminho) as z:
        arq_aba = pc.caminho_aba(z, ABA)
        textos, _ = pc.ler_compartilhados(z)
        xml = z.read(arq_aba)
        wb_xml = z.read('xl/workbook.xml').decode('utf-8')
        entradas = [(i, z.read(i.filename)) for i in z.infolist()]
    vazias, recusadas = set(), []
    for r in pedidas:
        pos = pc.achar_linha(xml, r)
        if not pos:
            recusadas.append(f'{r}: não existe')
            continue
        cel = {c.group(1).decode(): pc.valor_celula(c.group(3), c.group(4), textos)
               for c in pc.RE_CELULA.finditer(xml[pos[0]:pos[1]]) if c.group(1) in (b'E', b'F', b'O', b'Q')}
        if any(v not in (None, '') for v in cel.values()):
            recusadas.append(f'{r}: tem dados')
        else:
            vazias.add(r)
    if not vazias:
        return saida({'apagadas': [], 'recusadas': recusadas})
    antes = xml.count(b'<row ')
    xml, wb_xml = remover_linhas(xml, wb_xml, vazias)
    trocas = {arq_aba: xml, 'xl/workbook.xml': wb_xml.encode('utf-8')}
    entradas = sem_calcchain(entradas, trocas)
    copia = guardar_copia(caminho)
    tmp = os.path.join(os.path.dirname(COPIAS), 'gravando-base-copia.xlsx')
    with zipfile.ZipFile(tmp, 'w') as zout:
        for info, dados in entradas:
            zout.writestr(info, trocas.get(info.filename, dados), compress_type=info.compress_type)
    with zipfile.ZipFile(tmp) as z:
        ok = z.read(arq_aba).count(b'<row ') == antes - len(vazias)
    if not ok:
        os.remove(tmp)
        os.remove(copia)
        return saida({'erro': 'A conferência depois de apagar falhou; a Base_copia não foi alterada.'})
    if pc.planilha_aberta(caminho):
        os.remove(tmp)
        return saida({'erro': 'A Base_copia foi aberta no Excel durante a gravação. Feche e rode de novo.'})
    try:
        pc.substituir(tmp, caminho, copia)
    finally:
        os.remove(tmp)
    saida({'apagadas': sorted(vazias), 'recusadas': recusadas, 'copia': copia})


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) >= 3 and sys.argv[1] == 'gravar':
        gravar(sys.argv[2])
    elif len(sys.argv) >= 3 and sys.argv[1] == 'editar':
        editar(sys.argv[2])
    elif len(sys.argv) >= 3 and sys.argv[1] == 'compactar':
        compactar(sys.argv[2])
    elif len(sys.argv) >= 2 and sys.argv[1] == 'ordenar':
        ordenar()
    else:
        print(__doc__)
        sys.exit(1)
