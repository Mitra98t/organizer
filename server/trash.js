// Cestino: tutto ciò che si elimina resta recuperabile per TRASH_DAYS giorni, poi viene cancellato davvero.
import fs from 'node:fs';
import path from 'node:path';
import { db, tx, UPLOAD_DIR } from './db.js';
import { route, VIS_ANY, PVIS_ANY } from './api.js';
import { fail } from './util.js';

export const TRASH_DAYS = +process.env.TRASH_DAYS || 30;

// Per ogni tipo: come trovare un elemento nel cestino visibile all'utente e come ripristinarlo.
const TYPES = {
  entry: {
    find: (id, uid) => db.prepare(`SELECT e.* FROM entries e WHERE e.id = $id AND e.deleted_at IS NOT NULL AND ${VIS_ANY}`).get({ id, uid }),
    restore: e => db.prepare('UPDATE entries SET deleted_at = NULL, deleted_by = NULL WHERE id = $id OR (parent_id = $id AND deleted_at = $t)')
      .run({ id: e.id, t: e.deleted_at }),
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
    find: id => db.prepare('SELECT * FROM doc_notes WHERE id = ? AND deleted_at IS NOT NULL').get(id),
    restore: n => db.prepare('UPDATE doc_notes SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(n.id),
  },
  contact: {
    find: id => db.prepare('SELECT * FROM contacts WHERE id = ? AND deleted_at IS NOT NULL').get(id),
    restore: c => db.prepare('UPDATE contacts SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(c.id),
  },
};

const TABLE = { entry: 'entries', project: 'projects', item: 'items', doc: 'documents', contact: 'contacts', docnote: 'doc_notes' };

function getTrashed(type, id, user) {
  const t = TYPES[type] || fail(404, 'Tipo sconosciuto');
  return t.find(+id, user.id) || fail(404, 'Elemento non trovato nel cestino');
}

route('GET', '/api/trash', ({ user }) => {
  const uid = user.id;
  return {
    days: TRASH_DAYS,
    // Le sotto-attività eliminate insieme alla voce madre tornano con lei: si elencano solo le altre.
    entries: db.prepare(`SELECT e.* FROM entries e WHERE e.deleted_at IS NOT NULL AND ${VIS_ANY}
      AND (e.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM entries x WHERE x.id = e.parent_id AND x.deleted_at = e.deleted_at))
      ORDER BY e.deleted_at DESC`).all({ uid }),
    projects: db.prepare(`SELECT p.* FROM projects p WHERE p.deleted_at IS NOT NULL AND ${PVIS_ANY} ORDER BY p.deleted_at DESC`).all({ uid }),
    items: db.prepare('SELECT * FROM items WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all(),
    docs: db.prepare(`SELECT d.id, d.item_id, d.kind, d.label, d.version, d.filename, d.url, d.size, d.created_by, d.deleted_at, d.deleted_by,
      i.code AS item_code FROM documents d JOIN items i ON i.id = d.item_id
      WHERE d.deleted_at IS NOT NULL AND i.deleted_at IS NULL ORDER BY d.deleted_at DESC`).all(),
    contacts: db.prepare('SELECT * FROM contacts WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all(),
    docNotes: db.prepare(`SELECT n.*, d.filename, d.label, d.url FROM doc_notes n JOIN documents d ON d.id = n.doc_id
      WHERE n.deleted_at IS NOT NULL AND d.deleted_at IS NULL ORDER BY n.deleted_at DESC`).all(),
  };
});

route('POST', '/api/trash/:type/:id/restore', ({ params, user }) => {
  const el = getTrashed(params.type, params.id, user);
  tx(() => TYPES[params.type].restore(el));
});

route('DELETE', '/api/trash/:type/:id', ({ params, user }) => {
  const el = getTrashed(params.type, params.id, user);
  if (!user.is_admin && el.created_by !== user.id && el.deleted_by !== user.id) {
    fail(403, 'Può eliminare definitivamente solo chi l\'ha creato o eliminato (o un admin)');
  }
  purge(`id = ${el.id}`, TABLE[params.type]);
});

route('DELETE', '/api/trash', () => {
  purge('deleted_at IS NOT NULL');
}, { auth: 'admin' });

// Cancella davvero le righe che soddisfano `cond` (in una tabella o in tutte) e i file collegati.
function purge(cond, only) {
  const want = t => !only || only === t;
  const files = [];
  const collect = sql => files.push(...db.prepare(sql).all().map(r => r.stored));
  tx(() => {
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
  // Gli allegati che puntano a un documento (doc_id) non hanno file propri e spariscono con lui (ON DELETE CASCADE).
  for (const f of files) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });
  return files.length;
}

export function purgeExpired() {
  const limit = new Date(Date.now() - TRASH_DAYS * 864e5).toISOString().replace(/'/g, '');
  return purge(`deleted_at IS NOT NULL AND deleted_at <= '${limit}'`);
}
