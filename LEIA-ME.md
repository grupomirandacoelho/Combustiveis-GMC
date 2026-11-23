# Postos autorizados + Gestão de combustível

Um site só, no Cloudflare Pages:

- `/` — lista de postos para os motoristas (sem login).
- `/gestao/` — área da gestão. Só abre com usuário e senha; sem login o servidor devolve para a tela inicial.

## Pastas

```
public/            o que vai para o ar (HTML, CSS, JS, ícones, postos.csv)
  gestao/          telas da gestão (protegidas)
functions/         código que roda na Cloudflare (login, sessão, proteção de /gestao)
lib/auth.js        senhas (PBKDF2) e sessões
migrations/        estrutura do banco D1
scripts/           criar-usuario.mjs
```

## Onde está no ar

- Site novo: https://gestao-combustivel.pages.dev (projeto Pages `gestao-combustivel`, banco D1 `gestao-combustivel`).
- Site antigo dos motoristas: `postos-autorizados` — é outro projeto; nada aqui publica nele.

Precisa só do Node.js instalado. Não rode `npm install`: os comandos baixam o Wrangler para o cache do
npm, fora desta pasta, para o ownCloud não sincronizar milhares de arquivos. Na primeira vez em um
computador novo, rode `npx wrangler login` para entrar na conta Cloudflare.

## Exportar a Base (Editar abastecimentos, desde 18/11/2026)
- Botão **Exportar** na tabela do Editar abastecimentos: baixa uma planilha igual à Base_copia (aba Transações, 48 colunas, mesma
  formatação) só com os abastecimentos que estão nos filtros da tela (período, placa, motorista, posto, cartão, informações adicionais,
  "só os KM para conferir", "só os alterados"). É ela que atualiza a Base.xlsx à mão (o BI e outras planilhas leem a Base).
- Sai com a formatação da Base_copia: cor da linha de cada cartão (TRUCKPAG verde, VIBRA azul, VELOE lilás; Ticket sem cor),
  alinhamento e formato de cada coluna.
- Vem do banco (Supabase, `base_transacoes`). Correções ainda não gravadas na Base_copia saem como estavam antes. Se a lista da tela
  e o banco estiverem em versões diferentes (um lote acabou de entrar), nada é exportado e o aviso pede para recarregar a página.


## Área do motorista e tempo real (desde 19/11/2026)
- A área do motorista ("Minha média") lê os abastecimentos do banco, com os mesmos números dos painéis (chave KV `motorista-fonte` =
  `banco`; apagar a chave volta ao que o vigia publica).
- O tempo real (transações das APIs ainda não gravadas) é comparado com o banco: só entra o que o banco ainda não tem; os painéis e a
  área do motorista também descartam repetidos (mesma placa, minuto e litros).

## Gravações dos abastecimentos direto no banco (desde 19/11/2026)
- Tudo o que entra nas filas da Base_copia (lotes do Consolidador, D-1 das APIs, Inclusão da bomba interna, "Incluir" da Conferência;
  correções e exclusões do Editar abastecimentos, Rateio das NFs, estornos, recálculo do KM) é aplicado também no banco (Supabase,
  `base_transacoes`) logo depois de gravado, na ordem em que foi pedido. A planilha continua recebendo tudo pelo vigia, como reserva.
- Se o banco estiver fora do ar, o pedido fica pendente e o vigia reaplica uma vez por minuto (`/api/sync/banco/aplicar`).
- **Desde 19/11/2026 o banco é a origem:** a Base_copia não é mais recopiada para o banco. Teste até 01/12: o vigia compara banco x
  planilha uma vez por dia (`py scripts/comparar_base.py`; resultado no log e em `.dados/comparacao-base/`). Para voltar à planilha:
  `py scripts/supabase_sync.py sincronizar base_transacoes --voltar-planilha`.
- Para ver o resultado de cada pedido: colunas `banco_aplicado_em` e `banco_mensagem` das tabelas `consolidador_lotes` e
  `alteracoes_base_copia` no D1 ("anterior" = pedido de antes da integração; "erro: ..." = não aplicado, conferir à mão).

## Rotinas na nuvem (Supabase Edge Functions, desde 19/11/2026)
- As rotinas do vigia passam, uma a uma, para funções no Supabase agendadas pelo próprio banco (a cada 5 min ele confere quais
  rodam). Cada uma começa em **simulação** (só anota o que faria, para comparar com o vigia) e depois é **ligada** (o vigia pula a dele).
- Situação e plano: `docs/MIGRACAO-PASSO4.md`. Ligados na nuvem desde 23/11: APIs dos cartões (tempo real, D-1 e Rateio das NFs) e estornos da TruckPag (o vigia pula essas rotinas). As funções rodam em São Paulo: a TruckPag recusa chamadas de fora do Brasil.
- Publicar depois de mudar uma regra: `node scripts/nuvem_publicar.mjs` (o teste avisa se a cópia em `supabase/functions/_shared` ficou velha).

## Banco de dados no Supabase (desde 12/11/2026)

- Projeto Supabase (Postgres 17) ligado ao repositório do GitHub (pasta `.`, branch `main`). As tabelas ficam em
  `supabase/migrations/*.sql`. No plano gratuito a integração não aplicou a migração sozinha; ela foi aplicada direto no banco
  e registrada em `supabase_migrations.schema_migrations` (assim a integração não repete). Migração nova: testar dentro de uma
  transação desfeita (rollback), aplicar e registrar do mesmo jeito.
- Credenciais só no computador da sincronização: `%LOCALAPPDATA%\GestaoCombustivel\supabase.json` (`url`, `service_role` =
  chave secreta `sb_secret_`, `db` = conexão "Session pooler"; o endereço direto `db.<projeto>.supabase.co` é só IPv6 e não
  funciona daqui). Nunca vão para o GitHub nem para o chat.
- Tabelas (espelho das planilhas, uma por aba): `base_transacoes` (a Base_copia: no banco não há "cópia", a base é editada
  direto — decisão do usuário), `placas`, `motoristas` (sem CPF/nascimento/CNH), `cartoes_placas`, `placas_mercosul`,
  `bomba_precos`, `bomba_fornecedores`, `postos_localizacao`, `negociacoes`, `negociacoes_rotas`, `orcamento_metas`,
  `orcamento_unidades`, `metas_mes` (Base > Metas x mes, uma linha por placa e mês), `bomba_compras` (Base > Bomba interna e
  Bomba Interna Arla), `transacoes_negadas`, `anp_precos`; e `sincronizacao_planilhas` (quando cada uma foi carregada).
  Toda tabela tem `id`, `linha` (linha da planilha) e `sincronizado_em`. RLS ligado em todas, sem política: só a chave
  secreta lê e grava (a chave pública não vê nada).
- Atualização: `scripts/supabase_sync.py`. O vigia chama `sincronizar` a cada volta (em segundo plano, no máximo a cada 60 s):
  a planilha que mudou (e parou de mudar há 20 s) é recarregada inteira na tabela dela, numa transação. Valor que não cabe no
  tipo da coluna, ou coluna nova na planilha: aquela tabela não muda e o log do vigia mostra "Supabase: erro em ...". O que
  já foi carregado fica em `%LOCALAPPDATA%\GestaoCombustivel\supabase-estado.json` (apagar uma entrada força recarregar).
  - `py scripts/supabase_sync.py sincronizar --tudo` recarrega todas (~3 min); `conferir` compara linhas planilha x banco.
  - Coluna nova numa planilha: `py scripts/supabase_sync.py esquema` mostra o SQL; criar uma migração com o `alter table`.
- **Banco da Cloudflare (D1) no Supabase:** as 30 tabelas do D1 (alterações, bomba interna, consolidador, conferência,
  PRIME, notificações, contratos ANP, logins e funções, acessos dos motoristas etc.) estão no Supabase com os mesmos nomes,
  colunas e chaves (`supabase/migrations/20261112200000_cloudflare_d1.sql`). Fora: sessões e tentativas de login
  (temporárias), `d1_migrations` e a coluna `alteracoes_cadastros.pessoais` (CPF temporário; não vai para lugar nenhum).
  Senhas dos logins só como hash. `scripts/supabase_d1.py` (esquema / sincronizar / conferir): o vigia copia a cada 5 min
  só as tabelas que mudaram (`sincronizacao_cloudflare` mostra quando). Migração nova no D1 (coluna ou tabela): o log do
  vigia avisa "precisa de migração"; gerar o SQL com `esquema` e criar a migração no Supabase.
- **Ajustes de estrutura (revisão de 12/11/2026):** `base_transacoes.chave` = placa|data e hora|combustível é a identidade
  do abastecimento (única; não muda quando hodômetro ou litros são corrigidos; os 2 casos antigos repetidos ganham "#2").
  O código da transação não é único e a `linha` muda quando um lote entra no meio da planilha: não usar nenhum dos dois
  para ligar dados. Índices por chave, placa+data, data, unidade+data e código. Saíram do banco as colunas de fórmula que
  eram cópia (ano/mês da data, placa+hodômetro, data_ref, def_posto; `ignorar` em FONTES) e "ano" virou `ano_veiculo`.
  `consolidador_lotes` no Supabase fica sem a coluna `linhas` (os abastecimentos do lote já estão em base_transacoes).
  ANP: `concatenado` não é único (mesmo município em estados diferentes); cruzar por estado + município + produto + mês.
- Ainda não usado pelo site (continua na Cloudflare); próximo passo combinado: domínio próprio e site no Lovable usando o
  Supabase, deixando as planilhas por último.

### Modelo relacional `gestao` (desde 16/11/2026)

- O espelho (`public`) tem a forma das planilhas. O schema **`gestao`** é o modelo organizado: cadastros únicos (unidades,
  veículos, motoristas, postos, combustíveis, fornecedores, bases e tanques) e os dados ligados a eles por chave
  (abastecimentos, compras/NFs, rateio, preços, ANP, orçamento, metas, PRIME, acessos). Descrição completa e lista do que não
  está alinhado nas planilhas: **`docs/BANCO.md`**.
- `npm run banco:esquema` aplica a migração (`supabase/migrations/*gestao*.sql`, registrada em `schema_migrations`);
  `npm run banco:carga` recarrega o modelo a partir do espelho (lê tudo antes e grava numa transação só; a leitura grande
  dentro de transação longa derruba a conexão do pooler); `npm run banco:conferir` mostra totais e pendências da última carga
  (`gestao.carga`).
