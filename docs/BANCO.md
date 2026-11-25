# Banco de dados — modelo relacional `gestao`

> Criado em 16/11/2026, a pedido do usuário: reestruturar os bancos em tabelas de cadastros e de dados, que façam sentido,
> para tirar a dependência das planilhas no controle e na gestão dos combustíveis.

## 1. Como estava

| Onde | O quê | Problema |
|---|---|---|
| Planilhas (ownCloud) | Base/Base_copia (abastecimentos), Controle de motoristas e placas, Cartões frota, Negociações, Localização dos postos, Negociação bomba interna, Orçamento, ANP, Transações negadas | Cada uma escreve o mesmo dado de um jeito (unidade, combustível, posto); fórmulas copiadas viram coluna; a linha muda quando entra um lote; o site grava por fila + vigia |
| D1 (Cloudflare) | Acessos, filas de alteração para as planilhas, bomba interna, rateio, PRIME, notificações | Datas em texto, listas em JSON dentro de texto, ligação com os cadastros pelo nome |
| KV (Cloudflare) | JSON publicado para o site (abastecimentos, cadastros, cartões, ANP...) | Gerado das planilhas: sem planilha, sem site |
| Supabase `public` | Espelho 1 para 1 das planilhas e do D1 (12/11/2026) | Mesma forma das planilhas (`informacao_adicional_3` = unidade, colunas de fórmula, sem chaves entre tabelas) |

## 2. Como ficou

Schema **`gestao`** no Supabase (migração `supabase/migrations/20261116120000_gestao_modelo.sql`), carregado do espelho por
`scripts/gestao_carga.py` (uma transação só: quem consulta vê a carga anterior até a nova terminar). O espelho continua sendo
a porta de entrada enquanto as planilhas existirem; cada fase da troca está no `CHECKLIST.md` (seção 1.3).

### 2.1 Cadastros
| Tabela | Chave | O que é | Vem de |
|---|---|---|---|
| `empresas` | id | RAJA LOG, KEMIGAS | NOME REDUZIDO da Base |
| `unidades` | id, `nome` único | Unidade = centro de custo (RAJA JEQUIE), nome curto (Jequié), código Protheus (0203001), empresa, operacional | Base (INF. ADICIONAL 3), orçamento (BD_UND), cadastros |
| `unidade_apelidos` | apelido | Todos os jeitos de escrever a unidade → unidade | todas as planilhas |
| `combustiveis` | id, `nome` único | DIESEL S10, DIESEL S10 ADITIVADO, DIESEL COMUM, ARLA 32, GASOLINA, ETANOL, GNV + grupo | Base, negociações, bomba |
| `emissoras` | id | ticket, truckpag, veloe, vibra, bomba, manual | forma de pagamento |
| `veiculos` | id, `placa` única (validada) | Categoria, marca, modelo, ano, unidade, situação (ativo/desabilitado/vendido), meta, ponto crítico, tanque, autonomia; `cadastrado=false` = só apareceu nos abastecimentos | aba Carros + Base |
| `veiculo_placas_sistema` | veículo + sistema | Placa em cada sistema (Protheus, Base, Ticket, TruckPag, Veloe) | aba Placas MERCOSUL |
| `veiculo_metas` | veículo + mês | Meta de km/L por mês | Base > Metas x mes |
| `cartoes` | veículo + emissora | Situação do cartão (ativo, perdido, aguardando envio...) | CONTROLE CARTÕES FROTA |
| `motoristas` | id, `usuario` único (6 números) | Nome, matrícula, unidade, situação, códigos Ticket/TruckPag. **Sem CPF, nascimento, CNH nem senhas** | aba Motoristas + Base |
| `postos` | id, nome+cidade+UF únicos | Endereço, coordenadas, tipo (externo/interno/cais) | Base + Localização dos postos |
| `posto_codigos` | emissora + código | Código do estabelecimento em cada cartão → posto | Base |
| `rotas`, `rota_postos` | id / rota + posto | Rotas das unidades e postos autorizados (contato) | Negociações > ROTAS |
| `fornecedores`, `fornecedor_atendimentos` | id / fornecedor + combustível + praça | Fornecedores das bombas internas e onde atendem (CNPJ da filial) | Negociação bomba interna > Fornecedores |
| `bases`, `tanques`, `tanque_medicoes` | id / base + combustível / tanque + data | Bombas internas e cais, tanques (capacidade), medições da régua | D1 bomba_bases + compras da planilha (bases antigas, inativas, id ≥ 1001) |

