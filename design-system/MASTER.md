# Design system — Gestão de combustível (v2, 28/10/2026)

Refeito do zero a partir do Figma "SaaS – Sales Management Dashboard – Muvic" (layout **Blacksale**, arquivo
`qj5OCaZoEK7zBXSOn7omoQ`, frame `Dashboard_Custom` 11:8817) e do protótipo `prototipos/design-muvic`. O design
anterior ("mostrador da bomba", seções soltas com linha fina, Overpass) foi descartado. As funções, dados, filtros e
APIs são os mesmos; mudam o shell, a composição das telas, os componentes e a página dos motoristas.

---

## Handoff Spec: Portal da gestão (`/gestao/`)

### Overview
Portal interno da equipe de combustível (desktop no escritório; celular para consulta rápida). Cada tela é um
**painel de cartões em faixas**, como o Overview do Figma: indicadores no topo, gráfico com um cartão lateral,
tabela com um cartão lateral. Escuro por padrão; claro no interruptor do menu.

### Layout
| Região | Medida | Regra |
|---|---|---|
| Menu lateral (Drawer) | 249 px; recolhido 76 px | `--lateral`, respiro 20/15 px, blocos separados por 15 px: logotipo → grupos → rodapé fixo (tema, sair). Compacto desde 19/11/2026: telas 32 px (texto 13,5, ícone 16) com 2 px entre elas; grupos como rótulo 12/600 maiúsculo cinza (`--suave`), 28 px, 10 px entre grupos; grupo fechado não deixa espaço. Celular: telas 40 px e grupos 34 px (toque) |
| Barra superior (Header_Navigation) | altura 88 px, respiro 25 px | título 20/600 à esquerda (grupo do menu acima, 12/500 laranja); à direita, 25 px entre itens: **Buscar página**, botão Atualizar (só ícone 38 px), ação laranja |
| Conteúdo | grade de **12 colunas**, espaço 25 px, respiro 25 px | cada filho direto da página é uma faixa; os cartões ocupam colunas (ver "Composição") |
| Celular (< 820 px) | 1 coluna, respiros 16 px | menu vira gaveta; busca vira linha própria; tabelas largas rolam dentro do cartão |

**Composição das telas (grade de 12):**
| Faixa | Conteúdo | Colunas |
|---|---|---|
| Filtros | cartão com os filtros da tela | 12 |
| Indicadores (Graph_1) | 3 ou mais cartões KPI (`.bomba-registros` → `.kpi`) | 12, cartões em `auto-fit minmax(250px)` |
| Análise (Graph_2) | medidor / resumo em coluna (`.meta-bloco`, `.apoio-coluna`) + números de apoio (`.apoio`) | 4 + 8 |
| Gráfico + lateral | `.grade-paineis`: gráfico + ranking/lista | 8 + 4 |
| Tabela | `.painel-tabela` | 12 |

### Identidade visual (Grupo Miranda Coelho, desde 18/11/2026)
- Cores da marca: **laranja `#F6A42B`** (`--gmc-laranja`, cor principal; o código recebido era F6542B e o usuário confirmou o F6A42B,
  igual ao laranja da logo), **preto `#4B4B4D`** (`--gmc-preto`) e **cinza `#97989A`** (`--gmc-cinza`). Os tokens de uso abaixo
  apontam para eles; trocar a cor da marca = mudar só os três `--gmc-*` em `gestao.css` e `app.css`.
