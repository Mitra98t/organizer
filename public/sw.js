// Service worker: rete prima, cache come ripiego. Così l'app si apre anche offline
// e mostra gli ultimi dati (salvati dall'app in localStorage). Le API non passano dalla cache.
//
// I file si ricontrollano sempre con il server (cache: 'no-cache'), qualunque cosa dica la cache HTTP: dietro
// Cloudflare JS e CSS arrivano con "tienili 4 ore" e dopo un aggiornamento l'app userebbe il codice vecchio.
// Con l'ETag un file non cambiato non si riscarica (risposta 304).
const CACHE = 'organizer-v51';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/core.js', 'js/views.js', 'js/parse.js', 'js/autocomplete.js', 'js/mail.js', 'js/contacts.js', 'js/trash.js', 'js/docview.js', 'js/documents.js', 'js/dnd.js', 'js/chat.js', 'js/changelog.js', 'js/themes.js', 'js/perms.js', 'js/model3d.js', 'js/step-worker.js', 'js/feedback.js', 'js/notifiche.js', 'js/tour.js', 'js/cad.js', 'js/topics.js', 'js/pickers.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

const fresh = req => fetch(req.mode === 'navigate'
  ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }) // una navigazione non si copia con opzioni
  : new Request(req, { cache: 'no-cache' }));

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'no-cache' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', ev => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  ev.respondWith(
    fresh(ev.request)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(ev.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(ev.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))),
  );
});

// Notifiche push (server/push.js): { title, body, url, tag }. url è #/n/ID: l'app apre ciò a cui porta.
self.addEventListener('push', ev => {
  let d = {};
  try {
    d = ev.data ? ev.data.json() : {};
  } catch { /* messaggio non leggibile: si mostra comunque qualcosa */ }
  ev.waitUntil(self.registration.showNotification(d.title || 'Organizer', {
    body: d.body || '', tag: d.tag, renotify: !!d.tag, data: { url: d.url || '#/agenda' },
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
  }));
});

// Clic sulla notifica: si usa una finestra dell'app già aperta (portandola davanti), altrimenti se ne apre una.
self.addEventListener('notificationclick', ev => {
  ev.notification.close();
  const url = new URL(`./${ev.notification.data?.url || '#/agenda'}`, self.registration.scope).href;
  ev.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => w.url.startsWith(self.registration.scope));
    if (win) {
      await win.focus();
      return win.navigate ? win.navigate(url) : win.postMessage({ open: url });
    }
    return self.clients.openWindow(url);
  })());
});
