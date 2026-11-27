# CHECKLIST

Toda demanda pedida para o portal, quebrada em seções. `[x]` = feito e conferido; `[ ]` = falta.
Cada demanda nova entra na seção dela (ou numa seção nova) no mesmo dia em que for pedida; quando terminar, é marcada
e vai para o `CHANGELOG.md`. Regra de toda alteração: rodar `npm run verificar` (lint + testes) e criar os testes do que mudou.

## 0. Regras permanentes

- [x] Responder em português.
- [x] Nunca editar a `Base.xlsx` nem o `.pbix` (só leitura); nunca mexer no site antigo dos motoristas.
- [x] Nunca mostrar tokens, senhas ou credenciais; nenhum CPF, nascimento ou CNH de motorista guardado.
- [x] Testes só locais (usuário de teste apagado depois) ou em cópia das planilhas.
- [x] Atualizar `briefing.md`, `LEIA-ME.md`, `CHANGELOG.md` e este checklist a cada alteração.
- [x] Enviar toda alteração para o GitHub (`combustiveisgmc/Combustiveis-GMC`), sem dados nem segredos.
- [x] Toda alteração: lint (`npm run lint`), testes novos e `npm test` (16/11/2026).

## 1. Banco de dados: sair das planilhas

### 1.1 Estrutura (16/11/2026)
- [x] Espelho das planilhas e do D1 no Supabase (`public`, 12/11/2026).
- [x] Modelo relacional `gestao`: cadastros (empresas, unidades + apelidos, veículos, placas por sistema, metas, cartões, motoristas,
      postos + códigos por emissora, rotas, fornecedores, bases, tanques, medições) e dados (abastecimentos, correções, compras/NFs,
      rateio, preços negociados, preços das bombas, ANP, contratos, orçamento, transações negadas, km viradas, PRIME, acessos,
      notificações, avisos de cartão).
- [x] Carga do espelho para o modelo (`scripts/gestao_carga.py`) numa transação, com conferência dos totais e lista de pendências.
- [x] Regras de normalização testadas (`scripts/gestao_normalizar.py`, `tests/py/test_gestao.py`).
- [x] Relatório do que não está alinhado (`docs/BANCO.md` > Desalinhamentos).
- [x] Vigia rodar a carga do modelo depois de cada sincronização do espelho (17/11/2026; de 5 em 5 minutos). **Parou com o vigia em 27/11/2026**:
      os painéis só usam `gestao.veiculos` e `gestao.unidades`, que o cadastro de placas atualiza direto (conferido 27/11: nenhuma placa nem
      unidade fora do modelo). As outras tabelas de `gestao` ficam com a carga de 27/11 (nenhuma tela lê).

### 1.2 Corrigir os dados desalinhados (ver docs/BANCO.md)
- [x] Senhas dos portais dos cartões: decisão do usuário (17/11) = manter na planilha (cartão físico é necessário); o modelo não guarda.
- [x] Unidades padronizadas no modelo (apelidos); RAJA SÃO PAULO = RAJA LOG GRANEL (modelo + 2 motoristas na planilha, 17/11).
- [x] Carros do ADM cadastrados (18, exportação da Ticket, 17/11); Kemigas não entram (vão ser vendidos).
- [x] Placa VENDIDO volta a aparecer nos filtros do site (18/11), para enxergar vendido abastecendo.
- [x] PVH7231 → PVH7C31 no banco e nos dados do site (18/11; Base.xlsx não alterada).
- [ ] Placas VENDIDO com abastecimento recente e cartão Ticket ativo (HIB6D61, HFD9063, OPF3G97...): usuário revisar.
- [ ] Motoristas: listas dos últimos 10 dias enviadas (17/11); usuário decidir cadastrar / desligar.
- [x] Coordenadas "sem vírgula" = formato da planilha (não erro); 187 postos localizados pelo endereço (17/11).
- [x] Postos sem coordenada: decisão do usuário (18/11) = ficam sem; ele cadastra pelo Mapa de calor quando precisar.
- [x] Situação das placas: 258 ATIVA e 21 VENDIDO (sem unidade/categoria), 17/11. Usuário vai revisar ativas x vendidas.
- [ ] Corrigir as placas divergentes entre Base, Ticket, TruckPag e Veloe (aba Placas MERCOSUL).
- [x] Lançamentos sem placa (VAZAMENTO, LAVAGEM...) = desperdício (`abastecimentos.tipo`), 17/11.
- [x] Compras das bombas pelas planilhas de rateio no modelo, só bases ativas: 590 NFs (17/11).
- [ ] Bases de Belém, Salvador, São Paulo, GV e Ilhéus no site (Bomba interna) para as compras aparecerem em Movimentações.

