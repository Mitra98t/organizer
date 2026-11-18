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

// Every request of someone signed in, when its answer is over (status and time known, errors too): counted per person
// and day (app or token, errors); with a token also written one by one in api_log, without the query (it may hold
// searched text) and without bodies.
const API_KEEP_DAYS = 90;
const tokenNames = new Map(); // token id → name
let calls = 0;
// Public calls that went well and come from every visit (the login page asks who is signed in, the CLI and the app
// ask the version): not written one by one.
const ROUTINE = new Set(['GET /api/info', 'GET /api/me', 'GET /api/changelog']);
// At most 60 lines a minute per address without login (a scanner does not fill the database); the others are counted.
const perIp = new Map(); // ip → { minute, n }
export const dropped = { n: 0 };
export function noteApiCall(req, res, { user, route: r, path, bearer, ms }) {
  try {
    const status = res.statusCode || 0;
    if (user) {
      acc.prepare(`INSERT INTO request_daily (user_id, day, app, api, errors) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (user_id, day) DO UPDATE SET app = app + excluded.app, api = api + excluded.api, errors = errors + excluded.errors`)
        .run(user.id, day(), bearer ? 0 : 1, bearer ? 1 : 0, status >= 400 ? 1 : 0);
      if (!bearer) return; // the app's own requests: only counted
    } else if (status < 400 && r && ROUTINE.has(`${req.method} ${r.pattern}`)) return;
    const ip = str(clientIp(req), 64);
    if (!user) {
      const minute = Math.floor(Date.now() / 60e3);
      const c = perIp.get(ip);
      if (c?.minute === minute && c.n >= 60) {
        dropped.n++;
        return;
      }
      perIp.set(ip, c?.minute === minute ? { minute, n: c.n + 1 } : { minute, n: 1 });
      if (perIp.size > 5000) perIp.clear();
    }
    const tokenId = user?.api_token ?? null;
    if (tokenId && !tokenNames.has(tokenId)) tokenNames.set(tokenId, acc.prepare('SELECT name FROM api_tokens WHERE id = ?').get(tokenId)?.name || '');
    acc.prepare(`INSERT INTO api_log (at, user_id, token_id, token_name, method, route, path, status, ms, ip, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(now(), user?.id ?? null, tokenId, tokenId ? tokenNames.get(tokenId) : (bearer ? '(invalid token)' : ''), str(req.method, 10),
        r?.pattern || '(unknown)', str(path, 300), status, Math.round(ms), ip, str(req.headers['user-agent'], 200));
    if (++calls % 1000 === 1) {
      acc.prepare('DELETE FROM api_log WHERE at < ?').run(new Date(Date.now() - API_KEEP_DAYS * 864e5).toISOString());
      acc.prepare('DELETE FROM request_daily WHERE day < ?').run(new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10));
    }
  } catch (e) {
    console.warn('API request not written', e.message);
  }
}

// The app tells which section was opened (the page's group in the sidebar: agenda, mail, magazzino…).
route('POST', '/api/usage', async ({ user, body }) => {
  const b = await body();
  const page = String(b.page || '');
  if (!/^[a-z]{1,20}$/.test(page)) fail(400, 'Invalid page');
  recordUsage(user.id, page, 'views');
}, { ws: false, quiet: true });
