// Notifiche: chi viene citato (+persona nelle voci, negli aggiornamenti, nelle note sui documenti e in chat),
// chi riceve una voce assegnata o condivisa, chi riceve una mail (posta in arrivo da Thunderbird), i membri
// di un canale a ogni messaggio (nei canali silenziati solo se citati). Restano nell'app (la campanella) e
// arrivano anche come notifica di sistema sui dispositivi dove sono state attivate (push).
import { acc } from './accounts.js';
import { bump } from './events.js';
import { sendPush } from './push.js';
import { now } from './util.js';

const KEEP = 200; // per persona: le più vecchie si cancellano
const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

// userIds: a chi (chi ha fatto l'azione non riceve niente). tag: le notifiche con lo stesso tag si sostituiscono
// sul dispositivo (es. i messaggi di un canale).
export function notify(userIds, { ws = null, kind, title, body = '', url = '', actor = null, tag = null }) {
  // Solo account veri (nel workspace di prova del giro ci sono anche persone finte).
  const to = [...new Set(userIds)].filter(id => id && id !== actor && acc.prepare('SELECT 1 FROM users WHERE id = ?').get(id));
  for (const uid of to) {
    const id = Number(acc.prepare(`INSERT INTO notifications (user_id, workspace_id, kind, title, body, url, actor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(uid, ws, kind, clip(title, 200), clip(body, 400), url, actor, now()).lastInsertRowid);
    acc.prepare('DELETE FROM notifications WHERE user_id = ? AND id <= ?').run(uid, id - KEEP);
    pushTo(uid, { id, title: clip(title, 120), body: clip(body, 200), url: `#/n/${id}`, tag: tag || `n${id}` });
  }
  if (to.length) bump(null);
}

// Ai dispositivi iscritti, senza aspettare: le iscrizioni scadute (404/410) si tolgono.
export function pushTo(userId, data) {
  for (const sub of acc.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId)) {
    sendPush(sub, data).then(status => {
      if (status === 404 || status === 410) acc.prepare('DELETE FROM push_subs WHERE id = ?').run(sub.id);
      else if (status >= 400) console.warn(`push ${status} per l'utente ${userId}`);
    }, e => console.warn('push non mandata', e.message));
  }
}

// +nome nel testo → id dei membri citati (username o nome, come nella barra rapida).
export function mentionedIn(text, members) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/(?:^|[\s(,;:])\+\+?([\p{L}][\p{L}\d_.-]*[\p{L}\d_]|[\p{L}])/gu)) {
    const n = m[1].toLowerCase();
    const u = members.find(x => x.username.toLowerCase() === n || (x.name || '').toLowerCase() === n);
    if (u) out.add(u.id);
  }
  return [...out];
}

// Per /api/sync: le ultime notifiche della persona (di tutti i workspace) e quante sono da leggere.
export function notificationsOf(userId) {
  return {
    notifications: acc.prepare(`SELECT id, workspace_id, kind, title, body, url, actor_id, created_at, read_at FROM notifications
      WHERE user_id = ? ORDER BY id DESC LIMIT 40`).all(userId),
    notifUnread: acc.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n,
    pushDevices: acc.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get(userId).n,
  };
}
