// Account e workspace: utenti con password, sessioni, workspace, appartenenze (admin o membro) e inviti.
// Tutto in accounts.db; i dati di ogni workspace stanno nel suo file (vedi db.js).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, openSqlite, openDataDb } from './db.js';
import { fail, now } from './util.js';

export const acc = openSqlite('accounts.db');

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    pass TEXT NOT NULL,
    last_workspace_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE workspaces (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    file TEXT NOT NULL UNIQUE,
    created_by INTEGER REFERENCES users ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE TABLE memberships (
    workspace_id INTEGER NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE INDEX memberships_user ON memberships(user_id);
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    workspace_id INTEGER REFERENCES workspaces ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );
  CREATE TABLE invites (
    code TEXT PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    created_by INTEGER REFERENCES users ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_by INTEGER REFERENCES users ON DELETE SET NULL,
    used_at TEXT
  );
  `,
];

{
  const { user_version: v } = acc.prepare('PRAGMA user_version').get();
  for (let i = v; i < MIGRATIONS.length; i++) {
    acc.exec('BEGIN');
    try {
      acc.exec(MIGRATIONS[i]);
      acc.exec(`PRAGMA user_version = ${i + 1}`);
      acc.exec('COMMIT');
    } catch (e) {
      acc.exec('ROLLBACK');
      throw e;
    }
  }
}

export function atx(fn) {
  acc.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    acc.exec('COMMIT');
    return r;
  } catch (e) {
    acc.exec('ROLLBACK');
    throw e;
  }
}

// ---------- installazione precedente (un solo workspace) ----------
// Al primo avvio con i workspace: organizer.db diventa il workspace 1 e i suoi utenti diventano account,
// con ruolo admin per chi era admin. Le password escono dal file dei dati.
function importLegacy() {
  if (acc.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n) return;
  if (!fs.existsSync(path.join(DATA_DIR, 'organizer.db'))) return;
  const data = openDataDb('organizer.db');
  const users = data.prepare("SELECT id, username, name, pass, is_admin, created_at FROM users WHERE pass != ''").all();
  if (!users.length) return;
  const t = now();
  const name = process.env.WORKSPACE_NAME || 'Principale';
  atx(() => {
    // Prima gli utenti: il workspace fa riferimento a chi l'ha creato.
    for (const u of users) {
      acc.prepare('INSERT INTO users (id, username, name, pass, last_workspace_id, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(u.id, u.username, u.name, u.pass, u.created_at);
    }
    acc.prepare('INSERT INTO workspaces (id, name, file, created_by, created_at) VALUES (1, ?, ?, ?, ?)')
      .run(name, 'organizer.db', users.find(u => u.is_admin)?.id ?? users[0].id, t);
    for (const u of users) {
      acc.prepare('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (1, ?, ?, ?)')
        .run(u.id, u.is_admin ? 'admin' : 'member', t);
    }
    for (const s of data.prepare('SELECT * FROM sessions').all()) {
      acc.prepare('INSERT OR IGNORE INTO sessions (token_hash, user_id, workspace_id, created_at, last_seen) VALUES (?, ?, 1, ?, ?)')
        .run(s.token_hash, s.user_id, s.created_at, s.last_seen);
    }
    for (const i of data.prepare('SELECT * FROM invites WHERE used_at IS NULL').all()) {
      acc.prepare('INSERT OR IGNORE INTO invites (code, workspace_id, created_by, created_at, expires_at) VALUES (?, 1, ?, ?, ?)')
        .run(i.code, i.created_by, i.created_at, i.expires_at);
    }
  });
  data.exec("UPDATE users SET pass = ''; DELETE FROM sessions; DELETE FROM invites;");
  console.log(`Workspace: installazione esistente importata come "${name}" (${users.length} utenti)`);
}
importLegacy();

// ---------- workspace e membri ----------
export const userCount = () => acc.prepare('SELECT COUNT(*) AS n FROM users').get().n;
export const getAccount = id => acc.prepare('SELECT id, username, name, last_workspace_id FROM users WHERE id = ?').get(+id);
export const workspaceById = id => acc.prepare('SELECT * FROM workspaces WHERE id = ? AND deleted_at IS NULL').get(+id);
export const roleIn = (wsId, userId) => acc.prepare('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?').get(wsId, userId)?.role ?? null;

export function workspacesOf(userId) {
  return acc.prepare(`SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = ? AND w.deleted_at IS NULL ORDER BY w.name COLLATE NOCASE`).all(userId);
}

export function membersOf(wsId) {
  return acc.prepare(`SELECT u.id, u.username, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ? ORDER BY u.name COLLATE NOCASE`).all(wsId);
}

// Copia del membro nella tabella users del workspace (serve alle chiavi esterne e ai nomi).
export function syncMirror(ws, userId) {
  const u = getAccount(userId);
  const role = roleIn(ws.id, userId);
  const data = openDataDb(ws.file);
  data.prepare(`INSERT INTO users (id, username, name, pass, is_admin, member, created_at) VALUES ($id, $username, $name, '', $admin, $member, $t)
    ON CONFLICT(id) DO UPDATE SET username = $username, name = $name, is_admin = $admin, member = $member`)
    .run({ id: u.id, username: u.username, name: u.name, admin: role === 'admin' ? 1 : 0, member: role ? 1 : 0, t: now() });
}

export function addMember(ws, userId, role) {
  acc.prepare(`INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_id, user_id) DO NOTHING`).run(ws.id, userId, role, now());
  syncMirror(ws, userId);
}

export function createWorkspace(name, userId) {
  const t = now();
  const ws = atx(() => {
    // Il primo workspace usa organizer.db, gli altri ws-<id>.db.
    const first = !acc.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n;
    const id = Number(acc.prepare('INSERT INTO workspaces (name, file, created_by, created_at) VALUES (?, ?, ?, ?)')
      .run(name, `tmp-${crypto.randomUUID()}`, userId, t).lastInsertRowid);
    const file = first ? 'organizer.db' : `ws-${id}.db`;
    acc.prepare('UPDATE workspaces SET file = ? WHERE id = ?').run(file, id);
    acc.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)").run(id, userId, t);
    return { id, name, file };
  });
  syncMirror(ws, userId);
  return ws;
}

export function adminCount(wsId) {
  return acc.prepare("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND role = 'admin'").get(wsId).n;
}

export function removeMember(ws, userId) {
  if (roleIn(ws.id, userId) === 'admin' && adminCount(ws.id) === 1) fail(400, 'È l\'unico admin del workspace: prima nomina un altro admin');
  acc.prepare('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?').run(ws.id, userId);
  acc.prepare('UPDATE sessions SET workspace_id = NULL WHERE user_id = ? AND workspace_id = ?').run(userId, ws.id);
  syncMirror(ws, userId);
}

// ---------- sessioni ----------
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

export function createSession(userId, wsId) {
  const token = crypto.randomBytes(32).toString('base64url');
  acc.prepare('INSERT INTO sessions (token_hash, user_id, workspace_id, created_at, last_seen) VALUES (?, ?, ?, ?, ?)')
    .run(sha(token), userId, wsId ?? null, now(), now());
  return token;
}

export function destroySession(token) {
  if (token) acc.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

export function setSessionWorkspace(token, userId, wsId) {
  acc.prepare('UPDATE sessions SET workspace_id = ? WHERE token_hash = ?').run(wsId, sha(token));
  acc.prepare('UPDATE users SET last_workspace_id = ? WHERE id = ?').run(wsId, userId);
}

export function defaultWorkspace(userId) {
  const u = getAccount(userId);
  if (u?.last_workspace_id && roleIn(u.last_workspace_id, userId) && workspaceById(u.last_workspace_id)) return u.last_workspace_id;
  return workspacesOf(userId)[0]?.id ?? null;
}

// Dal cookie: account, workspace attivo (se ne ha uno valido) e ruolo in quel workspace.
export function resolveAuth(token) {
  if (!token) return null;
  const s = acc.prepare('SELECT user_id, workspace_id FROM sessions WHERE token_hash = ?').get(sha(token));
  if (!s) return null;
  const account = getAccount(s.user_id);
  let wsId = s.workspace_id;
  if (!wsId || !roleIn(wsId, account.id) || !workspaceById(wsId)) {
    wsId = defaultWorkspace(account.id);
    acc.prepare('UPDATE sessions SET workspace_id = ? WHERE token_hash = ?').run(wsId, sha(token));
  }
  const ws = wsId ? workspaceById(wsId) : null;
  return { account, ws, role: ws ? roleIn(ws.id, account.id) : null };
}
