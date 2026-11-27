// Quem recebe cada notificação (18/11/2026, pedido do usuário: "quem tenha acesso a certas telas recebam certas notificações").
// Mesmo código no servidor (functions/api/notificacoes: filtra as regras de cada login) e na tela Configurar notificações
// (mostra quem vai receber). Sem dependências: recebe a lista de permissões do login (admin = todas).
//
// destinatarios de uma regra:
//   {modo: 'todos'}                -> o padrão do tipo (TELAS_PADRAO: quem tem acesso a alguma destas telas; vazio = todos)
//   {modo: 'telas', telas: [...]}  -> quem tem acesso a alguma das telas escolhidas
//   {modo: 'usuarios', ids: [...]} -> só estes usuários ("Personalizado" no formulário)
//   {modo: 'funcoes', funcoes: [...]} -> quem tem uma destas funções (perfis de acesso; 26/11/2026)
// Em qualquer modo o login também precisa conseguir verificar o aviso (DADOS_TIPO: estoque, cartões ou dados de abastecimento).

// padrão de cada tipo. Preço alto era "quem vê qualquer dado de abastecimento" e chegava até em quem só tem a Consulta de KM;
// agora é quem tem algum painel de preço.
export const TELAS_PADRAO = {
  'estoque-baixo': ['bomba-estoque'],
  'preco-alto': ['preco-postos', 'mapa-calor', 'rodada-precos', 'preco-anp', 'preco-refinaria', 'preco-fornecedor'],
  'falta-cartao': ['cartoes-frota'],
  comunicado: [],
  personalizado: [],   // aviso personalizado (26/11/2026): todos, ou as telas/usuários escolhidos
};
// o que o login precisa para o navegador conseguir verificar o tipo ('dados' = alguma tela que lê os abastecimentos)
export const DADOS_TIPO = { 'estoque-baixo': ['bomba-estoque'], 'preco-alto': 'dados', 'falta-cartao': ['cartoes-frota'] };

const algum = (perms, lista) => lista.some((p) => perms.includes(p));
// perms = permissões do login; usamDados = telas que leem os abastecimentos (lib/permissoes.js USAM_DADOS)
// aviso personalizado: depende da fonte (mudanças nos postos = qualquer login; números dos abastecimentos = quem vê os dados)
export function consegueVerificar(perms, tipo, usamDados, condicao) {
  if (tipo === 'personalizado') return !(condicao && condicao.fonte === 'abastecimentos') || algum(perms, usamDados);
  const d = DADOS_TIPO[tipo];
  if (!d) return true;
  return algum(perms, d === 'dados' ? usamDados : d);
}
export function telasDaRegra(r) {
  const d = (r && r.destinatarios) || {};
  return d.modo === 'telas' ? (d.telas || []) : (TELAS_PADRAO[r.tipo] || []);
}
// funcaoId = função (perfil de acesso) do login; null para administrador e acesso personalizado
export function recebe(perms, uid, r, usamDados, funcaoId = null) {
  const d = r.destinatarios || {};
  if (!consegueVerificar(perms, r.tipo, usamDados, r.condicao)) return false;
  if (d.modo === 'usuarios') return (d.ids || []).includes(uid);
  if (d.modo === 'funcoes') return funcaoId !== null && funcaoId !== undefined && (d.funcoes || []).includes(Number(funcaoId));
  const telas = telasDaRegra(r);
  return !telas.length || algum(perms, telas);
}

// valida o que veio do formulário: {valor} ou {erro}. validas = ids de tela conhecidos.
export function limparDestinatarios(dst, validas) {
  const d = dst || {};
  if (d.modo === 'usuarios') {
    const ids = Array.isArray(d.ids) ? [...new Set(d.ids.map(Number).filter(Number.isInteger))] : [];
    return ids.length ? { valor: { modo: 'usuarios', ids } } : { erro: 'Escolha pelo menos um usuário.' };
  }
  if (d.modo === 'funcoes') {
    const funcoes = Array.isArray(d.funcoes) ? [...new Set(d.funcoes.map(Number).filter((x) => Number.isInteger(x) && x > 0))] : [];
    return funcoes.length ? { valor: { modo: 'funcoes', funcoes } } : { erro: 'Escolha pelo menos uma função.' };
  }
  if (d.modo === 'telas') {
    const telas = Array.isArray(d.telas) ? [...new Set(d.telas.filter((t) => validas.includes(t)))] : [];
    return telas.length ? { valor: { modo: 'telas', telas } } : { erro: 'Marque pelo menos uma tela (quem tem acesso a ela recebe o aviso).' };
  }
  return { valor: { modo: 'todos' } };
}
