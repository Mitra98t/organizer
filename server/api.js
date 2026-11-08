import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, tx, DATA_DIR, UPLOAD_DIR } from './db.js';
import { parseQuick, parseDate, extractCodes, isYmd, today, ALL, parseShares } from '../public/js/parse.js';
import { hashPassword, verifyPassword, sessionCookie, validUsername, validPassword, randomCode } from './auth.js';
import {
  acc, atx, userCount, getAccount, workspaceById, workspacesOf, membersOf, roleIn, adminCount,
  addMember, createWorkspace, removeMember, syncMirror, createSession, destroySession, defaultWorkspace, setSessionWorkspace,
  revokeApiTokens, permsIn, setPerms, mailAddressesOf, mailIgnoreOf, openFeedback, tourInfo,
} from './accounts.js';
import { HttpError, fail, now, bool, str, sendJson, clientIp } from './util.js';
import { rev, openStream, dropUser, mailExtOn, mailExtVersion } from './events.js';
import { chatSync, readKey } from './chatdata.js';
import { threadsSync, ensureEntryThread, autoLink, relinkItem, cleanSubject } from './maildata.js';
import { notify, notificationsOf } from './notify.js';
import { allows, assertCan, entryArea, readableKinds } from './perms.js';
import { currentWorkspace } from './db.js';
import { zip } from './zip.js';
import { tr } from './i18n.js';

const KINDS = ['todo', 'mail', 'note'];
const STATUSES = ['open', 'paused', 'closed'];
// Document kinds: the built-in ones plus those created in the workspace (doc_kinds table); "altro" (other) always last.
const DOC_KINDS = ['firmware', 'datasheet', 'schema', 'footprint', 'manuale', 'foto', 'altro'];
export const docKinds = () => [...DOC_KINDS.slice(0, -1),
  ...db.prepare('SELECT name FROM doc_kinds ORDER BY name').all().map(r => r.name), 'altro'];
export const docKind = k => (docKinds().includes(String(k)) ? String(k) : 'altro');
const ARCHIVE_DAYS = 30;
const MAX_UPLOAD = (+process.env.MAX_UPLOAD_MB || 200) * 1048576;
const CODE_OK = /^[A-Za-z0-9](?:[\w.\-/]*[A-Za-z0-9_])?$/;

export const routes = [];
// auth: 'none' | 'user' | 'admin' (admin of the active workspace). ws: false for routes that do not use a
// workspace's data (account, list and creation of workspaces). quiet: the change only concerns whoever makes
// it, so the other clients are not told to read the data again.
// area: the permission area (see perms.js) the route reads (GET) or writes; level forces it (e.g. 'read' for a
// POST that changes nothing). Entries have their area by kind: the routes check it themselves.
export function route(method, pattern, handler, { auth = 'user', ws = auth !== 'none', quiet = false, area = null, level = null } = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth, ws, quiet, area, level });
}

// ---------- visibility ----------
// Visibility: everything is private to whoever creates it, except inventory and documents. Entries, projects,
// contacts and notes on documents are shared with some people (+person, shares table) or with everyone (+all,
// shared_all). This applies to admins too. An entry is also seen by whoever has to do it (assignee), a subtask by
// whoever sees the entry above. The *_ANY versions include what is in the trash too (deleted_at set).
const sharedWith = (kind, a) => `(${a}.created_by = $uid OR ${a}.shared_all = 1
  OR EXISTS (SELECT 1 FROM shares s WHERE s.kind = '${kind}' AND s.obj_id = ${a}.id AND s.user_id = $uid))`;
// Entries to list on their own in the trash: not subtasks deleted with their parent, nor mails deleted with their
// thread (they come back with them). Also for the count in /api/sync.
export const TRASH_ALONE = `(e.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM entries x WHERE x.id = e.parent_id AND x.deleted_at = e.deleted_at))
  AND NOT EXISTS (SELECT 1 FROM mail_threads t WHERE t.id = e.thread_id AND t.deleted_at = e.deleted_at)`;

export const VIS_ANY = `(${sharedWith('entry', 'e')} OR e.assignee_id = $uid
  OR (e.parent_id IS NOT NULL AND EXISTS (SELECT 1 FROM entries pe WHERE pe.id = e.parent_id AND (${sharedWith('entry', 'pe')} OR pe.assignee_id = $uid))))`;
export const PVIS_ANY = sharedWith('project', 'p');
export const CVIS_ANY = sharedWith('contact', 'c');
export const NVIS_ANY = sharedWith('docnote', 'n');
export const VIS = `e.deleted_at IS NULL AND ${VIS_ANY}`;
const PVIS = `p.deleted_at IS NULL AND ${PVIS_ANY}`;

// An entry that is visible and in an area (todo/note or mail) the user can read or write.
export function entryFor(id, user, level = 'write') {
  const e = getEntry(id, user.id);
  assertCan(user, entryArea(e.kind), level);
  return e;
}

export const getEntry = (id, uid) =>
  db.prepare(`SELECT e.* FROM entries e WHERE e.id = $id AND ${VIS}`).get({ id: +id, uid }) || fail(404, 'Entry not found');
const getProject = (id, uid) =>
  db.prepare(`SELECT p.* FROM projects p WHERE p.id = $id AND ${PVIS}`).get({ id: +id, uid }) || fail(404, 'Project not found');
const getItem = id => db.prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL').get(+id) || fail(404, 'Item not found');
const getUser = id => db.prepare('SELECT id, username, name, is_admin FROM users WHERE id = ?').get(+id) || fail(404, 'User not found');
// +user: only current members of the workspace.
const findUser = name => db.prepare('SELECT id FROM users WHERE member = 1 AND (username = $n COLLATE NOCASE OR name = $n COLLATE NOCASE)').get({ n: name });

// ---------- notifications ----------
// Notification titles are [template, placeholders]: notify() translates them into each recipient's language.
const ASSIGNED = { todo: '{actor} assigned you a todo', note: '{actor} assigned you a note', mail: '{actor} assigned you a mail' };
const SHARED = { todo: '{actor} shared a todo with you', note: '{actor} shared a note with you', mail: '{actor} shared a mail with you' };
const actorName = user => user.name || user.username;
const plain = t => String(t || '').replace(/\[\[(\w+):\d+\]\]/g, '…').replace(/(^|\s)#/g, '$1');

// To whoever receives an entry (shared with +person or from the panel, assigned with ++person or from the menu).
function notifyEntry(user, e, ids, assigned = null) {
  const shared = ids.filter(id => id !== assigned);
  const base = { ws: currentWorkspace(), kind: 'mention', body: plain(e.title), url: `#/v/${e.id}`, actor: user.id };
  if (assigned) notify([assigned], { ...base, title: [ASSIGNED[e.kind] || '{actor} assigned you an entry', { actor: actorName(user) }] });
  if (shared.length) notify(shared, { ...base, title: [SHARED[e.kind] || '{actor} shared an entry with you', { actor: actorName(user) }] });
}

// ---------- sharing ----------
export const SHARE_TABLES = { entry: 'entries', project: 'projects', contact: 'contacts', docnote: 'doc_notes' };

// Names written with +person → workspace members (and "all"); unknown ones are returned.
export function shareTargets(names) {
  const out = { ids: [], all: false, unknown: [] };
  for (const n of names) {
    if (n === ALL) { out.all = true; continue; }
    const u = findUser(n);
    if (u) out.ids.push(u.id);
    else out.unknown.push(n);
  }
  return out;
}

// Adds people (and "everyone"): from +person things are only shared, nobody is ever removed.
export function addShares(kind, id, ids, all = false) {
  for (const uid of ids) db.prepare('INSERT OR IGNORE INTO shares (kind, obj_id, user_id) VALUES (?, ?, ?)').run(kind, id, uid);
  if (all) db.prepare(`UPDATE ${SHARE_TABLES[kind]} SET shared_all = 1 WHERE id = ?`).run(id);
}

// Who it is shared with (from the "Visible to" panel): replaces the list. Only its creator changes it.
route('PUT', '/api/shares/:kind/:id', async ({ params, user, body }) => {
  const table = SHARE_TABLES[params.kind] || fail(404, 'Unknown kind');
  const b = await body();
  const o = db.prepare(`SELECT id, created_by FROM ${table} WHERE id = ?`).get(+params.id) || fail(404, 'Not found');
  if (o.created_by !== user.id) fail(403, 'Only its creator decides who to share it with');
  const prev = db.prepare('SELECT user_id FROM shares WHERE kind = ? AND obj_id = ?').all(params.kind, o.id).map(r => r.user_id);
  const ids = (Array.isArray(b.users) ? b.users : []).map(Number)
    .filter(id => id !== user.id && db.prepare('SELECT 1 FROM users WHERE id = ? AND member = 1').get(id));
  tx(() => {
    db.prepare('DELETE FROM shares WHERE kind = ? AND obj_id = ?').run(params.kind, o.id);
    db.prepare(`UPDATE ${table} SET shared_all = ? WHERE id = ?`).run(bool(b.all), o.id);
    addShares(params.kind, o.id, ids);
  });
  // Only to whoever has just been added (not to "everyone": that would notify each person about everything).
  const before = new Set(prev);
  const added = ids.filter(id => !before.has(id));
  if (!added.length) return;
  if (params.kind === 'entry') return notifyEntry(user, db.prepare('SELECT * FROM entries WHERE id = ?').get(o.id), added);
  const what = { project: ['{actor} shared a project with you', 'name', `#/p/${o.id}`], contact: ['{actor} shared a contact with you', 'name', `#/contatti/${o.id}`], docnote: ['{actor} shared a note on a document with you', 'text', null] }[params.kind];
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(o.id);
  notify(added, { ws: currentWorkspace(), kind: 'mention', title: [what[0], { actor: actorName(user) }], body: plain(row[what[1]] || row.email || ''),
    url: what[2] || `#/d/${row.doc_id}?n=${row.id}`, actor: user.id });
});

const fmtDate = d => (d ? `${d.slice(8)}/${d.slice(5, 7)}` : tr('none'));
export const insertId = r => Number(r.lastInsertRowid);

function cleanTag(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\d_-]+/gu, '-').replace(/^[-]+|[-]+$/g, '').slice(0, 32);
}

