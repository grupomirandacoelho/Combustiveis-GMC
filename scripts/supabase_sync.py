"""Planilhas -> banco de dados no Supabase (Postgres). Pedido do usuário em 12/11/2026: ter os dados num banco de verdade,
atualizado sempre que as planilhas mudam, antes de deixar de usar as planilhas.

    py scripts/supabase_sync.py esquema            imprime o SQL das tabelas (tipos deduzidos dos dados de hoje)
    py scripts/supabase_sync.py sincronizar        recarrega as tabelas cuja planilha mudou desde a última vez
    py scripts/supabase_sync.py sincronizar --tudo recarrega todas
    py scripts/supabase_sync.py conferir           linhas de cada planilha x linhas de cada tabela
    py scripts/supabase_sync.py sincronizar base_transacoes --voltar-planilha
                                                   VOLTA da virada: refaz base_transacoes da Base_copia (desde 19/11/2026
                                                   o banco é a origem e a recópia automática fica desligada)

Regras:
  - as planilhas só são lidas (cópia temporária; a Base.xlsx continua intocada);
  - cada tabela é recarregada inteira numa transação (apaga e insere): o banco nunca fica pela metade, e se algum valor
    não couber no tipo da coluna, nada muda naquela tabela e o erro sai no log do vigia;
  - Base_copia vira a tabela base_transacoes (decisão do usuário: no banco não existe "cópia", a base é editada direto);
  - motoristas sem CPF, nascimento nem CNH (decisão de 12/11/2026; a planilha já não tem essas colunas);
  - credenciais em %LOCALAPPDATA%\\GestaoCombustivel\\supabase.json ({url, service_role, db}); nunca são impressas.
Saída de sincronizar/conferir: uma linha JSON no stdout.
"""
import datetime as dt
import json
import os
import re
import shutil
import sys
import tempfile
import unicodedata

import openpyxl

PROJETO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAIZ = os.path.dirname(PROJETO)   # pasta Dashboars Logística (Base.xlsx, LOCALIZAÇÃO DOS POSTOS.xlsx, ...)
LOCAL = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'GestaoCombustivel')
CREDENCIAIS = os.path.join(LOCAL, 'supabase.json')
ESTADO = os.path.join(LOCAL, 'supabase-estado.json')
CTRL = lambda n: os.path.join(PROJETO, 'CONTROLES', n)

