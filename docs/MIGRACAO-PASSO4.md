# Migração 100% nuvem — passo 4: rotinas do vigia nas Edge Functions do Supabase (desde 19/11/2026)

Pedido do usuário: "O token já esta no arquivo pode adiantar o passo 4" (agendador escolhido em 19/11: Supabase Edge Functions).

## Como funciona
- Cada rotina é uma Edge Function em `supabase/functions/<nome>/index.ts`, montada com `rotina(nome, fn)` de
  `supabase/functions/_shared/nuvem.ts`: confere a chave (`x-chave-nuvem`), lê modo e estado em `public.nuvem_rotinas`, roda em
  segundo plano e registra cada execução em `public.nuvem_execucoes` (60 dias).
- **Modos** (`public.nuvem_rotinas.modo`): `desligado` (só o vigia), `simular` (a nuvem roda e anota o que faria; o vigia segue
  gravando), `ligado` (a nuvem grava e o vigia pula a dele — `nuvemLigada()` em `scripts/sincronizar.mjs`).
- **Agenda:** pg_cron `nuvem-rotinas` a cada 5 min chama `gestao_nuvem_disparar()`, que dispara (pg_net) cada rotina não
  desligada cujo `intervalo_min` passou. Chave e endereço no Vault (`chave_nuvem`, `url_projeto`).
- **Regras iguais às do vigia:** a lógica pura fica em `lib/nuvem/*.js` (e o motor em `public/gestao/lib/consolidador.js`); o vigia
  importa de lá e a nuvem usa cópias em `_shared` (`scripts/nuvem_publicar.mjs --copiar`; `tests/js/nuvem.test.mjs` confere).
- **Estado:** o que ficava em `.dados/*.json` vai para `nuvem_rotinas.estado`, herdado do arquivo do vigia antes de simular
  (sem isso a nuvem retrataria coisas que o vigia já tratou — visto nos estornos em 19/11).
- **Publicar:** `node scripts/nuvem_publicar.mjs [nome] [--segredos]` (segredos: CHAVE_NUVEM, SITE_URL, SYNC_TOKEN, TRUCKPAG_*,
  TICKET_*; lidos de `%LOCALAPPDATA%\GestaoCombustivel`, nunca impressos).
- **Região (23/11):** as funções rodam em São Paulo (`x-region: sa-east-1` no disparo): a TruckPag recusa chamadas de fora do
  Brasil (403). Ao chamar à mão, mandar o mesmo cabeçalho.
- **Custo medido (sonda, 19/11):** histórico do Consolidador do banco = 6,4 MB, 2 s para buscar, ~0,5 s de CPU para carregar
  (limite 2 s): cabe numa função.

## Para mudar o modo de uma rotina
```sql
update public.nuvem_rotinas set modo = 'ligado' where nome = 'estornos-truckpag';   -- ou 'simular' / 'desligado'
select rotina, em, modo, ok, resultado from public.nuvem_execucoes order by em desc limit 20;  -- o que cada execução fez
```

## Ordem das rotinas (uma por vez: simular, comparar com o vigia, ligar)
| # | Rotina (vigia) | Situação |
|---|---|---|
| 1 | Estornos TruckPag (`estornos_truckpag.mjs`, 6 h) | **simular desde 19/11** (estado herdado; 1ª execução igual ao vigia) |
| 2 | Recálculo do KM (`km_recalcular.mjs`) | passa a ser feito pelo banco ao aplicar o lote (o vigia anota ao gravar a planilha) |
| 3 | Tempo real + D-1 (`cartoes_api.mjs`) | **simular desde 19/11** (Edge Function `cartoes-api`, 5 min; regras em `lib/nuvem/cartoes.js`, estado em `nuvem_cache`; publica pelo `/api/sync/kv` quando ligada) |
| 4 | Rateio das NFs (`bomba_rateio.mjs`) | **simular desde 19/11**, junto com o 3 (`lib/nuvem/rateio-bomba.js`; linhas das bombas por `gestao_linhas_bomba`) |
| 5 | Conferência com os cartões (`conferencia_cartoes.mjs`) | depois do 3 |
| 6 | Conciliação de NFs (`conciliacao_nfs.mjs`) | independente (lê as APIs de títulos e NF-e) |
| 7 | Motoristas e placas nos cartões (`motoristas_cartoes.mjs`, `placas_truckpag.mjs`) | **gravam nas APIs dos cartões**: ligar só com aprovação do usuário; cadastros do banco no lugar de `planilha_cadastros.py` |
