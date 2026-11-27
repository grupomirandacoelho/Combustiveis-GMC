// Estrutura da gestão: usuário, menu lateral, tema, modo apresentação e rotas (#/rota).
import { carregarDados, recarregarDados, versaoCarregada, versaoNoServidor, esc, fmtDia } from './lib/dados.js';
import { filtrosSalvos, limparFiltrosSalvos } from './lib/filtros.js';
import { iniciarAcoesLinha } from './lib/acoes-linha.js';
import { iniciarMascaraMoeda, iniciarMascaras } from './lib/mascara.js';
import { iniciarSelecao } from './lib/selecao.js';
import { confirmar } from './lib/confirmar.js';
import { iniciarNotificacoes, listaDoSino } from './lib/notificacao.js';
import { arrastarParaFechar } from './lib/gesto.js';
import { montarCelular } from './lib/celular.js';
import { iniciarToqueLongo } from './lib/toque-longo.js';
window.confirmar = confirmar;   // confirmação dentro do site (as páginas chamam confirmar() sem importar)

const $ = (id) => document.getElementById(id);
const app = $('app');

function guardar(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
function ler(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

// ---------- usuário ----------
let usuario = null;
// o que este login pode abrir (o servidor confere de novo em cada pedido; aqui só esconde o que não pode)
const pode = (perm) => !perm || (usuario && (usuario.papel === 'admin' || (perm !== 'admin' && usuario.permissoes.includes(perm))));
const carregandoUsuario = fetch('/api/me', { credentials: 'same-origin' })
  .then((r) => { if (r.status === 401) { location.href = '/?entrar=1'; return null; } return r.json(); })
  .then((u) => {
    if (!u) return;
    if (u.trocar_senha) { location.href = '/gestao/senha/'; return; }
    usuario = { ...u, permissoes: u.permissoes || [] };
    $('usuario-nome').textContent = u.nome;
    $('usuario-papel').textContent = u.papel === 'admin' ? 'Administrador' : 'Acesso personalizado';
    $('avatar').textContent = $('avatar-painel').textContent = (u.nome || '?').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
    $('btn-conta').title = u.nome;
    aplicarMenu();
    iniciarNotificacoes({ pode, usuario });   // avisos no canto da tela (Operacional > Notificações)
    $('conta-acessos').hidden = !pode(ROTAS.acessos.perm);
    $('sino-rodape').hidden = !pode(ROTAS.notificacoes.perm);   // engrenagem do sino: configurar as notificações
    conferirAlertasCartoes();
    conferirConferencia();
  })
  .catch(() => {});

// selo no menu "Cartões frota": avisos de cartão faltando enviados pelos motoristas e ainda em aberto
function seloCartoes(n) {
  const s = $('selo-cartoes');
  if (!s) return;
  s.textContent = n > 99 ? '99+' : String(n || '');
  s.title = n ? n + (n === 1 ? ' aviso de cartão faltando' : ' avisos de cartão faltando') : '';
  s.classList.toggle('oculto', !n);
}
function conferirAlertasCartoes() {
  if (!pode('cartoes-frota')) return;
  fetch('/api/cartoes/alertas', { credentials: 'same-origin', cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) seloCartoes(j.abertos); }).catch(() => {});
}
setInterval(() => { if (!document.hidden) conferirAlertasCartoes(); }, 2 * 60 * 1000);
window.addEventListener('alertas-cartoes', (e) => seloCartoes(e.detail));
// selo no menu "Conferência com os cartões": diferenças com a Ticket e a TruckPag ainda sem decisão
function seloConferencia(n) {
  const s = $('selo-conferencia');
  if (!s) return;
  s.textContent = n > 99 ? '99+' : String(n || '');
  s.title = n ? n + (n === 1 ? ' diferença para conferir' : ' diferenças para conferir') : '';
  s.classList.toggle('oculto', !n);
}
function conferirConferencia() {
  if (!pode('conferencia-cartoes')) return;
  fetch('/api/conferencia-cartoes?resumo=1', { credentials: 'same-origin', cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) seloConferencia(j.pendentes); }).catch(() => {});
}
setInterval(() => { if (!document.hidden) conferirConferencia(); }, 10 * 60 * 1000);
window.addEventListener('conferencia-cartoes', (e) => seloConferencia(e.detail));

// menu: some o que o login não pode abrir, e a seção inteira quando não sobra nada nela
function aplicarMenu() {
  document.querySelectorAll('#menu a[data-rota]').forEach((a) => {
    const r = ROTAS[a.dataset.rota];
    a.classList.toggle('oculto', !!r && !pode(r.perm));
  });
  document.querySelectorAll('.menu-secao').forEach((s) => {
    s.classList.toggle('oculto', !s.querySelector('.menu-itens a:not(.oculto)'));
  });
}

// ---------- menu da conta (iniciais ao lado da busca) ----------
(function menuConta() {
  const botao = $('btn-conta'), painel = $('conta-painel');
  const itens = () => [...painel.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')].filter((i) => !i.hidden);
  const abrir = (sim) => {
    painel.classList.toggle('oculto', !sim);
    botao.setAttribute('aria-expanded', String(sim));
    if (sim) itens()[0].focus();
  };
  botao.addEventListener('click', () => abrir(painel.classList.contains('oculto')));
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.conta')) abrir(false); });
  painel.addEventListener('click', (e) => { if (e.target.closest('a')) abrir(false); });
  painel.addEventListener('keydown', (e) => {
    const ls = itens(), i = ls.indexOf(document.activeElement);
    if (e.key === 'Escape') { abrir(false); botao.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); ls[(i + 1) % ls.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); ls[(i - 1 + ls.length) % ls.length].focus(); }
  });
})();

