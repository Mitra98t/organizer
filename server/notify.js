// Notifications: whoever is mentioned (+person in entries, updates, notes on documents and chat), whoever gets an
// entry assigned or shared, whoever receives a mail (inbox from Thunderbird), a channel's members at every message
// (in muted channels only when mentioned). They stay in the app (the bell) and also arrive as system notifications
// on the devices where they were turned on (push).
import { acc, langOfUser } from './accounts.js';
import { trIn } from './i18n.js';
import { bump } from './events.js';
import { sendPush } from './push.js';
import { now } from './util.js';

const KEEP = 200; // per person: the oldest are deleted
const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

// userIds: to whom (whoever did the action gets nothing). tag: notifications with the same tag replace each other
// on the device (e.g. a channel's messages). title and body are text, or [English template, placeholders]
// translated into each recipient's language.
export function notify(userIds, { ws = null, kind, title: title0, body: body0 = '', url = '', actor = null, tag = null }) {
  // Only real accounts (the tour's demo workspace also has fake people).
  const to = [...new Set(userIds)].filter(id => id && id !== actor && acc.prepare('SELECT 1 FROM users WHERE id = ?').get(id));
  for (const uid of to) {
    const lang = langOfUser(uid);
    const text = x => (Array.isArray(x) ? trIn(lang, x[0], x[1]) : x);
    const [title, body] = [text(title0), text(body0)];
    const id = Number(acc.prepare(`INSERT INTO notifications (user_id, workspace_id, kind, title, body, url, actor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(uid, ws, kind, clip(title, 200), clip(body, 400), url, actor, now()).lastInsertRowid);
    acc.prepare('DELETE FROM notifications WHERE user_id = ? AND id <= ?').run(uid, id - KEEP);
    pushTo(uid, { id, title: clip(title, 120), body: clip(body, 200), url: `#/n/${id}`, tag: tag || `n${id}` });
  }
  if (to.length) bump(null);
}

// To the subscribed devices, without waiting: expired subscriptions (404/410) are removed.
export function pushTo(userId, data) {
  for (const sub of acc.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId)) {
    sendPush(sub, data).then(status => {
      if (status === 404 || status === 410) acc.prepare('DELETE FROM push_subs WHERE id = ?').run(sub.id);
      else if (status >= 400) console.warn(`push ${status} for user ${userId}`);
    }, e => console.warn('push not sent', e.message));
  }
}

// +name in the text → ids of the mentioned members (username or name, as in the quick bar).
export function mentionedIn(text, members) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/(?:^|[\s(,;:])\+\+?([\p{L}][\p{L}\d_.-]*[\p{L}\d_]|[\p{L}])/gu)) {
    const n = m[1].toLowerCase();
    const u = members.find(x => x.username.toLowerCase() === n || (x.name || '').toLowerCase() === n);
    if (u) out.add(u.id);
  }
  return [...out];
}

// For /api/sync: the person's latest notifications (of every workspace) and how many are unread.
export function notificationsOf(userId) {
  return {
    notifications: acc.prepare(`SELECT id, workspace_id, kind, title, body, url, actor_id, created_at, read_at FROM notifications
      WHERE user_id = ? ORDER BY id DESC LIMIT 40`).all(userId),
    notifUnread: acc.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n,
    pushDevices: acc.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get(userId).n,
  };
}
