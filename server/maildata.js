// Mail by topic (see migrations v19-v21 in db.js): data and helpers used by /api/sync, by entry creation and by the
// bridge with Thunderbird. Everything is personal (owner_id): nobody else sees a person's mail.
//  - a topic gathers one or more conversations (mail_threads); by default each conversation has its own;
//  - a conversation is the tree of its messages (in_reply_to, refs) plus the mails written in Organizer;
//  - archiving applies to the conversation; a topic is archived when all of its conversations are.
// PVIS_ANY comes from api.js (which imports this file): it is used only inside functions, never at load time.
import { db } from './db.js';
import { PVIS_ANY } from './api.js';
import { now } from './util.js';
import { tr } from './i18n.js';

// "Re: R: Fwd: I: subject" → "subject": the thread's title.
export const cleanSubject = s => String(s || '').replace(/^\s*((re|r|fw|fwd|i|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();

export function newTopic(ownerId, title, at = now()) {
  return Number(db.prepare('INSERT INTO mail_topics (owner_id, title, created_at) VALUES (?, ?, ?)')
    .run(ownerId, cleanSubject(title).slice(0, 300) || tr('(no subject)'), at).lastInsertRowid);
}

// A new conversation, in the given topic or in one of its own.
export function newThread(ownerId, subject, at = now(), topicId = null) {
  const topic = topicId || newTopic(ownerId, subject, at);
  return Number(db.prepare('INSERT INTO mail_threads (owner_id, topic_id, subject, last_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ownerId, topic, cleanSubject(subject).slice(0, 300) || tr('(no subject)'), at, now()).lastInsertRowid);
}

// Every mail written in Organizer is in a thread: if it does not have one yet (just created) it gets one.
export function ensureEntryThread(e) {
  if (e.kind !== 'mail' || e.thread_id) return e.thread_id;
  const id = newThread(e.created_by, e.mail_subject || e.title);
  db.prepare('UPDATE entries SET thread_id = ? WHERE id = ?').run(id, e.id);
  return id;
}

// A thread without a topic (its own disappeared while the thread was in the trash) gets a new one.
export function ensureTopic(threadId) {
  const t = db.prepare('SELECT id, owner_id, subject, topic_id FROM mail_threads WHERE id = ?').get(threadId);
  if (t && !t.topic_id) db.prepare('UPDATE mail_threads SET topic_id = ? WHERE id = ?').run(newTopic(t.owner_id, t.subject), t.id);
}

// La conversazione si muove: torna tra le attive (salvo da storia vecchia) e l'ultima data si aggiorna.
export function touchThread(threadId, date, { reactivate = true } = {}) {
  const was = db.prepare('SELECT archived_at FROM mail_threads WHERE id = ?').get(threadId);
  db.prepare(`UPDATE mail_threads SET last_at = MAX(last_at, ?)${reactivate ? ', archived_at = NULL' : ''} WHERE id = ?`).run(date || now(), threadId);
  ensureTopic(threadId);
  if (reactivate && was?.archived_at) relinkThread(threadId); // torna attiva: si ricontrolla tutta
}

// Topics left without conversations (moved elsewhere or deleted): they disappear.
export function dropEmptyTopics(ownerId) {
  db.prepare(`DELETE FROM mail_topics WHERE owner_id = ? AND id NOT IN
    (SELECT topic_id FROM mail_threads WHERE topic_id IS NOT NULL AND deleted_at IS NULL)`).run(ownerId);
}

// Inventory codes (main and alternative, also without #) and projects (the tag, with or without @) written in
// subject and text become automatic links. Those removed by hand stay hidden: they do not come back.
// Codes with digits are also recognised when written loosely: without dashes, dots or slashes and without leading
// zeros in numbers ("sch44", "SCH.044" → SCH-44); letter-only codes only as they are.
const bare = s => String(s || '').toUpperCase().replace(/[-_./]+/g, '').replace(/(^|\D)0+(?=\d)/g, '$1');

// Given a text, tells whether a code (or a tag) appears in it: whole, or loosely for codes with digits.
// Two-character codes: only a letter and a digit (Q5, R1); acronyms of only letters or digits (OK, 12) are not.
const shortCode = w => w.length === 2 && /[A-Z]/.test(w) && /\d/.test(w);

function matcher(text) {
  const t = ` ${String(text || '')} `.toUpperCase();
  // The text's "words" (letters and digits, also joined by - _ . /), in their loose form.
  const words = new Set((String(text || '').match(/[A-Za-z0-9]+(?:[-_./][A-Za-z0-9]+)*/g) || []).map(bare));
  return (code, loose = true) => {
    const word = String(code || '').toUpperCase();
    if (word.length < 3 && !shortCode(word)) return false;
    for (let at = t.indexOf(word); at >= 0; at = t.indexOf(word, at + 1)) {
      if (!/[A-Z0-9]/.test(t[at - 1]) && !/[A-Z0-9]/.test(t[at + word.length])) return true; // not inside a longer word
    }
    const b = bare(word);
    return loose && /\d/.test(word) && (b.length >= 3 || shortCode(b)) && words.has(b);
  };
}

const linkAuto = (threadId, kind, id) => db.prepare('INSERT OR IGNORE INTO mail_thread_links (thread_id, kind, target_id, auto) VALUES (?, ?, ?, 1)').run(threadId, kind, id);

export function autoLink(threadId, uid, text) {
  const has = matcher(text);
  for (const { id, code } of db.prepare(`SELECT id, code FROM items WHERE deleted_at IS NULL
    UNION SELECT a.item_id, a.code FROM item_aliases a JOIN items i ON i.id = a.item_id WHERE i.deleted_at IS NULL`).all()) {
    if (has(code)) linkAuto(threadId, 'articolo', id);
  }
  for (const { id, tag } of db.prepare(`SELECT p.id, p.tag FROM projects p WHERE p.deleted_at IS NULL AND ${PVIS_ANY}`).all({ uid })) {
    if (has(tag, false)) linkAuto(threadId, 'progetto', id);
  }
}

// All the text of a conversation: subjects and texts of the messages, mails written in Organizer.
function threadText(threadId) {
  return [
    ...db.prepare('SELECT subject, body FROM mail_messages WHERE thread_id = ?').all(threadId).flatMap(m => [m.subject, m.body]),
    ...db.prepare('SELECT title, mail_subject, notes FROM entries WHERE thread_id = ? AND deleted_at IS NULL').all(threadId).flatMap(e => [e.title, e.mail_subject, e.notes]),
  ].join('\n');
}

// Automatic link to an item the text no longer mentions (code changed or removed): gone. Those picked by hand
// (auto = 0) and those removed by hand (hidden, they must stay hidden) are not touched.
const unlinkAuto = (threadId, itemId) => db.prepare(`DELETE FROM mail_thread_links
  WHERE thread_id = ? AND kind = 'articolo' AND target_id = ? AND auto = 1 AND hidden = 0`).run(threadId, itemId);
const codesOf = itemId => db.prepare(`SELECT code FROM items WHERE id = $id AND deleted_at IS NULL
  UNION SELECT code FROM item_aliases WHERE item_id = $id`).all({ id: itemId }).map(r => r.code);

// A conversation to re-check entirely (e.g. active again after the archive): new links are added, automatic ones
// to codes it no longer mentions are removed.
export function relinkThread(threadId) {
  const t = db.prepare('SELECT owner_id FROM mail_threads WHERE id = ? AND deleted_at IS NULL').get(threadId);
  if (!t) return;
  const text = threadText(threadId);
  autoLink(threadId, t.owner_id, text);
  const has = matcher(text);
  for (const { target_id: id } of db.prepare(`SELECT target_id FROM mail_thread_links
    WHERE thread_id = ? AND kind = 'articolo' AND auto = 1 AND hidden = 0`).all(threadId)) {
    if (!codesOf(id).some(c => has(c))) unlinkAuto(threadId, id);
  }
}

// An item whose codes changed (new, code changed, alternative added or removed): in the active conversations it is
// linked where it is mentioned and unlinked (if the link was automatic) where it no longer is. Archived ones are
// re-checked when they become active again.
export function relinkItem(itemId) {
  const codes = codesOf(itemId);
  for (const { id } of db.prepare('SELECT id FROM mail_threads WHERE archived_at IS NULL AND deleted_at IS NULL').all()) {
    const has = matcher(threadText(id));
    if (codes.some(c => has(c))) linkAuto(id, 'articolo', itemId);
    else unlinkAuto(id, itemId);
  }
}

// The conversation of a message Organizer does not have yet:
//  1. that of a quoted message (References, In-Reply-To), the most recent one;
//  2. otherwise same subject (without Re:, R:, Fwd:…) and at least one person in common, within 60 days: many
//     clients do not send the references. people: the message's addresses, without ours.
const DAY = 864e5;
export function findThread(uid, { refs = [], subject = '', people = [], date = now() }) {
  if (refs.length) {
    const r = db.prepare(`SELECT m.thread_id FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id
      WHERE m.message_id IN (${refs.map(() => '?').join(',')}) AND t.owner_id = ? AND t.deleted_at IS NULL ORDER BY m.date DESC LIMIT 1`).get(...refs, uid);
    if (r) return r.thread_id;
  }
  const subj = cleanSubject(subject).toLowerCase();
  if (subj.length < 4 || !people.length) return null;
  const when = Date.parse(date) || Date.now();
  const want = people.map(p => p.toLowerCase());
  const candidates = db.prepare(`SELECT id, subject FROM mail_threads WHERE owner_id = ? AND deleted_at IS NULL
    AND last_at BETWEEN ? AND ? ORDER BY last_at DESC LIMIT 200`)
    .all(uid, new Date(when - 60 * DAY).toISOString(), new Date(when + 60 * DAY).toISOString());
  for (const c of candidates) {
    const msgs = db.prepare('SELECT subject, from_addr, to_addr, cc FROM mail_messages WHERE thread_id = ?').all(c.id);
    const ents = db.prepare('SELECT mail_subject, title, contact, mail_cc FROM entries WHERE thread_id = ? AND deleted_at IS NULL').all(c.id);
    const subjects = new Set([c.subject, ...msgs.map(m => m.subject), ...ents.map(e => e.mail_subject || e.title)].map(s => cleanSubject(s).toLowerCase()));
    if (!subjects.has(subj)) continue;
    const addrs = [...msgs.flatMap(m => [m.from_addr, m.to_addr, m.cc]), ...ents.flatMap(e => [e.contact, e.mail_cc])].join(',').toLowerCase();
    if (want.some(a => addrs.includes(a))) return c.id;
  }
  return null;
}

// For /api/sync: the person's topics, conversations, messages (without the full text) and links. The links:
// picked by hand, found in the messages, mentioned in the mails written in Organizer (entry_links, items,
// projects); minus those removed by hand.
export function threadsSync(uid) {
  const own = 'SELECT id FROM mail_threads WHERE owner_id = $uid AND deleted_at IS NULL';
  return {
    mailTopics: db.prepare('SELECT id, title, hue, starred, created_at FROM mail_topics WHERE owner_id = $uid').all({ uid }),
    topicLinks: db.prepare(`SELECT l.topic_id, l.kind, l.target_id FROM mail_topic_links l JOIN mail_topics t ON t.id = l.topic_id
      WHERE t.owner_id = $uid`).all({ uid }),
    mailThreads: db.prepare(`SELECT id, topic_id, subject, hue, starred, archived_at, last_at, created_at FROM mail_threads
      WHERE id IN (${own}) ORDER BY last_at DESC`).all({ uid }),
    mailMsgs: db.prepare(`SELECT id, thread_id, entry_id, direction, message_id, in_reply_to, refs, from_addr, to_addr, cc, subject,
      substr(body, 1, 240) AS snippet, attachments != '[]' AS has_att, date, read_at FROM mail_messages WHERE thread_id IN (${own}) ORDER BY date, id`).all({ uid }),
    threadLinks: db.prepare(`SELECT * FROM (
      SELECT thread_id, kind, target_id, auto, 1 AS manual FROM mail_thread_links WHERE thread_id IN (${own}) AND hidden = 0
      UNION SELECT e.thread_id, l.kind, l.target_id, 1, 0 FROM entry_links l JOIN entries e ON e.id = l.entry_id
        WHERE e.thread_id IN (${own}) AND e.deleted_at IS NULL
      UNION SELECT e.thread_id, 'articolo', i.item_id, 1, 0 FROM entry_items i JOIN entries e ON e.id = i.entry_id
        WHERE e.thread_id IN (${own}) AND e.deleted_at IS NULL
      UNION SELECT e.thread_id, 'progetto', e.project_id, 1, 0 FROM entries e
        WHERE e.thread_id IN (${own}) AND e.deleted_at IS NULL AND e.project_id IS NOT NULL
    ) x WHERE NOT EXISTS (SELECT 1 FROM mail_thread_links h WHERE h.thread_id = x.thread_id AND h.kind = x.kind
      AND h.target_id = x.target_id AND h.hidden = 1)`).all({ uid }),
  };
}
