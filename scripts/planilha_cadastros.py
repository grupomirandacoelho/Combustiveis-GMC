"""Planilha de placas e motoristas (pasta CONTROLES, "Controle_motoristas_e_placas.xlsx") <-> portal.

    py scripts/planilha_cadastros.py gerar                      lista para o portal (.dados/cadastros.json)
    py scripts/planilha_cadastros.py gravar <alteracoes.json>   grava as alterações feitas no portal
    py scripts/planilha_cadastros.py migrar-sem-cpf <copia>     uma vez (12/11/2026): CPF vira USUARIO (6 primeiros números)
                                                                e saem DATA NASCIMENTO, CNH, CATEGORIA CNH e VALIDADE CNH

Quem chama é o vigia (scripts/sincronizar.mjs). Cuidados ao gravar:
  - a linha é achada pela placa (aba Carros) ou pelo usuário (aba Motoristas); só os campos alterados são escritos;
  - a aba Motoristas não tem dados pessoais (CPF, nascimento, CNH) desde 12/11/2026: só o USUARIO de 6 números;
  - se a planilha estiver aberta no Excel, não grava e devolve "aguardando" (o vigia tenta de novo);
  - antes de gravar, guarda uma cópia em .dados\\copias-planilha (as 30 mais recentes);
  - confere o cabeçalho das abas: se as colunas mudaram de lugar, não grava nada;
  - fórmulas de PONTO CRITICO (H) e AUTON MARGEM DE SEG. (J) ficam como estão; linha nova recebe as fórmulas.
Saída: uma linha JSON no stdout (sem senhas).
"""
import datetime as dt
import glob
import json
import os
import re
import shutil
import sys
import unicodedata

import openpyxl
from openpyxl.formatting.formatting import ConditionalFormattingList
from openpyxl.worksheet.cell_range import MultiCellRange

PASTA_PROJETO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COPIAS = os.path.join(PASTA_PROJETO, '.dados', 'copias-planilha')
SAIDA = os.path.join(PASTA_PROJETO, '.dados', 'cadastros.json')

# coluna -> campo do portal (lib/cadastros.js); o cabeçalho é conferido antes de ler ou gravar
ABAS = {
    'placas': {'aba': 'Carros', 'chave': 'placa', 'colunas': [
        ('PLACA', 'placa'), ('CATEGORIA', 'categoria'), ('UNIDADE', 'unidade'), ('MARCA', 'marca'), ('MODELO', 'modelo'),
        ('ANO', 'ano'), ('META', 'meta'), ('PONTO CRITICO', 'pontoCritico'), ('CAP TANQUE', 'capTanque'),
        ('AUTON MARGEM DE SEG.', 'autonomia'), ('SITUACAO', 'situacao')],
        # coluna K (ATIVA / DESABILITADA) foi criada pelo portal: se ainda não existir, é criada na primeira gravação
        'opcionais': {'SITUACAO': 'ATIVA'}},
    # C = USUARIO: login da área do motorista (6 primeiros números do CPF, guardados como texto por causa do zero à esquerda)
    'motoristas': {'aba': 'Motoristas', 'chave': 'usuario', 'colunas': [
        ('MOTORISTA', 'nome'), ('UNIDADE', 'unidade'), ('USUARIO', 'usuario'), ('SENHA TICKET', 'senhaTicket'),
        ('SENHA TRUCKPAG', 'senhaTruckpag'), ('SENHA VELOE', 'senhaVeloe'), ('SITUACAO', 'situacao'),
        # H..J: números dos cartões (criadas na primeira gravação, se faltarem)
        ('MATRICULA', 'matricula'), ('CODIGO TICKET', 'codigoTicket'), ('ID TRUCKPAG', 'idTruckpag')],
        'novas': {'MATRICULA', 'CODIGO TICKET', 'ID TRUCKPAG'}},
}
# layout antigo da aba Motoristas (até 12/11/2026), para a migração
ANTIGAS_MOTORISTAS = ['MOTORISTA', 'UNIDADE', 'CPF', 'SENHA TICKET', 'SENHA TRUCKPAG', 'SENHA VELOE', 'SITUACAO', 'DATA NASCIMENTO',
                      'MATRICULA', 'CNH', 'CATEGORIA CNH', 'VALIDADE CNH', 'CODIGO TICKET', 'ID TRUCKPAG']