### 1.3 Trocar as fontes do site e do vigia (próximas fases)
- [x] Site ler os dashboards do banco em vez do JSON das planilhas: feito pela migração 15 (`public.base_transacoes` -> `dados_painel`, 19/11),
      não pelo modelo `gestao.abastecimentos`.
- [x] Cadastro de placas lido do banco e gravado nele na hora (a fila para a planilha continua), 17/11.
- [x] Motoristas, cartões e postos no banco (viradas de 25/11; a fila para a planilha sai com o vigia em 27/11).
- [x] Editar abastecimentos, Consolidador e lotes D-1 gravarem direto no banco: `public.base_transacoes` (15.2 passo 3; vigia desligado 27/11).
- [x] APIs dos cartões (Ticket/TruckPag) gravarem direto no banco: Edge Function `cartoes-api` (15.2 passo 4, 23/11).
- [x] Negociações de postos e preços das bombas gravarem direto no banco (15.3, viradas de 25/11).
- [ ] Bomba interna (bases, tanques, movimentações, rateio) no modelo.
- [x] Planilhas deixam de ser fonte (vigia desligado 27/11); a Base.xlsx sai pelo botão Exportar do Editar abastecimentos. As outras
      planilhas ficam paradas em 27/11 (exportação delas só se o usuário pedir).
- [ ] Site fora da Cloudflare (Lovable, domínio próprio), quando o banco estiver provado.

## 2. Qualidade
- [x] ESLint com regras de erro (`.eslintrc.json`), 0 erros.
- [x] Testes: rateio, estoque, notificações, cadastros/cartões/permissões (JS); normalização, conversões e migração (Python).
- [ ] Limpar os 4 avisos de variável sem uso (cadastros/[tipo].js, mapa-calor.js, programa-prime.js).
- [ ] Testes das APIs (functions/) com D1 local.

## 3. Bomba interna
- [x] Estoque por base e tanque, movimentações (NFs), rateio das NFs com início por tanque.
- [x] Cais da Vibra (CAANA, CALAN, CABET, CAAPE) como base; rateio do portal a partir das planilhas (16/11/2026).
- [x] NFs 1722159 e 1722862 do Cais Viana lançadas sem mudar o volume (16/11/2026).
- [x] Cartões do Estoque alinhados (16/11/2026).
- [ ] Lançar as próximas NFs de Betim, Suape e Uberlândia (faltam ~2 notas de Uberlândia desde 31/10).

- [x] Preço do Rateio das NFs só com a nota fechada, travado depois, sem contar API e Base em dobro e no combustível certo (17/11).

## 4. Notificações
- [x] Avisos no canto da tela (estoque baixo, comunicado, preço alto, falta cartão, base desatualizada).
- [x] Estoque baixo com várias bases (16/11/2026).

## 5. Cartões e APIs
- [x] Integração Ticket/TruckPag em tempo real e D-1; tardios do fim de semana.
- [x] Unidade da placa vira o centro de custo na TruckPag; 27 placas alinhadas (16/11/2026).
- [ ] 10 placas VENDA sem centro de custo VENDA na TruckPag (decidir).
- [ ] Ticket: edição de veículo pela API não documentada; Veloe sem API.

## 6. Programa PRIME
- [x] Fechamento, Resultado, km mínimo, deflatores e comparativo antes x depois (13/11/2026).
- [ ] Lista de outubro/2026 quando chegar.

## 7. Postos e preços
- [x] Rodada de preços sem as bombas internas e os cais (13/11/2026).
- [x] Preço postos externos: posto bloqueado não compara com o preço antigo (13/11/2026).
- [ ] 9 postos com coordenada suspeita (briefing > Pendências).

## 8. Cadastros e abastecimentos
- [x] Motoristas sem dados pessoais; área do motorista com usuário de 6 números.
- [x] Editar abastecimentos: valor, data e hora editáveis.
- [ ] Apagar o acesso do motorista de teste 111444 (oferecido, sem resposta).
- [ ] Aviso de senha inicial dos motoristas (opções oferecidas, sem resposta).

