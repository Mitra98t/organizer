// Bridge with the Thunderbird extension (thunderbird/ folder). Organizer does not know the mail passwords: Thunderbird
// opens, sends and receives the mails. The extension authenticates with an API token and
//  - keeps /api/mail/stream open: the server knows it is there and tells it when there is a mail to open;
//  - takes from the queue (mail_outbox) the mails to open, attachments included, also as a reply to a message;
//  - reports sent mails (they become "sent", with their Message-ID) and the replies arriving to a followed
//    conversation (the mail is no longer "awaiting reply").
// Mails live in personal threads (maildata.js): received, sent and written in Organizer. When a reply arrives or
// leaves for mails Organizer does not have, the server asks the extension for them (missing) to complete the
// thread. The extension's calls apply to all the user's workspaces: the server looks in each of them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, tx, withWorkspace, UPLOAD_DIR } from './db.js';
import { acc, workspacesOf, workspaceById, permsIn, mailAddressesOf, defaultWorkspace } from './accounts.js';
import { Readable } from 'node:stream';
import { route, entryFor, updateEntry, addLog, insertId, syncEntryItems, docKind, saveUpload, CVIS_ANY } from './api.js';
import { newThread, ensureEntryThread, touchThread, autoLink, findThread, dropEmptyTopics, ensureTopic, relinkThread } from './maildata.js';
import { mailParts, sendFile } from './mail.js';
import { allows } from './perms.js';
import { bump, mailExtOn, mailExtVersion, openMailExtStream, notifyMailExt } from './events.js';
import { zip } from './zip.js';
import { notify } from './notify.js';
import { HttpError, fail, now, str, isHttps, readBody } from './util.js';
import { tr } from './i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTBOX_HOURS = 2; // a request not taken within this time is dropped
const WATCH_DAYS = 365; // followed conversations: the messages of the last year

// Message-ID without angle brackets (Thunderbird gives them that way).
const cleanId = s => str(s, 500).replace(/^<|>$/g, '');
const emailOf = s => (String(s || '').match(/<([^>]+)>/)?.[1] || String(s || '')).trim();
const emailsOf = s => String(s || '').split(',').map(emailOf).filter(a => a.includes('@'));
const re = s => (/^re:/i.test(s) ? s : `Re: ${s}`);

// Attachments of a received mail: name, message part (to get the file from Thunderbird), size and type.
// The first versions of the extension sent only the name.
const cleanAttachments = list => JSON.stringify((Array.isArray(list) ? list : []).slice(0, 50).map(a => (typeof a === 'string'
  ? { name: str(a, 255) }
  : { name: str(a?.name, 255) || 'allegato', part: str(a?.part, 50) || null, size: Number(a?.size) || null, type: str(a?.type, 100) || null })));

// The user as a request from the app in that workspace would see them (role and permissions there).
function asMember(user, ws, role) {
  return { ...user, workspace_id: ws.id, is_admin: role === 'admin' ? 1 : 0, perms: permsIn(ws.id, user.id) };
}

// The workspaces where the user can use mail at the requested level, with the user "of that workspace".
function mailWorkspaces(user, level) {
  return workspacesOf(user.id).map(w => [workspaceById(w.id), w.role])
    .filter(([ws]) => ws)
    .map(([ws, role]) => ({ ws, u: asMember(user, ws, role) }))
    .filter(({ u }) => allows(u.perms, 'mail', level));
}

function inWorkspace(user, wsId, level, fn) {
  const hit = mailWorkspaces(user, level).find(x => x.ws.id === +wsId) || fail(404, 'Workspace not found');
  return withWorkspace(hit.ws, () => fn(hit.u, hit.ws));
}

// ---------- from the app ----------
// "Send" when the extension is connected: the mail goes into the queue and Thunderbird opens it.
route('POST', '/api/entries/:id/compose', ({ params, user }) => {
  const e = entryFor(params.id, user, 'read');
  if (e.kind !== 'mail') fail(400, 'Not a mail');
  if (!mailExtOn(user.id)) fail(409, 'Thunderbird is not connected: open it and check the Organizer extension');
  tx(() => {
    db.prepare('DELETE FROM mail_outbox WHERE entry_id = ? AND user_id = ? AND claimed_at IS NULL').run(e.id, user.id);
    db.prepare('INSERT INTO mail_outbox (entry_id, user_id, created_at) VALUES (?, ?, ?)').run(e.id, user.id, now());
  });
  notifyMailExt(user.id, 'outbox');
}, { area: 'mail', level: 'read', quiet: true });

// ---------- thread ----------
const parseMsg = m => ({ ...m, attachments: JSON.parse(m.attachments || '[]') });
const getThread = (id, user) => db.prepare('SELECT * FROM mail_threads WHERE id = ? AND owner_id = ? AND deleted_at IS NULL').get(+id, user.id) || fail(404, 'Thread not found');

const fullThread = t => ({
  ...t,
  messages: db.prepare('SELECT * FROM mail_messages WHERE thread_id = ? ORDER BY date, id').all(t.id).map(parseMsg),
  entries: db.prepare('SELECT id FROM entries WHERE thread_id = ? AND deleted_at IS NULL ORDER BY id').all(t.id).map(r => r.id),
});
const getTopic = (id, user) => db.prepare('SELECT * FROM mail_topics WHERE id = ? AND owner_id = ?').get(+id, user.id) || fail(404, 'Topic not found');
const hueOf = v => (v === null || v === '' ? null : Math.max(0, Math.min(359, Math.round(+v) || 0)));
// A thread's notifications lead to its topic (#/t/topic?th=thread): those are read too.
const readNotifications = (user, t, at) => acc.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL
  AND (url = ? OR url LIKE ?)`).run(at, user.id, `#/t/${t.id}`, `#/t/%th=${t.id}`);

// The thread with the full messages (oldest first) and the mails written in Organizer that belong to it.
route('GET', '/api/mail/threads/:id', ({ params, user }) => fullThread(getThread(params.id, user)), { area: 'mail' });

