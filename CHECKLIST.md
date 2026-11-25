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
- [x] Vigia rodar a carga do modelo depois de cada sincronização do espelho (17/11/2026; de 5 em 5 minutos).

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
- [ ] Site ler os dashboards do modelo (`gestao.abastecimentos` e cadastros) em vez do JSON gerado das planilhas.
- [x] Cadastro de placas lido do banco e gravado nele na hora (a fila para a planilha continua), 17/11.
- [ ] Motoristas, cartões e postos no banco; depois tirar a fila para a planilha.
- [ ] Editar abastecimentos, Consolidador e lotes D-1 gravarem direto em `gestao.abastecimentos`.
- [ ] APIs dos cartões (Ticket/TruckPag) gravarem direto em `gestao.abastecimentos`.
- [ ] Negociações de postos e preços das bombas gravarem direto no modelo.
- [ ] Bomba interna (bases, tanques, movimentações, rateio) no modelo.
- [ ] Planilhas viram só exportação (Excel gerado do banco) e deixam de ser fonte.
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
- [ ] 3. (inventário e plano em `docs/MIGRACAO-PASSO3.md`) Gravações do portal direto no banco: correções e exclusões do Editar abastecimentos, Inclusão (bomba interna), lotes do
      Consolidador e do D-1, preço do Rateio das NFs; o vigia deixa de espelhar a Base_copia no banco (o banco vira a origem).
  - [x] 3.1 Filas aplicadas também direto no banco (19/11): `lib/aplicar-banco.js` nas 6 rotas que gravam nas filas + varredura
        `/api/sync/banco/aplicar` (vigia, 1x/min); colunas `banco_aplicado_em`/`banco_mensagem`.
  - [x] 3.3 Virada (19/11, antecipada a pedido do usuário): `supabase_sync.py` não recopia mais `base_transacoes`
        (volta: `py scripts/supabase_sync.py sincronizar base_transacoes --voltar-planilha`).
  - [ ] 3.2 Teste até 01/12/2026: `scripts/comparar_base.py` diário (vigia, 7h) igual + nenhum `banco_mensagem` com "erro".
  - [x] 3.4 Varredura no agendador da nuvem (23/11: pg_cron `nuvem-varredura-filas`).
- [~] 4. Rotinas dos cartões nas Edge Functions (plano e situação em `docs/MIGRACAO-PASSO4.md`; infraestrutura pronta em 19/11;
      estornos TruckPag e APIs dos cartões com Rateio das NFs LIGADOS em 23/11; recálculo do KM e varredura das filas também na nuvem; falta Conferência, conciliação e cadastros nos cartões): tempo real e D-1 (Ticket/TruckPag), estornos TruckPag, cadastro de motoristas e
      placas nos cartões, conciliação de NFs, conferência com os cartões.

- [x] 24/11: varredura das filas com índice no D1 (o LIKE lia a tabela inteira e estourou o limite diário em 23/11); rotina da nuvem
      que falha repete em 10 min; vigia ignora cópias em conflito do ownCloud.
- [x] 25/11: índices nas consultas dos cadastros (a limpeza dos dados pessoais estourou o limite do D1 em 24/11, 16:16–21:00).
- [ ] Antes de 15.4: conferir o consumo diário do D1 (rows read) depois do índice; `bomba-rateio/estado` ainda lê alteracoes_base_copia
      inteira a cada 5 min (~0,7 M/dia).

### 15.3 Demais planilhas no banco
Plano, inventário e decisões (25/11/2026): `docs/MIGRACAO-15-3.md`.
- [x] Placas e motoristas: banco é a origem desde 25/11 (lidos do banco, fila aplicada no banco, virada depois do teste do usuário).
      Comparação diária com a planilha (`comparar_cadastros.py`) até 15.4.
- [x] Cartões frota: banco é a origem desde 25/11 (virada junto com as placas; ligação com o cadastro de placas no banco).
- [~] Preço bomba interna: lido do banco e fila aplicada no banco desde 25/11 (`bomba-fonte`); falta comparar com lançamentos reais e
      a virada (`bomba_precos`/`bomba_fornecedores` sem recópia + `gestao_bomba_repetir_arla` de hora em hora no pg_cron).
- [ ] Placas e motoristas sem a planilha (já gravam no Supabase).
- [ ] Cartões frota, postos dos motoristas e negociações, preço bomba interna, coordenadas dos postos.
- [ ] Real x Orçado: orçamento no banco com tela de lançamento.
- [ ] ANP e Petrobras baixados por tarefa agendada na nuvem; conferir se a pasta Reajustes SGB ainda é usada.

### 15.4 Desligar o vigia
- [ ] Conferir painéis x banco por alguns dias com o vigia ainda ligado (só lendo).
- [ ] Desligar a tarefa agendada nos dois computadores e retirar o revezamento.
- [x] Preço bomba interna: "Lançar negociação" e "Adicionar fornecedor" só com as praças (com negociação ou fornecedor), não o cadastro inteiro de unidades (23/11/2026).

## 16. Espaço do Supabase (25/11/2026; plano gratuito = 500 MB, em 25/11: 334 MB)
- [x] Limpeza diária do histórico do pg_cron (mais de 7 dias).
- [ ] Tirar a ANP do espelho (`supabase_sync.py`) e da carga (`gestao_carga.py`) e apagar `public.anp_precos` e `gestao.anp_precos` (89 MB; o site não usa).
- [ ] Apagar `backup.base_transacoes_20261119` (33 MB) depois de 01/12 (fim da conferência banco x planilha).