### 2.2 Dados
| Tabela | Chave | O que é | Vem de |
|---|---|---|---|
| `abastecimentos` | id, `chave` única (placa\|data e hora\|combustível) | Todos os abastecimentos com veículo, motorista, unidade, empresa, posto, base, combustível, emissora (ids), litros, preço, valor, hodômetro, km, km/L; o resto do cartão em `info_adicional` (jsonb) | Base_copia |
| `abastecimento_correcoes` | id | Histórico do Editar abastecimentos | D1 alteracoes_base_copia |
| `compras_combustivel` | id | NFs e ajustes dos tanques (fornecedor, NF, emissão, litros, valor, vencimento); origem site ou planilha | D1 bomba_movimentacoes + Base > Bomba interna |
| `rateio_inicio`, `rateio_centro_custo`, `rateio_validacoes` | tanque / chave / compra | Rateio das NFs | D1 |
| `precos_negociados` | id | Negociações com os postos (data, unidade, posto, emissora, tipo mínimo/polo, valor, orientação) | Gestão de negociações |
| `precos_fornecedores` | id | Preço das bombas internas por fornecedor, combustível e praça | Negociação bomba interna |
| `anp_precos` | mês + UF + município + produto | Preço de revenda da ANP | Base > ANP |
| `contratos_anp` | id | Contratos de diesel do cliente (praça, UF, data base) | D1 |
| `orcamento` | unidade + natureza + mês | Orçamento da frota | Banco_Orçamento > Base_Metas |
| `transacoes_negadas` | id | Transações negadas (data e hora juntas, o resto em jsonb) | Base > Transações Negadas |
| `km_viradas`, `prime_*`, `usuarios`, `funcoes`, `usuario_bases`, `notificacoes`, `alertas_cartoes` | — | Portal (listas viram `text[]`, JSON vira `jsonb`, datas viram `timestamptz`) | D1 |
| `carga` | id | Cada carga: linhas por tabela, conferência e pendências | `gestao_carga.py` |

Regras gerais: datas em `date`/`timestamp` (nada de número serial do Excel nem texto), números em `numeric` (sem
arredondar o que veio da planilha), ligações por chave estrangeira, `check` nos domínios (situação, tipo, grupo), RLS ligado
em todas as tabelas (sem política: só a chave secreta acessa).

### 2.3 Comandos
| Comando | O que faz |
|---|---|
| `npm run banco:esquema` | Aplica as migrações `*gestao*` que faltam (e registra a versão) |
| `npm run banco:carga` | Recarrega o modelo a partir do espelho, confere os totais e grava as pendências em `gestao.carga` |
| `npm run banco:conferir` | Mostra a conferência e as pendências da última carga |

### 2.4 Primeira carga (16/11/2026)

Aplicada em produção. Conferência espelho x modelo **toda OK**: 62.824 abastecimentos (11.286.322,51 L e R$ 65.745.950,24
iguais), 290 placas e 165 motoristas do cadastro, 2.184 negociações, 2.948 preços das bombas, 11 compras do site e 692 da
planilha (3.304.039,94 L), orçamento R$ 129.526.758,87, 936 transações negadas, 4 notificações e 20 usuários.

| Cadastro | Linhas | | Dado | Linhas |
|---|---|---|---|---|
| unidades | 26 (+40 apelidos) | | abastecimentos | 62.824 |
| veículos | 347 (290 do cadastro + 57 só dos abastecimentos) | | compras/NFs | 703 (699 compras, 4 ajustes) |
| motoristas | 385 (165 do cadastro + 220 históricos) | | preços negociados | 2.184 |
| postos | 931 (+1.061 códigos de cartão) | | preços das bombas | 2.948 |
| combustíveis | 8 | | ANP | 96.463 |
| bases / tanques | 11 / 17 (5 ativas; 6 antigas inativas) | | orçamento | 2.364 |
| cartões | 539 situações | | metas por mês | 1.121 |

