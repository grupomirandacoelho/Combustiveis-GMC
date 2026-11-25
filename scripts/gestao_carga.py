"""Carga do modelo relacional (schema `gestao` no Supabase) a partir do espelho das planilhas e do D1 (schema `public`).

Uso:
  py scripts/gestao_carga.py esquema     aplica supabase/migrations/*gestao*.sql que faltam (numa transação, registrando a versão)
  py scripts/gestao_carga.py carregar    recarrega tudo numa transação só (quem lê vê a carga anterior até o fim)
  py scripts/gestao_carga.py conferir    totais do espelho x modelo e as pendências da última carga

As regras de tradução (unidade, combustível, placa, origem) ficam em scripts/gestao_normalizar.py (testadas).
Nunca grava senha: o espelho de motoristas tem senha dos cartões, que fica de fora. Documentação: docs/BANCO.md.
Credenciais: %LOCALAPPDATA%\\GestaoCombustivel\\supabase.json (nunca mostrar).
"""
import datetime as dt
import glob
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict

import psycopg
from psycopg.types.json import Jsonb

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gestao_normalizar as N  # noqa: E402
import rateio_nfs  # noqa: E402

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIGRACOES = os.path.join(RAIZ, 'supabase', 'migrations')
NAO_OPERACIONAL = re.compile(r'^(ADMINISTRATIVO|DIRETORIA|FAZENDA|RETIRADA |RAJA ADM|KEMIGAS DIRETORIA)')
CAIS = {'CAANA', 'CALAN', 'CABET', 'CAAPE'}
# bases da planilha de compras (Base.xlsx > Bomba interna) que não estão no D1: entram inativas (histórico)
BASES_HISTORICAS = {   # apelido na planilha -> (unidade, posto nos abastecimentos, nome da base)
    'BELEM': ('RAJA LOG BELEM', 'POSTO INT RAJA BELEM', 'BOMBA BELEM'),
    'ILHEUS': ('RAJA LOG ILHEUS', 'POSTO INTERNO VIP GAS ILHEUS', 'BOMBA ILHEUS'),
    'IHEUS': ('RAJA LOG ILHEUS', 'POSTO INTERNO VIP GAS ILHEUS', 'BOMBA ILHEUS'),
    'KEMIGAS GV': ('KEMIGAS GV', 'KEMIGAS LTDA', 'BOMBA KEMIGAS GV'),
    'RAJA VALADARES': ('RAJA GOVERNADOR VALADARES', None, 'BOMBA RAJA VALADARES'),
    'SALVADOR': ('RAJA SALVADOR', 'POSTO INT RAJA SALVADOR', 'BOMBA SALVADOR'),
    'SAO PAULO': ('RAJA LOG GRANEL', 'POSTO INT RAJA SAO PAULO', 'BOMBA SAO PAULO'),
}
TANQUE_D1 = {'diesel': 'DIESEL S10', 'arla': 'ARLA 32'}
BLOCO = 5000   # linhas por COPY
EMISSORAS = [('ticket', 'Ticket Log'), ('truckpag', 'TruckPag'), ('veloe', 'Veloe'), ('vibra', 'Vibra (cais)'),
             ('bomba', 'Bomba interna'), ('manual', 'Lançamento manual')]


def conectar():
    c = json.load(open(os.path.expandvars(r'%LOCALAPPDATA%\GestaoCombustivel\supabase.json'), encoding='utf-8'))
    return psycopg.connect(c['db'], connect_timeout=20, keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=5)


def log(msg):
    if os.environ.get('GESTAO_CARGA_TEMPO'):
        print(time.strftime('%H:%M:%S'), msg, flush=True)