// ---------- sino (notificações): ao lado da conta; lista o que está disparando (lib/notificacao.js) ----------
// "Lida" = já vista naquela ocorrência (aviso + hora em que apareceu), guardada no navegador por login. Só o nível crítico
// também aparece no canto da tela; aqui fica tudo. Engrenagem: Configurar notificações (antes no menu Operacional).
(function sino() {
  const botao = $('btn-sino'), painel = $('sino-painel'), lista = $('sino-lista'), selo = $('sino-selo');
  let atual = listaDoSino();
  const chaveLidas = () => 'notif-lidas:' + atual.uid;
  const lidas = () => { try { return JSON.parse(localStorage.getItem(chaveLidas()) || '{}') || {}; } catch { return {}; } };
  const salvar = (m) => { try { localStorage.setItem(chaveLidas(), JSON.stringify(m)); } catch {} };
  const naoLida = (it, m) => m[it.chave] !== it.desde;
  const quando = (ms) => { const d = new Date(ms); return isNaN(d) ? '' : d.toLocaleDateString('pt-BR') + ', ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
  const ICONE_NIVEL = { critico: 'i-alerta', alerta: 'i-alerta', info: 'i-info' };
  function desenhar() {
    const m = lidas(), n = atual.itens.filter((it) => naoLida(it, m)).length;
    selo.textContent = n > 99 ? '99+' : String(n);
    selo.classList.toggle('oculto', !n);
    $('sino-sr').textContent = n ? 'Notificações: ' + n + (n === 1 ? ' não lida' : ' não lidas') : 'Notificações';
    botao.title = n ? n + (n === 1 ? ' notificação não lida' : ' notificações não lidas') : 'Notificações';
    $('sino-lidas').hidden = !n;
    lista.innerHTML = atual.itens.length ? atual.itens.map((it, i) => {
      const corpo = '<svg class="sino-ic" aria-hidden="true"><use href="#' + (ICONE_NIVEL[it.nivel] || 'i-info') + '"/></svg>' +
        '<span class="sino-txt"><strong>' + esc(it.titulo || 'Aviso') + '</strong>' + (it.texto ? '<span class="sino-desc">' + esc(it.texto) + '</span>' : '') +
        '<small>' + esc(quando(it.desde)) + (it.nivel === 'critico' ? ' · crítico' : '') + '</small></span>';
      const cls = 'sino-item nivel-' + esc(it.nivel || 'info') + (naoLida(it, m) ? ' nao-lida' : '');
      return '<li class="' + cls + '">' + (it.acao && it.acao.href ? '<a href="' + esc(it.acao.href) + '" data-i="' + i + '">' + corpo + '</a>' : '<div data-i="' + i + '">' + corpo + '</div>') + '</li>';
    }).join('') : '<li class="sino-vazio">Nenhuma notificação agora.</li>';
  }
  const marcar = (its) => { const m = lidas(); for (const it of its) m[it.chave] = it.desde; salvar(m); desenhar(); };
  const abrir = (sim) => {
    painel.classList.toggle('oculto', !sim);
    botao.setAttribute('aria-expanded', String(sim));
    if (sim) { desenhar(); montarCelular($('sino-celular')); }   // notificações neste aparelho (26/11/2026)
  };
  window.addEventListener('centro-notificacoes', (e) => { atual = e.detail; desenhar(); });
  botao.addEventListener('click', () => abrir(painel.classList.contains('oculto')));
  $('sino-fechar').addEventListener('click', () => { abrir(false); botao.focus(); });
  $('sino-lidas').addEventListener('click', () => marcar(atual.itens));
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.notif-centro')) abrir(false); });
  painel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { abrir(false); botao.focus(); } });
  painel.addEventListener('click', (e) => {
    const alvo = e.target.closest('[data-i]');
    if (alvo) { const it = atual.itens[Number(alvo.dataset.i)]; if (it) marcar([it]); }
    if (e.target.closest('a')) abrir(false);
  });
  // celular (18/11/2026): o painel é uma gaveta pela direita (CSS) e sai arrastando o dedo para a direita, como o menu sai
  // arrastando para a esquerda; arrastar para a esquerda a partir da borda direita da tela abre.
  const celular = window.matchMedia('(max-width:820px)');
  painel.setAttribute('data-sem-gesto', '');   // o gesto do menu não vale dentro do painel
  arrastarParaFechar(painel, { direcoes: [1], ativo: () => celular.matches, aoSair: () => abrir(false) });
  let borda = null;
  document.addEventListener('touchstart', (e) => {
    borda = celular.matches && e.touches.length === 1 && painel.classList.contains('oculto') && !app.classList.contains('menu-aberto') &&
      e.touches[0].clientX > window.innerWidth - 28 && !e.target.closest('.leaflet-container, input[type=range]')
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!borda) return;
    const dx = e.touches[0].clientX - borda.x, dy = e.touches[0].clientY - borda.y;
    if (Math.abs(dy) > 30) { borda = null; return; }
    if (dx < -40) { borda = null; abrir(true); }
  }, { passive: true });
  desenhar();
})();

$('btn-sair').addEventListener('click', () => {
  limparFiltrosSalvos();
  fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {}).then(() => { location.href = '/'; });
});

// ---------- menu lateral ----------
function aplicarRecolhido(sim) {
  app.classList.toggle('recolhido', sim);
  $('btn-recolher').setAttribute('aria-expanded', String(!sim));
  $('btn-recolher').setAttribute('aria-label', sim ? 'Mostrar menu' : 'Recolher menu');
}
aplicarRecolhido(ler('gestao-menu') === 'recolhido');
$('btn-recolher').addEventListener('click', () => {
  const sim = !app.classList.contains('recolhido');
  aplicarRecolhido(sim);
  guardar('gestao-menu', sim ? 'recolhido' : null);
  window.dispatchEvent(new Event('resize'));
});

// seções do menu (Dashboards, Postos, Conta): a setinha oculta e reexibe os itens; o navegador lembra
function secoesFechadas() { try { return JSON.parse(ler('gestao-secoes') || '[]'); } catch (e) { return []; } }
function abrirSecao(secao, aberta) {
  secao.classList.toggle('fechada', !aberta);
  secao.querySelector('.menu-grupo').setAttribute('aria-expanded', String(aberta));
  secao.querySelectorAll('.menu-itens a').forEach((a) => { a.tabIndex = aberta ? 0 : -1; });
}
function salvarSecoes() {
  guardar('gestao-secoes', JSON.stringify([...document.querySelectorAll('.menu-secao.fechada')].map((s) => s.dataset.secao)));
}
const fechadas = secoesFechadas();
document.querySelectorAll('.menu-secao').forEach((s) => {
  abrirSecao(s, !fechadas.includes(s.dataset.secao));
  s.querySelector('.menu-grupo').addEventListener('click', () => {
    abrirSecao(s, s.classList.contains('fechada'));
    salvarSecoes();
  });
});

