import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, tx, DATA_DIR, UPLOAD_DIR } from './db.js';
import { parseQuick, parseDate, extractCodes, isYmd, today } from '../public/js/parse.js';
import { hashPassword, verifyPassword, sessionCookie, validUsername, validPassword, randomCode } from './auth.js';
import {
  acc, atx, userCount, getAccount, workspaceById, workspacesOf, membersOf, roleIn, adminCount,
  addMember, createWorkspace, removeMember, syncMirror, createSession, destroySession, defaultWorkspace, setSessionWorkspace,
  revokeApiTokens,
} from './accounts.js';
import { HttpError, fail, now, bool, str, sendJson } from './util.js';
import { rev, openStream, dropUser } from './events.js';
import { currentWorkspace } from './db.js';

const KINDS = ['todo', 'mail', 'note'];
const STATUSES = ['open', 'paused', 'closed'];
const DOC_KINDS = ['firmware', 'datasheet', 'schema', 'footprint', 'manuale', 'foto', 'altro'];
const ARCHIVE_DAYS = 30;
const CHAT_IN_SYNC = 100;
const MAX_UPLOAD = (+process.env.MAX_UPLOAD_MB || 200) * 1048576;
const CODE_OK = /^[A-Za-z0-9](?:[\w.\-/]*[A-Za-z0-9_])?$/;

export const routes = [];
// auth: 'none' | 'user' | 'admin' (admin del workspace attivo). ws: false per le route che non usano
// i dati di un workspace (account, elenco e creazione dei workspace). quiet: la modifica riguarda solo
// chi la fa, quindi gli altri client non vengono avvisati di rileggere i dati.
export function route(method, pattern, handler, { auth = 'user', ws = auth !== 'none', quiet = false } = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth, ws, quiet });
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
// +utente: solo i membri attuali del workspace.
const findUser = name => db.prepare('SELECT id FROM users WHERE member = 1 AND (username = $n COLLATE NOCASE OR name = $n COLLATE NOCASE)').get({ n: name });

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
  syncEntryLinks(entryId);
}

export const LINK_KINDS = ['doc', 'voce', 'contatto', 'progetto'];
const REF_RE = /\[\[(doc|voce|contatto|progetto):(\d+)\]\]/g;
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Gli altri collegamenti (per i backlink): [[tipo:ID]] ovunque nel testo della voce e, nelle mail, i codici
// di magazzino scritti senza # (l'autocompletamento del testo delle mail li inserisce così).
export function syncEntryLinks(entryId) {
  const e = db.prepare('SELECT kind, title, notes, mail_subject FROM entries WHERE id = ?').get(entryId);
  const logs = db.prepare('SELECT text FROM entry_log WHERE entry_id = ?').all(entryId).map(l => l.text);
  const text = [e.title, e.notes, e.mail_subject || '', ...logs].join('\n');
  db.prepare('DELETE FROM entry_links WHERE entry_id = ?').run(entryId);
  const link = db.prepare('INSERT OR IGNORE INTO entry_links (entry_id, kind, target_id) VALUES (?, ?, ?)');
  for (const m of text.matchAll(REF_RE)) if (!(m[1] === 'voce' && +m[2] === entryId)) link.run(entryId, m[1], +m[2]);
  if (e.kind !== 'mail') return;
  const body = `${e.notes}\n${e.mail_subject || ''}`;
  for (const it of db.prepare('SELECT id, code FROM items WHERE deleted_at IS NULL').all()) {
    if (new RegExp(`(^|[^\\w#])${escRe(it.code)}(?![\\w]|[.\\-/][\\w])`, 'i').test(body)) link.run(entryId, 'articolo', it.id);
  }
}

