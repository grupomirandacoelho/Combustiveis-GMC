"""Carga inicial das tabelas de apoio da lista de postos no banco (15.3 itens 4 e 5, 25/11/2026; pedido do usuário "Pode seguir
com as negociações e a localização dos postos"; migração supabase/migrations/20261125190000_gestao_postos_lista.sql):

    py scripts/postos_semente.py          recarrega public.municipios_sedes, public.postos_coordenadas e os limites das negociações

  - municipios_sedes: public/gestao/mapas/municipios.json (chave como importar_base.chave_cidade)
  - postos_coordenadas 'semente': public/postos.csv (lista antiga dos motoristas; o texto da coordenada fica como está no arquivo)
  - postos_coordenadas 'portal':  .dados/coordenadas-postos.json (digitadas no portal, que o vigia guardava fora da planilha)
  - parametros 'negociacoes_limites': R1:W1 da aba de negociações (como importar_base.ler_negociacoes)
Pode rodar de novo (substitui tudo). Saída: uma linha JSON.
"""
import csv
import json
import os
import shutil
import sys
import tempfile

import openpyxl

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importar_base as ib  # noqa: E402
import planilha_negociacao as pn  # noqa: E402
import supabase_sync as ss  # noqa: E402


def limites_da_planilha():
    tmp = tempfile.mkdtemp()
    try:
        c = os.path.join(tmp, 'neg.xlsx')
        shutil.copy2(pn.PLANILHA, c)
        wb = openpyxl.load_workbook(c, read_only=True, data_only=True)
        cab = [ib.texto(x) for x in next(wb[pn.ABA].iter_rows(min_row=1, max_row=1, values_only=True))]
        wb.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    limites = {'diasSemAtualizacao': 15, 'variacao': 0.1, 'diasRenegociacao': 90}
    rotulos = {'LIMITE DIAS SEM ATUALIZAÇÃO': 'diasSemAtualizacao', 'LIMITE VARIAÇÃO DE PREÇO': 'variacao',
               'LIMITE DIAS - RENEGOCIAÇÃO OBRIGATÓRIA': 'diasRenegociacao'}
    for i, c in enumerate(cab[:-1]):
        k = rotulos.get(c.upper())
        if k and isinstance(ib.num(cab[i + 1]), float):
            limites[k] = ib.num(cab[i + 1])
    return limites


def main():
    with open(ib.MUNICIPIOS, encoding='utf-8') as f:
        sedes = {}
        for nome, uf, lat, lng in json.load(f):
            sedes.setdefault((ib.chave_cidade(nome), uf), (lat, lng))
    semente = {}
    with open(pn.POSTOS_SEMENTE, encoding='utf-8-sig') as f:
        for p in csv.DictReader(f, delimiter=';'):
            if p.get('Latitude') and p.get('Longitude'):
                semente[pn.chave(p['Posto'])] = (p['Latitude'], p['Longitude'])
    try:
        with open(pn.COORDS_EXTRAS, encoding='utf-8') as f:
            portal = {k: (str(v[0]), str(v[1])) for k, v in json.load(f).items()}
    except FileNotFoundError:
        portal = {}
    limites = limites_da_planilha()
    with ss.conectar() as conn, conn.cursor() as cur:
        cur.execute('delete from public.municipios_sedes')
        cur.executemany('insert into public.municipios_sedes (chave, uf, lat, lng) values (%s, %s, %s, %s)',
                        [(k, uf, lat, lng) for (k, uf), (lat, lng) in sedes.items()])
        cur.execute('delete from public.postos_coordenadas')
        cur.executemany('insert into public.postos_coordenadas (chave, origem, lat, lon) values (%s, %s, %s, %s)',
                        [(k, 'semente', a, b) for k, (a, b) in semente.items()] + [(k, 'portal', a, b) for k, (a, b) in portal.items()])
        cur.execute("insert into public.parametros (nome, valor) values ('negociacoes_limites', %s::jsonb) "
                    "on conflict (nome) do update set valor = excluded.valor, atualizado_em = now()", (json.dumps(limites),))
        conn.commit()
    print(json.dumps({'sedes': len(sedes), 'semente': len(semente), 'portal': len(portal), 'limites': limites}, ensure_ascii=False))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