def ler(cur, sql):
    """SELECT -> lista de dicts."""
    cur.execute(sql)
    cols = [d.name for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def js(texto, padrao=None):
    if texto is None or texto == '':
        return padrao
    if isinstance(texto, (dict, list)):
        return texto
    try:
        return json.loads(texto)
    except (ValueError, TypeError):
        return padrao


def num(v):
    """Número de célula/texto ('6,35', 'R$ 1.234,5', 7) -> float; vazio ou texto -> None."""
    if v is None or v == '':
        return None
    if isinstance(v, (int, float)):
        return v
    s = str(v).strip().replace('R$', '').replace(' ', '')
    if ',' in s:
        s = s.replace('.', '').replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return None


def serial_para_data(s):
    """Serial do Excel (dias desde 30/12/1899, hora local) -> datetime."""
    if s is None:
        return None
    return dt.datetime(1899, 12, 30) + dt.timedelta(days=float(s))


def data_texto(d, hora=None):
    """'01/09/2024' ou '2024-09-01 00:00:00' (+ hora '20:38:49') -> datetime."""
    if d is None:
        return None
    if isinstance(d, dt.datetime):
        base = d
    elif isinstance(d, dt.date):
        base = dt.datetime(d.year, d.month, d.day)
    else:
        s, base = str(d).strip(), None
        for f in ('%d/%m/%Y', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d', '%d/%m/%Y %H:%M:%S'):
            try:
                base = dt.datetime.strptime(s, f)
                break
            except ValueError:
                pass
        if base is None:
            return None
    if hora:
        try:
            base = dt.datetime.combine(base.date(), dt.datetime.strptime(str(hora).strip()[:8], '%H:%M:%S').time())
        except ValueError:
            pass
    return base


def mes_de(texto):
    """'2026-10' / date -> primeiro dia do mês."""
    if isinstance(texto, dt.date):
        return dt.date(texto.year, texto.month, 1)
    m = re.match(r'^(\d{4})-(\d{2})', str(texto or ''))
    return dt.date(int(m.group(1)), int(m.group(2)), 1) if m else None


def cnpj(v):
    d = re.sub(r'\D', '', str(v or ''))
    return d if len(d) == 14 else None


def coordenada(v, minimo, maximo):
    """Latitude/longitude do Brasil. A planilha tem algumas sem a vírgula (-8334332 = -8,334332): volta a vírgula até caber
    na faixa. Devolve (valor, corrigida) ou (None, True) se não couber."""
    v = num(v)
    if v is None:
        return None, False
    if minimo <= v <= maximo:
        return v, False
    x = v
    while abs(x) > max(abs(minimo), abs(maximo)) and abs(x) >= 1:
        x /= 10
        if minimo <= x <= maximo:
            return x, True
    return None, True


def para_copy(x):
    """Valor para o COPY: dict e lista com objetos viram jsonb; lista de textos/números vira array."""
    if isinstance(x, dict):
        return Jsonb(x)
    if isinstance(x, list) and not all(isinstance(i, (str, int)) for i in x):
        return Jsonb(x)
    return x


# ---------------------------------------------------------------------------------------------------------------------
class Carga:
    def __init__(self, cur, fonte=None):
        self.cur = cur                  # gravação (dentro da transação da carga)
        self.fonte = fonte or cur       # leitura do espelho (conexão própria, sem transação longa: o pooler derruba)
        self.linhas = {}
        self.pend = defaultdict(list)
        self.ultimo = time.time()

    def inserir(self, tabela, colunas, linhas):
        """COPY (rápido pelo pooler)."""
        t0 = time.time()
        for i in range(0, max(len(linhas), 1), BLOCO):   # blocos: um COPY grande demais derruba a conexão do pooler
            with self.cur.copy(f'COPY gestao.{tabela} ({", ".join(colunas)}) FROM STDIN') as cp:
                for r in linhas[i:i + BLOCO]:
                    cp.write_row([para_copy(x) for x in r])
        self.linhas[tabela] = self.linhas.get(tabela, 0) + len(linhas)
        log(f'{tabela}: {len(linhas)} linhas, copy {time.time() - t0:.1f} s, cálculo antes {t0 - self.ultimo:.1f} s')
        self.ultimo = time.time()

    def mapa(self, sql):
        self.cur.execute(sql)
        return {r[1]: r[0] for r in self.cur.fetchall()}

    # -----------------------------------------------------------------------------------------------------------------
    def ler_espelho(self):
        """Lê tudo do espelho ANTES de abrir a transação de gravação (transação longa com leitura grande cai no pooler)."""
        def P(sql):
            # uma conexão nova por consulta: depois de ler os abastecimentos (dezenas de MB) a mesma conexão do pooler
            # cai ou trava na consulta seguinte; conexão nova lê normal (testado em 16/11/2026)
            t0 = time.time()
            for tentativa in (1, 2, 3):
                try:
                    with conectar() as con:
                        con.autocommit = True
                        with con.cursor() as cur:
                            r = ler(cur, sql)
                    break
                except psycopg.OperationalError:
                    if tentativa == 3:
                        raise
                    log(f'conexão caiu lendo {sql[:40]}; tentando de novo')
            log(f'leu {len(r)} linhas em {time.time() - t0:.1f} s: {sql[:60]}')
            return r
        e = {
            'base': P('select * from public.base_transacoes'),
            'placas': P('select linha, placa, categoria, unidade, marca, modelo, ano, meta, ponto_critico, cap_tanque, auton_margem_de_seg, situacao from public.placas'),
            'motoristas': P('select motorista, unidade, usuario, situacao, matricula, codigo_ticket, id_truckpag from public.motoristas'),  # sem as senhas
            'orc_und': P('select unidade, inf_adicional, centro_de_custo from public.orcamento_unidades'),
            'orc': P('select unidade, natureza, data, valor from public.orcamento_metas'),
            'negoc': P('select * from public.negociacoes'),
            'rotas': P('select * from public.negociacoes_rotas'),
            'loc': P('select * from public.postos_localizacao'),
            'cart': P('select placa, ticket, truckpag, veloe from public.cartoes_placas'),
            'merc': P('select * from public.placas_mercosul'),
            'metas': P('select placa, unidade, mes, meta from public.metas_mes'),
            'bforn': P('select * from public.bomba_fornecedores'),
            'bprec': P('select * from public.bomba_precos'),
            'bcomp': P('select * from public.bomba_compras'),
            'negadas': P('select * from public.transacoes_negadas'),
            # ANP fora do modelo desde 25/11/2026: o site usa o anp.json baixado do gov.br (scripts/anp_precos.py), não estas tabelas
        }
        e['d1'] = {t: P(f'select * from public."{t}"') for t in (
            'bomba_bases', 'bomba_movimentacoes', 'bomba_rateio_inicio', 'bomba_rateio_cc', 'bomba_rateio_validacoes',
            'contratos_anp', 'km_viradas', 'prime_meses', 'prime_notas', 'prime_abastecimentos', 'funcoes', 'usuarios',
            'notificacoes', 'alertas_cartoes', 'alteracoes_base_copia')}
        e['rateio'] = rateio_nfs.ler_todas(log=log)   # NFs das planilhas de rateio (cópias; cache em .dados)
        self.esp = e
        return e

    def rodar(self):
        c = self.cur
        e = getattr(self, 'esp', None) or self.ler_espelho()
        base, placas, motoristas, orc_und, orc = e['base'], e['placas'], e['motoristas'], e['orc_und'], e['orc']
        negoc, rotas, loc, cart, merc, metas = e['negoc'], e['rotas'], e['loc'], e['cart'], e['merc'], e['metas']
        bforn, bprec, bcomp, negadas, d1 = e['bforn'], e['bprec'], e['bcomp'], e['negadas'], e['d1']
        self.ultimo = time.time()

        # ---------- empresas e unidades ----------
        self.inserir('empresas', ['nome'], [['RAJA LOG'], ['KEMIGAS']])
        emp = self.mapa('select id, nome from gestao.empresas')
        info_und, apel = {}, {}

        def ver(texto, origem):
            n = N.unidade(texto)
            if n:
                info_und.setdefault(n, {})
                apel.setdefault(N.chave(texto), (n, origem))
            return n
        for o in orc_und:
            n = ver(o['inf_adicional'], 'orçamento')
            info_und[n].update(curto=o['unidade'], cc=o['centro_de_custo'])
            apel[N.chave(o['unidade'])] = (n, 'orçamento')
        for lista, campo, origem in ((base, 'informacao_adicional_3', 'base'), (placas, 'unidade', 'placas'), (motoristas, 'unidade', 'motoristas'),
                                     (negoc, 'unidade', 'negociações'), (rotas, 'unidade', 'rotas'), (orc, 'unidade', 'orçamento'),
                                     (metas, 'unidade', 'metas')):
            for x in lista:
                ver(x[campo], origem)
        # cadastro.unidades é a ORIGEM desde 18/11/2026 (editado no portal; migração 20261118210000_gestao_cadastro_tabelas.sql):
        # as unidades do cadastro entram com o MESMO id e os dados do cadastro; nome das planilhas acha a unidade pelo nome ou pelo
        # apelido do cadastro (nome antigo de uma unidade renomeada continua valendo). Unidade que só existe nas planilhas e não está
        # no cadastro entra como antes (id novo), e fica na lista de pendências.
        c.execute('select id, nome, nome_curto, centro_custo, empresa, operacional, ativa from cadastro.unidades order by id')
        cad = c.fetchall()
        c.execute('select apelido, unidade_id from cadastro.unidade_apelidos')
        apel_cad = dict(c.fetchall())
        cad_por_chave = {N.chave(r[1]): r[0] for r in cad}
        id_cad = lambda n: cad_por_chave.get(N.chave(n)) or apel_cad.get(N.chave(n))  # noqa: E731
        for r in cad:
            i, nome, curto, cc, empresa, operacional, ativa = r
            dados = next((v for n, v in info_und.items() if id_cad(n) == i), {})
            c.execute('insert into gestao.unidades (id, nome, nome_curto, centro_custo, empresa_id, operacional, ativa) overriding system value '
                      'values (%s, %s, %s, %s, %s, %s, %s)', (i, nome, curto or dados.get('curto'), cc or dados.get('cc'),
                                                              emp.get(empresa, emp['RAJA LOG']), operacional, ativa))
        if cad:
            c.execute("select setval(pg_get_serial_sequence('gestao.unidades', 'id'), (select max(id) from gestao.unidades))")
        so_planilha = sorted((n, v) for n, v in info_und.items() if not id_cad(n))
        self.inserir('unidades', ['nome', 'nome_curto', 'centro_custo', 'empresa_id', 'operacional'],
                     [[n, v.get('curto'), v.get('cc'), emp[N.empresa_da_unidade(n)], not NAO_OPERACIONAL.match(n)] for n, v in so_planilha])
        self.unidades_fora_do_cadastro = [n for n, _ in so_planilha]
        und = self.mapa('select id, nome from gestao.unidades')
        for n in info_und:   # nome das planilhas -> id do cadastro
            if id_cad(n):
                und[n] = id_cad(n)
        apelidos = {a: i for a, i in apel_cad.items() if i in und.values()}
        origem_ap = {a: 'cadastro' for a in apelidos}
        for a, (n, o) in apel.items():
            if a not in apelidos and und.get(n):
                apelidos[a] = und[n]
                origem_ap[a] = o
        self.inserir('unidade_apelidos', ['apelido', 'unidade_id', 'origem'], [[a, i, origem_ap[a]] for a, i in sorted(apelidos.items())])
        U = lambda t: und.get(N.unidade(t))  # noqa: E731

        # ---------- combustíveis e emissoras ----------
        nomes_comb = dict(N.COMBUSTIVEIS)
        for t in {b['tipo_combustivel'] for b in base} | {x['tipo_combustivel'] for x in negoc} | {x['produto'] for x in bprec + bcomp}:
            n = N.combustivel(t)
            if n and n not in nomes_comb:
                nomes_comb[n] = 'outro'
        self.inserir('combustiveis', ['nome', 'grupo'], [[n, g] for n, g in nomes_comb.items()])
        comb = self.mapa('select id, nome from gestao.combustiveis')
        C = lambda t: comb.get(N.combustivel(t))  # noqa: E731
        self.inserir('emissoras', ['id', 'nome'], [list(e) for e in EMISSORAS])

        # ---------- veículos ----------
        apelido_placa = {}   # placa em outro sistema -> placa de referência (Protheus)
        for m in merc:
            ref = N.placa(m['placa_protheus_referencia'])[0]
            for col in ('placa_base', 'placa_ticketlog', 'placa_truckpag', 'placa_veloego'):
                pl, ok = N.placa(m[col])
                if ok and pl != ref:
                    apelido_placa[pl] = ref

        def placa_ref(texto):
            pl, ok = N.placa(texto)
            return apelido_placa.get(pl, pl), ok
        ultima = {}
        for b in sorted(base, key=lambda r: r['data_transacao']):
            pl, ok = placa_ref(b['placa'])
            if ok:
                ultima[pl] = b
        veic = {}
        for p in placas:
            pl, ok = N.placa(p['placa'])
            if not ok:
                self.pend['placas inválidas no cadastro'].append(p['placa'])
                continue
            u = ultima.get(pl) or {}
            veic[pl] = [pl, p['categoria'] if N.chave(p['categoria']) != 'VENDA' else None, p['marca'], p['modelo'], p['ano'],
                        U(p['unidade']), N.situacao_veiculo(p['situacao'], p['unidade'], p['categoria']), p['meta'], p['ponto_critico'],
                        p['cap_tanque'], p['auton_margem_de_seg'], u.get('familia_veiculo'), u.get('tipo_frota'), True, p['linha']]
        for b in base:
            pl, ok = placa_ref(b['placa'])
            if ok and pl not in veic:
                u = ultima[pl]
                veic[pl] = [pl, None, None, u.get('modelo_veiculo'), None, U(u['informacao_adicional_3']), 'ativo', None, None, None, None,
                            u.get('familia_veiculo'), u.get('tipo_frota'), False, None]
            elif not ok:
                self.pend['lançamentos sem placa'].append(b['placa'])
        self.inserir('veiculos', ['placa', 'categoria', 'marca', 'modelo', 'ano_fabricacao', 'unidade_id', 'situacao', 'meta_km_l',
                                  'ponto_critico_km_l', 'capacidade_tanque_l', 'autonomia_km', 'familia', 'tipo_frota', 'cadastrado', 'linha_planilha'],
                     list(veic.values()))
        vid = self.mapa('select id, placa from gestao.veiculos')
        V = lambda t: vid.get(placa_ref(t)[0])  # noqa: E731
        self.pend['placas só nos abastecimentos (sem cadastro)'] = sorted(p for p, v in veic.items() if not v[13])
        sist = {'placa_protheus_referencia': 'protheus', 'placa_base': 'base', 'placa_ticketlog': 'ticket',
                'placa_truckpag': 'truckpag', 'placa_veloego': 'veloe'}
        rows = {}
        for m in merc:
            v = V(m['placa_protheus_referencia'])
            if not v:
                self.pend['placas Mercosul sem veículo'].append(m['placa_protheus_referencia'])
                continue
            for col, s in sist.items():
                if m[col]:
                    rows[(v, s)] = [v, s, N.placa(m[col])[0]]
                    if N.placa(m[col])[0] != N.placa(m['placa_protheus_referencia'])[0]:
                        self.pend['placa diferente entre os sistemas'].append(f"{m['placa_protheus_referencia']} ({s}: {m[col]})")
        self.inserir('veiculo_placas_sistema', ['veiculo_id', 'sistema', 'placa'], list(rows.values()))
        rows = {}
        for m in metas:
            v = V(m['placa'])
            if v and m['mes'] and m['meta'] is not None:
                rows[(v, mes_de(m['mes']))] = [v, mes_de(m['mes']), m['meta'], U(m['unidade'])]
            elif not v:
                self.pend['metas de placa sem veículo'].append(m['placa'])
        self.inserir('veiculo_metas', ['veiculo_id', 'mes', 'meta_km_l', 'unidade_id'], list(rows.values()))
        rows = []
        for x in cart:
            v = V(x['placa'])
            if not v:
                self.pend['cartões de placa sem veículo'].append(x['placa'])
                continue
            for e in ('ticket', 'truckpag', 'veloe'):
                s = N.situacao_cartao(x[e])
                if s:
                    rows.append([v, e, s])
        self.inserir('cartoes', ['veiculo_id', 'emissora_id', 'situacao'], rows)

        # ---------- motoristas ----------
        mot_rows, por_nome = [], {}
        for m in motoristas:
            usuario = re.sub(r'\D', '', str(m['usuario'] or '')).zfill(6) if m['usuario'] else None
            mot_rows.append([m['motorista'].strip(), usuario, m['matricula'], U(m['unidade']),
                             'desligado' if N.chave(m['situacao']) == 'DESLIGADO' else 'ativo', m['codigo_ticket'], m['id_truckpag'], True])
            por_nome[N.chave(m['motorista'])] = m['motorista'].strip()

        def nome_cadastro(texto):
            k = N.chave(texto)
            if not k:
                return None
            if k in por_nome:
                return por_nome[k]
            if len(k) >= 30:   # as transações cortam o nome em 35 letras
                c2 = [v for kk, v in por_nome.items() if kk.startswith(k)]
                if len(c2) == 1:
                    return c2[0]
            # e o cadastro às vezes tem o nome cortado (MANOEL VALDINEI MACHADO DA SIL x ... DA SILVA)
            c2 = [v for kk, v in por_nome.items() if len(kk) >= 25 and k.startswith(kk)]
            return c2[0] if len(c2) == 1 else None
        historicos = {}
        for b in base:
            if b['nome_motorista'] and not nome_cadastro(b['nome_motorista']):
                historicos.setdefault(N.chave(b['nome_motorista']), b)
        for k, b in historicos.items():
            mot_rows.append([k, None, None, U(b['informacao_adicional_3']), 'historico', None, None, False])
        self.inserir('motoristas', ['nome', 'usuario', 'matricula', 'unidade_id', 'situacao', 'codigo_ticket', 'id_truckpag', 'cadastrado'], mot_rows)
        c.execute('select id, nome, cadastrado from gestao.motoristas')
        mid = {(N.chave(n), cad): i for i, n, cad in c.fetchall()}

        def M(texto):
            n = nome_cadastro(texto)
            return mid.get((N.chave(n), True)) if n else mid.get((N.chave(texto), False))
        self.pend['motoristas só nos abastecimentos (sem cadastro)'] = sorted(historicos)

        # ---------- postos ----------
        def k_posto(nome, cidade, uf_):
            u = N.chave(uf_)[:2] or None
            return (N.chave(nome), N.chave(cidade) or None, u)
        postos = {}
        for b in base:
            if b['nome_estabelecimento']:
                postos.setdefault(k_posto(b['nome_estabelecimento'], b['cidade'], b['uf']),
                                  {'end': b['endereco'], 'bairro': b['bairro'], 'tipo': N.tipo_posto(b['tipo_estabelecimento'], b['nome_estabelecimento'])})
        loc_por_nome = defaultdict(list)
        for x in loc:
            # a planilha guarda algumas coordenadas como inteiro sem a vírgula (-19883025 = -19,883025): é o formato dela
            # (o Mapa de calor grava assim), não erro. Pendência só para a que não dá para converter
            la, _ = coordenada(x['latitude'], -34, 6)        # faixa do Brasil
            lo, _ = coordenada(x['longitude'], -74, -28)
            if (la is None) != (x['latitude'] is None) or (lo is None) != (x['longitude'] is None):
                self.pend['coordenadas que não são do Brasil na LOCALIZAÇÃO DOS POSTOS'].append(
                    f"{x['nome_estabelecimento']} ({x['latitude']}, {x['longitude']})")
            x = dict(x, latitude=la, longitude=lo)
            loc_por_nome[N.chave(x['nome_estabelecimento'])].append(x)
        for k, p in postos.items():
            todos = loc_por_nome.get(k[0], [])
            cands = [x for x in todos if N.chave(x['cidade']) == (k[1] or '')] or (todos if len(todos) == 1 else [])
            if cands:
                p['lat'], p['lon'] = cands[0]['latitude'], cands[0]['longitude']
                p['end'] = p['end'] or cands[0]['endereco']
        nomes_com_abast = {k[0] for k in postos}
        for x in (y for lst in loc_por_nome.values() for y in lst):   # postos da localização que nunca abasteceram (ex.: só negociados)
            k = k_posto(x['nome_estabelecimento'], x['cidade'], x['uf'])
            if k[0] not in nomes_com_abast and k not in postos:
                postos[k] = {'end': x['endereco'], 'bairro': x['bairro'], 'lat': x['latitude'], 'lon': x['longitude'], 'tipo': 'externo'}
        self.inserir('postos', ['nome', 'cidade', 'uf', 'endereco', 'bairro', 'latitude', 'longitude', 'tipo'],
                     [[k[0], k[1], k[2], p.get('end'), p.get('bairro'), p.get('lat'), p.get('lon'), p['tipo']] for k, p in postos.items()])
        c.execute('select id, nome, cidade, uf from gestao.postos')
        pid, pid_nome = {}, defaultdict(list)
        for i, n, cid, u in c.fetchall():
            pid[(n, cid, u)] = i
            pid_nome[n].append((i, cid, u))
        # só os que abasteceram nos últimos 60 dias importam para as análises (usuário, 17/11/2026)
        ult_dt = max((b['data_transacao'] for b in base), default=None)
        recentes = {k_posto(b['nome_estabelecimento'], b['cidade'], b['uf']) for b in base
                    if b['nome_estabelecimento'] and ult_dt and (ult_dt - b['data_transacao']).days <= 60}
        self.pend['postos externos sem coordenada (abastecidos nos últimos 60 dias)'] = sorted(
            f'{k[0]} ({k[1]}/{k[2]})' for k, p in postos.items() if p.get('lat') is None and p['tipo'] == 'externo' and k in recentes)
        repetidos = [n for n, lst in pid_nome.items() if len({(x[1], x[2]) for x in lst}) > 1]
        self.pend['postos com o mesmo nome em cidades diferentes'] = sorted(repetidos)

        uso = Counter(k_posto(b['nome_estabelecimento'], b['cidade'], b['uf']) for b in base if b['nome_estabelecimento'])
        uso_id = Counter({pid[k]: n for k, n in uso.items() if k in pid})

        def posto_por_nome(nome, cidade=None, uf_=None, mais_usado=False):
            c2 = pid_nome.get(N.chave(nome), [])
            if mais_usado and c2:   # bases: o mesmo nome em mais de um cadastro de posto -> o que mais abastece
                return max(c2, key=lambda x: uso_id.get(x[0], 0))[0]
            if cidade:
                c3 = [x for x in c2 if x[1] == N.chave(cidade) and (not uf_ or x[2] == uf_)]
                if len(c3) == 1:
                    return c3[0][0]
            return c2[0][0] if len(c2) == 1 else None
        cod = defaultdict(Counter)
        for b in base:
            if b['codigo_estabelecimento'] and b['nome_estabelecimento']:
                e = N.emissora(b['forma_de_pagamento'], b['tipo_estabelecimento'])
                cod[(e, b['codigo_estabelecimento'])][pid[k_posto(b['nome_estabelecimento'], b['cidade'], b['uf'])]] += 1
        self.inserir('posto_codigos', ['emissora_id', 'codigo', 'posto_id'], [[e, cd, cnt.most_common(1)[0][0]] for (e, cd), cnt in cod.items()])
        self.pend['código de estabelecimento com mais de um posto'] = [f'{e} {cd}' for (e, cd), cnt in cod.items() if len(cnt) > 1]

        # ---------- rotas ----------
        rot = {}
        for x in rotas:
            if x['rota']:
                rot.setdefault((U(x['unidade']), N.chave(x['rota'])), None)
        self.inserir('rotas', ['unidade_id', 'nome'], [list(k) for k in rot])
        c.execute('select id, unidade_id, nome from gestao.rotas')
        rid = {(u, n): i for i, u, n in c.fetchall()}
        rows = {}
        for x in rotas:
            if not x['rota'] or not x['posto']:
                continue
            cid, uf_ = N.cidade_uf(x['cidade'])
            r = rid[(U(x['unidade']), N.chave(x['rota']))]
            rows[(r, N.chave(x['posto']))] = [r, N.chave(x['posto']), posto_por_nome(x['posto'], cid, uf_), cid, uf_, x['contato'], x['nome_contato']]
        self.inserir('rota_postos', ['rota_id', 'posto_nome', 'posto_id', 'cidade', 'uf', 'contato', 'nome_contato'], list(rows.values()))

        # ---------- fornecedores ----------
        def compra_real(x):
            return bool(x['data_compra']) and (num(x['quantidade']) or 0) > 0
        fnomes = sorted({N.chave(x['fornecedor']) for x in bforn + bprec if x['fornecedor']} |
                        {N.chave(x['fornecedor']) for x in bcomp if x['fornecedor'] and compra_real(x) and len(str(x['fornecedor'])) <= 40})
        self.inserir('fornecedores', ['nome'], [[n] for n in fnomes])
        fid = self.mapa('select id, nome from gestao.fornecedores')

        def F(texto):
            k = N.chave(texto)
            if k in fid:
                return fid[k]
            c2 = [i for n, i in fid.items() if k.startswith(n + ' ') or k.startswith(n + '.')]
            return c2[0] if len(c2) == 1 else None
        rows = {}
        for x in bforn:
            k = (fid[N.chave(x['fornecedor'])], C(x['produto']), N.chave(x['unidade']))
            rows[k] = list(k) + [N.sim_nao(x['ativo']) is not False, cnpj(x['cnpj'])]
        self.inserir('fornecedor_atendimentos', ['fornecedor_id', 'combustivel_id', 'praca', 'ativo', 'cnpj'], list(rows.values()))
        self.inserir('precos_fornecedores', ['data', 'fornecedor_id', 'combustivel_id', 'praca', 'preco', 'preco_fob'],
                     [[x['data'], fid[N.chave(x['fornecedor'])], C(x['produto']), N.chave(x['unidade']), num(x['preco']), num(x['preco_fob'])]
                      for x in bprec if x['data'] and x['fornecedor']])

        # ---------- bases, tanques e medições ----------
        brows, bases_posto, apel_base = [], {}, {}
        for b in d1['bomba_bases']:
            k = N.chave(b['posto'])
            apelidos = [N.chave(b['nome'])] + (['JEQUIE'] if 'JEQUIE' in k else [])
            brows.append([b['id'], b['nome'], posto_por_nome(b['posto'], mais_usado=True), U(b['nome']) if 'JEQUIE' in k else None,
                          'cais' if k in CAIS else 'interna', bool(b['ativo']), apelidos])
            bases_posto[k] = b['id']
            for a in apelidos:
                apel_base[a] = b['id']
        prox = 1001
        for x in bcomp:
            a = N.chave(x['bomba'])
            if not a or a in apel_base:
                continue
            u, posto, nome = BASES_HISTORICAS.get(a, (None, None, 'BOMBA ' + a))
            ja = [r for r in brows if r[1] == nome]
            if ja:
                ja[0][6].append(a)
                apel_base[a] = ja[0][0]
                continue
            outros = [k for k, v in BASES_HISTORICAS.items() if v[2] == nome and k != a]   # ILHEUS e "IHEUS" = a mesma base
            brows.append([prox, nome, posto_por_nome(posto, mais_usado=True) if posto else None, und.get(u), 'interna', False, [a] + outros])
            if posto:
                bases_posto[N.chave(posto)] = prox
            for k in [a] + outros:
                apel_base[k] = prox
            prox += 1
        self.pend['bases sem posto nos abastecimentos'] = [r[1] for r in brows if r[2] is None]
        self.inserir('bases', ['id', 'nome', 'posto_id', 'unidade_id', 'tipo', 'ativa', 'apelidos'], brows)
        tq = {}
        for b in d1['bomba_bases']:
            for t, cfg in (js(b['tanques'], {}) or {}).items():
                if cfg:
                    tq[(b['id'], comb[TANQUE_D1[t]])] = cfg
        for x in bcomp:
            bi = apel_base.get(N.chave(x['bomba']))
            if bi and C(x['produto']):
                tq.setdefault((bi, C(x['produto'])), {})
        rateio = (getattr(self, 'esp', None) or {}).get('rateio') or {}
        for arq, v in rateio.items():
            bi = apel_base.get(v['base'])
            if bi and v['notas']:
                tq.setdefault((bi, comb[v['combustivel']]), {})
            elif not bi:
                self.pend['planilha de rateio sem base no modelo'].append(arq)
        self.inserir('tanques', ['base_id', 'combustivel_id', 'capacidade_l'], [[b, cb, num(cfg.get('capacidade'))] for (b, cb), cfg in tq.items()])
        c.execute('select id, base_id, combustivel_id from gestao.tanques')
        tid = {(b, cb): i for i, b, cb in c.fetchall()}
        self.inserir('tanque_medicoes', ['tanque_id', 'medido_em', 'volume_l', 'preco_medio'],
                     [[tid[k], cfg['inicialEm'], num(cfg['inicial']), num(cfg.get('precoInicial'))] for k, cfg in tq.items()
                      if cfg.get('inicialEm') and cfg.get('inicial') is not None])
        T = lambda base_id, tanque: tid.get((base_id, comb[TANQUE_D1.get(tanque, 'DIESEL S10')]))  # noqa: E731

        # ---------- compras (NFs) ----------
        rows = []
        for x in d1['bomba_movimentacoes']:
            if x['excluida']:
                continue
            rows.append([T(x['base_id'], x['tanque']), 'compra', F(x['fornecedor']), x['fornecedor'], cnpj(x['cnpj']), x['nf'],
                         x['emissao'], x['quando'], None, x['litros'], x['valor'], x['obs'], 'site', x['id'], x['usuario_nome'], None])
        for x in bcomp:
            t = tid.get((apel_base.get(N.chave(x['bomba'])), C(x['produto'])))
            if not t:
                self.pend['compras da planilha sem tanque'].append(f"{x['bomba']} {x['produto']} {x['data_compra']}")
                continue
            ajuste = not compra_real(x)
            rows.append([t, 'ajuste' if ajuste else 'compra', F(x['fornecedor']), x['fornecedor'], None,
                         str(x['nf']) if x['nf'] is not None else None, x['data_compra'], x['data_compra'], x['vencimento_boleto'],
                         num(x['quantidade']) or 0, None, x['afericao_da_bomba'], 'planilha', x['id'], None, None])
            if not ajuste and not x['fornecedor']:
                self.pend['compras da planilha sem fornecedor'].append(f"{x['bomba']} {x['produto']} {x['data_compra']}")
        self.juntar_rateio(rows, rateio, apel_base, tid, comb, F)
        self.inserir('compras_combustivel', ['tanque_id', 'tipo', 'fornecedor_id', 'fornecedor_nome', 'cnpj', 'nf', 'emissao', 'recebido_em',
                                             'vencimento', 'litros', 'valor', 'observacao', 'origem', 'origem_id', 'usuario', 'arquivo'], rows)
        c.execute("select id, origem_id from gestao.compras_combustivel where origem = 'site'")
        compra_site = {o: i for i, o in c.fetchall()}
        self.inserir('rateio_inicio', ['tanque_id', 'desde', 'placa', 'ja_rateado_l', 'usuario', 'atualizado_em'],
                     [[T(x['base_id'], x['tanque']), x['quando'], x['placa'], x['ja_rateado'] or 0, x['usuario_nome'], x['atualizado_em']]
                      for x in d1['bomba_rateio_inicio'] if T(x['base_id'], x['tanque'])])
        self.inserir('rateio_centro_custo', ['chave', 'unidade_id', 'centro_custo', 'usuario', 'atualizado_em'],
                     [[x['chave'], U(x['cc']), x['cc'], x['usuario_nome'], x['atualizado_em']] for x in d1['bomba_rateio_cc']])
        self.inserir('rateio_validacoes', ['compra_id', 'usuario', 'validado_em', 'dados'],
                     [[compra_site[x['mov_id']], x['usuario_nome'], x['validado_em'], js(x['dados'], {})]
                      for x in d1['bomba_rateio_validacoes'] if x['mov_id'] in compra_site])

        # ---------- abastecimentos ----------
        extras = ('informacao_adicional_1', 'informacao_adicional_2', 'informacao_adicional_4', 'informacao_adicional_5', 'campanha',
                  'grupo_restricao', 'codigo_emissora', 'serie_pos', 'codigo_liberacao_restricao', 'modelo_veiculo', 'numero_frota',
                  'ano_veiculo', 'tipo_estabelecimento', 'familia_veiculo', 'tipo_frota')
        rows = []
        for b in base:
            pk = k_posto(b['nome_estabelecimento'], b['cidade'], b['uf']) if b['nome_estabelecimento'] else None
            nr = N.chave(b['nome_reduzido'])
            u = U(b['informacao_adicional_3'])
            if not u:
                self.pend['abastecimentos sem unidade (centro de custo)'].append(b['chave'])
            rows.append([
                b['chave'], N.emissora(b['forma_de_pagamento'], b['tipo_estabelecimento']), b['codigo_transacao'], b['data_transacao'],
                b['placa'] or '', V(b['placa']), b['nome_motorista'], M(b['nome_motorista']) if b['nome_motorista'] else None,
                b['matricula'], u, emp['KEMIGAS' if nr.startswith('KEMIGAS') else 'RAJA LOG'] if nr else None,
                b['codigo_cliente'], pid.get(pk) if pk else None, bases_posto.get(pk[0]) if pk else None, C(b['tipo_combustivel']),
                b['litros'], b['vl_litro'], b['valor_emissao'], b['hodometro_ou_horimetro'], b['km_rodados_ou_horas_trabalhadas'],
                b['km_litro_ou_litros_hora'], b['servico'], b['forma_transacao'], b['numero_cartao'], b['responsavel'],
                {k: b[k] for k in extras if b.get(k) not in (None, '')}, b['linha'],
                *N.tipo_lancamento(b['placa'])])
        self.inserir('abastecimentos', ['chave', 'emissora_id', 'codigo_transacao', 'data_hora', 'placa', 'veiculo_id', 'motorista_nome',
                                        'motorista_id', 'matricula', 'unidade_id', 'empresa_id', 'codigo_cliente', 'posto_id', 'base_id',
                                        'combustivel_id', 'litros', 'preco_litro', 'valor', 'hodometro', 'km_rodados', 'km_por_litro',
                                        'servico', 'forma_transacao', 'numero_cartao', 'responsavel', 'info_adicional', 'linha_planilha',
                                        'tipo', 'descricao'], rows)
        self.inserir('abastecimento_correcoes', ['id', 'placa', 'data_hora', 'acao', 'campos', 'antes', 'usuario', 'criado_em', 'estado', 'aplicada_em'],
                     [[x['id'], x['placa'], serial_para_data(x['data']), x['acao'], js(x['celulas'], {}), js(x['antes'], {}), x['usuario_nome'],
                       x['criado_em'], x['estado'], x['aplicada_em']] for x in d1['alteracoes_base_copia']])

        # ---------- preços negociados ----------
        rows = []
        for x in negoc:
            if not x['data_da_negociacao'] or not x['posto_negociado']:
                continue
            cid, uf_ = N.cidade_uf(x['cidade'])
            e = {'TICKETLOG': 'ticket', 'TRUCKPAG': 'truckpag', 'VELOE': 'veloe'}.get(N.chave(x['plataforma']))
            posto = posto_por_nome(x['posto_negociado'], cid, uf_)
            if not posto:
                self.pend['negociações de posto que não está nos postos'].append(f"{N.chave(x['posto_negociado'])} ({cid})")
            tipo = N.chave(x['tipo']).lower() or None
            rows.append([x['data_da_negociacao'], U(x['unidade']), N.chave(x['posto_negociado']), posto, cid, uf_,
                         C(x['tipo_combustivel']) or comb['DIESEL S10'], e, x['plataforma'], tipo if tipo in ('minimo', 'polo') else None,
                         x['valor_negociado'], x['aviso'], x['contato_da_negociacao'], N.sim_nao(x['novo_contato_feito']), x['observacao'],
                         x['data_da_ultima_transacao_usada_para_o_preco'], x['linha']])
        self.inserir('precos_negociados', ['data', 'unidade_id', 'posto_nome', 'posto_id', 'cidade', 'uf', 'combustivel_id', 'emissora_id',
                                           'plataforma', 'tipo', 'valor', 'orientacao', 'contato', 'novo_contato', 'observacao', 'transacao_ref',
                                           'linha_planilha'], rows)

        # ---------- contratos, orçamento, negadas ----------
        self.inserir('contratos_anp', ['id', 'praca', 'uf', 'unidade_id', 'data_contrato', 'produto', 'observacao', 'ativo'],
                     [[x['id'], x['unidade'], x['uf'], U(x['unidade']), x['data_contrato'] or None, x['produto'], x['observacao'], bool(x['ativo'])]
                      for x in d1['contratos_anp']])
        soma = defaultdict(float)
        for x in orc:
            u = U(x['unidade'])
            if u and x['data'] and x['valor'] is not None:
                soma[(u, re.sub(r'\s+', ' ', N.chave(x['natureza'])), mes_de(x['data']))] += x['valor']
            elif not u:
                self.pend['orçamento sem unidade'].append(x['unidade'])
        self.inserir('orcamento', ['unidade_id', 'natureza', 'mes', 'valor'], [list(k) + [v] for k, v in soma.items()])
        principais = {'data', 'hora', 'placa', 'motorista', 'codigo_transacao', 'nome', 'cidade', 'uf', 'combustivel_transacao',
                      'litros_final', 'motivo', 'classificacao', 'pagamento', 'negociacao', 'id', 'linha', 'sincronizado_em'}
        self.inserir('transacoes_negadas', ['data_hora', 'placa', 'veiculo_id', 'motorista', 'codigo_transacao', 'posto_nome', 'cidade', 'uf',
                                            'combustivel', 'litros', 'motivo', 'classificacao', 'pagamento', 'negociacao', 'dados'],
                     [[data_texto(x['data'], x['hora']), x['placa'], V(x['placa']), x['motorista'], x['codigo_transacao'], x['nome'], x['cidade'],
                       (x['uf'] or '')[:2] or None, x['combustivel_transacao'], num(x['litros_final']), x['motivo'], x['classificacao'],
                       x['pagamento'], N.sim_nao(x['negociacao']),
                       {k: (str(v) if isinstance(v, (dt.date, dt.datetime)) else v) for k, v in x.items() if k not in principais and v not in (None, '')}]
                      for x in negadas])
        self.inserir('km_viradas', ['placa', 'dia', 'usuario', 'criado_em'],
                     [[x['placa'], dt.date(1970, 1, 1) + dt.timedelta(days=int(x['dia'])), x['usuario_nome'], x['criado_em']] for x in d1['km_viradas']])

        # ---------- PRIME, acesso e portal ----------
        self.inserir('prime_meses', ['mes', 'situacao', 'parametros', 'resultado', 'fechado_por', 'fechado_em', 'atualizado_em'],
                     [[mes_de(x['mes']), x['situacao'], js(x['parametros'], {}), js(x['resultado'], {}), x['fechado_por'], x['fechado_em'],
                       x['atualizado_em']] for x in d1['prime_meses']])
        self.inserir('prime_notas', ['mes', 'motorista', 'motorista_id', 'nota', 'motivo', 'usuario', 'criado_em'],
                     [[mes_de(x['mes']), x['motorista'], M(x['motorista']), x['nota'], x['motivo'], x['usuario_nome'], x['criado_em']]
                      for x in d1['prime_notas']])
        self.inserir('prime_abastecimentos', ['chave', 'mes', 'entra', 'motivo', 'aviso', 'motorista', 'motorista_para', 'usuario', 'criado_em'],
                     [[x['chave'], mes_de(x['mes']), bool(x['entra']), x['motivo'], x['aviso'], x['motorista'], x['motorista_para'],
                       x['usuario_nome'], x['criado_em']] for x in d1['prime_abastecimentos']])
        self.inserir('funcoes', ['id', 'nome', 'descricao', 'permissoes'],
                     [[x['id'], x['nome'], x['descricao'], js(x['permissoes'], []) or []] for x in d1['funcoes']])
        self.inserir('usuarios', ['id', 'usuario', 'nome', 'papel', 'ativo', 'excluido', 'funcao_id', 'permissoes', 'trocar_senha', 'ultimo_acesso', 'criado_em'],
                     [[x['id'], x['usuario'], x['nome'], x['papel'], bool(x['ativo']), bool(x['excluido']), x['funcao_id'],
                       js(x['permissoes'], []) or [], bool(x['trocar_senha']), x['ultimo_acesso'], x['criado_em']] for x in d1['usuarios']])
        existentes = {r[0] for r in brows}
        self.inserir('usuario_bases', ['usuario_id', 'base_id'],
                     [[x['id'], b] for x in d1['usuarios'] for b in (js(x['bomba_bases'], []) or []) if b in existentes])
        self.inserir('notificacoes', ['id', 'nome', 'tipo', 'ativa', 'condicao', 'mensagem', 'nivel', 'destinatarios', 'repetir', 'criado_por',
                                      'criado_em', 'atualizado_em'],
                     [[x['id'], x['nome'], x['tipo'], bool(x['ativa']), js(x['condicao'], {}), x['mensagem'], x['nivel'],
                       js(x['destinatarios'], {}), x['repetir'], x['criado_por'], x['criado_em'], x['atualizado_em']] for x in d1['notificacoes']])
        self.inserir('alertas_cartoes', ['id', 'criado_em', 'placa', 'veiculo_id', 'emissoras', 'motorista', 'observacao', 'estado',
                                         'resolvido_em', 'resolvido_por', 'nota'],
                     [[x['id'], x['criado_em'], x['placa'], V(x['placa']), js(x['cartoes'], []) or [], x['motorista'], x['observacao'], x['estado'],
                       x['resolvido_em'], x['resolvido_por'], x['nota']] for x in d1['alertas_cartoes']])

    def juntar_rateio(self, rows, rateio, apel_base, tid, comb, F):
        """NFs das planilhas de rateio nas compras. A nota que já está (mesmo tanque e número) ganha o que faltava (valor, CNPJ,
        fornecedor, emissão); a que não está entra com origem 'rateio'. rows = linhas de compras_combustivel (listas)."""
        hoje = dt.date.today().isoformat()
        por_nota = {}
        for i, r in enumerate(rows):
            if r[5]:
                por_nota.setdefault((r[0], str(r[5]).lstrip('0')), i)
        novas = completadas = 0
        for arq, v in rateio.items():
            t = tid.get((apel_base.get(v['base']), comb.get(v['combustivel'])))
            if not t:
                continue
            for n in v['notas']:
                chave_nf = (t, str(n['nf']).lstrip('0'))
                data = n['emissao'] or (n['primeiro'] or '')[:10] or None
                if data and data > hoje:
                    self.pend['NF do rateio com data no futuro'].append(f"{arq} NF {n['nf']} {data}")
                i = por_nota.get(chave_nf)
                if i is not None:
                    r = rows[i]
                    antes = list(r)
                    r[2] = r[2] or F(n['fornecedor'])
                    r[3] = r[3] or n['fornecedor']
                    r[4] = r[4] or n['cnpj']
                    r[6] = r[6] or n['emissao']
                    r[10] = r[10] if r[10] is not None else n['valor']
                    completadas += r != antes
                    continue
                rows.append([t, 'compra', F(n['fornecedor']), n['fornecedor'], n['cnpj'], n['nf'], n['emissao'],
                             n['primeiro'] or n['emissao'], None, n['litros'], n['valor'],
                             None if n['fonte'] == 'stock' else 'NF lida das abas do rateio (sem a Base NF STOCK)', 'rateio', None, None, arq])
                por_nota[chave_nf] = len(rows) - 1
                novas += 1
        log(f'rateio: {novas} NF(s) novas nas compras, {completadas} completada(s)')
        self.rateio_resumo = {'novas': novas, 'completadas': completadas}



# ---------------------------------------------------------------------------------------------------------------------
CONFERIR = [
    ('abastecimentos (linhas, litros, valor)',
     'select count(*), round(sum(litros)::numeric, 2), round(sum(valor_emissao)::numeric, 2) from public.base_transacoes',
     'select count(*), round(sum(litros), 2), round(sum(valor), 2) from gestao.abastecimentos'),
    ('placas do cadastro', 'select count(*) from public.placas', 'select count(*) from gestao.veiculos where cadastrado'),
    ('motoristas do cadastro', 'select count(*) from public.motoristas', 'select count(*) from gestao.motoristas where cadastrado'),
    ('negociações', 'select count(*) from public.negociacoes where data_da_negociacao is not null and posto_negociado is not null',
     'select count(*) from gestao.precos_negociados'),
    ('preços bomba', 'select count(*) from public.bomba_precos where data is not null', 'select count(*) from gestao.precos_fornecedores'),
    ('compras do site (linhas, litros)', 'select count(*), round(sum(litros)::numeric, 2) from public.bomba_movimentacoes where excluida = 0',
     "select count(*), round(sum(litros), 2) from gestao.compras_combustivel where origem = 'site'"),
    ('compras da planilha (linhas, litros)', 'select count(*), round(sum(quantidade)::numeric, 2) from public.bomba_compras',
     "select count(*), round(sum(litros), 2) from gestao.compras_combustivel where origem = 'planilha'"),
    ('orçamento (R$)', 'select round(sum(valor)::numeric, 2) from public.orcamento_metas where data is not null',
     'select round(sum(valor), 2) from gestao.orcamento'),
    ('transações negadas', 'select count(*) from public.transacoes_negadas', 'select count(*) from gestao.transacoes_negadas'),
    ('notificações', 'select count(*) from public.notificacoes', 'select count(*) from gestao.notificacoes'),
    ('usuários', 'select count(*) from public.usuarios', 'select count(*) from gestao.usuarios'),
]


def iguais(x, y, tolerancia=0.05):
    """Totais do espelho x modelo: até 5 centavos de diferença (o espelho soma em double, o modelo em numeric exato)."""
    return len(x) == len(y) and all((p is None and q is None) or (p is not None and q is not None and abs(p - q) <= tolerancia)
                                    for p, q in zip(x, y))


def conferir(cur):
    out = {}
    for nome, a, b in CONFERIR:
        cur.execute(a)
        x = [float(v) if v is not None else None for v in cur.fetchone()]
        cur.execute(b)
        y = [float(v) if v is not None else None for v in cur.fetchone()]
        out[nome] = {'origem': x, 'modelo': y, 'ok': iguais(x, y)}
    return out


def esquema(con):
    with con.cursor() as cur:
        cur.execute('select version from supabase_migrations.schema_migrations')
        feitas = {r[0] for r in cur.fetchall()}
    for arq in sorted(glob.glob(os.path.join(MIGRACOES, '*gestao*.sql'))):
        versao = os.path.basename(arq).split('_')[0]
        if versao in feitas:
            print('já aplicada:', os.path.basename(arq))
            continue
        sql = open(arq, encoding='utf-8').read()
        with con.transaction():
            with con.cursor() as cur:
                cur.execute(sql)
                cur.execute('insert into supabase_migrations.schema_migrations (version, name, statements) values (%s, %s, %s)',
                            (versao, os.path.basename(arq)[len(versao) + 1:-4], [sql]))
        print('aplicada:', os.path.basename(arq))


PROTECAO = ("set local idle_in_transaction_session_timeout = '60s'",   # cliente caiu: o banco desfaz a sessão órfã sozinho
            "set local lock_timeout = '30s'")                          # tabela presa por outra sessão: erro em vez de esperar


def com_tentativas(passo, nome, vezes=3):
    """Roda passo(cur) numa transação nova; se a conexão cair, espera a sessão órfã ser desfeita e tenta de novo."""
    for tentativa in range(1, vezes + 1):
        try:
            with conectar() as con, con.transaction():
                with con.cursor() as cur:
                    for s in PROTECAO:
                        cur.execute(s)
                    return passo(cur)
        except (psycopg.OperationalError, psycopg.errors.LockNotAvailable) as e:
            if tentativa == vezes:
                raise
            log(f'{nome}: falhou ({str(e).splitlines()[0]}); tentativa {tentativa + 1} em 70 s')
            time.sleep(70)


def carregar():
    # 1) lê o espelho (cada consulta numa conexão nova, sem transação aberta)
    esp = Carga(None).ler_espelho()

    # 2) só então abre a conexão de gravação (parada durante a leitura, o pooler a fecharia) e grava numa transação só
    def principal(cur):
        cur.execute("select tablename from pg_tables where schemaname = 'gestao' and tablename not in ('carga', 'anp_precos')")
        tabelas = [r[0] for r in cur.fetchall()]
        cur.execute('truncate ' + ', '.join('gestao.' + t for t in tabelas) + ' restart identity cascade')
        cur.execute('insert into gestao.carga default values returning id')
        carga_id = cur.fetchone()[0]
        k = Carga(cur)
        k.esp = esp
        k.rodar()
        return k, carga_id
    k, carga_id = com_tentativas(principal, 'carga principal')

    # 3) conferência e registro da carga
    with conectar() as con, con.transaction():
        with con.cursor() as cur:
            conf = conferir(cur)
            pend = {n: {'qtd': len(set(v)), 'exemplos': sorted(set(map(str, v)))[:30]} for n, v in k.pend.items() if v}
            cur.execute('update gestao.carga set terminada_em = now(), linhas = %s, conferencia = %s, pendencias = %s where id = %s',
                        (Jsonb(k.linhas), Jsonb(conf), Jsonb(pend), carga_id))
    return k.linhas, conf, pend


def mostrar(linhas, conf, pend):
    if linhas:
        print('linhas:', ', '.join(f'{t} {n}' for t, n in sorted(linhas.items())))
    print('\nconferência (espelho x modelo):')
    for n, v in conf.items():
        print(f"  {'OK ' if v['ok'] else 'DIF'} {n}: {v['origem']} x {v['modelo']}")
    print('\npendências:')
    for n, v in (pend or {}).items():
        print(f"  {n}: {v['qtd']} (ex.: {', '.join(v['exemplos'][:6])})")


if __name__ == '__main__':
    acao = sys.argv[1] if len(sys.argv) > 1 else ''
    with conectar() as con:
        if acao == 'esquema':
            esquema(con)
        elif acao == 'carregar':
            con.close()
            if '--json' in sys.argv:   # o vigia lê só a última linha
                try:
                    linhas, conf, pend = carregar()
                    print(json.dumps({'ok': True, 'abastecimentos': linhas.get('abastecimentos', 0),
                                      'diferencas': sum(1 for v in conf.values() if not v['ok']), 'pendencias': len(pend)}))
                except Exception as e:   # noqa: BLE001 (o vigia registra e tenta de novo)
                    print(json.dumps({'ok': False, 'erro': str(e).splitlines()[0][:300] if str(e) else type(e).__name__}))
            else:
                mostrar(*carregar())
        elif acao == 'conferir':
            with con.cursor() as cur:
                cur.execute('select linhas, pendencias from gestao.carga where terminada_em is not null order by id desc limit 1')
                r = cur.fetchone()
                mostrar(r[0] if r else {}, conferir(cur), r[1] if r else {})
        else:
            print(__doc__)
            sys.exit(1)
