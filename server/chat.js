// Chat del workspace a canali: messaggi brevi tra i membri, con i collegamenti a ciò che sta nell'app
// (#CODICE, @progetto, [[doc:ID]], [[voce:ID]], [[contatto:ID]]) scritti nel testo e mostrati come link.
// Ogni canale ha le sue persone (o è di tutti), vedi chatdata.js. Gli ultimi messaggi di ogni canale arrivano
// con /api/sync; i precedenti si leggono qui. Senza ?channel= vale il primo canale (per la CLI di prima).
import { db, tx, currentWorkspace } from './db.js';
import { route, insertId } from './api.js';
import { myChannels, canManageChannels, channelReaders } from './chatdata.js';
import { acc, permsIn } from './accounts.js';
import { allows } from './perms.js';
import { notify, mentionedIn } from './notify.js';
import { fail, now, str, bool } from './util.js';

const MAX_TEXT = 4000;
const COLS = 'id, channel_id, user_id, text, created_at, edited_at';

// Il canale (per id o per nome) se l'utente lo legge; con write anche se ci può scrivere.
function channelFor(user, ref, write = false) {
  const list = myChannels(user.id);
  const c = ref == null || ref === ''
    ? list.find(x => !write || x.can_write) || fail(404, 'Non sei in nessun canale')
    : list.find(x => x.id === +ref || x.name.toLowerCase() === String(ref).replace(/^#/, '').toLowerCase()) || fail(404, 'Canale non trovato');
  if (write && !c.can_write) fail(403, `In #${c.name} puoi solo leggere`);
  return c;
}

function getMessage(id, user) {
  const m = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND deleted_at IS NULL').get(+id) || fail(404, 'Messaggio non trovato');
  channelFor(user, m.channel_id);
  return m;
}

// ?before=ID: i precedenti (per scorrere indietro); ?after=ID: i successivi (per chi segue la chat, es. org chat -f).
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
  const text = str(b.text, MAX_TEXT) || fail(400, 'Scrivi qualcosa');
  const id = insertId(db.prepare('INSERT INTO chat_messages (channel_id, user_id, text, created_at) VALUES (?, ?, ?, ?)').run(c.id, user.id, text, now()));
  markRead(c.id, user.id, id); // chi scrive ha letto tutto fino al proprio messaggio
  notifyMessage(user, c, text);
  return { id, channel_id: c.id };
}, { area: 'chat' });

route('PATCH', '/api/chat/:id', async ({ params, user, body }) => {
  const m = getMessage(params.id, user);
  if (m.user_id !== user.id) fail(403, 'Puoi modificare solo i tuoi messaggi');
  const text = str((await body()).text, MAX_TEXT) || fail(400, 'Il messaggio non può essere vuoto');
  db.prepare('UPDATE chat_messages SET text = ?, edited_at = ? WHERE id = ?').run(text, now(), m.id);
}, { area: 'chat' });

route('DELETE', '/api/chat/:id', ({ params, user }) => {
  const m = getMessage(params.id, user);
  if (m.user_id !== user.id && !user.is_admin && !canManageChannels(user)) fail(403, 'Puoi eliminare solo i tuoi messaggi');
  db.prepare('UPDATE chat_messages SET deleted_at = ? WHERE id = ?').run(now(), m.id);
}, { area: 'chat' });

const markRead = (channelId, userId, id) => db.prepare(`INSERT INTO chat_reads (channel_id, user_id, read_id) VALUES (?, ?, ?)
  ON CONFLICT (channel_id, user_id) DO UPDATE SET read_id = MAX(read_id, excluded.read_id)`).run(channelId, userId, id);

// Notifiche di un messaggio: chi è citato (+persona) sempre; gli altri del canale se non l'hanno silenziato.
// Le notifiche dello stesso canale si sostituiscono sul dispositivo (tag), per non riempire lo schermo.
const chatUrl = c => `#/chat?c=${c.id}`;
function notifyMessage(user, c, text) {
  const ws = currentWorkspace();
  const readers = channelReaders(c.id).filter(r => r.id !== user.id && allows(permsIn(ws, r.id), 'chat'));
  const members = db.prepare('SELECT id, username, name FROM users WHERE member = 1').all().filter(u => readers.some(r => r.id === u.id));
  const cited = new Set(mentionedIn(text, members));
  const plain = String(text).replace(/\[\[(\w+):\d+\]\]/g, '…');
  const who = user.name || user.username;
  const base = { ws: currentWorkspace(), body: plain, url: chatUrl(c), actor: user.id, tag: `chat-${currentWorkspace()}-${c.id}` };
  if (cited.size) notify([...cited], { ...base, kind: 'mention', title: `${who} ti ha citato in #${c.name}` });
  notify(readers.filter(r => !r.muted && !cited.has(r.id)).map(r => r.id), { ...base, kind: 'chat', title: `#${c.name} · ${who}` });
}