# tabela -> de onde vem. colunas: quantas colunas do cabeçalho valem (as da direita costumam ser parâmetros/fórmulas soltas)
# abas: várias abas na mesma tabela, com uma coluna fixa (ex.: produto) para dizer de qual veio
# largo: aba com um mês por coluna (Metas x mes) -> uma linha por placa e mês
FONTES = {
    # ignorar: colunas de fórmula da planilha que no banco são cópia (ano/mês da data, placa+hodômetro, vazias);
    # renomear: "ano" é o ano do veículo; chave: identidade estável do abastecimento (ver chave_abastecimento)
    'base_transacoes': {'arquivo': CTRL('Base_copia.xlsx'), 'aba': 'Transações', 'ignorar': ['ano_2', 'mes', 'cod_unid', 'data_ref', 'def_posto'],
                        'renomear': {'ano': 'ano_veiculo'}, 'chave': True,
                        # 19/11/2026 (15.2 passo 3, virada): o banco é a origem; o portal grava direto nele (lib/aplicar-banco.js).
                        # A recópia da planilha fica desligada; só com "sincronizar base_transacoes --voltar-planilha" (volta).
                        'origem_banco': True},
    # 25/11/2026 (15.3 itens 1 e 2, virada; decisão do usuário: tudo pelo portal): o banco é a origem das placas, dos motoristas e
    # do controle dos cartões (lib/aplicar-cadastros.js). Volta: "sincronizar placas motoristas cartoes_placas --voltar-planilha".
    'placas': {'arquivo': CTRL('Controle_motoristas_e_placas.xlsx'), 'aba': 'Carros', 'origem_banco': True},
    'motoristas': {'arquivo': CTRL('Controle_motoristas_e_placas.xlsx'), 'aba': 'Motoristas', 'origem_banco': True},
    'cartoes_placas': {'arquivo': CTRL('CONTROLE CARTÕES FROTA.xlsx'), 'aba': 'CARTÕES', 'origem_banco': True},
    'placas_mercosul': {'arquivo': CTRL('CONTROLE CARTÕES FROTA.xlsx'), 'aba': 'Placas MERCOSUL'},
    # 25/11/2026 (15.3 item 3, virada da bomba interna): o banco é a origem dos preços e fornecedores (lib/aplicar-cadastros.js,
    # gestao_aplicar_bomba; Arla pelo pg_cron). Volta: "sincronizar bomba_precos bomba_fornecedores --voltar-planilha".
    'bomba_precos': {'arquivo': CTRL('Negociação bomba interna.xlsx'), 'aba': 'Plan1', 'origem_banco': True},
    'bomba_fornecedores': {'arquivo': CTRL('Negociação bomba interna.xlsx'), 'aba': 'Fornecedores', 'origem_banco': True},
    # 25/11/2026 (15.3 itens 4 e 5, virada; teste do usuário: rodada de 7 preços + 1 coordenada): o banco é a origem das negociações e
    # das coordenadas dos postos. Volta: "sincronizar negociacoes postos_localizacao --voltar-planilha". ROTAS segue recopiada.
    'postos_localizacao': {'arquivo': os.path.join(RAIZ, 'LOCALIZAÇÃO DOS POSTOS.xlsx'), 'aba': 'Localização dos postos', 'colunas': 11, 'origem_banco': True},
    'negociacoes': {'arquivo': os.path.join(RAIZ, 'Gestão de negociações de preço.xlsx'), 'aba': 'Base de dados de negociações', 'colunas': 17, 'origem_banco': True},
    'negociacoes_rotas': {'arquivo': os.path.join(RAIZ, 'Gestão de negociações de preço.xlsx'), 'aba': 'ROTAS'},
    # 25/11/2026 (15.3 item 6, virada): o orçamento é enviado pela tela Real x Orçado, um ano por vez (gestao_orcamento_importar);
    # o banco é a origem. Volta: "sincronizar orcamento_metas orcamento_unidades --voltar-planilha".
    'orcamento_metas': {'arquivo': os.path.join(RAIZ, 'Banco_Orçamento_Despesas_Frota.xlsx'), 'aba': 'Base_Metas', 'origem_banco': True},
    'orcamento_unidades': {'arquivo': os.path.join(RAIZ, 'Banco_Orçamento_Despesas_Frota.xlsx'), 'aba': 'BD_UND', 'origem_banco': True},
    # metas_mes, bomba_compras e transacoes_negadas: decisão do usuário em 25/11/2026, param de ser copiadas quando o vigia for
    # desligado (nenhuma tela lê; o Power BI lê a Base.xlsx direto); o que está no banco fica como histórico
    'metas_mes': {'arquivo': os.path.join(RAIZ, 'Base.xlsx'), 'aba': 'Metas x mes', 'largo': {'fixas': 2, 'coluna': 'mes', 'valor': 'meta'}},
    'bomba_compras': {'arquivo': os.path.join(RAIZ, 'Base.xlsx'), 'abas': [('Bomba interna', 'DIESEL'), ('Bomba Interna Arla', 'ARLA')], 'fixa': 'produto'},
    'transacoes_negadas': {'arquivo': os.path.join(RAIZ, 'Base.xlsx'), 'aba': 'Transações Negadas'},
    # 'anp_precos' saiu em 25/11/2026 (89 MB no plano de 500 MB e nada lia: o Preço x ANP usa o anp.json do gov.br, scripts/anp_precos.py)
}


def chave(s):
    return ' '.join(unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().upper().split())


def nome_coluna(titulo):
    s = chave(titulo).lower().replace('adidional', 'adicional').replace('%', ' pct ')
    s = re.sub(r'[^a-z0-9]+', '_', s).strip('_')
    if not s:
        s = 'coluna'
    if s[0].isdigit():
        s = 'c_' + s
    return s[:60]


def saida(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str) + '\n')


def aba(wb, nome):
    for ws in wb.worksheets:
        if chave(ws.title) == chave(nome):
            return ws
    raise ValueError(f'aba "{nome}" não encontrada')


def abrir(caminho):
    """Cópia temporária (a planilha pode estar aberta no Excel ou sendo gravada pelo vigia) -> (workbook, pasta temp)."""
    d = tempfile.mkdtemp(prefix='sb-')
    t = os.path.join(d, 'x.xlsx')
    shutil.copy2(caminho, t)
    return openpyxl.load_workbook(t, read_only=True, data_only=True), d


def limpar(v):
    if isinstance(v, str):
        v = v.strip()
        return v if v != '' else None
    return v