// The topic with all its conversations (archived ones included), full messages.
route('GET', '/api/mail/topics/:id', ({ params, user }) => {
  const topic = getTopic(params.id, user);
  const threads = db.prepare('SELECT * FROM mail_threads WHERE topic_id = ? AND deleted_at IS NULL ORDER BY created_at').all(topic.id);
  return { ...topic, threads: threads.map(fullThread) };
}, { area: 'mail' });

// A conversation: read (the received messages), archived or active again (archiving marks it read), renamed, with
// star and colour (hue null = automatic), moved to another topic (topic: id, or "new").
route('PATCH', '/api/mail/threads/:id', async ({ params, user, body }) => {
  const b = await body();
  const t = getThread(params.id, user);
  const at = now();
  tx(() => {
    if (b.read !== undefined || b.archived) {
      db.prepare(`UPDATE mail_messages SET read_at = ${b.read === false ? 'NULL' : 'COALESCE(read_at, ?)'} WHERE thread_id = ? AND direction = 'in'`)
        .run(...(b.read === false ? [t.id] : [at, t.id]));
    }
    if (b.archived !== undefined) db.prepare('UPDATE mail_threads SET archived_at = ? WHERE id = ?').run(b.archived ? at : null, t.id);
    if (b.archived === false && t.archived_at) relinkThread(t.id); // active again: re-checked with today's codes
    if (b.subject !== undefined) db.prepare('UPDATE mail_threads SET subject = ? WHERE id = ?').run(str(b.subject, 300) || t.subject, t.id);
    if (b.starred !== undefined) db.prepare('UPDATE mail_threads SET starred = ? WHERE id = ?').run(b.starred ? 1 : 0, t.id);
    if (b.hue !== undefined) db.prepare('UPDATE mail_threads SET hue = ? WHERE id = ?').run(hueOf(b.hue), t.id);
    if (b.topic !== undefined) {
      const to = b.topic === 'new' ? null : getTopic(b.topic, user).id;
      db.prepare('UPDATE mail_threads SET topic_id = ? WHERE id = ?').run(to, t.id);
      ensureTopic(t.id);
      dropEmptyTopics(user.id);
    }
  });
  if (b.read || b.archived) readNotifications(user, t, at);
  return { topic: db.prepare('SELECT topic_id FROM mail_threads WHERE id = ?').get(t.id).topic_id };
}, { area: 'mail' });

// A topic: title, star, colour.
route('PATCH', '/api/mail/topics/:id', async ({ params, user, body }) => {
  const b = await body();
  const t = getTopic(params.id, user);
  if (b.title !== undefined) db.prepare('UPDATE mail_topics SET title = ? WHERE id = ?').run(str(b.title, 300) || t.title, t.id);
  if (b.starred !== undefined) db.prepare('UPDATE mail_topics SET starred = ? WHERE id = ?').run(b.starred ? 1 : 0, t.id);
  if (b.hue !== undefined) db.prepare('UPDATE mail_topics SET hue = ? WHERE id = ?').run(hueOf(b.hue), t.id);
}, { area: 'mail' });

// Merging: all the topic's conversations move to another one (this one disappears).
route('POST', '/api/mail/topics/:id/merge', async ({ params, user, body }) => {
  const from = getTopic(params.id, user);
  const into = getTopic((await body()).into, user);
  if (from.id === into.id) return;
  tx(() => {
    db.prepare('UPDATE mail_threads SET topic_id = ? WHERE topic_id = ?').run(into.id, from.id);
    db.prepare('INSERT OR IGNORE INTO mail_topic_links (topic_id, kind, target_id) SELECT ?, kind, target_id FROM mail_topic_links WHERE topic_id = ?').run(into.id, from.id);
    dropEmptyTopics(user.id);
  });
}, { area: 'mail' });

// Moving a topic to another workspace of the user (where they can write mail): conversations, messages and mails
// written in Organizer, with attachments and log. Each workspace has its own database: the rows are copied there
// (new ids) and then removed here. The links (items, projects, contacts…) belonged to this workspace: they are
// dropped and the automatic ones are computed again with the inventory there. An attachment taken from the
// inventory becomes a file of its own. Conversations in the trash stay here.
const omit = (row, ...keys) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
function insertRow(table, row) {
  const cols = Object.keys(row);
  return insertId(db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => row[c])));
}
const inIds = ids => `(${ids.map(Number).join(', ') || 'NULL'})`;