- **Desde 17/11/2026:** o vigia recarrega o modelo sozinho depois que o espelho muda (de 5 em 5 min; log "Modelo do banco
  recarregado"). O **cadastro de placas do site lê do banco** e grava nele na hora (além da fila para a planilha), pelas funções
  `public.gestao_placas()` e `public.gestao_salvar_placa()`; as Functions usam os segredos `SUPABASE_URL` e `SUPABASE_KEY` do Pages
  (`lib/supabase.js`). Banco fora do ar: o site usa a lista publicada da planilha. Situação de placa nova: **VENDIDO** (sai dos cartões).
- Compras das bombas no modelo também vêm das **planilhas de rateio** (`scripts/rateio_nfs.py`, pasta RATEIOS BOMBA INTERNA, só
  leitura em cópia, cache em `.dados/rateio-nfs.json`).
- Regras de tradução (unidade, combustível, placa, origem): `scripts/gestao_normalizar.py`. Unidade nova ou grafia nova: acrescentar
  em `UNIDADE_CURTA` e no teste. O modelo **não guarda senhas** (a aba Motoristas tem senhas dos portais: ficam de fora).

## Preço das bombas pelo Rateio das NFs (regra de 17/11/2026)

- O vigia só troca o VL/LITRO e o VALOR EMISSAO de um abastecimento de bomba interna pelo preço da nota quando **todas as notas dele
  estão fechadas** (litros todos rateados); até lá fica o preço do cartão. Depois de aplicado ("Rateio das NFs (nota fechada)") o preço
  fica travado, e abastecimento corrigido à mão no Editar abastecimentos nunca é mexido pelo automático.
- O mesmo abastecimento da API e da Base_copia é reconhecido pela placa com até 10 min e 0,5 L de diferença; o pedido leva o tanque
  (diesel/arla) e o vigia só grava na linha desse combustível.

## Lint e testes (desde 16/11/2026)

- Toda alteração: `npm run verificar` = lint (`npm run lint`: ESLint com `.eslintrc.json` + compilação dos scripts Python) e
  testes (`npm test`: `tests/js/*.test.mjs` com node:test e `tests/py/test_*.py` com unittest). Cada mudança ganha o seu teste.
- Não rodar `npm install` (o ownCloud sincronizaria o node_modules): o ESLint roda por `npx --yes eslint@8`.
- Toda alteração também entra no **`CHANGELOG.md`** (o que foi pedido e feito, mais novo em cima) e no **`CHECKLIST.md`**
  (demandas por seção, marcadas quando prontas).

## Código no GitHub

- Repositório **privado** https://github.com/combustiveisgmc/Combustiveis-GMC (conta `combustiveisgmc`, branch `main`).
- O histórico do git fica **fora do ownCloud**, em `C:\Users\Raja\git\gestao-combustivel.git` (o ownCloud corta arquivos e
  estragaria o histórico); nesta pasta há só o arquivo `.git` apontando para lá. Em outro computador: `git clone` normal.
- Não sobem (`.gitignore`): `.dados/`, `CONTROLES/`, planilhas, `.dev.vars`, `.wrangler/` (banco local) e `node_modules/`.
- Mandar as mudanças: `git add -A`, `git commit -m "o que mudou"`, `git push`. Publicar o site continua sendo `npm run publicar`
  (o GitHub não publica nada sozinho).

## Visual (design v2, refeito do zero em 28/10/2026)

- **Identidade do Grupo Miranda Coelho (18/11/2026):** laranja `#F6A42B` (cor principal), preto `#4B4B4D` e cinza `#97989A`, nas
  variáveis `--gmc-laranja`, `--gmc-preto` e `--gmc-cinza` de `public/gestao/gestao.css` e `public/app.css` (para trocar a cor da
  marca, mude só essas três). Logo (variante monocromática, desde 18/11): `public/logo-grupo.png` (preta, fundo claro) e `logo-grupo-negativo.png` (branca, fundo escuro);
  só o símbolo: `logo-simbolo*.png` (menu recolhido). Ícone do aplicativo e do site: `icon-192.png` e `icon-512.png`.
  Verde e vermelho continuam querendo dizer bom e ruim.
- **Densidade (18/11/2026):** cartões mais compactos para o principal de cada painel caber na primeira tela (1440×900). Os espaços ficam nos tokens `--vao`, `--recheio`, `--recheio-filtros` e `--reg-icone` de `public/gestao/gestao.css`: para afrouxar ou apertar todos os painéis de uma vez, mude só eles.
- Baseado no Figma "SaaS – Sales Management Dashboard – Muvic" (layout Blacksale) e no protótipo `prototipos/design-muvic`.
  Especificação completa (tokens, composição, componentes, estados, celular, acessibilidade): `design-system/MASTER.md`.
- Gestão: `public/gestao/gestao.css` (escrito do zero). Cada tela é uma grade de 12 colunas com faixas de cartões:
  indicadores no topo, medidor/resumo + números, gráfico + lateral, tabela. Escuro por padrão; claro no interruptor do menu.
- Barra superior: título, Atualizar e a ação laranja, **Buscar página** (tecla "/") e a conta sempre na ponta direita.
  Início no formato Overview do Figma (indicadores, gasto diário, média por categoria, números de cada painel; "Todas as
  páginas" só no celular). Endereço que não existe mostra "Página não encontrada".
- Filtros: à mostra ficam **Período, Placa e Estabelecimento** (nessa ordem, nas telas que têm esses filtros; senão o
  seguinte da tela) e o resto em **Mais filtros**, em todas as telas (computador e celular). Operação por motorista, Média
  geral e Evolução placas ganharam o filtro Estabelecimento (tipo: posto de combustível, interno, Cais Vibra). O botão mostra quantos filtros escondidos estão ativos. Vários valores
  do mesmo filtro viram uma etiqueta só ("Combustível: DIESEL +3"; o x limpa o filtro inteiro).
- Números: reais sempre com "R$" na frente (R$ 1.234,56); preço por litro com 3 casas e "R$/L" depois (6,525 R$/L).
  A média de Despesas se chama "Média (todos os combustíveis)" (as outras telas usam só diesel).
- Início: no mês em andamento, o último dia do gráfico "Gasto diário" sai tracejado (ainda está entrando) e fica fora da
  "Média por dia".
- Dashboards (Operação, Despesas, Média geral) e Mapa de calor abrem em **Este mês** (`periodoPadrao` em `lib/filtros.js`).
- **Listas de seleção:** todas as seleções e campos com sugestões abrem a lista do site (`lib/selecao.js`): mostra todas
  as opções, a escolhida marcada, busca quando são muitas e filtro ao digitar. No Rateio das NFs o centro de custo lista
  todos os centros de custo da Base_copia.
- **Segurança:** com senha provisória só a troca de senha funciona (as APIs ficam fechadas até trocar). Cada arquivo de
  dados vai só para quem pode abrir a tela que usa ele. Errar a senha 5 vezes bloqueia a conta por 15 min só naquele
  aparelho; um aparelho que erra 20 vezes (em qualquer conta) fica bloqueado 15 min. Cabeçalhos de segurança em
  `public/_headers` e em `lib/auth.js` (o Referrer-Policy precisa ser `strict-origin-when-cross-origin`: com `same-origin` o OpenStreetMap bloqueia os mapas).
- Peças compartilhadas: `lib/baixar.js` (Baixar CSV/XLSX), `lib/acoes-linha.js` ("⋯" e linha que abre a edição),
  `htmlMedidor` e `suavizar` em `lib/graficos.js`.
- Motoristas: `public/app.css` (página de postos: indicadores, unidades em grade, cartões de posto) e
  `public/motorista/motorista.css` (Minha média), no mesmo visual.

## Usuários e senhas

- Administradores: `pedro.lagares`, `joao.oliveira`, `vitor.coelho`. Senha inicial: `123456`.
- No primeiro acesso o site obriga a trocar a senha (mínimo 8 caracteres); a gestão só abre depois disso.
- Depois, a senha pode ser trocada quando quiser em **Trocar senha**, no topo da gestão.
- **Gerenciar acessos (pelo portal, só administradores):** Conta (canto superior direito) → Gerenciar acessos. Desde 18/11/2026 não fica mais no menu lateral.
  - **Novo login:** nome, usuário e tipo de acesso. O portal gera uma senha provisória, mostrada uma única vez,
    e a pessoa troca no primeiro acesso.
  - **Tipo de acesso:** *Administrador* abre tudo e gerencia os acessos. *Acesso personalizado* abre só o que
    estiver marcado: cada dashboard, o mapa, ver a lista de postos, alterar postos e a rodada de preços
    (catálogo em `lib/permissoes.js`). *Função* libera as páginas de uma função pronta; o botão
    "Personalizar a partir desta função" copia essas páginas para ajustar só aquele login.
  - **Funções:** no quadro "Funções" da mesma página, crie, edite ou exclua funções. Editar uma função muda na hora
    o acesso de todos os logins dela. Excluir copia as páginas para os logins, que ficam como personalizados.
  - A tabela de logins tem pesquisa e ordena ao clicar no título da coluna.
  - **Editar:** muda nome, tipo, permissões e "login ativo". Desmarcar "ativo" bloqueia na hora, sem excluir.
    **Nova senha** gera outra senha provisória e desconecta a pessoa.
  - **Excluir:** a pessoa não entra mais e o login some da lista, mas o registro fica, porque o histórico de
    alterações de postos aponta para ele. O nome de usuário fica livre para ser usado de novo.
  - **Proteções:** ninguém exclui, desativa ou rebaixa a si mesmo, e sempre sobra pelo menos um administrador
    ativo.
  - **Validação no servidor:** o menu esconde o que não é permitido, e o servidor confere de novo em cada pedido:
    - `/gestao/dados` exige alguma página que use os dados;
    - `/api/postos/alteracoes` exige ver os postos para ler e alterar os postos para gravar;
    - `/api/postos/rodada` exige a rodada de preços;
    - `/api/usuarios` exige administrador.

    Observação: o arquivo de abastecimentos é um só. Quem pode abrir qualquer dashboard recebe o arquivo inteiro,
    e as páginas liberadas definem o que a pessoa vê.
- **Pela linha de comando (alternativa):** `npm run criar-usuario -- usuario "Nome Completo" gestor --remoto`
  cria ou redefine a senha de um login. Um login criado por aqui sem permissões não abre nenhuma página;
  marque as permissões em Gerenciar acessos.

## Fiscal/Financeiro > Conciliação de NFs

- Lista de cada **nota fiscal de serviço (NFS)** emitida pelo cartão (número, emissão, valor) com a conciliação: quantas
  notas dos postos já foram recolhidas, a soma delas e se bate com as compras da fatura ("Conciliada", "N postos sem nota"
  ou "Diferença R$ ..."). Clicar em qualquer parte da linha (ou Enter nela) abre uma tela própria com as notas dos postos daquela NFS (posto, número, emissão,
  valor, eletrônica ou manual) e os postos que ainda não entregaram a nota, com "Voltar às NFS" no topo. O botão de baixar
  (ícone) abre as opções CSV e XLSX da lista detalhada: data do lote (emissão da NFS), número da NFS, data de emissão e
  número da NF do posto, posto, valor da NF e cartão. Filtros: período de emissão da NFS, cartão, conciliação
  (Conciliada / Faltam notas / Com diferença), pagamento e mês de vencimento, além da busca por número.
- Vem das APIs (só leitura), montado pelo vigia a cada 6 horas: NFS emitidas a partir de 01/01/2026.
- **Ticket:** NFS = título da fatura de reembolso; as compras do título são ligadas aos lotes da "coleta de notas" da Ticket
  (mesmas transações) e cada lote traz os postos e as notas.
- **TruckPag, transações sem nota:** aparecem uma a uma no topo da tela da NFS (posto, código da transação, placa, data e
  hora, valor), como os postos sem nota da Ticket. Compra estornada e o estorno dela se anulam: não aparecem, não contam
  como pendência e não vão no arquivo baixado. A lista de NFS e a lista de notas têm rolagem própria (cabeçalho fixo).
- **Conciliada:** sem posto/transação sem nota e diferença entre a soma das notas e as compras da NFS de até R$ 1,00
  (margem de erro decidida pelo usuário); acima disso aparece "Com diferença".
- **TruckPag (ligada em 27/10/2026):** NFS = título (lote de reembolso, um a cada 15 dias) da API antiga deles (/Faturamento/Titulos), com
  as notas dos postos pela chave da NF-e (XMLs da API nova). Essa API tem usuário e senha próprios (não é o token que já
  usamos). Para ligar, no Kemigas, no arquivo `%LOCALAPPDATA%\GestaoCombustivel\apis-cartoes.json`, dentro do bloco
  "truckpag", acrescentar `"titulosUsuario": "<usuário>"` e `"titulosSenha": "<senha>"` (a senha normal; o portal faz o
  MD5 que a API pede). Na volta seguinte do vigia (até 6 h, ou reiniciando o vigia) a TruckPag aparece na tela.
- Acesso: permissão "Conciliação de NFs" (grupo Fiscal/Financeiro) em Gerenciar acessos.

## Operacional > Conferência com os cartões

- Tabela: Abastecimento (placa, cartão, data), Estabelecimento, Diferença e os botões presos na borda direita; no celular
  cada abastecimento vira um cartão com os botões embaixo. As contagens ficam nas abas.
- Compara a Base_copia com o que a **Ticket** e a **TruckPag** mostram hoje (últimos 45 dias, até anteontem), para pegar
  transações editadas ou lançadas depois no portal do cartão. O vigia (`scripts/conferencia_cartoes.mjs`) refaz a
  comparação a cada 3 horas (cache por dia em `.dados\cartoes-api\conferencia\`) e publica no KV `conferencia-cartoes`.
- Casa cada transação com a linha da Base_copia pela placa + minuto + combustível (Arla separado) e, se a placa foi
  trocada, pelo minuto + litros. Compara placa, hodômetro, litros (diferença a partir de 0,01 L: a TruckPag manda 3 casas
  e a Base_copia guarda 2) e valor (valor só fora da bomba interna e acima de R$ 0,50). Uma 3ª passagem casa pela placa,
  dia, cartão e litros quando a hora ou o combustível foram mudados. Da TruckPag só contam as transações APROVADAS que não
  são VAZAMENTO (situação lida do relatório analítico de transações). A API da Ticket não informa cancelamento.
- Usa o histórico do Editar abastecimentos para separar **correção nossa** de **mudança no cartão** (original / nosso / cartão):
  - **Alterado no cartão:** mudou lá e não foi corrigido aqui. "Aplicar o do cartão" grava direto daqui: mostra o antes →
    depois (com KM rodados e KM/litro refeitos nesta linha e na seguinte) e, confirmando, manda para a Base_copia pela
    mesma fila do Editar abastecimentos. Se o valor do cartão der KM impossível, a confirmação avisa. Troca de placa
    abre o Editar ("Aplicar no Editar"), para conferir a sequência das duas placas.
  - **Conflito:** corrigido aqui e o cartão mudou para outro valor. Aplicar o do cartão ou "Manter o nosso".
  - **Falta na Base_copia:** está no cartão e não na planilha. "Incluir na Base_copia" vira um pedido; o vigia monta o lote
    com o motor do Consolidador (mesmas regras do D-1, confere duplicado) e grava. "Ignorar" tira da lista.
  - **Sumiu do cartão:** está na planilha e a API não traz mais (cancelada/estornada). Abrir no Editar (para excluir) ou Manter.
  - **Corrigido no portal:** o cartão continua com o valor original e a Base_copia com a nossa correção. Só informação.
  - **Mantidos:** decisões tomadas (com Desfazer). Uma decisão vale para aquele valor do cartão; se o cartão mudar de novo, volta.
- Botão no topo de cada aba (com confirmação) faz a ação em todas as linhas de uma vez: "Manter o nosso em todos"
  (Alterado no cartão e Conflito), "Ignorar todos" (Falta), "Manter todos" (Sumiu) e "Desfazer todos" (Mantidos; não
  desfaz inclusões já pedidas). "Corrigido no portal" é só informação e não tem botão.
- Nada é alterado sozinho. O selo no menu mostra quantas diferenças ainda não têm decisão.
- Acesso: "Conferência com os cartões" (consulta) e "Conferência com os cartões (manter, ignorar e incluir)" no grupo
  Operacional; o "Aplicar" precisa também de "Editar abastecimentos (gravar correções)".
- Banco: `conferencia_decisoes` e `conferencia_pedidos` (migração 0020). API: `/api/conferencia-cartoes`; o vigia usa
  `/api/sync/conferencia-cartoes/pedidos`.

## Área do motorista (média e meta de cada motorista)

- Página dos postos: linha "Cartões aceitos" no topo, aviso de cartão faltando, unidade e busca; cada posto mostra nome,
  cidade e cartão, com o botão do mapa à direita (tocar no posto também abre o mapa).
- O motorista abre a página dos postos, toca em **Entrar** e digita o **usuário** = os 6 primeiros números do CPF (se
  digitar o CPF inteiro, por costume, vale só o começo) e a **senha**: a inicial é o próprio usuário; ele pode trocar na
  aba **Senhas** ("Seu acesso a este portal" > Trocar minha senha; pelo menos 6 letras ou números). Esqueceu a senha que
  escolheu: Cadastro > Motoristas > **Senha inicial** na linha dele (volta a ser o usuário e encerra as sessões abertas).
  Depois de 5 tentativas erradas o usuário fica bloqueado por 15 minutos. Fica conectado 30 dias no aparelho; "Sair" no topo.
- **Sem dados pessoais (12/11/2026, pedido do usuário):** o portal, a planilha e o banco não guardam CPF, data de
  nascimento nem CNH dos motoristas. O usuário de 6 números fica na coluna C (USUARIO) da aba Motoristas; senha escolhida
  só como hash, na tabela `motoristas_acesso` (que também guarda primeiro e último acesso e quantos acessos).
- **Controle de acessos:** Cadastro > Motoristas mostra a coluna "Último acesso" (data, quantos acessos, senha inicial ou
  trocada), o filtro "Área do motorista" (Já entrou / Nunca entrou) e, no resumo, quantos já entraram e quantos entraram
  nos últimos 30 dias.
- Quem pode entrar: motorista do Cadastro > Motoristas (planilha Controle_motoristas_e_placas) que não esteja DESLIGADO.
- A tela (`/motorista/`) é um espelho da Operação por motorista só com os abastecimentos dele: média km/L contra a meta do
  mês (com % atingido), litros economizados ou gastos acima da meta, km, litros e abastecimentos do mês, mês a mês (% da
  meta) e a lista dos abastecimentos. Mesmas regras da Operação (só diesel, veículos com categoria, sem PICAPE e VENDA).
  Mês atual e os 12 anteriores; as transações das APIs dos cartões aparecem na hora (selo "novo").
- O motorista é ligado aos abastecimentos **pelo nome do cadastro** (igual ao NOME MOTORISTA da Base, sem diferença de
  acento/maiúsculas). Se o nome no cadastro estiver diferente, a tela mostra que não achou abastecimentos: corrija o nome no
  cadastro. Em 27/10/2026, 159 dos 162 motoristas ativos já casavam (os 3 restantes não abasteceram nos últimos 13 meses).
- O motorista não vê nada da gestão (sessão separada) e o site só entrega a ele os abastecimentos dele.

## Trocar os motoristas para o site novo (quando estiver pronto)

Enquanto isso não for feito, os motoristas continuam usando o site antigo normalmente.

- **Com domínio próprio** (ex.: postos.suaempresa.com.br): no painel, remova o domínio do projeto antigo
  (Custom domains) e adicione no `gestao-combustivel`. O endereço dos motoristas não muda.
- **Só com endereço .pages.dev:** publique no projeto antigo apenas um arquivo `_redirects` com a linha
  `/*  https://gestao-combustivel.pages.dev/:splat  301`. Quem abrir o endereço antigo (inclusive pelo
  app instalado no celular) cai no site novo.

## Dia a dia

- **Dados dos dashboards (automático):** a tarefa do Windows "Gestao Combustivel - sincronizar Base" deixa um
  vigia rodando neste computador (`sincronizar.mjs --vigiar`), que confere a `..\Base.xlsx` e a
  `..\LOCALIZAÇÃO DOS POSTOS.xlsx` a cada 10 s. Quando uma delas é salva e para de mudar por 20 s, ele lê uma
  cópia (as planilhas nunca são alteradas), gera `.dados/abastecimentos.json` e envia para o Workers KV
  `gestao-dados`. Do salvamento até o site: cerca de 1 minuto.
  O vigia avisa o site do andamento (chave `status`): clicando em **Atualizar** durante o envio, aparece
  "a Base salva às HH:MM está sendo enviada" e os dados entram sozinhos quando chegam.
  A tarefa roda no logon e a cada 5 min (se o vigia cair, volta; se estiver rodando, não abre outro).
  Não precisa publicar o site para atualizar dados.
  - Enviar agora, à mão: `npm run atualizar-dados`.
  - Log: `%LOCALAPPDATA%\GestaoCombustivel\sincronizacao.log`.
  - Precisa do login do Wrangler no seu usuário (`npx wrangler login`, uma vez). Se o log mostrar erro de login,
    rode de novo; ou crie um token de API da Cloudflare com permissão "Workers KV Storage: Edit" e salve-o em
    `%LOCALAPPDATA%\GestaoCombustivel\cloudflare-token.txt` (não vence como o login).
  - Pausar/remover: Agendador de Tarefas do Windows → "Gestao Combustivel - sincronizar Base".
  - O computador precisa estar ligado e com o seu usuário conectado. Futuramente as APIs dos cartões gravam no
    mesmo lugar (KV `DADOS`), direto na Cloudflare.
  - Só gerar o arquivo, sem enviar: `npm run importar-base`.
- **Postos dos motoristas (pelo portal):** a lista cabe na página sem rolar para o lado: Posto (com cidade e unidade embaixo), Situação e tipo, Cartão, Última negociação, Aviso e Ações (Editar, Bloquear/Autorizar e Ver no mapa). Em tela estreita cada posto vira um cartão; mostra 50 por vez. Gestão → Postos → Postos dos motoristas. Adicionar, Editar, Bloquear
  e Autorizar registram a alteração no banco (tabela `alteracoes_postos`). O mesmo vigia busca as pendências a
  cada 10 s e grava **uma linha nova** no fim da aba "Base de dados de negociações" da
  `..\Gestão de negociações de preço.xlsx` (data de hoje, contato "NOME (PORTAL)"; nenhuma linha existente é
  alterada). Em seguida republica a lista dos motoristas (`/postos.csv`, chave `postos` do KV).
  - **Planilha aberta no Excel:** a gravação espera ela ser fechada (o portal mostra "Planilha aberta no Excel").
  - **Valor em branco:** quando o valor fica vazio (por exemplo, ao mudar só o tipo ou a situação), a linha nova
    repete o valor negociado da última negociação daquele posto.
  - **"Novo contato feito?" (J):** ao gravar uma linha nova, o portal marca "Sim" nas linhas anteriores do mesmo
    posto, como na rotina manual. Isso tira os avisos de DESATUALIZADO e RENEGOCIAÇÃO OBRIGATÓRIA das negociações
    já substituídas.
  - **Cópia de segurança:** antes de cada gravação, em `.dados\copias-planilha` (as 30 mais recentes).
  - **Fórmulas** das colunas N a P são copiadas da linha anterior; o Excel recalcula ao abrir.
  - **Coordenadas** digitadas no portal ficam em `.dados\coordenadas-postos.json` (valem sobre a
    `LOCALIZAÇÃO DOS POSTOS.xlsx`).
  - **Regra da lista:** último lote semanal (data com 30 linhas ou mais) + tudo negociado depois dele, valendo a
    última negociação de cada (unidade, posto). Editar a planilha à mão também republica a lista, 20 s depois
    de salva.
  - Republicar à mão: `node scripts/sincronizar.mjs --postos`.
  - O token do vigia fica em `%LOCALAPPDATA%\GestaoCombustivel\sync-token.txt` e é o segredo `SYNC_TOKEN` do
    projeto Pages (os dois precisam ser iguais).
  - `public/postos.csv` só é usado se o KV estiver vazio.
- **Rodada de preços (pelo portal):** Gestão → Postos → Rodada de preços. Para cada posto da lista, pega a última
  transação de diesel feita depois da transação usada na negociação anterior (coluna K) e propõe esse preço.
  As bombas internas ficam fora (13/11/2026: POSTO INT RAJA BELEM/JEQUIE/SALVADOR/SAO PAULO, CAANA, CALAN, CABET,
  CAAPE): o preço delas não vem por aí e, sem o rateio pronto, sairia errado. Lista `FORA_DA_RODADA` na tela e no
  `POST /api/postos/rodada` (que recusa esses postos).
  Variação acima do limite da planilha (U1, hoje 10%) só entra se a pessoa marcar o posto. "Gravar rodada" manda
  tudo junto (`POST /api/postos/rodada`); o vigia grava uma linha por posto com contato
  "ATUALIZAÇÃO AUTOMÁTICA (BASE DE TRANSAÇÕES)" (ou "... - CONFIRMADO PELO USUÁRIO (VARIAÇÃO >10%)"),
  K = data e hora da transação e Q = variação. Postos com alteração ainda não gravada ficam de fora.
- **Roteirizador SPOT (Mapas):** adaptação do "Planejador de rota & abastecimentos" para as viagens avulsas, fora
  das bases. Usa os dados do próprio portal:
  - **Preço do posto:** o abastecimento de diesel mais recente nele, pelas transações da Base. Preços fora de
    R$ 4 a R$ 10 são descartados.
  - **Coordenadas:** planilha `LOCALIZAÇÃO DOS POSTOS`. **Tanque e ponto crítico:** aba Metas, no campo `pc` do JSON.
  - **Rota:** OSRM. Se o serviço não responder, usa a linha reta × 1,25 e avisa na tela.
  - **Cidades:** sede de cada município do IBGE (`public/gestao/mapas/municipios.json`: nome, UF, lat, lng). O
    `cidades.json` só completa o que faltar; posto não dá mais coordenada de cidade.
  - **Coordenada suspeita:** o importador confere cada posto da LOCALIZAÇÃO DOS POSTOS contra a cidade da própria
    linha. A mais de 100 km da sede, o posto fica fora do mapa e o roteirizador lista qual é (`locaisSuspeitos` no
    `abastecimentos.json`). Corrija a planilha e salve: na próxima carga ele volta.
  - **Origem, destino e paradas:** cidades, postos da lista dos motoristas (polo, autorizado e mínimo) e fábricas
    dos clientes (`public/gestao/mapas/clientes.json`: empresa, nome, cidade, uf, lat, lng, confiança).
  - **Fábricas dos clientes:** a pesquisa (fontes e motivo de cada coordenada) fica em
    `scripts/clientes/clientes-*.json`. Para corrigir ou incluir uma fábrica, edite o arquivo da empresa e rode
    `py scripts/montar_clientes.py`, que confere se a coordenada cai a até 60 km da sede do município, e publique.
    Confiança "baixa" aparece como "localização aproximada" na lista.
  - **Mapa fixo:**
    - os postos autorizados (polo, autorizado e mínimo) e as unidades RAJA ficam sempre marcados;
    - ao clicar num marcador, aparecem o preço, o último negociado e a última transação;
    - as coordenadas das unidades estão em `BASES`, no início de `roteirizador.js`;
    - um posto a até 1,5 km de uma unidade aparece com o nome da unidade;
    - a legenda pode ser minimizada, e o navegador lembra a escolha.
  - **Regras (iguais às do planejador):**
    - autonomia = tanque × 85% × km/L crítico;
    - preço de referência = posto mais barato nos últimos 150 km da rota;
    - enche o tanque em postos com preço até a referência;
    - mínimo de 30% do tanque por parada. Quando nenhum posto permite esse mínimo, aceita menos e marca a parada.
  - **Opções na tela:** "Preço válido por" (30, 60 ou 90 dias, 1 ano ou sem limite; padrão 30) e "Desvio máximo"
    (5, 10 ou 20 km; padrão 5).
  - **Lista dos motoristas:** vale a última negociação do posto, desde a data de corte.
    - **Bloqueado** nunca entra na rota.
    - **POLO** (coluna Tipo) pode completar o tanque. **Autorizado sem tipo** também pode completar.
    - **Escolha:** sempre o menor preço. A situação na lista só desempata diferenças de menos de 1 centavo. Quando
      um polo ou autorizado está a até R$ 0,05/L do escolhido, a parada mostra um alerta com o custo a mais.
    - **Correção pela data:** preços com mais de 15 dias são corrigidos pelo índice de mercado, montado com as
      transações da frota e encadeado por quinzena (variação dos mesmos postos de uma quinzena para a outra). O
      plano avisa quando a correção passa de R$ 0,10/L ou quando um posto com preço registrado menor fica mais caro
      depois de corrigido.
    - **Detalhe e rotas:** clicar num posto no mapa mostra a data e o valor da última transação, a negociação e o
      preço corrigido. O OSRM devolve até 3 rotas alternativas; cada uma tem o seu plano, e a de menor custo vem
      escolhida.
    - **MÍNIMO** (coluna Tipo, ou aviso que começa com "MINIMO") é posto de pernoite ou auxiliar. Só entra quando
      não há outro ao alcance e recebe apenas o necessário até o próximo posto que completa.
    - **Fora da lista** entra normalmente quando for o mais econômico.
    - **Preço:** para posto da lista, a negociação mais recente vale sobre o último abastecimento quando é mais nova.
  - **Litros:** sempre de 10 em 10. Arredonda para cima e, se não couber no tanque, para baixo.
  - **Trecho sem posto conhecido:** a tela diz entre quais cidades ele fica e pinta o trecho de vermelho no mapa.
  - **Tipo nos postos:** a coluna Tipo da planilha aparece em Postos dos motoristas e no `postos.csv` (última
    coluna), e é editável pelo portal.
- **Dados das negociações nos dashboards:** a planilha de negociações também vai no `abastecimentos.json`
  (bloco `negPostos`, só leitura). Salvar a planilha, à mão ou pela gravação do vigia, reenvia os dados como
  acontece com a Base. Usam esses dados a Rodada de preços e o dashboard Preço postos externos.
- **Preço x ANP (Dashboards):** nosso preço ponderado de diesel contra a média de revenda da ANP (óleo diesel S10).
  - **Dados da ANP:** `scripts/anp_precos.py` lê os arquivos do Levantamento de Preços no gov.br (série histórica
    semanal e mensal, e o resumo das últimas semanas), só diesel S10, Brasil/região/estado/município, desde 2023.
    Gera `.dados/anp/anp.json` (chave `anp` do KV; versão em `anp-versao`), servido em `/gestao/dados/anp.json`.
  - **Atualização automática:** o vigia confere a ANP de hora em hora. Cada arquivo só é baixado de novo quando o
    tamanho dele no servidor muda (o gov.br recusa HEAD; o script pede 1 byte e lê o total). Cache do que já foi
    processado em `.dados/anp/cache`. Enviar agora, à mão: `node scripts/sincronizar.mjs --anp`.
  - **Contas:** nosso preço = soma do valor pago ÷ soma dos litros (todo diesel da Base conta como S10; preços fora
    de R$ 3 a 12 descartados). Média ANP do período = preço ANP de cada semana/mês pesado pelos nossos litros nela;
    só entram semanas/meses que a ANP pesquisou naquele local. Município sem pesquisa da ANP é comparado com o estado.
  - **Semana:** domingo a sábado, igual à ANP. **Origem:** postos externos (padrão), bombas internas ou tudo.
  - **Tabela por município:** mostra onde abastecemos (até 3 postos, do maior volume), com preço ponderado, litros e
    diferença contra a ANP; em vermelho os que estão acima da média.
- **Contratos x ANP (Dashboards):** preço de diesel do contrato com o cliente contra a ANP semanal do estado de
  referência de cada unidade.
  - **Planilha:** pasta `..\..\Reajustes SGB` (só leitura, como a Base). Vale o arquivo com a data mais nova no nome
    (`Controle Reajustes Diesel - DD-MM-AAAA.xlsx`), aba `Super`: UNIDADE, ESTADO REFERÊNCIA, DATA BASE (CONTRATO),
    PREÇO CONTRATO. As colunas são achadas pelo nome. Script: `scripts/reajustes.py` -> `.dados/reajustes.json` ->
    chave `reajustes` do KV (`/gestao/dados/reajustes.json`).
  - **Atualização:** o vigia relê quando entra arquivo novo na pasta ou o mais recente é salvo. À mão:
    `node scripts/sincronizar.mjs --reajustes`.
  - **Conta:** variação = ANP do estado na semana escolhida (padrão: a última publicada) ÷ preço do contrato − 1.
    Semana sem pesquisa no estado usa a anterior mais próxima (até 3 semanas).
  - **Regra de 5% (gatilho do contrato):** até ±5% a situação é "ANP dentro da variação do contrato" (sem vermelho).
    Acima de +5% fica em vermelho; abaixo de −5% aparece "ANP abaixo da variação do contrato" com selo neutro, sem
    vermelho. No gráfico, linha tracejada vermelha em +5% e cinza em −5%. O valor está na constante `GATILHO` de
    `public/gestao/dashboards/contratos-anp.js`.
  - **Maior alta / maior queda:** pelo estado de referência (com as unidades dele), na semana escolhida.
- **Planilha estragada:** antes de gravar em qualquer planilha o computador da sincronização guarda uma cópia em
  `.dados\copias-planilha` e, depois de gravar, confere se o arquivo ficou igual (se não ficou, põe a cópia de volta).
  Se a LOCALIZAÇÃO DOS POSTOS não abrir, o site continua sendo atualizado com a última cópia boa e o log avisa
  "usando a cópia ...": copie esse arquivo de volta por cima da planilha.
- **Postos dos motoristas → Editar com outra unidade ou outro nome:** se um posto foi cadastrado na unidade errada, ou
  com um nome diferente do que está no portal do cartão (comum quando a negociação é feita antes da primeira transação),
  clique em Editar e troque a unidade e/ou o nome (o campo sugere os nomes que já aparecem nos abastecimentos). O
  cadastro antigo sai da lista e fica só o corrigido (na planilha de negociações, as linhas dele passam a ter a unidade
  e o nome novos).
- **Postos dos motoristas → Adicionar posto:** ao digitar o nome do posto aparecem os postos que já tiveram negociação
  (Preço postos externos). Escolhendo um, o formulário vem preenchido com a última negociação (unidade, cidade,
  plataforma, tipo, preço, combustível e coordenada) e um quadro mostra a negociação, o último preço pago e se o posto já
  está na lista daquela unidade (nesse caso, use Editar ou Autorizar). Trocar a unidade puxa a negociação dela.
  Posto sem negociação mas com abastecimento também aparece ("sem negociação"): vem preenchido com os dados da Base
  (cidade, unidade que mais abastece nele, cartão, combustível, coordenada do mapa de calor) e, no valor, o último preço
  pago: troque pelo preço negociado e escolha a situação e o tipo.
  A coordenada da lista dos motoristas vem da planilha LOCALIZAÇÃO (pelo nome do posto): quando um posto ganha
  coordenada lá (mapa de calor, busca automática ou à mão), a lista dos motoristas é republicada sozinha.
- **Preço postos externos:** os postos autorizados da lista dos motoristas aparecem na tabela mesmo sem abastecimento no
  período ("Sem abastecimento neste período"), já com a negociação e o botão "Atualizar preço". Bombas internas e cais
  ficam fora. Abastecimento com o tipo do estabelecimento em branco na Base conta como posto externo.
  Posto bloqueado (13/11/2026): se a negociação que valia no dia é "POSTO BLOQUEADO", o abastecimento não é comparado
  com aquele preço (era o de quando foi bloqueado, ex.: AUTO POSTO BATISTELLA R$ 5,84 em 20/08/2025, e o posto não
  entra na rodada): não soma em "Pago acima", entra em "Abastecido em posto bloqueado" e a tabela mostra "Bloqueado
  desde …". Mesma regra no resumo da Início; bloqueado também não conta como negociação desatualizada.
  Posto sem negociação tem o botão "Incluir negociação": o formulário vem preenchido com os abastecimentos dele (unidade,
  cidade, cartão, combustível, coordenada); informe o preço negociado e grave. Vira a primeira negociação na planilha e,
  como autorizado, o posto entra na lista dos motoristas (o mesmo que o "Adicionar posto").
- **Bomba interna > Estoque:** um cartão por bomba interna (base), com uma barra por tanque (Diesel S10 e/ou Arla 32) e,
  embaixo, volume, capacidade e preço médio. Estoque = medição cadastrada na base + compras (Movimentações) − abastecimentos
  da Base e da Base_copia (os do Consolidador entram na Base_copia e já saem do estoque) com o posto associado à base, cada
  um contado uma vez. "Adicionar base" / "Editar": nome, posto
  como aparece nos abastecimentos da Base (ex.: POSTO INT RAJA JEQUIE), tanques (capacidade, estoque na medição, data e
  hora da medição, preço médio opcional) e ativa/inativa. Para acertar o estoque depois de medir a régua, edite a base e
  informe o novo estoque com a data e a hora: a conta recomeça dali. Preço médio = média ponderada das compras (sem
  compra nem preço informado, vale o último preço da bomba na Base). Bases e compras ficam só no site (D1).
- **Cais da Vibra como base (16/11/2026):** no "Adicionar base" do Estoque, o campo do posto sugere também os cais da Vibra
  (TIPO ESTABELECIMENTO "CAIS VIBRA" na Base: CAANA, CALAN, CABET, CAAPE), que têm tanque próprio e funcionam como bomba
  interna. O cartão da base mostra "CAIS VIBRA - …". Estoque, Movimentações, Rateio das NFs e o vigia já trabalham pelo
  nome do posto da base, então não mudam.
- **Bomba interna: quem vê cada base:** em Gerenciar acessos, no login da pessoa, "Bases da bomba interna": "Todas as
  bases" (padrão, inclusive as criadas depois) ou "Só as bases marcadas". Com só algumas, as telas da Bomba interna
  (Estoque, Inclusão de abastecimento, Movimentações) mostram e aceitam lançamentos só dessas bases, e a pessoa não cria
  base nova. Administrador vê todas. Preço bomba interna não usa essa regra.
- **Bomba interna > Inclusão de abastecimento:** fora do menu desde 23/10/2026 (por enquanto os abastecimentos das bombas
  vêm do Consolidador); a página continua em `#/bomba-abastecimento` para voltar quando quiser. A tela abre na lista dos lançados (com pesquisa por placa, motorista,
  unidade, data…). O botão "+ Adicionar abastecimento" mostra os dois tipos e abre o formulário numa janela: "Rápido"
  (data e hora de agora) ou "Detalhado" (informa data e horário, para quem não lançou na hora). Unidade → combustível (só os tanques da unidade), placa, KM, litragem e motorista (vem o
  último da placa). Mostra o KM anterior, km rodado, média e o estoque. A linha da Base é montada como no Consolidador
  (veículo, matrícula, posto, KM rodado), forma de pagamento BOMBA INTERNA, VL/LITRO = preço médio do estoque; duplicado
  (mesma placa, KM e combustível) é bloqueado. O computador da sincronização grava na CONTROLES\Base_copia.xlsx (como os
  lotes do Consolidador); a lista embaixo mostra a situação de cada lançamento.
  **Editar / Excluir** (na lista, depois que o abastecimento foi gravado na Base_copia): a correção vai pela mesma fila do
  "Editar abastecimentos". Editar remonta a linha (unidade, combustível, data e hora, placa, KM, litragem, motorista) e
  grava só as colunas que mudaram; excluir tira a linha da Base_copia. Nos dois casos o km rodado do próximo
  abastecimento da mesma placa e combustível na Base_copia é refeito. Enquanto a correção não foi gravada, o
  abastecimento fica "aguardando a correção" (sem nova edição). Lançamento que deu erro e nunca entrou na planilha: só
  excluir (sai do site). Excluído não conta mais no estoque.
- **Duplicidade ao gravar na Base_copia:** mesma placa + data (segundo) + hodômetro + **combustível** (diesel junto, Arla à parte).
  Antes não olhava o combustível e o Arla lançado junto com o diesel na bomba interna era descartado (corrigido em 09/11/2026).
- **KM do abastecimento seguinte (automático, 06/11/2026):** quando um lote do Consolidador (manual ou o D-1 da API) é
  gravado na Base_copia, o vigia (scripts/km_recalcular.mjs) procura o próximo abastecimento da mesma placa e cadeia de
  combustível. Se o km dele ainda conta o trecho do abastecimento inserido (km em dobro), cria a correção de KM rodado e
  km/L na fila do Editar abastecimentos ("Recálculo do KM (automático)"). Km já corrigido à mão não é tocado; km que
  ficaria negativo só vai para o log. Os abastecimentos ainda em tempo real já eram recalculados a cada 5 minutos.
- **Lançamentos atrasados nos cartões (automático, 10/11/2026):** um abastecimento lançado hoje na Ticket/TruckPag com data
  de um dia já lido e fechado nunca chegava (o vigia não relia dias fechados). Agora scripts/cartoes_api.mjs relê uma vez por
  dia os últimos 40 dias; o que aparece e não estava na leitura anterior (feita com o dia fechado) é "atrasado"
  (.dados/cartoes-api/tardios.json) e vai para a Base_copia pelo D-1 normal (lote do Consolidador, confere duplicado), mesmo
  antes de 23/10. Dos dias só da revisão, só os atrasados entram na conta (o rateio das NFs segue igual). O log mostra
  "N lançamento(s) atrasado(s) nos cartões encontrado(s) na releitura".
- **Estornos da TruckPag (automático, 06/11/2026):** o relatório usado no tempo real e no D-1 só traz transações válidas;
  o estorno feito depois do D-1 ficava na Base_copia. A cada 6 horas o vigia (scripts/estornos_truckpag.mjs) lê o
  relatório relatorios/analitico-transacao dos últimos 35 dias e, para cada transação ESTORNADA achada na Base_copia
  (TRUCKPAG, mesmo segundo ±5 s ou até 1,5 min, mesma litragem e mesmo hodômetro ou placa; nunca a linha de uma transação
  aprovada, como o refeito pelo posto), põe a exclusão na fila do Editar abastecimentos ("Estorno TruckPag (automático)")
  e acerta o km do abastecimento seguinte. Mais de uma linha igual: só avisa no log. Estado em .dados/cartoes-api/estornos.json.
- **Bomba interna > Movimentações:** compras de combustível (data e hora, unidade, tanque, litragem, valor total, NF,
  emissão da NF, fornecedor, CNPJ, observação); editar, excluir e exportar. Cada compra entra no estoque do tanque e é uma
  nota do Rateio das NFs. "Fornecedor do cadastro" (os do Preço bomba interna com CNPJ, do produto do tanque) preenche o
  CNPJ; o CNPJ digitado mostra de qual fornecedor do cadastro ele é. No Rateio das NFs a nota mostra o fornecedor do
  cadastro pelo CNPJ.
- **Bomba interna > Rateio das NFs:** substitui a planilha "Rateio Bomba Interna Jequié.xlsx". As notas (Movimentações) são
  consumidas pelos abastecimentos da bomba em ordem de hora: a primeira nota até acabarem os litros dela, depois a próxima.
  O abastecimento que passa da última gota de uma nota é dividido (uma parte fecha a nota, o resto abre a seguinte). O preço
  por litro de cada abastecimento é o da nota com mais litros dele, e o vigia lança esse preço (VL/LITRO e VALOR EMISSAO) na
  Base_copia, no lote D-1 e no tempo real. Cada nota tem o rateio por empresa (NOME REDUZIDO) → centro de custo (INFORMAÇÃO
  ADICIONAL 3) → placa, em valor e %.
  - **Validação** (quem tem "Rateio das NFs (validar…)"): quando a nota fecha, abra-a, confira data e hora, placa, motorista,
    litros, R$/L, valor e centro de custo; o centro de custo pode ser corrigido na própria tabela (a correção vai também para
    a INFORMAÇÃO ADICIONAL 3 da Base_copia). "Validar rateio" guarda uma foto do rateio, que é o que o fiscal vê. "Reabrir
    para correção" tira do fiscal até validar de novo.
  - **Rateio na tela:** por centro de custo e, dentro dele, as placas (valor, litros e %), com o total geral. Clicar no
    centro de custo esconde as placas dele; clicar de novo mostra.
  - **Exportar (nota validada):** "Exportar planilha (XLSX)" gera `NF <número>.xlsx` como a planilha de cada nota: aba
    "NF <número>" com os abastecimentos nas 40 colunas da Base (CODIGO TRANSACAO até RESPONSAVEL; LITROS = parte do
    abastecimento na nota, VL/LITRO = preço da nota, VALOR EMISSAO = litros × preço, INFORMACAO ADIDIONAL 3 = centro de custo
    validado) e aba "Rateio" com uma **tabela dinâmica de verdade** (centro de custo → placa, soma do VALOR EMISSAO e
    PERCENTUAL do total), que o Excel atualiza ao abrir (fora do Excel aparecem os valores já escritos). "Exportar rateio
    (CSV)" traz o rateio já montado (centro de custo, placa, litros, valor, %).
    Abastecimento validado antes de chegar à Base_copia (no mesmo dia) sai só com as colunas conhecidas (data, placa,
    motorista, combustível, posto, litros, preço, valor, centro de custo, empresa); reabrir e validar de novo no dia seguinte
    completa.
  - **Fiscal** (só "Rateio das NFs (ver…)"): abre só as notas validadas, exporta os CSVs e marca como conferido. As
    notas lançadas desde o início do rateio do portal que ainda não foram validadas aparecem como **"Em aberto"**, sem
    abrir (o fiscal sabe que o rateio delas ainda não fechou).
  - **Início do rateio** (por tanque): antes dele o rateio ficou na planilha e o portal não mexe no preço. Diesel de Jequié
    começa no SFH1H45 de 22/10/2026 08:46:28, com 70,94 L dele na NF 175332 (última da planilha); a NF 235674 é a primeira
    do portal. O Arla ainda não tem início (defina na própria tela quando for ratear).
    **Cais da Vibra (16/11/2026):** as planilhas `RATEIOS BOMBA INTERNA\CAIS *\CAIS * - Rateio Diesel.xlsm` foram
    completadas até a última NF (Suape 2962521 e Viana 1712274: preço da NF em todas as linhas, `=P*O`, abastecimentos da
    Base_copia até os 5.000 L e o total; cópias de antes em `%LOCALAPPDATA%\GestaoCombustivel\backup-rateios-cais`). O
    portal começa em: CABET no OPP7H48 de 12/11/2026 17:14:13 (NF 5004331 já fechada, 0 L); CALAN no TDK2E30 de
    31/10/2026 08:18:49 (160,14 L na NF 279655); CAAPE no RUZ9E75 de 11/11/2026 07:27:20 (312,65 L na NF 2962521); CAANA no
    QRM0H08 de 12/11/2026 13:37:53 (353,82 L na NF 1712274). As notas seguintes vão em Movimentações (Viana já tem as NFs
    1722159 e 1722862, de 22/10, na aba Base NF STOCK).
  - Abastecimentos que passam das notas lançadas ficam em "Abastecimentos sem nota" e entram na próxima nota assim que
    ela for lançada; até lá o preço deles não muda.
- **Preço bomba interna > Fornecedores cadastrados:** tabela da aba Fornecedores da planilha, com o **CNPJ de cada unidade**
  do fornecedor (coluna CNPJ, criada pelo vigia). "Editar" muda o CNPJ e se o fornecedor está ativo; "Novo fornecedor" pede
  o CNPJ de cada unidade marcada. O vigia grava na planilha e publica o cadastro no KV `fornecedores-bomba` (lido pelas
  Movimentações e pelo Rateio das NFs).
- **Preço bomba interna (Bomba interna; antes em Operacional):** as negociações ficam na planilha CONTROLES\Negociação bomba interna.xlsx (não mais
  na Base). "Lançar negociação": escolha data, produto e unidade e preencha o preço de cada fornecedor (no Arla já vem o
  último preço; no diesel, preencha o do dia). "Novo fornecedor": nome, produto e unidades; entra na aba Fornecedores da
  planilha (ATIVO = NAO na planilha tira o fornecedor da repetição do Arla). O computador da sincronização grava na
  planilha (cópia antes; se ela estiver aberta no Excel, espera fechar) e repete todo dia o último preço do Arla de cada
  fornecedor ativo até um preço novo ser lançado. Precisa do acesso "consulta e edição". Na hora: `node scripts/sincronizar.mjs --bomba`.
- **Mapa de calor: interação como no BI (16/11/2026):** ao trocar um filtro (unidade, período, estabelecimento) o mapa
  enquadra sozinho os postos do recorte. Clicar num posto (na tabela "Postos no mapa" ou na bolha) deixa só ele no mapa,
  com zoom; Ctrl/Cmd + clique soma outros postos (todos ficam no mapa, enquadrados); clicar de novo no único escolhido ou em
  "Todos os postos" volta ao recorte todo. O tamanho da bolha continua pelo recorte todo. Na tabela de abastecimentos, Data,
  Placa e Cartão são colunas separadas e ordenáveis (o cartão com o selo do Ticket/TruckPag/Veloe e "API" quando ainda
  não está na Base).
- **Mapa de calor: postos sem coordenadas:** clique no posto da lista "Postos sem coordenadas" para abrir o cadastro dele e
  inserir a coordenada (cole do Google Maps: botão direito no posto, clique nas coordenadas e cole aqui; ou digite latitude e
  longitude). O site avisa se o ponto fica a mais de 100 km da cidade. O posto já entra no mapa e o computador da
  sincronização grava na planilha LOCALIZAÇÃO DOS POSTOS (com cópia antes; se ela estiver aberta no Excel, espera fechar).
  Precisa do acesso "consulta e edição" no Mapa de calor. As tabelas mostram a última placa e a data e hora do último
  abastecimento. Na hora: `node scripts/sincronizar.mjs --locais`.
  O cadastro mostra o endereço da Base, um mapinha e duas listas do OpenStreetMap: "Encontrados pelo nome" (o nome do
  posto procurado na cidade, sem "REDE xx"/"LTDA") e "Postos de combustível por perto". Clique em "Usar", num ponto do
  mapinha ou em qualquer lugar do mapa, e salve. O computador da sincronização também procura sozinho pelo nome (15 postos
  a cada 15 min enquanto houver fila; `node scripts/sincronizar.mjs --geocodificar`) e só grava quando o nome bate com
  segurança. Os abastecimentos de CAIO COELHO DUTRA e JACY RODRIGUES COELHO (administrativo) e do centro de
  custo RAJA ADM ficam fora do mapa.
- **KM rodado impossível na Base:** nos dados do site (não na Base.xlsx), abastecimento de diesel com KM rodado acima de
  3.000 e mais de 3 vezes a diferença do hodômetro para o anterior da mesma placa usa a diferença do hodômetro (erro de
  digitação estragava a média km/L). O log da sincronização mostra quantos foram trocados. Corrija também na Base.
- **Consulta de KM: correções:** a consulta lê a Base.xlsx. Correções de hodômetro, placa ou exclusões feitas no
  Editar abastecimentos aparecem nela na hora (marcadas como "corrigido"), enquanto a Base ainda tiver o valor antigo.
  Correção feita direto na Base.xlsx aparece quando a planilha é salva (o computador da sincronização reenvia em ~1 min).
- **Consulta de KM: hodômetro que virou 1 milhão:** quando o hodômetro passa de 999.999 e volta a zero, aparece o aviso
  "menor que a leitura de 999.xxx km: conferir". Clique na placa e, no histórico, em "O hodômetro virou 1 milhão": o aviso
  some e as leituras seguintes contam +1.000.000 km nas contas (o hodômetro mostrado continua o real). "Desfazer" volta
  atrás. A marcação vale para todos os usuários.
- **Preço x Refinaria (Dashboards):** nosso preço de diesel contra o preço da Petrobras às distribuidoras (sem tributos) no
  ponto de entrega mais perto de cada abastecimento, no preço vigente no dia. Mesmos recortes do Preço x ANP. Mostra também
  os reajustes da Petrobras no período com o nosso preço na semana antes e depois. O vigia confere o portal
  precos.petrobras.com.br de hora em hora; na hora: `node scripts/sincronizar.mjs --petrobras`. Precisa do pypdf no
  computador da sincronização (`py -m pip install --user pypdf`).
- **APIs dos cartões (Ticket Log e TruckPag):** o computador da sincronização consulta as duas APIs a cada 5 minutos.
  As transações que ainda não estão na planilha Base já entram em todos os painéis (indicador "Tempo real" ao lado do
  Atualizar; selo "API" nas tabelas). No dia seguinte, a partir das 6h, ele grava o dia anterior na Base_copia sozinho
  (lote "Integração Ticket/TruckPag (API)" na lista do Consolidador, com os avisos de posto novo etc.). Veloe e Vibra
  continuam pelo Consolidador. Para rodar na hora: `node scripts/sincronizar.mjs --apis`. As credenciais ficam só no
  computador principal (%LOCALAPPDATA%\GestaoCombustivel\apis-cartoes.json); sem esse arquivo o passo é pulado.
- **Consolidador de abastecimentos (Operacional):** envie Ticket.xlsx, Truckpag.xlsx, Veloe.csv e Vibra.xlsx; a Base não
  precisa ir (o site usa o histórico que o vigia publica a partir da Base.xlsx e da CONTROLES\Base_copia.xlsx). Decida os
  postos pendentes uma vez: a decisão fica gravada. Posto novo (ou da Base sem tipo) sai com o tipo de estabelecimento
  "POSTO DE COMBUSTIVEL" (na Vibra, "CAIS VIBRA"). Abastecimento sem motorista no arquivo (painel 5): "Usar a sugestão"
  (último motorista do veículo) ou digitar outro motorista (lista dos motoristas da Base; a matrícula vem da Base, e nome
  sem matrícula pede confirmação); veículo sem motorista anterior também aparece, para digitar. "Gravar na Base_copia" manda as linhas para o vigia gravar na aba
  Transações da Base_copia **em ordem de data e hora** (o que for mais antigo que as últimas linhas entra no meio, no lugar
  certo; vale também para os lotes da API) (com as cores de cada plataforma; planilha aberta no Excel: espera fechar; cópia antes
  em `.dados\copias-planilha\base-copia-*.xlsx`). Na hora: `node scripts/sincronizar.mjs --consolidador`. Para pôr em ordem
  o que já estiver fora (vigia parado e planilha fechada): `py scripts/planilha_base_copia.py ordenar`.
- **Diesel:** todos os tipos (S-10, S-10 aditivado, comum, "DIESEL") contam juntos nos painéis e ficam numa cadeia só de
  KM por placa (o km rodado de um diesel comum conta a partir do S-10 anterior e vice-versa) no Consolidador, no Editar
  abastecimentos e na Inclusão de abastecimento.
- **Editar abastecimentos (Operacional):** todos os abastecimentos da CONTROLES\Base_copia.xlsx (começa nos últimos 30
  dias; mude o período nos filtros; 15 por vez; clique no título de uma coluna para ordenar; clique numa linha para ver
  todos os abastecimentos daquela placa com o mesmo combustível, e "Voltar ao filtro anterior" para voltar). Corrija na tabela a
  data e hora (16/11/2026: campo "dd/mm/aaaa hh:mm:ss", segundos opcionais, de 2020 até agora; coluna E da Base_copia; o
  abastecimento muda de lugar na sequência da placa e o KM rodado/KM por litro dele, do próximo e dos vizinhos de antes são
  recalculados; o pedido vai com a data que a planilha terá, e o vigia registra a data nova para achar a linha nos pedidos
  seguintes; a linha não muda de lugar na planilha: a próxima gravação de lote reordena o trecho final se for o caso), a
  placa e o motorista (com sugestões dos que já existem; placa nova recalcula o KM rodado e o KM/litro pelo abastecimento
  anterior da placa nova e acerta o próximo das duas placas; tipo de frota, modelo e ano vêm da placa nova e a matrícula vem
  do motorista), e use a lixeira no fim da linha para excluir um abastecimento (dá para desfazer até salvar; na Base_copia a
  linha é apagada e as de baixo sobem, com fórmulas, formatação condicional e filtro ajustados; o próximo da mesma placa
  passa a contar do anterior). Corrija também o
  hodômetro e o V/litro, e escolha na lista as informações adicionais 1 e 3: o KM
  rodado e o KM/litro são recalculados nesta linha e no próximo abastecimento da mesma placa e combustível, e o valor total
  (litros × V/litro) também. Desde 13/11/2026 o **valor total também é editável**: digitando o valor cobrado no cartão, o
  V/litro vira valor ÷ litros (até 4 casas). Litros ou V/litro digitados sempre refazem o valor total (antes, digitar de
  volta o V/litro da planilha voltava o valor total errado da planilha); diferença de menos de 1 centavo é ignorada. "Só os KM para conferir" mostra os hodômetros estranhos. O selo do cartão fica embaixo da
  placa; em tela estreita a tabela rola para o lado. "Salvar alterações" (no cabeçalho da tabela, ao lado de "Só os
  alterados") manda para o
  vigia, que grava nas células da Base_copia (formato mantido; planilha aberta no Excel: espera fechar; cópia antes em
  `.dados\copias-planilha\base-copia-*.xlsx`). "Correções recentes" mostra antes → depois de cada uma. A Base.xlsx não é
  alterada. Na hora: `node scripts/sincronizar.mjs --editar-base`.
- **Operação por motorista: selecionar abastecimentos:** na tabela de abastecimentos, clique numa linha e o painel
  passa a contar só ela; Ctrl+clique soma ou tira outras; Shift+clique pega um intervalo. No aviso que aparece acima dos
  números, "Todos menos os selecionados" tira esses abastecimentos da média (ficam riscados na tabela). "Limpar seleção"
  volta ao normal. A setinha no fim de cada linha mostra % tanque, R$/litro, posto, cidade, centro de custo e campanha
  (a exportação para planilha traz todas as colunas). Enquanto houver seleção e o medidor estiver fora da tela, uma barra
  no rodapé mostra a média da seleção contra a meta (km/L, meta, % da meta, litros a mais) com os mesmos botões e
  "Ver painel", que volta ao medidor.
- **Página do motorista (Minha média, /motorista/):** spec em design-system/MOTORISTA.md. Tem as senhas dos cartões e os
  postos autorizados (mesma lista da tela inicial, já na unidade do motorista), além da média, PRIME e abastecimentos.
- **Programa PRIME (Operacional):** fechamento do mês do ranking dos motoristas (regras em `design-system/PRIME.md`).
  - **Abastecimentos:** o diesel do mês na Base. "Tirar / trocar" tira do PRIME (motivo + aviso que o motorista vê) ou faz contar para outro
    motorista. O km do que sai passa para o próximo abastecimento da placa (mesmo no mês seguinte). Nada muda na Base nem na Operação.
  - **Telemetria e notas:** anexar a exportação "Pontuação resumida" da SS. A nota da telemetria vale com cobertura (km telemetria ÷ km
    abastecimentos) de 50% ou mais, ou quando não dá prêmio; senão, e para carros sem SS, a nota é manual (campo "Nota usada").
  - **Fechar mês:** só com todos os motoristas com nota; grava o resultado (o mês fechado não muda mais). Reabrir: só administrador.
  - **Ranking:** clique num motorista para ver os abastecimentos dele e tirar/colocar no PRIME ali mesmo. As colunas ordenam ao clicar.
  - **Parâmetros:** tabelas de prêmio, encarregados (adicionar e excluir) e nomes fora do ranking, gravados por mês. Na Minha média o motorista vê a nota, as
    estrelas (meses fechados) e o aviso dos abastecimentos fora do PRIME.
- **Divisão por cartão (Dashboards):** % dos litros de cada cartão nos postos externos, mês a mês e dia a dia, matriz com
  a média dos 6 meses anteriores e litros por fornecedor. Réplica da página "% Cartão" do Power BI; spec em design-system/DIVISAO-CARTOES.md.
- **Real x Orçado (Dashboards):** combustível, Arla e KM de cada filial contra o orçamento e o consumo km/L por veículo
  (réplica do `Claude\dashboard_frota.html`). O orçado vem da planilha `Banco_Orçamento_Despesas_Frota.xlsx` (pasta
  Dashboars Logística, só leitura: abas `Base_Metas` e `BD_UND`). Ele vai junto com os dados da Base: ao salvar essa
  planilha, o vigia reenvia em cerca de 1 minuto. Unidade nova no orçamento precisa estar na aba `BD_UND`, com o mesmo
  INF ADICIONAL usado nas transações. Regras completas no briefing (seção 8d).
- **Cadastro > Motoristas x cartões frota (Ticket e TruckPag):** a aba Motoristas tem as colunas MOTORISTA, UNIDADE,
  USUARIO, SENHA TICKET, SENHA TRUCKPAG, SENHA VELOE, SITUACAO, MATRICULA, CODIGO TICKET e ID TRUCKPAG. Desde 12/11/2026
  **não há CPF, data de nascimento nem CNH** (a coluna CPF virou USUARIO = 6 primeiros números; as de nascimento e CNH
  saíram: `py scripts/planilha_cadastros.py migrar-sem-cpf`, rodado uma vez). Para **motorista novo** o formulário pede o
  CPF (dá o usuário; se os 6 números já forem de outro motorista, o portal sorteia outro e avisa) e, com "Cadastrar também
  nos sites dos cartões" marcado, a data de nascimento (obrigatória) e a CNH (opcional), além das senhas Ticket e TruckPag.
  Esses dados pessoais ficam só na alteração (`alteracoes_cadastros.pessoais`) até o vigia mandar aos cartões; depois são
  apagados (e de qualquer jeito somem em 7 dias). Nunca vão para a planilha, para a lista do portal nem para o disco.
  - **Completar com a Ticket:** desligado e removido em 12/11/2026 (consultava a Ticket pelo CPF e trazia a CNH).
  - **Cadastrar nos cartões (motorista novo):** **ligado em 06/11/2026** (testado com um motorista real). Na Ticket vai com tipo de
    senha IU (informada pelo usuário; a senha Ticket é a matrícula, 6 números), Gestor responsável "GESTOR FROTA" e sem a
    validade da CNH (com ela a Ticket recusa o cadastro novo). Ligado
    (arquivo `%LOCALAPPDATA%\GestaoCombustivel\motoristas-cartoes.json` com `{"criar": true}` no computador da
    sincronização), o motorista adicionado no portal é cadastrado na Ticket (só no cliente 245364 Raja Log) e na TruckPag
    (empresa 25298), e o código/ID voltam para a planilha. Editar nos cartões: por enquanto não (decisão do usuário; a
    TruckPag não deixa consultar motoristas, então só os criados pelo portal teriam o ID).
  - **Motorista de teste:** nome começando por TESTE, FANTASMA ou MOTORISTA TESTE (ou o usuário 111444, o MOTORISTA
    TESTE usado nos ajustes da área do motorista) nunca é cadastrado nem editado nos cartões.
  - **Editar na TruckPag (ligado em 27/10/2026):** quando alguém muda no portal o nome ou a senha TruckPag de um motorista,
    depois que o vigia grava na planilha ele atualiza o mesmo motorista na TruckPag (pelo ID TruckPag). A TruckPag exige CPF
    e data de nascimento em toda edição: o formulário de edição tem o bloco "Repetir na TruckPag (opcional)" com os dois
    (não ficam guardados; apagados depois do envio). Em branco, a alteração fica só no portal e na planilha e o log do vigia
    avisa. A situação (DESLIGADO etc.) não vai para a TruckPag. Desligar: `"editar": false` em
    `%LOCALAPPDATA%\GestaoCombustivel\motoristas-cartoes.json`.
  - **Editar na Ticket:** pronto mas desligado: a Ticket recusa a alteração pela API ("motorista pertence a outro cliente";
    os motoristas estão nos clientes Raja Log e Kemigas). Perguntar ao suporte da Ticket; para religar, `"editarTicket":
    true` no mesmo arquivo motoristas-cartoes.json.
  - **ID TruckPag dos motoristas antigos:** em 27/10/2026 os 162 motoristas do cadastro receberam o ID pela exportação
    "Motoristas" da TruckPag. O script que fazia isso (`importar_ids_truckpag.mjs`, ligava pelo CPF) saiu em 12/11/2026;
    motorista que entrar na TruckPag por fora do portal: copie o ID dele (portal da TruckPag) para a coluna ID TRUCKPAG.
- **Cadastro de placas x TruckPag** (16/11/2026, `scripts/placas_truckpag.mjs`): placa editada ou adicionada no Cadastro >
  Placas com unidade, depois de gravada na planilha, tem a unidade repetida na TruckPag como **centro de custo** do veículo
  (`PUT /api/integracao-clientes/veiculo/{id}` só com `centro_custo_id`; os centros vêm de
  `GET /veiculo/centro-de-custo?empresa_id=25298`, ligados pelo nome igual ao da unidade). O vigia pega as edições em
  `/api/sync/cadastros/editados-placas` (estado `%LOCALAPPDATA%\GestaoCombustivel\placas-truckpag.json`) e escreve no log
  "Placas x TruckPag: …". Liga com `"placasUnidade": true` em motoristas-cartoes.json (ligado em 16/11/2026). Unidade sem
  centro de custo igual na TruckPag (VENDA, KEMIGAS DIRETORIA) e placa que não está na TruckPag: só avisa. Testado em
  16/11/2026 com a TZV5E39 (vazio → RAJA LOG BELEM). Conferir tudo: `node scripts/placas_truckpag.mjs conferir`; alinhar:
  `node scripts/placas_truckpag.mjs alinhar [PLACA ...] --gravar`. Ticket: sem forma documentada de alterar veículo pela
  API; Veloe: sem API.
- **Cartões frota: troca do nome da placa** (13/11/2026): uma alteração "editar" com `dados.placa` troca a placa da linha
  na aba CARTÕES sem mexer nos cartões (`planilha_cartoes.py gravar`); o histórico mostra "Placa: antiga → nova". Usado
  para passar NZP7708, PKB9742, PPB6233, PVS3551, PYX0319 e QXD7057 para o formato Mercosul (as transações já vinham assim).
- **Cadastros (Placas e Motoristas):**
  - **Placa desabilitada:** some das listas e escolhas do portal (filtro Placa dos painéis, bomba interna, Consulta de KM,
    Editar abastecimentos, aviso de cartão faltando e Cartões frota); os totais históricos continuam contando os abastecimentos dela.
  - **Planilha:** a de `CONTROLES` com "motorista" no nome (hoje `Controle_motoristas_e_placas.xlsx`), abas `Carros`
    e `Motoristas`. O script é `scripts/planilha_cadastros.py`.
  - **Publicação:** o vigia publica a lista na chave `cadastros` do KV quando a planilha muda (e ela para de mudar
    por 20 s). Para publicar na hora: `node scripts/sincronizar.mjs --cadastros`.
  - **Alterações pelo portal:** ficam na tabela `alteracoes_cadastros`. O vigia acha a linha pela placa ou pelo usuário (motoristas) e
    grava só os campos alterados. Planilha aberta no Excel: espera fechar. Antes de gravar, guarda uma cópia em
    `.dados\copias-planilha\cadastros-*.xlsx`.
  - **Cabeçalho:** se as colunas mudarem de lugar ou de nome, o vigia não grava e mostra o erro no histórico. Nesse
    caso, ajuste `ABAS` no script.
  - **Fórmulas:** PONTO CRITICO (H) e AUTON MARGEM DE SEG. (J) não são editáveis. O portal mostra o resultado das
    fórmulas `=IF(G<=0,"",G-0.5)` e `=I*G*0.75`, e uma linha nova recebe as duas.
  - **Placa desabilitada:** coluna K "SITUACAO" da aba Carros (ATIVA / DESABILITADA; vazio = ATIVA), criada pelo
    vigia na primeira gravação. Botões Desabilitar/Habilitar em cada linha.
  - **Senhas dos cartões:** aparecem mascaradas (botão "Mostrar senhas"). Depois de gravadas na planilha, saem do
    histórico do banco do portal.
  - **Acessos:** em Gerenciar acessos, cada página tem "Sem acesso", "Só consulta" ou "Consulta e edição"
    (permissões `cadastro-placas` / `cadastro-placas-editar` e `cadastro-motoristas` / `cadastro-motoristas-editar`).
- **Cartões frota (Operacional):**
  - **Planilha:** a de `CONTROLES` com "cartões" no nome (hoje `CONTROLE CARTÕES FROTA.xlsx`), aba `CARTÕES`
    (PLACA, TICKET, TRUCKPAG, VELOE). Situações: ATIVO, QUEBRADO, PERDIDO, AGUARDANDO ENVIO, ENVIO PARA BASE; célula
    vazia = sem cartão. O script é `scripts/planilha_cartoes.py`. Ele lê e grava direto no XML, só nas células
    alteradas (o resto do arquivo não muda); placa nova ganha uma linha nova no fim, com o formato da linha de cima.
    As linhas vazias formatadas até a linha 1.048.504 foram apagadas em 05/10/2026 (18,6 MB → 1,8 MB).
  - **Ligado ao cadastro de placas:** placas ativas de cavalo, truck, toco, bitruck, 3/4 e picape entram sozinhas (cartões em
    branco); desabilitar a placa, trocar para uma categoria sem cartão ou tirá-la do cadastro faz ela sair. Placa que
    nunca foi cadastrada fica com o aviso "fora do cadastro de placas" até ser cadastrada. Na hora:
    `py scripts/planilha_cartoes.py sincronizar` (com a planilha de cartões fechada).
  - **Publicação:** chave `cartoes` do KV, quando a planilha muda (e para de mudar por 20 s). Na hora:
    `node scripts/sincronizar.mjs --cartoes`.
  - **Alterações pelo portal:** tabela `alteracoes_cartoes`. Planilha aberta no Excel: espera fechar. Antes de gravar,
    cópia em `.dados\copias-planilha\cartoes-*.xlsx` (as 10 mais recentes). Placa nova entra na linha seguinte à última.
  - **Última transação:** vem dos dados da Base. A coluna FORMA DE PAGAMENTO diz o cartão: "Cartao Fisico" = Ticket,
    TRUCKPAG, VELOE. Vazia conta como Ticket só antes de 28/06/2025.
  - **Avisos dos motoristas:** botão "Falta cartão no caminhão? Avisar" na página dos postos. O aviso aparece no topo
    da página Cartões frota e como selo vermelho no menu. "Resolver" fecha o aviso; "Atualizar situação" abre a
    edição da placa com o cartão avisado já como AGUARDANDO ENVIO. Limite: 5 avisos por aparelho por hora.
  - **Acessos:** "Sem acesso", "Só consulta" ou "Consulta e edição" (`cartoes-frota` / `cartoes-frota-editar`).
- **Computador reserva (revezamento):** o vigia pode rodar em mais de um computador; só um trabalha por vez.
  - **Principal:** o de prioridade 1 (`%LOCALAPPDATA%\GestaoCombustivel\vigia.json`), hoje o Kemigas. Ele trabalha
    sempre que estiver ligado.
  - **Reserva** (prioridade 2): assume se o principal ficar 4 min sem sinal e devolve sozinho quando ele volta.
    Quem está de plantão aparece no Início da gestão.
  - **Instalar o reserva:** no outro computador, com o ownCloud sincronizando a pasta Gestão dos Abastecimentos,
    rode `scripts\instalar-vigia-reserva.cmd`. Antes: copie o `sync-token.txt` do principal por pendrive (nunca pelo
    ownCloud) e rode `npx --yes wrangler@4 login`.
  - **Erro 7403 ou "missing OAuth scopes" no log:** o login do Wrangler perdeu permissões; rode
    `npx --yes wrangler@4 login` de novo naquele computador.
- **Mudança no banco** (arquivo novo em `migrations/`): `npm run db:remoto` antes de `npm run publicar`.
- **Mudança no vigia** (`scripts/sincronizar.mjs`): publique o site antes e depois reinicie a tarefa agendada, que
  só lê o script ao iniciar:
  `schtasks /End /TN "Gestao Combustivel - sincronizar Base"` e depois `schtasks /Run /TN "Gestao Combustivel - sincronizar Base"`.

## T

- **Confirmações (04/11/2026):** toda pergunta "tem certeza?" usa a janela do próprio site (`public/gestao/lib/confirmar.js`), não a do navegador. No PRIME > Parâmetros as unidades de cada encarregado são escolhidas numa lista suspensa (marcar/desmarcar), sem digitar.

- **PRIME e Mapa de calor (04/11/2026):** no PRIME, "Tirar / trocar" com outro motorista também corrige a Base_copia (o resto do portal muda quando a Base for atualizada) e um parcial no último abastecimento do mês tira junto o 1º do mês seguinte. O motorista vê a média dele sem os abastecimentos fora do PRIME. No Mapa de calor, clicar num posto filtra a tabela de abastecimentos ao lado; o lápis na coluna Unidade troca o centro de custo do abastecimento na Base_copia (precisa do acesso de editar abastecimentos).

## Notificações: sino e configuração (05/11/2026; sino desde 18/11/2026)
- **Sino** no canto superior direito, ao lado da conta: o número vermelho é o de avisos não lidos; a lista mostra título, texto, data e hora. "Marcar como lidas" zera o número; clicar num aviso abre a tela dele. No canto da tela (aviso que salta) só aparecem os alertas de nível **crítico**.
- No celular o painel abre como gaveta pela direita e sai arrastando o dedo para a direita (como o menu); arrastar da borda direita da tela para a esquerda abre. Os avisos que saltam no canto saem arrastando para o lado.
- **Para quem (18/11/2026):** padrão do tipo (estoque: quem vê o Estoque; preço alto: quem vê algum painel de preço; falta cartão: quem vê os Cartões frota; comunicado e base desatualizada: todos), **quem tem acesso a estas telas** (marque as telas; recebe quem tiver alguma delas) ou só estes usuários. A linha "Recebem agora" mostra quem vai receber. Em qualquer opção a pessoa também precisa ter acesso aos dados do aviso (ex.: estoque baixo só chega a quem vê o Estoque).
- As regras ficam em "Configurar notificações", no rodapé do sino (a tela saiu do menu Operacional; precisa da permissão "Notificações").
- Avisos que aparecem no canto da tela para quem está no portal. Crie em "Nova notificação": tipo (estoque baixo da bomba interna, comunicado com data de início e fim, preço alto em posto externo, falta cartão avisada pelo motorista, Base desatualizada; cada tipo tem os seus campos), bases (no estoque baixo dá para marcar várias; nenhuma marcada = todas), tanque, limite em litros ou % da capacidade, nível, mensagem (use {base}, {tanque}, {volume}, {limite}, {capacidade}, {percentual}), para quem e quando volta depois de fechar no X.
- "Ver no canto da tela" mostra o aviso como vai ficar. A coluna "Agora" diz se a regra está disparando e onde. A chave "Ativa" pausa sem apagar.
- O estoque é a mesma conta da tela Estoque; quem não tem acesso ao Estoque não vê o aviso de estoque. Permissão para mexer nas regras: "Notificações" (Gerenciar acessos > Operacional).

## Dashboards > Contratos x ANP (05/11/2026)
- Os contratos ficam no banco do portal (não lê mais a planilha de reajustes). Cada contrato: unidade, estado de referência da ANP, data do contrato, produto e observação. "Adicionar contrato", lápis e lixeira na tabela (permissão "Contratos x ANP (cadastrar, editar e excluir contratos)").
- Variação = ANP do estado na semana escolhida ÷ ANP do estado na semana da data do contrato − 1. Passou de ±5%: fora da variação.

## Engrenagem dos cadastros (18/11/2026)
- Dentro do formulário de cada cadastro (placa, motorista, posto, contrato x ANP, fornecedor; cartões só consulta) a engrenagem abre
  os **cadastros do portal**: unidades, categorias de veículo, marcas, avisos de posto e produtos de contrato. São tabelas no banco
  (Supabase, esquema `cadastro`), as mesmas em todo o portal: a unidade da placa, do motorista e dos abastecimentos é o mesmo cadastro.
- Cada item tem **Editar** (renomear; na unidade também nome curto, centro de custo, empresa e operacional) e **Desativar/Reativar**
  (desativado some das listas dos formulários; quem já usa continua com ele). "Adicionar" cria um novo. Grava na hora.
- Renomear uma unidade guarda o nome antigo como apelido: planilhas e abastecimentos antigos continuam achando a unidade.
- Placa e motorista só gravam com unidade (e, na placa, categoria e marca) cadastradas; o aviso diz para cadastrar na engrenagem.
- Situação, plataforma, combustível e tipo continuam **fixos** (são usados nas contas do site).