// no menu recolhido, mostra o nome do item ao passar o mouse
const dica = document.createElement('div');
dica.className = 'dica-menu oculto';
document.body.appendChild(dica);
$('lateral').addEventListener('mouseover', (e) => {
  const item = e.target.closest('.menu a, .menu button');
  if (!item || !app.classList.contains('recolhido') || innerWidth <= 820) { dica.classList.add('oculto'); return; }
  const r = item.getBoundingClientRect();
  dica.textContent = item.querySelector('.rotulo').textContent;
  dica.style.left = r.right + 10 + 'px';
  dica.style.top = r.top + r.height / 2 - 14 + 'px';
  dica.classList.remove('oculto');
});
$('lateral').addEventListener('mouseleave', () => dica.classList.add('oculto'));

// celular: menu por cima do conteúdo
$('btn-menu-movel').addEventListener('click', () => app.classList.add('menu-aberto'));
document.addEventListener('click', (e) => {
  if (!app.classList.contains('menu-aberto')) return;
  if (e.target.closest('#lateral') && !e.target.closest('a')) return;
  if (e.target.closest('#btn-menu-movel')) return;
  app.classList.remove('menu-aberto');
});
// celular: arrastar o dedo para a direita (começando na metade esquerda da tela) puxa o menu, que acompanha o dedo;
// arrastar para a esquerda fecha. Não vale em tabela com rolagem lateral, mapa ou campo de faixa (eles usam o arrasto).
(function () {
  const lat = $('lateral'), celular = window.matchMedia('(max-width:820px)');
  let ini = null, arrastando = false;
  const largura = () => lat.getBoundingClientRect().width || 290;
  const ocupado = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.matches && n.matches('.leaflet-container, input[type=range], [data-sem-gesto]')) return true;
      if (n.scrollWidth > n.clientWidth + 2 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true;
    }
    return false;
  };
  document.addEventListener('touchstart', (e) => {
    if (!celular.matches || e.touches.length !== 1) { ini = null; return; }
    const t = e.touches[0], aberto = app.classList.contains('menu-aberto');
    if (!aberto && (t.clientX > window.innerWidth * 0.5 || ocupado(e.target))) { ini = null; return; }
    ini = { x: t.clientX, y: t.clientY, t: Date.now(), aberto };
    arrastando = false;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!ini) return;
    const t = e.touches[0], dx = t.clientX - ini.x, dy = t.clientY - ini.y;
    if (!arrastando) {
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.5 || (ini.aberto ? dx > 0 : dx < 0)) { if (Math.abs(dy) > 12) ini = null; return; }
      arrastando = true;
      lat.style.transition = 'none';
    }
    const w = largura(), pos = ini.aberto ? Math.min(0, dx) : Math.min(0, -w + dx);
    lat.style.transform = 'translateX(' + pos + 'px)';
    lat.style.boxShadow = '0 0 0 100vmax rgba(0,0,0,' + (0.55 * (1 + pos / w)).toFixed(3) + ')';
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!ini) return;
    const foi = ini; ini = null;
    if (!arrastando) return;
    arrastando = false;
    const dx = (e.changedTouches[0] || {}).clientX - foi.x, rapido = Math.abs(dx) / Math.max(1, Date.now() - foi.t) > 0.5;
    const w = largura(), abrir = foi.aberto ? !(dx < -w * 0.3 || (rapido && dx < 0)) : (dx > w * 0.35 || (rapido && dx > 0));
    lat.style.transition = ''; lat.style.transform = ''; lat.style.boxShadow = '';
    app.classList.toggle('menu-aberto', abrir);
  });
  document.addEventListener('touchcancel', () => { ini = null; arrastando = false; lat.style.transition = ''; lat.style.transform = ''; lat.style.boxShadow = ''; });
})();

// ---------- tema ----------
function temaEfetivo() {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'light' ? 'light' : 'dark';   // o escuro (layout do Figma) é o padrão
}
function rotuloTema() { $('btn-tema').setAttribute('aria-checked', String(temaEfetivo() === 'dark')); }

