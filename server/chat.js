// Workspace chat with channels: short messages between members, with links to what is in the app (#CODE,
// @project, [[doc:ID]], [[voce:ID]], [[contatto:ID]]) written in the text and shown as links.
// Each channel has its own people (or belongs to everyone), see chatdata.js. The last messages of each channel
// arrive with /api/sync; earlier ones are read here. Without ?channel= the first channel applies (for the old CLI).
import { db, tx, currentWorkspace } from './db.js';
import { route, insertId } from './api.js';
import { myChannels, canManageChannels, channelReaders } from './chatdata.js';
import { acc, permsIn } from './accounts.js';
import { allows } from './perms.js';
import { notify, mentionedIn } from './notify.js';
import { fail, now, str, bool } from './util.js';

const MAX_TEXT = 4000;
const COLS = 'id, channel_id, user_id, text, created_at, edited_at';

// The channel (by id or by name) if the user reads it; with write also if they can write in it.
function channelFor(user, ref, write = false) {
  const list = myChannels(user.id);
  const c = ref == null || ref === ''
    ? list.find(x => !write || x.can_write) || fail(404, 'You are not in any channel')
    : list.find(x => x.id === +ref || x.name.toLowerCase() === String(ref).replace(/^#/, '').toLowerCase()) || fail(404, 'Channel not found');
  if (write && !c.can_write) fail(403, 'In #{name} you can only read', { name: c.name });
  return c;
}

function getMessage(id, user) {
  const m = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND deleted_at IS NULL').get(+id) || fail(404, 'Message not found');
  channelFor(user, m.channel_id);
  return m;
}

// ?before=ID: earlier ones (to scroll back); ?after=ID: later ones (for whoever follows the chat, e.g. org chat -f).
route('GET', '/api/chat', ({ query, user }) => {
  const c = channelFor(user, query.channel);
  const limit = Math.min(Math.max(+query.limit || 50, 1), 500);
  if (query.after) {
    return db.prepare(`SELECT ${COLS} FROM chat_messages WHERE channel_id = ? AND deleted_at IS NULL AND id > ? ORDER BY id LIMIT ?`).all(c.id, +query.after, limit);
  }
  const before = +query.before || Number.MAX_SAFE_INTEGER;
  return db.prepare(`SELECT ${COLS} FROM chat_messages WHERE channel_id = ? AND deleted_at IS NULL AND id < ? ORDER BY id DESC LIMIT ?`)
    .all(c.id, before, limit).reverse();
}, { area: 'chat' });

route('POST', '/api/chat', async ({ user, body }) => {
  const b = await body();
  const c = channelFor(user, b.channel, true);
  const text = str(b.text, MAX_TEXT) || fail(400, 'Write something');
  const id = insertId(db.prepare('INSERT INTO chat_messages (channel_id, user_id, text, created_at) VALUES (?, ?, ?, ?)').run(c.id, user.id, text, now()));
  markRead(c.id, user.id, id); // whoever writes has read everything up to their own message
  notifyMessage(user, c, text);
  return { id, channel_id: c.id };
}, { area: 'chat' });

route('PATCH', '/api/chat/:id', async ({ params, user, body }) => {
  const m = getMessage(params.id, user);
  if (m.user_id !== user.id) fail(403, 'You can only edit your own messages');
  const text = str((await body()).text, MAX_TEXT) || fail(400, 'The message cannot be empty');
  db.prepare('UPDATE chat_messages SET text = ?, edited_at = ? WHERE id = ?').run(text, now(), m.id);
}, { area: 'chat' });

route('DELETE', '/api/chat/:id', ({ params, user }) => {
  const m = getMessage(params.id, user);
  if (m.user_id !== user.id && !user.is_admin && !canManageChannels(user)) fail(403, 'You can only delete your own messages');
  db.prepare('UPDATE chat_messages SET deleted_at = ? WHERE id = ?').run(now(), m.id);
}, { area: 'chat' });

const markRead = (channelId, userId, id) => db.prepare(`INSERT INTO chat_reads (channel_id, user_id, read_id) VALUES (?, ?, ?)
  ON CONFLICT (channel_id, user_id) DO UPDATE SET read_id = MAX(read_id, excluded.read_id)`).run(channelId, userId, id);

// A message's notifications: whoever is mentioned (+person) always; the others in the channel unless they muted it.
// Notifications of the same channel replace each other on the device (tag), not to fill the screen.
const chatUrl = c => `#/chat?c=${c.id}`;
function notifyMessage(user, c, text) {
  const ws = currentWorkspace();
  const readers = channelReaders(c.id).filter(r => r.id !== user.id && allows(permsIn(ws, r.id), 'chat'));
  const members = db.prepare('SELECT id, username, name FROM users WHERE member = 1').all().filter(u => readers.some(r => r.id === u.id));
  const cited = new Set(mentionedIn(text, members));
  const plain = String(text).replace(/\[\[(\w+):\d+\]\]/g, '…');
  const who = user.name || user.username;
  const base = { ws: currentWorkspace(), body: plain, url: chatUrl(c), actor: user.id, tag: `chat-${currentWorkspace()}-${c.id}` };
  if (cited.size) notify([...cited], { ...base, kind: 'mention', title: ['{who} mentioned you in #{channel}', { who, channel: c.name }] });
  notify(readers.filter(r => !r.muted && !cited.has(r.id)).map(r => r.id), { ...base, kind: 'chat', title: `#${c.name} · ${who}` });
}

// Muting a channel: no notification for every message, the ones where you are mentioned stay.
route('POST', '/api/chat/channels/:id/mute', async ({ params, user, body }) => {
  const c = channelFor(user, params.id);
  const muted = (await body()).muted ? 1 : 0;
  db.prepare(`INSERT INTO chat_reads (channel_id, user_id, read_id, muted) VALUES (?, ?, 0, ?)
    ON CONFLICT (channel_id, user_id) DO UPDATE SET muted = excluded.muted`).run(c.id, user.id, muted);
}, { area: 'chat', level: 'read' });

// Read up to ID in the channel (never goes back). Only concerns the reader: no notification to the others.
route('POST', '/api/chat/read', async ({ user, body }) => {
  const b = await body();
  const id = Number(b.id);
  if (!Number.isInteger(id) || id < 0) fail(400, 'Invalid message');
  const c = b.channel == null
    ? channelFor(user, db.prepare('SELECT channel_id FROM chat_messages WHERE id = ?').get(id)?.channel_id)
    : channelFor(user, b.channel);
  markRead(c.id, user.id, id);
  // Channel read: its notifications too.
  acc.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND workspace_id = ? AND url = ? AND read_at IS NULL')
    .run(now(), user.id, currentWorkspace(), chatUrl(c));
}, { area: 'chat', level: 'read', quiet: true });

// ---------- managing channels ----------
function channelFields(b) {
  const f = {};
  if (b.name !== undefined) {
    f.name = str(b.name, 60).replace(/^#/, '').trim() || fail(400, 'Give the channel a name');
  }
  if (b.everyone !== undefined) f.everyone = bool(b.everyone);
  return f;
}

// members: [{ user_id, can_write }] — only current workspace members.
function setMembers(channelId, members) {
  db.prepare('DELETE FROM chat_members WHERE channel_id = ?').run(channelId);
  for (const m of Array.isArray(members) ? members : []) {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND member = 1').get(+m.user_id)) continue;
    db.prepare('INSERT OR REPLACE INTO chat_members (channel_id, user_id, can_write) VALUES (?, ?, ?)').run(channelId, +m.user_id, bool(m.can_write ?? true));
    // Whoever is added finds the earlier messages read.
    db.prepare(`INSERT OR IGNORE INTO chat_reads (channel_id, user_id, read_id)
      VALUES (?, ?, (SELECT IFNULL(MAX(id), 0) FROM chat_messages WHERE channel_id = ?))`).run(channelId, +m.user_id, channelId);
  }
}

const assertManager = user => canManageChannels(user) || fail(403, 'You are not allowed to manage channels');
const nameTaken = (name, selfId = null) => db.prepare('SELECT 1 FROM chat_channels WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL AND id IS NOT ?').get(name, selfId);

route('POST', '/api/chat/channels', async ({ user, body }) => {
  assertManager(user);
  const b = await body();
  const f = channelFields({ everyone: false, ...b });
  if (!f.name) fail(400, 'Give the channel a name');
  if (nameTaken(f.name)) fail(409, '#{name} already exists', { name: f.name });
  return tx(() => {
    const id = insertId(db.prepare('INSERT INTO chat_channels (name, everyone, created_by, created_at) VALUES (?, ?, ?, ?)').run(f.name, f.everyone, user.id, now()));
    // Whoever creates the channel is in it (even without putting themselves in the list).
    setMembers(id, [...(b.members || []).filter(m => +m.user_id !== user.id), { user_id: user.id, can_write: true }]);
    return { id };
  });
}, { area: 'chat' });

route('PATCH', '/api/chat/channels/:id', async ({ params, user, body }) => {
  assertManager(user);
  const c = db.prepare('SELECT * FROM chat_channels WHERE id = ? AND deleted_at IS NULL').get(+params.id) || fail(404, 'Channel not found');
  const b = await body();
  const f = channelFields(b);
  if (f.name && nameTaken(f.name, c.id)) fail(409, '#{name} already exists', { name: f.name });
  tx(() => {
    for (const [k, v] of Object.entries(f)) db.prepare(`UPDATE chat_channels SET ${k} = ? WHERE id = ?`).run(v, c.id);
    if (b.members !== undefined) setMembers(c.id, b.members);
  });
}, { area: 'chat' });

route('DELETE', '/api/chat/channels/:id', ({ params, user }) => {
  assertManager(user);
  const c = db.prepare('SELECT * FROM chat_channels WHERE id = ? AND deleted_at IS NULL').get(+params.id) || fail(404, 'Channel not found');
  db.prepare('UPDATE chat_channels SET deleted_at = ? WHERE id = ?').run(now(), c.id);
}, { area: 'chat' });