## 9. Mapas e dashboards
- [x] Mapa de calor como no BI (zoom automático, postos escolhidos sozinhos, colunas Data/Placa/Cartão).
- [ ] Placa desabilitada escondida no roteirizador (a lista vem da aba Metas).
- [ ] 41 fábricas de clientes com localização aproximada para conferir.

## 10. Ajustes de tela (18/11/2026)
- [x] Tirar os ícones "i" dos cartões do Início.
- [x] Três pontinhos do gráfico "Média km/L contra a meta" → ícone de abrir o painel responsável.
- [x] Sino de notificações ao lado da conta, só alertas críticos no canto da tela; configuração das notificações dentro do sino
      (tela saiu do grupo Operacional).
- [x] Varredura de textos sobrepostos/estourando (Operação por motorista > mais informações, Preço x ANP e demais telas, 1440 e 390 px).
- [x] Barra de rolagem maior que a página em Evolução placas.
- [x] Pontos de cada dia no gráfico de gasto diário do Início.
- [x] "Gerenciar acessos" fora do menu lateral (fica na Conta).
- [x] Engrenagem de configuração das opções dentro de cada cadastro (placas, motoristas, postos, contratos, fornecedores, cartões).

## 11. Identidade visual do Grupo Miranda Coelho (18/11/2026)
- [x] Cores da marca nas variáveis de tema (laranja F6A42B confirmado pelo usuário, preto 4B4B4D, cinza 97989A), escuro e claro.
- [x] Logo com o nome no lugar da antiga (gestão, motoristas, Minha média, Trocar senha), negativa no tema escuro.
- [x] Logo sem o nome como ícone do aplicativo e do site (e no menu recolhido).
- [ ] Conferir com a área responsável se o laranja certo é mesmo o F6A42B (o código enviado foi F6542B).
- [x] Logos trocadas pela variante monocromática (branca no escuro, preta no claro; ícone com símbolo branco em fundo escuro).

## 12. Celular (18/11/2026)
- [x] Conta ao lado das notificações no canto superior direito; painel da conta inteiro na tela.
- [x] Notificações saem arrastando para o lado, como o menu (painel do sino em gaveta e avisos do canto).

## 13. Densidade dos painéis (18/11/2026)
- [x] Cartões, vãos, ícones dos indicadores, medidor e gráficos mais compactos (tokens `--vao`, `--recheio`, `--reg-icone`).
- [x] Principal de cada painel acima da dobra em 1440×900 (conferido nas 29 telas do menu, sem rolagem lateral nem erro).
- [x] Grupos de filtro lado a lado em tela larga.
- [x] Divisão por cartão: % no gráfico Dia a dia (18/11/2026).

## 14. Notificações por tela (18/11/2026)
- [x] Quem só tem a Consulta de KM não recebe mais o preço alto (padrão do tipo = painéis de preço).
- [x] "Para quem" com "Quem tem acesso a estas telas" e a contagem de quem recebe agora.
- [ ] Usuário ajustar as telas do aviso "Preço alto no posto" (hoje 4 logins; a equipe das bases deixou de receber).

## 15. Migração 100% nuvem (decidida em 18/11/2026)
Decisões do usuário: banco principal = **Supabase** (D1 só para login, sessões, filas e configurações); a Base.xlsx continua
alimentando o BI e outras planilhas, atualizada **à mão** pelo botão Exportar do Editar abastecimentos; o Consolidador grava no banco.
O vigia só é desligado no fim, com cada tarefa abaixo já rodando na nuvem e conferida.

### 15.1 Exportação e cadastros (primeira etapa)
- [x] Botão **Exportar** no Editar abastecimentos: planilha igual à Base_copia (48 colunas A..AV, Arial 8, cabeçalho em negrito,
      filtro automático, formato de cada coluna), só com os abastecimentos dos filtros da tela; fonte `public.base_transacoes` (18/11).
      19/11: cores das linhas por cartão (TRUCKPAG, VIBRA, VELOE) e alinhamento de cada coluna, como na Base_copia.
- [x] Opções dos cadastros viram **tabelas** (esquema `cadastro` no Supabase): unidades, categorias de veículo, marcas, avisos de
      posto, produtos de contrato; engrenagem mantém os cadastros; modelo `gestao` usa os ids do cadastro (18/11).
