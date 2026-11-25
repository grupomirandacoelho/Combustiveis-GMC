# Migração 100% nuvem — 15.3: demais planilhas no banco (desde 25/11/2026)

Pedido do usuário: "Segue com a migração das planilhas". Decisões (25/11/2026):
- **Tudo pelo portal:** ninguém mais edita as planilhas de cadastro direto no Excel. O banco vira a origem; a planilha fica como
  cópia (o vigia segue gravando até 15.4) e depois só exportação.
- **Orçamento (Real x Orçado):** continua preenchido no Excel e é enviado pelo portal (upload); o portal importa para o banco.

## Como cada planilha muda (mesmo caminho dos abastecimentos em 15.2)
1. **Ler do banco** no mesmo formato que o vigia publica no KV, conferir igual e ligar por uma chave do KV (volta = apagar a chave).
2. **Aplicar a fila do portal no banco** na hora (como `lib/aplicar-banco.js`), com a varredura do pg_cron cobrindo falhas.
3. **Virada:** `supabase_sync.py` deixa de recopiar a tabela da planilha (`origem_banco`); a planilha continua recebendo a fila
   pelo vigia como reserva; comparação diária banco x planilha até 15.4.
4. Regras especiais do vigia para a nuvem (Edge Function ou SQL).

Cuidado: `gestao_carga.py` refaz o modelo `gestao` a partir das tabelas `public.*`; depois da virada a tabela `public.*` é a
origem (não pode voltar a ser recopiada da planilha), senão a carga desfaz o que o portal gravou.

## Inventário (25/11/2026)
| # | Planilha | Quem grava | Quem lê | No banco | Situação |
|---|---|---|---|---|---|
| 1 | Controle_motoristas_e_placas (Carros, Motoristas) | `/api/cadastros` → `alteracoes_cadastros` → `planilha_cadastros.py` | KV `cadastros`: login do motorista, cartões, PRIME, placas desabilitadas, tela de cadastros | `public.placas`/`motoristas`, `gestao.veiculos`/`motoristas`, `gestao_placas`, `gestao_motoristas_cartoes` | **1. lido do banco e fila aplicada no banco desde 25/11** (`lib/aplicar-cadastros.js`, `gestao_aplicar_cadastro`); falta a virada. (`gestao_cadastros_lista`, KV `cadastros-fonte` = `banco`; igual: 308/166, só autonomia 0 digitado à mão vira vazio) |
| 2 | CONTROLE CARTÕES FROTA (CARTÕES, Placas MERCOSUL) | `/api/cartoes` → `alteracoes_cartoes` → `planilha_cartoes.py` (+ placas seguem o cadastro) | KV `cartoes` | `public.cartoes_placas`, `placas_mercosul`, `gestao.cartoes` | a fazer |
| 3 | Negociação bomba interna (preços, fornecedores) | `/api/bomba-interna` → `alteracoes_bomba` → `planilha_bomba.py` (+ Arla repetido 1x/h) | extras `negociacao`/`fornecedoresBomba`, KV `fornecedores-bomba` | `public.bomba_precos`, `bomba_fornecedores`, `gestao.precos_fornecedores` | a fazer |
| 4 | Gestão de negociações de preço (postos, ROTAS) | `/api/postos` → `alteracoes_postos` → `planilha_negociacao.py` | KV `postos` (CSV do app dos motoristas, roteirizador), extras `negPostos` | `public.negociacoes`, `gestao.precos_negociados`, `rotas` | a fazer |
| 5 | LOCALIZAÇÃO DOS POSTOS | `/api/locais` → `alteracoes_locais` → `planilha_locais.py`; geocodificação (OpenStreetMap) | extras `locais`/`locaisSuspeitos`, CSV dos postos | `public.postos_localizacao`, `gestao.postos` | a fazer (junto com 4) |
| 6 | Banco_Orçamento_Despesas_Frota | só à mão | extras `orcamento` (Real x Orçado) | `public.orcamento_*`, `gestao.orcamento` | a fazer: upload no portal |
| 7 | ANP / Petrobras / Reajustes SGB | downloads do vigia | KV `anp`, `petrobras`, `reajustes` | nada | a fazer: Edge Functions agendadas |
| 8 | Abas da Base.xlsx (Metas x mês, compras da bomba, negadas, ANP) | sistema externo (só leitura) | só a carga do modelo | espelhos + `gestao` | decidir no fim (importação só leitura ou sai) |

Todos os itens de `abastecimentos-extras` (negociação e fornecedores da bomba, coordenadas, `negPostos`, orçamento) precisam vir do
banco antes de desligar `verificar()`/`importar_base.py` do vigia.
