"""Publica no portal os preços da ANP e da Petrobras gerados por scripts/anp_precos.py e scripts/petrobras_precos.py, nas mesmas
chaves do KV que o vigia gravava (anp, anp-versao, petrobras, petrobras-versao), pela rota /api/sync/kv com o token de sincronização.
15.3 (25/11/2026; decisão do usuário: ANP e Petrobras pelo GitHub Actions, .github/workflows/precos-anp-petrobras.yml).

    python scripts/publicar_precos.py <saida-anp.json> <saida-petrobras.json>

Cada argumento é a saída (última linha JSON) do script correspondente; só publica o que veio com "mudou": true.
Precisa das variáveis SITE_URL e SYNC_TOKEN (segredo; nunca é impresso). Saída: uma linha JSON no stdout.
"""
import datetime as dt
import json
import os
import sys
import urllib.request

PASTA_PROJETO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANP = os.path.join(PASTA_PROJETO, '.dados', 'anp', 'anp.json')
PETROBRAS = os.path.join(PASTA_PROJETO, '.dados', 'petrobras', 'petrobras.json')


def ultima_linha(caminho):
    try:
        with open(caminho, encoding='utf-8') as f:
            linhas = [l for l in f.read().splitlines() if l.strip()]
        return json.loads(linhas[-1]) if linhas else {}
    except (OSError, ValueError):
        return {}


def publicar(site, token, chave, valor):
    corpo = json.dumps({'chave': chave, 'valor': valor}, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(site.rstrip('/') + '/api/sync/kv', data=corpo, method='POST',
                                 headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.status


def main(saida_anp, saida_petrobras):
    site, token = os.environ.get('SITE_URL', ''), os.environ.get('SYNC_TOKEN', '')
    if not site or not token:
        return {'erro': 'faltam SITE_URL e SYNC_TOKEN'}
    agora = dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    feito = {}
    a = ultima_linha(saida_anp)
    if a.get('mudou') and os.path.isfile(ANP):
        with open(ANP, encoding='utf-8') as f:
            publicar(site, token, 'anp', json.load(f))
        publicar(site, token, 'anp-versao', {'versao': a.get('versao'), 'ultimaSemana': a.get('ultimaSemana'),
                                             'ultimoMes': a.get('ultimoMes'), 'enviadoEm': agora})
        feito['anp'] = {'ultimaSemana': a.get('ultimaSemana'), 'ultimoMes': a.get('ultimoMes')}
    p = ultima_linha(saida_petrobras)
    if p.get('mudou') and os.path.isfile(PETROBRAS):
        with open(PETROBRAS, encoding='utf-8') as f:
            publicar(site, token, 'petrobras', json.load(f))
        publicar(site, token, 'petrobras-versao', {'versao': p.get('versao'), 'titulo': p.get('titulo'),
                                                   'ultimaVigencia': p.get('ultimaVigencia'), 'enviadoEm': agora})
        feito['petrobras'] = {'titulo': p.get('titulo'), 'ultimaVigencia': p.get('ultimaVigencia')}
    return {'publicado': feito, 'anpErro': a.get('erro'), 'petrobrasErro': p.get('erro')}


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    print(json.dumps(main(sys.argv[1], sys.argv[2]), ensure_ascii=False))
