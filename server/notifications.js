// Route delle notifiche (vedi notify.js): lette, apertura da una notifica di sistema, iscrizioni push.
import { acc } from './accounts.js';
import { route } from './api.js';
import { vapidPublic } from './push.js';
import { pushTo } from './notify.js';
import { fail, now, str, isHttps } from './util.js';

// Segna lette: alcune (ids), quelle che portano a un indirizzo (url, es. la voce appena aperta) o tutte.
route('POST', '/api/notifications/read', async ({ user, body }) => {
  const b = await body();
  const t = now();
  if (b.all) acc.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(t, user.id);
  for (const id of Array.isArray(b.ids) ? b.ids.slice(0, 200) : []) {
    acc.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').run(t, +id, user.id);
  }
  if (b.url) acc.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND url = ? AND read_at IS NULL').run(t, user.id, str(b.url, 300));
}, { ws: false });

// Da una notifica di sistema si apre #/n/ID: dove porta (e in che workspace); intanto è letta.
route('GET', '/api/notifications/:id', ({ user, params }) => {
  const n = acc.prepare('SELECT id, workspace_id, url FROM notifications WHERE id = ? AND user_id = ?').get(+params.id, user.id) || fail(404, 'Notifica non trovata');
  acc.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?').run(now(), n.id);
  return n;
}, { ws: false, quiet: true });

route('GET', '/api/push/key', () => ({ key: vapidPublic }), { ws: false });

// Un dispositivo (browser o app installata) che vuole le notifiche anche ad app chiusa.
route('POST', '/api/push/subscribe', async ({ req, user, body }) => {
  const b = await body();
  const endpoint = str(b.endpoint, 1000);
  if (!/^https:\/\//.test(endpoint) || !b.keys?.p256dh || !b.keys?.auth) fail(400, 'Iscrizione non valida');
  // L'indirizzo del sito (es. https://organizer.example.com): il servizio push di Apple lo vuole come mittente.
  const origin = `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
  acc.prepare(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth, client, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, origin = excluded.origin`)
    .run(user.id, endpoint, str(b.keys.p256dh, 200), str(b.keys.auth, 100), str(req.headers['user-agent'], 300), origin, now());
}, { ws: false, quiet: true });

route('POST', '/api/push/unsubscribe', async ({ user, body }) => {
  acc.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(user.id, str((await body()).endpoint, 1000));
}, { ws: false, quiet: true });

route('POST', '/api/push/test', ({ user }) => {
  const n = acc.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get(user.id).n;
  if (!n) fail(409, 'Nessun dispositivo con le notifiche attive');
  pushTo(user.id, { title: 'Organizer', body: 'Le notifiche funzionano su questo dispositivo.', url: '#/impostazioni/notifiche', tag: 'test' });
  return { devices: n };
}, { ws: false, quiet: true });
