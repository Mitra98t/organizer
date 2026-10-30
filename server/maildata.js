// Posta a topic (vedi le migrazioni v19-v21 in db.js): dati e aiuti usati da /api/sync, dalla creazione delle
// voci e dal ponte con Thunderbird. Tutto è personale (owner_id): nessun altro vede la posta di una persona.
//  - un topic raccoglie una o più conversazioni (mail_threads); di base ogni conversazione ha il suo;
//  - una conversazione è l'albero dei suoi messaggi (in_reply_to, refs) più le mail scritte in Organizer;
//  - archiviata è la conversazione; un topic è archiviato quando lo sono tutte le sue.
// PVIS_ANY viene da api.js (che importa questo file): si usa solo dentro le funzioni, mai al caricamento.
import { db } from './db.js';
import { PVIS_ANY } from './api.js';
import { now } from './util.js';

// "Re: R: Fwd: I: oggetto" → "oggetto": il titolo del thread.
export const cleanSubject = s => String(s || '').replace(/^\s*((re|r|fw|fwd|i|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();

export function newTopic(ownerId, title, at = now()) {
  return Number(db.prepare('INSERT INTO mail_topics (owner_id, title, created_at) VALUES (?, ?, ?)')
    .run(ownerId, cleanSubject(title).slice(0, 300) || '(senza oggetto)', at).lastInsertRowid);
}

// Una conversazione nuova, nel topic dato o in uno tutto suo.
export function newThread(ownerId, subject, at = now(), topicId = null) {
  const topic = topicId || newTopic(ownerId, subject, at);
  return Number(db.prepare('INSERT INTO mail_threads (owner_id, topic_id, subject, last_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ownerId, topic, cleanSubject(subject).slice(0, 300) || '(senza oggetto)', at, now()).lastInsertRowid);
}

// Ogni mail scritta in Organizer sta in un thread: se non ce l'ha ancora (appena creata) gliene si dà uno.
export function ensureEntryThread(e) {
  if (e.kind !== 'mail' || e.thread_id) return e.thread_id;
  const id = newThread(e.created_by, e.mail_subject || e.title);
  db.prepare('UPDATE entries SET thread_id = ? WHERE id = ?').run(id, e.id);
  return id;
}

// Un thread senza topic (il suo è sparito mentre il thread era nel cestino) ne riceve uno nuovo.
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

// Topic rimasti senza conversazioni (spostate altrove o eliminate): spariscono.
export function dropEmptyTopics(ownerId) {
  db.prepare(`DELETE FROM mail_topics WHERE owner_id = ? AND id NOT IN
    (SELECT topic_id FROM mail_threads WHERE topic_id IS NOT NULL AND deleted_at IS NULL)`).run(ownerId);
}

// Codici di magazzino (principali e alternativi, anche senza #) e progetti (il tag, con o senza @) scritti in
// oggetto e testo diventano collegamenti automatici. Quelli tolti a mano restano nascosti (hidden): non tornano.
// I codici con dei numeri si riconoscono anche scritti alla buona: senza trattini, punti o barre e senza gli zeri
// davanti ai numeri ("sch44", "SCH.044" → SCH-44); quelli di sole lettere solo come sono.
const bare = s => String(s || '').toUpperCase().replace(/[-_./]+/g, '').replace(/(^|\D)0+(?=\d)/g, '$1');

// Dato un testo, dice se un codice (o un tag) ci compare: intero, o alla buona per i codici con numeri.
function matcher(text) {
  const t = ` ${String(text || '')} `.toUpperCase();
  // Le "parole" del testo (lettere e cifre, anche unite da - _ . /), nella forma alla buona.
  const words = new Set((String(text || '').match(/[A-Za-z0-9]+(?:[-_./][A-Za-z0-9]+)*/g) || []).map(bare));
  return (code, loose = true) => {
    const word = String(code || '').toUpperCase();
    if (word.length < 3) return false;
    for (let at = t.indexOf(word); at >= 0; at = t.indexOf(word, at + 1)) {
      if (!/[A-Z0-9]/.test(t[at - 1]) && !/[A-Z0-9]/.test(t[at + word.length])) return true; // non dentro una parola più lunga
    }
    return loose && /\d/.test(word) && bare(word).length >= 3 && words.has(bare(word));
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

// Tutto il testo di una conversazione: oggetti e testi dei messaggi, mail scritte in Organizer.
function threadText(threadId) {
  return [
    ...db.prepare('SELECT subject, body FROM mail_messages WHERE thread_id = ?').all(threadId).flatMap(m => [m.subject, m.body]),
    ...db.prepare('SELECT title, mail_subject, notes FROM entries WHERE thread_id = ? AND deleted_at IS NULL').all(threadId).flatMap(e => [e.title, e.mail_subject, e.notes]),
  ].join('\n');
}

// Una conversazione da ricontrollare per intero (es. torna attiva dopo l'archivio).
export function relinkThread(threadId) {
  const t = db.prepare('SELECT owner_id FROM mail_threads WHERE id = ? AND deleted_at IS NULL').get(threadId);
  if (t) autoLink(threadId, t.owner_id, threadText(threadId));
}

// Un articolo con un codice nuovo (cambiato, alternativo aggiunto, articolo appena creato): le conversazioni
// attive che lo citano si collegano. Quelle archiviate no: si ricontrollano se tornano attive.
export function relinkItem(itemId) {
  const codes = db.prepare(`SELECT code FROM items WHERE id = $id AND deleted_at IS NULL
    UNION SELECT code FROM item_aliases WHERE item_id = $id`).all({ id: itemId }).map(r => r.code);
  if (!codes.length) return 0;
  let n = 0;
  for (const { id } of db.prepare('SELECT id FROM mail_threads WHERE archived_at IS NULL AND deleted_at IS NULL').all()) {
    const has = matcher(threadText(id));
    if (codes.some(c => has(c)) && linkAuto(id, 'articolo', itemId).changes) n++;
  }
  return n;
}

// La conversazione di un messaggio che Organizer non ha ancora:
//  1. quella di un messaggio citato (References, In-Reply-To), il più recente;
//  2. altrimenti stesso oggetto (senza Re:, R:, Fwd:…) e almeno una persona in comune, entro 60 giorni: molti
//     client non mandano i riferimenti. people: gli indirizzi del messaggio, senza i nostri.
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

// Per /api/sync: topic, conversazioni, messaggi (senza il testo intero) e collegamenti della persona. I
// collegamenti: scelti a mano, trovati nei messaggi, citati nelle mail scritte in Organizer (entry_links,
// articoli, progetti); meno quelli tolti a mano.
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
