// Trash: everything deleted stays recoverable for TRASH_DAYS days, then it is really deleted.
import fs from 'node:fs';
import path from 'node:path';
import { db, tx, UPLOAD_DIR } from './db.js';
import { route, VIS_ANY, PVIS_ANY, CVIS_ANY, NVIS_ANY, TRASH_ALONE } from './api.js';
import { fail } from './util.js';
import { ensureEntryThread, ensureTopic } from './maildata.js';
import { allows, assertCan, entryArea, readableKinds } from './perms.js';

export const TRASH_DAYS = +process.env.TRASH_DAYS || 30;


// For each kind: how to find an item in the trash visible to the user and how to restore it.
const TYPES = {
  entry: {
    find: (id, uid) => db.prepare(`SELECT e.* FROM entries e WHERE e.id = $id AND e.deleted_at IS NOT NULL AND ${VIS_ANY}`).get({ id, uid }),
    restore: e => {
      db.prepare('UPDATE entries SET deleted_at = NULL, deleted_by = NULL WHERE id = $id OR (parent_id = $id AND deleted_at = $t)')
        .run({ id: e.id, t: e.deleted_at });
      // A mail whose thread is now in the trash goes back to a thread of its own.
      if (e.kind === 'mail' && db.prepare('SELECT 1 FROM mail_threads WHERE id = ? AND deleted_at IS NOT NULL').get(e.thread_id)) {
        db.prepare('UPDATE entries SET thread_id = NULL WHERE id = ?').run(e.id);
        ensureEntryThread({ ...e, thread_id: null });
      }
    },
  },
  // A mail thread (personal) with the mails written in Organizer deleted together with it.
  thread: {
    find: (id, uid) => db.prepare('SELECT *, owner_id AS created_by FROM mail_threads WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL').get(id, uid),
    restore: t => {
      db.prepare('UPDATE mail_threads SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(t.id);
      db.prepare('UPDATE entries SET deleted_at = NULL, deleted_by = NULL WHERE thread_id = ? AND deleted_at = ?').run(t.id, t.deleted_at);
      ensureTopic(t.id); // its topic, if it has disappeared meanwhile, is a new one
    },
  },
  project: {
    find: (id, uid) => db.prepare(`SELECT p.* FROM projects p WHERE p.id = $id AND p.deleted_at IS NOT NULL AND ${PVIS_ANY}`).get({ id, uid }),
    restore: p => db.prepare('UPDATE projects SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(p.id),
  },
  item: {
    find: id => db.prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NOT NULL').get(id),
    restore: it => db.prepare('UPDATE items SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(it.id),
  },
  doc: {
    find: id => db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NOT NULL').get(id),
    restore: d => {
      db.prepare('UPDATE documents SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(d.id);
      db.prepare('UPDATE items SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(d.item_id);
    },
  },
  docnote: {
    find: (id, uid) => db.prepare(`SELECT n.* FROM doc_notes n WHERE n.id = $id AND n.deleted_at IS NOT NULL AND ${NVIS_ANY}`).get({ id, uid }),
    restore: n => db.prepare('UPDATE doc_notes SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(n.id),
  },
  contact: {
    find: (id, uid) => db.prepare(`SELECT c.* FROM contacts c WHERE c.id = $id AND c.deleted_at IS NOT NULL AND ${CVIS_ANY}`).get({ id, uid }),
    restore: c => db.prepare('UPDATE contacts SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(c.id),
  },
};

const TABLE = { entry: 'entries', project: 'projects', item: 'items', doc: 'documents', contact: 'contacts', docnote: 'doc_notes', thread: 'mail_threads' };

function getTrashed(type, id, user) {
  const t = TYPES[type] || fail(404, 'Unknown kind');
  return t.find(+id, user.id) || fail(404, 'Item not found in the trash');
}

// Permissions: each kind in the trash belongs to an area (entries by kind: todo/note or mail).
const AREA_OF = { project: 'progetti', item: 'magazzino', doc: 'documenti', docnote: 'documenti', contact: 'contatti', thread: 'mail' };
const areaOf = (type, el) => (type === 'entry' ? entryArea(el.kind) : AREA_OF[type]);

route('GET', '/api/trash', ({ user }) => {
  const uid = user.id;
  const can = area => allows(user.perms, area);
  const kinds = JSON.stringify(readableKinds(user));
  const all = (area, sql, args = {}) => (can(area) ? db.prepare(sql).all(args) : []);
  return {
    days: TRASH_DAYS,
    // Subtasks deleted together with their parent come back with it, mails with their thread: only the others
    // are listed.
    entries: db.prepare(`SELECT e.* FROM entries e WHERE e.deleted_at IS NOT NULL AND ${VIS_ANY}
      AND e.kind IN (SELECT value FROM json_each($kinds)) AND ${TRASH_ALONE}
      ORDER BY e.deleted_at DESC`).all({ uid, kinds }),
    threads: all('mail', `SELECT t.id, t.subject, t.owner_id AS created_by, t.deleted_at, t.deleted_by,
      (SELECT COUNT(*) FROM mail_messages m WHERE m.thread_id = t.id) AS messages
      FROM mail_threads t WHERE t.owner_id = $uid AND t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC`, { uid }),
    projects: all('progetti', `SELECT p.* FROM projects p WHERE p.deleted_at IS NOT NULL AND ${PVIS_ANY} ORDER BY p.deleted_at DESC`, { uid }),
    items: all('magazzino', 'SELECT * FROM items WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'),
    docs: all('documenti', `SELECT d.id, d.item_id, d.kind, d.label, d.version, d.filename, d.url, d.size, d.created_by, d.deleted_at, d.deleted_by,
      i.code AS item_code FROM documents d JOIN items i ON i.id = d.item_id
      WHERE d.deleted_at IS NOT NULL AND i.deleted_at IS NULL ORDER BY d.deleted_at DESC`),
    contacts: all('contatti', `SELECT c.* FROM contacts c WHERE c.deleted_at IS NOT NULL AND ${CVIS_ANY} ORDER BY c.deleted_at DESC`, { uid }),
    docNotes: all('documenti', `SELECT n.*, d.filename, d.label, d.url FROM doc_notes n JOIN documents d ON d.id = n.doc_id
      WHERE n.deleted_at IS NOT NULL AND d.deleted_at IS NULL AND ${NVIS_ANY} ORDER BY n.deleted_at DESC`, { uid }),
  };
});

route('POST', '/api/trash/:type/:id/restore', ({ params, user }) => {
  const el = getTrashed(params.type, params.id, user);
  assertCan(user, areaOf(params.type, el), 'write');
  tx(() => TYPES[params.type].restore(el));
});

route('DELETE', '/api/trash/:type/:id', ({ params, user }) => {
  const el = getTrashed(params.type, params.id, user);
  assertCan(user, areaOf(params.type, el), 'write');
  if (!user.is_admin && el.created_by !== user.id && el.deleted_by !== user.id) {
    fail(403, 'Only whoever created or deleted it (or an admin) can delete it for good');
  }
  purge(`id = ${el.id}`, TABLE[params.type]);
});

route('DELETE', '/api/trash', () => {
  purge('deleted_at IS NOT NULL');
}, { auth: 'admin' });

// Really deletes the rows matching `cond` (in one table or in all) and the linked files.
function purge(cond, only) {
  const want = t => !only || only === t;
  const files = [];
  const collect = sql => files.push(...db.prepare(sql).all().map(r => r.stored));
  tx(() => {
    // A thread goes with its mails deleted together with it (messages and links fall with the thread).
    if (want('mail_threads')) {
      const threads = `SELECT id FROM mail_threads WHERE ${cond}`;
      const ents = `SELECT e.id FROM entries e JOIN mail_threads t ON t.id = e.thread_id WHERE t.id IN (${threads}) AND e.deleted_at = t.deleted_at`;
      collect(`SELECT stored FROM mail_attachments WHERE stored IS NOT NULL AND entry_id IN (${ents})`);
      db.prepare(`DELETE FROM entries WHERE id IN (${ents})`).run();
      db.prepare(`DELETE FROM mail_threads WHERE ${cond}`).run();
    }
    if (want('entries')) {
      collect(`SELECT stored FROM mail_attachments WHERE stored IS NOT NULL
        AND entry_id IN (SELECT id FROM entries WHERE ${cond} OR parent_id IN (SELECT id FROM entries WHERE ${cond}))`);
      db.prepare(`DELETE FROM entries WHERE ${cond}`).run();
    }
    if (want('documents') || want('items')) {
      const docCond = want('documents') ? `(${cond})` : '0';
      const itemCond = want('items') ? `item_id IN (SELECT id FROM items WHERE ${cond})` : '0';
      collect(`SELECT stored FROM documents WHERE stored IS NOT NULL AND (${docCond} OR ${itemCond})`);
      if (want('documents')) db.prepare(`DELETE FROM documents WHERE ${cond}`).run();
      if (want('items')) db.prepare(`DELETE FROM items WHERE ${cond}`).run();
    }
    if (want('projects')) db.prepare(`DELETE FROM projects WHERE ${cond}`).run();
    if (want('contacts')) db.prepare(`DELETE FROM contacts WHERE ${cond}`).run();
    if (want('doc_notes')) db.prepare(`DELETE FROM doc_notes WHERE ${cond}`).run();
  });
  // Attachments pointing to a document (doc_id) have no files of their own and go with it (ON DELETE CASCADE).
  for (const f of files) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });
  return files.length;
}

export function purgeExpired() {
  const limit = new Date(Date.now() - TRASH_DAYS * 864e5).toISOString().replace(/'/g, '');
  return purge(`deleted_at IS NOT NULL AND deleted_at <= '${limit}'`);
}