- [x] Placa e motorista só gravam com unidade/categoria/marca cadastradas (validação no banco antes da fila da planilha).
- [ ] Postos, contratos x ANP e fornecedores validarem no servidor a unidade/aviso/produto contra o cadastro (hoje só a lista do formulário).
- [ ] Categoria e marca do veículo como chave (id) do cadastro quando as placas saírem da planilha (15.3); hoje texto validado.

### 15.2 Abastecimentos no banco
Agendador escolhido pelo usuário (19/11/2026): **Supabase Edge Functions** (pg_cron chama as funções; credenciais dos cartões como
segredos do Supabase). Precisa de um token de acesso do Supabase gerado pelo usuário para publicar as funções.
Ordem (cada passo conferido antes do próximo; o vigia continua ligado até o fim):
- [x] 1. Painéis leem os abastecimentos do banco (`base_transacoes` = Base_copia) em vez da Base.xlsx; o resto do arquivo (negociações,
      locais, orçamento) continua vindo do vigia até a etapa 15.3. Ligado em produção em 19/11 (KV `abastecimentos-fonte` = `banco`;
      para voltar à planilha, apagar a chave). Veículos: decisão do usuário = **Cadastro de placas** (não mais a aba Metas da Base).
- [x] 1b. Área do motorista (Minha média) do banco (19/11; KV `motorista-fonte` = `banco`; o vigia ainda publica os grupos do KV como
      reserva até 15.4). Tempo real comparado com o banco (corrigiu 17-18/11 em dobro nos painéis).
- [x] 2. Lista do Editar abastecimentos e histórico do Consolidador lidos do banco (19/11; chaves KV `base-copia-fonte` e `consolidacao-fonte`).
- [x] 3. (inventário e plano em `docs/MIGRACAO-PASSO3.md`) Gravações do portal direto no banco: correções e exclusões do Editar abastecimentos, Inclusão (bomba interna), lotes do
      Consolidador e do D-1, preço do Rateio das NFs; o vigia deixa de espelhar a Base_copia no banco (o banco vira a origem).
  - [x] 3.1 Filas aplicadas também direto no banco (19/11): `lib/aplicar-banco.js` nas 6 rotas que gravam nas filas + varredura
        `/api/sync/banco/aplicar` (vigia, 1x/min); colunas `banco_aplicado_em`/`banco_mensagem`.
  - [x] 3.3 Virada (19/11, antecipada a pedido do usuário): `supabase_sync.py` não recopia mais `base_transacoes`
        (volta: `py scripts/supabase_sync.py sincronizar base_transacoes --voltar-planilha`).
  - [x] 3.2 (27/11: iguais, 63.537 abastecimentos; teste encerrado) Teste até 27/11/2026 (adiantado de 01/12 pelo usuário em 25/11): `scripts/comparar_base.py` diário (vigia, 7h) igual + nenhum `banco_mensagem` com "erro".
  - [x] 3.4 Varredura no agendador da nuvem (23/11: pg_cron `nuvem-varredura-filas`).
- [x] 4. Rotinas dos cartões nas Edge Functions (plano e situação em `docs/MIGRACAO-PASSO4.md`; infraestrutura pronta em 19/11;
      estornos TruckPag e APIs dos cartões com Rateio das NFs LIGADOS em 23/11; conferência e conciliação em 23/11; cadastros nos cartões em 27/11: todas LIGADAS): tempo real e D-1 (Ticket/TruckPag), estornos TruckPag, cadastro de motoristas e
      placas nos cartões, conciliação de NFs, conferência com os cartões.

- [x] 24/11: varredura das filas com índice no D1 (o LIKE lia a tabela inteira e estourou o limite diário em 23/11); rotina da nuvem
      que falha repete em 10 min; vigia ignora cópias em conflito do ownCloud.
- [x] 25/11: índices nas consultas dos cadastros (a limpeza dos dados pessoais estourou o limite do D1 em 24/11, 16:16–21:00).
- [x] Antes de 15.4: conferir o consumo diário do D1 (rows read) depois do índice. Feito 25/11: `bomba-rateio/estado` lia
      alteracoes_base_copia inteira a cada 5 min (~0,7 M/dia); índice parcial `0035` + `INDEXED BY`: 2.513 -> 1 linha lida por vez.