// ---------- busca de página (barra superior): procura nas páginas do menu que o login enxerga ----------
(function buscaPagina() {
  const campo = $('busca-pagina'), lista = $('busca-lista');
  if (!campo) return;
  let itens = [], ativo = -1;
  const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const paginas = () => [...document.querySelectorAll('#menu a[href]')]
    .filter((a) => !a.hidden && !a.closest('.oculto') && getComputedStyle(a).display !== 'none')
    .map((a) => {
      const s = a.closest('.menu-secao');
      const use = a.querySelector('use');
      return { href: a.getAttribute('href'), nome: (a.querySelector('.rotulo') || a).textContent.trim(),
        grupo: s ? s.querySelector('.menu-grupo span').textContent : 'Geral', icone: use ? use.getAttribute('href') : '#i-inicio' };
    });
  function fechar() {
    lista.classList.add('oculto');
    campo.setAttribute('aria-expanded', 'false');
    campo.removeAttribute('aria-activedescendant');
  }
  function marcar(i) {
    ativo = i;
    lista.querySelectorAll('[data-i]').forEach((li) => li.setAttribute('aria-selected', String(+li.dataset.i === i)));
    campo.setAttribute('aria-activedescendant', 'busca-op-' + i);
  }
  function desenhar() {
    const t = norm(campo.value.trim());
    if (!t) { fechar(); return; }
    itens = paginas().filter((p) => norm(p.nome + ' ' + p.grupo).includes(t)).slice(0, 12);
    lista.innerHTML = itens.length
      ? itens.map((p, i) => '<li role="option" id="busca-op-' + i + '" data-i="' + i + '" aria-selected="false">' +
        '<svg aria-hidden="true"><use href="' + esc(p.icone) + '"/></svg><span>' + esc(p.nome) + '<small>' + esc(p.grupo) + '</small></span></li>').join('')
      : '<li class="busca-vazia" role="option" aria-disabled="true">Nenhuma página com esse nome</li>';
    lista.classList.remove('oculto');
    campo.setAttribute('aria-expanded', 'true');
    if (itens.length) marcar(0); else { ativo = -1; campo.removeAttribute('aria-activedescendant'); }
  }
  function abrir(i) {
    const p = itens[i];
    if (!p) return;
    campo.value = '';
    fechar();
    campo.blur();
    location.href = p.href;
  }
  campo.addEventListener('input', desenhar);
  campo.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && itens.length) { e.preventDefault(); marcar((ativo + 1) % itens.length); }
    else if (e.key === 'ArrowUp' && itens.length) { e.preventDefault(); marcar((ativo - 1 + itens.length) % itens.length); }
    else if (e.key === 'Enter') { e.preventDefault(); abrir(ativo); }
    else if (e.key === 'Escape') { campo.value = ''; fechar(); }
  });
  lista.addEventListener('mousedown', (e) => { const li = e.target.closest('[data-i]'); if (li) { e.preventDefault(); abrir(+li.dataset.i); } });
  campo.addEventListener('blur', () => setTimeout(fechar, 120));
  // "/" em qualquer lugar fora de um campo leva à busca
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.target.closest('input, textarea, select, [contenteditable="true"]')) { e.preventDefault(); campo.focus(); }
  });
})();
rotuloTema();
$('btn-tema').addEventListener('click', () => {
  const novo = temaEfetivo() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', novo);
  guardar('gestao-tema', novo);
  rotuloTema();
  window.dispatchEvent(new CustomEvent('tema'));
});

// ---------- modo apresentação ----------
export function alternarApresentacao(ligar) {
  const on = ligar ?? !document.body.classList.contains('apresentando');
  document.body.classList.toggle('apresentando', on);
  if (on && document.documentElement.requestFullscreen && !document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
  if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  desenharAcoes();
  window.dispatchEvent(new Event('resize'));
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('apresentando')) alternarApresentacao(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('apresentando')) alternarApresentacao(false);
});

// ---------- rotas ----------
const ROTAS = {
  'inicio': { titulo: 'Início', montar: montarInicio },
  // endereço que não existe (link antigo ou digitado errado)
  'nao-encontrada': {
    titulo: 'Página não encontrada', perm: null,
    montar: (ctx) => { ctx.pagina.innerHTML = '<div class="vazio sem-acesso"><strong>Esta página não existe.</strong> O endereço pode estar errado ou a página mudou de nome. Use "Buscar página" ou <a href="#/inicio">volte ao início</a>.</div>'; return {}; },
  },
  'operacao-motorista': {
    titulo: 'Operação por motorista',
    apresentavel: true,
    montar: (ctx) => import('./dashboards/operacao-motorista.js').then((m) => m.montar(ctx)),
  },
  'despesas': {
    titulo: 'Despesas',
    apresentavel: true,
    montar: (ctx) => import('./dashboards/despesas.js').then((m) => m.montar(ctx)),
  },
  'divisao-cartoes': {
    titulo: 'Divisão por cartão',
    apresentavel: true,
    montar: (ctx) => import('./dashboards/divisao-cartoes.js').then((m) => m.montar(ctx)),
  },
  'evolucao-placas': {
    titulo: 'Evolução placas',
    apresentavel: true,
    montar: (ctx) => import('./dashboards/evolucao-placas.js').then((m) => m.montar(ctx)),
  },
  'media-geral': {
    titulo: 'Média geral',
    apresentavel: true,
    montar: (ctx) => import('./dashboards/media-geral.js').then((m) => m.montar(ctx)),
  },
  'preco-fornecedor': {           // endereço antigo mantido para quem salvou o link
    titulo: 'Preço bomba interna',
    apresentavel: true,
    montar: (ctx) => import('./dashboards/preco-fornecedor.js').then((m) => m.montar(ctx)),
  },
  'preco-postos': {
    titulo: 'Preço postos externos',
    apresentavel: true,
    montar: (ctx) => import('./dashboards/preco-postos.js').then((m) => m.montar(ctx)),
  },
  'preco-anp': {
    titulo: 'Preço x ANP',
    apresentavel: true,
    montar: (ctx) => import('./dashboards/preco-anp.js').then((m) => m.montar(ctx)),
  },
  'preco-refinaria': {
    titulo: 'Preço x Refinaria',
    apresentavel: true,
    montar: (ctx) => import('./dashboards/preco-refinaria.js').then((m) => m.montar(ctx)),
  },
  'contratos-anp': {
    titulo: 'Contratos x ANP',
    apresentavel: true,
    montar: (ctx) => import('./dashboards/contratos-anp.js').then((m) => m.montar(ctx)),
  },
  'real-orcado': {
    titulo: 'Real x Orçado',
    apresentavel: true,
    montar: (ctx) => import('./dashboards/real-orcado.js').then((m) => m.montar(ctx)),
  },
  'programa-prime': {
    titulo: 'Fechamento abastecimentos',
    montar: (ctx) => import('./paginas/programa-prime.js').then((m) => m.montar(ctx)),
  },
  // resultado do mês fechado por unidade (economia em R$ x premiação); mesma permissão do PRIME
  'prime-resultado': {
    titulo: 'Resultado PRIME',
    apresentavel: true,
    perm: 'programa-prime',
    montar: (ctx) => import('./dashboards/prime-resultado.js').then((m) => m.montar(ctx)),
  },
  // fora do menu desde 18/11/2026: abre pela engrenagem do sino (cabeçalho); "grupo" = o que aparece acima do título
  notificacoes: {
    titulo: 'Configurar notificações',
    grupo: 'Notificações',
    montar: (ctx) => import('./paginas/notificacoes.js').then((m) => m.montar(ctx)),
  },
  'consulta-km': {
    titulo: 'Consulta de KM',
    montar: (ctx) => import('./dashboards/consulta-km.js').then((m) => m.montar(ctx)),
  },
  'mapa-calor': {
    titulo: 'Mapa de calor',
    apresentavel: true,
    montar: (ctx) => import('./mapas/mapa-calor.js').then((m) => m.montar(ctx)),
  },
  'roteirizador': {
    titulo: 'Roteirizador SPOT',
    apresentavel: true,
    montar: (ctx) => import('./mapas/roteirizador.js').then((m) => m.montar(ctx)),
  },
  'postos-motoristas': {
    titulo: 'Postos dos motoristas',
    montar: (ctx) => import('./paginas/postos-motoristas.js').then((m) => m.montar(ctx)),
  },
  'rodada-precos': {
    titulo: 'Rodada de preços',
    montar: (ctx) => import('./paginas/rodada-precos.js').then((m) => m.montar(ctx)),
  },
  'bomba-estoque': {
    titulo: 'Estoque',
    montar: (ctx) => import('./paginas/bomba-estoque.js').then((m) => m.montar(ctx)),
  },
  'bomba-abastecimento': {
    titulo: 'Inclusão de abastecimento',
    montar: (ctx) => import('./paginas/bomba-abastecimento.js').then((m) => m.montar(ctx)),
  },
  'bomba-movimentacoes': {
    titulo: 'Movimentações',
    montar: (ctx) => import('./paginas/bomba-movimentacoes.js').then((m) => m.montar(ctx)),
  },
  'fiscal-conciliacao': {
    titulo: 'Conciliação de NFs',
    montar: (ctx) => import('./paginas/fiscal-conciliacao.js').then((m) => m.montar(ctx)),
  },
  'bomba-rateio': {
    titulo: 'Rateio das NFs',
    montar: (ctx) => import('./paginas/bomba-rateio.js').then((m) => m.montar(ctx)),
  },
  'consolidador': {
    titulo: 'Consolidador',
    montar: (ctx) => import('./paginas/consolidador.js').then((m) => m.montar(ctx)),
  },
  'abastecimentos': {
    titulo: 'Editar abastecimentos',
    montar: (ctx) => import('./paginas/abastecimentos.js').then((m) => m.montar(ctx)),
  },
  'conferencia-cartoes': {
    titulo: 'Conferência com os cartões',
    montar: (ctx) => import('./paginas/conferencia-cartoes.js').then((m) => m.montar(ctx)),
  },
  'cartoes-frota': {
    titulo: 'Cartões frota',
    montar: (ctx) => import('./paginas/cartoes.js').then((m) => m.montar(ctx)),
  },
  'cadastro-placas': {
    titulo: 'Placas',
    montar: (ctx) => import('./paginas/cadastros.js').then((m) => m.montar(ctx, 'placas')),
  },
  'cadastro-motoristas': {
    titulo: 'Motoristas',
    montar: (ctx) => import('./paginas/cadastros.js').then((m) => m.montar(ctx, 'motoristas')),
  },
  // fora do menu lateral desde 18/11/2026: abre pelo menu da conta (iniciais no canto de cima)
  'acessos': {
    titulo: 'Gerenciar acessos',
    grupo: 'Conta',
    perm: 'admin',
    montar: (ctx) => import('./paginas/acessos.js').then((m) => m.montar(ctx)),
  },
};
// a permissão de cada página tem o mesmo nome da rota (lib/permissoes.js); o início é de todos
for (const [id, r] of Object.entries(ROTAS)) if (id !== 'inicio' && r.perm === undefined) r.perm = id;