Origem dos abastecimentos: Ticket 47.203, TruckPag 7.191, manual 3.783, Veloe 2.004, bomba interna 2.002, Vibra (cais) 641.
Só 9 abastecimentos ficaram sem veículo (os que não têm placa) e 1 sem posto.

**Cuidado com o pooler do Supabase** (aprendido nesta carga): conexão que leu muito dado cai na consulta seguinte; COPY
grande demais num comando só derruba a conexão; quando o computador perde a conexão, a sessão fica "parada em transação"
no banco segurando as tabelas. Por isso a carga lê cada tabela numa conexão nova, grava em blocos de 5.000 linhas, usa
`idle_in_transaction_session_timeout` de 60 s e `lock_timeout` de 30 s, e tenta de novo até 3 vezes. O `supabase_sync.py`
(espelho) ganhou keepalive para não travar o vigia.

## 3. O que não está alinhado (16/11/2026)

Achados do levantamento do espelho e da carga. A carga não esconde nenhum: o que não casa fica com a ligação vazia
(ex.: `veiculo_id` nulo) e entra na lista de pendências da `gestao.carga`.

### 3.1 Segurança
1. **Senhas dos portais dos cartões na planilha de motoristas.** As 165 linhas da aba Motoristas têm senha da Ticket, da
   TruckPag e da Veloe, e o espelho `public.motoristas` copia essas colunas. O modelo novo não guarda senha nenhuma;
   o certo é tirar essas colunas da planilha e do espelho.

### 3.2 Cadastros
2. **Unidade escrita de 4 jeitos.** Base/cadastros usam o centro de custo (RAJA JEQUIE), o orçamento usa Jequié, as
   negociações usam JEQUIE (sem acento) e os contratos usam a praça (Betim, Olinda, GRANEL - BETIM). Resolvido no modelo pela
   tabela `unidade_apelidos`; nas planilhas continua.
3. **Placas fora do cadastro.** 63 "placas" dos abastecimentos não estão na aba Carros (57 placas válidas e 6 textos). Parte é veículo de verdade sem cadastro
   (SIE2E17 com 415 abastecimentos, RMJ4H10, SJE7D27...), parte é digitação (RPW7121 x RPW7I21, NYL6778 x NYI6778, TOE3E45 x
   TDE3E45) e parte nem é placa (VAZAMENTO, LAVAGEM, LIMPEZA NO TANQUE, PRIMEIRO ABASTECIMENTO DO TANQUE DE SP, FAZENDA, CARRO ALUGADO).
4. **SITUACAO das placas vazia.** 274 de 290 placas sem situação; "VENDA" aparece como unidade (21) e como categoria (16).
   No modelo: situação = ativo/desabilitado/vendido e a unidade fica vazia nos vendidos.
5. **Motoristas fora do cadastro.** 220 nomes dos abastecimentos não estão na aba Motoristas (ex-funcionários e nomes
   cortados em 35 letras pelos cartões). No modelo entram como `situacao = historico`, `cadastrado = false`.
6. **Placas diferentes entre os sistemas.** 3 placas (5 divergências) da aba Placas MERCOSUL com placa diferente entre Base, Ticket,
   TruckPag e Veloe (ex.: JQF6F82 na TruckPag, JQF6F81 na Base e JQF6582 na Ticket).
7. **Cartões sem número.** A planilha de cartões só tem a situação (ATIVO, PERDIDO...), não o número do cartão.

### 3.3 Postos
8. **886 nomes de posto para 772 códigos** nos abastecimentos, e 51 nomes com mais de um código ou cidade (POSTO CALIFORNIA
   em 4 cidades). No modelo o posto é nome + cidade + UF e cada código de cartão aponta para um posto.
9. **459 postos externos com abastecimento e sem coordenada** (sem linha na LOCALIZAÇÃO DOS POSTOS ou nome diferente), e
   **47 coordenadas gravadas sem vírgula** (ex.: POSTO SUAPE com latitude -8334332): a carga recoloca a vírgula e lista na pendência.
   Também: 36 nomes de posto em mais de uma cidade e 19 códigos de estabelecimento apontando para mais de um posto.