route('POST', '/api/mail/topics/:id/move', async ({ params, user, body }) => {
  const b = await body();
  const topic = getTopic(params.id, user);
  if (+b.ws === user.workspace_id) fail(400, 'The topic is already in this workspace');
  const dest = mailWorkspaces(user, 'write').find(x => x.ws.id === +b.ws) || fail(404, 'Workspace not found, or you cannot write mail there');
  const threads = db.prepare('SELECT * FROM mail_threads WHERE topic_id = ? AND deleted_at IS NULL ORDER BY id').all(topic.id);
  const tids = threads.map(t => t.id);
  const msgs = db.prepare(`SELECT * FROM mail_messages WHERE thread_id IN ${inIds(tids)} ORDER BY id`).all();
  const ents = db.prepare(`SELECT * FROM entries WHERE thread_id IN ${inIds(tids)} ORDER BY id`).all();
  const eids = ents.map(e => e.id);
  const atts = db.prepare(`SELECT a.*, d.stored AS doc_stored FROM mail_attachments a LEFT JOIN documents d ON d.id = a.doc_id
    WHERE a.entry_id IN ${inIds(eids)} ORDER BY a.id`).all();
  const logs = db.prepare(`SELECT * FROM entry_log WHERE entry_id IN ${inIds(eids)} ORDER BY id`).all();

  const moved = withWorkspace(dest.ws, () => tx(() => {
    // The people there (whoever wrote a log line or uploaded an attachment and is not in that workspace: nobody).
    const known = id => (id != null && db.prepare('SELECT 1 FROM users WHERE id = ?').get(id) ? id : null);
    const topicId = insertRow('mail_topics', omit(topic, 'id'));
    const tmap = new Map(threads.map(t => [t.id, insertRow('mail_threads', { ...omit(t, 'id'), topic_id: topicId })]));
    const emap = new Map(ents.map(e => [e.id, insertRow('entries', {
      ...omit(e, 'id', 'project_id', 'parent_id', 'assignee_id', 'mail_thread', 'reply_to'), thread_id: tmap.get(e.thread_id),
      created_by: known(e.created_by), deleted_by: known(e.deleted_by),
    })]));
    const mmap = new Map(msgs.map(m => [m.id, insertRow('mail_messages', { ...omit(m, 'id'), thread_id: tmap.get(m.thread_id), entry_id: emap.get(m.entry_id) ?? null })]));
    for (const e of ents) if (e.reply_to) db.prepare('UPDATE entries SET reply_to = ? WHERE id = ?').run(mmap.get(e.reply_to) ?? null, emap.get(e.id));
    for (const a of atts) {
      let stored = a.stored;
      if (a.doc_id && a.doc_stored && fs.existsSync(path.join(UPLOAD_DIR, a.doc_stored))) {
        stored = crypto.randomBytes(16).toString('hex');
        fs.copyFileSync(path.join(UPLOAD_DIR, a.doc_stored), path.join(UPLOAD_DIR, stored));
      }
      if (stored) insertRow('mail_attachments', { ...omit(a, 'id', 'doc_id', 'doc_stored'), entry_id: emap.get(a.entry_id), stored, created_by: known(a.created_by) });
    }
    for (const l of logs) insertRow('entry_log', { ...omit(l, 'id'), entry_id: emap.get(l.entry_id), user_id: known(l.user_id) });
    for (const id of tmap.values()) relinkThread(id);
    for (const id of emap.values()) syncEntryItems(id, dest.u);
    return topicId;
  }));

  tx(() => {
    db.prepare(`DELETE FROM mail_outbox WHERE entry_id IN ${inIds(eids)}`).run();
    db.prepare(`DELETE FROM entries WHERE id IN ${inIds(eids)}`).run();
    db.prepare(`DELETE FROM mail_threads WHERE id IN ${inIds(tids)}`).run();
    dropEmptyTopics(user.id);
  });
  bump(user.id, dest.ws.id);
  return { ws: dest.ws.id, name: dest.ws.name, topic: moved };
}, { area: 'mail' });

// Search in the person's mail (for "[[" and the filter): the conversations where every word is found in a message
// (subject, full text, addresses and names), in the conversation's subject or in its topic's title. A word that
// is the name of an address-book contact also searches their addresses.
route('GET', '/api/mail/search', ({ user, query }) => {
  const words = String(query.q || '').toLowerCase().split(/\s+/).filter(w => w.length >= 2).slice(0, 8);
  if (!words.length) return [];
  const like = w => `%${w.replace(/[\\%_]/g, m => `\\${m}`)}%`;
  let ids = null;
  for (const w of words) {
    const emails = db.prepare(`SELECT lower(c.email) AS e FROM contacts c WHERE c.deleted_at IS NULL AND c.email != '' AND ${CVIS_ANY}
      AND lower(c.name) LIKE $w ESCAPE '\\'`).all({ uid: user.id, w: like(w) }).map(r => r.e);
    const found = new Set(db.prepare(`SELECT t.id FROM mail_threads t LEFT JOIN mail_topics p ON p.id = t.topic_id
      WHERE t.owner_id = ? AND t.deleted_at IS NULL AND (lower(t.subject) LIKE ? ESCAPE '\\' OR lower(p.title) LIKE ? ESCAPE '\\'
        OR t.id IN (SELECT thread_id FROM mail_messages WHERE lower(subject || ' ' || from_addr || ' ' || to_addr || ' ' || cc || ' ' || body) LIKE ? ESCAPE '\\'
          ${emails.map(() => "OR lower(from_addr || ' ' || to_addr || ' ' || cc) LIKE ?").join(' ')}))`)
      .all(user.id, like(w), like(w), like(w), ...emails.map(e => `%${e}%`)).map(r => r.id));
    ids = ids ? new Set([...ids].filter(id => found.has(id))) : found;
    if (!ids.size) return [];
  }
  return db.prepare(`SELECT id FROM mail_threads WHERE id IN (SELECT value FROM json_each(?)) ORDER BY last_at DESC LIMIT 30`)
    .all(JSON.stringify([...ids])).map(r => r.id);
}, { area: 'mail', quiet: true });

// A single message, for the preview of one of its attachments (page title and way back to the conversation).
route('GET', '/api/mail/messages/:id', ({ params, user }) => {
  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(+params.id) || fail(404, 'Message not found');
  const t = getThread(m.thread_id, user);
  return { id: m.id, thread_id: t.id, topic_id: t.topic_id, subject: m.subject, from_addr: m.from_addr, date: m.date, attachments: parseMsg(m).attachments };
}, { area: 'mail' });

// A message read or unread (opening it in the tree reads it).
route('PATCH', '/api/mail/messages/:id', async ({ params, user, body }) => {
  const b = await body();
  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(+params.id) || fail(404, 'Message not found');
  const t = getThread(m.thread_id, user);
  if (b.read !== undefined) db.prepare('UPDATE mail_messages SET read_at = ? WHERE id = ?').run(b.read ? m.read_at || now() : null, m.id);
  if (b.read && !db.prepare("SELECT 1 FROM mail_messages WHERE thread_id = ? AND direction = 'in' AND read_at IS NULL").get(t.id)) readNotifications(user, t, now());
}, { area: 'mail' });

// To the trash, with the mails written in Organizer that belong to it (they come back together with Restore). In
// Thunderbird the mails stay; if it passes them again, the messages already seen do not reopen the thread.
route('DELETE', '/api/mail/threads/:id', ({ params, user }) => {
  const t = getThread(params.id, user);
  const at = now();
  tx(() => trashThread(t, user, at));
  readNotifications(user, t, at);
}, { area: 'mail' });