let rotaAtual = null;
let desmontar = null;
// cada navegação ganha um número: só a montagem da navegação mais recente fica valendo (27/11/2026: indo e voltando rápido para a
// mesma tela, as duas montagens terminavam com a rota certa, a segunda sobrescrevia a primeira e a primeira nunca era desmontada;
// os ouvintes dela seguiam rodando e davam "Cannot read properties of null" no console)
let navegacao = 0;

// ---------- dados novos: botão Atualizar ----------
let dadosNovos = null;          // versão nova encontrada no servidor, ainda não carregada
let atualizando = false;

function aviso(texto) {
  let t = document.getElementById('aviso-flutuante');
  if (!t) {
    t = document.createElement('div');
    t.id = 'aviso-flutuante';
    t.className = 'aviso-flutuante';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.textContent = texto;
  t.classList.add('visivel');
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => t.classList.remove('visivel'), Math.max(4200, texto.length * 60));   // textos longos ficam mais tempo
}

function quando(info) {
  if (!info || !info.geradoEm) return '';
  const g = new Date(info.geradoEm);
  return g.toLocaleDateString('pt-BR') + ' às ' + g.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// andamento informado pelo sincronizador do computador da Base (chave "status")
const hora = (s) => (s ? new Date(s).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');
function andamento(info) {
  const s = info && info.status;
  if (!s || !s.desde) return null;
  const recente = Date.now() - new Date(s.desde).getTime() < 10 * 60 * 1000;   // mais velho que 10 min: ignora
  const depoisDaVersao = !info.geradoEm || s.desde >= info.geradoEm;
  if (s.estado === 'processando' && recente && depoisDaVersao) return { tipo: 'enviando', s };
  if (s.estado === 'erro' && depoisDaVersao) return { tipo: 'erro', s };
  return null;
}

let recebendo = null;            // {baseSalvaEm} enquanto a Base está sendo enviada
let carregarQuandoChegar = false;
let tRapido = null;

async function conferirVersao() {
  const atual = versaoCarregada();
  if (!atual) return;                         // nenhum dado na tela ainda
  const info = await versaoNoServidor();
  if (!info) return;
  if (info.versao && info.versao !== atual) {
    recebendo = null;
    if (carregarQuandoChegar) { carregarQuandoChegar = false; aplicarDadosNovos(info); return; }
    dadosNovos = info;
  } else {
    const a = andamento(info);
    recebendo = a && a.tipo === 'enviando' ? a.s : null;
  }
  desenharAcoes();
  // enquanto a Base está sendo enviada, confere a cada 10 s (em vez de 2 min)
  clearTimeout(tRapido);
  if (recebendo || carregarQuandoChegar) tRapido = setTimeout(conferirVersao, 10 * 1000);
}
setInterval(() => { if (!document.hidden) conferirVersao(); }, 2 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) conferirVersao(); });

