// Thread di mail (vedi la migrazione v19 in db.js): dati e aiuti senza dipendenze da api.js, perché li usano
// /api/sync, la creazione delle voci e il ponte con Thunderbird. Un thread è personale (owner_id).
import { db } from './db.js';
import { now } from './util.js';

// "Re: R: Fwd: I: oggetto" → "oggetto": il titolo del thread.
export const cleanSubject = s => String(s || '').replace(/^\s*((re|r|fw|fwd|i|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();

export function newThread(ownerId, subject, at = now()) {
  return Number(db.prepare('INSERT INTO mail_threads (owner_id, subject, last_at, created_at) VALUES (?, ?, ?, ?)')
    .run(ownerId, cleanSubject(subject).slice(0, 300) || '(senza oggetto)', at, now()).lastInsertRowid);
}

// Ogni mail scritta in Organizer sta in un thread: se non ce l'ha ancora (appena creata) gliene si dà uno.
export function ensureEntryThread(e) {
  if (e.kind !== 'mail' || e.thread_id) return e.thread_id;
  const id = newThread(e.created_by, e.mail_subject || e.title);
  db.prepare('UPDATE entries SET thread_id = ? WHERE id = ?').run(id, e.id);
  return id;
}

// Il thread si muove: torna tra gli attivi (salvo da storia vecchia) e l'ultima data si aggiorna.
export function touchThread(threadId, date, { reactivate = true } = {}) {
  db.prepare(`UPDATE mail_threads SET last_at = MAX(last_at, ?)${reactivate ? ', archived_at = NULL' : ''} WHERE id = ?`).run(date || now(), threadId);
}

// Codici di magazzino scritti in un messaggio (anche senza #): diventano collegamenti del thread.
export function autoLinkItems(threadId, text) {
  const t = ` ${String(text || '')} `.toUpperCase();
  const codes = db.prepare(`SELECT id, code FROM items WHERE deleted_at IS NULL
    UNION SELECT item_id, code FROM item_aliases`).all();
  for (const { id, code } of codes) {
    if (code.length < 3) continue;
    const at = t.indexOf(code.toUpperCase());
    if (at < 0) continue;
    const before = t[at - 1];
    const after = t[at + code.length];
    if (/[A-Z0-9]/.test(before) || /[A-Z0-9]/.test(after)) continue; // parte di una parola più lunga
    db.prepare("INSERT OR IGNORE INTO mail_thread_links (thread_id, kind, target_id, auto) VALUES (?, 'articolo', ?, 1)").run(threadId, id);
  }
}

// Per /api/sync: i thread della persona, i loro messaggi (senza il testo intero) e i collegamenti: scelti a mano,
// trovati nei messaggi, citati nelle mail scritte in Organizer (entry_links, articoli, progetti).
export function threadsSync(uid) {
  const own = 'SELECT id FROM mail_threads WHERE owner_id = $uid AND deleted_at IS NULL';
  return {
    mailThreads: db.prepare(`SELECT id, subject, archived_at, last_at, created_at FROM mail_threads WHERE id IN (${own}) ORDER BY last_at DESC`).all({ uid }),
    mailMsgs: db.prepare(`SELECT id, thread_id, entry_id, direction, from_addr, to_addr, cc, subject, substr(body, 1, 240) AS snippet,
      attachments != '[]' AS has_att, date, read_at FROM mail_messages WHERE thread_id IN (${own}) ORDER BY date, id`).all({ uid }),
    threadLinks: db.prepare(`SELECT thread_id, kind, target_id, auto, 1 AS manual FROM mail_thread_links WHERE thread_id IN (${own})
      UNION SELECT e.thread_id, l.kind, l.target_id, 1, 0 FROM entry_links l JOIN entries e ON e.id = l.entry_id
        WHERE e.thread_id IN (${own}) AND e.deleted_at IS NULL
      UNION SELECT e.thread_id, 'articolo', i.item_id, 1, 0 FROM entry_items i JOIN entries e ON e.id = i.entry_id
        WHERE e.thread_id IN (${own}) AND e.deleted_at IS NULL
      UNION SELECT e.thread_id, 'progetto', e.project_id, 1, 0 FROM entries e
        WHERE e.thread_id IN (${own}) AND e.deleted_at IS NULL AND e.project_id IS NOT NULL`).all({ uid }),
  };
}
