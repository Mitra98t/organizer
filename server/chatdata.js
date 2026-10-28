// Canali della chat: chi legge, chi scrive, quanti messaggi non letti. Senza dipendenze da api.js perché lo
// usano sia le route della chat (chat.js) sia /api/sync.
//   everyone = 1: tutti i membri del workspace leggono e scrivono (es. "generale");
//   altrimenti chat_members, con can_write 0 per chi può solo leggere.
import { db } from './db.js';

export const CHAT_IN_SYNC = 100; // ultimi messaggi per canale in /api/sync; i precedenti con /api/chat?before=

// Chi crea, rinomina, elimina i canali e ne sceglie le persone: gli admin e chi ha il permesso "canali".
export const canManageChannels = user => !!user?.is_admin || user?.perms?.canali === 'write';

// I canali che l'utente legge, con can_write.
export function myChannels(uid) {
  return db.prepare(`SELECT c.id, c.name, c.everyone, CASE WHEN c.everyone = 1 THEN 1 ELSE m.can_write END AS can_write
    FROM chat_channels c LEFT JOIN chat_members m ON m.channel_id = c.id AND m.user_id = $uid
    WHERE c.deleted_at IS NULL AND (c.everyone = 1 OR m.user_id IS NOT NULL) ORDER BY c.id`).all({ uid });
}

// Per l'ETag di /api/sync: cambia quando l'utente legge (le letture non mandano notifiche a nessuno).
export const readKey = uid => db.prepare('SELECT COALESCE(SUM(read_id), 0) AS n FROM chat_reads WHERE user_id = ?').get(uid).n;

// Canali, messaggi recenti e non letti per /api/sync. Chi gestisce i canali li vede tutti (per gestirli),
// ma i messaggi solo di quelli in cui è dentro.
export function chatSync(user) {
  const uid = user.id;
  const mine = myChannels(uid);
  const ids = mine.map(c => c.id);
  const manage = canManageChannels(user);
  const all = manage ? db.prepare('SELECT id, name, everyone FROM chat_channels WHERE deleted_at IS NULL ORDER BY id').all() : mine;
  const members = db.prepare('SELECT user_id, can_write FROM chat_members WHERE channel_id = ?');
  const read = db.prepare('SELECT read_id FROM chat_reads WHERE channel_id = ? AND user_id = ?');
  const unread = db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE channel_id = ? AND deleted_at IS NULL AND user_id != ? AND id > ?');
  const channels = all.map(c => {
    const m = mine.find(x => x.id === c.id);
    const readId = m ? read.get(c.id, uid)?.read_id ?? 0 : 0;
    return {
      id: c.id, name: c.name, everyone: c.everyone, member: !!m, can_write: m ? m.can_write : 0,
      members: c.everyone ? [] : members.all(c.id), read_id: readId, unread: m ? unread.get(c.id, uid, readId).n : 0,
    };
  });
  const chat = ids.length ? db.prepare(`SELECT id, channel_id, user_id, text, created_at, edited_at FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY id DESC) AS rn FROM chat_messages
      WHERE deleted_at IS NULL AND channel_id IN (SELECT value FROM json_each(?))) WHERE rn <= ${CHAT_IN_SYNC} ORDER BY id`).all(JSON.stringify(ids)) : [];
  return { chatChannels: channels, chat, chatUnread: channels.reduce((n, c) => n + c.unread, 0), canManageChannels: manage };
}