function trashThread(t, user, at) {
  db.prepare('UPDATE mail_threads SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(at, user.id, t.id);
  db.prepare('UPDATE entries SET deleted_at = ?, deleted_by = ? WHERE thread_id = ? AND deleted_at IS NULL').run(at, user.id, t.id);
  dropEmptyTopics(user.id);
}

// A topic to the trash: each of its conversations goes there (and is restored on its own, in a new topic).
route('DELETE', '/api/mail/topics/:id', ({ params, user }) => {
  const topic = getTopic(params.id, user);
  const at = now();
  const threads = db.prepare('SELECT * FROM mail_threads WHERE topic_id = ? AND deleted_at IS NULL').all(topic.id);
  tx(() => { for (const t of threads) trashThread(t, user, at); });
  for (const t of threads) readNotifications(user, t, at);
}, { area: 'mail' });

// Links picked by hand: items, documents, projects, contacts, entries (like the [[…]] and the #codes).
const THREAD_LINK = { articolo: 'items', doc: 'documents', progetto: 'projects', contatto: 'contacts', voce: 'entries', mail: 'mail_threads' };
route('POST', '/api/mail/threads/:id/links', async ({ params, user, body }) => {
  const b = await body();
  const t = getThread(params.id, user);
  const table = THREAD_LINK[b.kind] || fail(400, 'Invalid link kind');
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(+b.id)) fail(404, 'Element not found');
  db.prepare('INSERT INTO mail_thread_links (thread_id, kind, target_id) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET auto = 0, hidden = 0').run(t.id, b.kind, +b.id);
}, { area: 'mail' });

// Links of the whole topic (e.g. to its project), besides those of the conversations.
route('POST', '/api/mail/topics/:id/links', async ({ params, user, body }) => {
  const b = await body();
  const t = getTopic(params.id, user);
  const table = THREAD_LINK[b.kind] || fail(400, 'Invalid link kind');
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(+b.id)) fail(404, 'Element not found');
  db.prepare('INSERT OR IGNORE INTO mail_topic_links (topic_id, kind, target_id) VALUES (?, ?, ?)').run(t.id, b.kind, +b.id);
}, { area: 'mail' });

route('DELETE', '/api/mail/topics/:id/links/:kind/:target', ({ params, user }) => {
  const t = getTopic(params.id, user);
  db.prepare('DELETE FROM mail_topic_links WHERE topic_id = ? AND kind = ? AND target_id = ?').run(t.id, params.kind, +params.target);
}, { area: 'mail' });

// Removing a link, even automatic or mentioned in a mail written here: it stays hidden and does not come back.
route('DELETE', '/api/mail/threads/:id/links/:kind/:target', ({ params, user }) => {
  const t = getThread(params.id, user);
  if (!THREAD_LINK[params.kind]) fail(400, 'Invalid link kind');
  db.prepare(`INSERT INTO mail_thread_links (thread_id, kind, target_id, auto, hidden) VALUES (?, ?, ?, 1, 1)
    ON CONFLICT DO UPDATE SET hidden = 1`).run(t.id, params.kind, +params.target);
}, { area: 'mail' });

// ---------- replies ----------
// Recipients of a reply: whoever wrote (or, to a message we sent, whoever it went to); "all" adds the other
// recipients in Cc, except our addresses (those of the Thunderbird identities).
function replyAddresses(m, all, userId) {
  const own = new Set(mailAddressesOf(userId).map(a => a.toLowerCase()));
  const to = m.direction === 'out' ? emailsOf(m.to_addr) : emailsOf(m.from_addr);
  const seen = new Set([...own, ...to.map(a => a.toLowerCase())]);
  const cc = !all ? [] : [...emailsOf(m.to_addr), ...emailsOf(m.cc)].filter(a => {
    const k = a.toLowerCase();
    return !seen.has(k) && seen.add(k);
  });
  return { contact: to.join(', ') || null, mail_cc: cc.join(', ') || null };
}