// Silenziare un canale: niente notifiche per ogni messaggio, restano quelle in cui si è citati.
route('POST', '/api/chat/channels/:id/mute', async ({ params, user, body }) => {
  const c = channelFor(user, params.id);
  const muted = (await body()).muted ? 1 : 0;
  db.prepare(`INSERT INTO chat_reads (channel_id, user_id, read_id, muted) VALUES (?, ?, 0, ?)
    ON CONFLICT (channel_id, user_id) DO UPDATE SET muted = excluded.muted`).run(c.id, user.id, muted);
}, { area: 'chat', level: 'read' });

// Letto fino a ID nel canale (non si torna mai indietro). Riguarda solo chi legge: niente notifica agli altri.
route('POST', '/api/chat/read', async ({ user, body }) => {
  const b = await body();
  const id = Number(b.id);
  if (!Number.isInteger(id) || id < 0) fail(400, 'Messaggio non valido');
  const c = b.channel == null
    ? channelFor(user, db.prepare('SELECT channel_id FROM chat_messages WHERE id = ?').get(id)?.channel_id)
    : channelFor(user, b.channel);
  markRead(c.id, user.id, id);
  // Letto il canale: anche le sue notifiche.
  acc.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND workspace_id = ? AND url = ? AND read_at IS NULL')
    .run(now(), user.id, currentWorkspace(), chatUrl(c));
}, { area: 'chat', level: 'read', quiet: true });

// ---------- gestione dei canali ----------
function channelFields(b) {
  const f = {};
  if (b.name !== undefined) {
    f.name = str(b.name, 60).replace(/^#/, '').trim() || fail(400, 'Dai un nome al canale');
  }
  if (b.everyone !== undefined) f.everyone = bool(b.everyone);
  return f;
}

// members: [{ user_id, can_write }] — solo membri attuali del workspace.
function setMembers(channelId, members) {
  db.prepare('DELETE FROM chat_members WHERE channel_id = ?').run(channelId);
  for (const m of Array.isArray(members) ? members : []) {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND member = 1').get(+m.user_id)) continue;
    db.prepare('INSERT OR REPLACE INTO chat_members (channel_id, user_id, can_write) VALUES (?, ?, ?)').run(channelId, +m.user_id, bool(m.can_write ?? true));
    // Chi viene aggiunto trova letti i messaggi di prima.
    db.prepare(`INSERT OR IGNORE INTO chat_reads (channel_id, user_id, read_id)
      VALUES (?, ?, (SELECT IFNULL(MAX(id), 0) FROM chat_messages WHERE channel_id = ?))`).run(channelId, +m.user_id, channelId);
  }
}

const assertManager = user => canManageChannels(user) || fail(403, 'Non hai il permesso di gestire i canali');
const nameTaken = (name, selfId = null) => db.prepare('SELECT 1 FROM chat_channels WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL AND id IS NOT ?').get(name, selfId);

route('POST', '/api/chat/channels', async ({ user, body }) => {
  assertManager(user);
  const b = await body();
  const f = channelFields({ everyone: false, ...b });
  if (!f.name) fail(400, 'Dai un nome al canale');
  if (nameTaken(f.name)) fail(409, `Esiste già #${f.name}`);
  return tx(() => {
    const id = insertId(db.prepare('INSERT INTO chat_channels (name, everyone, created_by, created_at) VALUES (?, ?, ?, ?)').run(f.name, f.everyone, user.id, now()));
    // Chi crea il canale ci sta dentro (anche se non si mette nell'elenco).
    setMembers(id, [...(b.members || []).filter(m => +m.user_id !== user.id), { user_id: user.id, can_write: true }]);
    return { id };
  });
}, { area: 'chat' });

route('PATCH', '/api/chat/channels/:id', async ({ params, user, body }) => {
  assertManager(user);
  const c = db.prepare('SELECT * FROM chat_channels WHERE id = ? AND deleted_at IS NULL').get(+params.id) || fail(404, 'Canale non trovato');
  const b = await body();
  const f = channelFields(b);
  if (f.name && nameTaken(f.name, c.id)) fail(409, `Esiste già #${f.name}`);
  tx(() => {
    for (const [k, v] of Object.entries(f)) db.prepare(`UPDATE chat_channels SET ${k} = ? WHERE id = ?`).run(v, c.id);
    if (b.members !== undefined) setMembers(c.id, b.members);
  });
}, { area: 'chat' });

route('DELETE', '/api/chat/channels/:id', ({ params, user }) => {
  assertManager(user);
  const c = db.prepare('SELECT * FROM chat_channels WHERE id = ? AND deleted_at IS NULL').get(+params.id) || fail(404, 'Canale non trovato');
  db.prepare('UPDATE chat_channels SET deleted_at = ? WHERE id = ?').run(now(), c.id);
}, { area: 'chat' });