async function aplicarDadosNovos(info) {
  atualizando = true;
  desenharAcoes();
  try {
    await recarregarDados();
    window.dispatchEvent(new CustomEvent('dados-atualizados'));
    aviso('Dados atualizados (gerados às ' + hora(info.baseSalvaEm || info.geradoEm) + ').');
    dadosNovos = null;
  } catch (e) {
    aviso('Não foi possível carregar os dados novos: ' + e.message);
  } finally {
    atualizando = false;
    desenharAcoes();
  }
}

async function atualizarDados() {
  if (atualizando) return;
  atualizando = true;
  desenharAcoes();
  let info = null;
  try { info = await versaoNoServidor(); } finally { atualizando = false; }
  if (!info) { aviso('Sem conexão com o servidor. Verifique a internet e tente de novo.'); desenharAcoes(); return; }
  if (info.versao && info.versao !== versaoCarregada()) { aplicarDadosNovos(info); return; }
  const a = andamento(info);
  if (a && a.tipo === 'enviando') {
    recebendo = a.s;
    carregarQuandoChegar = true;
    aviso('Os dados novos estão sendo gerados. Eles entram sozinhos em instantes.');
    desenharAcoes();
    clearTimeout(tRapido);
    tRapido = setTimeout(conferirVersao, 10 * 1000);
    return;
  }
  if (a && a.tipo === 'erro') {
    aviso('A geração dos dados novos falhou. Ela é tentada de novo sozinha em alguns minutos.');
    desenharAcoes();
    return;
  }
  aviso('Você já está com os dados mais recentes (gerados às ' + hora(info.baseSalvaEm || info.geradoEm) + ' de ' +
    new Date(info.baseSalvaEm || info.geradoEm).toLocaleDateString('pt-BR') + ').');
  desenharAcoes();
}

function desenharAcoes() {
  const r = ROTAS[rotaAtual];
  const acoes = $('barra-acoes');
  acoes.innerHTML = '';
  if (!r || !r.apresentavel) return;
  const on = document.body.classList.contains('apresentando');

  const at = document.createElement('button');
  at.type = 'button';
  at.className = 'btn btn-atualizar' + (dadosNovos ? ' tem-novo' : '');
  at.disabled = atualizando;
  const girar = atualizando || recebendo;
  at.title = dadosNovos ? 'Há dados novos, de ' + quando(dadosNovos)
    : recebendo ? 'Os dados novos estão sendo gerados'
    : 'Buscar os dados mais recentes';
  at.innerHTML = '<svg aria-hidden="true" class="' + (girar ? 'girando' : '') + '"><use href="#i-atualizar"/></svg>' +
    '<span class="txt">' + (atualizando ? 'Atualizando…' : dadosNovos ? 'Atualizar: dados novos' : recebendo ? 'Recebendo os dados…' : 'Atualizar') + '</span>' +
    (dadosNovos ? '<span class="ponto-novo" aria-hidden="true"></span>' : '');
  at.addEventListener('click', atualizarDados);
  // transações das APIs dos cartões (Ticket Log e TruckPag) somadas aos painéis antes de entrarem na planilha
  const tr = document.createElement('span');
  tr.className = 'chip-tempo-real oculto';
  acoes.appendChild(tr);
  carregarDados().then((d) => {
    const x = d.tempoReal;
    if (!x || !x.n || !tr.isConnected) return;
    const pc = x.porCartao || {};
    const ultima = x.ate ? x.ate.slice(8, 10) + '/' + x.ate.slice(5, 7) + ' ' + x.ate.slice(11, 16) : '';
    tr.innerHTML = '<span class="ponto-vivo" aria-hidden="true"></span><span class="txt">Tempo real: ' + x.n.toLocaleString('pt-BR') +
      (ultima ? ' · última ' + ultima : '') + '</span>';
    tr.title = x.n.toLocaleString('pt-BR') + ' transações das APIs dos cartões (Ticket ' + (pc.TICKET || 0) + ', TruckPag ' + (pc.TRUCKPAG || 0) +
      ') de hoje, que ainda não estão nos abastecimentos. Entram no dia seguinte (D-1). Veloe e Vibra entram pelo Consolidador.';
    tr.classList.remove('oculto');
  }).catch(() => {});
  acoes.appendChild(at);

  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ' + (on ? '' : 'btn-principal');
  b.innerHTML = on
    ? '<svg aria-hidden="true"><use href="#i-sair-apres"/></svg><span class="txt">Sair da apresentação</span>'
    : '<svg aria-hidden="true"><use href="#i-apresentar"/></svg><span class="txt">Apresentar</span>';
  b.addEventListener('click', () => alternarApresentacao());
  acoes.appendChild(b);
}