- Logos em `public/` (variante monocromática escolhida pelo usuário em 18/11/2026): `logo-grupo.png` (com o nome, preta #4B4B4D,
  fundo claro), `logo-grupo-negativo.png` (branca, fundo escuro), `logo-simbolo.png` / `logo-simbolo-negativo.png` (só o símbolo:
  menu recolhido). Ícone do aplicativo e do site: `icon-192.png` / `icon-512.png` (símbolo branco em fundo #161616). No tema escuro usar a negativa: classes `.so-escuro` / `.so-claro`.
- Menu aberto: logo com o nome em toda a largura livre (até 176 px, proporção mantida; ~151×29 px). Menu recolhido: só o símbolo, 40 px. Barra das páginas dos motoristas e da troca
  de senha: logo negativa com 30 px (24 px até 420 px de largura), separada do título por uma linha.
- Texto sobre o laranja é escuro (`#161616`, 8,8:1): o branco sobre o laranja tem só 2:1.
- Verde e vermelho continuam com o significado de bom/ruim (pílulas, medidor, variação, economia do PRIME); o laranja não é "bom".

### Design Tokens
| Token | Escuro | Claro | Uso |
|---|---|---|---|
| `--gmc-laranja` / `--gmc-preto` / `--gmc-cinza` | `#F6A42B` / `#4B4B4D` / `#97989A` | iguais | cores da marca (base dos tokens abaixo) |
| `--fundo` | `#161616` | `#F5F5F5` | fundo do conteúdo e da barra (Black 2) |
| `--lateral` | `#121212` | `#FFFFFF` | menu (Black 1) |
| `--cartao` | `#262626` | `#FFFFFF` | todos os cartões, diálogos, menus suspensos |
| `--cartao-2` | `#2E2E2E` | `#F0F0F1` | passar o mouse, linha selecionada, campo dentro de cartão |
| `--texto` / `--texto-2` / `--suave` | `#FFF` / `#D0D0D0` / `#97989A` | `#161616` / `#4B4B4D` / `#66676A` | texto; `--suave` só em rótulos de eixo e notas |
| `--borda` / `--borda-forte` | `#333333` / `#4B4B4D` | `#E4E4E5` / `#CBCCCE` | linhas de tabela, divisórias |
| `--contorno` | `rgba(255,255,255,.85)` | `rgba(22,22,22,.35)` | contorno de campos e botões secundários (Figma: branco 1 px) |
| `--primaria` | `#F6A42B` | `#F6A42B` | ação principal, item ativo, bordas e destaques (era `--verde` até 17/11/2026) |
| `--primaria-texto` | `#F6A42B` | `#9E5A00` | texto e links na cor da marca (no claro, laranja escuro: 5,4:1 no branco) |
| `--sobre-primaria` | `#161616` | `#161616` | texto em cima do laranja (8,8:1) |
| `--primaria-suave` | `rgba(246,164,43,.16)` | `rgba(246,164,43,.14)` | fundo de seleção e destaque leve |
| `--serie-1` | `#F6A42B` | `#C77A0A` | série principal dos gráficos (no claro mais escura: 3,4:1 no branco) |
| `--sobe` / `--desce` | `#2EA41B` / `#FF5A5A` | `#1C7C10` / `#C62828` | variação favorável / desfavorável |
| `--pilula-ok` / `-alerta` / `-ruim` | `#3DBF4A` / `#F6C25E` / `#F92F2F` | iguais | Complete / On Delivery / Canceled |
| `--selo` | `#BC7C01` | igual | contadores do menu, rótulo de destaque do gráfico |
| `--ic-laranja` / `--ic-roxo` / `--ic-areia` / `--ic-rosa` | `#FCDCAA` / `#C4C3E9` / `#E9E1C3` / `#EBCACA` | iguais | quadrados de ícone dos KPIs e listas (`--ic-verde` `#CBECD8` só para "caiu = bom") |
| `--vao` / `--recheio` / `--recheio-filtros` / `--reg-icone` | 16 px / 18 20 px / 12 20 px / 52 px | iguais | densidade (18/11/2026): vão entre cartões, recheio dos cartões e dos filtros, ícone dos indicadores |
| `--r` / `--r-icone` / `--r-pilula` | 5 / 15 / 25 px | | cantos |
| `--e-1…5` | 5 / 10 / 15 / 20 / 25 px | | espaços |
| Tipo | Plus Jakarta Sans | | 12/500 rótulos · 14/500 texto e títulos de cartão · 16/600 grupos do menu · 20/600 título da página · 24/500 números |

### Components
| Componente | Classe | Anatomia | Notas |
|---|---|---|---|
| Cartão | `.cartao`, `.painel`, `.filtros`, `.meta-bloco` | fundo `--cartao`, canto 5, respiro 25, cabeçalho 32 px (título 14/500 + ação à direita) | sem borda nem sombra no escuro |
| KPI (Total Revenue) | `.kpi` (gerado por `htmlBomba`) | quadrado `--reg-icone` (52 px) canto 15 com ícone 28 px · rótulo 14/500 + ⓘ · número 24/500 · variação 10/500 "vs. mês anterior" | a cor do quadrado segue a ordem laranja → roxo → areia → rosa |
| Linha de lista (Top Selling) | `.linha-lista` | mini-ícone 46 px · nome 14/600 + detalhe 12 · valor/pílula à direita | início (categorias), motoristas (unidades) |
| Medidor | `htmlMedidor` | meio círculo 14 px de traço, marca da meta, número 24/500 no centro | verde ≥ meta, âmbar até 5% abaixo, vermelho abaixo disso |
| Pílula | `.status`, `.sit-*`, `.selo-*` | 10–12/600, canto 25, 2×9 px | sempre com texto; o ícone ↑↓ continua |
| Tabela (Top Transactions) | `table.dados` | cabeçalho 12/500 sem fundo; linhas 13 px com borda superior `--borda`; passar o mouse `--cartao-2` | cabeçalho preso ao rolar |
| Gráfico (General Sale Activity) | `graficoPeriodo` | linha `--serie-1` (laranja) 2,5 suave, sem grade cheia (tracejada), faixa de destaque 26 px no ponto, dica escura | rótulos de eixo 12 `--suave` |
| Botão | `.btn` / `.btn-principal` / `.btn-icone` | 38 px (44 px no celular ≤ 600 px); contorno `--contorno`; principal laranja (texto escuro) | |
| Campo | inputs, `.filtro-botao` | 38 px (44 px no celular ≤ 600 px), contorno `--contorno`, canto 5 | foco: contorno laranja |
| Busca de página | `#busca-pagina` | campo 174 px com lupa; lista suspensa com as páginas do menu | Enter abre a primeira; ↑↓ navegam |
| Ações da linha | `lib/acoes-linha.js` | botão "⋯" 32 px; linha com Editar abre ao clicar | |
| Baixar | `lib/baixar.js` | botão com ícone, menu CSV / XLSX | |

### States and Interactions
| Elemento | Estado | Comportamento |
|---|---|---|
| Item do menu | ativo | fundo `--cartao`, ícone laranja |
| Item do menu | passar o mouse | fundo `#1C1C1C` |
| Cartão-link (KPI, início) | passar o mouse | contorno 1 px laranja (Figma: atalhos) |
| Botão | passar o mouse / foco | fundo `--cartao-2` / contorno de foco 3 px `--foco` |
| Botão Atualizar | dados novos | ponto âmbar no canto; girando enquanto atualiza |
| Busca de página | sem resultado | "Nenhuma página com esse nome" |
| Tabela | linha clicável | cursor de mão; Enter abre |
| Gráfico | ponto apontado | faixa vertical + dica escura; setas do teclado percorrem |

### Responsive Behavior
| Largura | Mudanças |
|---|---|
| > 1100 px | grade de 12 completa |
| 820–1100 px | faixas 4+8 e 8+4 viram 12; KPIs em 2 colunas |
| < 820 px | menu em gaveta; barra quebra em 2 linhas (título / busca + ações); KPIs em 1 coluna; Conciliação vira cartões |

### Edge Cases
- **Vazio**: texto `--suave` dentro do cartão, nunca cartão sumindo sem aviso.
- **Carregando**: anel girando laranja no centro do cartão.
- **Erro**: faixa vermelha suave com o texto do erro.
- **Número grande**: KPI encolhe até 18 px e quebra; nunca é cortado.
- **Nome longo**: quebra linha em tabelas (`.trunc`), reticências só no menu.

### Animation / Motion
| Elemento | Gatilho | Animação | Duração | Easing |
|---|---|---|---|---|
| Medidor | desenho | arco cresce (stroke-dasharray) | 500 ms | cubic-bezier(.2,.8,.2,1) |
| Interruptor de tema | clique | bolinha desliza | 180 ms | ease |
| Gaveta do menu (celular) | abrir | translateX | 220 ms | ease |
`prefers-reduced-motion` desliga tudo.

### Accessibility Notes
- Ordem do foco: pular para o conteúdo → menu → busca → ações → filtros → cartões.
- Busca: `role="combobox"`, lista `role="listbox"`, `aria-activedescendant`.
- Interruptor de tema `role="switch"`; ações da linha `aria-label="Ações da linha"`.
- Status nunca só pela cor (pílula com texto + ícone ↑↓).

---

## Tela de login (`/`, desde 26/11/2026)
Implantada do protótipo `prototipos/login-v2` (spec completa em `prototipos/login-v2/HANDOFF.md`; base Figma "Login Page Perfect
UI"): foto do caminhão + painel de 456 px no computador (tela fixa, sem rolagem), sem foto no celular (≤ 900 px). Um login para
todos (motorista com o usuário de 6 números → `/motorista/`; gestão → `/gestao/`), "Falta cartão no caminhão?" sem login.
Arquivos: `public/index.html`, `public/login.css` (tokens do protótipo; a janela do cartão usa classes `ac-*`), `public/app.js`,
`functions/index.js` (quem já está conectado vai direto para a área dele). Os postos autorizados saíram da página pública: ficam na
área do motorista e `/postos.csv` exige login.

## Handoff Spec: Página dos motoristas (antes de 26/11/2026 em `/`), Minha média (`/motorista/`) e Trocar senha

### Overview
Usada no celular, na estrada. Agora é um mini-painel no mesmo visual: barra escura, **3 KPIs** (unidades, postos
autorizados, bandeiras de cartão), aviso de cartão em cartão de destaque, **unidades em grade de cartões** com
mini-ícone, e **postos em cartões de lista** (nome, cidade, pílula do cartão, aviso em pílula âmbar, botão de mapa).

### Layout
| Região | Medida | Regra |
|---|---|---|
| Barra | 64 px, `--lateral` | logotipo 30 px, título 20/600, botão "Entrar"/"Gestão" com contorno |
| Conteúdo | máx. 960 px, respiro 16 (celular) / 25 (≥ 760 px), espaço 15/25 | KPIs → busca → aviso de cartão → unidades / postos |
| Unidades | grade `auto-fill minmax(220px)` | cartão 46 px de ícone + nome 16/600 + "N postos" |
| Postos | grade `auto-fill minmax(300px)` | cartão com cabeçalho (ícone + nome + cidade), pílula do cartão, aviso, botão laranja "Abrir no mapa" |

Minha média: KPIs (média, meta, economia) + medidor em meio círculo + listas em cartões. Trocar senha: um cartão central.

---

## Revisão de 29/10/2026 (crítica de design)

- Texto nunca abaixo de 12 px (exceto o contador do menu recolhido e os números dentro dos círculos do roteirizador).
- `--suave` no tema escuro: #9A9A9A (o #8C8C8C ficava no limite do AA).
- Cabeçalho: título, ações da página, "Buscar página" e a conta sempre na ponta direita.
- Filtros: visíveis Período, Placa e Estabelecimento (prioridade em criarFiltros); os outros atrás de "Mais filtros (n)" em todas as telas.
  Etiquetas: uma por filtro ("Combustível: DIESEL +3").
- Números: "R$ 1.234,56" (R$ antes); preço "6,525 R$/L" (3 casas). Linha de apoio com 5 números cabe numa linha (min 96 px).
- Tabelas: o título da coluna quebra linha; em 1366 px nenhuma rola para o lado. Quando não cabe, juntar colunas (cidade embaixo do
  nome, orçado embaixo do real) ou virar cartão (container query) antes de aceitar rolagem. Listas longas: "Mostrar mais".
- Cartões (Ticket, TruckPag…): sempre `seloCartao` de lib/cartoes.js. Janelas: X no canto e botões presos no rodapé (automático).
- Ícones dos cartões de número: `r.ico` (preco, mercado, comparar, sobe, desce) quando não são valor/litros/preço.
- Tabelas em cartão estreito: colunas de apoio com .col-opc1/.col-opc2 dentro de .conter somem (container query) em
  vez de rolar para o lado. Tabelas largas de trabalho: colunas de identificação presas à esquerda (Editar) e ações
  presas à direita (Conferência); no celular a Conferência vira cartões.
- Gráficos: período em andamento (ultimoParcial) tracejado e fora das médias.
- Telas de trabalho: números de apoio em faixa fina (`.apoio-topo`); ações em lote e Salvar/Descartar no cabeçalho da tabela.
- Tabelas de edição: larguras mínimas em px; em tela estreita rolam para o lado em vez de cortar o conteúdo.
- Número negativo com nome positivo não pode: "Economia" negativa vira "Litros gastos a mais" com o valor positivo.
- Rota inexistente mostra "Página não encontrada".

### Área dos motoristas (revisão de 29/10/2026)
- Texto mínimo de 14 px (celular, na rua); botões de 44 px; `--suave` #9A9A9A, igual à gestão.
- Página dos postos: sem números de resumo no topo; posto compacto com o mapa como ícone; o laranja fica para os avisos importantes.
- Nome dos cartões igual ao do portal (Ticket, TruckPag, Veloe).
- Ícones: fundo escuro translúcido (`--ic-*` em rgba ~16%) com traço claro, nunca pastel claro — o modo escuro forçado do
  celular escurece cores claras e deixa os quadradinhos com cor de lama. As páginas declaram `color-scheme: dark` (CSS e meta).
- Lista de unidades: um estilo só (pino laranja); cor alternada sem significado não entra.
- Minha média: o medidor é o destaque; cada abastecimento mostra ✓ (na meta) ou ↓ (abaixo), com texto para leitor de tela.

### % da meta (29/10/2026)
- 4 faixas, a mesma regra no portal e na área dos motoristas: **100%+** verde (#3DBF4A) · **95% a 100%** verde-claro
  (#A6CF3F) · **90% a 95%** amarelo (#F6C25E) · **menos de 90%** vermelho (#F92F2F). Abaixo de 100% não é "ruim":
  quanto mais perto de 100%, melhor. Sempre com o número escrito (e seta nas pílulas), nunca só a cor.
- Código: `faixaMeta(p)` / `metaHtml(p, texto)` / `legendaMeta()` em `public/gestao/lib/filtros.js`.

## Regras que continuam
- Filtros de todas as páginas saem de `public/gestao/lib/filtros.js` e ficam no endereço da página.
- Layout responde à largura do conteúdo (container queries) e da tela.
- Números com algarismos tabulares; status com ícone + texto; alvos ≥ 32 px (≥ 44 px no celular dos motoristas).

## Ícones (03/11/2026)
Biblioteca **Phosphor Icons 2.1, peso Regular** (Figma "Phosphor Icons (Community)"; SVGs do pacote `@phosphor-icons/core`).
Todos com `viewBox="0 0 256 256"` e `fill="currentColor"` (a cor vem do texto). Ícone novo: copie o `<path>` de
`assets/regular/<nome>.svg` para um `<symbol id="i-…">` no sprite de `public/gestao/index.html` e use `<svg><use href="#i-…"/></svg>`.

| id | Phosphor | | id | Phosphor | | id | Phosphor |
|---|---|---|---|---|---|---|---|
| i-inicio | house | | i-media | gauge | | i-alerta | warning |
| i-motorista | steering-wheel | | i-etiqueta | tag | | i-olho | eye |
| i-senha | lock | | i-rodada | list-checks | | i-refinaria | factory |
| i-postos | gas-pump | | i-usuarios | users | | i-lixeira | trash |
| i-tema | moon | | i-rota | path | | i-tanque | cylinder |
| i-sair | sign-out | | i-km | road-horizon | | i-bomba | gas-can |
| i-recolher | caret-left | | i-contrato | file-text | | i-nota | receipt |
| i-menu | list | | i-anp | chart-line-up | | i-rateio | chart-pie-slice |
| i-apresentar | presentation | | i-caminhao | truck | | i-movimento | arrows-down-up |
| i-sair-apres / i-x | x | | i-cracha | identification-card | | i-lapis | pencil-simple |
| i-seta | caret-down | | i-consolidar | stack | | i-estrela | star |
| i-cima / i-baixo | arrow-up / arrow-down | | i-orcado | target | | i-busca | magnifying-glass |
| i-despesas | wallet | | i-cartao | credit-card | | i-info | info |
| i-preco | chart-bar | | i-conferir | clipboard-text | | i-pontos | dots-three |
| i-mapa | map-pin | | i-atualizar | arrows-clockwise | | i-mais | plus |
| i-baixar | download-simple | | i-evolucao | table | | | |

Cartões de números (`--ico-*`): dinheiro = money, gota = drop, etiqueta = tag, grafico = chart-line-up, caminhao = truck,
balanca = scales, sobe/desce = arrow-up/arrow-down. App dos motoristas (peso **Duotone**, miolo com 45% de opacidade em vez dos 20% padrão, assets/duotone/<nome>-duotone.svg): cartao = credit-card, local = map-pin, posto = gas-pump;
botão de mapa de cada posto = navigation-arrow; "Falta cartão no caminhão? Avisar" = bell-ringing.


## Excluir / remover (04/11/2026)
Sempre a lixeira: `<button class="btn-lixeira" aria-label="Excluir ..." title="Excluir ..."><svg aria-hidden="true"><use href="#i-lixeira"/></svg></button>` (gestao.css: .btn-lixeira = .ea-excluir). Nunca botão de texto "Excluir" ou "Remover" nas tabelas.

**Confirmação:** nunca `confirm()` do navegador. Usar `if (!(await confirmar('Excluir …?'))) return;` (`lib/confirmar.js`, global): janela `dialog.dialogo.dialogo-confirmar` com Cancelar + ação; texto começando com Excluir/Remover/Descartar/Desfazer = título "Confirmar exclusão", botão `.btn-perigo` com o verbo e foco no Cancelar; demais = "Confirmar" (`.btn-principal`). Quebras de linha do texto são mantidas.

**Correção na Base_copia a partir de outra tela** (motorista no PRIME, unidade no Mapa de calor): `lib/base-copia.js` (`corrigirNaBaseCopia(l, col, valor)` acha a linha pela placa + dia + hodômetro e manda pela fila do Editar abastecimentos). O lápis da linha é `.btn-lixeira.btn-editar` com `#i-lapis`; a linha mostra o valor novo com "aguardando gravação na Base_copia · era X" até a Base ser atualizada.

**Seleção múltipla em formulário** (ex.: unidades dos encarregados no PRIME): botão `.filtro-botao` + painel `.painel-filtro` com busca e `.opcao[role=checkbox]` (o mesmo dos filtros), valor num `input hidden` e chips `.pr-chip` das escolhidas embaixo. Nunca campo de texto separado por vírgula.

**Notificação no canto (toast):** `mostrarNotificacao({chave, titulo, texto, nivel, acao, aoFechar, sozinha})` em `lib/notificacao.js`. Canto inferior direito, 380 px (celular: 12 px das bordas), borda esquerda de 4 px na cor do nível (info `--primaria`, alerta `--pilula-alerta`, crítico `--pilula-ruim`), ícone 20 px, título 14/600, texto 13 `--texto-2`, X 30 px (40 no celular). Entrada: desliza 28 px da direita + aparece, 260 ms cubic-bezier(.2,.8,.2,1); saída 180 ms ease-in; movimento reduzido: só esmaece (120 ms). Crítico = role alert; os outros = status. Mesma chave atualiza o aviso; máximo 3 na tela. Não usar para confirmação de ação (isso é o `aviso()` do gestao.js).


## Cores dos cartões (padrão do portal, lib/cartoes.js)
Ticket #2F7D32 · TruckPag #278187 · Veloe #4B2E83 · **Vibra #9DC3E6 com texto #11283d** (09/11/2026) · Identificação #1D4E9B · Bomba interna #7A5C12 · sem informação #5F6663. Selos e gráficos usam sempre corCartao/corTextoCartao.

## Tabelas novas: sempre ordenáveis (11/11/2026)
Pedido do usuário: toda tabela nova classifica por coluna, como as outras. Usar `public/gestao/lib/tabela.js`
(`tabelaOrdenavel(tabela, {colunas, padrao, vazio, classeLinha})`): clique no cabeçalho ordena, de novo inverte, ▲/▼ e
`aria-sort`, vazios no fim, texto em ordem do português, total no `<tfoot>` fora da ordenação. Coluna sem ordenação: `v: null`.
Faixas de indicadores com valores longos ou texto de apoio: `.apoio.apoio-pilha` (rótulo em cima, número embaixo).

## Gestos no celular (18/11/2026)
- Menu: arrastar da metade esquerda para a direita abre; arrastar para a esquerda fecha (`gestao.js`).
- Notificações (sino): gaveta pela direita (`.sino-painel` fixo, 88vw até 380 px, fundo escurecido); arrastar para a direita fecha;
  arrastar da borda direita (28 px) para a esquerda abre. Avisos do canto: arrastar para qualquer lado fecha (como o X), esmaecendo.
- Regra comum (`lib/gesto.js`): começa com 12 px na horizontal e 1,5× mais horizontal que vertical; sai com 30% da largura ou
  arrasto rápido (> 0,5 px/ms); senão volta ao lugar. `data-sem-gesto` desliga o gesto do menu dentro de um elemento.

## Densidade e dobra (18/11/2026)
- Meta: em 1440×900, filtros + indicadores + resumo/medidor + o 1º gráfico de cada painel aparecem sem rolar.
- Vão entre cartões `--vao` 16 px; recheio dos cartões `--recheio` 18/20 px; filtros `--recheio-filtros` 12/20 px; barra do título 16/10 px.
- Indicador: ícone 52 px, recheio 14/18 px, 4 px entre rótulo e número. Medidor até 210 px. Gráfico de período 220 px de altura.
- Em tela larga (≥ 1101 px) os grupos de filtro ficam lado a lado, separados por uma linha vertical; abaixo disso, empilhados.
- Tela nova: usar os blocos e tokens existentes; não voltar a `var(--e-5)` para recheio ou vão de cartão.
