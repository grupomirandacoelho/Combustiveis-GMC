// Unidades da operação (a lista oficial da planilha "Gestão de negociações de preço", a mesma dos Postos dos motoristas) e a ligação
// com o centro de custo dos abastecimentos (RAJA LOG JEQUIE -> JEQUIE, KEMIGAS GV -> GOVERNADOR VALADARES).
// Usada no aviso personalizado "separado por unidade" (26/11/2026: cada encarregado recebe só as unidades dele, campo Unidades em
// Gerenciar acessos), no navegador, no servidor e na nuvem (sem dependências).
export const UNIDADES = ['BELEM', 'CONQUISTA', 'GOIANIA', 'GOVERNADOR VALADARES', 'ILHEUS', 'JEQUIE', 'MARANHAO',
  'RECIFE', 'SALVADOR', 'SAO PAULO', 'SERRA', 'TEIXEIRA'];
export const NOME_UNIDADE = { BELEM: 'Belém', CONQUISTA: 'Conquista', GOIANIA: 'Goiânia', 'GOVERNADOR VALADARES': 'Governador Valadares',
  ILHEUS: 'Ilhéus', JEQUIE: 'Jequié', MARANHAO: 'Maranhão', RECIFE: 'Recife', SALVADOR: 'Salvador', 'SAO PAULO': 'São Paulo',
  SERRA: 'Serra', TEIXEIRA: 'Teixeira' };
export const chaveU = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

// texto qualquer (código da unidade, nome com acento ou centro de custo) -> código da unidade ('' se não achar)
export function unidadeDe(texto) {
  const c = chaveU(texto);
  if (!c) return '';
  const exata = UNIDADES.find((u) => u === c);
  if (exata) return exata;
  const contida = UNIDADES.find((u) => c.includes(u));
  if (contida) return contida;
  return /\bGV\b/.test(c) ? 'GOVERNADOR VALADARES' : '';
}

// a ocorrência vale para quem tem estas unidades? (sem unidades no cadastro = todas)
export const daUnidade = (unidadeOcorrencia, unidadesDoLogin) =>
  !unidadesDoLogin || !unidadesDoLogin.length || unidadesDoLogin.includes(unidadeDe(unidadeOcorrencia));