CALCULADOS = {'pontoCritico', 'autonomia'}
NUMEROS = {'ano', 'meta', 'capTanque', 'matricula', 'codigoTicket', 'idTruckpag'}


def chave(s):
    return ' '.join(unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().upper().split())


def planilha():
    """O arquivo da pasta CONTROLES (o nome já mudou uma vez: procura pelo padrão)."""
    if os.environ.get('PLANILHA_CADASTROS'):
        return os.environ['PLANILHA_CADASTROS']
    achados = [p for p in glob.glob(os.path.join(PASTA_PROJETO, 'CONTROLES', '*.xlsx'))
               if not os.path.basename(p).startswith('~$') and 'conflict' not in os.path.basename(p).lower() and 'MOTORISTA' in chave(os.path.basename(p))]
    return sorted(achados)[0] if achados else None


def norm_chave(tipo, v):
    if tipo == 'placas':
        return re.sub(r'[^A-Z0-9]', '', str(v or '').upper())
    return usuario(v) or ''


def usuario(v):
    """Usuário do motorista: 6 números como texto ('012345'); célula numérica perde o zero à esquerda."""
    if v is None or v == '' or isinstance(v, bool):
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    d = re.sub(r'\D', '', str(v))
    return d.zfill(6) if 0 < len(d) <= 6 else (d or None)