// The reply mail in Organizer, in the thread (written there, then "Send" opens it in Thunderbird as a reply).
// Without going through the quick line: a subject with "@" or "!" must not become a project or a due date. The
// projects are those of the thread's other mails.
function insertReply(user, t, f) {
  const at = now();
  const last = db.prepare('SELECT id, title, project_id FROM entries WHERE thread_id = ? AND deleted_at IS NULL ORDER BY id DESC').get(t.id);
  const id = insertId(db.prepare(`INSERT INTO entries (kind, title, contact, mail_cc, mail_subject, project_id, thread_id, reply_to, created_by, created_at, updated_at)
    VALUES ('mail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(str(re(last?.title || t.subject), 1000), f.contact, f.mail_cc, str(f.subject, 300) || null, last?.project_id ?? null, t.id, f.reply_to ?? null, user.id, at, at));
  if (last) db.prepare('INSERT OR IGNORE INTO entry_projects (entry_id, project_id) SELECT ?, project_id FROM entry_projects WHERE entry_id = ?').run(id, last.id);
  syncEntryItems(id, user);
  touchThread(t.id, at);
  return id;
}

// "Reply" (or "all") on a message of the thread.
route('POST', '/api/mail/messages/:id/reply', async ({ params, user, body }) => {
  const b = await body();
  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(+params.id) || fail(404, 'Message not found');
  const t = getThread(m.thread_id, user);
  return { id: tx(() => insertReply(user, t, { subject: re(m.subject || t.subject), reply_to: m.id, ...replyAddresses(m, !!b.all, user.id) })) };
}, { area: 'mail' });

// A new mail in the thread, to whoever was in it (without replying to a specific message).
route('POST', '/api/mail/threads/:id/draft', ({ params, user }) => {
  const t = getThread(params.id, user);
  const last = db.prepare('SELECT * FROM mail_messages WHERE thread_id = ? ORDER BY date DESC').get(t.id);
  return { id: tx(() => insertReply(user, t, { subject: re(t.subject), ...(last ? replyAddresses(last, true, user.id) : { contact: null, mail_cc: null }) })) };
}, { area: 'mail' });

// "New mail" on a topic's page: a new conversation in the topic, with an empty draft.
route('POST', '/api/mail/topics/:id/draft', ({ params, user }) => {
  const topic = getTopic(params.id, user);
  return {
    id: tx(() => {
      const at = now();
      const tid = newThread(user.id, tr('New mail'), at, topic.id);
      return insertId(db.prepare(`INSERT INTO entries (kind, title, thread_id, created_by, created_at, updated_at)
        VALUES ('mail', ?, ?, ?, ?, ?)`).run(tr('New mail'), tid, user.id, at, at));
    }),
  };
}, { area: 'mail' });

// ---------- at start-up ----------
// The rules of automatic links may change between versions (e.g. 2-character codes): active conversations are
// re-checked at every start. Archived ones when they become active again.
export function relinkAllActive() {
  let n = 0;
  for (const { id } of acc.prepare('SELECT id FROM workspaces WHERE deleted_at IS NULL').all()) {
    const ws = workspaceById(id);
    if (!ws) continue;
    withWorkspace(ws, () => tx(() => {
      for (const t of db.prepare('SELECT id FROM mail_threads WHERE archived_at IS NULL AND deleted_at IS NULL').all()) {
        relinkThread(t.id);
        n++;
      }
    }));
  }
  return n;
}

// ---------- inbox from before (up to v0.14) ----------
// It lived in accounts.db (mail_inbox); now every mail is in a thread of the mail workspace. Moved only once.
export function migrateInbox() {
  const users = acc.prepare('SELECT DISTINCT user_id FROM mail_inbox').all().map(r => r.user_id);
  for (const uid of users) {
    const wsId = defaultWorkspace(uid);
    const ws = wsId && workspaceById(wsId);
    if (!ws) continue;
    const rows = acc.prepare('SELECT * FROM mail_inbox WHERE user_id = ? AND archived_at IS NULL ORDER BY date').all(uid);
    withWorkspace(ws, () => tx(() => {
      for (const m of rows) {
        if (db.prepare('SELECT 1 FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id WHERE t.owner_id = ? AND m.message_id = ?').get(uid, m.message_id)) continue;
        // Read = already seen: they go among the archived ones, as they were in the old Archive.
        const tid = newThread(uid, m.subject, m.date);
        db.prepare(`INSERT INTO mail_messages (thread_id, direction, message_id, from_addr, to_addr, cc, subject, body, attachments, date, read_at, created_at)
          VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(tid, m.message_id, m.from_addr, m.to_addr, m.cc, m.subject, m.body, m.attachments, m.date, m.read_at, now());
        if (m.read_at) db.prepare('UPDATE mail_threads SET archived_at = ? WHERE id = ?').run(m.read_at, tid);
        autoLink(tid, uid, `${m.subject} ${m.body}`);
      }
    }));
    acc.prepare('DELETE FROM mail_inbox WHERE user_id = ?').run(uid);
  }
}

// The addresses of the Thunderbird identities (the extension sends them when it connects).
route('POST', '/api/mail/identities', async ({ user, body }) => {
  const b = await body();
  const list = (Array.isArray(b.addresses) ? b.addresses : []).map(a => emailOf(str(a, 300))).filter(a => a.includes('@')).slice(0, 50);
  acc.prepare('UPDATE users SET mail_addresses = ? WHERE id = ?').run(JSON.stringify([...new Set(list)]), user.id);
}, { ws: false, quiet: true });

// ---------- from the extension ----------
route('GET', '/api/mail/stream', ({ req, res, user }) => openMailExtStream(req, res, user), { ws: false });

// The workspaces mail can go to (extension options: a workspace for each mail account).
route('GET', '/api/mail/workspaces', ({ user }) => {
  const def = defaultWorkspace(user.id);
  return mailWorkspaces(user, 'write').map(({ ws }) => ({ id: ws.id, name: ws.name, default: ws.id === def }));
}, { ws: false });

// "Open in Thunderbird": the extension opens the message in a tab (since 1.7). Requests are kept in memory.
const OPEN_EXT = '1.7';
const opens = new Map(); // user id → Message-IDs to open

route('POST', '/api/mail/messages/:id/open', ({ params, user }) => {
  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(+params.id) || fail(404, 'Message not found');
  getThread(m.thread_id, user);
  if (!mailExtOn(user.id)) fail(409, 'Thunderbird is not connected: open it and try again');
  if ((mailExtVersion(user.id) || '0').localeCompare(OPEN_EXT, undefined, { numeric: true }) < 0) {
    fail(409, 'Opening mails in Thunderbird needs extension {version}: update it from Settings → Mail', { version: OPEN_EXT });
  }
  opens.set(user.id, [...(opens.get(user.id) || []), m.message_id].slice(-10));
  notifyMailExt(user.id, 'open');
}, { area: 'mail', level: 'read', quiet: true });

route('GET', '/api/mail/opens', ({ user }) => {
  const list = opens.get(user.id) || [];
  opens.delete(user.id);
  return list;
}, { ws: false });