// Prima volta con la tabella dei collegamenti: si calcolano per le voci che ci sono già.
export function backfillLinks() {
  if (db.prepare('SELECT 1 FROM entry_links LIMIT 1').get()) return 0;
  const ids = db.prepare('SELECT id FROM entries').all().map(r => r.id);
  tx(() => { for (const id of ids) syncEntryLinks(id); });
  return ids.length;
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
export function throttle(key) {
  const a = attempts.get(key);
  if (a && a.n >= 10 && Date.now() - a.t < 15 * 60e3) fail(429, 'Troppi tentativi, riprova tra qualche minuto');
}
export const clearFailures = key => attempts.delete(key);
export function noteFailure(key) {
  let a = attempts.get(key);
  if (!a || Date.now() - a.t > 15 * 60e3) a = { n: 0, t: Date.now() };
  a.n++;
  attempts.set(key, a);
}

// Sessione nuova; il workspace attivo è l'ultimo usato (o quello indicato, es. dopo un invito).
function login(req, res, userId, wsId = defaultWorkspace(userId)) {
  res.setHeader('Set-Cookie', sessionCookie(req, createSession(userId, wsId)));
  if (wsId) acc.prepare('UPDATE users SET last_workspace_id = ? WHERE id = ?').run(wsId, userId);
  return { user: getAccount(userId) };
}

async function newAccount(b) {
  const username = str(b.username, 32);
  if (!validUsername(username)) fail(400, 'Username: 2-32 caratteri tra lettere, numeri, . _ -');
  if (!validPassword(b.password)) fail(400, 'La password deve avere almeno 8 caratteri');
  if (acc.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'Username già in uso');
  return { username, name: str(b.name, 60) || username, pass: await hashPassword(b.password) };
}

const insertAccount = u => Number(acc.prepare('INSERT INTO users (username, name, pass, created_at) VALUES (?, ?, ?, ?)')
  .run(u.username, u.name, u.pass, now()).lastInsertRowid);

const wsInfo = (wsId, userId) => ({ id: wsId, name: workspaceById(wsId)?.name, role: roleIn(wsId, userId) });

const validInvite = code => acc.prepare(`SELECT i.*, w.name AS workspace_name FROM invites i JOIN workspaces w ON w.id = i.workspace_id
  WHERE i.code = ? AND i.used_at IS NULL AND i.expires_at > ? AND w.deleted_at IS NULL`).get(String(code || '').trim().toUpperCase(), now());

// Usa l'invito: l'account entra nel workspace come membro (se non c'era già).
function acceptInvite(inv, userId) {
  const ws = workspaceById(inv.workspace_id);
  atx(() => {
    if (!roleIn(ws.id, userId)) acc.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").run(ws.id, userId, now());
    acc.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?').run(userId, now(), inv.code);
  });
  syncMirror(ws, userId);
  return ws;
}

route('GET', '/api/me', ({ user }) => ({
  user: user && getAccount(user.id),
  setup: userCount() === 0,
  workspaces: user ? workspacesOf(user.id) : [],
  workspace: user?.workspace_id ? wsInfo(user.workspace_id, user.id) : null,
}), { auth: 'none' });

route('POST', '/api/setup', async ({ req, res, body }) => {
  const b = await body();
  if (userCount() > 0) fail(403, 'Configurazione già eseguita');
  const u = await newAccount(b);
  const id = atx(() => {
    if (userCount() > 0) fail(403, 'Configurazione già eseguita');
    return insertAccount(u);
  });
  const ws = createWorkspace(str(b.workspace, 80) || 'Principale', id);
  return login(req, res, id, ws.id);
}, { auth: 'none' });

route('POST', '/api/login', async ({ req, res, body }) => {
  const b = await body();
  const key = `${req.socket.remoteAddress}|${String(b.username).toLowerCase()}`;
  throttle(key);
  const u = acc.prepare('SELECT id, pass FROM users WHERE username = ?').get(str(b.username, 32));
  if (!u || !(await verifyPassword(String(b.password || ''), u.pass))) {
    noteFailure(key);
    fail(401, 'Credenziali errate');
  }
  attempts.delete(key);
  // Accesso con un codice invito: chi ha già un account entra anche nel nuovo workspace.
  const inv = b.code && validInvite(b.code);
  if (b.code && !inv) fail(400, 'Invito non valido o scaduto');
  return login(req, res, u.id, inv ? acceptInvite(inv, u.id).id : undefined);
}, { auth: 'none' });

route('GET', '/api/invites/:code', ({ params }) => {
  const inv = validInvite(params.code) || fail(404, 'Invito non valido o scaduto');
  return { workspace: inv.workspace_name };
}, { auth: 'none' });

route('POST', '/api/register', async ({ req, res, body }) => {
  const b = await body();
  const key = `${req.socket.remoteAddress}|invite`;
  throttle(key);
  if (!validInvite(b.code)) {
    noteFailure(key);
    fail(400, 'Invito non valido o scaduto');
  }
  const u = await newAccount(b);
  const id = atx(() => insertAccount(u));
  const inv = validInvite(b.code) || fail(400, 'Invito non valido o scaduto');
  return login(req, res, id, acceptInvite(inv, id).id);
}, { auth: 'none' });

// Invito aperto da chi è già dentro all'app.
route('POST', '/api/invites/:code/accept', ({ req, params, user, token }) => {
  const inv = validInvite(params.code) || fail(400, 'Invito non valido o scaduto');
  const ws = acceptInvite(inv, user.id);
  setSessionWorkspace(token, user.id, ws.id);
  return { workspace: { id: ws.id, name: ws.name } };
}, { ws: false });

route('POST', '/api/logout', ({ req, res, token }) => {
  destroySession(token);
  res.setHeader('Set-Cookie', sessionCookie(req, ''));
  return { ok: true };
}, { auth: 'none' });

route('PATCH', '/api/me', async ({ user, body }) => {
  const b = await body();
  if (b.name !== undefined) {
    acc.prepare('UPDATE users SET name = ? WHERE id = ?').run(str(b.name, 60) || user.username, user.id);
    for (const w of workspacesOf(user.id)) syncMirror(workspaceById(w.id), user.id);
  }
  if (b.password !== undefined) {
    const row = acc.prepare('SELECT pass FROM users WHERE id = ?').get(user.id);
    if (!(await verifyPassword(String(b.current || ''), row.pass))) fail(400, 'Password attuale errata');
    if (!validPassword(b.password)) fail(400, 'La password deve avere almeno 8 caratteri');
    acc.prepare('UPDATE users SET pass = ? WHERE id = ?').run(await hashPassword(b.password), user.id);
  }
  return { user: getAccount(user.id) };
}, { ws: false });

route('GET', '/api/events', ({ req, res, user }) => openStream(req, res, user));

// ---------- sync ----------
route('GET', '/api/sync', ({ req, res, user }) => {
  // Il segno di lettura della chat cambia senza notifiche (riguarda solo chi legge): fa parte dell'ETag.
  const chatRead = db.prepare('SELECT chat_read_id FROM users WHERE id = ?').get(user.id)?.chat_read_id ?? 0;
  const etag = `"${rev()}-${user.id}-${user.workspace_id}-${chatRead}"`;
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
    // Tutti quelli che compaiono nei dati (anche ex membri, per i nomi); member = 1 per i membri attuali.
    users: db.prepare('SELECT id, username, name, is_admin, member FROM users ORDER BY name COLLATE NOCASE').all(),
    workspace: wsInfo(user.workspace_id, uid),
    workspaces: workspacesOf(uid),
    projects: db.prepare(`SELECT p.* FROM projects p WHERE ${PVIS} ORDER BY p.name COLLATE NOCASE`).all({ uid }),
    entries: db.prepare(`SELECT e.* FROM entries e WHERE ${where} ORDER BY e.id`).all(p),
    logs: db.prepare(`SELECT l.* FROM entry_log l JOIN entries e ON e.id = l.entry_id WHERE ${where} ORDER BY l.id`).all(p),
    entryItems: db.prepare(`SELECT ei.entry_id, ei.item_id FROM entry_items ei JOIN entries e ON e.id = ei.entry_id WHERE ${where}`).all(p),
    items: db.prepare('SELECT * FROM items WHERE deleted_at IS NULL ORDER BY code COLLATE NOCASE').all(),
    itemLinks: db.prepare('SELECT parent_id, child_id FROM item_links').all(),
    entryProjects: db.prepare(`SELECT ep.entry_id, ep.project_id FROM entry_projects ep
      JOIN entries e ON e.id = ep.entry_id JOIN projects p ON p.id = ep.project_id
      WHERE ${where} AND p.deleted_at IS NULL AND (p.private = 0 OR p.created_by = $uid)`).all(p),
    projectItems: db.prepare(`SELECT pi.project_id, pi.item_id FROM project_items pi
      JOIN projects p ON p.id = pi.project_id WHERE ${PVIS}`).all({ uid }),
    docs: db.prepare(`SELECT id, item_id, kind, label, version, filename, mime, size, sha256, url, created_by, created_at
      FROM documents WHERE deleted_at IS NULL ORDER BY created_at DESC`).all(),
    contacts: db.prepare('SELECT * FROM contacts WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE, email').all(),
    categoryColors: db.prepare('SELECT name, hue FROM category_colors').all(),
    docNotes: db.prepare(`SELECT n.* FROM doc_notes n JOIN documents d ON d.id = n.doc_id
      WHERE n.deleted_at IS NULL AND d.deleted_at IS NULL ORDER BY n.id`).all(),
    attachments: db.prepare(`SELECT a.id, a.entry_id, a.doc_id, a.filename, a.mime, a.size FROM mail_attachments a
      JOIN entries e ON e.id = a.entry_id WHERE ${where} ORDER BY a.id`).all(p),
    // Chat: gli ultimi messaggi (i precedenti con /api/chat?before=) e quanti ne restano da leggere.
    chat: db.prepare(`SELECT id, user_id, text, created_at, edited_at FROM chat_messages WHERE deleted_at IS NULL
      ORDER BY id DESC LIMIT ${CHAT_IN_SYNC}`).all().reverse(),
    chatReadId: chatRead,
    chatUnread: db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE deleted_at IS NULL AND user_id != ? AND id > ?').get(uid, chatRead).n,
    trashCount: db.prepare(`SELECT
      (SELECT COUNT(*) FROM entries e WHERE e.deleted_at IS NOT NULL AND ${VIS_ANY}
        AND (e.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM entries x WHERE x.id = e.parent_id AND x.deleted_at = e.deleted_at)))
      + (SELECT COUNT(*) FROM projects p WHERE p.deleted_at IS NOT NULL AND ${PVIS_ANY})
      + (SELECT COUNT(*) FROM items WHERE deleted_at IS NOT NULL)
      + (SELECT COUNT(*) FROM documents d WHERE d.deleted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM items i WHERE i.id = d.item_id AND i.deleted_at IS NULL))
      + (SELECT COUNT(*) FROM contacts WHERE deleted_at IS NOT NULL)
      + (SELECT COUNT(*) FROM doc_notes n WHERE n.deleted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM documents d WHERE d.id = n.doc_id AND d.deleted_at IS NULL)) AS n`).get({ uid }).n,
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

  // Tutti i progetti: quelli scritti con @ (il primo diventa il principale) più quello della pagina.
  const projectIds = [...new Set([
    ...p.projects.map(tag => resolveProject(tag, user)),
    ...(b.project_id ? [getProject(b.project_id, user.id).id] : []),
  ])];
  const projectId = projectIds[0] ?? parent?.project_id ?? null;

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
  for (const pid of projectIds.slice(1)) addEntryProject(id, pid);
  syncEntryItems(id, user);
  return id;
}

function addEntryProject(entryId, projectId) {
  db.prepare('INSERT OR IGNORE INTO entry_projects (entry_id, project_id) VALUES (?, ?)').run(entryId, projectId);
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
    // @progetto nel titolo aggiunge il progetto (non toglie gli altri); se non ce n'è uno principale, lo diventa.
    for (const tag of p.projects) {
      const pid = resolveProject(tag, user);
      if (!e.project_id && f.project_id === undefined) f.project_id = pid;
      else if (pid !== (f.project_id ?? e.project_id)) addEntryProject(e.id, pid);
    }
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
    // Oltre a AAAA-MM-GG, le date della barra rapida: "ven", "3g", "25/11", "no" (= nessuna).
    const due = b.due === null || isYmd(b.due) ? b.due : parseDate(str(b.due, 30).replace(/^!/, ''), base, { past: (f.kind ?? e.kind) === 'note' });
    if (due === undefined) fail(400, 'Data non valida');
    f.due = due;
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
  else if (f.mail_subject !== undefined || f.kind !== undefined) syncEntryLinks(e.id);
}

route('POST', '/api/entries', async ({ user, body }) => {
  const b = await body();
  return { id: tx(() => createEntry(b, user)) };
});

// Una voce con tutto ciò che le sta attorno (per la CLI e i programmi esterni: l'app usa /api/sync).
// Funziona anche per le voci archiviate, che /api/sync non manda più.
route('GET', '/api/entries/:id', ({ params, user }) => {
  const e = getEntry(params.id, user.id);
  return {
    ...e,
    projects: db.prepare(`SELECT p.id, p.tag, p.name FROM projects p WHERE p.id IN
      (SELECT $pid UNION SELECT project_id FROM entry_projects WHERE entry_id = $id) AND ${PVIS}
      ORDER BY p.id != $pid, p.name COLLATE NOCASE`).all({ pid: e.project_id, id: e.id, uid: user.id }),
    items: db.prepare(`SELECT i.id, i.code, i.name FROM entry_items ei JOIN items i ON i.id = ei.item_id
      WHERE ei.entry_id = ? AND i.deleted_at IS NULL ORDER BY i.code`).all(e.id),
    logs: db.prepare('SELECT * FROM entry_log WHERE entry_id = ? ORDER BY id').all(e.id),
    subtasks: db.prepare(`SELECT e.* FROM entries e WHERE e.parent_id = $id AND ${VIS} ORDER BY e.id`).all({ id: e.id, uid: user.id }),
    attachments: db.prepare('SELECT id, doc_id, filename, mime, size FROM mail_attachments WHERE entry_id = ? ORDER BY id').all(e.id),
  };
});

// Backlink: le voci (anche archiviate) che collegano l'elemento. Per un articolo anche #CODICE e i codici
// nelle mail, per un documento anche gli allegati, per un contatto anche le mail mandate al suo indirizzo.
route('GET', '/api/backlinks/:kind/:id', ({ params, user }) => {
  const { kind } = params;
  const id = +params.id;
  if (![...LINK_KINDS, 'articolo'].includes(kind)) fail(404, 'Tipo sconosciuto');
  const ids = db.prepare('SELECT entry_id AS id FROM entry_links WHERE kind = ? AND target_id = ?').all(kind, id).map(r => r.id);
  if (kind === 'articolo') ids.push(...db.prepare('SELECT entry_id AS id FROM entry_items WHERE item_id = ?').all(id).map(r => r.id));
  if (kind === 'doc') ids.push(...db.prepare('SELECT entry_id AS id FROM mail_attachments WHERE doc_id = ?').all(id).map(r => r.id));
  if (kind === 'contatto') {
    const email = db.prepare("SELECT email FROM contacts WHERE id = ? AND email != ''").get(id)?.email;
    if (email) {
      ids.push(...db.prepare(`SELECT id FROM entries WHERE kind = 'mail' AND (',' || REPLACE(LOWER(contact), ' ', '') || ',') LIKE ?`)
        .all(`%,${email.toLowerCase()},%`).map(r => r.id));
    }
  }
  return db.prepare(`SELECT e.id, e.kind, e.title, e.due, e.done_at, e.contact, e.mail_subject, e.project_id, e.parent_id, e.updated_at
    FROM entries e WHERE e.id IN (SELECT value FROM json_each($ids)) AND ${VIS} ORDER BY e.updated_at DESC`)
    .all({ ids: JSON.stringify([...new Set(ids)]), uid: user.id });
});

route('PATCH', '/api/entries/:id', async ({ params, user, body }) => {
  const b = await body();
  tx(() => updateEntry(getEntry(params.id, user.id), b, user));
});

// Eliminare = spostare nel cestino. Le sotto-attività seguono la voce con lo stesso istante,
// così il ripristino riporta indietro esattamente ciò che è stato eliminato insieme.
// Progetti di una voce: il primo aggiunto diventa il principale; togliendo il principale lo diventa il successivo.
route('POST', '/api/entries/:id/projects', async ({ params, user, body }) => {
  const b = await body();
  const e = getEntry(params.id, user.id);
  const pid = getProject(b.project_id, user.id).id;
  tx(() => {
    if (!e.project_id) {
      db.prepare('UPDATE entries SET project_id = ?, updated_at = ? WHERE id = ?').run(pid, now(), e.id);
      db.prepare('UPDATE entries SET project_id = ? WHERE parent_id = ?').run(pid, e.id);
    } else if (pid !== e.project_id) addEntryProject(e.id, pid);
  });
});

route('DELETE', '/api/entries/:id/projects/:pid', ({ params, user }) => {
  const e = getEntry(params.id, user.id);
  const pid = +params.pid;
  tx(() => {
    if (pid === e.project_id) {
      const next = db.prepare('SELECT project_id FROM entry_projects WHERE entry_id = ? ORDER BY rowid LIMIT 1').get(e.id)?.project_id ?? null;
      db.prepare('UPDATE entries SET project_id = ?, updated_at = ? WHERE id = ?').run(next, now(), e.id);
      db.prepare('UPDATE entries SET project_id = ? WHERE parent_id = ?').run(next, e.id);
      if (next) db.prepare('DELETE FROM entry_projects WHERE entry_id = ? AND project_id = ?').run(e.id, next);
    } else {
      db.prepare('DELETE FROM entry_projects WHERE entry_id = ? AND project_id = ?').run(e.id, pid);
    }
  });
});

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
  const parentId = b.parent_id ? getProject(b.parent_id, user.id).id : null;
  const t = now();
  const id = insertId(db.prepare('INSERT INTO projects (name, tag, private, parent_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, tag, bool(b.private), parentId, user.id, t, t));
  return { id, tag };
});

// Colore scelto a mano: tinta 0..359, oppure null per tornare al colore automatico.
function checkHue(v) {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 359) fail(400, 'Colore non valido');
  return n;
}

route('PUT', '/api/categories/color', async ({ body }) => {
  const b = await body();
  const name = str(b.name, 60) || fail(400, 'Categoria mancante');
  const hue = checkHue(b.hue);
  if (hue === null) db.prepare('DELETE FROM category_colors WHERE name = ?').run(name);
  else db.prepare('INSERT INTO category_colors (name, hue) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET hue = excluded.hue').run(name, hue);
});

// Un progetto non può finire dentro se stesso o dentro un suo discendente.
function checkParent(p, parentId) {
  for (let id = parentId, depth = 0; id; depth++) {
    if (id === p.id || depth > 50) fail(400, 'Un progetto non può stare dentro se stesso o un suo sottoprogetto');
    id = db.prepare('SELECT parent_id FROM projects WHERE id = ?').get(id)?.parent_id;
  }
}

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
  if (b.hue !== undefined) f.hue = checkHue(b.hue);
  if (b.parent_id !== undefined) {
    f.parent_id = b.parent_id ? getProject(b.parent_id, user.id).id : null;
    checkParent(p, f.parent_id);
  }
  if (b.private !== undefined) {
    if (p.created_by !== user.id) fail(403, 'Solo chi ha creato il progetto può cambiarne la visibilità');
    f.private = bool(b.private);
  }
  f.updated_at = now();
  setFields('projects', p.id, f);
});