### 15.3 Demais planilhas no banco
Plano, inventário e decisões (25/11/2026): `docs/MIGRACAO-15-3.md`.
- [x] Placas e motoristas: banco é a origem desde 25/11 (lidos do banco, fila aplicada no banco, virada depois do teste do usuário).
      Comparação diária com a planilha (`comparar_cadastros.py`) até 15.4.
- [x] Cartões frota: banco é a origem desde 25/11 (virada junto com as placas; ligação com o cadastro de placas no banco).
- [x] Preço bomba interna: banco é a origem desde 25/11 (virada depois do teste do usuário; Arla de hora em hora no pg_cron).
- [x] Negociações e localização dos postos: banco é a origem desde 25/11 (virada depois do teste do usuário). Falta levar a busca de
      coordenadas do OpenStreetMap para a nuvem (hoje o vigia busca, grava na planilha e manda ao banco).
- [x] Placas e motoristas sem a planilha (virada 25/11; comparação diária igual).
- [x] Cartões frota, postos dos motoristas e negociações, preço bomba interna, coordenadas dos postos (viradas 25/11; comparação diária igual).
- [x] Real x Orçado: orçamento por upload da planilha na tela, um ano por vez sem substituir (decisões do usuário 25/11); banco é a
      origem desde 25/11 (o próximo envio é o de 2027).
- [x] ANP e Petrobras pelo GitHub Actions, LIGADOS em 25/11 (ANP pela ponte `proxy-anp` em São Paulo; resultados idênticos aos do vigia).
- [x] Reajustes SGB: nada mais lê a planilha (o painel já usava os contratos do portal; o cartão do Início passou a usar também, 25/11).
      O passo `processarReajustes` do vigia e `reajustes.json` saem no 15.4.
- [x] Busca de coordenadas no OpenStreetMap como rotina da nuvem (`geo-postos`), LIGADA em 25/11.

### 15.4 Desligar o vigia
- [x] Aviso "Atualizar: dados novos" (`/api/dados/versao`) ainda usa a versão que o vigia publica no KV ("versao"): passar a somar
      as versões do banco (`gestao_dados_painel_versao`, `gestao_bomba_versao` e as próximas) antes de desligar o vigia (25/11/2026).
      Feito 25/11: com os painéis no banco a versão é o ETag do arquivo (`versaoDoBanco` em lib/dados-painel.js); a do vigia só conta
      enquanto alguma parte ainda vem das planilhas.
- [x] pg_cron `gestao-dados-painel`: ~8 s a cada 2 min mesmo sem mudança e 3 a 6 falhas por dia passando de 2 min (statement timeout);
      gerar só quando algo mudou (visto em 25/11/2026). Feito 25/11: contador por gatilho (`painel_mudancas`), rotina
      `gestao_dados_painel_rodar()`; conferir em 26/11 o tempo e as falhas do dia em `cron.job_run_details`.
- [x] Conferir painéis x banco por alguns dias com o vigia ainda ligado (só lendo). Comparações finais 27/11: 63.537 abastecimentos iguais; cadastros só com diferença de arredondamento das coordenadas.
- [x] Desligar o vigia (27/11/2026): chave KV `vigia-desligado` (nenhum computador recebe o plantão), tarefa do Kemigas desativada, pedidos fechados como 'aplicada' pela nuvem (`fecharNoBanco`), cadastro nos cartões LIGADO na nuvem, reajustes fora.
- [ ] Usuário: desativar a tarefa "Gestao Combustivel - sincronizar Base" (reserva) no notebook LAPTOP-3MSEKU3I (hoje fica em espera pelo interruptor, mas continua rodando).
- [x] Ticket não cadastra motorista novo sem a categoria da CNH: o cadastro novo com cartões passou a exigir só a categoria (27/11/2026).
- [x] ANTONIO DONIZETTI AUGUSTO (pedido 767): categoria AE informada pelo usuário; criado na Ticket pela nuvem em 27/11 8:50 (dados pessoais apagados).
- [x] Apagar as chaves KV `reajustes` e `reajustes-versao` (sem uso desde 27/11; apagadas em 27/11).
- [x] Preço bomba interna: "Lançar negociação" e "Adicionar fornecedor" só com as praças (com negociação ou fornecedor), não o cadastro inteiro de unidades (23/11/2026).

