// Exports and imports a person's data, to take it to another workspace or another server (Settings → Your data).
// Anyone can do it, not only admins.
//  - Export (GET /api/export): a .zip with organizer-export.json (the table rows, readable) and in files/ the real
//    files of documents and attachments. Inside: all the workspace's inventory and documents (they belong to
//    everyone) and what the person created: entries (todos, journal, written mails), projects, contacts, notes on
//    documents, their mail. Nothing private of others, no chat. Only the areas they can read.
//  - Import (POST /api/import): added to the current workspace, overwriting nothing, only in the areas one can
//    write. An item with the same code (or alternative code) stays as it is and only takes the documents it is
//    missing; a project with the same tag and a contact with the same email are merged with the existing ones.
//    Everything that arrives belongs to whoever imports it. Ids change: [[…]] links in the texts are updated;
//    those to things not exported become their name in plain text.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, tx, UPLOAD_DIR } from './db.js';
import { acc, workspaceById } from './accounts.js';
import { route, saveUpload } from './api.js';
import { allows, readableKinds } from './perms.js';
import { zip, unzip } from './zip.js';
import { ensureTopic } from './maildata.js';
import { fail, now } from './util.js';

const FORMAT = 'organizer-export';
const REF_RE = /\[\[(doc|voce|contatto|progetto|mail|nota):(\d+)\]\]/g;
const REF_NAME = {
  doc: "SELECT COALESCE(NULLIF(label, ''), filename, url) AS n FROM documents WHERE id = ?",
  voce: 'SELECT title AS n FROM entries WHERE id = ?',
  contatto: "SELECT COALESCE(NULLIF(name, ''), email) AS n FROM contacts WHERE id = ?",
  progetto: 'SELECT name AS n FROM projects WHERE id = ?',
  mail: 'SELECT subject AS n FROM mail_threads WHERE id = ?',
  nota: 'SELECT substr(text, 1, 120) AS n FROM doc_notes WHERE id = ?',
};
const json = (sql, p = {}) => db.prepare(sql).all(p);