10. **27 postos negociados que não casam com nenhum posto dos abastecimentos** (nome diferente do que vem nos cartões).
11. A coluna COD POSTO da localização está desalinhada (já registrada no briefing).

### 3.4 Abastecimentos e combustíveis
12. **Combustível com 11 grafias** (DIESEL S-10 COMUM, DIESEL, Arla 32, arla 32, Etanol, ALCOOL COMUM...) → 8 combustíveis.
13. **5.785 abastecimentos sem forma de pagamento** (bomba interna e lançamentos manuais): no modelo a origem vem do tipo
    do estabelecimento (bomba/vibra/manual).
14. **18 abastecimentos sem centro de custo** e 97 com valor diferente de litros × preço (diferença > R$ 0,05; a maioria
    é preço do cais com mais casas do que o mostrado).
15. **Código da transação não é único** e a linha da Base_copia muda (já tratado no espelho com a `chave`).

### 3.5 Bomba interna
16. **Duas fontes de compras.** A planilha (Base > Bomba interna) vai de 08/2023 a 06/2026; o site (Movimentações) começa em
    10/2026 e só tem Jequié e os cais. **De jul a out/2026 não há compra registrada em lugar nenhum**, e as bombas de Belém,
    Salvador, São Paulo, GV (Raja e Kemigas) e Ilhéus não estão cadastradas como base no site (entram no modelo como bases
    inativas, id ≥ 1001).
17. Nomes das bombas com grafia diferente na planilha (Belem/Belém, "Ihéus"), **524 compras sem fornecedor** e 4 linhas que
    são ajuste (estoque inicial, vazamento -88 L; no modelo `tipo = ajuste`). A bomba de Raja Valadares não aparece em
    nenhum abastecimento como posto interno (só a da Kemigas, "KEMIGAS LTDA").
18. Fornecedores repetidos por praça e produto na aba Fornecedores (VIBRA 3 vezes, REDUX 3 vezes): no modelo, um fornecedor
    e os atendimentos dele.

### 3.6 Outros
19. **Transações negadas com data em dois formatos** ("01/09/2024" e "2024-09-01 00:00:00") e números em texto.
20. **ANP com colunas calculadas da nossa base** (despesa real, litros, tipo ticket) na mesma tabela da ANP: no modelo fica só
    o preço da ANP (o nosso gasto sai de `abastecimentos`).
21. **Negociações sem status** (coluna STATUS ATUALIZACAO vazia em todas) e "IDENTIFICAÇÃO" como plataforma (53 linhas).
22. **4 metas de placa sem veículo** (PKB9742, PPB6233, PVS3551, QXD7057: placas antigas de veículos que viraram Mercosul).
23. **Orçamento e contratos por praça/cidade**, não pela unidade (Maceió, Olinda, João Pessoa não são unidades).
24. **Filas do D1 (`alteracoes_*`) existem só para gravar nas planilhas**: quando o site gravar no banco, deixam de ser necessárias.

### 3.7 Decisões do usuário (17/11/2026) e o que foi feito

