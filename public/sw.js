// Service worker: network first, cache as a fallback. So the app opens offline too and shows the latest data
// (saved by the app in localStorage). The API does not go through the cache.
//
// Files are always re-checked with the server (cache: 'no-cache'), whatever the HTTP cache says: behind Cloudflare
// JS and CSS arrive with "keep them 4 hours" and after an update the app would use the old code.
// With the ETag an unchanged file is not downloaded again (304 response).
const CACHE = 'organizer-v78';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/core.js', 'js/views.js', 'js/parse.js', 'js/autocomplete.js', 'js/mail.js', 'js/contacts.js', 'js/trash.js', 'js/docview.js', 'js/documents.js', 'js/dnd.js', 'js/chat.js', 'js/changelog.js', 'js/themes.js', 'js/perms.js', 'js/model3d.js', 'js/step-worker.js', 'js/feedback.js', 'js/notifiche.js', 'js/tour.js', 'js/cad.js', 'js/topics.js', 'js/pickers.js', 'js/tabbar.js', 'js/palette.js', 'js/appicons.js', 'js/i18n.js',
  'js/locales/it.js', 'js/locales/it/ac.js', 'js/locales/it/app.js', 'js/locales/it/common.js', 'js/locales/it/core.js', 'js/locales/it/docs.js', 'js/locales/it/docview.js', 'js/locales/it/mail.js', 'js/locales/it/palette.js', 'js/locales/it/people.js', 'js/locales/it/small.js', 'js/locales/it/topics.js', 'js/locales/it/tour.js', 'js/locales/it/views.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

const fresh = req => fetch(req.mode === 'navigate'
  ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }) // a navigation cannot be copied with options
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

// Push notifications (server/push.js): { title, body, url, tag }. url is #/n/ID: the app opens what it leads to.
self.addEventListener('push', ev => {
  let d = {};
  try {
    d = ev.data ? ev.data.json() : {};
  } catch { /* unreadable message: show something anyway */ }
  ev.waitUntil(self.registration.showNotification(d.title || 'Organizer', {
    body: d.body || '', tag: d.tag, renotify: !!d.tag, data: { url: d.url || '#/agenda' },
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
  }));
});

// Click on the notification: use an app window already open (bringing it to the front), otherwise open one.
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