## 16. Espaço do Supabase (25/11/2026; plano gratuito = 500 MB, em 25/11: 334 MB)
- [x] Limpeza diária do histórico do pg_cron (mais de 7 dias).
- [x] Tirar a ANP do espelho (`supabase_sync.py`) e da carga (`gestao_carga.py`) e apagar `public.anp_precos` e `gestao.anp_precos` (89 MB; o site não usa). Feito 25/11.
- [ ] Apagar `backup.base_transacoes_20261119` (33 MB) depois de 01/12 (a conferência banco x planilha termina em 27/11; a cópia fica uns dias a mais por segurança).

## 17. Notificações no celular (26/11/2026)
Decisões do usuário: começar pela equipe de gestão (depois os motoristas); escolher em cada notificação se vai para o celular.
- [x] Opção "Enviar também para o celular" em Configurar notificações (D1 `notificacoes.celular`, espelho no Supabase).
- [x] Sino: "No celular" com Ativar / Enviar teste / Desativar neste aparelho; instrução do iPhone (Tela de Início); manifesto da gestão.
- [x] Nuvem: Edge Function `notificacoes-push` a cada 10 min (ligada), mesmo motor do sino, Web Push sem biblioteca (VAPID + aes128gcm).
- [x] Android: ativado e teste recebido (usuário, 26/11).
- [x] iPhone: ativado pela Tela de Início e teste recebido (usuário, 26/11). Primeira notificação marcada: Estoque baixo (5 bases, 9.000 L, a cada 1 h).
- [x] Com uma regra de estoque baixo ou preço alto marcada: conferir o tempo da rodada. 26/11 07:35: Estoque baixo (5 bases) rodou
      sem erro em ~10 s no total (quase tudo download dos arquivos), 5 avisos x 2 aparelhos = 10 enviados. Se um dia passar do limite
      de CPU (2 s), guardar os estoques calculados em vez de refazer a cada rodada.
- [ ] Motoristas (depois): avisos da área do motorista (comunicado, resultado do PRIME).

## 18. Ajustes de 26/11/2026
- [x] Faixas do topo no padrão "valor embaixo" (`.apoio-pilha` no lugar de `.apoio-topo` em 9 telas).
- [x] Baixar da NFS, ícone do Estoque, posto em duas unidades, motorista no dia a dia, colunas de Despesas, Controle Ticket Log,
      Evolução placas sem CC, R$/KM no Real x Orçado, toque longo = Ctrl+clique, modo escuro no menu da conta.
- [x] Publicar nos dashboards (snapshot até D-1; `painel_publicacao`, migração `20261126110000`). Primeira publicação 26/11 (até 25/11).
- [ ] Usuário: conferir o Controle Ticket Log com o Power BI (as medidas Média 6 meses e 50% foram deduzidas, o usuário confirmou a leitura).
- [ ] Usuário: testar o toque longo no app (Operação por motorista, Programa PRIME, Real x Orçado, Mapa de calor).
- [x] Tela de login (protótipo login-v2) e postos autorizados só com login (26/11/2026).
- [ ] Usuário: testar o login de um motorista no celular (app instalado abre no login e depois na área com os postos).
- [x] Mapa de calor: erro "Cannot read properties of null (reading 'clientHeight')" em enquadrar ao sair da tela (corrigido 27/11: chamadas atrasadas param no desmontar) (ResizeObserver
      sem desligar; visto no console em 26/11).
- [x] Aviso personalizado (postos e abastecimentos) e unidades do login para separar por unidade (26/11/2026).
- [ ] Usuário: cadastrar os encarregados (Gerenciar acessos > Unidades) e criar o aviso de mudanças nos postos com "Separar por unidade".
- [x] Bordas dos botões mais suaves e botões de ícone sem borda; badge da notificação com o símbolo do grupo; litros e valor
      economizado no ranking do PRIME (26/11/2026).
- [x] Campos de texto, listas e buscas com a borda suave em todo o portal (26/11/2026).
- [x] Medidor da média: linha "% da meta" embaixo do arco, sem sobrepor (26/11/2026).
- [x] Textos da tela sem Base/Base_copia/planilha/vigia (27/11/2026; teste `textos-sem-planilha.test.mjs`).
- [ ] Erros no console ao trocar de tela rápido (vistos 27/11 na varredura): Operação por motorista "Cannot read properties of null (reading 'clientWidth')" e Divisão por cartão "(reading 'closest')" (mesmo tipo do Mapa de calor: chamada atrasada depois de sair).
- [ ] Usuário: conferir no Android se a notificação mostra o símbolo do grupo na barra (abrir o app uma vez para atualizar).

