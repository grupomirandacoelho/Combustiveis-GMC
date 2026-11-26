// Estornos da TruckPag na nuvem (passo 4, 19/11/2026): a mesma rotina do scripts/estornos_truckpag.mjs do vigia, com as mesmas
// regras (lib/nuvem/estornos.js, copiado para _shared). Diferenças só de encaixe: a lista da Base_copia vem do banco
// (gestao_dados_gerados 'base-copia', que desde a virada de 19/11 é a origem), o estado fica em public.nuvem_rotinas e o token da
// TruckPag é segredo do Supabase. Modo 'simular': anota o que excluiria, sem mandar nada ao portal.
import { rotina, gerado, portal, env, diaLocal } from '../_shared/nuvem.ts';
import { acharNaBase, itensExclusao, serial } from '../_shared/estornos.js';

const DIAS = 35;

async function relatorio(ini: string, fim: string) {
  const r = await fetch(env('TRUCKPAG_HOST') + '/api/integracao-clientes/relatorios/analitico-transacao', {
    method: 'POST', signal: AbortSignal.timeout(120_000),
    headers: { Authorization: 'Bearer ' + env('TRUCKPAG_TOKEN'), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ data_inicial: ini, data_final: fim }),
  });
  if (!r.ok) throw new Error('TruckPag: HTTP ' + r.status);
  const j = await r.json();
  return Array.isArray(j.data) ? j.data : [];
}

rotina('estornos-truckpag', async ({ modo, estado }) => {
  const processados = ((estado.processados as unknown[]) || []).map(String);
  const feitos = new Set(processados);
  const todas = await relatorio(diaLocal(Date.now() - DIAS * 864e5), diaLocal());
  const lista = await gerado('base-copia');
  if (!lista || !lista.col) throw new Error('lista da Base_copia indisponível no banco');
  // deno-lint-ignore no-explicit-any
  const estornadas = todas.filter((t: any) => t.transacao_status === 'ESTORNADA' && t.transacao_tipo !== 'ESTORNO' && !feitos.has(String(t.transacao_id)));
  // deno-lint-ignore no-explicit-any
  const aprovadas = todas.filter((t: any) => t.transacao_status === 'APROVADA' && t.transacao_tipo !== 'ESTORNO');
  const { indices, ambiguos, semLinha, refeitas } = acharNaBase(lista, estornadas, aprovadas);
  const itens = indices.length ? itensExclusao(lista, indices) : [];
  let inseridos = null;
  if (itens.length && modo === 'ligado') inseridos = (await portal('POST', '/api/sync/base-copia/automaticas', { quem: 'Estorno TruckPag (automático)', itens })).inseridos;
  // mesmas regras do vigia para o que já foi tratado: excluídas, ambíguas e as sem linha com mais de 2 dias e meio
  // deno-lint-ignore no-explicit-any
  const velha = (t: any) => Date.now() - (serial(t.transacao_data) - 25569) * 864e5 > 2.5 * 864e5;
  // deno-lint-ignore no-explicit-any
  const novos = estornadas.filter((t: any) => !semLinha.includes(t) || velha(t)).map((t: any) => String(t.transacao_id));
  // deno-lint-ignore no-explicit-any
  const naJanela = new Set(todas.map((t: any) => String(t.transacao_id)));
  return {
    estado: { processados: [...processados.filter((x) => naJanela.has(x)), ...novos] },
    resultado: {
      lidas: todas.length, estornadas: estornadas.length, lista_versao: lista.versao,
      // deno-lint-ignore no-explicit-any
      excluir: indices.map((i: number) => ({ placa: lista.dic.placa[lista.col.placa[i]], linha: lista.col.linha[i], data: lista.col.dt[i] })),
      itens, inseridos,
      // deno-lint-ignore no-explicit-any
      ambiguos: ambiguos.map((t: any) => ({ placa: t.veiculo_placa, data: t.transacao_data, litros: t.litragem })),
      sem_linha: semLinha.length, refeitas: refeitas.length,   // canceladas que foram refeitas (26/11/2026): não apagam
    },
  };
});
