// The access log for whoever runs the instance (see access.js).
import { acc, isOwner } from './accounts.js';
import { route } from './api.js';
import { FAILED } from './access.js';
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