// Articoli di magazzino legati al progetto a mano (oltre a quelli citati con #CODICE nelle voci).
route('POST', '/api/projects/:id/items', async ({ params, user, body }) => {
  const b = await body();
  const p = getProject(params.id, user.id);
  const code = checkCode(str(b.code, 64).replace(/^#/, ''));
  return tx(() => {
    const itemId = ensureItem(code, user);
    db.prepare('INSERT OR IGNORE INTO project_items (project_id, item_id, created_at) VALUES (?, ?, ?)').run(p.id, itemId, now());
    return { item_id: itemId };
  });
});

route('DELETE', '/api/projects/:id/items/:item', ({ params, user }) => {
  const p = getProject(params.id, user.id);
  db.prepare('DELETE FROM project_items WHERE project_id = ? AND item_id = ?').run(p.id, +params.item);
});

route('DELETE', '/api/projects/:id', ({ params, user }) => {
  const p = getProject(params.id, user.id);
  if (p.created_by !== user.id && !user.is_admin) fail(403, 'Solo chi ha creato il progetto (o un admin) può eliminarlo');
  db.prepare('UPDATE projects SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), user.id, p.id);
});

// ---------- magazzino ----------
function itemFields(b) {
  const f = {};
  for (const [k, max] of Object.entries({ name: 200, category: 60, firmware: 100, location: 100, notes: 20000, url: 2000 })) {
    if (b[k] !== undefined) f[k] = str(b[k], max);
  }
  if (f.url && !/^https?:\/\//i.test(f.url)) f.url = `https://${f.url}`;
  if (b.status !== undefined) {
    if (!['', 'outdated', 'discarded'].includes(b.status)) fail(400, 'Stato non valido');
    f.status = b.status;
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
  const projectId = b.project_id ? getProject(b.project_id, user.id).id : null;
  const t = now();
  return tx(() => {
    const id = insertId(db.prepare('INSERT INTO items (code, created_by, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(code, user.id, t, t));
    setFields('items', id, itemFields(b));
    if (projectId) db.prepare('INSERT INTO project_items (project_id, item_id, created_at) VALUES (?, ?, ?)').run(projectId, id, t);
    return { id };
  });
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
  // Scaricando, il file prende il nome dato nell'app (con l'estensione del file originale).
  const ext = path.extname(d.filename || '');
  const label = (d.label || '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').replace(/\s+(\.\w+)$/, '$1').trim();
  const name = label ? (ext && !label.toLowerCase().endsWith(ext.toLowerCase()) ? `${label}${ext}` : label) : d.filename || `documento-${d.id}`;
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
  const d = db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(+params.id) || fail(404, 'Documento non trovato');
  const f = {};
  if (b.label !== undefined) f.label = str(b.label, 200);
  if (b.version !== undefined) f.version = str(b.version, 60);
  if (b.kind !== undefined) f.kind = DOC_KINDS.includes(b.kind) ? b.kind : 'altro';
  tx(() => {
    setFields('documents', d.id, f);
    // Come al caricamento: il firmware più recente con versione dà la versione all'articolo.
    const latest = db.prepare(`SELECT version FROM documents WHERE item_id = ? AND kind = 'firmware' AND version != ''
      AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`).get(d.item_id);
    // Vale anche se il documento smette di essere un firmware: torna la versione del firmware più recente rimasto.
    if (((f.kind ?? d.kind) === 'firmware' || d.kind === 'firmware') && latest) {
      db.prepare('UPDATE items SET firmware = ?, updated_at = ? WHERE id = ?').run(latest.version, now(), d.item_id);
    }
  });
});

// ---------- note sui documenti ----------
function notePosition(b) {
  if (b.page == null) return { page: null, x: null, y: null };
  const page = Number(b.page);
  const x = Number(b.x);
  const y = Number(b.y);
  if (!Number.isInteger(page) || page < 1 || !(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) fail(400, 'Posizione non valida');
  return { page, x, y };
}

const getNote = id => db.prepare('SELECT * FROM doc_notes WHERE id = ? AND deleted_at IS NULL').get(+id) || fail(404, 'Nota non trovata');

route('POST', '/api/docs/:id/notes', async ({ params, user, body }) => {
  const b = await body();
  const d = db.prepare('SELECT id FROM documents WHERE id = ? AND deleted_at IS NULL').get(+params.id) || fail(404, 'Documento non trovato');
  const text = str(b.text, 5000) || fail(400, 'Scrivi la nota');
  const { page, x, y } = notePosition(b);
  const t = now();
  return { id: insertId(db.prepare(`INSERT INTO doc_notes (doc_id, page, x, y, text, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(d.id, page, x, y, text, user.id, t, t)) };
});

route('PATCH', '/api/doc-notes/:id', async ({ params, body }) => {
  const b = await body();
  const n = getNote(params.id);
  const f = {};
  if (b.text !== undefined) f.text = str(b.text, 5000) || fail(400, 'La nota non può essere vuota');
  if (b.resolved !== undefined) f.resolved_at = b.resolved ? n.resolved_at || now() : null;
  if (b.page !== undefined) Object.assign(f, notePosition(b));
  f.updated_at = now();
  setFields('doc_notes', n.id, f);
});

route('DELETE', '/api/doc-notes/:id', ({ params, user }) => {
  const n = getNote(params.id);
  db.prepare('UPDATE doc_notes SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), user.id, n.id);
});

route('DELETE', '/api/docs/:id', ({ params, user }) => {
  const d = db.prepare('SELECT id FROM documents WHERE id = ? AND deleted_at IS NULL').get(+params.id) || fail(404, 'Documento non trovato');
  db.prepare('UPDATE documents SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), user.id, d.id);
});

// ---------- amministrazione del workspace attivo ----------
const activeWs = () => workspaceById(currentWorkspace()) || fail(404, 'Workspace non trovato');

route('GET', '/api/admin/invites', () =>
  acc.prepare('SELECT code, created_at, expires_at FROM invites WHERE workspace_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC')
    .all(currentWorkspace(), now()),
{ auth: 'admin' });

route('POST', '/api/admin/invites', ({ user }) => {
  const code = randomCode(10);
  const expires = new Date(Date.now() + 7 * 864e5).toISOString();
  acc.prepare('INSERT INTO invites (code, workspace_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(code, currentWorkspace(), user.id, now(), expires);
  return { code, expires_at: expires };
}, { auth: 'admin' });

route('DELETE', '/api/admin/invites/:code', ({ params }) => {
  acc.prepare('DELETE FROM invites WHERE code = ? AND workspace_id = ? AND used_at IS NULL').run(params.code, currentWorkspace());
}, { auth: 'admin' });

route('PATCH', '/api/admin/users/:id', async ({ params, user, body }) => {
  const b = await body();
  const ws = activeWs();
  const targetId = +params.id;
  if (!roleIn(ws.id, targetId)) fail(404, 'Non è membro di questo workspace');
  if (b.is_admin !== undefined) {
    if (targetId === user.id && !b.is_admin && adminCount(ws.id) === 1) fail(400, 'Sei l\'unico admin: prima nomina un altro admin');
    acc.prepare('UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?').run(b.is_admin ? 'admin' : 'member', ws.id, targetId);
    syncMirror(ws, targetId);
  }
  if (b.reset_password) {
    // La password vale per tutti i workspace della persona: la può reimpostare solo chi è admin in ognuno.
    const others = workspacesOf(targetId).filter(w => roleIn(w.id, user.id) !== 'admin');
    if (others.length) fail(403, 'Questa persona è anche in workspace dove non sei admin: la password la può cambiare solo lei (o il comando make reset-password)');
    const password = randomCode(12);
    acc.prepare('UPDATE users SET pass = ? WHERE id = ?').run(await hashPassword(password), targetId);
    acc.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
    revokeApiTokens(targetId);
    dropUser(targetId);
    return { password };
  }
}, { auth: 'admin' });

// Toglie la persona dal workspace (il suo account e gli altri workspace restano).
route('DELETE', '/api/admin/users/:id', ({ params, user }) => {
  const ws = activeWs();
  if (+params.id === user.id) fail(400, 'Per uscire usa "Esci dal workspace"');
  if (!roleIn(ws.id, +params.id)) fail(404, 'Non è membro di questo workspace');
  removeMember(ws, +params.id);
  dropUser(+params.id, ws.id);
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