def ler_aba(ws, ncol=None):
    """-> (titulos, linhas [(numero_linha, [valores])]). Linhas vazias saem."""
    it = ws.iter_rows(values_only=True)
    cab = list(next(it, []) or [])
    if ncol is None:   # até o último título preenchido
        ncol = max([i + 1 for i, c in enumerate(cab) if c not in (None, '')] or [0])
    titulos = [cab[i] if i < len(cab) and cab[i] not in (None, '') else f'coluna {i + 1}' for i in range(ncol)]
    linhas = []
    for n, r in enumerate(it, start=2):
        vals = [limpar(r[i]) if i < len(r) else None for i in range(ncol)]
        if any(v is not None for v in vals):
            linhas.append((n, vals))
    return titulos, linhas


def ler_fonte(nome):
    """-> (colunas [nomes], linhas [(numero_linha, [valores])])."""
    f = FONTES[nome]
    wb, tmp = abrir(f['arquivo'])
    try:
        if 'abas' in f:
            colunas, todas = None, []
            for nome_aba, fixo in f['abas']:
                t, ls = ler_aba(aba(wb, nome_aba))
                cols = [nome_coluna(x) for x in t]
                if colunas is None:
                    colunas = cols
                todas += [(n, [vals[cols.index(c)] if c in cols else None for c in colunas] + [fixo]) for n, vals in ls]
            return unicos(colunas + [f['fixa']]), todas
        t, ls = ler_aba(aba(wb, f['aba']), f.get('colunas'))
        if 'largo' in f:
            lg = f['largo']
            fixas = [nome_coluna(x) for x in t[:lg['fixas']]]
            meses = t[lg['fixas']:]
            out = []
            for n, vals in ls:
                for m, v in zip(meses, vals[lg['fixas']:]):
                    if v is not None and isinstance(m, (dt.datetime, dt.date)):
                        out.append((n, vals[:lg['fixas']] + [m, v]))
            return unicos(fixas + [lg['coluna'], lg['valor']]), out
        cols = unicos([nome_coluna(x) for x in t])
        if nome == 'placas':
            calcular_placas(cols, ls)
        if f.get('ignorar'):
            manter = [i for i, c in enumerate(cols) if c not in f['ignorar']]
            cols = [cols[i] for i in manter]
            ls = [(n, [v[i] for i in manter]) for n, v in ls]
        cols = [f.get('renomear', {}).get(c, c) for c in cols]
        if f.get('chave'):
            cols, ls = cols + ['chave'], chave_abastecimento(cols, ls)
        return cols, ls
    finally:
        wb.close()
        shutil.rmtree(tmp, ignore_errors=True)


# colunas de fórmula sem valor salvo no arquivo (o openpyxl grava a fórmula sem o resultado): tipo fixo e conta feita aqui
TIPO_FIXO = {('placas', 'ponto_critico'): 'double precision', ('placas', 'auton_margem_de_seg'): 'double precision'}


def calcular_placas(cols, linhas):
    """Mesmas contas da aba Carros (e do portal): ponto crítico = meta - 0,5; autonomia = tanque x meta x 0,75."""
    im, ic, ip, ia = (cols.index(c) for c in ('meta', 'cap_tanque', 'ponto_critico', 'auton_margem_de_seg'))
    num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else numero_br(v)
    for _, v in linhas:
        meta, cap = num(v[im]), num(v[ic])
        v[ip] = round(meta - 0.5, 3) if meta and meta > 0 else None
        v[ia] = round(cap * meta * 0.75, 3) if meta and cap else None


def chave_abastecimento(cols, linhas):
    """Identidade estável do abastecimento (12/11/2026): placa|data e hora|combustível. Fica igual quando o portal corrige
    hodômetro ou litros. O código da transação não serve (11 mil sem código, 67 repetidos) e a linha muda quando um lote
    entra no meio da planilha. Hoje só 2 abastecimentos antigos repetem a combinação (RUI9F84 09/02/2024 e SIE2E12
    19/07/2025): o segundo ganha "#2" (na ordem da planilha), e assim por diante."""
    ip, idt, ic = (cols.index(c) for c in ('placa', 'data_transacao', 'tipo_combustivel'))
    vistos, out = {}, []
    for n, v in linhas:
        d = v[idt]
        k = '|'.join([str(v[ip] or '').strip().upper(), d.strftime('%Y-%m-%dT%H:%M:%S') if hasattr(d, 'strftime') else str(d or ''),
                      str(v[ic] or '').strip().upper()])
        vistos[k] = vistos.get(k, 0) + 1
        out.append((n, v + [k if vistos[k] == 1 else f'{k}#{vistos[k]}']))
    return out


def unicos(cols):
    vistos, out = {}, []
    for c in cols:
        if c in ('id', 'linha', 'sincronizado_em'):
            c = c + '_planilha'
        k = vistos.get(c, 0)
        vistos[c] = k + 1
        out.append(c if not k else f'{c}_{k + 1}')
    return out