| Item | Decisão | Feito |
|---|---|---|
| 1. Senhas dos cartões na planilha de motoristas | Manter (o cartão físico é necessário para abastecer) | Continuam só na planilha e no espelho; o modelo `gestao` não guarda senha |
| 2. Unidade escrita de vários jeitos | Padronizar; RAJA SÃO PAULO = RAJA LOG GRANEL | Modelo: SÃO PAULO e RAJA SÃO PAULO viram RAJA LOG GRANEL; os 2 motoristas com RAJA SÃO PAULO passaram para RAJA LOG GRANEL na planilha (pela fila). As planilhas de negociações e orçamento seguem com o nome curto (o site depende dele) e o modelo traduz pelos apelidos |
| 3. Placas fora do cadastro | ADM entra no cadastro (sem meta/tanque, sem controle de autonomia); Kemigas não (vão ser vendidos); desperdício = VAZAMENTO, LAVAGEM, LIMPEZA NO TANQUE e PRIMEIRO ABASTECIMENTO DO TANQUE (FAZENDA e CARRO ALUGADO não) | 18 veículos do ADM cadastrados pela exportação da Ticket (PICAPE para Strada/Ranger/Hilux, CARRO para os demais; unidade RAJA ADM); `abastecimentos.tipo = 'desperdicio'` só para os 4 textos; PVH7C31 corrigido pelo usuário no cadastro (a grafia antiga PVH7231 continua na aba Metas da Base, na aba Placas MERCOSUL e na planilha de cartões) |
| 4. Motoristas fora do cadastro | Ver os dos últimos 10 dias (rotatividade maior); os do ADM não ficam no cadastro | Listas enviadas: fora do cadastro com abastecimento em 10 dias e cadastrados ATIVOS sem abastecimento em 10 dias; nome cortado no cadastro agora casa com o nome completo dos abastecimentos |
| 5. Situação das placas | Vazia = ATIVA; VENDA sai da unidade e da categoria e vira situação VENDIDO | 258 placas ATIVA e 21 VENDIDO (unidade e categoria vazias) gravadas na planilha pela fila; VENDIDO entrou no cadastro do site, nos cartões (fora do controle) e na lista de placas fora de uso |
| 6. Postos sem coordenada | Resolver; os sem abastecimento nos últimos 60 dias ficam de fora | As "sem vírgula" eram o formato da planilha (o site já converte), não erro. 187 postos ganharam coordenada pelo endereço dos abastecimentos (OpenStreetMap, até 30 km da sede da cidade), gravadas na LOCALIZAÇÃO pela fila do Mapa de calor; dos que sobraram, só 19 abasteceram nos últimos 60 dias (a pendência agora conta só esses) |
| 7. Compras das bombas sem registro (jul–out/2026) | Usar o histórico das planilhas de rateio, só das bases ativas (Jequié, cais, São Paulo, Salvador e Belém); RMG, Kemigás e Vipgás fora | `scripts/rateio_nfs.py` lê 13 planilhas de rateio: 590 NFs novas nas compras do modelo (origem `rateio`) |

### 3.8 Site lendo do banco (começo, 17/11/2026)

- **Cadastro de placas** lê do banco (`public.gestao_placas()`, pela API do Supabase com a chave secreta nos segredos do Pages
  `SUPABASE_URL`/`SUPABASE_KEY`) e cada alteração feita no site é gravada no banco na hora (`public.gestao_salvar_placa()`),
  além da fila para a planilha. Banco fora do ar: o site usa a lista publicada da planilha (`lib/supabase.js`).
- **Vigia** recarrega o modelo sozinho depois que o espelho muda (no máximo a cada 5 min, ~4 min por carga): log "Modelo do banco recarregado".
- Próximos: motoristas (as senhas continuam vindo da planilha), cartões, postos/negociações, bomba interna, abastecimentos.

### 3.9 Ajustes de 18/11/2026

- **Correção de placa:** `scripts/gestao_normalizar.py` `PLACAS_CORRIGIDAS` (hoje só PVH7231 → PVH7C31). Toda placa que passa pela carga é
  corrigida; o `importar_base.py` usa a mesma lista na aba Metas. Placa errada nova nas planilhas: acrescentar ali (e no teste).
- Placa VENDIDO não some mais dos filtros do site (só DESABILITADA).
- Postos sem coordenada ficam sem; o usuário cadastra pelo Mapa de calor.

## Esquema `cadastro` (origem dos cadastros, desde 18/11/2026)
O esquema `gestao` é refeito pela carga a cada 5 min a partir das planilhas; o `cadastro` é a ORIGEM, editado pelo portal (engrenagem
dos formulários) e nunca apagado pela carga. A carga lê daqui: `gestao.unidades` sai com o mesmo id de `cadastro.unidades`.

| Tabela | Chave | O que guarda |
|---|---|---|
| `unidades` | id | nome (centro de custo), nome curto, código do centro de custo, empresa (RAJA LOG/KEMIGAS), operacional, ativa |
| `unidade_apelidos` | apelido | outros jeitos de escrever a unidade e nomes antigos (renomear) -> unidade |
| `categorias_veiculo` | id | categorias do veículo (CAVALO, TRUCK...) |
| `marcas_veiculo` | id | marcas do veículo |
| `avisos_posto` | id | avisos que aparecem no posto para o motorista |
| `produtos_contrato` | id | produtos dos contratos x ANP |

