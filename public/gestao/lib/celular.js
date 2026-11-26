// Notificações no celular (26/11/2026; pedido do usuário: começar pela equipe de gestão). Bloco "No celular" do sino: ativa, testa e
// desativa as notificações NESTE aparelho (inscrição Web Push do navegador, guardada pelo portal em /api/push). Quem manda é a nuvem
// (Edge Function notificacoes-push), só as notificações marcadas "Enviar também para o celular" em Configurar notificações.
// iPhone: só funciona com o portal adicionado à Tela de Início (iOS 16.4 ou mais novo) e aberto por lá.
import { esc } from './dados.js';

const iOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const instalado = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export function suporte() {
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return 'ok';
  return iOS() && !instalado() ? 'ios-instalar' : 'nao';
}
function deB64url(t) {
  const s = t.replace(/-/g, '+').replace(/_/g, '/'), bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
// descrição curta para a pessoa reconhecer o aparelho na lista
export function descreverAparelho(ua = navigator.userAgent) {
  const so = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Aparelho';
  const nav = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return nav && !/^(iPhone|iPad)$/.test(so) ? so + ' · ' + nav : so;
}
async function api(corpo) {
  const r = await fetch('/api/push', { method: corpo ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: corpo ? { 'Content-Type': 'application/json' } : undefined, body: corpo ? JSON.stringify(corpo) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Não foi possível falar com o servidor (' + r.status + ').');
  return j;
}
const inscricaoAtual = async () => { const reg = await navigator.serviceWorker.getRegistration('/'); return reg ? reg.pushManager.getSubscription() : null; };

// estado deste aparelho: {suporte, chave, permissao, ativo, aparelhos, endpoint}
async function estado() {
  const s = suporte();
  if (s !== 'ok') return { suporte: s };
  const [srv, sub] = await Promise.all([api(), inscricaoAtual().catch(() => null)]);
  const ativo = !!(sub && srv.aparelhos.some((a) => a.endpoint === sub.endpoint)) && Notification.permission === 'granted';
  return { suporte: s, chave: srv.chave, permissao: Notification.permission, ativo, aparelhos: srv.aparelhos, endpoint: sub ? sub.endpoint : null };
}

// chamado direto do clique (o iPhone só pede a permissão a partir de um toque)
async function ativar(chave) {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new Error(perm === 'denied' ? 'As notificações foram bloqueadas. Libere nas configurações do aparelho para este site e tente de novo.' : 'Permissão não concedida.');
  }
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // inscrição feita com outra chave (o servidor trocou a chave): refaz
  if (sub && sub.options && sub.options.applicationServerKey) {
    const atual = new Uint8Array(sub.options.applicationServerKey), nova = deB64url(chave);
    if (atual.length !== nova.length || atual.some((b, i) => b !== nova[i])) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: deB64url(chave) });
  await api({ acao: 'inscrever', inscricao: sub.toJSON(), aparelho: descreverAparelho() });
}
async function desativar() {
  const sub = await inscricaoAtual();
  if (!sub) return;
  await api({ acao: 'cancelar', endpoint: sub.endpoint });
  await sub.unsubscribe().catch(() => {});
}
async function testar() {
  const sub = await inscricaoAtual();
  if (!sub) throw new Error('Este aparelho não está com as notificações ativadas.');
  await api({ acao: 'testar', endpoint: sub.endpoint });
}

// desenha o bloco dentro do sino
export async function montarCelular(el) {
  if (!el) return;
  const msg = (t, erro) => { const p = el.querySelector('.cel-msg'); if (p) { p.textContent = t || ''; p.classList.toggle('erro', !!erro); } };
  let e;
  try { e = await estado(); } catch { el.hidden = true; return; }
  if (e.suporte === 'ok' && !e.chave) { el.hidden = true; return; }   // ainda não configurado no servidor
  el.hidden = false;
  const titulo = '<strong>No celular</strong>';
  if (e.suporte === 'ios-instalar') {
    el.innerHTML = titulo + '<p>No iPhone, as notificações só chegam com o portal na Tela de Início: no Safari, toque em Compartilhar e em ' +
      '<b>Adicionar à Tela de Início</b>, abra o portal pelo ícone e ative aqui.</p>';
    return;
  }
  if (e.suporte === 'nao') { el.innerHTML = titulo + '<p>Este navegador não recebe notificações. No celular, use o Chrome (Android) ou o Safari (iPhone).</p>'; return; }
  if (e.permissao === 'denied') {
    el.innerHTML = titulo + '<p>As notificações estão bloqueadas para este site. Libere nas configurações do navegador ou do aparelho e abra o sino de novo.</p>';
    return;
  }
  const outros = e.aparelhos.filter((a) => a.endpoint !== e.endpoint || !e.ativo);
  el.innerHTML = titulo + (e.ativo
    ? '<p>Ativadas neste aparelho. Chegam aqui os avisos marcados para o celular.</p><div class="cel-acoes">' +
      '<button type="button" class="btn" data-cel="testar">Enviar teste</button><button type="button" class="link-acao" data-cel="desativar">Desativar</button></div>'
    : '<p>Receba neste aparelho os avisos marcados para o celular, mesmo com o portal fechado.</p><div class="cel-acoes">' +
      '<button type="button" class="btn btn-principal" data-cel="ativar">Ativar neste aparelho</button></div>') +
    (outros.length ? '<small>Também ativadas em: ' + esc(outros.map((a) => a.aparelho || 'aparelho').slice(0, 4).join(', ')) +
      (outros.length > 4 ? ' e mais ' + (outros.length - 4) : '') + '.</small>' : '') +
    '<p class="cel-msg" role="status"></p>';
  el.onclick = async (ev) => {
    const b = ev.target.closest('[data-cel]');
    if (!b) return;
    const acao = b.dataset.cel;
    b.disabled = true;
    try {
      if (acao === 'ativar') { await ativar(e.chave); await montarCelular(el); msg('Pronto. Use "Enviar teste" para conferir.'); return; }
      if (acao === 'testar') { await testar(); msg('Teste enviado. Deve chegar em alguns segundos.'); }
      if (acao === 'desativar') { await desativar(); await montarCelular(el); return; }
    } catch (err) { msg(err.message || String(err), true); }
    b.disabled = false;
  };
}
