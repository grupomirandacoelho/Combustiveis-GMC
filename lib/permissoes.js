// Catálogo do que um login pode usar no portal. O id é o mesmo da rota (#/id) da gestão,
// exceto "postos-editar", que é uma ação dentro de "Postos dos motoristas".
// Administrador tem tudo e, além disso, gerencia os acessos.
export const CATALOGO = [
  { grupo: 'Dashboards', itens: [
    { id: 'operacao-motorista', rotulo: 'Operação por motorista' },
    { id: 'despesas', rotulo: 'Despesas' },
    { id: 'divisao-cartoes', rotulo: 'Divisão por cartão (% dos litros por cartão)' },
    { id: 'evolucao-placas', rotulo: 'Evolução placas' },
    { id: 'media-geral', rotulo: 'Média geral' },
    { id: 'preco-anp', rotulo: 'Preço x ANP (média de revenda)' },
    { id: 'preco-refinaria', rotulo: 'Preço x Refinaria (preço da Petrobras às distribuidoras)' },
    { id: 'contratos-anp', rotulo: 'Contratos x ANP (reajustes do cliente)', niveis: true },
    { id: 'contratos-anp-editar', rotulo: 'Contratos x ANP (cadastrar, editar e excluir contratos)', requer: 'contratos-anp', nivelDe: 'contratos-anp' },
    { id: 'real-orcado', rotulo: 'Real x Orçado (combustível, Arla, KM e consumo)', niveis: true },
    // 15.3 (25/11/2026): o orçamento continua no Excel e é enviado pela tela (substitui o orçamento inteiro no banco)
    { id: 'real-orcado-editar', rotulo: 'Real x Orçado (enviar a planilha do orçamento)', requer: 'real-orcado', nivelDe: 'real-orcado' },
  ] },
  { grupo: 'Mapas', itens: [
    { id: 'mapa-calor', rotulo: 'Mapa de calor', niveis: true },
    { id: 'mapa-calor-editar', rotulo: 'Mapa de calor (inserir coordenadas de postos na LOCALIZAÇÃO)', requer: 'mapa-calor', nivelDe: 'mapa-calor' },
    { id: 'roteirizador', rotulo: 'Roteirizador SPOT' },
  ] },
  { grupo: 'Postos', itens: [
    { id: 'postos-motoristas', rotulo: 'Ver a lista de postos dos motoristas' },
    { id: 'postos-editar', rotulo: 'Adicionar, editar, bloquear e autorizar postos', requer: 'postos-motoristas' },
    { id: 'preco-postos', rotulo: 'Preço postos externos' },
    { id: 'rodada-precos', rotulo: 'Fazer a rodada de preços' },
  ] },
  // nível de acesso: na tela de acessos cada página vira "sem acesso / só consulta / consulta e edição"
  { grupo: 'Operacional', itens: [
    { id: 'consulta-km', rotulo: 'Consulta de KM (placa, km e data)' },
    { id: 'cartoes-frota', rotulo: 'Cartões frota', niveis: true },
    { id: 'cartoes-frota-editar', rotulo: 'Cartões frota (edição)', requer: 'cartoes-frota', nivelDe: 'cartoes-frota' },
    { id: 'consolidador', rotulo: 'Consolidador de abastecimentos', niveis: true },
    { id: 'consolidador-editar', rotulo: 'Consolidador (gravar na Base_copia e relacionar postos)', requer: 'consolidador', nivelDe: 'consolidador' },
    { id: 'abastecimentos', rotulo: 'Editar abastecimentos (lista da Base_copia)', niveis: true },
    { id: 'abastecimentos-editar', rotulo: 'Editar abastecimentos (gravar correções na Base_copia)', requer: 'abastecimentos', nivelDe: 'abastecimentos' },
    { id: 'conferencia-cartoes', rotulo: 'Conferência com os cartões', niveis: true },
    { id: 'conferencia-cartoes-editar', rotulo: 'Conferência com os cartões (manter, ignorar e incluir)', requer: 'conferencia-cartoes', nivelDe: 'conferencia-cartoes' },
    { id: 'programa-prime', rotulo: 'Programa PRIME (ranking e prêmios dos motoristas)', niveis: true },
    { id: 'programa-prime-editar', rotulo: 'Programa PRIME (decidir abastecimentos, anexar a telemetria, notas e fechar o mês)', requer: 'programa-prime', nivelDe: 'programa-prime' },
    { id: 'notificacoes', rotulo: 'Notificações (criar, editar e excluir os avisos do canto da tela)' },
  ] },
  // bombas internas: estoque dos tanques, lançamento de abastecimentos, compras e preço dos fornecedores
  { grupo: 'Bomba interna', itens: [
    { id: 'bomba-estoque', rotulo: 'Estoque', niveis: true },
    { id: 'bomba-estoque-editar', rotulo: 'Estoque (adicionar e editar bases e tanques)', requer: 'bomba-estoque', nivelDe: 'bomba-estoque' },
    { id: 'bomba-abastecimento', rotulo: 'Inclusão de abastecimento (lançar na Base_copia)' },
    { id: 'bomba-movimentacoes', rotulo: 'Movimentações (compras)', niveis: true },
    { id: 'bomba-movimentacoes-editar', rotulo: 'Movimentações (lançar, editar e excluir compras)', requer: 'bomba-movimentacoes', nivelDe: 'bomba-movimentacoes' },
    // rateio das notas: quem consulta (ex.: fiscal) também marca "conferido"; a edição define onde o rateio começa
    { id: 'bomba-rateio', rotulo: 'Rateio das NFs (ver os rateios validados e marcar como conferido)', niveis: true },
    { id: 'bomba-rateio-editar', rotulo: 'Rateio das NFs (validar, corrigir centro de custo e definir o início)', requer: 'bomba-rateio', nivelDe: 'bomba-rateio' },
    { id: 'preco-fornecedor', rotulo: 'Preço bomba interna', niveis: true },
    { id: 'preco-fornecedor-editar', rotulo: 'Preço bomba interna (lançar negociações e fornecedores)', requer: 'preco-fornecedor', nivelDe: 'preco-fornecedor' },
  ] },
  // fiscal e financeiro: notas fiscais de serviço dos cartões conciliadas com as notas dos postos (APIs)
  { grupo: 'Fiscal/Financeiro', itens: [
    { id: 'fiscal-conciliacao', rotulo: 'Conciliação de NFs' },
  ] },
  { grupo: 'Cadastros', itens: [
    { id: 'cadastro-placas', rotulo: 'Placas', niveis: true },
    { id: 'cadastro-placas-editar', rotulo: 'Placas (edição)', requer: 'cadastro-placas', nivelDe: 'cadastro-placas' },
    { id: 'cadastro-motoristas', rotulo: 'Motoristas', niveis: true },
    { id: 'cadastro-motoristas-editar', rotulo: 'Motoristas (edição)', requer: 'cadastro-motoristas', nivelDe: 'cadastro-motoristas' },
  ] },
];
export const TODAS = CATALOGO.flatMap((g) => g.itens.map((i) => i.id));
const REQUER = Object.fromEntries(CATALOGO.flatMap((g) => g.itens.filter((i) => i.requer).map((i) => [i.id, i.requer])));

