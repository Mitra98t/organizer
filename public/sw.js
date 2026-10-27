// Service worker: rete prima, cache come ripiego. Così l'app si apre anche offline
// e mostra gli ultimi dati (salvati dall'app in localStorage). Le API non passano dalla cache.
const CACHE = 'organizer-v14';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/core.js', 'js/views.js', 'js/parse.js', 'js/autocomplete.js', 'js/mail.js', 'js/contacts.js', 'js/trash.js', 'js/docview.js', 'js/documents.js', 'js/dnd.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
    fetch(ev.request)
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