INTEIROS = re.compile(r'^(codigo|cod_|id_|ano|mes$|matricula|numero_frota$|numero_cartao$|nf$|cliente$|estabelecimento$)')   # códigos e contagens: bigint (exato)


def numero_br(v):
    """Texto de número com vírgula decimal ("200,00", "1.234,5") -> float; senão None. Texto só de dígitos (usuário,
    senha, centro de custo com zero à esquerda) continua texto."""
    if isinstance(v, str) and re.fullmatch(r'-?\d{1,3}(\.\d{3})*,\d+|-?\d+,\d+', v.strip()):
        return float(v.strip().replace('.', '').replace(',', '.'))
    return None


def tipo_de(valores, nome=''):
    vs = [v for v in valores if v is not None]
    if not vs:
        return 'text'
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) or numero_br(v) is not None for v in vs):
        ns = [v if isinstance(v, (int, float)) else numero_br(v) for v in vs]
        if INTEIROS.match(nome) and all(float(v).is_integer() and abs(v) < 9e18 for v in ns):
            return 'bigint'
        return 'double precision'
    if all(isinstance(v, (dt.datetime, dt.date)) for v in vs):
        datas = all((isinstance(v, dt.date) and not isinstance(v, dt.datetime)) or (isinstance(v, dt.datetime) and v.time() == dt.time(0)) for v in vs)
        return 'date' if datas else 'timestamp'
    return 'text'


def converter(v, tipo):
    if v is None:
        return None
    if tipo == 'text':
        if isinstance(v, float) and v.is_integer():
            v = int(v)
        if isinstance(v, (dt.datetime, dt.date)):
            return v.isoformat(sep=' ') if isinstance(v, dt.datetime) else v.isoformat()
        return str(v)
    if tipo in ('date', 'timestamp'):
        if isinstance(v, dt.datetime):
            return v.date() if tipo == 'date' and v.time() == dt.time(0) else v
        if isinstance(v, dt.date):
            return v
        raise ValueError(f'"{v}" não é data')
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        t = str(v).strip().replace(' ', '')
        t = t.replace('.', '').replace(',', '.') if ',' in t else t
        try:
            v = float(t)
        except ValueError:
            raise ValueError(f'"{v}" não é número')
    if tipo == 'bigint':
        if not float(v).is_integer():
            raise ValueError(f'"{v}" não é número inteiro')
        return int(v)
    return float(v)


def esquema():
    partes = ['-- Tabelas espelho das planilhas (scripts/supabase_sync.py; tipos deduzidos dos dados de 12/11/2026).',
              '-- Acesso só pela chave secreta (vigia e, no futuro, o site): RLS ligado e nenhuma política para anon/authenticated.', '']
    for nome in FONTES:
        cols, linhas = ler_fonte(nome)
        tipos = [TIPO_FIXO.get((nome, c)) or tipo_de([vals[i] for _, vals in linhas], c) for i, c in enumerate(cols)]
        defs = ['  id bigint generated always as identity primary key', '  linha integer'] + [f'  {c} {t}' for c, t in zip(cols, tipos)]
        defs.append("  sincronizado_em timestamptz not null default now()")
        partes.append(f'create table if not exists public.{nome} (\n' + ',\n'.join(defs) + '\n);')
        partes.append(f'alter table public.{nome} enable row level security;')
        partes.append(f"comment on table public.{nome} is 'Espelho de {os.path.basename(FONTES[nome]['arquivo'])} > "
                      f"{FONTES[nome].get('aba') or ', '.join(a for a, _ in FONTES[nome]['abas'])} ({len(linhas)} linhas em 12/11/2026)';")
        partes.append('')
    partes.append('''-- controle da sincronização (o que foi carregado e quando)
create table if not exists public.sincronizacao_planilhas (
  tabela text primary key,
  arquivo text not null,
  linhas integer not null,
  modificado_em timestamptz,
  sincronizado_em timestamptz not null default now()
);
alter table public.sincronizacao_planilhas enable row level security;''')
    sys.stdout.write('\n'.join(partes) + '\n')


def conectar():
    import psycopg
    with open(CREDENCIAIS, encoding='utf-8-sig') as f:
        c = json.load(f)
    # keepalive: se a rede cair no meio, a conexão dá erro em vez de travar o processo do vigia para sempre (16/11/2026)
    return psycopg.connect(c['db'], connect_timeout=20, keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=5)