// The extension's package, already set up for this server (address and permission to connect here).
route('GET', '/api/mail/thunderbird.xpi', ({ req, res }) => {
  const origin = `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
  const dir = path.join(ROOT, 'thunderbird');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.permissions.push(`${origin}/*`);
  const files = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { name: 'config.json', data: Buffer.from(JSON.stringify({ server: origin })) },
    { name: 'icon.png', data: fs.readFileSync(path.join(ROOT, 'public/icons/icon-192.png')) },
    ...['background.js', 'options.html', 'options.js', '_locales/en/messages.json', '_locales/it/messages.json']
      .map(name => ({ name, data: fs.readFileSync(path.join(dir, name)) })),
  ];
  const data = zip(files);
  res.writeHead(200, {
    'Content-Type': 'application/x-xpinstall',
    'Content-Length': data.length,
    'Content-Disposition': 'attachment; filename="organizer-thunderbird.xpi"',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}, { ws: false });

// Mails to open, in all workspaces.
route('GET', '/api/mail/outbox', ({ user }) => {
  const since = new Date(Date.now() - OUTBOX_HOURS * 3600e3).toISOString();
  return mailWorkspaces(user, 'read').flatMap(({ ws }) => withWorkspace(ws, () => {
    db.prepare('DELETE FROM mail_outbox WHERE created_at < ?').run(new Date(Date.now() - 864e5).toISOString());
    return db.prepare(`SELECT o.id AS outbox_id, e.* FROM mail_outbox o JOIN entries e ON e.id = o.entry_id AND e.deleted_at IS NULL
      WHERE o.user_id = ? AND o.claimed_at IS NULL AND o.created_at > ? ORDER BY o.id`).all(user.id, since)
      .map(({ outbox_id: id, ...e }) => {
        const p = mailParts(e);
        const reply = e.reply_to && db.prepare('SELECT message_id FROM mail_messages WHERE id = ?').get(e.reply_to)?.message_id;
        return { ws: ws.id, id, to: p.to, cc: p.cc, subject: p.subject, body: p.body, reply_to: reply || null,
          files: p.files.map((f, i) => ({ n: i + 1, name: f.name, mime: f.mime })) };
      });
  }));
}, { ws: false });

const outboxRow = (id, user) => db.prepare('SELECT * FROM mail_outbox WHERE id = ? AND user_id = ?').get(+id, user.id) || fail(404, 'Request not found');

// Only one extension opens the mail, even if two are connected (two computers).
route('POST', '/api/mail/outbox/:ws/:id/claim', ({ params, user }) => inWorkspace(user, params.ws, 'read', () => {
  outboxRow(params.id, user);
  if (!db.prepare('UPDATE mail_outbox SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL').run(now(), +params.id).changes) fail(409, 'Already opened elsewhere');
}), { ws: false, quiet: true });

route('GET', '/api/mail/outbox/:ws/:id/file/:n', ({ res, params, user }) => inWorkspace(user, params.ws, 'read', () => {
  const o = outboxRow(params.id, user);
  const f = mailParts(db.prepare('SELECT * FROM entries WHERE id = ?').get(o.entry_id)).files[+params.n - 1] || fail(404, 'No such attachment');
  sendFile(res, f.file, f.name, f.mime);
}), { ws: false });

// Mail sent by Thunderbird: it is "sent", awaiting reply, and its Message-ID joins the conversation.
route('POST', '/api/mail/sent', async ({ user, body }) => {
  const b = await body();
  const wsId = inWorkspace(user, b.ws, 'write', (u, ws) => {
    const o = outboxRow(b.outbox_id, u);
    const e = entryFor(o.entry_id, u, 'write');
    tx(() => {
      updateEntry(e, { done: true, awaiting: true }, u);
      const tid = ensureEntryThread(e);
      const mid = cleanId(b.message_id);
      const date = str(b.date, 40) || now();
      if (mid) {
        // In the tree it sits under the message it replies to.
        const parent = e.reply_to ? db.prepare('SELECT message_id FROM mail_messages WHERE id = ?').get(e.reply_to)?.message_id || '' : '';
        db.prepare(`INSERT OR IGNORE INTO mail_messages (thread_id, entry_id, direction, message_id, in_reply_to, refs, from_addr, to_addr, cc, subject, body, date, read_at, created_at)
          VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(tid, e.id, mid, parent, JSON.stringify(parent ? [parent] : []), str(b.from, 300), str(b.to, 1000) || e.contact || '',
          str(b.cc, 1000) || e.mail_cc || '', str(b.subject, 300), mailParts(e).body, date, now(), now());
      }
      touchThread(tid, date);
      db.prepare('DELETE FROM mail_outbox WHERE id = ?').run(o.id);
      addLog(e.id, u.id, tr('sent by Thunderbird'), true);
    });
    return ws.id;
  });
  bump(user.id, wsId);
  notifyMailExt(user.id, 'watch');
}, { ws: false, quiet: true });

// Message-IDs of the followed conversations: the extension checks whether an incoming mail replies to one of them.
route('GET', '/api/mail/watch', ({ user }) => {
  const since = new Date(Date.now() - WATCH_DAYS * 864e5).toISOString();
  return mailWorkspaces(user, 'read').flatMap(({ ws }) => withWorkspace(ws, () =>
    db.prepare(`SELECT m.message_id FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id
      WHERE t.owner_id = ? AND t.deleted_at IS NULL AND m.date > ?`).all(user.id, since).map(r => r.message_id)));
}, { ws: false });

// A mail from Thunderbird: received, sent without going through Organizer, an old one requested to complete a
// conversation (history), a conversation brought in by hand (import) or the first load of the last month
// (backfill). It goes into the right conversation, in any workspace (see findThread: references, then the thread
// given by the extension, then subject and people); if there is none it opens a new one (in its own topic) in the
// mail account's workspace (ws, from the extension's options) or in the default one, but only with inbox (all the
// mail), import, backfill or
// history. Old ones, brought in by hand and loaded ones arrive already read and without notifications; import
// brings the conversation back among the active ones. It answers with the quoted Message-IDs Organizer does not
// have: the extension looks for them in Thunderbird and sends them with history: true.
route('POST', '/api/mail/incoming', async ({ user, body }) => {
  const b = await body();
  const mid = cleanId(b.message_id) || fail(400, 'Missing Message-ID');
  const inReplyTo = cleanId(b.in_reply_to);
  const refs = [...new Set([...(Array.isArray(b.references) ? b.references : []), b.in_reply_to].map(cleanId).filter(Boolean))].slice(-50);
  const direction = b.direction === 'out' ? 'out' : 'in';
  const history = !!b.history;
  const imported = !!b.import; // picked by hand in Thunderbird ("Bring the thread into Organizer")
  const backfill = !!b.backfill;
  const quiet = history || imported || backfill;
  const date = str(b.date, 40) || now();
  const spaces = mailWorkspaces(user, 'write');
  const mine = new Set(mailAddressesOf(user.id).map(a => a.toLowerCase()));
  const people = [...new Set([b.from, b.to, b.cc].flatMap(emailsOf).map(a => a.toLowerCase()))].filter(a => !mine.has(a));
  const each = fn => { for (const { ws } of spaces) { const r = withWorkspace(ws, () => fn(ws)); if (r) return r; } return null; };
  // A message of a conversation in the trash is already seen: it does not reopen it nor create another (by hand it does).
  if (!imported && each(() => db.prepare(`SELECT 1 FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id
    WHERE m.message_id = ? AND t.owner_id = ? AND t.deleted_at IS NOT NULL`).get(mid, user.id))) return { matched: true, thread: null, missing: [] };
  const live = 'SELECT 1 FROM mail_threads t WHERE t.id = m.thread_id AND t.owner_id = ? AND t.deleted_at IS NULL';
  let hit = each(ws => {
    const seen = db.prepare(`SELECT m.id, m.thread_id FROM mail_messages m WHERE m.message_id = ? AND EXISTS (${live})`).get(mid, user.id);
    return seen && { ws, thread: seen.thread_id, seen };
  });
  hit ||= each(ws => { const t = findThread(user.id, { refs }); return t && { ws, thread: t }; });
  if (!hit && b.thread) {
    hit = each(ws => (db.prepare('SELECT 1 FROM mail_threads WHERE id = ? AND owner_id = ? AND deleted_at IS NULL').get(+b.thread, user.id) ? { ws, thread: +b.thread } : null));
  }
  hit ||= each(ws => { const t = findThread(user.id, { subject: b.subject, people, date }); return t && { ws, thread: t }; });
  if (!hit && !b.inbox && !quiet) return { matched: false, missing: [] };
  if (!hit) {
    // The mail account's workspace (chosen in the extension's options), otherwise the default one.
    const ws = spaces.find(x => x.ws.id === +b.ws)?.ws || spaces.find(x => x.ws.id === defaultWorkspace(user.id))?.ws || spaces[0]?.ws
      || fail(409, 'No workspace to put the mail in');
    hit = { ws, thread: withWorkspace(ws, () => newThread(user.id, b.subject, date)) };
  }
  const fromName = (String(b.from || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim() || emailOf(b.from) || 'qualcuno');
  const { missing, topic } = withWorkspace(hit.ws, () => {
    tx(() => {
      if (hit.seen) {
        // Already here (e.g. from an old version of the extension): the references for the tree are completed.
        db.prepare("UPDATE mail_messages SET in_reply_to = ?, refs = ? WHERE id = ? AND refs = '[]'").run(inReplyTo, JSON.stringify(refs), hit.seen.id);
        if (imported) touchThread(hit.thread, date);
        return;
      }
      db.prepare(`INSERT OR IGNORE INTO mail_messages (thread_id, direction, message_id, in_reply_to, refs, from_addr, to_addr, cc, subject, body,
        attachments, date, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(hit.thread, direction, mid, inReplyTo, JSON.stringify(refs),
        str(b.from, 300), str(b.to, 1000), str(b.cc, 1000), str(b.subject, 300), str(b.body, 100000), cleanAttachments(b.attachments), date,
        direction === 'out' || quiet ? now() : null, now());
      // A new reply (or a conversation brought in by hand) goes back among the active ones and closes the waits.
      touchThread(hit.thread, date, { reactivate: imported || !quiet });
      if (direction === 'in' && !quiet) {
        db.prepare('UPDATE entries SET awaiting_reply = 0, updated_at = ? WHERE thread_id = ? AND awaiting_reply = 1').run(now(), hit.thread);
      }
      autoLink(hit.thread, user.id, `${b.subject || ''} ${b.body || ''}`);
    });
    const have = new Set(db.prepare('SELECT message_id FROM mail_messages WHERE thread_id = ?').all(hit.thread).map(r => r.message_id));
    return { missing: refs.filter(r => !have.has(r)), topic: db.prepare('SELECT topic_id FROM mail_threads WHERE id = ?').get(hit.thread).topic_id };
  });
  // Notification for mails that just arrived (not for history, loads, those recovered when connecting).
  const fresh = Date.now() - Date.parse(date) < 15 * 60e3;
  if (!hit.seen && direction === 'in' && !quiet && fresh) {
    notify([user.id], { ws: hit.ws.id, kind: 'mail', title: ['Mail from {name}', { name: fromName }], body: str(b.subject, 300) || ['(no subject)'], url: `#/t/${topic}?th=${hit.thread}`, tag: `mail-${hit.thread}` });
  }
  bump(user.id, hit.ws.id);
  notifyMailExt(user.id, 'watch');
  return { matched: true, thread: hit.thread, missing };
}, { ws: false, quiet: true });

// A person's first connection (or after the switch to topics): the extension loads the last month from all the
// folders and then says so. since null = already done.
route('GET', '/api/mail/backfill', ({ user }) => ({
  since: acc.prepare('SELECT mail_backfill_at FROM users WHERE id = ?').get(user.id)?.mail_backfill_at ? null : new Date(Date.now() - 31 * 864e5).toISOString(),
}), { ws: false });

route('POST', '/api/mail/backfill/done', ({ user }) => {
  acc.prepare('UPDATE users SET mail_backfill_at = ? WHERE id = ?').run(now(), user.id);
}, { ws: false, quiet: true });

// ---------- received attachments: preview and inventory documents ----------
// The file is in Thunderbird: Organizer asks the extension to upload it, as an item's document (with the same API
// as uploads, in the active workspace) or for the preview (preview: it sends it here and the server keeps it in
// memory for a while; reopening it or sending it to the inventory soon after no longer goes through Thunderbird).
// Requests are kept in memory: if the server restarts they are made again from the app.
const fetches = new Map(); // id → request
let fetchSeq = 0;
const PREVIEW_EXT = '1.6'; // the first version of the extension that can send an attachment for the preview
const PREVIEW_WAIT = 60e3;
const PREVIEW_TTL = 30 * 60e3;
const PREVIEW_MAX = 60 * 1048576;
const PREVIEW_CACHE = 200 * 1048576;
const previews = new Map(); // "workspace:message:n" → { buf, type, at }, oldest first
const waiting = new Map(); // same key → Promise of the file the extension is sending

function receivedAttachment(user, msgId, n) {
  const src = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(+msgId) || fail(404, 'Message not found');
  getThread(src.thread_id, user);
  const att = JSON.parse(src.attachments || '[]')[+n] || fail(404, 'No such attachment');
  if (!att.part) fail(400, 'This attachment cannot be fetched: the mail arrived with an old version of the extension');
  return { src, att, key: `${user.workspace_id}:${src.id}:${+n}` };
}

function cachedPreview(key) {
  for (const [k, f] of previews) if (Date.now() - f.at > PREVIEW_TTL) previews.delete(k);
  return previews.get(key) || null;
}

function cachePreview(key, file) {
  previews.delete(key);
  previews.set(key, file);
  let total = [...previews.values()].reduce((n, f) => n + f.buf.length, 0);
  for (const [k, f] of previews) {
    if (total <= PREVIEW_CACHE || k === key) break;
    previews.delete(k);
    total -= f.buf.length;
  }
}

const newFetch = f => { const id = ++fetchSeq; fetches.set(id, { id, created: Date.now(), ...f }); return id; };

// The file of a received attachment, to view it: from memory or requested from Thunderbird (waiting for it).
route('GET', '/api/mail/messages/:id/attachments/:n', async ({ res, params, user }) => {
  const { src, att, key } = receivedAttachment(user, params.id, params.n);
  let f = cachedPreview(key);
  if (!f) {
    if (!waiting.has(key)) {
      if (!mailExtOn(user.id)) fail(409, 'Thunderbird is not connected: the file is there, open it and try again');
      if ((mailExtVersion(user.id) || '0').localeCompare(PREVIEW_EXT, undefined, { numeric: true }) < 0) {
        fail(409, 'The preview needs Thunderbird extension {version}: update it from Settings → Mail', { version: PREVIEW_EXT });
      }
      const p = new Promise((resolve, reject) => {
        const id = newFetch({ user: user.id, ws: user.workspace_id, preview: true, message_id: src.message_id, part: att.part, name: att.name, type: att.type, key, resolve, reject });
        setTimeout(() => { fetches.delete(id); reject(new HttpError(409, 'Thunderbird did not send the file: try again')); }, PREVIEW_WAIT);
      });
      p.catch(() => {}).finally(() => waiting.delete(key));
      waiting.set(key, p);
      notifyMailExt(user.id, 'fetch');
    }
    f = await waiting.get(key);
  }
  const name = att.name || 'allegato';
  res.writeHead(200, {
    'Content-Type': f.type,
    'Content-Length': f.buf.length,
    'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'no-store',
  });
  res.end(f.buf);
}, { area: 'mail', quiet: true });

// "→ inventory": if the file is already here (preview just seen) it becomes a document at once, otherwise Thunderbird uploads it.
route('POST', '/api/mail/attachments/save', async ({ user, body }) => {
  const b = await body();
  const it = db.prepare('SELECT id, code FROM items WHERE id = ? AND deleted_at IS NULL').get(+b.item_id) || fail(404, 'Item not found');
  const { src, att, key } = receivedAttachment(user, b.id, b.n);
  const cached = cachedPreview(key);
  if (cached) {
    const req = Object.assign(Readable.from([cached.buf]), { headers: { 'content-length': String(cached.buf.length), 'content-type': cached.type } });
    const { stored, size, sha256, mime } = await saveUpload(req);
    db.prepare(`INSERT INTO documents (item_id, kind, label, version, filename, mime, size, sha256, stored, created_by, created_at)
      VALUES (?, ?, '', '', ?, ?, ?, ?, ?, ?, ?)`).run(it.id, docKind(b.kind), str(att.name, 255) || 'file', mime, size, sha256, stored, user.id, now());
    bump(user.id, user.workspace_id);
    return { code: it.code, saved: true };
  }
  if (!mailExtOn(user.id)) fail(409, 'Thunderbird is not connected: the file is there, open it and try again');
  newFetch({ user: user.id, ws: user.workspace_id, item_id: it.id, kind: docKind(b.kind), message_id: src.message_id, part: att.part, name: att.name, type: att.type });
  notifyMailExt(user.id, 'fetch');
  return { code: it.code };
}, { area: 'documenti', quiet: true });

// Requests for the extension. Preview ones only to the versions that know them (they send their version).
route('GET', '/api/mail/fetches', ({ req, user }) => {
  for (const [id, f] of fetches) if (Date.now() - f.created > 3600e3) fetches.delete(id);
  const previewOk = String(req.headers['x-organizer-ext'] || '0').localeCompare(PREVIEW_EXT, undefined, { numeric: true }) >= 0;
  return [...fetches.values()].filter(f => f.user === user.id && !f.claimed && (previewOk || !f.preview))
    .map(f => ({ id: f.id, ws: f.ws, preview: !!f.preview, item_id: f.item_id, kind: f.kind, message_id: f.message_id, part: f.part, name: f.name, type: f.type }));
}, { ws: false });

route('POST', '/api/mail/fetches/:id/claim', ({ params, user }) => {
  const f = fetches.get(+params.id);
  if (!f || f.user !== user.id) fail(404, 'Request not found');
  if (f.claimed) fail(409, 'Already taken');
  f.claimed = true;
}, { ws: false, quiet: true });

// A preview's file, from the extension.
route('POST', '/api/mail/fetches/:id/file', async ({ req, params, user }) => {
  const f = fetches.get(+params.id);
  if (!f?.preview || f.user !== user.id) fail(404, 'Request not found');
  fetches.delete(f.id);
  try {
    const buf = await readBody(req, PREVIEW_MAX);
    const file = { buf, type: str(req.headers['content-type'], 100) || f.type || 'application/octet-stream', at: Date.now() };
    cachePreview(f.key, file);
    f.resolve(file);
  } catch (e) {
    f.reject(e.status === 413 ? new HttpError(413, 'File too large for the preview (max {mb} MB): send it to the inventory or open it in Thunderbird', { mb: PREVIEW_MAX >> 20 }) : e);
    throw e;
  }
}, { ws: false, quiet: true });

// Done (or failed: error says why, and the preview that was waiting shows it).
route('POST', '/api/mail/fetches/:id/done', async ({ params, user, body }) => {
  const f = fetches.get(+params.id);
  if (f?.user !== user.id) return;
  fetches.delete(f.id);
  const b = await body().catch(() => ({}));
  f.reject?.(new HttpError(409, b.error ? 'Thunderbird: {error}' : 'Thunderbird did not send the file', b.error ? { error: str(b.error, 300) } : null));
}, { ws: false, quiet: true });
