"""Compara as planilhas de cadastro com o banco depois da virada (15.3, 25/11/2026; pedido do usuário "se tudo estiver ok você pode
seguir com a virada"): placas e motoristas (Controle_motoristas_e_placas.xlsx x gestao_cadastros_lista) e o controle dos cartões
frota (CONTROLE CARTÕES FROTA.xlsx x gestao_cartoes_lista). O banco é a origem; a planilha segue recebendo os mesmos pedidos pelo
vigia como cópia, e as duas precisam continuar iguais até desligar o vigia (15.4).

    py scripts/comparar_cadastros.py      resumo em JSON no stdout; relatório completo em .dados/comparacao-cadastros/

Só lê (as planilhas por cópia, como o vigia; o banco por SELECT). Nunca escreve senha no relatório (só o nome do campo).
Ponto crítico e autonomia: a planilha guarda fórmula (o valor só existe depois que o Excel abre); o banco calcula pela regra padrão
(meta - 0,5 e tanque x meta x 0,75). Vazio ou zero na planilha com valor no banco não conta como diferença.
"""
import datetime as dt
import json
import os
import shutil
import sys
import zipfile

import openpyxl

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import planilha_cadastros as pcad  # noqa: E402
import planilha_cartoes as pcart  # noqa: E402
import importar_base as ib  # noqa: E402
import tempfile  # noqa: E402
import supabase_sync as ss  # noqa: E402

PASTA = os.path.join(ss.PROJETO, '.dados', 'comparacao-cadastros')
CALCULADOS = {'pontoCritico', 'autonomia'}


def _n(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v


def diferencas(nome, planilha, banco, chave):
    a = {x.get(chave): x for x in planilha}
    b = {x.get(chave): x for x in banco}
    difs = []
    for k in sorted(set(a) | set(b), key=str):
        if k not in a or k not in b:
            difs.append({'lista': nome, 'chave': k, 'so_na': 'banco' if k in b else 'planilha'})
            continue
        for campo in sorted(set(a[k]) | set(b[k])):
            if campo == 'linha':
                continue   # posição não importa (a planilha e o banco numeram cada um do seu jeito)
            va, vb = a[k].get(campo), b[k].get(campo)
            if campo in CALCULADOS and va in (None, 0):
                continue
            if _n(va) != _n(vb):
                item = {'lista': nome, 'chave': k, 'campo': campo}
                if 'senha' not in campo.lower():
                    item.update({'planilha': va, 'banco': vb})
                difs.append(item)
    return difs


def precos(n):
    """negociação colunar (importar_base / gestao_bomba_extras) -> [{chave: dia|fornecedor|produto|unidade|n, preco}]; n = repetição
    da mesma chave (a planilha pode ter dois preços no mesmo dia, um vazio)"""
    if not n:
        return []
    d, c, vistos, out = n['dic'], n['col'], {}, []
    for i in range(len(c['data'])):
        k = '|'.join([str(c['data'][i]), d['fornecedor'][c['fornecedor'][i]], d['produto'][c['produto'][i]], d['unidade'][c['unidade'][i]]])
        vistos[k] = vistos.get(k, 0) + 1
        out.append({'chave': k + '|' + str(vistos[k]), 'preco': c['preco'][i]})
    return out


def comparar():
    copia = os.path.join(os.path.dirname(pcart.COPIAS), 'comparando-cadastros.xlsx')
    os.makedirs(os.path.dirname(copia), exist_ok=True)
    shutil.copy2(pcad.planilha(), copia)
    try:
        wb, wv = openpyxl.load_workbook(copia), openpyxl.load_workbook(copia, data_only=True)
        plan = {'placas': pcad.ler(wb, wv, 'placas'), 'motoristas': pcad.ler(wb, wv, 'motoristas')}
    finally:
        os.remove(copia)
    with zipfile.ZipFile(pcart.planilha()) as z:
        cartoes = pcart.ler_cartoes(z)[0]
    with tempfile.TemporaryDirectory() as tmp:   # bomba interna (virada de 25/11/2026), lida como o vigia lê para os painéis
        neg, forn = ib.ler_bomba_interna(ib.BOMBA_PADRAO, tmp)
    with ss.conectar() as conn, conn.cursor() as cur:
        cur.execute('select public.gestao_cadastros_lista(), public.gestao_cartoes_lista(), public.gestao_bomba_extras()')
        cad, cart, bomba = cur.fetchone()
    difs = (diferencas('placas', plan['placas'], cad['placas'], 'placa')
            + diferencas('motoristas', plan['motoristas'], cad['motoristas'], 'usuario')
            + diferencas('cartoes', cartoes, cart['cartoes'], 'placa')
            + diferencas('bomba-precos', precos(neg), precos(bomba['negociacao']), 'chave')
            + diferencas('bomba-fornecedores', [{'chave': '|'.join(map(str, f[:3])), 'ativo': f[3], 'cnpj': f[4]} for f in forn or []],
                         [{'chave': '|'.join(map(str, f[:3])), 'ativo': f[3], 'cnpj': f[4]} for f in bomba['fornecedoresBomba'] or []], 'chave'))
    os.makedirs(PASTA, exist_ok=True)
    rel = os.path.join(PASTA, dt.datetime.now().strftime('%Y-%m-%d_%H%M') + '.json')
    with open(rel, 'w', encoding='utf-8') as f:
        json.dump({'diferencas': difs}, f, ensure_ascii=False, indent=1)
    return {'igual': not difs, 'placas': len(cad['placas']), 'motoristas': len(cad['motoristas']), 'cartoes': len(cart['cartoes']),
            'precosBomba': len(bomba['negociacao']['col']['preco']),
            'diferencas': len(difs), 'relatorio': os.path.relpath(rel, ss.PROJETO), 'exemplos': difs[:5]}


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(comparar(), ensure_ascii=False, default=str))
