// The access log for whoever runs the instance (see access.js).
import { acc, isOwner } from './accounts.js';
import { route } from './api.js';
import { FAILED } from './access.js';
import { dropped } from './usage.js';
import { fail } from './util.js';

route('GET', '/api/admin/access', ({ user, query }) => {
  if (!isOwner(user.id)) fail(403, 'Only whoever runs the instance sees the access log');
  const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 2000);
  const failedOnly = query.failed === '1';
  const where = failedOnly ? `WHERE l.event IN (${FAILED.map(e => `'${e}'`).join(', ')})` : '';
  const rows = acc.prepare(`SELECT l.id, l.at, l.event, l.user_id, COALESCE(u.username, l.username) AS username, u.name, l.ip, l.country, l.agent
    FROM access_log l LEFT JOIN users u ON u.id = l.user_id ${where} ORDER BY l.id DESC LIMIT ?`).all(limit);
  const day = new Date(Date.now() - 864e5).toISOString();
  const failed24h = acc.prepare(`SELECT COUNT(*) AS n FROM access_log WHERE at > ? AND event IN (${FAILED.map(e => `'${e}'`).join(', ')})`).get(day).n;
  const ips24h = acc.prepare(`SELECT COUNT(DISTINCT ip) AS n FROM access_log WHERE at > ? AND event IN (${FAILED.map(e => `'${e}'`).join(', ')})`).get(day).n;
  return { rows, failed24h, ips24h, failed: FAILED };
}, { ws: false });

// Usage per person over the last `days` days: sections opened and changes saved per area and per day, last use,
// sessions (devices) and tokens, and how many times each one involved the others (mentions, assignments, shares,
// chat: from the notifications). Only numbers, never contents.
route('GET', '/api/admin/usage', ({ user, query }) => {
  if (!isOwner(user.id)) fail(403, 'Only whoever runs the instance sees the access log');
  const days = Math.min(Math.max(Number(query.days) || 30, 1), 365);
  const since = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
  const users = acc.prepare('SELECT id, username, name, created_at FROM users ORDER BY name COLLATE NOCASE').all();
  const q = {
    areas: acc.prepare(`SELECT area, SUM(views) AS views, SUM(writes) AS writes FROM usage_daily WHERE user_id = ? AND day >= ?
      GROUP BY area ORDER BY SUM(views) + SUM(writes) DESC`),
    perDay: acc.prepare('SELECT day, SUM(views) AS views, SUM(writes) AS writes FROM usage_daily WHERE user_id = ? AND day >= ? GROUP BY day ORDER BY day'),
    last: acc.prepare('SELECT MAX(last_at) AS at FROM usage_daily WHERE user_id = ?'),
    lastLogin: acc.prepare("SELECT MAX(at) AS at FROM access_log WHERE user_id = ? AND event = 'login'"),
    sessions: acc.prepare('SELECT created_at, last_seen, ip, agent FROM sessions WHERE user_id = ? ORDER BY last_seen DESC LIMIT 10'),
    tokens: acc.prepare('SELECT name, hint, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY COALESCE(last_used_at, created_at) DESC'),
    workspaces: acc.prepare(`SELECT w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ? AND w.deleted_at IS NULL AND w.tour_of IS NULL ORDER BY w.id`),
    requests: acc.prepare('SELECT COALESCE(SUM(app), 0) AS app, COALESCE(SUM(api), 0) AS api, COALESCE(SUM(errors), 0) AS errors FROM request_daily WHERE user_id = ? AND day >= ?'),
    involved: acc.prepare(`SELECT user_id, COUNT(*) AS n FROM notifications WHERE actor_id = ? AND user_id != actor_id AND created_at >= ?
      GROUP BY user_id ORDER BY n DESC`),
  };
  return {
    days,
    since,
    users: users.map(u => {
      const perDay = q.perDay.all(u.id, since);
      return {
        ...u,
        lastUse: q.last.get(u.id).at,
        lastLogin: q.lastLogin.get(u.id).at,
        activeDays: perDay.length,
        views: perDay.reduce((s, d) => s + d.views, 0),
        writes: perDay.reduce((s, d) => s + d.writes, 0),
        perDay,
        areas: q.areas.all(u.id, since),
        sessions: q.sessions.all(u.id),
        tokens: q.tokens.all(u.id),
        workspaces: q.workspaces.all(u.id),
        involved: q.involved.all(u.id, since),
        requests: q.requests.get(u.id, since),
      };
    }),
  };
}, { ws: false });

// API requests: with a token (CLI, bots, Thunderbird) and without login (refused, nonexistent endpoints, logins),
// newest first; who = token | anon, errors = 1 only those that ended with an error. With a summary per token (7 days)
// and of the requests without login (24 hours: how many, from how many addresses, the most frequent ones).
route('GET', '/api/admin/requests', ({ user, query }) => {
  if (!isOwner(user.id)) fail(403, 'Only whoever runs the instance sees the access log');
  const limit = Math.min(Math.max(Number(query.limit) || 300, 1), 5000);
  const where = [
    query.who === 'token' && 'l.token_id IS NOT NULL',
    query.who === 'anon' && 'l.user_id IS NULL',
    query.errors === '1' && 'l.status >= 400',
  ].filter(Boolean);
  const rows = acc.prepare(`SELECT l.id, l.at, l.user_id, u.username, u.name, l.token_id, l.token_name, l.method, l.route, l.path, l.status, l.ms, l.ip, l.agent
    FROM api_log l LEFT JOIN users u ON u.id = l.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.id DESC LIMIT ?`).all(limit);
  const week = new Date(Date.now() - 7 * 864e5).toISOString();
  const day = new Date(Date.now() - 864e5).toISOString();
  return {
    rows,
    tokens: acc.prepare(`SELECT l.token_id, l.token_name, u.username, COUNT(*) AS n, SUM(l.status >= 400) AS errors, MAX(l.at) AS last
      FROM api_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.token_id IS NOT NULL AND l.at > ? GROUP BY l.token_id ORDER BY n DESC`).all(week),
    anon: {
      n: acc.prepare('SELECT COUNT(*) AS n FROM api_log WHERE user_id IS NULL AND at > ?').get(day).n,
      refused: acc.prepare('SELECT COUNT(*) AS n FROM api_log WHERE user_id IS NULL AND at > ? AND status >= 400').get(day).n,
      ips: acc.prepare(`SELECT ip, COUNT(*) AS n, SUM(status >= 400) AS refused, MAX(at) AS last FROM api_log WHERE user_id IS NULL AND at > ?
        GROUP BY ip ORDER BY n DESC LIMIT 8`).all(day),
      // Endpoints that do not exist by their path (what a scanner looks for), the others by their pattern.
      routes: acc.prepare(`SELECT method, CASE route WHEN '(unknown)' THEN path ELSE route END AS route, COUNT(*) AS n FROM api_log
        WHERE user_id IS NULL AND at > ? GROUP BY 1, 2 ORDER BY n DESC LIMIT 8`).all(day),
    },
    dropped: dropped.n,
  };
}, { ws: false });
