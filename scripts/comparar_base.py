"""Compara a planilha Base_copia (aba Transações) com o banco (public.base_transacoes), abastecimento por abastecimento.
Migração 15.2 passo 3, item 2 (19/11/2026, pedido do usuário: "Já pode desligar a recópia hoje e começar as comparações"):
desde a virada o banco vive só dos pedidos do portal e a planilha segue recebendo os mesmos pedidos pelo vigia; as duas
precisam continuar iguais até o fim do teste (27/11/2026; adiantado de 01/12).

    py scripts/comparar_base.py            compara tudo; resumo em JSON no stdout, relatório completo em .dados/comparacao-base/
    py scripts/comparar_base.py --desde 2026-11-01   só abastecimentos a partir da data

Só lê (a planilha por cópia temporária; o banco por SELECT). Identidade = chave do espelho (placa|data e hora|combustível).
Não compara a posição (coluna `linha`) nem as colunas que o banco não guarda (ano_2, mes, cod_unid, data_ref, def_posto).
"""
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import supabase_sync as ss  # noqa: E402

PASTA = os.path.join(ss.PROJETO, '.dados', 'comparacao-base')


def igual(a, b):
    # texto só com espaços = vazio (a planilha grava vazio onde o lote trazia ' ')
    a = None if isinstance(a, str) and not a.strip() else a
    b = None if isinstance(b, str) and not b.strip() else b
    if a is None or b is None:
        return (a in (None, '')) and (b in (None, ''))
    if isinstance(a, float) or isinstance(b, float):
        try:
            return abs(float(a) - float(b)) <= 1e-6 * max(1.0, abs(float(a)))
        except (TypeError, ValueError):
            return False
    if isinstance(a, str) or isinstance(b, str):
        return str(a).strip() == str(b).strip()
    return a == b


def _txt(v):
    return v.isoformat(sep=' ') if isinstance(v, (dt.datetime, dt.date)) else v


def comparar(desde=None):
    cols, linhas = ss.ler_fonte('base_transacoes')
    with ss.conectar() as conn, conn.cursor() as cur:
        tipos = ss.tipos_do_banco(cur, 'base_transacoes')
        cur.execute(f'select linha, {", ".join(cols)} from public.base_transacoes')
        banco = {r[-1]: (r[0], list(r[1:])) for r in cur.fetchall()}
    ic, idt, ip = cols.index('chave'), cols.index('data_transacao'), cols.index('placa')
    plan = {}
    for n, vals in linhas:
        conv = []
        for c, v in zip(cols, vals):
            try:
                conv.append(ss.converter(v, tipos.get(c, 'text')))
            except ValueError:
                conv.append(v)
        plan[conv[ic]] = (n, conv)

    def dentro(vals):
        d = vals[idt]
        return desde is None or (hasattr(d, 'date') and d.date() >= desde)

    def resumo(n, vals):
        d = vals[idt]
        return {'linha': n, 'placa': vals[ip], 'data': _txt(d), 'chave': vals[ic]}

    so_planilha = [resumo(*plan[k]) for k in plan if k not in banco and dentro(plan[k][1])]
    so_banco = [resumo(*banco[k]) for k in banco if k not in plan and dentro(banco[k][1])]
    diferentes = []
    for k, (n, pv) in plan.items():
        if k not in banco or not dentro(pv):
            continue
        bv = banco[k][1]
        cols_dif = [{'coluna': c, 'planilha': _txt(a), 'banco': _txt(b)} for c, a, b in zip(cols, pv, bv) if c != 'chave' and not igual(a, b)]
        if cols_dif:
            diferentes.append({**resumo(n, pv), 'linha_banco': banco[k][0], 'colunas': cols_dif})
    return {
        'em': dt.datetime.now().isoformat(timespec='seconds'), 'desde': desde.isoformat() if desde else None,
        'planilha': sum(1 for _, v in plan.values() if dentro(v)), 'banco': sum(1 for _, v in banco.values() if dentro(v)),
        'so_na_planilha': so_planilha, 'so_no_banco': so_banco, 'diferentes': diferentes,
        'igual': not (so_planilha or so_banco or diferentes),
    }


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    args = sys.argv[1:]
    desde = dt.date.fromisoformat(args[args.index('--desde') + 1]) if '--desde' in args else None
    r = comparar(desde)
    os.makedirs(PASTA, exist_ok=True)
    arq = os.path.join(PASTA, dt.datetime.now().strftime('%Y-%m-%d_%H%M') + '.json')
    with open(arq, 'w', encoding='utf-8') as f:
        json.dump(r, f, ensure_ascii=False, indent=1, default=str)
    print(json.dumps({'igual': r['igual'], 'planilha': r['planilha'], 'banco': r['banco'], 'so_na_planilha': len(r['so_na_planilha']),
                      'so_no_banco': len(r['so_no_banco']), 'diferentes': len(r['diferentes']), 'relatorio': os.path.relpath(arq, ss.PROJETO),
                      'exemplos': (r['so_na_planilha'] + r['so_no_banco'] + r['diferentes'])[:5]}, ensure_ascii=False, default=str))
