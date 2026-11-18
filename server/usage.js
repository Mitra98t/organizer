// Usage per person (for whoever runs the instance, Settings → Access and usage): per day and area how many sections
// were opened (views, sent by the app when the page changes) and how many changes were saved (writes, counted here
// for every request that changes something; through a token they count as "api"). Only numbers: never what was
// read or written. The sessions keep the address and browser of their last use.
import { acc, touchSession } from './accounts.js';
import { route } from './api.js';
import { clientIp, fail, now, str } from './util.js';

const KEEP_DAYS = 400;
const day = () => now().slice(0, 10);

let n = 0;
export function recordUsage(userId, area, kind) {
  try {
    const t = now();
    acc.prepare(`INSERT INTO usage_daily (user_id, day, area, views, writes, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, day, area) DO UPDATE SET views = views + excluded.views, writes = writes + excluded.writes, last_at = excluded.last_at`)
      .run(userId, day(), area, kind === 'views' ? 1 : 0, kind === 'writes' ? 1 : 0, t, t);
    if (++n % 500 === 1) acc.prepare('DELETE FROM usage_daily WHERE day < ?').run(new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10));
  } catch (e) {
    console.warn('usage not written', e.message); // never stops a request
  }
}

// After every request of someone signed in: the session's last use (once a minute) and, for changes, the area.
const SKIP = new Set(['usage', 'logout', 'events', 'login', 'refs', 'notifications', 'push', 'tour']);
// The first part of the path → the app's area (as the sections in the sidebar), when the route does not say it.
const SEG_AREA = {
  entries: 'voci', logs: 'voci', shares: 'voci', attachments: 'mail', items: 'magazzino', categories: 'magazzino',
  docs: 'documenti', 'doc-notes': 'documenti', 'doc-kinds': 'documenti', projects: 'progetti', contacts: 'contatti',
  trash: 'cestino', me: 'impostazioni', tokens: 'impostazioni', workspaces: 'impostazioni', admin: 'impostazioni',
  invites: 'impostazioni', import: 'impostazioni', feedback: 'impostazioni',
};
const touched = new Map(); // session token → last time written
export function noteRequest(req, { user, token, route: r, path, bearer }) {
  if (!user) return;
  if (token && Date.now() - (touched.get(token) || 0) > 60e3) {
    touched.set(token, Date.now());
    if (touched.size > 5000) touched.clear();
    touchSession(token, str(clientIp(req), 64), str(req.headers['user-agent'], 200));
  }
  if (req.method === 'GET') return;
  const seg = path.split('/')[2] || '';
  if (SKIP.has(seg)) return;
  recordUsage(user.id, bearer ? 'api' : r.area || SEG_AREA[seg] || seg, 'writes');
}

// The app tells which section was opened (the page's group in the sidebar: agenda, mail, magazzino…).
route('POST', '/api/usage', async ({ user, body }) => {
  const b = await body();
  const page = String(b.page || '');
  if (!/^[a-z]{1,20}$/.test(page)) fail(400, 'Invalid page');
  recordUsage(user.id, page, 'views');
}, { ws: false, quiet: true });
