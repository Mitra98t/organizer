// Notification routes (see notify.js): read, opening from a system notification, push subscriptions.
import { acc } from './accounts.js';
import { route } from './api.js';
import { vapidPublic } from './push.js';
import { pushTo } from './notify.js';
import { fail, now, str, isHttps } from './util.js';
import { trIn } from './i18n.js';

// Mark as read: some (ids), those leading to an address (url, e.g. the entry just opened) or all.
route('POST', '/api/notifications/read', async ({ user, body }) => {
  const b = await body();
  const t = now();
  if (b.all) acc.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(t, user.id);
  for (const id of Array.isArray(b.ids) ? b.ids.slice(0, 200) : []) {
    acc.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').run(t, +id, user.id);
  }
  if (b.url) acc.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND url = ? AND read_at IS NULL').run(t, user.id, str(b.url, 300));
}, { ws: false });

// A system notification opens #/n/ID: where it leads (and in which workspace); meanwhile it is read.
route('GET', '/api/notifications/:id', ({ user, params }) => {
  const n = acc.prepare('SELECT id, workspace_id, url FROM notifications WHERE id = ? AND user_id = ?').get(+params.id, user.id) || fail(404, 'Notification not found');
  acc.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?').run(now(), n.id);
  return n;
}, { ws: false, quiet: true });

route('GET', '/api/push/key', () => ({ key: vapidPublic }), { ws: false });

// A device (browser or installed app) that wants notifications with the app closed too.
route('POST', '/api/push/subscribe', async ({ req, user, body }) => {
  const b = await body();
  const endpoint = str(b.endpoint, 1000);
  if (!/^https:\/\//.test(endpoint) || !b.keys?.p256dh || !b.keys?.auth) fail(400, 'Invalid subscription');
  // The site's address (e.g. https://organizer.example.com): Apple's push service wants it as the sender.
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
  if (!n) fail(409, 'No device with notifications turned on');
  pushTo(user.id, { title: 'Organizer', body: trIn(user.lang, 'Notifications work on this device.'), url: '#/impostazioni/notifiche', tag: 'test' });
  return { devices: n };
}, { ws: false, quiet: true });
