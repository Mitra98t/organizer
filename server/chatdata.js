// Chat channels: who reads, who writes, how many unread messages. Without dependencies on api.js because both the
// chat routes (chat.js) and /api/sync use it.
//   everyone = 1: all the workspace members read and write (e.g. "general");
//   otherwise chat_members, with can_write 0 for those who can only read.
import { db } from './db.js';

export const CHAT_IN_SYNC = 100; // last messages per channel in /api/sync; earlier ones with /api/chat?before=

// Who creates, renames, deletes channels and picks their people: admins and whoever has the "channels" permission.
export const canManageChannels = user => !!user?.is_admin || user?.perms?.canali === 'write';

// The channels the user reads, with can_write.
export function myChannels(uid) {
  return db.prepare(`SELECT c.id, c.name, c.everyone, CASE WHEN c.everyone = 1 THEN 1 ELSE m.can_write END AS can_write
    FROM chat_channels c LEFT JOIN chat_members m ON m.channel_id = c.id AND m.user_id = $uid
    WHERE c.deleted_at IS NULL AND (c.everyone = 1 OR m.user_id IS NOT NULL) ORDER BY c.id`).all({ uid });
}

// For /api/sync's ETag: changes when the user reads (reads send no notifications to anyone).
export const readKey = uid => db.prepare('SELECT COALESCE(SUM(read_id), 0) AS n FROM chat_reads WHERE user_id = ?').get(uid).n;

// Channels, recent messages and unread counts for /api/sync. Whoever manages channels sees all of them (to manage
// them), but the messages only of those they are in.
export function chatSync(user) {
  const uid = user.id;
  const mine = myChannels(uid);
  const ids = mine.map(c => c.id);
  const manage = canManageChannels(user);
  const all = manage ? db.prepare('SELECT id, name, everyone FROM chat_channels WHERE deleted_at IS NULL ORDER BY id').all() : mine;
  const members = db.prepare('SELECT user_id, can_write FROM chat_members WHERE channel_id = ?');
  const read = db.prepare('SELECT read_id, muted FROM chat_reads WHERE channel_id = ? AND user_id = ?');
  const unread = db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE channel_id = ? AND deleted_at IS NULL AND user_id != ? AND id > ?');
  const channels = all.map(c => {
    const m = mine.find(x => x.id === c.id);
    const r = m ? read.get(c.id, uid) : null;
    const readId = r?.read_id ?? 0;
    return {
      id: c.id, name: c.name, everyone: c.everyone, member: !!m, can_write: m ? m.can_write : 0, muted: r?.muted ?? 0,
      members: c.everyone ? [] : members.all(c.id), read_id: readId, unread: m ? unread.get(c.id, uid, readId).n : 0,
    };
  });
  const chat = ids.length ? db.prepare(`SELECT id, channel_id, user_id, text, created_at, edited_at FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY id DESC) AS rn FROM chat_messages
      WHERE deleted_at IS NULL AND channel_id IN (SELECT value FROM json_each(?))) WHERE rn <= ${CHAT_IN_SYNC} ORDER BY id`).all(JSON.stringify(ids)) : [];
  return { chatChannels: channels, chat, chatUnread: channels.reduce((n, c) => n + c.unread, 0), canManageChannels: manage };
}

// Who reads the channel (for notifications): all the workspace members or the channel's people; muted = silenced.
export function channelReaders(channelId) {
  const c = db.prepare('SELECT everyone FROM chat_channels WHERE id = ?').get(channelId);
  const ids = c?.everyone
    ? db.prepare('SELECT id FROM users WHERE member = 1').all().map(r => r.id)
    : db.prepare('SELECT m.user_id AS id FROM chat_members m JOIN users u ON u.id = m.user_id AND u.member = 1 WHERE m.channel_id = ?').all(channelId).map(r => r.id);
  const muted = new Set(db.prepare('SELECT user_id FROM chat_reads WHERE channel_id = ? AND muted = 1').all(channelId).map(r => r.user_id));
  return ids.map(id => ({ id, muted: muted.has(id) }));
}
