// Access log: who got in, who tried and failed, from where. In accounts.db (one for the whole instance), seen only by
// whoever runs it (isOwner): Settings → Access, or `make access` in the terminal.
// Events: login (app or CLI), login_failed, login_blocked (too many attempts), logout, setup, register,
// register_failed, password_changed, password_failed (wrong current password), password_reset (from the server's
// terminal), token_created, token_revoked, token_refused (a request with an unknown or revoked token).
import { acc } from './accounts.js';
import { notify } from './notify.js';
import { clientIp, now, str } from './util.js';

export const ACCESS_EVENTS = ['login', 'login_failed', 'login_blocked', 'logout', 'setup', 'register', 'register_failed',
  'password_changed', 'password_failed', 'password_reset', 'token_created', 'token_revoked', 'token_refused'];
export const FAILED = ['login_failed', 'login_blocked', 'register_failed', 'password_failed', 'token_refused'];
const KEEP_DAYS = 365;

// Behind Cloudflare the country of the address comes in a header; trusted only together with the real address
// (CLIENT_IP_HEADER: the app is then reachable only through the tunnel).
const TRUST_CF = Boolean(process.env.CLIENT_IP_HEADER);

let written = 0;
export function logAccess(req, event, { userId = null, username = '' } = {}) {
  try {
    acc.prepare(`INSERT INTO access_log (at, event, user_id, username, ip, country, agent) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(now(), event, userId, str(username, 64), req ? str(clientIp(req), 64) : '', req && TRUST_CF ? str(req.headers['cf-ipcountry'], 4) : '',
        req ? str(req.headers['user-agent'], 200) : 'server terminal');
    if (++written % 200 === 1) {
      acc.prepare('DELETE FROM access_log WHERE at < ?').run(new Date(Date.now() - KEEP_DAYS * 864e5).toISOString());
    }
  } catch (e) {
    console.warn('access log not written', e.message); // never blocks a login
  }
}

// How many failed attempts since a moment (ISO).
export const failedSince = at => acc.prepare(`SELECT COUNT(*) AS n FROM access_log WHERE at > ? AND event IN (${FAILED.map(e => `'${e}'`).join(', ')})`).get(at).n;

// Repeated events of one source (blocked attempts, refused tokens) are written at most once a minute each.
const lastSeen = new Map();
export function logAccessOnce(req, event, key, extra) {
  const k = `${event}|${key}`;
  if (Date.now() - (lastSeen.get(k) || 0) < 60e3) return;
  lastSeen.set(k, Date.now());
  if (lastSeen.size > 5000) lastSeen.clear();
  logAccess(req, event, extra);
}

// An account blocked for too many wrong passwords: whoever runs the instance is told (once per account and address
// every 15 minutes, like the block).
export function alertBlocked(req, username) {
  const k = `alert|${clientIp(req)}|${String(username).toLowerCase()}`;
  if (Date.now() - (lastSeen.get(k) || 0) < 15 * 60e3) return;
  lastSeen.set(k, Date.now());
  const first = acc.prepare('SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY id LIMIT 1').get();
  if (!first) return;
  const owners = acc.prepare("SELECT user_id FROM memberships WHERE workspace_id = ? AND role = 'admin'").all(first.id).map(r => r.user_id);
  const country = TRUST_CF ? str(req.headers['cf-ipcountry'], 4) : '';
  notify(owners, {
    kind: 'security',
    title: ['Too many wrong passwords for "{name}"', { name: str(username, 64) }],
    body: ['Login blocked for 15 minutes for {ip}{country}. Settings → Access shows the attempts.', { ip: clientIp(req), country: country ? ` (${country})` : '' }],
    url: '#/impostazioni/accessi',
    tag: 'access-blocked',
  });
}