function uniqueTag(name) {
  const base = cleanTag(name) || 'project';
  for (let i = 1; ; i++) {
    const tag = i === 1 ? base : `${base}-${i}`;
    if (!db.prepare('SELECT 1 FROM projects WHERE tag = ?').get(tag)) return tag;
  }
}

function resolveProject(tag, user) {
  const p = db.prepare(`SELECT p.id, p.deleted_at FROM projects p WHERE p.tag = $tag AND ${PVIS_ANY}`).get({ tag, uid: user.id });
  // Writing the @tag of a project in the trash restores it: that is clearly what is meant.
  if (p?.deleted_at) db.prepare('UPDATE projects SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(p.id);
  if (p) return p.id;
  if (db.prepare('SELECT 1 FROM projects WHERE tag = ?').get(tag)) fail(403, '@{tag} is another user\'s project, not shared with you', { tag });
  // Writing @new creates the project: that needs permission to write projects.
  if (!allows(user.perms, 'progetti', 'write')) fail(403, 'Project @{tag} does not exist and you are not allowed to create projects', { tag });
  const t = now();
  return insertId(db.prepare('INSERT INTO projects (name, tag, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(tag, tag, user.id, t, t));
}

// A code (main or alternative) belongs to one item only: [message, placeholders] of the error if it is taken.
function codeTaken(code, selfId = null) {
  const main = db.prepare('SELECT code, deleted_at FROM items WHERE code = ? AND id IS NOT ?').get(code, selfId);
  if (main) return main.deleted_at ? ['{code} is in the trash: restore it from there', { code: main.code }] : ['Code {code} already exists', { code: main.code }];
  const alias = db.prepare(`SELECT a.code, i.code AS main FROM item_aliases a JOIN items i ON i.id = a.item_id
    WHERE a.code = ? AND a.item_id IS NOT ?`).get(code, selfId);
  return alias ? ['{code} is an alternative code of {main}', { code: alias.code, main: alias.main }] : null;
}

function ensureItem(code, user) {
  // Alternative #CODE: it is the item it belongs to.
  const alias = db.prepare('SELECT item_id FROM item_aliases WHERE code = ?').get(code);
  const it = alias ? db.prepare('SELECT id, deleted_at FROM items WHERE id = ?').get(alias.item_id)
    : db.prepare('SELECT id, deleted_at FROM items WHERE code = ?').get(code);
  if (it?.deleted_at) db.prepare('UPDATE items SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(it.id);
  if (it) return it.id;
  // Unknown #CODE creates the item: only for whoever can write the inventory (for the others it stays text).
  if (!allows(user.perms, 'magazzino', 'write')) return null;
  const t = now();
  return insertId(db.prepare('INSERT INTO items (code, created_by, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(code, user.id, t, t));
}

// Entry↔inventory links come from the text: every #CODE in title, notes or updates.
export function syncEntryItems(entryId, user) {
  const e = db.prepare('SELECT title, notes FROM entries WHERE id = ?').get(entryId);
  const logs = db.prepare('SELECT text FROM entry_log WHERE entry_id = ?').all(entryId);
  const codes = extractCodes([e.title, e.notes, ...logs.map(l => l.text)].join('\n'));
  db.prepare('DELETE FROM entry_items WHERE entry_id = ?').run(entryId);
  const ins = db.prepare('INSERT OR IGNORE INTO entry_items (entry_id, item_id) VALUES (?, ?)');
  for (const c of codes) {
    const id = ensureItem(c, user);
    if (id) ins.run(entryId, id);
  }
  syncEntryLinks(entryId);
}

// mail = a mail conversation (mail_threads): personal, only whoever receives it sees it.
// nota = a note on a document (doc_notes): private to whoever writes it, unless shared.
export const LINK_KINDS = ['doc', 'voce', 'contatto', 'progetto', 'mail', 'nota'];
const REF_RE = /\[\[(doc|voce|contatto|progetto|mail|nota):(\d+)\]\]/g;
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The other links (for backlinks): [[kind:ID]] anywhere in the entry's text and, in mails, inventory codes written
// without # (the autocomplete of the mail text inserts them that way).
export function syncEntryLinks(entryId) {
  const e = db.prepare('SELECT kind, title, notes, mail_subject FROM entries WHERE id = ?').get(entryId);
  const logs = db.prepare('SELECT text FROM entry_log WHERE entry_id = ?').all(entryId).map(l => l.text);
  const text = [e.title, e.notes, e.mail_subject || '', ...logs].join('\n');
  db.prepare('DELETE FROM entry_links WHERE entry_id = ?').run(entryId);
  const link = db.prepare('INSERT OR IGNORE INTO entry_links (entry_id, kind, target_id) VALUES (?, ?, ?)');
  for (const m of text.matchAll(REF_RE)) if (!(m[1] === 'voce' && +m[2] === entryId)) link.run(entryId, m[1], +m[2]);
  if (e.kind !== 'mail') return;
  const body = `${e.notes}\n${e.mail_subject || ''}`;
  for (const it of db.prepare(`SELECT id, code FROM items WHERE deleted_at IS NULL UNION ALL
    SELECT a.item_id, a.code FROM item_aliases a JOIN items i ON i.id = a.item_id WHERE i.deleted_at IS NULL`).all()) {
    if (new RegExp(`(^|[^\\w#])${escRe(it.code)}(?![\\w]|[.\\-/][\\w])`, 'i').test(body)) link.run(entryId, 'articolo', it.id);
  }
}

// First time with the links table: compute them for the entries already there.
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

// ---------- authentication ----------
const attempts = new Map();
export function throttle(key) {
  const a = attempts.get(key);
  if (a && a.n >= 10 && Date.now() - a.t < 15 * 60e3) fail(429, 'Too many attempts, try again in a few minutes');
}
export const clearFailures = key => attempts.delete(key);
export function noteFailure(key) {
  let a = attempts.get(key);
  if (!a || Date.now() - a.t > 15 * 60e3) a = { n: 0, t: Date.now() };
  a.n++;
  attempts.set(key, a);
}

// New session; the active workspace is the last one used (or the one given, e.g. after an invite).
function login(req, res, userId, wsId = defaultWorkspace(userId)) {
  res.setHeader('Set-Cookie', sessionCookie(req, createSession(userId, wsId)));
  if (wsId) acc.prepare('UPDATE users SET last_workspace_id = ? WHERE id = ?').run(wsId, userId);
  return { user: getAccount(userId) };
}

async function newAccount(b) {
  const username = str(b.username, 32);
  if (!validUsername(username)) fail(400, 'Username: 2-32 characters among letters, digits, . _ - (not "all" nor "tutti")');
  if (!validPassword(b.password)) fail(400, 'The password needs at least 8 characters');
  if (acc.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'Username already taken');
  return { username, name: str(b.name, 60) || username, pass: await hashPassword(b.password) };
}

const insertAccount = u => Number(acc.prepare('INSERT INTO users (username, name, pass, created_at) VALUES (?, ?, ?, ?)')
  .run(u.username, u.name, u.pass, now()).lastInsertRowid);

const wsInfo = (wsId, userId) => ({ id: wsId, name: workspaceById(wsId)?.name, role: roleIn(wsId, userId) });

const validInvite = code => acc.prepare(`SELECT i.*, w.name AS workspace_name FROM invites i JOIN workspaces w ON w.id = i.workspace_id
  WHERE i.code = ? AND i.used_at IS NULL AND i.expires_at > ? AND w.deleted_at IS NULL`).get(String(code || '').trim().toUpperCase(), now());

// Uses the invite: the account joins the workspace as a member (if it was not in it already).
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
  if (userCount() > 0) fail(403, 'Setup already done');
  const u = await newAccount(b);
  const id = atx(() => {
    if (userCount() > 0) fail(403, 'Setup already done');
    return insertAccount(u);
  });
  const ws = createWorkspace(str(b.workspace, 80) || tr('Main'), id);
  return login(req, res, id, ws.id);
}, { auth: 'none' });

route('POST', '/api/login', async ({ req, res, body }) => {
  const b = await body();
  const key = `${clientIp(req)}|${String(b.username).toLowerCase()}`;
  throttle(key);
  const u = acc.prepare('SELECT id, pass FROM users WHERE username = ?').get(str(b.username, 32));
  if (!u || !(await verifyPassword(String(b.password || ''), u.pass))) {
    noteFailure(key);
    fail(401, 'Wrong credentials');
  }
  attempts.delete(key);
  // Logging in with an invite code: whoever already has an account also joins the new workspace.
  const inv = b.code && validInvite(b.code);
  if (b.code && !inv) fail(400, 'Invalid or expired invite');
  return login(req, res, u.id, inv ? acceptInvite(inv, u.id).id : undefined);
}, { auth: 'none' });

route('GET', '/api/invites/:code', ({ params }) => {
  const inv = validInvite(params.code) || fail(404, 'Invalid or expired invite');
  return { workspace: inv.workspace_name };
}, { auth: 'none' });

route('POST', '/api/register', async ({ req, res, body }) => {
  const b = await body();
  const key = `${clientIp(req)}|invite`;
  throttle(key);
  if (!validInvite(b.code)) {
    noteFailure(key);
    fail(400, 'Invalid or expired invite');
  }
  const u = await newAccount(b);
  const id = atx(() => insertAccount(u));
  const inv = validInvite(b.code) || fail(400, 'Invalid or expired invite');
  return login(req, res, id, acceptInvite(inv, id).id);
}, { auth: 'none' });

// Invite opened by someone who is already in the app.
route('POST', '/api/invites/:code/accept', ({ req, params, user, token }) => {
  const inv = validInvite(params.code) || fail(400, 'Invalid or expired invite');
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
  if (Array.isArray(b.mailIgnore)) {
    const list = [...new Set(b.mailIgnore.map(x => str(x, 200).trim().toLowerCase()).filter(Boolean))].slice(0, 1000);
    acc.prepare('UPDATE users SET mail_ignore = ? WHERE id = ?').run(JSON.stringify(list), user.id);
  }
  if (b.password !== undefined) {
    const row = acc.prepare('SELECT pass FROM users WHERE id = ?').get(user.id);
    if (!(await verifyPassword(String(b.current || ''), row.pass))) fail(400, 'Wrong current password');
    if (!validPassword(b.password)) fail(400, 'The password needs at least 8 characters');
    acc.prepare('UPDATE users SET pass = ? WHERE id = ?').run(await hashPassword(b.password), user.id);
  }
  return { user: getAccount(user.id) };
}, { ws: false });

route('GET', '/api/events', ({ req, res, user }) => openStream(req, res, user));

// ---------- sync ----------
route('GET', '/api/sync', ({ req, res, user }) => {
  // The chat read marker changes without notifications (it only concerns the reader): it is part of the ETag.
  const chatRead = readKey(user.id);
  const etag = `"${rev()}-${user.id}-${user.workspace_id}-${chatRead}-${user.perms ? Object.values(user.perms).join('') : ''}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, no-cache' });
    return res.end();
  }
  const uid = user.id;
  const p = { uid, cutoff: new Date(Date.now() - ARCHIVE_DAYS * 864e5).toISOString() };
  // Permissions: nothing is sent for areas that cannot be read (entries by kind: todo/note, mail).
  const can = area => allows(user.perms, area);
  const kinds = readableKinds(user).map(k => `'${k}'`).join(', ') || "''";
  // Mails awaiting a reply stay in the data even after 30 days: they are threads still open.
  const where = `${VIS} AND e.kind IN (${kinds}) AND (e.done_at IS NULL OR e.done_at > $cutoff OR e.awaiting_reply = 1)`;
  const all = (area, stmt, ...args) => (can(area) ? db.prepare(stmt).all(...args) : []);
  sendJson(res, 200, {
    perms: user.perms, // null = full access
    // For admins: every member's permissions (Settings → Permissions).
    memberPerms: user.is_admin ? Object.fromEntries(membersOf(user.workspace_id).map(m => [m.id, permsIn(user.workspace_id, m.id)])) : null,
    rev: rev(),
    me: getUser(uid),
    // Everyone who appears in the data (former members too, for names); member = 1 for current members.
    users: db.prepare('SELECT id, username, name, is_admin, member FROM users ORDER BY name COLLATE NOCASE').all(),
    workspace: wsInfo(user.workspace_id, uid),
    workspaces: workspacesOf(uid),
    projects: all('progetti', `SELECT p.* FROM projects p WHERE ${PVIS} ORDER BY p.name COLLATE NOCASE`, { uid }),
    entries: db.prepare(`SELECT e.* FROM entries e WHERE ${where} ORDER BY e.id`).all(p),
    logs: db.prepare(`SELECT l.* FROM entry_log l JOIN entries e ON e.id = l.entry_id WHERE ${where} ORDER BY l.id`).all(p),
    entryItems: all('magazzino', `SELECT ei.entry_id, ei.item_id FROM entry_items ei JOIN entries e ON e.id = ei.entry_id WHERE ${where}`, p),
    items: all('magazzino', 'SELECT * FROM items WHERE deleted_at IS NULL ORDER BY code COLLATE NOCASE'),
    itemAliases: all('magazzino', `SELECT a.item_id, a.code FROM item_aliases a JOIN items i ON i.id = a.item_id
      WHERE i.deleted_at IS NULL ORDER BY a.code COLLATE NOCASE`),
    itemLinks: all('magazzino', 'SELECT parent_id, child_id FROM item_links'),
    entryProjects: all('progetti', `SELECT ep.entry_id, ep.project_id FROM entry_projects ep
      JOIN entries e ON e.id = ep.entry_id JOIN projects p ON p.id = ep.project_id
      WHERE ${where} AND p.deleted_at IS NULL AND ${PVIS_ANY}`, p),
    projectItems: can('magazzino') ? all('progetti', `SELECT pi.project_id, pi.item_id FROM project_items pi
      JOIN projects p ON p.id = pi.project_id WHERE ${PVIS}`, { uid }) : [],
    docs: all('documenti', `SELECT id, item_id, kind, label, version, filename, mime, size, sha256, url, created_by, created_at
      FROM documents WHERE deleted_at IS NULL ORDER BY created_at DESC`),
    contacts: all('contatti', `SELECT c.* FROM contacts c WHERE c.deleted_at IS NULL AND ${CVIS_ANY} ORDER BY c.name COLLATE NOCASE, c.email`, { uid }),
    categoryColors: all('magazzino', 'SELECT name, hue FROM category_colors'),
    docKinds: docKinds(),
    customDocKinds: db.prepare('SELECT name FROM doc_kinds ORDER BY name').all().map(r => r.name),
    docNotes: all('documenti', `SELECT n.* FROM doc_notes n JOIN documents d ON d.id = n.doc_id
      WHERE n.deleted_at IS NULL AND d.deleted_at IS NULL AND ${NVIS_ANY} ORDER BY n.id`, { uid }),
    // Who what you see is shared with (for "Visible to"): entries, projects, contacts, notes on documents.
    shares: db.prepare(`SELECT s.kind, s.obj_id, s.user_id FROM shares s WHERE
      (s.kind = 'entry' AND s.obj_id IN (SELECT e.id FROM entries e WHERE ${where}))
      OR (s.kind = 'project' AND s.obj_id IN (SELECT p.id FROM projects p WHERE ${PVIS}))
      OR (s.kind = 'contact' AND s.obj_id IN (SELECT c.id FROM contacts c WHERE c.deleted_at IS NULL AND ${CVIS_ANY}))
      OR (s.kind = 'docnote' AND s.obj_id IN (SELECT n.id FROM doc_notes n WHERE n.deleted_at IS NULL AND ${NVIS_ANY}))`).all(p),
    attachments: db.prepare(`SELECT a.id, a.entry_id, a.doc_id, a.filename, a.mime, a.size FROM mail_attachments a
      JOIN entries e ON e.id = a.entry_id WHERE ${where} ORDER BY a.id`).all(p),
    // Mail with Thunderbird: whether the extension is connected, and the conversations' messages (without the text).
    mailExt: mailExtOn(uid),
    mailExtVersion: mailExtVersion(uid),
    myAddresses: mailAddressesOf(uid),
    mailIgnore: mailIgnoreOf(uid), // "to save" contacts not to suggest (addresses or parts)
    feedbackOpen: openFeedback(uid), // null = does not handle feedback
    ...tourInfo(uid), // onboarded (tour invitation already seen), tourWs (demo workspace)
    ...notificationsOf(uid), // notifications (of every workspace), unread ones, devices with push
    // Mail threads (personal): the threads, their messages without the full text, the links.
    ...(can('mail') ? threadsSync(uid) : { mailTopics: [], topicLinks: [], mailThreads: [], mailMsgs: [], threadLinks: [] }),
    // Chat: the channels one can read (all of them, for whoever manages them), the last messages of each, unread ones.
    ...(can('chat') ? chatSync(user) : { chatChannels: [], chat: [], chatUnread: 0, canManageChannels: false }),
    // In the trash only the areas one can read count.
    trashCount: [
      `SELECT COUNT(*) AS n FROM entries e WHERE e.deleted_at IS NOT NULL AND ${VIS_ANY} AND e.kind IN (${kinds}) AND ${TRASH_ALONE}`,
      can('mail') && 'SELECT COUNT(*) AS n FROM mail_threads WHERE owner_id = $uid AND deleted_at IS NOT NULL',
      can('progetti') && `SELECT COUNT(*) AS n FROM projects p WHERE p.deleted_at IS NOT NULL AND ${PVIS_ANY}`,
      can('magazzino') && 'SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NOT NULL',
      can('documenti') && `SELECT COUNT(*) AS n FROM documents d WHERE d.deleted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM items i WHERE i.id = d.item_id AND i.deleted_at IS NULL)`,
      can('contatti') && `SELECT COUNT(*) AS n FROM contacts c WHERE c.deleted_at IS NOT NULL AND ${CVIS_ANY}`,
      can('documenti') && `SELECT COUNT(*) AS n FROM doc_notes n WHERE n.deleted_at IS NOT NULL AND ${NVIS_ANY}
        AND EXISTS (SELECT 1 FROM documents d WHERE d.id = n.doc_id AND d.deleted_at IS NULL)`,
    ].filter(Boolean).reduce((sum, q) => sum + db.prepare(q).get(q.includes('$uid') ? { uid } : {}).n, 0),
  }, { ETag: etag });
});

route('GET', '/api/archive', ({ user, query }) => {
  const q = `%${str(query.q, 200)}%`;
  const cutoff = new Date(Date.now() - ARCHIVE_DAYS * 864e5).toISOString();
  const kinds = readableKinds(user).map(k => `'${k}'`).join(', ') || "''";
  return db.prepare(`SELECT e.* FROM entries e WHERE ${VIS} AND e.kind IN (${kinds}) AND e.done_at IS NOT NULL AND e.done_at <= $cutoff
    AND (e.title LIKE $q OR e.notes LIKE $q OR e.contact LIKE $q) ORDER BY e.done_at DESC LIMIT 200`)
    .all({ uid: user.id, cutoff, q });
});

// ---------- entries (todo / mail / note) ----------
// ">marco" becomes the email of the address-book contact with that name (if there is only one).
function resolveContact(s, user) {
  if (s.includes('@')) return s;
  const name = s.replace(/[._]/g, ' ');
  const exact = db.prepare(`SELECT email FROM contacts c WHERE c.deleted_at IS NULL AND c.email != '' AND c.name = $name COLLATE NOCASE AND ${CVIS_ANY}`)
    .all({ name, uid: user.id });
  if (exact.length === 1) return exact[0].email;
  const prefix = db.prepare(`SELECT email FROM contacts c WHERE c.deleted_at IS NULL AND c.email != '' AND c.name LIKE $like ESCAPE '\\' AND ${CVIS_ANY}`)
    .all({ like: `${name.replace(/[%_\\]/g, '\\$&')}%`, uid: user.id });
  return prefix.length === 1 ? prefix[0].email : s;
}

export function createEntry(b, user) {
  // Entry created offline that has already arrived (sending was repeated): return that one.
  const clientId = b.client_id ? str(b.client_id, 64) : null;
  const seen = clientId && db.prepare('SELECT id FROM entries WHERE created_by = ? AND client_id = ?').get(user.id, clientId);
  if (seen) return seen.id;
  const base = isYmd(b.today) ? b.today : today();
  const p = parseQuick(str(b.text, 1000), { today: base, kind: KINDS.includes(b.kind) ? b.kind : 'todo' });
  if (!p.title) fail(400, 'Write at least a few words');

  let parent = b.parent_id ? getEntry(b.parent_id, user.id) : null;
  if (parent?.parent_id) parent = getEntry(parent.parent_id, user.id); // a single level of subtasks
  const kind = p.kindExplicit || !parent ? p.kind : 'todo';
  assertCan(user, entryArea(kind), 'write');

  // All the projects: those written with @ (the first becomes the main one) plus the page's one.
  const projectIds = [...new Set([
    ...p.projects.map(tag => resolveProject(tag, user)),
    ...(b.project_id ? [getProject(b.project_id, user.id).id] : []),
  ])];
  const projectId = projectIds[0] ?? parent?.project_id ?? null;

  let title = p.title;
  let assigneeId = b.assignee_id ? getUser(b.assignee_id).id : null;
  const contact = p.contact ? resolveContact(p.contact, user) : null;
  // +person shares, ++person shares and assigns, +all shares with everyone; unknown names stay in the title.
  const sh = shareTargets(p.shares);
  if (p.assignee) {
    const u = findUser(p.assignee);
    if (u) assigneeId = u.id;
  }
  if (sh.unknown.length) title += sh.unknown.map(n => ` +${n}`).join('');

  const t = now();
  // done: a todo marked done while offline arrives already done (at its time).
  const doneAt = b.done ? (typeof b.done === 'string' && !Number.isNaN(Date.parse(b.done)) ? new Date(b.done).toISOString() : t) : null;
  const id = insertId(db.prepare(`INSERT INTO entries
    (kind, title, contact, due, project_id, parent_id, assignee_id, created_by, created_at, updated_at, client_id, done_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(kind, title, contact, p.due ?? null, projectId, parent?.id ?? null, assigneeId, user.id, t, t, clientId, kind === 'note' ? null : doneAt));
  addShares('entry', id, sh.ids.filter(x => x !== user.id), p.shareAll || bool(b.shared_all));
  notifyEntry(user, { id, kind, title }, sh.ids, assigneeId);
  for (const pid of projectIds.slice(1)) addEntryProject(id, pid);
  if (kind === 'mail') autoLink(ensureEntryThread({ id, kind, title, created_by: user.id }), user.id, title); // every mail is in a thread
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
    // The title accepts the same tokens as the quick line: "!fri" while editing moves the due date.
    const p = parseQuick(str(b.title, 1000), { today: base, kind: e.kind });
    if (!p.title) fail(400, 'The title cannot be empty');
    f.title = p.title;
    if (p.kindExplicit) f.kind = p.kind;
    if (p.due !== undefined) f.due = p.due;
    // @project in the title adds the project (does not remove the others); if there is no main one, it becomes it.
    for (const tag of p.projects) {
      const pid = resolveProject(tag, user);
      if (!e.project_id && f.project_id === undefined) f.project_id = pid;
      else if (pid !== (f.project_id ?? e.project_id)) addEntryProject(e.id, pid);
    }
    if (p.contact) f.contact = resolveContact(p.contact, user);
    // +person / ++person / +all in the title add shares (they never remove any): only the entry's creator.
    const sh = shareTargets(p.shares);
    if (p.assignee) {
      const u = findUser(p.assignee);
      if (u) f.assignee_id = u.id;
    }
    if (sh.unknown.length) f.title += sh.unknown.map(n => ` +${n}`).join('');
    if (sh.ids.length || p.shareAll) {
      if (e.created_by !== user.id) fail(403, 'Only the entry\'s creator decides who to share it with');
      const had = new Set(db.prepare("SELECT user_id FROM shares WHERE kind = 'entry' AND obj_id = ?").all(e.id).map(r => r.user_id));
      addShares('entry', e.id, sh.ids.filter(x => x !== user.id), p.shareAll);
      notifyEntry(user, { ...e, title: f.title ?? e.title }, sh.ids.filter(x => !had.has(x)));
    }
  }
  if (b.notes !== undefined) f.notes = str(b.notes, 20000);
  if (b.kind !== undefined) {
    if (!KINDS.includes(b.kind)) fail(400, 'Invalid kind');
    f.kind = b.kind;
  }
  if (b.due !== undefined) {
    // Besides YYYY-MM-DD, the quick-bar dates: "fri", "3d", "25/11", "no" (= none).
    const due = b.due === null || isYmd(b.due) ? b.due : parseDate(str(b.due, 30).replace(/^!/, ''), base, { past: (f.kind ?? e.kind) === 'note' });
    if (due === undefined) fail(400, 'Invalid date');
    f.due = due;
  }
  if (b.contact !== undefined) f.contact = str(b.contact, 1000) || null;
  if (b.mail_cc !== undefined) f.mail_cc = str(b.mail_cc, 1000) || null;
  if (b.mail_subject !== undefined) f.mail_subject = str(b.mail_subject, 300) || null;
  if (b.project_id !== undefined) f.project_id = b.project_id ? getProject(b.project_id, user.id).id : null;
  if (b.assignee_id !== undefined) f.assignee_id = b.assignee_id ? getUser(b.assignee_id).id : null;
  if (b.done !== undefined) {
    f.done_at = b.done ? e.done_at || now() : null;
    // A sent mail awaits a reply (until someone says it arrived or is not needed); reopened, it does not.
    if ((f.kind ?? e.kind) === 'mail') f.awaiting_reply = b.done ? (e.done_at ? e.awaiting_reply : 1) : 0;
  }
  if (b.awaiting !== undefined) {
    f.awaiting_reply = bool(b.awaiting);
    if (e.awaiting_reply && !b.awaiting && e.done_at) addLog(e.id, user.id, tr('reply received'), true);
  }
  if (b.pinned !== undefined) f.pinned = bool(b.pinned);
  if (!Object.keys(f).length) return;
  // Permissions: writing in the entry's area and, if the kind changes (todo ↔ mail), in the new one too.
  assertCan(user, entryArea(e.kind), 'write');
  if (f.kind && f.kind !== e.kind) assertCan(user, entryArea(f.kind), 'write');
  f.updated_at = now();
  setFields('entries', e.id, f);

  if (f.project_id !== undefined) db.prepare('UPDATE entries SET project_id = ? WHERE parent_id = ?').run(f.project_id, e.id);
  // Mails written here are in a thread; the codes and projects they mention become its links.
  if ((f.kind || e.kind) === 'mail') {
    const m = { ...e, ...f };
    const tid = ensureEntryThread(m);
    // While the conversation is only this draft, it takes its subject (or the title).
    if (f.title !== undefined || f.mail_subject !== undefined) {
      const alone = !db.prepare('SELECT 1 FROM mail_messages WHERE thread_id = ?').get(tid)
        && !db.prepare('SELECT 1 FROM entries WHERE thread_id = ? AND id != ? AND deleted_at IS NULL').get(tid, e.id);
      const subject = cleanSubject(m.mail_subject || m.title).slice(0, 300);
      if (alone && subject) db.prepare('UPDATE mail_threads SET subject = ? WHERE id = ?').run(subject, tid);
    }
    if (f.kind || f.notes !== undefined || f.mail_subject !== undefined || f.title !== undefined) autoLink(tid, user.id, `${m.title} ${m.mail_subject || ''} ${m.notes || ''}`);
  }
  // Assigned to someone else (with ++person or from the Assigned menu): tell them.
  if (f.assignee_id && f.assignee_id !== e.assignee_id) notifyEntry(user, { ...e, ...f }, [], f.assignee_id);
  if (e.due && f.due !== undefined && f.due !== e.due) addLog(e.id, user.id, tr('due date {from} → {to}', { from: fmtDate(e.due), to: fmtDate(f.due) }), true);
  if (f.title !== undefined || f.notes !== undefined) syncEntryItems(e.id, user);
  else if (f.mail_subject !== undefined || f.kind !== undefined) syncEntryLinks(e.id);
}

route('POST', '/api/entries', async ({ user, body }) => {
  const b = await body();
  return { id: tx(() => createEntry(b, user)) };
});

// An entry with everything around it (for the CLI and external programs: the app uses /api/sync).
// Works for archived entries too, which /api/sync no longer sends.
route('GET', '/api/entries/:id', ({ params, user }) => {
  const e = entryFor(params.id, user, 'read');
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

// Backlinks: the entries (archived ones too) that link to something. For an item also #CODE and the codes in
// mails, for a document also attachments, for a contact also the mails sent to their address.
// [[kind:ID]] links the app does not have in its data: archived (with the title, if they can be seen), not shared
// with the reader (only that is said, without content) or deleted.
route('POST', '/api/refs', async ({ user, body }) => {
  const b = await body();
  const uid = user.id;
  const out = {};
  for (const [kind, raw] of (Array.isArray(b.refs) ? b.refs : []).slice(0, 200)) {
    const id = +raw;
    const key = `${kind}:${id}`;
    if (kind === 'voce') {
      const e = db.prepare('SELECT id, kind, title, done_at, deleted_at FROM entries WHERE id = ?').get(id);
      if (!e || e.deleted_at) out[key] = { status: 'gone' };
      else if (db.prepare(`SELECT 1 FROM entries e WHERE e.id = $id AND ${VIS}`).get({ id, uid }) && allows(user.perms, entryArea(e.kind))) {
        out[key] = { status: 'ok', kind: e.kind, title: e.title, done: !!e.done_at };
      } else out[key] = { status: 'hidden' };
    } else if (kind === 'progetto' || kind === 'contatto') {
      const [table, a, vis, area] = kind === 'progetto' ? ['projects', 'p', PVIS_ANY, 'progetti'] : ['contacts', 'c', CVIS_ANY, 'contatti'];
      const o = db.prepare(`SELECT id, deleted_at FROM ${table} WHERE id = ?`).get(id);
      if (!o || o.deleted_at) out[key] = { status: 'gone' };
      else out[key] = { status: db.prepare(`SELECT 1 FROM ${table} ${a} WHERE ${a}.id = $id AND ${vis}`).get({ id, uid }) && allows(user.perms, area) ? 'ok' : 'hidden' };
    } else if (kind === 'doc') {
      const d = db.prepare('SELECT deleted_at FROM documents WHERE id = ?').get(id);
      out[key] = { status: !d || d.deleted_at ? 'gone' : allows(user.perms, 'documenti') ? 'ok' : 'hidden' };
    } else if (kind === 'mail') {
      const t = db.prepare('SELECT owner_id, topic_id, subject, deleted_at FROM mail_threads WHERE id = ?').get(id);
      if (!t || t.deleted_at) out[key] = { status: 'gone' };
      else out[key] = t.owner_id === uid && allows(user.perms, 'mail') ? { status: 'ok', title: t.subject, topic: t.topic_id } : { status: 'hidden' };
    } else if (kind === 'nota') {
      const n = db.prepare(`SELECT n.id, n.doc_id, n.text, n.resolved_at, n.deleted_at, d.deleted_at AS doc_deleted
        FROM doc_notes n JOIN documents d ON d.id = n.doc_id WHERE n.id = ?`).get(id);
      if (!n || n.deleted_at || n.doc_deleted) out[key] = { status: 'gone' };
      else if (db.prepare(`SELECT 1 FROM doc_notes n WHERE n.id = $id AND ${NVIS_ANY}`).get({ id, uid }) && allows(user.perms, 'documenti')) {
        out[key] = { status: 'ok', title: n.text, doc: n.doc_id, done: !!n.resolved_at };
      } else out[key] = { status: 'hidden' };
    }
  }
  return out;
}, { quiet: true });

route('GET', '/api/backlinks/:kind/:id', ({ params, user }) => {
  const { kind } = params;
  const id = +params.id;
  if (![...LINK_KINDS, 'articolo'].includes(kind)) fail(404, 'Unknown kind');
  const ids = db.prepare('SELECT entry_id AS id FROM entry_links WHERE kind = ? AND target_id = ?').all(kind, id).map(r => r.id);
  if (kind === 'articolo') ids.push(...db.prepare('SELECT entry_id AS id FROM entry_items WHERE item_id = ?').all(id).map(r => r.id));
  if (kind === 'doc') ids.push(...db.prepare('SELECT entry_id AS id FROM mail_attachments WHERE doc_id = ?').all(id).map(r => r.id));
  if (kind === 'contatto') {
    const email = db.prepare(`SELECT email FROM contacts c WHERE c.id = $id AND c.email != '' AND ${CVIS_ANY}`).get({ id, uid: user.id })?.email;
    if (email) {
      ids.push(...db.prepare(`SELECT id FROM entries WHERE kind = 'mail' AND (',' || REPLACE(LOWER(contact), ' ', '') || ',') LIKE ?`)
        .all(`%,${email.toLowerCase()},%`).map(r => r.id));
    }
  }
  return db.prepare(`SELECT e.id, e.kind, e.title, e.due, e.done_at, e.awaiting_reply, e.contact, e.mail_subject, e.project_id, e.parent_id, e.updated_at
    FROM entries e WHERE e.id IN (SELECT value FROM json_each($ids)) AND ${VIS}
    AND e.kind IN (SELECT value FROM json_each($kinds)) ORDER BY e.updated_at DESC`)
    .all({ ids: JSON.stringify([...new Set(ids)]), kinds: JSON.stringify(readableKinds(user)), uid: user.id });
});

route('PATCH', '/api/entries/:id', async ({ params, user, body }) => {
  const b = await body();
  tx(() => updateEntry(getEntry(params.id, user.id), b, user));
});

// Deleting = moving to the trash. Subtasks follow the entry with the same instant, so restoring brings back exactly
// what was deleted together.
// An entry's projects: the first one added becomes the main one; removing the main one promotes the next.
route('POST', '/api/entries/:id/projects', async ({ params, user, body }) => {
  const b = await body();
  const e = entryFor(params.id, user);
  const pid = getProject(b.project_id, user.id).id;
  tx(() => {
    if (!e.project_id) {
      db.prepare('UPDATE entries SET project_id = ?, updated_at = ? WHERE id = ?').run(pid, now(), e.id);
      db.prepare('UPDATE entries SET project_id = ? WHERE parent_id = ?').run(pid, e.id);
    } else if (pid !== e.project_id) addEntryProject(e.id, pid);
  });
});

route('DELETE', '/api/entries/:id/projects/:pid', ({ params, user }) => {
  const e = entryFor(params.id, user);
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
  const e = entryFor(params.id, user);
  db.prepare('UPDATE entries SET deleted_at = $t, deleted_by = $u WHERE (id = $id OR parent_id = $id) AND deleted_at IS NULL')
    .run({ t: now(), u: user.id, id: e.id });
});

// Update: a line telling what was found out. Accepts !date and +user to change the entry.
route('POST', '/api/entries/:id/log', async ({ params, user, body }) => {
  const b = await body();
  tx(() => {
    const e = entryFor(params.id, user);
    const p = parseQuick(str(b.text, 4000), { today: isYmd(b.today) ? b.today : today(), kind: e.kind });
    const patch = { today: b.today };
    if (p.due !== undefined) patch.due = p.due;
    if (p.assignee) {
      const u = findUser(p.assignee);
      if (u) patch.assignee_id = u.id;
    }
    // +person in an update mentions them: it stays in the text, they get a notification and, if the entry is yours, they see it.
    const sh = shareTargets(p.shares);
    const text = [p.title, ...p.shares.filter(n => n !== p.assignee).map(n => `+${n}`)].filter(Boolean).join(' ');
    if (!text && Object.keys(patch).length === 1) fail(400, 'Write something');
    if (sh.ids.length && e.created_by === user.id) addShares('entry', e.id, sh.ids.filter(x => x !== user.id));
    updateEntry(e, patch, user);
    if (text) addLog(e.id, user.id, text);
    const canSee = uid => db.prepare(`SELECT 1 FROM entries e WHERE e.id = $id AND ${VIS}`).get({ id: e.id, uid });
    const cited = sh.ids.filter(uid => uid !== patch.assignee_id && canSee(uid));
    if (cited.length) notify(cited, { ws: currentWorkspace(), kind: 'mention', title: ['{actor} mentioned you in an update', { actor: actorName(user) }], body: `${plain(e.title)}: ${plain(text)}`, url: `#/v/${e.id}`, actor: user.id });
    db.prepare('UPDATE entries SET updated_at = ? WHERE id = ?').run(now(), e.id);
    syncEntryItems(e.id, user);
  });
});

route('DELETE', '/api/logs/:id', ({ params, user }) => {
  const l = db.prepare('SELECT * FROM entry_log WHERE id = ?').get(+params.id) || fail(404, 'Update not found');
  entryFor(l.entry_id, user);
  if (l.user_id !== user.id && !user.is_admin) fail(403, 'You can only delete your own updates');
  tx(() => {
    db.prepare('DELETE FROM entry_log WHERE id = ?').run(l.id);
    syncEntryItems(l.entry_id, user);
  });
});

// ---------- projects ----------
route('POST', '/api/projects', async ({ user, body }) => {
  const b = await body();
  const name = str(b.name, 100);
  if (!name) fail(400, 'The name is required');
  const tag = b.tag ? cleanTag(b.tag) : uniqueTag(name);
  if (!tag) fail(400, 'Invalid tag');
  const clash = db.prepare('SELECT deleted_at FROM projects WHERE tag = ?').get(tag);
  if (clash) fail(409, clash.deleted_at ? '@{tag} is in the trash: restore it from there' : 'A project @{tag} already exists', { tag });
  const parentId = b.parent_id ? getProject(b.parent_id, user.id).id : null;
  // Private to its creator; share: the names written with +person (and "all") in the projects bar.
  const sh = shareTargets(Array.isArray(b.share) ? b.share.map(x => str(x, 64)) : []);
  if (sh.unknown.length) fail(400, 'There is nobody called {names} in this workspace', { names: sh.unknown.map(n => `+${n}`).join(', ') });
  const t = now();
  const id = insertId(db.prepare('INSERT INTO projects (name, tag, parent_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, tag, parentId, user.id, t, t));
  addShares('project', id, sh.ids.filter(x => x !== user.id), sh.all);
  return { id, tag };
}, { area: 'progetti' });

// Colour picked by hand: hue 0..359, or null to go back to the automatic colour.
function checkHue(v) {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 359) fail(400, 'Invalid colour');
  return n;
}

route('PUT', '/api/categories/color', async ({ body }) => {
  const b = await body();
  const name = str(b.name, 60) || fail(400, 'Missing category');
  const hue = checkHue(b.hue);
  if (hue === null) db.prepare('DELETE FROM category_colors WHERE name = ?').run(name);
  else db.prepare('INSERT INTO category_colors (name, hue) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET hue = excluded.hue').run(name, hue);
}, { area: 'magazzino' });

// A project cannot end up inside itself or inside one of its descendants.
function checkParent(p, parentId) {
  for (let id = parentId, depth = 0; id; depth++) {
    if (id === p.id || depth > 50) fail(400, 'A project cannot be inside itself or one of its subprojects');
    id = db.prepare('SELECT parent_id FROM projects WHERE id = ?').get(id)?.parent_id;
  }
}

route('PATCH', '/api/projects/:id', async ({ params, user, body }) => {
  const b = await body();
  const p = getProject(params.id, user.id);
  const f = {};
  if (b.name !== undefined) f.name = str(b.name, 100) || fail(400, 'The name is required');
  if (b.tag !== undefined) {
    f.tag = cleanTag(b.tag) || fail(400, 'Invalid tag');
    if (db.prepare('SELECT 1 FROM projects WHERE tag = ? AND id != ?').get(f.tag, p.id)) fail(409, 'A project @{tag} already exists', { tag: f.tag });
  }
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) fail(400, 'Invalid status');
    f.status = b.status;
  }
  if (b.notes !== undefined) f.notes = str(b.notes, 20000);
  if (b.hue !== undefined) f.hue = checkHue(b.hue);
  if (b.parent_id !== undefined) {
    f.parent_id = b.parent_id ? getProject(b.parent_id, user.id).id : null;
    checkParent(p, f.parent_id);
  }
  f.updated_at = now();
  setFields('projects', p.id, f);
}, { area: 'progetti' });

// Inventory items linked to the project by hand (besides those mentioned with #CODE in entries).
route('POST', '/api/projects/:id/items', async ({ params, user, body }) => {
  const b = await body();
  const p = getProject(params.id, user.id);
  const code = checkCode(str(b.code, 64).replace(/^#/, ''));
  return tx(() => {
    const itemId = ensureItem(code, user) ?? fail(403, 'Item {code} does not exist and you are not allowed to create it', { code });
    db.prepare('INSERT OR IGNORE INTO project_items (project_id, item_id, created_at) VALUES (?, ?, ?)').run(p.id, itemId, now());
    return { item_id: itemId };
  });
}, { area: 'progetti' });

route('DELETE', '/api/projects/:id/items/:item', ({ params, user }) => {
  const p = getProject(params.id, user.id);
  db.prepare('DELETE FROM project_items WHERE project_id = ? AND item_id = ?').run(p.id, +params.item);
}, { area: 'progetti' });

route('DELETE', '/api/projects/:id', ({ params, user }) => {
  const p = getProject(params.id, user.id);
  if (p.created_by !== user.id && !user.is_admin) fail(403, 'Only the project\'s creator (or an admin) can delete it');
  db.prepare('UPDATE projects SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), user.id, p.id);
}, { area: 'progetti' });

// ---------- inventory ----------
function itemFields(b) {
  const f = {};
  for (const [k, max] of Object.entries({ name: 200, category: 60, firmware: 100, location: 100, notes: 20000, url: 2000 })) {
    if (b[k] !== undefined) f[k] = str(b[k], max);
  }
  if (f.url && !/^https?:\/\//i.test(f.url)) f.url = `https://${f.url}`;
  if (b.status !== undefined) {
    if (!['', 'evaluation', 'outdated', 'discarded'].includes(b.status)) fail(400, 'Invalid status');
    f.status = b.status;
  }
  if (b.qty !== undefined) {
    if (b.qty === null || b.qty === '') f.qty = null;
    else if (Number.isInteger(+b.qty)) f.qty = +b.qty;
    else fail(400, 'Invalid quantity');
  }
  return f;
}

function checkCode(code) {
  if (!CODE_OK.test(code)) fail(400, 'Code: letters, digits and . _ - / (must start and end with a letter or digit)');
  return code;
}

route('POST', '/api/items', async ({ user, body }) => {
  const b = await body();
  const code = checkCode(str(b.code, 64));
  const taken = codeTaken(code);
  if (taken) fail(409, ...taken);
  const projectId = b.project_id ? getProject(b.project_id, user.id).id : null;
  const t = now();
  return tx(() => {
    const id = insertId(db.prepare('INSERT INTO items (code, created_by, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(code, user.id, t, t));
    setFields('items', id, itemFields(b));
    if (projectId) db.prepare('INSERT INTO project_items (project_id, item_id, created_at) VALUES (?, ?, ?)').run(projectId, id, t);
    relinkItem(id); // active mails that already mentioned it are now linked to it
    return { id };
  });
}, { area: 'magazzino' });

route('PATCH', '/api/items/:id', async ({ params, body }) => {
  const b = await body();
  const it = getItem(params.id);
  const f = itemFields(b);
  tx(() => {
    if (b.code !== undefined && b.code !== it.code) {
      f.code = checkCode(str(b.code, 64));
      const taken = codeTaken(f.code, it.id);
      if (taken) fail(409, ...taken);
      // An alternative code becomes the main one: the previous one stays among the alternatives.
      if (db.prepare('DELETE FROM item_aliases WHERE code = ? AND item_id = ?').run(f.code, it.id).changes
        && f.code.toLowerCase() !== it.code.toLowerCase()) {
        db.prepare('INSERT INTO item_aliases (code, item_id, created_at) VALUES (?, ?, ?)').run(it.code, it.id, now());
      }
      renameCodeInEntries(it, f.code);
    }
    f.updated_at = now();
    setFields('items', it.id, f);
    if (f.code) relinkItem(it.id); // new code: active mails are checked again (linked or unlinked)
  });
}, { area: 'magazzino' });

// Renaming a code also updates the #references in the text of the linked entries.
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
}, { area: 'magazzino' });

// Alternative codes: added and removed; in texts #ALTERNATIVE leads to the item.
route('POST', '/api/items/:id/aliases', async ({ params, user, body }) => {
  const it = getItem(params.id);
  const code = checkCode(str((await body()).code, 64).replace(/^#/, ''));
  if (code.toLowerCase() === it.code.toLowerCase()) fail(400, 'It is already the main code');
  const taken = codeTaken(code, it.id);
  if (taken) fail(409, ...taken);
  tx(() => {
    db.prepare('INSERT OR IGNORE INTO item_aliases (code, item_id, created_at) VALUES (?, ?, ?)').run(code, it.id, now());
    // The entries that already mentioned it (#CODE) are now linked to the item.
    const q = `%#${code.replace(/[%_\\]/g, '\\$&')}%`;
    const ids = db.prepare(`SELECT DISTINCT e.id FROM entries e LEFT JOIN entry_log l ON l.entry_id = e.id
      WHERE e.title LIKE $q ESCAPE '\\' OR e.notes LIKE $q ESCAPE '\\' OR l.text LIKE $q ESCAPE '\\'`).all({ q });
    for (const { id } of ids) syncEntryItems(id, user);
    relinkItem(it.id); // and the active mail conversations that mention it
  });
}, { area: 'magazzino' });

route('DELETE', '/api/items/:id/aliases/:code', ({ params }) => {
  const it = getItem(params.id);
  if (!db.prepare('DELETE FROM item_aliases WHERE code = ? AND item_id = ?').run(params.code, it.id).changes) fail(404, 'Alternative code not found');
  relinkItem(it.id); // mails that mentioned it only with that code are no longer linked (if it was automatic)
}, { area: 'magazzino' });

route('POST', '/api/items/:id/children', async ({ params, user, body }) => {
  const b = await body();
  const it = getItem(params.id);
  const code = checkCode(str(b.code, 64).replace(/^#/, ''));
  tx(() => {
    const childId = ensureItem(code, user);
    if (childId === it.id) fail(400, 'An item cannot contain itself');
    db.prepare('INSERT OR IGNORE INTO item_links (parent_id, child_id) VALUES (?, ?)').run(it.id, childId);
  });
}, { area: 'magazzino' });

route('DELETE', '/api/items/:id/children/:child', ({ params }) => {
  db.prepare('DELETE FROM item_links WHERE parent_id = ? AND child_id = ?').run(+params.id, +params.child);
}, { area: 'magazzino' });

// ---------- documents ----------
// Saves the request body (the raw file) in uploads/ under a random name.
export async function saveUpload(req) {
  if (+req.headers['content-length'] > MAX_UPLOAD) fail(413, 'File too large (max {mb} MB)', { mb: MAX_UPLOAD >> 20 });
  const stored = crypto.randomBytes(16).toString('hex');
  const dest = path.join(UPLOAD_DIR, stored);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_UPLOAD) return cb(new HttpError(413, 'File too large (max {mb} MB)', { mb: MAX_UPLOAD >> 20 }));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, meter, fs.createWriteStream(dest));
    if (!size) fail(400, 'Empty file');
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
  return { stored, size, sha256: hash.digest('hex'), mime: str(req.headers['content-type'], 100) || 'application/octet-stream' };
}

// Upload: the request body is the raw file, the metadata are in the query string (?name= always).
// Without ?name= and with a JSON body an external link is registered instead (repo, wiki, drive...): an uploaded
// .json file has a JSON Content-Type but also a name, so it stays a file.
export const isJsonRequest = (req, query) => !query.name && (req.headers['content-type'] || '').startsWith('application/json');

route('POST', '/api/items/:id/docs', async ({ req, params, query, user, body }) => {
  const it = getItem(params.id);
  const kind = docKind(query.kind);
  const t = now();

  if (isJsonRequest(req, query)) {
    const b = await body();
    const url = str(b.url, 2000);
    if (!/^https?:\/\//i.test(url)) fail(400, 'The link must start with http:// or https://');
    const k = docKind(b.kind);
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
}, { area: 'documenti' });

// When downloaded, the file gets the name given in the app, always with the original file's extension: renaming
// "datasheet.pdf" to "datasheet" (or to "datasheet.") still downloads "datasheet.pdf". The extension comes from the
// original name (also double ones like .tar.gz); a file uploaded without one takes it from its type.
const MIME_EXT = {
  'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/svg+xml': '.svg', 'text/plain': '.txt', 'text/csv': '.csv', 'text/tab-separated-values': '.tsv',
  'text/html': '.html', 'text/markdown': '.md', 'application/json': '.json', 'application/xml': '.xml', 'text/xml': '.xml',
  'application/zip': '.zip', 'application/gzip': '.gz', 'application/x-7z-compressed': '.7z', 'model/stl': '.stl',
  'model/3mf': '.3mf', 'application/step': '.step', 'image/vnd.dxf': '.dxf', 'application/dxf': '.dxf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx', 'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls',
};
function extOf(d) {
  const f = d.filename || '';
  const ext = f.match(/\.tar\.(gz|bz2|xz|zst)$/i)?.[0] || path.extname(f);
  return /^\.[\w-]+(\.[\w-]+)?$/.test(ext) ? ext : MIME_EXT[(d.mime || '').split(';')[0].trim().toLowerCase()] || '';
}
// Characters not allowed in file names (Windows, macOS) become spaces; no trailing dots or spaces.
const cleanName = n => (n || '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').replace(/\s+(\.\w+)$/, '$1').replace(/[.\s]+$/, '').trim();
export function downloadName(d) {
  const ext = extOf(d);
  const name = cleanName(d.label) || cleanName(d.filename) || `document-${d.id}`;
  return ext && !name.toLowerCase().endsWith(ext.toLowerCase()) ? `${name}${ext}` : name;
}

const attachment = name => `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

export const INLINE_OK = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)$/;

route('GET', '/api/docs/:id/file', ({ res, params, query }) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(+params.id);
  if (!d?.stored) fail(404, 'Document not found');
  const file = path.join(UPLOAD_DIR, d.stored);
  if (!fs.existsSync(file)) fail(404, 'File missing on the server');
  const safe = INLINE_OK.test(d.mime || '');
  const name = downloadName(d);
  res.writeHead(200, {
    'Content-Type': safe ? d.mime : 'application/octet-stream',
    'Content-Length': fs.statSync(file).size,
    'Content-Disposition': query.inline && safe ? `inline; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}` : attachment(name),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
    ...(d.mime === 'application/pdf' ? {} : { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'" }),
  });
  fs.createReadStream(file).pipe(res);
}, { area: 'documenti' });

// All the files of an item in a .zip (links stay out: there is no file to download).
route('GET', '/api/items/:id/docs.zip', ({ res, params }) => {
  const it = db.prepare('SELECT code FROM items WHERE id = ?').get(+params.id) || fail(404, 'Item not found');
  const docs = db.prepare('SELECT * FROM documents WHERE item_id = ? AND deleted_at IS NULL AND stored IS NOT NULL ORDER BY created_at').all(+params.id);
  const used = new Set();
  const files = [];
  for (const d of docs) {
    const file = path.join(UPLOAD_DIR, d.stored);
    if (!fs.existsSync(file)) continue;
    // Two documents with the same name: the second becomes "name (2).ext".
    let name = downloadName(d);
    const ext = path.extname(name);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${path.basename(name, ext).replace(/ \(\d+\)$/, '')} (${n})${ext}`;
    used.add(name.toLowerCase());
    files.push({ name, data: fs.readFileSync(file) });
  }
  if (!files.length) fail(404, 'The item has no files to download');
  const body = zip(files);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': body.length,
    'Content-Disposition': attachment(`${it.code.replace(/[\\/:*?"<>|\r\n]+/g, '_')}-documents.zip`),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}, { area: 'documenti' });

// Like at upload: the most recent firmware with a version gives the item its version (if one is left).
function refreshFirmware(itemId) {
  const latest = db.prepare(`SELECT version FROM documents WHERE item_id = ? AND kind = 'firmware' AND version != ''
    AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`).get(itemId);
  if (latest) db.prepare('UPDATE items SET firmware = ?, updated_at = ? WHERE id = ?').run(latest.version, now(), itemId);
}

const liveDoc = id => db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(+id) || fail(404, 'Document not found');
const targetItem = id => db.prepare('SELECT id, code FROM items WHERE id = ? AND deleted_at IS NULL').get(+id) || fail(404, 'Item not found');

// Name, kind, version; item_id moves it to another item (with its notes).
route('PATCH', '/api/docs/:id', async ({ params, body }) => {
  const b = await body();
  const d = liveDoc(params.id);
  const f = {};
  if (b.label !== undefined) f.label = str(b.label, 200);
  if (b.version !== undefined) f.version = str(b.version, 60);
  if (b.kind !== undefined) f.kind = docKind(b.kind);
  if (b.item_id !== undefined) f.item_id = targetItem(b.item_id).id;
  tx(() => {
    setFields('documents', d.id, f);
    // Also when the document stops being a firmware (or changes item): the version of the most recent firmware
    // left comes back.
    if ((f.kind ?? d.kind) === 'firmware' || d.kind === 'firmware') {
      refreshFirmware(d.item_id);
      if (f.item_id && f.item_id !== d.item_id) refreshFirmware(f.item_id);
    }
  });
}, { area: 'documenti' });

// A copy in another item (or the same one): a file of its own (or the saved page of a link), without the notes.
route('POST', '/api/docs/:id/copy', async ({ params, user, body }) => {
  const d = liveDoc(params.id);
  const it = targetItem((await body()).item_id);
  let stored = null;
  if (d.stored) {
    const src = path.join(UPLOAD_DIR, d.stored);
    if (!fs.existsSync(src)) fail(404, 'File missing on the server');
    stored = crypto.randomBytes(16).toString('hex');
    fs.copyFileSync(src, path.join(UPLOAD_DIR, stored));
  }
  const id = tx(() => {
    const id = insertId(db.prepare(`INSERT INTO documents (item_id, kind, label, version, filename, mime, size, sha256, stored, url, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(it.id, d.kind, d.label, d.version, d.filename, d.mime, d.size, d.sha256, stored, d.url, user.id, now()));
    if (d.kind === 'firmware') refreshFirmware(it.id);
    db.prepare('INSERT INTO doc_pages (doc_id, url, html, saved_at) SELECT ?, url, html, saved_at FROM doc_pages WHERE doc_id = ?').run(id, d.id);
    return id;
  });
  return { id };
}, { area: 'documenti' });

// New document kind: one word (letters, digits, - _), lower case.
route('POST', '/api/doc-kinds', async ({ user, body }) => {
  const name = str((await body()).name, 24).toLowerCase().replace(/\s+/g, '-');
  if (!/^[\p{L}\d_-]+$/u.test(name)) fail(400, 'Kind: one word, with letters, digits, - and _');
  if (docKinds().includes(name)) fail(409, 'The kind "{name}" already exists', { name });
  db.prepare('INSERT INTO doc_kinds (name, created_by, created_at) VALUES (?, ?, ?)').run(name, user.id, now());
  return { name };
}, { area: 'documenti' });

// Deleting a kind added by hand moves its documents to "altro" (other); the built-in ones cannot be deleted.
route('DELETE', '/api/doc-kinds/:name', ({ params }) => {
  if (!db.prepare('SELECT 1 FROM doc_kinds WHERE name = ?').get(params.name)) fail(404, 'Only added kinds can be deleted');
  tx(() => {
    db.prepare("UPDATE documents SET kind = 'altro' WHERE kind = ?").run(params.name);
    db.prepare('DELETE FROM doc_kinds WHERE name = ?').run(params.name);
  });
}, { area: 'documenti' });

// ---------- notes on documents ----------
// Page and point (0..1); z only for 3D models.
function notePosition(b) {
  if (b.page == null) return { page: null, x: null, y: null, z: null };
  const page = Number(b.page);
  const [x, y] = [Number(b.x), Number(b.y)];
  const z = b.z == null ? null : Number(b.z);
  const unit = n => n >= 0 && n <= 1;
  if (!Number.isInteger(page) || page < 1 || !unit(x) || !unit(y) || (z !== null && !unit(z))) fail(400, 'Invalid position');
  return { page, x, y, z };
}

// Highlighted text (only for notes with a page): the selected text and its boxes.
function noteMarks(b, page) {
  if (page == null || !Array.isArray(b.marks) || !b.marks.length) return { quote: null, marks: null };
  const unit = n => typeof n === 'number' && n >= -0.01 && n <= 1.01;
  const marks = b.marks.slice(0, 300).map(m => {
    if (!Array.isArray(m) || m.length !== 5 || !Number.isInteger(m[0]) || m[0] < 1 || !m.slice(1).every(unit)) fail(400, 'Invalid highlight');
    return [m[0], ...m.slice(1).map(n => Math.round(Math.min(1, Math.max(0, n)) * 1e4) / 1e4)];
  });
  return { quote: String(b.quote || '').replace(/\s+/g, ' ').trim().slice(0, 2000) || null, marks: JSON.stringify(marks) };
}

// Notes are private to whoever writes them; +person / +all in the text share them (and do not stay in the text).
const getNote = (id, user) => db.prepare(`SELECT * FROM doc_notes n WHERE n.id = $id AND n.deleted_at IS NULL AND ${NVIS_ANY}`)
  .get({ id: +id, uid: user.id }) || fail(404, 'Note not found');

function noteText(raw) {
  const ps = parseShares(str(raw, 5000));
  const sh = shareTargets(ps.names);
  // Whoever does not exist stays written in the note, as in entries.
  return { text: [ps.text, ...sh.unknown.map(n => `+${n}`)].filter(Boolean).join(' '), ids: sh.ids, all: ps.all };
}

// Whoever is mentioned in a note on a document (+person: shares it with them).
function notifyNote(user, n, ids) {
  const d = db.prepare('SELECT label, filename, url FROM documents WHERE id = ?').get(n.doc_id);
  notify(ids, { ws: currentWorkspace(), kind: 'mention', title: d?.label || d?.filename ? ['{actor} mentioned you in a note on {doc}', { actor: actorName(user), doc: d.label || d.filename }] : ['{actor} mentioned you in a note on a document', { actor: actorName(user) }],
    body: plain(n.text), url: `#/d/${n.doc_id}?n=${n.id}`, actor: user.id });
}

route('POST', '/api/docs/:id/notes', async ({ params, user, body }) => {
  const b = await body();
  const d = db.prepare('SELECT id FROM documents WHERE id = ? AND deleted_at IS NULL').get(+params.id) || fail(404, 'Document not found');
  const nt = noteText(b.text);
  if (!nt.text) fail(400, 'Write the note');
  const { page, x, y, z } = notePosition(b);
  const { quote, marks } = noteMarks(b, z == null ? page : null);
  const t = now();
  const id = insertId(db.prepare(`INSERT INTO doc_notes (doc_id, page, x, y, z, text, quote, marks, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(d.id, page, x, y, z, nt.text, quote, marks, user.id, t, t));
  addShares('docnote', id, nt.ids.filter(x => x !== user.id), nt.all);
  notifyNote(user, { id, doc_id: d.id, text: nt.text }, nt.ids);
  return { id };
}, { area: 'documenti' });

route('PATCH', '/api/doc-notes/:id', async ({ params, user, body }) => {
  const b = await body();
  const n = getNote(params.id, user);
  const f = {};
  if (b.text !== undefined) {
    const nt = noteText(b.text);
    f.text = nt.text || fail(400, 'The note cannot be empty');
    if (nt.ids.length || nt.all) {
      if (n.created_by !== user.id) fail(403, 'Only the note\'s author decides who to share it with');
      const had = new Set(db.prepare("SELECT user_id FROM shares WHERE kind = 'docnote' AND obj_id = ?").all(n.id).map(r => r.user_id));
      addShares('docnote', n.id, nt.ids.filter(x => x !== user.id), nt.all);
      notifyNote(user, { ...n, text: nt.text }, nt.ids.filter(x => !had.has(x)));
    }
  }
  if (b.resolved !== undefined) f.resolved_at = b.resolved ? n.resolved_at || now() : null;
  if (b.page !== undefined) Object.assign(f, notePosition(b));
  f.updated_at = now();
  setFields('doc_notes', n.id, f);
}, { area: 'documenti' });

route('DELETE', '/api/doc-notes/:id', ({ params, user }) => {
  const n = getNote(params.id, user);
  db.prepare('UPDATE doc_notes SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), user.id, n.id);
}, { area: 'documenti' });

route('DELETE', '/api/docs/:id', ({ params, user }) => {
  const d = db.prepare('SELECT id FROM documents WHERE id = ? AND deleted_at IS NULL').get(+params.id) || fail(404, 'Document not found');
  db.prepare('UPDATE documents SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), user.id, d.id);
}, { area: 'documenti' });

// ---------- administration of the active workspace ----------
const activeWs = () => workspaceById(currentWorkspace()) || fail(404, 'Workspace not found');

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
  if (!roleIn(ws.id, targetId)) fail(404, 'Not a member of this workspace');
  if (b.is_admin !== undefined) {
    if (targetId === user.id && !b.is_admin && adminCount(ws.id) === 1) fail(400, 'You are the only admin: make someone else admin first');
    acc.prepare('UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?').run(b.is_admin ? 'admin' : 'member', ws.id, targetId);
    syncMirror(ws, targetId);
  }
  // Permissions per area (see public/js/perms.js); null = full access. Admins always have everything.
  if (b.perms !== undefined) {
    if (roleIn(ws.id, targetId) === 'admin') fail(400, 'Admins always have access to everything: remove the admin role first');
    if (b.perms !== null && typeof b.perms !== 'object') fail(400, 'Invalid permissions');
    setPerms(ws.id, targetId, b.perms);
    return { perms: permsIn(ws.id, targetId) };
  }
  if (b.reset_password) {
    // The password applies to all the person's workspaces: only someone who is admin in each of them can reset it.
    const others = workspacesOf(targetId).filter(w => roleIn(w.id, user.id) !== 'admin');
    if (others.length) fail(403, 'This person is also in workspaces where you are not admin: only they can change their password (or the make reset-password command)');
    const password = randomCode(12);
    acc.prepare('UPDATE users SET pass = ? WHERE id = ?').run(await hashPassword(password), targetId);
    acc.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
    revokeApiTokens(targetId);
    dropUser(targetId);
    return { password };
  }
}, { auth: 'admin' });

// Removes the person from the workspace (their account and other workspaces stay).
route('DELETE', '/api/admin/users/:id', ({ params, user }) => {
  const ws = activeWs();
  if (+params.id === user.id) fail(400, 'To leave, use "Leave the workspace"');
  if (!roleIn(ws.id, +params.id)) fail(404, 'Not a member of this workspace');
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
