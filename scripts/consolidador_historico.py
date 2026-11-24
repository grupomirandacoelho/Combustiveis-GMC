"""Histórico da Base para o Consolidador de abastecimentos do site (Operacional > Consolidador).

    py scripts/consolidador_historico.py          gera .dados/consolidacao.json

Lê (cópias, só leitura) a Base.xlsx da pasta Dashboars Logística e a CONTROLES\\Base_copia.xlsx (onde o site grava os
abastecimentos consolidados) e junta as duas, sem linhas repetidas. Não refaz a lógica do consolidador: só exporta, em
formato compacto, as colunas da aba Transações que o carregarBase() do consolidador lê de cada linha. O site remonta
as linhas e roda o mesmo carregarBase() do HTML original (public/gestao/lib/consolidador.js).

Colunas (índice da aba Transações, como no HTML): 1 forma de pagamento, 4 data, 5 placa, 10 matrícula, 11 motorista,
13 combustível, 15 vl/litro, 16 hodômetro, 21 posto; veículo = 2,3,6,7,8,9,12,27..39; posto = 20,22..26.
Quem chama é o vigia (scripts/sincronizar.mjs), que envia o arquivo para a chave "consolidacao" do KV.
Saída: uma linha JSON no stdout.
"""
import datetime as dt
import glob
import json
import os
import shutil
import sys
import tempfile
import unicodedata

import openpyxl

PASTA_PROJETO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get('BASE_CONSOLIDADOR') or os.path.join(os.path.dirname(PASTA_PROJETO), 'Base.xlsx')
SAIDA = os.path.join(PASTA_PROJETO, '.dados', 'consolidacao.json')
EPOCA_EXCEL = dt.datetime(1899, 12, 30)
COL_VEICULO = [2, 3, 6, 7, 8, 9, 12] + list(range(27, 40))
COL_POSTO = [20, 22, 23, 24, 25, 26]
CABECALHO = {1: 'FORMA DE PAGAMENTO', 4: 'DATA TRANSACAO', 5: 'PLACA', 10: 'MATRICULA', 11: 'NOME MOTORISTA',
             13: 'TIPO COMBUSTIVEL', 15: 'VL/LITRO', 16: 'HODOMETRO OU HORIMETRO', 21: 'NOME ESTABELECIMENTO'}


def chave(s):
    return ' '.join(unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().upper().split())


def base_copia():
    if os.environ.get('PLANILHA_BASE_COPIA'):
        return os.environ['PLANILHA_BASE_COPIA']
    achados = [p for p in glob.glob(os.path.join(PASTA_PROJETO, 'CONTROLES', '*.xlsx'))
               if not os.path.basename(p).startswith('~$') and 'conflict' not in os.path.basename(p).lower() and chave(os.path.basename(p)).startswith('BASE')]
    return sorted(achados)[0] if achados else None


def saida(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')


def valor(v):
    """Valor da célula como o SheetJS (raw) entregaria ao HTML: número, texto ou null; data vira número serial."""
    if v is None:
        return None
    if isinstance(v, dt.datetime):
        return (v - EPOCA_EXCEL).total_seconds() / 86400
    if isinstance(v, dt.date):
        return (dt.datetime(v.year, v.month, v.day) - EPOCA_EXCEL).days
    if isinstance(v, dt.time):
        return (v.hour * 3600 + v.minute * 60 + v.second) / 86400
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


class Dic:
    def __init__(self):
        self.lista, self.idx = [], {}

    def __call__(self, v):
        k = json.dumps(v, ensure_ascii=False)
        if k not in self.idx:
            self.idx[k] = len(self.lista)
            self.lista.append(v)
        return self.idx[k]


def ler(caminho, tmp, nome_copia):
    copia = os.path.join(tmp, nome_copia)
    shutil.copy2(caminho, copia)
    wb = openpyxl.load_workbook(copia, read_only=True, data_only=True)
    try:
        ws = wb['Transações']
        ws.reset_dimensions()
        linhas = ws.iter_rows(values_only=True)
        cab = [chave(c) for c in next(linhas)]
        for i, titulo in CABECALHO.items():
            if i >= len(cab) or cab[i] != chave(titulo):
                raise ValueError(f'{os.path.basename(caminho)}: a coluna {i + 1} da aba Transações deveria ser "{titulo}".')
        for r in linhas:
            if r is None:
                continue
            r = tuple(r) + (None,) * (40 - len(r))
            yield [valor(c) for c in r[:40]]
    finally:
        wb.close()


def gerar():
    if not os.path.isfile(BASE):
        return saida({'erro': f'Base não encontrada: {BASE}'})
    fontes = [(BASE, 'base.xlsx')]
    bc = base_copia()
    if bc and os.path.isfile(bc):
        fontes.append((bc, 'base-copia.xlsx'))
    dics = {k: Dic() for k in ('placa', 'fuel', 'forma', 'posto', 'mot', 'mat')}
    vt, pt = Dic(), Dic()
    col = {k: [] for k in ('dt', 'placa', 'hodo', 'fuel', 'forma', 'vl', 'posto', 'mot', 'mat', 'v', 'p')}
    vistas, resumo, datamax = set(), [], None
    tmp = tempfile.mkdtemp(prefix='consolidador-')
    try:
        for caminho, nome in fontes:
            n = novas = 0
            anteriores, vistas = vistas, set()   # só tira o que já veio da planilha anterior (dentro da mesma, fica como está)
            for r in ler(caminho, tmp, nome):
                d, placa = r[4], r[5]
                if not placa or not isinstance(d, (int, float)) or isinstance(d, bool):
                    continue   # o carregarBase ignora linha sem placa ou sem data numérica
                n += 1
                linha = (round(d, 6), placa, r[16], r[13], r[1], r[15], r[21], r[11], r[10],
                         tuple(r[i] for i in COL_VEICULO), tuple(r[i] for i in COL_POSTO))
                k = json.dumps(linha, ensure_ascii=False, default=str)
                vistas.add(k)
                if k in anteriores:
                    continue   # a mesma linha nas duas planilhas (a Base_copia começa como cópia da Base)
                novas += 1
                datamax = d if datamax is None or d > datamax else datamax
                col['dt'].append(d)
                col['placa'].append(dics['placa'](placa))
                col['hodo'].append(r[16])
                col['fuel'].append(dics['fuel'](r[13]))
                col['forma'].append(dics['forma'](r[1]))
                col['vl'].append(r[15])
                col['posto'].append(dics['posto'](r[21]))
                col['mot'].append(dics['mot'](r[11]))
                col['mat'].append(dics['mat'](r[10]))
                col['v'].append(vt([r[i] for i in COL_VEICULO]))
                col['p'].append(pt([r[i] for i in COL_POSTO]))
            resumo.append({'arquivo': os.path.basename(caminho), 'linhas': n, 'novas': novas})
            vistas |= anteriores
    except ValueError as e:
        return saida({'erro': str(e)})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    agora = dt.datetime.now()
    d = {
        'versao': agora.strftime('%Y%m%d%H%M%S'), 'geradoEm': agora.strftime('%Y-%m-%dT%H:%M:%S'),
        'fontes': resumo, 'linhas': len(col['dt']), 'datamax': datamax,
        'dic': {k: v.lista for k, v in dics.items()}, 'veiculos': vt.lista, 'postos': pt.lista, 'col': col,
    }
    os.makedirs(os.path.dirname(SAIDA), exist_ok=True)
    with open(SAIDA, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, separators=(',', ':'))
    saida({'versao': d['versao'], 'linhas': d['linhas'], 'fontes': resumo, 'bytes': os.path.getsize(SAIDA)})


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    gerar()
