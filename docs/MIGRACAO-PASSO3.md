# Migração 100% nuvem — etapa 15.2 passo 3: gravações direto no banco (19/11/2026)

Aprovado pelo usuário: "Pode começar pelo inventário, assim que estiver ok pode seguir para o passo 3".

## Inventário: quem grava na Base_copia (aba Transações)
Só duas "portas", aplicadas pelo vigia (`scripts/sincronizar.mjs`) com `scripts/planilha_base_copia.py`:

**A. Inserir linhas** — fila D1 `consolidador_lotes` (`id, criado_em, usuario_id, usuario_nome, resumo JSON, linhas JSON, chaves JSON,
estado pendente|aguardando|aplicada|erro, mensagem, aplicada_em, linha_inicial, linha_final`); `linhas` = `[fonte, 48 colunas A..AV]`
(`CORE.buildRow`, já com KM rodado R e km/L S). `planilha_base_copia.py gravar` (l. 111-249): pula a linha se já existe placa + data ao
segundo + hodômetro + combustível (todo diesel junto; Arla à parte, l. 86-104/198); insere em ordem de data (`intercalar` l. 256, renumera
a cauda fora de ordem); copia o estilo da última linha da mesma FORMA DE PAGAMENTO; não calcula cod_unid. Resultado:
`POST /api/sync/consolidador/resultado` (estado, mensagem, aplicada_em, linha_inicial, linha_final). Depois `km_recalcular.anotar()`.
Quem usa: Consolidador manual (`/api/consolidador/lotes`), lote D-1 das APIs (`cartoes_api.mjs:306` -> `/api/sync/cartoes-api/lote`,
preço já ajustado), Inclusão de abastecimento da bomba interna (`/api/bomba/abastecimentos`, lote com 1 linha 'MANUAL' + linha em
`bomba_abastecimentos.lote_id`), "Incluir" da Conferência com os cartões (`conferencia_cartoes.mjs:173` -> mesmo endpoint do D-1).

**B. Corrigir / excluir linhas** — fila D1 `alteracoes_base_copia` (`id, criado_em, usuario_id, usuario_nome, linha, placa, data (serial
do Excel), celulas JSON {coluna: valor}, antes JSON, estado, mensagem, aplicada_em, acao editar|excluir, tanque diesel|arla|null`).
`planilha_base_copia.py editar` (l. 505-691): acha a linha por placa + data ao segundo (prefere `linha` se ainda bate; placa já trocada
-> `linha` com a mesma data; senão a única linha com aquela data; com `tanque`, só linhas daquele combustível — `escolher_linha` l. 488).
Editar: grava as células; placa nova (F) completa G-J com a última linha da placa; motorista novo (L) completa K com a última do motorista.
Excluir: remove a linha. Resultado: `POST /api/sync/base-copia/resultado`.
Quem usa: Editar abastecimentos (correções E,F,L,O-T,AB,AD e exclusões; a tela já manda R/S recalculados da linha e da seguinte),
Bomba interna (editar/excluir a Inclusão), Rateio das NFs (`bomba_rateio.mjs:173` -> `/api/sync/bomba-rateio/precos`: P, T, AD, com
tanque), estornos TruckPag (`estornos_truckpag.mjs` -> `/api/sync/base-copia/automaticas`: exclusão + R/S da seguinte), recálculo do KM
(`km_recalcular.mjs:119`: R/S), Conferência com os cartões "Aplicar o do cartão" (`/api/base-copia`: Q/O/T + R/S).

Leitores da planilha: `base_copia_lista.py`, `consolidador_historico.py`, `planilha_base_copia.py`, `supabase_sync.py` (espelho
`base_transacoes`: apaga e recopia; chave = `UPPER(TRIM(placa))|data 'AAAA-MM-DDTHH:MM:SS'|UPPER(TRIM(combustível))`, repetida #2...;
guarda `linha`). `bomba_rateio`, `conferencia_cartoes`, `km_recalcular`, `estornos_truckpag` leem `.dados/cartoes-api/base-copia.json`
(gerado da planilha) e o `historico.json` — continuam no vigia até o passo 4 (Edge Functions).

## Plano da virada
1. Filas D1 iguais (nenhuma tela muda). Novas colunas `banco_aplicado_em` / `banco_mensagem` em `consolidador_lotes` e
   `alteracoes_base_copia` (o `estado` continua sendo o da planilha, que o vigia segue aplicando como cópia de segurança).
2. Funções no Supabase que repetem `planilha_base_copia.py`: `gestao_aplicar_lote(linhas)` (pula duplicado, insere, mantém ordem por
   data na coluna `linha`, refaz `chave`) e `gestao_aplicar_alteracao(...)` (acha por placa + data [+ tanque], edita colunas, completa
   G-J/K, exclui). O portal chama ao gravar na fila e, de tempos em tempos, reaplica o que ficou sem `banco_aplicado_em`.
3. Virada: `supabase_sync.py` deixa de recopiar `base_transacoes` da planilha (o banco vira a origem); antes, conferir banco x planilha.
4. Volta: religar a cópia da planilha (`base_transacoes` recomposta da Base_copia, que seguiu recebendo tudo).

## Andamento
- 19/11/2026, item 1 feito ("Pode seguir com o item 1"): as 6 rotas que gravam nas filas chamam `lib/aplicar-banco.js` depois de
  gravar; a varredura `POST /api/sync/banco/aplicar` (vigia, 1x/min, antes de gravar a planilha) reaplica o que ficou pendente.
  Pedidos anteriores marcados `banco_aplicado_em = 'anterior'`. Próximo: item 2 (conferir banco x planilha por alguns dias).
- 19/11/2026 10:47, virada antecipada ("Já pode desligar a recópia hoje e começar as comparações"): recópia desligada, filas vazias,
  comparação de partida 62.939 = 62.939. Comparação diária até 27/11 (adiantado de 01/12 em 25/11) (`scripts/comparar_base.py`).
