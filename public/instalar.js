// Faixa "Instalar o aplicativo" na tela de login e na área do motorista (27/11/2026, pedido do usuário: "A tela de login e o acesso
// dos motoristas ficou sem a opção de baixar para aplicativo"). Substitui a faixa da página antiga de postos (saiu com o login v2).
//  - Android / Chrome no computador: botão "Instalar" (pedido do próprio navegador, beforeinstallprompt);
//  - iPhone / iPad (Safari): "Como instalar" abre o passo a passo (Compartilhar > Adicionar à Tela de Início);
//  - já instalado (aberto pelo ícone): não aparece; fechou no X: some por 7 dias.
// Também registra o service worker (sem ele o navegador não oferece a instalação).
(function () {
  'use strict';
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});

  var CHAVE = 'instalar-fechado', SETE_DIAS = 7 * 864e5;
  var instalado = matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (instalado) return;
  try { var fechou = Number(localStorage.getItem(CHAVE)) || 0; if (Date.now() - fechou < SETE_DIAS) return; } catch (e) { /* sem armazenamento: mostra */ }

  var css = '' +
    '.inst-faixa{position:fixed;left:12px;right:12px;bottom:12px;z-index:1000;max-width:520px;margin:0 auto;display:flex;align-items:center;gap:12px;' +
    'padding:12px 12px 12px 14px;border-radius:12px;background:#262626;color:#fff;box-shadow:0 8px 28px rgba(0,0,0,.45);font:500 14px/1.35 "Plus Jakarta Sans",system-ui,sans-serif;}' +
    '.inst-faixa[hidden],.inst-ajuda[hidden]{display:none;}' +
    '.inst-icone{width:40px;height:40px;border-radius:10px;flex-shrink:0;}' +
    '.inst-txt{flex:1 1 auto;min-width:0;}.inst-txt small{display:block;color:#b8b8b8;font-weight:400;font-size:12px;margin-top:2px;}' +
    '.inst-btn{flex-shrink:0;height:38px;padding:0 16px;border:0;border-radius:8px;background:#F6A42B;color:#161616;font:600 14px "Plus Jakarta Sans",system-ui,sans-serif;cursor:pointer;}' +
    '.inst-x{flex-shrink:0;width:32px;height:32px;border:0;border-radius:8px;background:none;color:#b8b8b8;font-size:22px;line-height:1;cursor:pointer;}' +
    '.inst-x:hover{background:rgba(255,255,255,.08);color:#fff;}' +
    '.inst-btn:focus-visible,.inst-x:focus-visible{outline:2px solid #F6A42B;outline-offset:2px;}' +
    '.inst-ajuda{position:fixed;inset:0;z-index:1001;display:flex;align-items:flex-end;justify-content:center;padding:16px;background:rgba(0,0,0,.6);}' +
    '.inst-ajuda-in{width:100%;max-width:420px;padding:20px;border-radius:14px;background:#262626;color:#fff;font:400 15px/1.5 "Plus Jakarta Sans",system-ui,sans-serif;}' +
    '.inst-ajuda h2{margin:0 0 10px;font-size:17px;font-weight:600;}.inst-ajuda ol{margin:0 0 16px;padding-left:20px;}.inst-ajuda li{margin:4px 0;}' +
    '.inst-ajuda .inst-btn{width:100%;}' +
    'body.com-inst{padding-bottom:104px;}';   /* espaço para a faixa não cobrir o fim da página */
  var estilo = document.createElement('style');
  estilo.textContent = css;
  document.head.appendChild(estilo);

  var faixa = document.createElement('div');
  faixa.className = 'inst-faixa';
  faixa.hidden = true;
  faixa.setAttribute('role', 'region');
  faixa.setAttribute('aria-label', 'Instalar o aplicativo');
  faixa.innerHTML = '<img class="inst-icone" src="/icon-192.png" alt="">' +
    '<div class="inst-txt">Instale o aplicativo no celular<small>Abre mais rápido, direto pelo ícone na tela inicial.</small></div>' +
    '<button type="button" class="inst-btn">' + (ios ? 'Como instalar' : 'Instalar') + '</button>' +
    '<button type="button" class="inst-x" aria-label="Fechar">×</button>';

  var ajuda = document.createElement('div');
  ajuda.className = 'inst-ajuda';
  ajuda.hidden = true;
  ajuda.setAttribute('role', 'dialog');
  ajuda.setAttribute('aria-modal', 'true');
  ajuda.setAttribute('aria-label', 'Como instalar no iPhone');
  ajuda.innerHTML = '<div class="inst-ajuda-in"><h2>Instalar no iPhone</h2><ol>' +
    '<li>Abra esta página no <strong>Safari</strong>.</li>' +
    '<li>Toque em <strong>Compartilhar</strong> (o quadrado com a seta para cima).</li>' +
    '<li>Escolha <strong>Adicionar à Tela de Início</strong> e toque em <strong>Adicionar</strong>.</li></ol>' +
    '<button type="button" class="inst-btn">Entendi</button></div>';

  function pronto() { document.body.appendChild(faixa); document.body.appendChild(ajuda); }
  if (document.body) pronto(); else document.addEventListener('DOMContentLoaded', pronto);

  var pedido = null;
  function mostrar() { faixa.hidden = false; document.body.classList.add('com-inst'); }
  function esconder(lembrar) {
    faixa.hidden = true;
    document.body.classList.remove('com-inst');
    if (lembrar) { try { localStorage.setItem(CHAVE, String(Date.now())); } catch (e) { /* sem armazenamento */ } }
  }
  faixa.querySelector('.inst-x').addEventListener('click', function () { esconder(true); });
  faixa.querySelector('.inst-btn').addEventListener('click', function () {
    if (ios) { ajuda.hidden = false; ajuda.querySelector('.inst-btn').focus(); return; }
    if (!pedido) return;
    pedido.prompt();
    pedido.userChoice.then(function (r) { if (r && r.outcome === 'accepted') esconder(false); pedido = null; });
  });
  ajuda.querySelector('.inst-btn').addEventListener('click', function () { ajuda.hidden = true; });
  ajuda.addEventListener('click', function (e) { if (e.target === ajuda) ajuda.hidden = true; });

  if (ios) {
    if (document.body) mostrar(); else document.addEventListener('DOMContentLoaded', mostrar);   // no iPhone não há o pedido do navegador: a faixa explica como instalar
  } else {
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); pedido = e; mostrar(); });
  }
  window.addEventListener('appinstalled', function () { esconder(false); });
})();