def saida(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')


def planilha_aberta(caminho):
    pasta, nome = os.path.split(caminho)
    if os.path.exists(os.path.join(pasta, '~$' + nome)) or os.path.exists(os.path.join(pasta, '~$' + nome[2:])):
        return True
    try:
        with open(caminho, 'r+b'):
            return False
    except PermissionError:
        return True


def guardar_copia(caminho):
    os.makedirs(COPIAS, exist_ok=True)
    destino = os.path.join(COPIAS, 'cadastros-' + dt.datetime.now().strftime('%Y%m%d-%H%M%S') + '.xlsx')
    shutil.copy2(caminho, destino)
    for velho in sorted(glob.glob(os.path.join(COPIAS, 'cadastros-*.xlsx')))[:-30]:
        try:
            os.remove(velho)
        except OSError:
            pass
    return destino


def aba(wb, nome):
    for ws in wb.worksheets:
        if chave(ws.title) == chave(nome):
            return ws
    raise ValueError(f'Aba "{nome}" não encontrada na planilha.')


def conferir_cabecalho(ws, conf, criar=False):
    """Confere o título de cada coluna. Coluna opcional ainda sem título é aceita (e criada se criar=True)."""
    for i, (titulo, _) in enumerate(conf['colunas'], start=1):
        atual = ws.cell(1, i).value
        if (titulo in conf.get('opcionais', {}) or titulo in conf.get('novas', ())) and atual in (None, ''):
            if criar:
                ws.cell(1, i).value = titulo
                if ws.cell(1, i - 1).has_style:
                    ws.cell(1, i)._style = ws.cell(1, i - 1)._style
            continue
        if chave(atual) != chave(titulo):
            raise ValueError(f'A coluna {openpyxl.utils.get_column_letter(i)} da aba "{ws.title}" deveria ser "{titulo}" '
                             f'e está "{ws.cell(1, i).value}". Nada foi gravado.')


def ultima_linha(ws):
    r = ws.max_row
    while r > 1 and ws.cell(r, 1).value in (None, ''):
        r -= 1
    return r


def numero(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def formula(v):
    return isinstance(v, str) and v.startswith('=')


def valor_exibido(campo, v):
    if v is None or v == '':
        return None
    if campo == 'usuario':
        return usuario(v)
    if campo in NUMEROS:
        return numero(v)
    if isinstance(v, (dt.datetime, dt.date)):   # data digitada no Excel
        return v.strftime('%d/%m/%Y')
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return ' '.join(str(v).split())


def ler(wb, wb_valores, tipo):
    conf = ABAS[tipo]
    ws, wv = aba(wb, conf['aba']), aba(wb_valores, conf['aba'])
    conferir_cabecalho(ws, conf)
    lista = []
    for r in range(2, ultima_linha(ws) + 1):
        if ws.cell(r, 1).value in (None, ''):
            continue
        item, brutos = {'linha': r}, {}
        for i, (_, campo) in enumerate(conf['colunas'], start=1):
            if campo in CALCULADOS:
                brutos[campo] = (ws.cell(r, i).value, wv.cell(r, i).value)
            else:
                item[campo] = valor_exibido(campo, ws.cell(r, i).value)
        for titulo, padrao in conf.get('opcionais', {}).items():   # vazio = valor padrão (ex.: placa ATIVA)
            campo = dict(conf['colunas'])[titulo]
            item[campo] = (str(item[campo]).upper() if item[campo] else padrao)
        if tipo == 'placas':
            # o openpyxl não calcula fórmulas: as duas conhecidas são calculadas aqui; outras usam o último valor do Excel
            meta, cap = numero(item['meta']), numero(item['capTanque'])
            contas = {
                'pontoCritico': (r'=IF\(G\d+<=0,"",G\d+-0\.5\)', (meta - 0.5) if meta and meta > 0 else None),
                'autonomia': (r'=I\d+\*G\d+\*0\.75', cap * meta * 0.75 if meta and cap else None),
            }
            for campo, (padrao, calculado) in contas.items():
                bruto, cache = brutos[campo]
                if formula(bruto):
                    v = calculado if re.fullmatch(padrao, bruto.replace(' ', ''), re.I) else numero(cache)
                else:
                    v = numero(bruto)
                item[campo] = round(v, 3) if v is not None else None
        lista.append(item)
    return lista


def gerar():
    caminho = planilha()
    if not caminho or not os.path.isfile(caminho):
        return saida({'erro': 'Planilha de placas e motoristas não encontrada na pasta CONTROLES.'})
    wb = openpyxl.load_workbook(caminho)
    wv = openpyxl.load_workbook(caminho, data_only=True)
    d = {'placas': ler(wb, wv, 'placas'), 'motoristas': ler(wb, wv, 'motoristas'), 'arquivo': os.path.basename(caminho)}
    os.makedirs(os.path.dirname(SAIDA), exist_ok=True)
    with open(SAIDA, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False)
    saida({'placas': len(d['placas']), 'motoristas': len(d['motoristas']), 'arquivo': d['arquivo']})


def estender_intervalo(sqref, ultima):
    partes = []
    for faixa in str(sqref).split():
        m = re.fullmatch(r'([A-Z]+)(\d+):([A-Z]+)(\d+)', faixa)
        if m and int(m.group(4)) < ultima:
            faixa = f'{m.group(1)}{m.group(2)}:{m.group(3)}{ultima}'
        partes.append(faixa)
    return ' '.join(partes)


def escrever(ws, r, tipo, campo, v):
    col = [c for _, c in ABAS[tipo]['colunas']].index(campo) + 1
    cel = ws.cell(r, col)
    if v is None or v == '':
        cel.value = None
    elif campo == 'usuario':
        cel.value = usuario(v)
        cel.number_format = '@'
    elif campo in NUMEROS:
        cel.value = int(v) if campo in ('ano', 'matricula', 'codigoTicket', 'idTruckpag') or float(v).is_integer() else float(v)
    elif campo == 'modelo' and isinstance(cel.value, int) and re.fullmatch(r'[1-9]\d*', str(v)):
        cel.value = int(v)   # modelos só com número (ex.: 1718) continuam número
    else:
        cel.value = str(v)


def formulas_placa(ws, r):
    """H e J vazios recebem as fórmulas da planilha (valores digitados à mão ficam)."""
    if ws.cell(r, 8).value in (None, ''):
        ws.cell(r, 8).value = f'=IF(G{r}<=0,"",G{r}-0.5)'
    if ws.cell(r, 10).value in (None, ''):
        ws.cell(r, 10).value = f'=I{r}*G{r}*0.75'


def gravar(arquivo_json):
    with open(arquivo_json, encoding='utf-8-sig') as f:
        alteracoes = json.load(f)
    if not alteracoes:
        return saida({'itens': []})
    caminho = planilha()
    if not caminho or not os.path.isfile(caminho):
        return saida({'itens': [{'id': a['id'], 'estado': 'erro', 'mensagem': 'Planilha não encontrada na pasta CONTROLES.'} for a in alteracoes]})
    if planilha_aberta(caminho):
        return saida({'itens': [{'id': a['id'], 'estado': 'aguardando',
                                 'mensagem': 'A planilha está aberta no Excel. A alteração será gravada quando ela for fechada.'}
                                for a in alteracoes]})
    wb = openpyxl.load_workbook(caminho)
    try:
        abas = {t: aba(wb, c['aba']) for t, c in ABAS.items()}
        for t, ws in abas.items():
            conferir_cabecalho(ws, ABAS[t], criar=True)
    except ValueError as e:
        return saida({'itens': [{'id': a['id'], 'estado': 'erro', 'mensagem': str(e)} for a in alteracoes]})
    copia = guardar_copia(caminho)
    itens, mexidas = [], set()
    for a in alteracoes:
        tipo, d = a['tipo'], a['dados']
        ws, conf = abas[tipo], ABAS[tipo]
        campos = [c for _, c in conf['colunas']]
        col_chave = campos.index(conf['chave']) + 1
        ultima = ultima_linha(ws)
        linhas = {norm_chave(tipo, ws.cell(r, col_chave).value): r for r in range(2, ultima + 1) if ws.cell(r, col_chave).value}
        nova = d.get(conf['chave'])
        if a['acao'] == 'editar':
            r = linhas.get(norm_chave(tipo, a['chave']))
            if not r:
                itens.append({'id': a['id'], 'estado': 'erro', 'mensagem': f'{a["chave"]} não está mais na planilha (foi apagado ou alterado à mão).'})
                continue
            if nova and norm_chave(tipo, nova) != norm_chave(tipo, a['chave']) and norm_chave(tipo, nova) in linhas:
                itens.append({'id': a['id'], 'estado': 'erro', 'mensagem': f'{nova} já existe em outra linha da planilha.'})
                continue
        else:
            if norm_chave(tipo, nova) in linhas:
                itens.append({'id': a['id'], 'estado': 'erro', 'mensagem': f'{nova} já existe na planilha.'})
                continue
            r = ultima + 1
            for c in range(1, len(campos) + 1):   # formato igual ao da linha de cima
                if ws.cell(ultima, c).has_style:
                    ws.cell(r, c)._style = ws.cell(ultima, c)._style
        for campo, v in d.items():
            if campo in campos and campo not in CALCULADOS:
                escrever(ws, r, tipo, campo, v)
        if tipo == 'placas':
            formulas_placa(ws, r)
        mexidas.add(tipo)
        itens.append({'id': a['id'], 'estado': 'aplicada', 'linha': r})

    if not mexidas:
        os.remove(copia)   # nada mudou: a cópia não precisa ficar
        return saida({'itens': itens})
    for tipo in mexidas:   # filtro, validações e formatação condicional cobrem as linhas novas
        ws = abas[tipo]
        ultima = ultima_linha(ws)
        if ws.auto_filter.ref:   # cobre as linhas novas e as colunas do portal (ex.: K criada depois)
            ultima_col = openpyxl.utils.get_column_letter(max(len(ABAS[tipo]['colunas']), ws.max_column))
            ws.auto_filter.ref = re.sub(r':[A-Z]+\d+$', f':{ultima_col}{ultima}', ws.auto_filter.ref)
        for dv in ws.data_validations.dataValidation:
            dv.sqref = MultiCellRange(estender_intervalo(dv.sqref, ultima))
        nova_cf = ConditionalFormattingList()
        for cf in ws.conditional_formatting:
            for regra in cf.rules:
                nova_cf.add(estender_intervalo(cf.sqref, ultima), regra)
        ws.conditional_formatting = nova_cf
    wb.calculation.fullCalcOnLoad = True   # o Excel recalcula as fórmulas ao abrir

    tmp = os.path.join(os.path.dirname(COPIAS), 'gravando-cadastros.xlsx')
    wb.save(tmp)
    openpyxl.load_workbook(tmp, read_only=True).close()   # confere que o arquivo abre
    if planilha_aberta(caminho):
        os.remove(tmp)
        return saida({'itens': [{'id': i['id'], 'estado': 'aguardando',
                                 'mensagem': 'A planilha foi aberta no Excel durante a gravação; tenta de novo quando ela for fechada.'}
                                if i['estado'] == 'aplicada' else i for i in itens]})
    import planilha_cartoes as pc   # substituir: confere o arquivo depois de gravar (ownCloud)
    try:
        pc.substituir(tmp, caminho, copia)
    finally:
        os.remove(tmp)
    saida({'itens': itens, 'copia': copia})


def migrar_sem_cpf(copia_fora):
    """Uma vez (12/11/2026, pedido do usuário): a coluna CPF vira USUARIO (6 primeiros números) e as colunas DATA NASCIMENTO,
    CNH, CATEGORIA CNH e VALIDADE CNH saem da aba Motoristas. A cópia de antes vai para copia_fora (fora do ownCloud, para
    apagar depois de conferir: tem CPF). Saída: contagens, nunca CPF."""
    caminho = planilha()
    if not caminho or not os.path.isfile(caminho):
        return saida({'erro': 'Planilha não encontrada.'})
    if planilha_aberta(caminho):
        return saida({'erro': 'A planilha está aberta no Excel. Feche e rode de novo.'})
    wb = openpyxl.load_workbook(caminho)
    ws = aba(wb, 'Motoristas')
    cab = [chave(ws.cell(1, i).value) for i in range(1, len(ANTIGAS_MOTORISTAS) + 1)]
    if cab != ANTIGAS_MOTORISTAS:
        return saida({'erro': 'O cabeçalho da aba Motoristas não é o esperado (já migrada?).', 'cabecalho': cab})
    shutil.copy2(caminho, copia_fora)
    ultima = ultima_linha(ws)
    vistos, sem, repetidos = {}, 0, 0
    for r in range(2, ultima + 1):
        if ws.cell(r, 1).value in (None, ''):
            continue
        d = re.sub(r'\D', '', str(ws.cell(r, 3).value or ''))
        u = d[:6] if len(d) == 11 else None
        if not u:
            sem += 1
        elif u in vistos:
            repetidos += 1
        else:
            vistos[u] = r
        ws.cell(r, 3).value = u
        ws.cell(r, 3).number_format = '@'
    ws.cell(1, 3).value = 'USUARIO'
    larguras = {i: ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width for i in range(1, 15)}
    for col in (12, 11, 10, 8):   # da direita para a esquerda: VALIDADE CNH, CATEGORIA CNH, CNH, DATA NASCIMENTO
        ws.delete_cols(col)
    restantes = [i for i in range(1, 15) if i not in (8, 10, 11, 12)]
    for novo, velho in enumerate(restantes, start=1):
        letra = openpyxl.utils.get_column_letter(novo)
        if larguras.get(velho):
            ws.column_dimensions[letra].width = larguras[velho]
    if ws.auto_filter.ref:
        ws.auto_filter.ref = f'A1:{openpyxl.utils.get_column_letter(len(restantes))}{ultima}'
    conferir_cabecalho(ws, ABAS['motoristas'])
    tmp = os.path.join(os.path.dirname(COPIAS), 'migrando-cadastros.xlsx')
    os.makedirs(os.path.dirname(tmp), exist_ok=True)
    wb.save(tmp)
    openpyxl.load_workbook(tmp, read_only=True).close()
    import planilha_cartoes as pc
    try:
        pc.substituir(tmp, caminho, copia_fora)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    saida({'ok': True, 'motoristas': len(vistos) + sem + repetidos, 'usuarios': len(vistos), 'semCpf': sem, 'repetidos': repetidos})


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) >= 3 and sys.argv[1] == 'migrar-sem-cpf':
        migrar_sem_cpf(sys.argv[2])
    elif len(sys.argv) >= 2 and sys.argv[1] == 'gerar':
        gerar()
    elif len(sys.argv) >= 3 and sys.argv[1] == 'gravar':
        gravar(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(1)