async function desenharRota() {
  await carregandoUsuario;
  const nome = (location.hash.replace(/^#\/?/, '') || 'inicio').split('?')[0];
  const rota = ROTAS[nome] ? nome : nome ? 'nao-encontrada' : 'inicio';
  // voltou para uma tela sem filtro no endereço: repõe os filtros que ela tinha nesta sessão
  if (!location.hash.includes('?')) {
    const salvo = filtrosSalvos('#/' + rota);
    if (salvo) history.replaceState(null, '', '#/' + rota + '?' + salvo);
  }
  if (desmontar) { try { desmontar(); } catch (e) {} desmontar = null; }
  const vez = ++navegacao;
  rotaAtual = rota;
  const r = ROTAS[rota];
  document.title = r.titulo + ' · RajaLog - Gestão de combustíveis';
  $('titulo-pagina').textContent = r.titulo;
  $('sub-pagina').textContent = '';
  // grupo do menu acima do título (o nome da página é o mesmo do menu; o grupo dá o contexto)
  const itemMenu = document.querySelector('#menu a[data-rota="' + rota + '"]');
  const grupo = itemMenu && itemMenu.closest('.menu-secao');
  $('grupo-pagina').textContent = grupo ? grupo.querySelector('.menu-grupo span').textContent : (r.grupo || '');
  document.querySelectorAll('#menu a[data-rota]').forEach((a) => {
    if (a.dataset.rota === rota) {
      a.setAttribute('aria-current', 'page');
      const secao = a.closest('.menu-secao');   // a página aberta nunca fica escondida numa seção fechada
      if (secao && secao.classList.contains('fechada')) { abrirSecao(secao, true); salvarSecoes(); }
    } else a.removeAttribute('aria-current');
  });
  if (!r.apresentavel && document.body.classList.contains('apresentando')) alternarApresentacao(false);
  desenharAcoes();
  // área nova a cada navegação (27/11/2026): a tela que sai fica com o elemento antigo, já fora da página. O que ela ainda fizer
  // depois de sair (dados que chegam, redimensionar, temporizadores) cai nele: sem erro no console e sem desenhar por cima da
  // tela nova. Mesmo id e classe: o CSS (.pagina > * na grade de 12 colunas) continua igual.
  const velha = $('pagina'), pagina = velha.cloneNode(false);
  velha.replaceWith(pagina);
  ligarPagina(pagina);
  // enquanto o arquivo da página chega (import), mostra o "Carregando…" em vez da área vazia
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando…</div>';
  const ctx = { pagina, definirSub: (t) => { $('sub-pagina').textContent = t; }, pode, usuario, aviso };
  if (!pode(r.perm)) {
    pagina.innerHTML = '<div class="vazio sem-acesso"><strong>Seu acesso não inclui esta página.</strong> ' +
      'Se precisar dela, peça a um administrador do portal. <a href="#/inicio">Voltar ao início</a></div>';
    document.querySelectorAll('#barra-acoes > *').forEach((b) => b.remove());
    return;
  }
  const res = await r.montar(ctx);
  if (vez === navegacao) desmontar = res && res.desmontar ? res.desmontar : null;
  else if (res && res.desmontar) { try { res.desmontar(); } catch (e) {} }
}
window.addEventListener('hashchange', desenharRota);
// o que vale para a área da página: toque longo no celular (= Ctrl+clique, 26/11/2026) e os botões de ações das linhas
function ligarPagina(el) { iniciarToqueLongo(el); iniciarAcoesLinha(el); }
ligarPagina($('pagina'));
iniciarMascaraMoeda(document);
iniciarMascaras(document);       // CPF, datas e placa: pontos, traço e barras entram sozinhos ao digitar   // campos de valor (R$) com máscara: só números, vírgula e pontos automáticos
iniciarSelecao(document);        // selects e campos com sugestões abrem a lista de seleção do site (com todas as opções)
// toda janela (dialog.dialogo) ganha um X no canto ao abrir: fechar sem precisar rolar até o Cancelar
new MutationObserver((mudancas) => {
  for (const m of mudancas) {
    const d = m.target;
    if (d.tagName !== 'DIALOG' || !d.open || !d.classList.contains('dialogo') || d.querySelector(':scope > .dialogo-x')) continue;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'dialogo-x'; b.setAttribute('aria-label', 'Fechar');
    b.innerHTML = '<svg aria-hidden="true"><use href="#i-x"/></svg>';
    b.addEventListener('click', () => d.close());
    d.prepend(b);
  }
}).observe(document.body, { attributes: true, attributeFilter: ['open'], subtree: true });
desenharRota();

// ---------- início ----------
// descrição de cada página nos atalhos do início (nome, ícone, grupo e ordem vêm do menu lateral)
const DESCRICOES = {
  'operacao-motorista': 'Média km/L de cada motorista e veículo contra a meta, economia de litros e todos os abastecimentos.',
  'despesas': 'Quanto cada veículo, centro de custo e fornecedor gastou, com R$ por km e preço médio.',
  'divisao-cartoes': '% dos litros de cada cartão (Ticket, TruckPag, Veloe, Vibra) nos postos externos, mês a mês e dia a dia.',
  'evolucao-placas': '% da meta de km/L de cada placa, mês a mês, agrupado por centro de custo.',
  'media-geral': 'Média km/L da frota contra a meta, mês a mês, com km rodado, economia e média por placa.',
  'preco-anp': 'Preço ponderado pago no diesel contra a média de revenda da ANP (diesel S10), por Brasil, região, estado e município.',
  'preco-refinaria': 'Preço pago no diesel contra o preço da Petrobras às distribuidoras no ponto de entrega mais próximo, e quanto pagamos acima dele.',
  'contratos-anp': 'Preço de contrato com o cliente (último reajuste) contra a ANP semanal do estado de referência de cada unidade.',
  'real-orcado': 'Combustível, Arla e KM de cada filial contra o orçamento, mês a mês, e o consumo km/L de cada veículo.',
  'programa-prime': 'Fechamento mensal do ranking dos motoristas: nota da telemetria, média contra a meta e prêmios.',
  'prime-resultado': 'Resultado do mês fechado por unidade: litros e R$ economizados contra a premiação.',
  notificacoes: 'Avisos no canto da tela (ex.: estoque baixo da bomba interna): criar, editar, pausar e excluir.',
  'preco-fornecedor': 'Preço de cada fornecedor das bombas internas, do mais barato ao mais caro; lançamento das negociações do dia e de fornecedores novos.',
  'bomba-estoque': 'Volume de diesel e Arla de cada bomba interna: medição inicial, compras e abastecimentos; cadastro das bases.',
  'bomba-movimentacoes': 'Compras de diesel e Arla das bombas internas, com NF, valor e litragem; alimentam o estoque.',
  'fiscal-conciliacao': 'Notas fiscais de serviço dos cartões com as notas dos postos de cada fatura, das APIs; baixar em CSV ou XLSX.',
  'bomba-rateio': 'Rateio de cada nota de compra das bombas internas por centro de custo e placa, validado e disponível para o fiscal.',
  'consulta-km': 'Último hodômetro de cada placa e a data da leitura, com o histórico de leituras.',
  'mapa-calor': 'Onde a frota abastece: litros e preço médio de cada posto no mapa.',
  'roteirizador': 'Traça a rota de uma viagem avulsa e sugere onde abastecer pelo menor custo, com os preços dos abastecimentos.',
  'postos-motoristas': 'Postos autorizados e bloqueados por unidade: adicionar, editar, bloquear e autorizar.',
  'preco-postos': 'Preço pago em cada posto contra o negociado, quanto foi pago acima e as negociações desatualizadas.',
  'rodada-precos': 'Atualiza o valor negociado de cada posto pelo preço da última transação.',
  'consolidador': 'Junta os abastecimentos de Ticket, Truckpag, Veloe e Vibra com o histórico e grava nos abastecimentos do portal.',
  'abastecimentos': 'Corrige hodômetro, valor por litro e informações adicionais dos abastecimentos.',
  'conferencia-cartoes': 'Compara os abastecimentos do portal com a Ticket e a TruckPag, separando o que mudou no cartão das correções feitas no portal.',
  'cartoes-frota': 'Situação dos cartões Ticket, TruckPag e Veloe de cada placa, último uso e avisos dos motoristas.',
  'cadastro-placas': 'Cadastro dos veículos: categoria, unidade, meta, ponto crítico e tanque.',
  'cadastro-motoristas': 'Cadastro dos motoristas: unidade, usuário da área do motorista, senhas dos cartões e últimos acessos.',
  'acessos': 'Criar, editar e excluir logins e escolher o que cada pessoa pode usar no portal.',
};

// atalhos do início agrupados como o menu lateral: mesmos grupos, nomes e ordem; só as páginas que o login pode abrir
function gruposDoMenu() {
  return [...document.querySelectorAll('#menu .menu-secao')].map((s) => ({
    nome: s.querySelector('.menu-grupo span').textContent,
    itens: [...s.querySelectorAll('a[data-rota]')]
      .filter((a) => { const r = ROTAS[a.dataset.rota]; return r && DESCRICOES[a.dataset.rota] && pode(r.perm); })
      .map((a) => ({ rota: a.dataset.rota, nome: a.querySelector('.rotulo').textContent, icone: a.querySelector('use').getAttribute('href') })),
  })).filter((g) => g.itens.length);
}

function montarInicio(ctx) {
  const primeiro = usuario ? usuario.nome.split(' ')[0] : '';
  const grupos = gruposDoMenu();
  const atalhos = grupos.flatMap((g) => g.itens);
  // Overview do Figma: saudação, resumo (indicadores, gráfico, média, números: lib paginas/inicio.js) e o cartão
  // "Todas as páginas" ao lado dos números (mesmos grupos, nomes e ordem do menu; a descrição fica na dica)
  ctx.pagina.innerHTML =
    '<div class="ini-saudacao"><h2 class="inicio-ola">' + (primeiro ? 'Olá, ' + esc(primeiro) : 'Olá') + '</h2>' +
    (atalhos.length ? '' : '<p class="inicio-texto">Seu login ainda não tem nenhuma página liberada. Peça a um administrador do portal.</p>') + '</div>' +
    '<div class="ini-resumo" id="ini-resumo"></div>' +
    (atalhos.length
      ? '<section class="cartao ini-atalhos-cartao" aria-labelledby="ini-atalhos-titulo"><div class="cab-cartao"><h2 id="ini-atalhos-titulo">Todas as páginas</h2>' +
        '<span class="conta">' + atalhos.length + (atalhos.length === 1 ? ' página' : ' páginas') + '</span></div><div class="ini-atalhos">' + grupos.map((g) =>
        '<div><h3>' + esc(g.nome) + '</h3><ul>' + g.itens.map(({ rota, icone, nome }) =>
          '<li><a href="#/' + rota + '" title="' + esc(DESCRICOES[rota]) + '"><svg aria-hidden="true"><use href="' + esc(icone) + '"/></svg>' +
            '<span>' + esc(nome) + '</span></a></li>').join('') + '</ul></div>').join('') + '</div></section>'
      : '') +
    '<p class="info-dados" id="info-dados">Verificando a última atualização dos dados…</p>' +
    '<p class="info-dados" id="info-plantao"></p>';
  // resumo geral (números de cada painel que o login pode abrir); se falhar, o início continua com os atalhos
  const resumo = document.getElementById('ini-resumo');
  import('./paginas/inicio.js')
    .then((m) => m.montarResumo(resumo, { pode, texto: document.getElementById('inicio-texto') }))
    .catch(() => { if (resumo.isConnected) resumo.remove(); });
  // qual computador está sincronizando agora (principal ou reserva) e há quanto tempo deu sinal
  versaoNoServidor().then((v) => {
    const el = document.getElementById('info-plantao');
    if (!el) return;
    const p = v && v.plantao;
    if (!p) { el.remove(); return; }
    const hora = (s) => new Date(s * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const minutos = Math.round((Date.now() / 1000 - p.renovado) / 60);
    el.textContent = 'Sincronização: computador ' + p.maquina + ' (' + (p.prioridade === 1 ? 'principal' : 'reserva') + '), de plantão desde ' + hora(p.desde) +
      (minutos > 5 ? '. Sem sinal há ' + minutos + ' min: o computador reserva assume se estiver ligado.' : '.');
  });
  const temDados = ['prime-resultado', 'operacao-motorista', 'despesas', 'divisao-cartoes', 'evolucao-placas', 'media-geral', 'preco-fornecedor', 'preco-postos', 'preco-anp', 'preco-refinaria', 'contratos-anp', 'real-orcado', 'programa-prime',
    'consulta-km', 'mapa-calor', 'roteirizador', 'rodada-precos'].some(pode);
  if (!temDados) { document.getElementById('info-dados').remove(); return; }
  carregarDados().then((d) => {
    const el = document.getElementById('info-dados');
    if (!el) return;
    const g = new Date(d.geradoEm);
    el.textContent = 'Dados atualizados em ' + g.toLocaleDateString('pt-BR') + ' às ' +
      g.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) +
      '. Abastecimentos de ' + fmtDia(d.diaMin) + ' a ' + fmtDia(d.diaMax) + '.';
  }).catch((e) => {
    const el = document.getElementById('info-dados');
    if (el) el.textContent = e.message;
  });
}
