// Notificações no celular (26/11/2026; pedido do usuário: começar pela equipe de gestão e escolher em cada notificação se vai para
// o celular). A nuvem (Edge Function notificacoes-push, a cada 10 min) avalia as regras marcadas "Enviar também para o celular" com
// o MESMO código do sino do portal (public/gestao/lib/notificacao.js, TIPOS/avaliar) e decide o que mandar para cada aparelho.
// Copiado para supabase/functions/_shared pelo scripts/nuvem_publicar.mjs.
//
// Quando manda: na primeira vez que a ocorrência aparece para o login; depois, enquanto ela continuar valendo, conforme o "repetir"
// da regra (diaria = de novo no dia seguinte; horas:N = de novo depois de N horas; sessao = não repete). Quando a ocorrência deixa
// de valer, é esquecida (se voltar, manda de novo). estado = {'<usuario_id>|<chave>': ms do último envio}.
import { TIPOS, avaliar } from '../../public/gestao/lib/notificacao.js';
import { daUnidade } from '../../public/gestao/lib/unidades.js';

const BAHIA_MS = 3 * 3600e3;
const diaBahia = (ms) => new Date(ms - BAHIA_MS).toISOString().slice(0, 10);

export function deveEnviar(ultimo, repetir, agora) {
  if (!ultimo) return true;
  if (repetir === 'sessao' || repetir === 'nunca') return false;   // nunca: manda uma vez só (26/11/2026)
  if (repetir === 'diaria' || !repetir) return diaBahia(ultimo) !== diaBahia(agora);
  const h = Number(String(repetir).split(':')[1]) || 24;
  return agora - ultimo >= h * 3600e3;
}

// endereço que a notificação abre ao ser tocada (a tela do aviso, como o botão do sino)
export function urlDoAviso(o) {
  const acao = o.acao || (TIPOS[o.regra.tipo] && TIPOS[o.regra.tipo].acao);
  return '/gestao/' + (acao && acao.href ? acao.href : '#/');
}

// o que mandar agora.
//  regras: as ativas com celular = 1 · usuarios: [{id, recebe: [ids das regras], pode: {estoque, cartoes, dados}, bases: null | [ids]}]
//  inscricoes: [{id, usuario_id, endpoint, p256dh, auth}] · comum: {base, alertasCartao} · estoques (todas as bases) · dados (decodificado)
// -> {envios: [{inscricao, usuario_id, chave, mensagem, urgencia}], estado (novo), ocorrencias (quantas valem agora)}
export function planejar({ regras, usuarios, inscricoes, comum = {}, estoques = null, dados = null, estado = {}, agora = Date.now() }) {
  const porUsuario = new Map();
  for (const i of inscricoes) (porUsuario.get(i.usuario_id) || porUsuario.set(i.usuario_id, []).get(i.usuario_id)).push(i);
  const envios = [], novo = {};
  let ocorrencias = 0;
  for (const u of usuarios) {
    const aparelhos = porUsuario.get(u.id);
    if (!aparelhos || !aparelhos.length) continue;
    const minhas = regras.filter((r) => (u.recebe || []).includes(r.id));
    if (!minhas.length) continue;
    const ctx = {
      contexto: { base: comum.base || null, ...(u.pode && u.pode.cartoes && comum.alertasCartao ? { alertasCartao: comum.alertasCartao } : {}),
        ...(comum.alteracoesPostos ? { alteracoesPostos: comum.alteracoesPostos } : {}) },
      estoques: u.pode && u.pode.estoque && estoques ? estoques.filter((e) => !u.bases || u.bases.includes(e.base_id)) : null,
      dados: u.pode && u.pode.dados ? dados : null,
    };
    // aviso personalizado "separado por unidade": só as ocorrências das unidades da pessoa (sem unidades = todas)
    for (const o of avaliar(minhas, ctx).filter((x) => !(x.regra.condicao && x.regra.condicao.por_unidade) || daUnidade(x.unidade, u.unidades))) {
      ocorrencias++;
      const k = u.id + '|' + o.chave, ultimo = estado[k] || 0;
      if (!deveEnviar(ultimo, o.regra.repetir, agora)) { novo[k] = ultimo; continue; }
      novo[k] = agora;
      const mensagem = { titulo: o.titulo, texto: o.texto, url: urlDoAviso(o), tag: o.chave, nivel: o.regra.nivel };
      for (const inscricao of aparelhos) {
        envios.push({ inscricao, usuario_id: u.id, chave: o.chave, mensagem, urgencia: o.regra.nivel === 'critico' ? 'high' : 'normal' });
      }
    }
  }
  // "aparece uma vez só": o que já foi mandado não é esquecido quando a ocorrência some (senão voltaria a ser mandado se ela
  // voltasse); fica guardado por até 90 dias
  const nunca = new Set(regras.filter((r) => r.repetir === 'nunca').map((r) => 'r' + r.id + ':'));
  for (const [k, ms] of Object.entries(estado)) {
    if (k in novo || !(agora - ms < 90 * 864e5)) continue;
    const chave = k.slice(k.indexOf('|') + 1);
    if ([...nunca].some((p) => chave.startsWith(p) || chave === p.slice(0, -1))) novo[k] = ms;
  }
  return { envios, estado: novo, ocorrencias };
}

// o que a regra precisa carregar (só o necessário: o arquivo dos painéis tem 5 MB)
export function precisa(regras) {
  const tipos = new Set(regras.map((r) => r.tipo));
  return {
    estoque: tipos.has('estoque-baixo'),
    dados: tipos.has('estoque-baixo') || tipos.has('preco-alto') || regras.some((r) => r.tipo === 'falta-cartao' && r.condicao && r.condicao.cc) ||
      regras.some((r) => r.tipo === 'personalizado' && r.condicao && r.condicao.fonte === 'abastecimentos'),
    cartoes: tipos.has('falta-cartao'),
  };
}
