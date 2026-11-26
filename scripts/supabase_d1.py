"""Banco da Cloudflare (D1) -> Supabase (Postgres). Pedido do usuário em 12/11/2026: levar também os dados do banco da
Cloudflare, mantendo atualizado enquanto o site continua lá.

    py scripts/supabase_d1.py esquema            SQL das tabelas (lido da estrutura do D1 de produção)
    py scripts/supabase_d1.py sincronizar        recarrega no Supabase as tabelas do D1 que mudaram
    py scripts/supabase_d1.py sincronizar --tudo recarrega todas
    py scripts/supabase_d1.py conferir           linhas no D1 x linhas no Supabase

Regras:
  - mesmas tabelas, colunas e chaves primárias do D1 (o site poderá usar o Supabase do mesmo jeito);
  - fora: sessões e tentativas de login (temporárias, se apagam sozinhas) e d1_migrations (controle da Cloudflare);
  - fora: a coluna alteracoes_cadastros.pessoais (CPF/nascimento/CNH temporários do motorista novo; decisão de 12/11/2026:
    não guardar em lugar nenhum);
  - a leitura é um SELECT por tabela numa chamada só do wrangler (conta Cloudflare fixa, como no vigia);
  - cada tabela que mudou (hash das linhas) é recarregada inteira numa transação.
Saída de sincronizar/conferir: uma linha JSON.
"""
import hashlib
import json
import os
import subprocess
import sys

import supabase_sync as sb

PROJETO = sb.PROJETO
ESTADO = os.path.join(sb.LOCAL, 'supabase-d1-estado.json')
CONTA_CLOUDFLARE = 'b28f3cec780adbc994189a364453bf20'   # a mesma de scripts/sincronizar.mjs
# push_inscricoes: chaves dos aparelhos para as notificações no celular (26/11/2026), como as sessões
FORA = {'d1_migrations', 'sessoes', 'sessoes_motoristas', 'tentativas_login', 'push_inscricoes'}
# pessoais: CPF temporário (não guardar em lugar nenhum); consolidador_lotes.linhas: os abastecimentos do lote, que depois
# de aplicado já estão em base_transacoes (cópia; ajuste de 12/11/2026)
COLUNAS_FORA = {('alteracoes_cadastros', 'pessoais'), ('consolidador_lotes', 'linhas')}


def d1(sql):
    """Executa SQL de leitura no D1 de produção -> lista de resultados (um por comando)."""
    r = subprocess.run(f'npx --yes wrangler@4 d1 execute DB --remote --json --command "{sql}"', cwd=PROJETO, shell=True,
                       capture_output=True, text=True, encoding='utf-8', timeout=300,
                       env={**os.environ, 'CLOUDFLARE_ACCOUNT_ID': CONTA_CLOUDFLARE})
    i = r.stdout.find('[')
    if r.returncode != 0 or i < 0:
        raise RuntimeError('wrangler falhou: ' + (r.stderr or r.stdout).strip()[-300:])
    return [x['results'] for x in json.loads(r.stdout[i:])]


def estrutura():
    """-> {tabela: [(coluna, tipo_postgres, pk)]} na ordem do D1."""
    nomes = [t['name'] for t in d1("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
                                    "AND name NOT LIKE '_cf_%' ORDER BY name")[0] if t['name'] not in FORA]
    partes = ' '.join(f"SELECT '{n}' AS tabela, cid, name, type, pk FROM pragma_table_info('{n}');" for n in nomes)
    out = {n: [] for n in nomes}
    for c in sorted([c for r in d1(partes) for c in r], key=lambda c: (c['tabela'], c['cid'])):
        if (c['tabela'], c['name']) in COLUNAS_FORA:
            continue
        t = (c['type'] or '').upper()
        tipo = 'bigint' if 'INT' in t else 'double precision' if any(x in t for x in ('REAL', 'FLOA', 'DOUB')) else 'text'
        out[c['tabela']].append((c['name'], tipo, c['pk']))
    return out


def q(nome):
    return '"' + nome.replace('"', '""') + '"'


def esquema():
    partes = ['-- Espelho do banco da Cloudflare (D1) no Supabase (scripts/supabase_d1.py), 12/11/2026. Mesmas tabelas, colunas e',
              '-- chaves do D1; fora: sessões/tentativas de login, d1_migrations e alteracoes_cadastros.pessoais (dados pessoais).',
              '-- RLS ligado e sem política: só a chave secreta lê e grava.', '']
    for nome, cols in estrutura().items():
        defs = [f'  {q(c)} {t}' for c, t, _ in cols]
        pk = [c for c, _, p in sorted(cols, key=lambda x: x[2]) if p]
        if pk:
            defs.append('  primary key (' + ', '.join(q(c) for c in pk) + ')')
        partes.append(f'create table if not exists public.{q(nome)} (\n' + ',\n'.join(defs) + '\n);')
        partes.append(f'alter table public.{q(nome)} enable row level security;')
        partes.append(f"comment on table public.{q(nome)} is 'Espelho da tabela {nome} do banco da Cloudflare (D1)';")
        partes.append('')
    partes.append('''create table if not exists public.sincronizacao_cloudflare (
  tabela text primary key,
  linhas integer not null,
  hash text not null,
  sincronizado_em timestamptz not null default now()
);
alter table public.sincronizacao_cloudflare enable row level security;''')
    sys.stdout.write('\n'.join(partes) + '\n')


