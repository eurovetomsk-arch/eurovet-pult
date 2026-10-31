// Сеть первой (чтобы обновления приходили сразу), кэш - запасной вариант без интернета.
const V = 'pult-shell-v0.6.3';
const SHELL = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'vendor/supabase.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // данные Supabase не кэшируем здесь
  // GitHub Pages разрешает браузеру 10 минут держать старые файлы: спрашиваем сервер каждый раз
  const req = e.request.mode === 'navigate' ? new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }) : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(fetch(req).then((r) => { const cp = r.clone(); caches.open(V).then((c) => c.put(e.request, cp)); return r; })
    .catch(() => caches.match(e.request).then((r) => r || caches.match('./'))));
});

// Уведомления о напоминаниях (присылает функция pult-push)
self.addEventListener('push', (e) => {
  let d = { title: 'Ассистент', body: '' };
  try { d = e.data.json(); } catch { /* пустое уведомление */ }
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body, icon: 'icon-512.png', badge: 'icon-180.png', tag: 'pult-remind' }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then((ws) => (ws.length ? ws[0].focus() : clients.openWindow('./'))));
});
