import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, tx, DATA_DIR, UPLOAD_DIR } from './db.js';
import { parseQuick, extractCodes, isYmd, today } from '../public/js/parse.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, sessionCookie,
  validUsername, validPassword, randomCode,
} from './auth.js';
import { HttpError, fail, now, bool, str, sendJson } from './util.js';
import { rev, openStream, dropUser } from './events.js';

const KINDS = ['todo', 'mail', 'note'];
const STATUSES = ['open', 'paused', 'closed'];
const DOC_KINDS = ['firmware', 'datasheet', 'schema', 'manuale', 'foto', 'altro'];
const ARCHIVE_DAYS = 30;
const MAX_UPLOAD = (+process.env.MAX_UPLOAD_MB || 200) * 1048576;
const CODE_OK = /^[A-Za-z0-9](?:[\w.\-/]*[A-Za-z0-9_])?$/;

export const routes = [];
export function route(method, pattern, handler, { auth = 'user' } = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth });
}

// ---------- visibilità ----------
// Tutto è condiviso tra gli utenti dell'istanza, tranne voci e progetti marcati privati.
// Le versioni *_ANY includono anche ciò che sta nel cestino (deleted_at valorizzato).
export const VIS_ANY = `(e.private = 0 OR e.created_by = $uid OR e.assignee_id = $uid)
  AND (e.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = e.project_id AND (p.private = 0 OR p.created_by = $uid)))`;
export const PVIS_ANY = '(p.private = 0 OR p.created_by = $uid)';
export const VIS = `e.deleted_at IS NULL AND ${VIS_ANY}`;
const PVIS = `p.deleted_at IS NULL AND ${PVIS_ANY}`;

export const getEntry = (id, uid) =>
  db.prepare(`SELECT e.* FROM entries e WHERE e.id = $id AND ${VIS}`).get({ id: +id, uid }) || fail(404, 'Voce non trovata');
const getProject = (id, uid) =>
  db.prepare(`SELECT p.* FROM projects p WHERE p.id = $id AND ${PVIS}`).get({ id: +id, uid }) || fail(404, 'Progetto non trovato');
const getItem = id => db.prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL').get(+id) || fail(404, 'Articolo non trovato');
const getUser = id => db.prepare('SELECT id, username, name, is_admin FROM users WHERE id = ?').get(+id) || fail(404, 'Utente non trovato');
const findUser = name => db.prepare('SELECT id FROM users WHERE username = $n COLLATE NOCASE OR name = $n COLLATE NOCASE').get({ n: name });
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

const fmtDate = d => (d ? `${d.slice(8)}/${d.slice(5, 7)}` : 'nessuna');
export const insertId = r => Number(r.lastInsertRowid);

function cleanTag(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\d_-]+/gu, '-').replace(/^[-]+|[-]+$/g, '').slice(0, 32);
}

function uniqueTag(name) {
  const base = cleanTag(name) || 'progetto';
  for (let i = 1; ; i++) {
    const tag = i === 1 ? base : `${base}-${i}`;
    if (!db.prepare('SELECT 1 FROM projects WHERE tag = ?').get(tag)) return tag;
  }
}