def converter(v, tipo):
    if v is None:
        return None
    if tipo == 'text':
        return v if isinstance(v, str) else json.dumps(v) if isinstance(v, (dict, list)) else str(v)
    if tipo == 'bigint':
        if isinstance(v, str):
            v = float(v)
        if not float(v).is_integer():
            raise ValueError(f'"{v}" não é inteiro')
        return int(v)
    return float(v)


def ler_tudo(tabelas):
    res = d1(' '.join(f'SELECT * FROM {n};' for n in tabelas))
    return dict(zip(tabelas, res))


def tipos_do_banco(cur, tabela):
    cur.execute("select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = %s", (tabela,))
    m = {'bigint': 'bigint', 'integer': 'bigint', 'double precision': 'double precision', 'real': 'double precision', 'numeric': 'double precision'}
    return {c: m.get(t, 'text') for c, t in cur.fetchall()}


def sincronizar(tudo=False):
    if not os.path.isfile(sb.CREDENCIAIS):
        return sb.saida({'pulado': 'sem credenciais do Supabase neste computador'})
    try:
        with open(ESTADO, encoding='utf-8') as f:
            estado = json.load(f)
    except (OSError, ValueError):
        estado = {}
    with sb.conectar() as conn:
        with conn.cursor() as cur:
            cur.execute("select table_name from information_schema.tables where table_schema = 'public'")
            no_banco = {r[0] for r in cur.fetchall()}
        todas = list(estrutura())
        tabelas = [t for t in todas if t in no_banco]
        dados = ler_tudo(tabelas)
        feitos, erros = [], []
        for nome in tabelas:
            linhas = dados[nome]
            h = hashlib.sha256(json.dumps(linhas, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            if not tudo and estado.get(nome) == h:
                continue
            try:
                with conn.cursor() as cur:
                    tipos = tipos_do_banco(cur, nome)
                    cols = [c for c in (linhas[0].keys() if linhas else []) if (nome, c) not in COLUNAS_FORA]
                    faltam = [c for c in cols if c not in tipos]
                    if faltam:
                        raise ValueError('colunas novas no D1, sem coluna no Supabase: ' + ', '.join(faltam) + ' (precisa de migração)')
                    cur.execute(f'delete from public.{q(nome)}')
                    if linhas:
                        with cur.copy(f'copy public.{q(nome)} ({", ".join(q(c) for c in cols)}) from stdin') as cp:
                            for r in linhas:
                                cp.write_row([converter(r.get(c), tipos[c]) for c in cols])
                    cur.execute('''insert into public.sincronizacao_cloudflare (tabela, linhas, hash, sincronizado_em) values (%s, %s, %s, now())
                                   on conflict (tabela) do update set linhas = excluded.linhas, hash = excluded.hash, sincronizado_em = now()''',
                                (nome, len(linhas), h))
                conn.commit()
                estado[nome] = h
                feitos.append({'tabela': nome, 'linhas': len(linhas)})
            except Exception as e:
                conn.rollback()
                erros.append({'tabela': nome, 'erro': str(e)[:300]})
    with open(ESTADO, 'w', encoding='utf-8') as f:
        json.dump(estado, f)
    erros += [{'tabela': t, 'erro': 'tabela nova no D1, sem tabela no Supabase (precisa de migração)'} for t in todas if t not in no_banco]
    sb.saida({'tabelas': feitos, 'erros': erros})


def conferir():
    tabelas = list(estrutura())
    contagem = d1('SELECT ' + ', '.join(f'(SELECT count(*) FROM {n}) AS {n}' for n in tabelas))[0][0]
    out = []
    with sb.conectar() as conn, conn.cursor() as cur:
        for n in tabelas:
            try:
                cur.execute(f'select count(*) from public.{q(n)}')
                b = cur.fetchone()[0]
            except Exception:
                conn.rollback()
                b = None
            out.append({'tabela': n, 'd1': contagem[n], 'supabase': b, 'igual': contagem[n] == b})
    sb.saida({'conferencia': out})


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'esquema':
        esquema()
    elif cmd == 'sincronizar':
        try:
            sincronizar(tudo='--tudo' in sys.argv[2:])
        except Exception as e:   # ex.: a Cloudflare recusou a leitura (acontece e passa na próxima): uma linha de erro, sem quebrar
            sb.saida({'tabelas': [], 'erros': [{'tabela': '(leitura do D1)', 'erro': str(e)[:300]}]})
    elif cmd == 'conferir':
        conferir()
    else:
        print(__doc__)
        sys.exit(1)