// ---------- esportazione ----------
route('GET', '/api/export', ({ res, user }) => {
  const uid = user.id;
  const can = area => allows(user.perms, area);
  const T = {};
  if (can('magazzino')) {
    T.items = json('SELECT * FROM items WHERE deleted_at IS NULL');
    T.item_aliases = json('SELECT a.* FROM item_aliases a JOIN items i ON i.id = a.item_id WHERE i.deleted_at IS NULL');
    T.item_links = json(`SELECT l.* FROM item_links l JOIN items p ON p.id = l.parent_id JOIN items c ON c.id = l.child_id
      WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL`);
    T.category_colors = json('SELECT * FROM category_colors');
  }
  if (can('documenti')) {
    T.documents = json('SELECT d.* FROM documents d JOIN items i ON i.id = d.item_id WHERE d.deleted_at IS NULL AND i.deleted_at IS NULL');
    T.doc_kinds = json('SELECT * FROM doc_kinds');
    T.doc_pages = json('SELECT p.* FROM doc_pages p JOIN documents d ON d.id = p.doc_id JOIN items i ON i.id = d.item_id WHERE d.deleted_at IS NULL AND i.deleted_at IS NULL');
    T.doc_notes = json(`SELECT n.* FROM doc_notes n JOIN documents d ON d.id = n.doc_id
      WHERE n.created_by = $uid AND n.deleted_at IS NULL AND d.deleted_at IS NULL`, { uid });
  }
  if (can('progetti')) {
    T.projects = json('SELECT * FROM projects WHERE created_by = $uid AND deleted_at IS NULL', { uid });
    T.project_items = json('SELECT pi.* FROM project_items pi JOIN projects p ON p.id = pi.project_id WHERE p.created_by = $uid AND p.deleted_at IS NULL', { uid });
  }
  if (can('contatti')) T.contacts = json('SELECT * FROM contacts WHERE created_by = $uid AND deleted_at IS NULL', { uid });
  const kinds = JSON.stringify(readableKinds(user));
  T.entries = json(`SELECT * FROM entries WHERE created_by = $uid AND deleted_at IS NULL AND kind IN (SELECT value FROM json_each($kinds))`, { uid, kinds });
  const mine = 'SELECT id FROM entries WHERE created_by = $uid AND deleted_at IS NULL AND kind IN (SELECT value FROM json_each($kinds))';
  T.entry_log = json(`SELECT * FROM entry_log WHERE entry_id IN (${mine})`, { uid, kinds });
  T.entry_projects = json(`SELECT * FROM entry_projects WHERE entry_id IN (${mine})`, { uid, kinds });
  T.entry_deps = json(`SELECT entry_id, after_id FROM entry_deps WHERE entry_id IN (${mine}) AND after_id IN (${mine})`, { uid, kinds });
  T.entry_items = json(`SELECT * FROM entry_items WHERE entry_id IN (${mine})`, { uid, kinds });
  T.entry_links = json(`SELECT * FROM entry_links WHERE entry_id IN (${mine})`, { uid, kinds });
  if (can('mail')) {
    T.mail_attachments = json(`SELECT * FROM mail_attachments WHERE entry_id IN (${mine})`, { uid, kinds });
    T.mail_topics = json('SELECT * FROM mail_topics WHERE owner_id = $uid', { uid });
    T.mail_topic_links = json('SELECT l.* FROM mail_topic_links l JOIN mail_topics t ON t.id = l.topic_id WHERE t.owner_id = $uid', { uid });
    T.mail_threads = json('SELECT * FROM mail_threads WHERE owner_id = $uid AND deleted_at IS NULL', { uid });
    const threads = 'SELECT id FROM mail_threads WHERE owner_id = $uid AND deleted_at IS NULL';
    T.mail_messages = json(`SELECT * FROM mail_messages WHERE thread_id IN (${threads})`, { uid });
    T.mail_thread_links = json(`SELECT * FROM mail_thread_links WHERE thread_id IN (${threads})`, { uid });
  }
  // The names of things mentioned in the texts ([[voce:12]]…): if they do not arrive with the export, on import
  // they become plain text (the ids from there would belong to other things).
  const names = {};
  const texts = [...(T.entries || []).flatMap(e => [e.title, e.notes, e.mail_subject]), ...(T.entry_log || []).map(l => l.text),
    ...(T.doc_notes || []).map(n => n.text), ...(T.projects || []).map(p => p.notes), ...(T.contacts || []).map(c => c.notes), ...(T.items || []).map(i => i.notes)];
  for (const t of texts) {
    for (const [m, kind, id] of String(t || '').matchAll(REF_RE)) names[m] ||= db.prepare(REF_NAME[kind]).get(+id)?.n || null;
  }
  // The files: documents and attachments that really are on the server.
  const stored = new Set([...(T.documents || []), ...(T.mail_attachments || [])].map(x => x.stored).filter(Boolean));
  const files = [...stored].filter(f => fs.existsSync(path.join(UPLOAD_DIR, f)))
    .map(f => ({ name: `files/${f}`, data: fs.readFileSync(path.join(UPLOAD_DIR, f)) }));
  const ws = workspaceById(user.workspace_id);
  const me = acc.prepare('SELECT id, username, name FROM users WHERE id = ?').get(uid);
  const meta = { format: FORMAT, version: 1, exported_at: now(), by: me, workspace: ws?.name || '', names, tables: T };
  const body = zip([{ name: 'organizer-export.json', data: Buffer.from(JSON.stringify(meta, null, 1)) }, ...files]);
  const stamp = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename="organizer-${me.username}-${stamp}.zip"`,
  });
  res.end(body);
}, { quiet: true });

// ---------- importazione ----------
const colsOf = new Map();
function cols(table) {
  if (!colsOf.has(table)) colsOf.set(table, db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(c => c.name));
  return colsOf.get(table);
}

// A new row with the columns the table really has (the export may come from another version).
function insert(table, row) {
  const keys = Object.keys(row).filter(k => k !== 'id' && cols(table).includes(k) && row[k] !== undefined);
  const r = db.prepare(`INSERT OR IGNORE INTO "${table}" (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map(k => row[k]));
  return r.changes ? Number(r.lastInsertRowid) : null;
}

function importAll(meta, files, user) {
  const T = meta.tables || {};
  const uid = user.id;
  const from = meta.by?.id;
  const can = area => allows(user.perms, area, 'write');
  const at = now();
  const M = { items: new Map(), documents: new Map(), projects: new Map(), contacts: new Map(), entries: new Map(), mail_topics: new Map(), mail_threads: new Map(), mail_messages: new Map(), doc_notes: new Map() };
  const n = { articoli: 0, articoliUniti: 0, documenti: 0, voci: 0, progetti: 0, progettiUniti: 0, contatti: 0, contattiUniti: 0, note: 0, conversazioni: 0, saltati: [] };
  const skip = area => { if (!n.saltati.includes(area)) n.saltati.push(area); };
  const has = name => (T[name] || []).length > 0;
  const mine = row => ({ ...row, created_by: uid, deleted_at: null, deleted_by: null });
  // [[kind:id]] links: to the new id, or to the plain name if the thing did not arrive.
  const refMap = { doc: 'documents', voce: 'entries', contatto: 'contacts', progetto: 'projects', mail: 'mail_threads', nota: 'doc_notes' };
  const fixRefs = s => (s == null ? s : String(s).replace(REF_RE, (m, kind, id) => {
    const to = M[refMap[kind]].get(+id);
    return to ? `[[${kind}:${to}]]` : (meta.names?.[m] || m.slice(2, -2)).replace(/(^|\s)#/g, '$1');
  }));
  const copyFile = old => {
    const data = old && files.get(`files/${old}`)?.();
    if (!data) return null;
    const name = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(UPLOAD_DIR, name), data);
    return name;
  };

  // Inventory: by code (also alternative, also in the trash: then it comes back).
  if (has('items') && !can('magazzino')) skip('magazzino');
  if (can('magazzino')) {
    for (const it of T.items || []) {
      const hit = db.prepare(`SELECT id, deleted_at FROM items WHERE code = ? UNION ALL
        SELECT i.id, i.deleted_at FROM item_aliases a JOIN items i ON i.id = a.item_id WHERE a.code = ?`).get(it.code, it.code);
      if (hit) {
        if (hit.deleted_at) db.prepare('UPDATE items SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(hit.id);
        M.items.set(it.id, hit.id);
        n.articoliUniti++;
      } else {
        M.items.set(it.id, insert('items', { ...mine(it), created_at: it.created_at || at, updated_at: at }));
        n.articoli++;
      }
    }
    for (const a of T.item_aliases || []) if (M.items.get(a.item_id)) insert('item_aliases', { ...a, item_id: M.items.get(a.item_id) });
    for (const l of T.item_links || []) {
      if (M.items.get(l.parent_id) && M.items.get(l.child_id)) insert('item_links', { ...l, parent_id: M.items.get(l.parent_id), child_id: M.items.get(l.child_id) });
    }
    for (const c of T.category_colors || []) insert('category_colors', c);
  } else {
    // Without being able to write the inventory, the items already there are still needed (documents, entries).
    for (const it of T.items || []) {
      const hit = db.prepare('SELECT id FROM items WHERE code = ? AND deleted_at IS NULL').get(it.code);
      if (hit) M.items.set(it.id, hit.id);
    }
  }

  // Documents: those the item does not have yet (same content or same link), with their file.
  if (has('documents') && !can('documenti')) skip('documenti');
  if (can('documenti')) {
    for (const k of T.doc_kinds || []) insert('doc_kinds', { ...k, created_by: uid });
    for (const d of T.documents || []) {
      const item = M.items.get(d.item_id);
      if (!item) continue;
      const same = d.url
        ? db.prepare('SELECT id FROM documents WHERE item_id = ? AND url = ? AND deleted_at IS NULL').get(item, d.url)
        : d.sha256 && db.prepare('SELECT id FROM documents WHERE item_id = ? AND sha256 = ? AND deleted_at IS NULL').get(item, d.sha256);
      if (same) { M.documents.set(d.id, same.id); continue; }
      const stored = d.url ? null : copyFile(d.stored);
      if (!d.url && !stored) continue; // the file is not in the archive
      M.documents.set(d.id, insert('documents', { ...mine(d), item_id: item, stored }));
      n.documenti++;
    }
    // Saved copies of link pages, for the documents that do not have one yet.
    for (const p of T.doc_pages || []) {
      const doc = M.documents.get(p.doc_id);
      if (doc && !db.prepare('SELECT 1 FROM doc_pages WHERE doc_id = ?').get(doc)) insert('doc_pages', { ...p, doc_id: doc });
    }
  }

  // Projects (by tag) and contacts (by address).
  if (has('projects') && !can('progetti')) skip('progetti');
  if (can('progetti')) {
    for (const p of T.projects || []) {
      const hit = db.prepare('SELECT id FROM projects WHERE tag = ? AND deleted_at IS NULL').get(p.tag);
      if (hit) { M.projects.set(p.id, hit.id); n.progettiUniti++; continue; }
      M.projects.set(p.id, insert('projects', { ...mine(p), parent_id: null }));
      n.progetti++;
    }
    for (const p of T.projects || []) {
      if (p.parent_id && M.projects.get(p.parent_id)) db.prepare('UPDATE projects SET parent_id = ? WHERE id = ? AND parent_id IS NULL').run(M.projects.get(p.parent_id), M.projects.get(p.id));
    }
    for (const x of T.project_items || []) {
      if (M.projects.get(x.project_id) && M.items.get(x.item_id)) insert('project_items', { ...x, project_id: M.projects.get(x.project_id), item_id: M.items.get(x.item_id) });
    }
  } else {
    for (const p of T.projects || []) { const hit = db.prepare('SELECT id FROM projects WHERE tag = ? AND deleted_at IS NULL').get(p.tag); if (hit) M.projects.set(p.id, hit.id); }
  }
  if (has('contacts') && !can('contatti')) skip('contatti');
  if (can('contatti')) {
    for (const c of T.contacts || []) {
      const hit = c.email && db.prepare("SELECT id FROM contacts WHERE email != '' AND lower(email) = lower(?) AND deleted_at IS NULL").get(c.email);
      if (hit) { M.contacts.set(c.id, hit.id); n.contattiUniti++; continue; }
      M.contacts.set(c.id, insert('contacts', mine(c)));
      n.contatti++;
    }
  }

  // Mail: topics and conversations first, because the mails written here belong to them.
  const mailOk = can('mail');
  if (has('mail_threads') && !mailOk) skip('mail');
  if (mailOk) {
    for (const t of T.mail_topics || []) M.mail_topics.set(t.id, insert('mail_topics', { ...t, owner_id: uid }));
    for (const t of T.mail_threads || []) {
      const id = insert('mail_threads', { ...t, owner_id: uid, topic_id: M.mail_topics.get(t.topic_id) ?? null, deleted_at: null, deleted_by: null });
      M.mail_threads.set(t.id, id);
      if (id) ensureTopic(id); // without its topic (e.g. an export from before topics): a new one
      n.conversazioni++;
    }
  }

  // Notes on documents before entries, which may mention them ([[nota:…]]); their texts are fixed at the end.
  if (can('documenti')) {
    for (const x of T.doc_notes || []) {
      const doc = M.documents.get(x.doc_id);
      if (!doc) continue;
      M.doc_notes.set(x.id, insert('doc_notes', { ...mine(x), doc_id: doc }));
      n.note++;
    }
  }

  // Entries: mine, with their updates, projects, items and links.
  const kindOk = kind => can(kind === 'mail' ? 'mail' : 'voci');
  for (const e of T.entries || []) {
    if (!kindOk(e.kind)) { skip(e.kind === 'mail' ? 'mail' : 'voci'); continue; }
    M.entries.set(e.id, insert('entries', {
      ...mine(e), parent_id: null, reply_to: null,
      project_id: M.projects.get(e.project_id) ?? null,
      assignee_id: e.assignee_id && e.assignee_id === from ? uid : null,
      thread_id: M.mail_threads.get(e.thread_id) ?? null,
    }));
    n.voci++;
  }
  if (mailOk) {
    for (const m of T.mail_messages || []) {
      const th = M.mail_threads.get(m.thread_id);
      if (th) M.mail_messages.set(m.id, insert('mail_messages', { ...m, thread_id: th, entry_id: M.entries.get(m.entry_id) ?? null }));
    }
  }
  for (const e of T.entries || []) {
    const id = M.entries.get(e.id);
    if (!id) continue;
    db.prepare('UPDATE entries SET parent_id = ?, reply_to = ?, title = ?, notes = ?, mail_subject = ? WHERE id = ?')
      .run(M.entries.get(e.parent_id) ?? null, M.mail_messages.get(e.reply_to) ?? null, fixRefs(e.title), fixRefs(e.notes), fixRefs(e.mail_subject ?? null), id);
  }
  for (const l of T.entry_log || []) if (M.entries.get(l.entry_id)) insert('entry_log', { ...l, entry_id: M.entries.get(l.entry_id), user_id: uid, text: fixRefs(l.text) });
  for (const x of T.entry_deps || []) {
    if (M.entries.get(x.entry_id) && M.entries.get(x.after_id)) insert('entry_deps', { entry_id: M.entries.get(x.entry_id), after_id: M.entries.get(x.after_id), created_by: uid, created_at: now() });
  }
  for (const x of T.entry_projects || []) {
    if (M.entries.get(x.entry_id) && M.projects.get(x.project_id)) insert('entry_projects', { entry_id: M.entries.get(x.entry_id), project_id: M.projects.get(x.project_id) });
  }
  for (const x of T.entry_items || []) {
    if (M.entries.get(x.entry_id) && M.items.get(x.item_id)) insert('entry_items', { entry_id: M.entries.get(x.entry_id), item_id: M.items.get(x.item_id) });
  }
  const target = { doc: 'documents', voce: 'entries', contatto: 'contacts', progetto: 'projects', mail: 'mail_threads', nota: 'doc_notes', articolo: 'items' };
  for (const x of T.entry_links || []) {
    const to = M[target[x.kind]]?.get(x.target_id);
    if (M.entries.get(x.entry_id) && to) insert('entry_links', { entry_id: M.entries.get(x.entry_id), kind: x.kind, target_id: to });
  }
  for (const a of T.mail_attachments || []) {
    const entry = M.entries.get(a.entry_id);
    if (!entry) continue;
    const doc = a.doc_id ? M.documents.get(a.doc_id) : null;
    const stored = a.stored ? copyFile(a.stored) : null;
    if (!doc && !stored) continue;
    insert('mail_attachments', { ...a, entry_id: entry, doc_id: doc, stored, created_by: uid });
  }
  if (mailOk) {
    for (const l of T.mail_thread_links || []) {
      const to = M[target[l.kind]]?.get(l.target_id);
      if (M.mail_threads.get(l.thread_id) && to) insert('mail_thread_links', { ...l, thread_id: M.mail_threads.get(l.thread_id), target_id: to });
    }
    for (const l of T.mail_topic_links || []) {
      const to = M[target[l.kind]]?.get(l.target_id);
      if (M.mail_topics.get(l.topic_id) && to) insert('mail_topic_links', { ...l, topic_id: M.mail_topics.get(l.topic_id), target_id: to });
    }
  }

  // Texts of new notes, projects, contacts and items: links updated.
  for (const [table, map] of [['doc_notes', M.doc_notes], ['projects', M.projects], ['contacts', M.contacts], ['items', M.items]]) {
    const field = table === 'doc_notes' ? 'text' : 'notes';
    for (const row of T[table] || []) {
      const id = map.get(row.id);
      if (id && row[field] && /\[\[\w+:\d+\]\]/.test(row[field])) db.prepare(`UPDATE ${table} SET ${field} = ? WHERE id = ? AND ${field} = ?`).run(fixRefs(row[field]), id, row[field]);
    }
  }
  return n;
}

route('POST', '/api/import', async ({ req, user }) => {
  const { stored } = await saveUpload(req);
  const file = path.join(UPLOAD_DIR, stored);
  try {
    let files;
    try {
      files = unzip(fs.readFileSync(file));
    } catch {
      fail(400, 'The file is not an Organizer export (it needs the .zip downloaded from "Export my data")');
    }
    const raw = files.get('organizer-export.json');
    const meta = raw && JSON.parse(raw().toString('utf8'));
    if (meta?.format !== FORMAT) fail(400, 'The file is not an Organizer export');
    if (meta.version > 1) fail(400, 'The export comes from a newer version of the app: update the app first');
    return tx(() => importAll(meta, files, user));
  } finally {
    fs.rmSync(file, { force: true });
  }
});