// páginas que usam o arquivo de abastecimentos (/gestao/dados/...)
export const USAM_DADOS = ['operacao-motorista', 'despesas', 'divisao-cartoes', 'evolucao-placas', 'media-geral', 'preco-fornecedor',
  'preco-postos', 'preco-anp', 'preco-refinaria', 'contratos-anp', 'consulta-km', 'mapa-calor', 'roteirizador', 'rodada-precos',
  'cartoes-frota', 'real-orcado', 'programa-prime', 'notificacoes', 'consolidador', 'abastecimentos', 'postos-editar', 'bomba-estoque', 'bomba-abastecimento'];   // bomba: saídas do estoque e histórico para lançar abastecimentos   // postos-editar: o "Adicionar posto" sugere os postos já negociados   // consolidador: lê /gestao/dados/consolidacao.json   // cartões frota: última transação de cada cartão vem dos abastecimentos   // abastecimentos: lê /gestao/dados/base-copia.json

// lista guardada no banco -> lista válida (ids conhecidos, sem repetição, dependências respeitadas)
export function limparPermissoes(lista) {
  const s = new Set((Array.isArray(lista) ? lista : []).filter((p) => TODAS.includes(p)));
  for (const [p, r] of Object.entries(REQUER)) if (s.has(p)) s.add(r);   // editar inclui ver
  return TODAS.filter((p) => s.has(p));
}

// administrador: tudo; com função: as permissões da função (mudam junto quando a função é editada);
// sem função: a lista personalizada do próprio login
export function permissoesDe(u) {
  if (!u) return [];
  if (u.papel === 'admin') return [...TODAS];
  const lista = u.funcao_id && u.funcao_permissoes !== null && u.funcao_permissoes !== undefined ? u.funcao_permissoes : u.permissoes;
  try { return limparPermissoes(JSON.parse(lista || '[]')); } catch { return []; }
}

export function pode(u, ...perms) {
  if (!u) return false;
  if (u.papel === 'admin') return true;
  const minhas = permissoesDe(u);
  return perms.some((p) => minhas.includes(p));
}
