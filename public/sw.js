const CACHE_NAME = 'postos-autorizados-v19';   // v19: tela de login no lugar da lista pública de postos (26/11/2026); v18: notificações no celular (push); v17: logos brancas do Grupo Miranda Coelho (variante monocromática); v16: identidade do grupo (laranja, logo, ícone)
// sem '/' (quem já entrou é redirecionado para a área dele: o cache guardaria a página errada) e sem '/postos.csv' (só com login)
const SHELL_FILES = [
  '/app.css',
  '/app.js',
  '/login.css',
  '/caminhao-rajalog-720.webp',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/logo-grupo-negativo.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE_NAME).then(function (cache) { return cache.addAll(SHELL_FILES); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.filter(function (n) { return n !== CACHE_NAME; })
        .map(function (n) { return caches.delete(n); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  const url = new URL(req.url);

  // só GET do próprio site; login e gestão nunca passam pelo cache
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/gestao')) return;

  // imagens e manifest quase nunca mudam: cache primeiro
  if (url.pathname.endsWith('.png') || url.pathname.endsWith('manifest.json')) {
    event.respondWith(caches.match(req).then(function (c) { return c || fetch(req); }));
    return;
  }

  // resto (página, csv, css, js): rede primeiro; sem sinal, usa o que ficou salvo
  event.respondWith(
    fetch(req).then(function (resp) {
      if (resp.ok) {
        const copia = resp.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(url.pathname, copia); });
      }
      return resp;
    }).catch(function () {
      return caches.match(url.pathname);
    })
  );
});

// Notificações no celular (26/11/2026): a nuvem manda por Web Push (Edge Function notificacoes-push); aqui o aparelho mostra.
// Conteúdo: {titulo, texto, url, tag, nivel}. tag = a ocorrência (o mesmo aviso de novo substitui o anterior, não empilha).
self.addEventListener('push', function (event) {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { texto: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.titulo || 'Gestão de combustível', {
    body: d.texto || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    requireInteraction: d.nivel === 'critico',
    data: { url: d.url || '/gestao/' }
  }));
});

// toque na notificação: abre a tela do aviso (reaproveita a janela do portal se já estiver aberta)
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const alvo = new URL((event.notification.data && event.notification.data.url) || '/gestao/', self.location.origin);
  if (alvo.origin !== self.location.origin) return;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (janelas) {
    for (const j of janelas) {
      if (new URL(j.url).pathname.startsWith('/gestao') && 'focus' in j) {
        return j.focus().then(function (f) { return f && 'navigate' in f ? f.navigate(alvo.href) : f; });
      }
    }
    return self.clients.openWindow(alvo.href);
  }));
});