def ler_estado():
    try:
        with open(ESTADO, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def gravar_estado(e):
    with open(ESTADO, 'w', encoding='utf-8') as f:   # UTF-8 sem BOM
        json.dump(e, f)


def tipos_do_banco(cur, tabela):
    cur.execute("select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = %s", (tabela,))
    m = {'bigint': 'bigint', 'double precision': 'double precision', 'date': 'date', 'timestamp without time zone': 'timestamp',
         'text': 'text', 'integer': 'bigint', 'numeric': 'double precision', 'timestamp with time zone': 'timestamp'}
    return {c: m.get(t, 'text') for c, t in cur.fetchall()}


def carregar(conn, nome, mtime):
    cols, linhas = ler_fonte(nome)
    with conn.cursor() as cur:
        tipos = tipos_do_banco(cur, nome)
        if not tipos:
            raise ValueError(f'tabela {nome} ainda não existe no Supabase (migração pendente)')
        faltam = [c for c in cols if c not in tipos]
        if faltam:
            raise ValueError(f'colunas novas na planilha, sem coluna no banco: {", ".join(faltam)} (precisa de migração)')
        dados = []
        for n, vals in linhas:
            linha = [n]
            for c, v in zip(cols, vals):
                try:
                    linha.append(converter(v, tipos[c]))
                except ValueError as e:
                    raise ValueError(f'linha {n}, coluna {c}: {e}')
            dados.append(linha)
        cur.execute(f'delete from public.{nome}')
        with cur.copy(f'copy public.{nome} (linha, {", ".join(cols)}) from stdin') as cp:
            for linha in dados:
                cp.write_row(linha)
        cur.execute('''insert into public.sincronizacao_planilhas (tabela, arquivo, linhas, modificado_em, sincronizado_em)
                       values (%s, %s, %s, %s, now())
                       on conflict (tabela) do update set arquivo = excluded.arquivo, linhas = excluded.linhas,
                         modificado_em = excluded.modificado_em, sincronizado_em = now()''',
                    (nome, os.path.basename(FONTES[nome]['arquivo']), len(dados), dt.datetime.fromtimestamp(mtime, dt.timezone.utc)))
    conn.commit()
    return len(dados)


def sincronizar(tudo=False, so=None, voltar=False):
    if not os.path.isfile(CREDENCIAIS):
        return saida({'pulado': 'sem credenciais do Supabase neste computador'})
    estado = ler_estado()
    pendentes = []
    for nome, f in FONTES.items():
        if so and nome not in so:
            continue
        if f.get('origem_banco') and not voltar:
            continue   # banco é a origem (virada de 19/11/2026): nunca recopiar da planilha sem pedir
        if not os.path.isfile(f['arquivo']):
            continue
        st = os.stat(f['arquivo'])
        if not tudo and dt.datetime.now().timestamp() - st.st_mtime < 20:
            continue   # planilha sendo gravada agora (Excel, vigia, ownCloud): espera ela parar de mudar
        marca = {'mtime': st.st_mtime, 'tamanho': st.st_size}
        e = estado.get(nome) or {}
        if tudo or e.get('mtime') != marca['mtime'] or e.get('tamanho') != marca['tamanho']:
            pendentes.append((nome, marca))
    if not pendentes:
        return saida({'tabelas': []})
    feitos, erros = [], []
    with conectar() as conn:
        for nome, marca in pendentes:
            try:
                n = carregar(conn, nome, marca['mtime'])
                estado[nome] = {**marca, 'linhas': n, 'em': dt.datetime.now().isoformat(timespec='seconds')}
                gravar_estado(estado)
                feitos.append({'tabela': nome, 'linhas': n})
            except Exception as e:   # uma tabela com problema não impede as outras
                conn.rollback()
                erros.append({'tabela': nome, 'erro': str(e)[:300]})
    saida({'tabelas': feitos, 'erros': erros})


def conferir():
    out = []
    with conectar() as conn, conn.cursor() as cur:
        for nome in FONTES:
            _, linhas = ler_fonte(nome)
            try:
                cur.execute(f'select count(*) from public.{nome}')
                banco = cur.fetchone()[0]
            except Exception:
                conn.rollback()
                banco = None
            out.append({'tabela': nome, 'planilha': len(linhas), 'banco': banco, 'igual': banco == len(linhas)})
    saida({'conferencia': out})


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'esquema':
        esquema()
    elif cmd == 'sincronizar':
        args = sys.argv[2:]
        sincronizar(tudo='--tudo' in args or '--voltar-planilha' in args, so=[a for a in args if not a.startswith('--')] or None,
                    voltar='--voltar-planilha' in args)
    elif cmd == 'conferir':
        conferir()
    else:
        print(__doc__)
        sys.exit(1)