function resolveProject(tag, user) {
  const p = db.prepare(`SELECT p.id, p.deleted_at FROM projects p WHERE p.tag = $tag AND ${PVIS_ANY}`).get({ tag, uid: user.id });
  // Scrivere @tag di un progetto nel cestino lo ripristina: è chiaramente quello che si intende.
  if (p?.deleted_at) db.prepare('UPDATE projects SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(p.id);
  if (p) return p.id;
  if (db.prepare('SELECT 1 FROM projects WHERE tag = ?').get(tag)) fail(403, `@${tag} è un progetto privato di un altro utente`);
  const t = now();
  return insertId(db.prepare('INSERT INTO projects (name, tag, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(tag, tag, user.id, t, t));
}

function ensureItem(code, user) {
  const it = db.prepare('SELECT id, deleted_at FROM items WHERE code = ?').get(code);
  if (it?.deleted_at) db.prepare('UPDATE items SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(it.id);
  if (it) return it.id;
  const t = now();
  return insertId(db.prepare('INSERT INTO items (code, created_by, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(code, user.id, t, t));
}

// I collegamenti voce↔magazzino derivano dal testo: ogni #CODICE in titolo, note o aggiornamenti.
export function syncEntryItems(entryId, user) {
  const e = db.prepare('SELECT title, notes FROM entries WHERE id = ?').get(entryId);
  const logs = db.prepare('SELECT text FROM entry_log WHERE entry_id = ?').all(entryId);
  const codes = extractCodes([e.title, e.notes, ...logs.map(l => l.text)].join('\n'));
  db.prepare('DELETE FROM entry_items WHERE entry_id = ?').run(entryId);
  const ins = db.prepare('INSERT OR IGNORE INTO entry_items (entry_id, item_id) VALUES (?, ?)');
  for (const c of codes) ins.run(entryId, ensureItem(c, user));
}

export function addLog(entryId, userId, text, system = false) {
  db.prepare('INSERT INTO entry_log (entry_id, user_id, text, system, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(entryId, userId, text, bool(system), now());
}

function setFields(table, id, f) {
  const cols = Object.keys(f);
  if (!cols.length) return;
  db.prepare(`UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(c => f[c]), id);
}

// ---------- autenticazione ----------
const attempts = new Map();
function throttle(key) {
  const a = attempts.get(key);
  if (a && a.n >= 10 && Date.now() - a.t < 15 * 60e3) fail(429, 'Troppi tentativi, riprova tra qualche minuto');
}
function noteFailure(key) {
  let a = attempts.get(key);
  if (!a || Date.now() - a.t > 15 * 60e3) a = { n: 0, t: Date.now() };
  a.n++;
  attempts.set(key, a);
}

function login(req, res, userId) {
  res.setHeader('Set-Cookie', sessionCookie(req, createSession(userId)));
  return { user: getUser(userId) };
}

async function newUser(b, isAdmin) {
  const username = str(b.username, 32);
  if (!validUsername(username)) fail(400, 'Username: 2-32 caratteri tra lettere, numeri, . _ -');
  if (!validPassword(b.password)) fail(400, 'La password deve avere almeno 8 caratteri');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'Username già in uso');
  return { username, name: str(b.name, 60) || username, pass: await hashPassword(b.password), is_admin: bool(isAdmin) };
}

const insertUser = u => insertId(db.prepare('INSERT INTO users (username, name, pass, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
  .run(u.username, u.name, u.pass, u.is_admin, now()));

route('GET', '/api/me', ({ user }) => ({ user, setup: userCount() === 0 }), { auth: 'none' });

route('POST', '/api/setup', async ({ req, res, body }) => {
  const u = await newUser(await body(), true);
  const id = tx(() => {
    if (userCount() > 0) fail(403, 'Configurazione già eseguita');
    return insertUser(u);
  });
  return login(req, res, id);
}, { auth: 'none' });

route('POST', '/api/login', async ({ req, res, body }) => {
  const b = await body();
  const key = `${req.socket.remoteAddress}|${String(b.username).toLowerCase()}`;
  throttle(key);
  const u = db.prepare('SELECT id, pass FROM users WHERE username = ?').get(str(b.username, 32));
  if (!u || !(await verifyPassword(String(b.password || ''), u.pass))) {
    noteFailure(key);
    fail(401, 'Credenziali errate');
  }
  attempts.delete(key);
  return login(req, res, u.id);
}, { auth: 'none' });

route('POST', '/api/register', async ({ req, res, body }) => {
  const b = await body();
  const key = `${req.socket.remoteAddress}|invite`;
  throttle(key);
  const code = str(b.code, 20).toUpperCase();
  const valid = () => db.prepare('SELECT * FROM invites WHERE code = ? AND used_at IS NULL AND expires_at > ?').get(code, now());
  if (!valid()) {
    noteFailure(key);
    fail(400, 'Invito non valido o scaduto');
  }
  const u = await newUser(b, false);
  const id = tx(() => {
    if (!valid()) fail(400, 'Invito non valido o scaduto');
    const id = insertUser(u);
    db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?').run(id, now(), code);
    return id;
  });
  return login(req, res, id);
}, { auth: 'none' });

route('POST', '/api/logout', ({ req, res, token }) => {
  destroySession(token);
  res.setHeader('Set-Cookie', sessionCookie(req, ''));
  return { ok: true };
}, { auth: 'none' });

route('PATCH', '/api/me', async ({ user, body }) => {
  const b = await body();
  if (b.name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(str(b.name, 60) || user.username, user.id);
  if (b.password !== undefined) {
    const row = db.prepare('SELECT pass FROM users WHERE id = ?').get(user.id);
    if (!(await verifyPassword(String(b.current || ''), row.pass))) fail(400, 'Password attuale errata');
    if (!validPassword(b.password)) fail(400, 'La password deve avere almeno 8 caratteri');
    db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(await hashPassword(b.password), user.id);
  }
  return { user: getUser(user.id) };
});

route('GET', '/api/events', ({ req, res, user }) => openStream(req, res, user));

// ---------- sync ----------
route('GET', '/api/sync', ({ req, res, user }) => {
  const etag = `"${rev()}-${user.id}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, no-cache' });
    return res.end();
  }
  const uid = user.id;
  const p = { uid, cutoff: new Date(Date.now() - ARCHIVE_DAYS * 864e5).toISOString() };
  const where = `${VIS} AND (e.done_at IS NULL OR e.done_at > $cutoff)`;
  sendJson(res, 200, {
    rev: rev(),
    me: getUser(uid),
    users: db.prepare('SELECT id, username, name, is_admin FROM users ORDER BY name COLLATE NOCASE').all(),
    projects: db.prepare(`SELECT p.* FROM projects p WHERE ${PVIS} ORDER BY p.name COLLATE NOCASE`).all({ uid }),
    entries: db.prepare(`SELECT e.* FROM entries e WHERE ${where} ORDER BY e.id`).all(p),
    logs: db.prepare(`SELECT l.* FROM entry_log l JOIN entries e ON e.id = l.entry_id WHERE ${where} ORDER BY l.id`).all(p),
    entryItems: db.prepare(`SELECT ei.entry_id, ei.item_id FROM entry_items ei JOIN entries e ON e.id = ei.entry_id WHERE ${where}`).all(p),
    items: db.prepare('SELECT * FROM items WHERE deleted_at IS NULL ORDER BY code COLLATE NOCASE').all(),
    itemLinks: db.prepare('SELECT parent_id, child_id FROM item_links').all(),
    docs: db.prepare(`SELECT id, item_id, kind, label, version, filename, mime, size, sha256, url, created_by, created_at
      FROM documents WHERE deleted_at IS NULL ORDER BY created_at DESC`).all(),
    contacts: db.prepare('SELECT * FROM contacts WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE, email').all(),
    attachments: db.prepare(`SELECT a.id, a.entry_id, a.doc_id, a.filename, a.mime, a.size FROM mail_attachments a
      JOIN entries e ON e.id = a.entry_id WHERE ${where} ORDER BY a.id`).all(p),
    trashCount: db.prepare(`SELECT
      (SELECT COUNT(*) FROM entries e WHERE e.deleted_at IS NOT NULL AND ${VIS_ANY}
        AND (e.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM entries x WHERE x.id = e.parent_id AND x.deleted_at = e.deleted_at)))
      + (SELECT COUNT(*) FROM projects p WHERE p.deleted_at IS NOT NULL AND ${PVIS_ANY})
      + (SELECT COUNT(*) FROM items WHERE deleted_at IS NOT NULL)
      + (SELECT COUNT(*) FROM documents d WHERE d.deleted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM items i WHERE i.id = d.item_id AND i.deleted_at IS NULL))
      + (SELECT COUNT(*) FROM contacts WHERE deleted_at IS NOT NULL) AS n`).get({ uid }).n,
  }, { ETag: etag });
});

route('GET', '/api/archive', ({ user, query }) => {
  const q = `%${str(query.q, 200)}%`;
  const cutoff = new Date(Date.now() - ARCHIVE_DAYS * 864e5).toISOString();
  return db.prepare(`SELECT e.* FROM entries e WHERE ${VIS} AND e.done_at IS NOT NULL AND e.done_at <= $cutoff
    AND (e.title LIKE $q OR e.notes LIKE $q OR e.contact LIKE $q) ORDER BY e.done_at DESC LIMIT 200`)
    .all({ uid: user.id, cutoff, q });
});

// ---------- voci (todo / mail / note) ----------
// ">marco" diventa l'email del contatto in rubrica che si chiama così (se è uno solo).
function resolveContact(s) {
  if (s.includes('@')) return s;
  const name = s.replace(/[._]/g, ' ');
  const exact = db.prepare(`SELECT email FROM contacts WHERE deleted_at IS NULL AND email != '' AND name = ? COLLATE NOCASE`).all(name);
  if (exact.length === 1) return exact[0].email;
  const prefix = db.prepare(`SELECT email FROM contacts WHERE deleted_at IS NULL AND email != '' AND name LIKE ? ESCAPE '\\'`)
    .all(`${name.replace(/[%_\\]/g, '\\$&')}%`);
  return prefix.length === 1 ? prefix[0].email : s;
}

export function createEntry(b, user) {
  const base = isYmd(b.today) ? b.today : today();
  const p = parseQuick(str(b.text, 1000), { today: base, kind: KINDS.includes(b.kind) ? b.kind : 'todo' });
  if (!p.title) fail(400, 'Scrivi almeno qualche parola');

  let parent = b.parent_id ? getEntry(b.parent_id, user.id) : null;
  if (parent?.parent_id) parent = getEntry(parent.parent_id, user.id); // un solo livello di sotto-attività
  const kind = p.kindExplicit || !parent ? p.kind : 'todo';

  let projectId = parent?.project_id ?? null;
  if (b.project_id) projectId = getProject(b.project_id, user.id).id;
  if (p.project) projectId = resolveProject(p.project, user);

  let title = p.title;
  let assigneeId = b.assignee_id ? getUser(b.assignee_id).id : null;
  const contact = p.contact ? resolveContact(p.contact) : null;
  if (p.assignee) {
    const u = findUser(p.assignee);
    if (u) assigneeId = u.id;
    else title += ` +${p.assignee}`;
  }

  const t = now();
  const id = insertId(db.prepare(`INSERT INTO entries
    (kind, title, contact, due, private, project_id, parent_id, assignee_id, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(kind, title, contact, p.due ?? null, bool(b.private), projectId, parent?.id ?? null, assigneeId, user.id, t, t));
  syncEntryItems(id, user);
  return id;
}

export function updateEntry(e, b, user) {
  const f = {};
  const base = isYmd(b.today) ? b.today : today();
  if (b.title !== undefined) {
    // Il titolo accetta gli stessi token della riga rapida: "!ven" in modifica sposta la scadenza.
    const p = parseQuick(str(b.title, 1000), { today: base, kind: e.kind });
    if (!p.title) fail(400, 'Il titolo non può essere vuoto');
    f.title = p.title;
    if (p.kindExplicit) f.kind = p.kind;
    if (p.due !== undefined) f.due = p.due;
    if (p.project) f.project_id = resolveProject(p.project, user);
    if (p.contact) f.contact = resolveContact(p.contact);
    if (p.assignee) {
      const u = findUser(p.assignee);
      if (u) f.assignee_id = u.id;
      else f.title += ` +${p.assignee}`;
    }
  }
  if (b.notes !== undefined) f.notes = str(b.notes, 20000);
  if (b.kind !== undefined) {
    if (!KINDS.includes(b.kind)) fail(400, 'Tipo non valido');
    f.kind = b.kind;
  }
  if (b.due !== undefined) {
    if (b.due !== null && !isYmd(b.due)) fail(400, 'Data non valida');
    f.due = b.due;
  }
  if (b.contact !== undefined) f.contact = str(b.contact, 1000) || null;
  if (b.mail_cc !== undefined) f.mail_cc = str(b.mail_cc, 1000) || null;
  if (b.mail_subject !== undefined) f.mail_subject = str(b.mail_subject, 300) || null;
  if (b.project_id !== undefined) f.project_id = b.project_id ? getProject(b.project_id, user.id).id : null;
  if (b.assignee_id !== undefined) f.assignee_id = b.assignee_id ? getUser(b.assignee_id).id : null;
  if (b.done !== undefined) f.done_at = b.done ? e.done_at || now() : null;
  if (b.pinned !== undefined) f.pinned = bool(b.pinned);
  if (b.private !== undefined) {
    if (e.created_by !== user.id) fail(403, 'Solo chi ha creato la voce può cambiarne la visibilità');
    f.private = bool(b.private);
  }
  if (!Object.keys(f).length) return;
  f.updated_at = now();
  setFields('entries', e.id, f);

  if (f.project_id !== undefined) db.prepare('UPDATE entries SET project_id = ? WHERE parent_id = ?').run(f.project_id, e.id);
  if (e.due && f.due !== undefined && f.due !== e.due) addLog(e.id, user.id, `scadenza ${fmtDate(e.due)} → ${fmtDate(f.due)}`, true);
  if (f.title !== undefined || f.notes !== undefined) syncEntryItems(e.id, user);
}

route('POST', '/api/entries', async ({ user, body }) => {
  const b = await body();
  return { id: tx(() => createEntry(b, user)) };
});

route('PATCH', '/api/entries/:id', async ({ params, user, body }) => {
  const b = await body();
  tx(() => updateEntry(getEntry(params.id, user.id), b, user));
});

// Eliminare = spostare nel cestino. Le sotto-attività seguono la voce con lo stesso istante,
// così il ripristino riporta indietro esattamente ciò che è stato eliminato insieme.
route('DELETE', '/api/entries/:id', ({ params, user }) => {
  const e = getEntry(params.id, user.id);
  db.prepare('UPDATE entries SET deleted_at = $t, deleted_by = $u WHERE (id = $id OR parent_id = $id) AND deleted_at IS NULL')
    .run({ t: now(), u: user.id, id: e.id });
});

// Aggiornamento: una riga che racconta cosa si è scoperto. Accetta !data e +utente per modificare la voce.
route('POST', '/api/entries/:id/log', async ({ params, user, body }) => {
  const b = await body();
  tx(() => {
    const e = getEntry(params.id, user.id);
    const p = parseQuick(str(b.text, 4000), { today: isYmd(b.today) ? b.today : today(), kind: e.kind });
    const patch = { today: b.today };
    if (p.due !== undefined) patch.due = p.due;
    if (p.assignee) {
      const u = findUser(p.assignee);
      if (u) patch.assignee_id = u.id;
      else p.title += ` +${p.assignee}`;
    }
    if (!p.title && Object.keys(patch).length === 1) fail(400, 'Scrivi qualcosa');
    updateEntry(e, patch, user);
    if (p.title) addLog(e.id, user.id, p.title);
    db.prepare('UPDATE entries SET updated_at = ? WHERE id = ?').run(now(), e.id);
    syncEntryItems(e.id, user);
  });
});

route('DELETE', '/api/logs/:id', ({ params, user }) => {
  const l = db.prepare('SELECT * FROM entry_log WHERE id = ?').get(+params.id) || fail(404, 'Aggiornamento non trovato');
  getEntry(l.entry_id, user.id);
  if (l.user_id !== user.id && !user.is_admin) fail(403, 'Puoi cancellare solo i tuoi aggiornamenti');
  tx(() => {
    db.prepare('DELETE FROM entry_log WHERE id = ?').run(l.id);
    syncEntryItems(l.entry_id, user);
  });
});

// ---------- progetti ----------
route('POST', '/api/projects', async ({ user, body }) => {
  const b = await body();
  const name = str(b.name, 100);
  if (!name) fail(400, 'Il nome è obbligatorio');
  const tag = b.tag ? cleanTag(b.tag) : uniqueTag(name);
  if (!tag) fail(400, 'Tag non valido');
  const clash = db.prepare('SELECT deleted_at FROM projects WHERE tag = ?').get(tag);
  if (clash) fail(409, clash.deleted_at ? `@${tag} è nel cestino: ripristinalo da lì` : `Esiste già un progetto @${tag}`);
  const t = now();
  const id = insertId(db.prepare('INSERT INTO projects (name, tag, private, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, tag, bool(b.private), user.id, t, t));
  return { id, tag };
});

route('PATCH', '/api/projects/:id', async ({ params, user, body }) => {
  const b = await body();
  const p = getProject(params.id, user.id);
  const f = {};
  if (b.name !== undefined) f.name = str(b.name, 100) || fail(400, 'Il nome è obbligatorio');
  if (b.tag !== undefined) {
    f.tag = cleanTag(b.tag) || fail(400, 'Tag non valido');
    if (db.prepare('SELECT 1 FROM projects WHERE tag = ? AND id != ?').get(f.tag, p.id)) fail(409, `Esiste già un progetto @${f.tag}`);
  }
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) fail(400, 'Stato non valido');
    f.status = b.status;
  }
  if (b.notes !== undefined) f.notes = str(b.notes, 20000);
  if (b.private !== undefined) {
    if (p.created_by !== user.id) fail(403, 'Solo chi ha creato il progetto può cambiarne la visibilità');
    f.private = bool(b.private);
  }
  f.updated_at = now();
  setFields('projects', p.id, f);
});

route('DELETE', '/api/projects/:id', ({ params, user }) => {
  const p = getProject(params.id, user.id);
  if (p.created_by !== user.id && !user.is_admin) fail(403, 'Solo chi ha creato il progetto (o un admin) può eliminarlo');
  db.prepare('UPDATE projects SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), user.id, p.id);
});

// ---------- magazzino ----------
function itemFields(b) {
  const f = {};
  for (const [k, max] of Object.entries({ name: 200, category: 60, firmware: 100, location: 100, notes: 20000 })) {
    if (b[k] !== undefined) f[k] = str(b[k], max);
  }
  if (b.qty !== undefined) {
    if (b.qty === null || b.qty === '') f.qty = null;
    else if (Number.isInteger(+b.qty)) f.qty = +b.qty;
    else fail(400, 'Quantità non valida');
  }
  return f;
}

function checkCode(code) {
  if (!CODE_OK.test(code)) fail(400, 'Codice: lettere, numeri e . _ - / (deve iniziare e finire con lettera o numero)');
  return code;
}

route('POST', '/api/items', async ({ user, body }) => {
  const b = await body();
  const code = checkCode(str(b.code, 64));
  const existing = db.prepare('SELECT deleted_at FROM items WHERE code = ?').get(code);
  if (existing) fail(409, existing.deleted_at ? `${code} è nel cestino: ripristinalo da lì` : `Il codice ${code} esiste già`);
  const t = now();
  const id = insertId(db.prepare('INSERT INTO items (code, created_by, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(code, user.id, t, t));
  setFields('items', id, itemFields(b));
  return { id };
});

route('PATCH', '/api/items/:id', async ({ params, body }) => {
  const b = await body();
  const it = getItem(params.id);
  const f = itemFields(b);
  tx(() => {
    if (b.code !== undefined && b.code !== it.code) {
      f.code = checkCode(str(b.code, 64));
      if (db.prepare('SELECT 1 FROM items WHERE code = ? AND id != ?').get(f.code, it.id)) fail(409, `Il codice ${f.code} esiste già`);
      renameCodeInEntries(it, f.code);
    }
    f.updated_at = now();
    setFields('items', it.id, f);
  });
});

// Rinominando un codice si aggiornano anche i #riferimenti nel testo delle voci collegate.
function renameCodeInEntries(it, code) {
  const esc = it.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[\\s(\\[,;:])#${esc}(?![\\w]|[.\\-/][\\w])`, 'gi');
  const fix = s => (s ? s.replace(re, `$1#${code}`) : s);
  const ids = db.prepare('SELECT entry_id FROM entry_items WHERE item_id = ?').all(it.id).map(r => r.entry_id);
  for (const id of ids) {
    const e = db.prepare('SELECT title, notes FROM entries WHERE id = ?').get(id);
    db.prepare('UPDATE entries SET title = ?, notes = ? WHERE id = ?').run(fix(e.title), fix(e.notes), id);
    for (const l of db.prepare('SELECT id, text FROM entry_log WHERE entry_id = ?').all(id)) {
      db.prepare('UPDATE entry_log SET text = ? WHERE id = ?').run(fix(l.text), l.id);
    }
  }
}

route('DELETE', '/api/items/:id', ({ params, user }) => {
  const it = getItem(params.id);
  db.prepare('UPDATE items SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), user.id, it.id);
});

route('POST', '/api/items/:id/children', async ({ params, user, body }) => {
  const b = await body();
  const it = getItem(params.id);
  const code = checkCode(str(b.code, 64).replace(/^#/, ''));
  tx(() => {
    const childId = ensureItem(code, user);
    if (childId === it.id) fail(400, 'Un articolo non può contenere se stesso');
    db.prepare('INSERT OR IGNORE INTO item_links (parent_id, child_id) VALUES (?, ?)').run(it.id, childId);
  });
});

route('DELETE', '/api/items/:id/children/:child', ({ params }) => {
  db.prepare('DELETE FROM item_links WHERE parent_id = ? AND child_id = ?').run(+params.id, +params.child);
});

// ---------- documenti ----------
// Salva il corpo della richiesta (file grezzo) in uploads/ con un nome casuale.
export async function saveUpload(req) {
  if (+req.headers['content-length'] > MAX_UPLOAD) fail(413, `File troppo grande (max ${MAX_UPLOAD >> 20} MB)`);
  const stored = crypto.randomBytes(16).toString('hex');
  const dest = path.join(UPLOAD_DIR, stored);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_UPLOAD) return cb(new HttpError(413, `File troppo grande (max ${MAX_UPLOAD >> 20} MB)`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, meter, fs.createWriteStream(dest));
    if (!size) fail(400, 'File vuoto');
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
  return { stored, size, sha256: hash.digest('hex'), mime: str(req.headers['content-type'], 100) || 'application/octet-stream' };
}

// Upload: il corpo della richiesta è il file grezzo, i metadati stanno nella query string.
// Con Content-Type JSON invece si registra un link esterno (repo, wiki, drive...).
route('POST', '/api/items/:id/docs', async ({ req, params, query, user, body }) => {
  const it = getItem(params.id);
  const kind = DOC_KINDS.includes(query.kind) ? query.kind : 'altro';
  const t = now();

  if ((req.headers['content-type'] || '').startsWith('application/json')) {
    const b = await body();
    const url = str(b.url, 2000);
    if (!/^https?:\/\//i.test(url)) fail(400, 'Il link deve iniziare con http:// o https://');
    const k = DOC_KINDS.includes(b.kind) ? b.kind : 'altro';
    const id = insertId(db.prepare(`INSERT INTO documents (item_id, kind, label, version, url, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(it.id, k, str(b.label, 200), str(b.version, 60), url, user.id, t));
    return { id };
  }

  const { stored, size, sha256, mime } = await saveUpload(req);
  const version = str(query.version, 60);
  const id = insertId(db.prepare(`INSERT INTO documents (item_id, kind, label, version, filename, mime, size, sha256, stored, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(it.id, kind, str(query.label, 200), version, str(query.name, 255) || 'file', mime, size, sha256, stored, user.id, t));
  if (kind === 'firmware' && version) db.prepare('UPDATE items SET firmware = ?, updated_at = ? WHERE id = ?').run(version, t, it.id);
  return { id };
});

export const INLINE_OK = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)$/;

route('GET', '/api/docs/:id/file', ({ res, params, query }) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(+params.id);
  if (!d?.stored) fail(404, 'Documento non trovato');
  const file = path.join(UPLOAD_DIR, d.stored);
  if (!fs.existsSync(file)) fail(404, 'File mancante sul server');
  const safe = INLINE_OK.test(d.mime || '');
  const name = d.filename || `documento-${d.id}`;
  res.writeHead(200, {
    'Content-Type': safe ? d.mime : 'application/octet-stream',
    'Content-Length': fs.statSync(file).size,
    'Content-Disposition': `${query.inline && safe ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
    ...(d.mime === 'application/pdf' ? {} : { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'" }),
  });
  fs.createReadStream(file).pipe(res);
});

route('PATCH', '/api/docs/:id', async ({ params, body }) => {
  const b = await body();
  const d = db.prepare('SELECT id FROM documents WHERE id = ?').get(+params.id) || fail(404, 'Documento non trovato');
  const f = {};
  if (b.label !== undefined) f.label = str(b.label, 200);
  if (b.version !== undefined) f.version = str(b.version, 60);
  if (b.kind !== undefined) f.kind = DOC_KINDS.includes(b.kind) ? b.kind : 'altro';
  setFields('documents', d.id, f);
});

route('DELETE', '/api/docs/:id', ({ params, user }) => {
  const d = db.prepare('SELECT id FROM documents WHERE id = ? AND deleted_at IS NULL').get(+params.id) || fail(404, 'Documento non trovato');
  db.prepare('UPDATE documents SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), user.id, d.id);
});

// ---------- amministrazione ----------
route('GET', '/api/admin/invites', () =>
  db.prepare('SELECT code, created_at, expires_at FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC').all(now()),
{ auth: 'admin' });

route('POST', '/api/admin/invites', ({ user }) => {
  const code = randomCode(10);
  const expires = new Date(Date.now() + 7 * 864e5).toISOString();
  db.prepare('INSERT INTO invites (code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)').run(code, user.id, now(), expires);
  return { code, expires_at: expires };
}, { auth: 'admin' });

route('DELETE', '/api/admin/invites/:code', ({ params }) => {
  db.prepare('DELETE FROM invites WHERE code = ? AND used_at IS NULL').run(params.code);
}, { auth: 'admin' });

route('PATCH', '/api/admin/users/:id', async ({ params, user, body }) => {
  const b = await body();
  const target = getUser(params.id);
  if (b.is_admin !== undefined) {
    if (target.id === user.id && !b.is_admin) fail(400, 'Non puoi toglierti i permessi da solo');
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(bool(b.is_admin), target.id);
  }
  if (b.reset_password) {
    const password = randomCode(12);
    db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(await hashPassword(password), target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    dropUser(target.id);
    return { password };
  }
}, { auth: 'admin' });

route('DELETE', '/api/admin/users/:id', ({ params, user }) => {
  const target = getUser(params.id);
  if (target.id === user.id) fail(400, 'Non puoi eliminare te stesso');
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  dropUser(target.id);
}, { auth: 'admin' });

route('GET', '/api/admin/backup', ({ res }) => {
  const file = path.join(DATA_DIR, `backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': fs.statSync(file).size,
    'Content-Disposition': `attachment; filename="organizer-${stamp}.db"`,
  });
  fs.createReadStream(file).pipe(res).on('close', () => fs.rmSync(file, { force: true }));
}, { auth: 'admin' });