Funções (só a chave secreta): `gestao_cadastro_listas()`, `gestao_cadastro_salvar(tipo, acao, id, dados)`,
`gestao_validar_placa(dados)`; `gestao.unidade_id(nome)` acha a unidade pelo nome ou apelido do cadastro (não cria mais).

## Dados dos painéis gerados no banco (desde 19/11/2026)
`public.dados_painel` (uma linha) guarda a parte dos abastecimentos do arquivo dos painéis, montada por
`gestao_gerar_dados_painel()` a partir de `base_transacoes` e `gestao.veiculos` com as mesmas regras do `scripts/importar_base.py`
(dicionários por ordem de aparição, KM impossível corrigido pelo hodômetro, cartão usado, endereços). O pg_cron (`gestao-dados-painel`)
roda a cada 2 minutos e chama `gestao_dados_painel_rodar()` (desde 25/11/2026): gatilhos por comando em `base_transacoes`,
`gestao.veiculos` e `gestao.unidades` somam `painel_mudancas.contador`; só quando ele andou (ou uma vez por dia) os geradores rodam, e
cada um só refaz quando a assinatura (md5) muda. Tabela nova lida por um gerador precisa do mesmo gatilho (teste
`tests/py/test_painel_gatilhos.py`). O portal lê por `gestao_dados_painel_versao()` e `gestao_dados_painel()`.


## Filas do portal aplicadas no banco (desde 19/11/2026, 15.2 passo 3)
As filas do D1 (`consolidador_lotes` = inserir, `alteracoes_base_copia` = corrigir/excluir) são aplicadas em `public.base_transacoes`
por `gestao_aplicar_lote(p_linhas jsonb)` (pula duplicado por placa + data ao segundo + hodômetro + combustível com todo diesel junto;
insere e renumera `linha` por data; refaz `chave`) e `gestao_aplicar_alteracao(p_acao, p_linha, p_placa, p_data, p_celulas, p_tanque)`
(acha a linha como o `planilha_base_copia.py`; placa nova completa G-J, motorista novo completa K; exclusão só com a mesma placa).
Execução só para `service_role`. Quem chama: `lib/aplicar-banco.js` (portal, ao gravar e na varredura `/api/sync/banco/aplicar`).
No D1, `banco_aplicado_em` (hora, 'anterior' ou 'aplicando:<hora>' enquanto reservado) e `banco_mensagem` mostram o resultado.
Desde 19/11/2026 10:47 `base_transacoes` não é mais recopiada da Base_copia: o banco é a origem (volta: `supabase_sync.py sincronizar
base_transacoes --voltar-planilha`). `scripts/comparar_base.py` compara os dois até 01/12/2026.

## Rotinas da nuvem (desde 19/11/2026, passo 4)
`public.nuvem_rotinas` (nome, modo desligado|simular|ligado, intervalo_min, estado jsonb, disparada_em, ultima_execucao,
ultimo_resultado, ultimo_erro) e `public.nuvem_execucoes` (rotina, em, modo, ok, resultado; 60 dias), com RLS e sem políticas (só
service_role). `gestao_nuvem_disparar()` (pg_cron `nuvem-rotinas` */5) chama as Edge Functions por pg_net com a chave do Vault.
Detalhes em `docs/MIGRACAO-PASSO4.md`.

## Área do motorista e tempo real (desde 19/11/2026, 15.2 passo 1b)
`gestao_gerar_dados_painel` também grava `public.dados_motoristas` (uma linha por motorista: `chave` = `gestao.chave(nome)`, `linhas`
json dos 13 meses). `gestao_painel_motorista(p_nome)` devolve as linhas e os veículos do cadastro; `gestao_chaves_tempo_real(p_desde)`
devolve as chaves placa|minuto|litros×100 para o vigia montar o tempo real sem repetir o banco. Execução só para `service_role`.

`public.nuvem_cache` (nome com prefixo da rotina, valor jsonb, em): estado das rotinas da nuvem que no vigia fica em arquivos
(`gestao_nuvem_cache_ler(prefixo)` devolve tudo de uma vez; `gestao_nuvem_cache_gravar`). `gestao_linhas_bomba(postos, desde)`: linhas
A..AN das bombas internas para a planilha de rateio de cada nota.
