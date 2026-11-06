// Accounts and workspaces: users with passwords, sessions, workspaces, memberships (admin or member) and invites.
// All in accounts.db; each workspace's data lives in its own file (see db.js).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, openSqlite, openDataDb } from './db.js';
import { fail, now } from './util.js';
import { normalize } from '../public/js/perms.js';

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
  // Tokens for the CLI and external programs (bots, scripts): sent as "Authorization: Bearer ...".
  `
  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    hint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE INDEX api_tokens_user ON api_tokens(user_id);
  `,
  // Members' permissions per area (JSON, see public/js/perms.js); NULL = full access.
  `
  ALTER TABLE memberships ADD COLUMN perms TEXT;
  `,
  // Inbox passed on by the Thunderbird extension (server/thunderbird.js): personal, only whoever receives it sees
  // it, in any workspace. thread_ws/thread_entry: the Organizer mail it belongs to.
  // mail_addresses: the addresses of the Thunderbird identities (for "reply all" without oneself).
  `
  CREATE TABLE mail_inbox (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    from_addr TEXT NOT NULL DEFAULT '',
    to_addr TEXT NOT NULL DEFAULT '',
    cc TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    date TEXT NOT NULL,
    thread_ws INTEGER,
    thread_entry INTEGER,
    read_at TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, message_id)
  );
  CREATE INDEX mail_inbox_user ON mail_inbox(user_id, date);
  ALTER TABLE users ADD COLUMN mail_addresses TEXT NOT NULL DEFAULT '[]';
  `,
  // Feedback about the app (bugs, ideas) with screenshots: reviewed by whoever runs the instance (server/feedback.js).
  `
  CREATE TABLE feedback (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users ON DELETE SET NULL,
    workspace_id INTEGER,
    text TEXT NOT NULL,
    page TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '',
    client TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE TABLE feedback_files (
    id INTEGER PRIMARY KEY,
    feedback_id INTEGER NOT NULL REFERENCES feedback ON DELETE CASCADE,
    stored TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // Notifications (server/notify.js): mentions, incoming mail, channel messages. They belong to the person, in every
  // workspace (workspace_id says where the url leads). push_subs: the devices to send them to with the app closed.
  `
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    workspace_id INTEGER,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    actor_id INTEGER,
    created_at TEXT NOT NULL,
    read_at TEXT
  );
  CREATE INDEX notifications_user ON notifications(user_id, id);
  CREATE TABLE push_subs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    client TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  `,
  // Organizer tour (server/tour.js): onboarded_at = the invitation has been seen (existing users do not get it);
  // tour_of = that person's demo workspace.
  `
  ALTER TABLE users ADD COLUMN onboarded_at TEXT;
  UPDATE users SET onboarded_at = created_at;
  ALTER TABLE workspaces ADD COLUMN tour_of INTEGER REFERENCES users ON DELETE CASCADE;
  `,
  // Mail by topic: mail_backfill_at = the Thunderbird extension has loaded the last month (NULL = to do at the next
  // connection, also for existing users: mail starts over).
  `
  ALTER TABLE users ADD COLUMN mail_backfill_at TEXT;
  `,
  // "To save" contacts not to suggest: whole addresses or parts (noreply, @shop.example, a name), per person.
  `
  ALTER TABLE users ADD COLUMN mail_ignore TEXT NOT NULL DEFAULT '[]';
  `,
  // Interface language of the person (en, it): sent by the app with every request, used for what is written to
  // them later (notifications).
  `
  ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT 'en';
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

// ---------- older installation (a single workspace) ----------
// On the first start with workspaces: organizer.db becomes workspace 1 and its users become accounts, with the
// admin role for whoever was admin. Passwords leave the data file.
function importLegacy() {
  if (acc.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n) return;
  if (!fs.existsSync(path.join(DATA_DIR, 'organizer.db'))) return;
  const data = openDataDb('organizer.db');
  const users = data.prepare("SELECT id, username, name, pass, is_admin, created_at FROM users WHERE pass != ''").all();
  if (!users.length) return;
  const t = now();
  const name = process.env.WORKSPACE_NAME || 'Main';
  atx(() => {
    // Users first: the workspace refers to whoever created it.
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
  console.log(`Workspace: existing installation imported as "${name}" (${users.length} users)`);
}
importLegacy();

// ---------- workspaces and members ----------
export const userCount = () => acc.prepare('SELECT COUNT(*) AS n FROM users').get().n;
export const getAccount = id => acc.prepare('SELECT id, username, name, last_workspace_id, lang FROM users WHERE id = ?').get(+id);
export const langOfUser = id => acc.prepare('SELECT lang FROM users WHERE id = ?').get(+id)?.lang || 'en';
export const workspaceById = id => acc.prepare('SELECT * FROM workspaces WHERE id = ? AND deleted_at IS NULL').get(+id);
// A member's permissions in the workspace: null = full access (admin, or no restriction set).
export function permsIn(wsId, userId) {
  const m = acc.prepare('SELECT role, perms FROM memberships WHERE workspace_id = ? AND user_id = ?').get(wsId, userId);
  if (!m || m.role === 'admin' || !m.perms) return null;
  try {
    return normalize(JSON.parse(m.perms));
  } catch {
    return null;
  }
}

export function setPerms(wsId, userId, perms) {
  acc.prepare('UPDATE memberships SET perms = ? WHERE workspace_id = ? AND user_id = ?')
    .run(perms ? JSON.stringify(normalize(perms)) : null, wsId, userId);
}

export const roleIn = (wsId, userId) => acc.prepare('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?').get(wsId, userId)?.role ?? null;

export function workspacesOf(userId) {
  return acc.prepare(`SELECT w.id, w.name, m.role, w.tour_of IS NOT NULL AS tour FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = ? AND w.deleted_at IS NULL ORDER BY w.name COLLATE NOCASE`).all(userId);
}

export function membersOf(wsId) {
  return acc.prepare(`SELECT u.id, u.username, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ? ORDER BY u.name COLLATE NOCASE`).all(wsId);
}

// Copy of the member in the workspace's users table (for foreign keys and names).
export function syncMirror(ws, userId) {
  const u = getAccount(userId);
  const role = roleIn(ws.id, userId);
  const data = openDataDb(ws.file);
  // Whoever joins the workspace finds the chat already read: earlier messages do not count as new.
  data.prepare(`INSERT INTO users (id, username, name, pass, is_admin, member, created_at, chat_read_id)
    VALUES ($id, $username, $name, '', $admin, $member, $t, (SELECT IFNULL(MAX(id), 0) FROM chat_messages))
    ON CONFLICT(id) DO UPDATE SET username = $username, name = $name, is_admin = $admin, member = $member`)
    .run({ id: u.id, username: u.username, name: u.name, admin: role === 'admin' ? 1 : 0, member: role ? 1 : 0, t: now() });
  // Per channel too: whoever joins finds the everyone-channels read (the others when added to them, see chat.js).
  if (role) {
    data.prepare(`INSERT OR IGNORE INTO chat_reads (channel_id, user_id, read_id)
      SELECT c.id, ?, IFNULL((SELECT MAX(m.id) FROM chat_messages m WHERE m.channel_id = c.id), 0) FROM chat_channels c WHERE c.everyone = 1`).run(u.id);
  }
}

export function addMember(ws, userId, role) {
  acc.prepare(`INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_id, user_id) DO NOTHING`).run(ws.id, userId, role, now());
  syncMirror(ws, userId);
}

export function createWorkspace(name, userId) {
  const t = now();
  const ws = atx(() => {
    // The first workspace uses organizer.db, the others ws-<id>.db.
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
  if (roleIn(ws.id, userId) === 'admin' && adminCount(ws.id) === 1) fail(400, 'They are the only admin of the workspace: make someone else admin first');
  acc.prepare('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?').run(ws.id, userId);
  acc.prepare('UPDATE sessions SET workspace_id = NULL WHERE user_id = ? AND workspace_id = ?').run(userId, ws.id);
  syncMirror(ws, userId);
}

// ---------- sessions ----------
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
  // With an API token there is no session: only the account's default workspace changes.
  if (token) acc.prepare('UPDATE sessions SET workspace_id = ? WHERE token_hash = ?').run(wsId, sha(token));
  acc.prepare('UPDATE users SET last_workspace_id = ? WHERE id = ?').run(wsId, userId);
}

export function defaultWorkspace(userId) {
  const u = getAccount(userId);
  if (u?.last_workspace_id && roleIn(u.last_workspace_id, userId) && workspaceById(u.last_workspace_id)) return u.last_workspace_id;
  return workspacesOf(userId)[0]?.id ?? null;
}

// From the cookie: account, active workspace (if it has a valid one) and role in that workspace.
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
  return { account, ws, role: ws ? roleIn(ws.id, account.id) : null, perms: ws ? permsIn(ws.id, account.id) : null };
}

// ---------- API tokens ----------
// The token is shown only once, when created; the database keeps its hash and last 4 characters (to recognise it).
export function createApiToken(userId, name) {
  const token = `org_${crypto.randomBytes(32).toString('base64url')}`;
  const id = Number(acc.prepare('INSERT INTO api_tokens (user_id, name, token_hash, hint, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, name, sha(token), token.slice(-4), now()).lastInsertRowid);
  return { id, name, token };
}

export const apiTokensOf = userId =>
  acc.prepare('SELECT id, name, hint, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC').all(userId);

export const revokeApiTokens = (userId, id = null) =>
  acc.prepare('DELETE FROM api_tokens WHERE user_id = ? AND (? IS NULL OR id = ?)').run(userId, id, id).changes;

// Like resolveAuth, but for an API token. The workspace is chosen with each request (X-Workspace header), otherwise
// it is the account's default one. Unknown token → null.
export function resolveApiToken(token, wsHeader) {
  const t = acc.prepare('SELECT id, user_id, last_used_at FROM api_tokens WHERE token_hash = ?').get(sha(token));
  if (!t) return null;
  // "Last used" to the minute: no need to write on every request.
  if (!t.last_used_at || Date.now() - Date.parse(t.last_used_at) > 60e3) acc.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), t.id);
  const account = getAccount(t.user_id);
  let wsId = defaultWorkspace(account.id);
  if (wsHeader) {
    wsId = +wsHeader;
    if (!workspaceById(wsId) || !roleIn(wsId, account.id)) fail(403, 'You are not in workspace {ws}', { ws: wsHeader });
  }
  const ws = wsId ? workspaceById(wsId) : null;
  return { account, ws, role: ws ? roleIn(ws.id, account.id) : null, perms: ws ? permsIn(ws.id, account.id) : null, apiToken: t.id };
}

// "To save" contacts the person does not want to see: whole addresses or parts of an address or name.
export const mailIgnoreOf = userId => JSON.parse(acc.prepare('SELECT mail_ignore FROM users WHERE id = ?').get(userId)?.mail_ignore || '[]');
// The user's Thunderbird identity addresses (sent by the extension): they are "my" addresses.
export const mailAddressesOf = userId => JSON.parse(acc.prepare('SELECT mail_addresses FROM users WHERE id = ?').get(userId)?.mail_addresses || '[]');

// Who runs the instance (for feedback): the admins of the first workspace, the one created at installation.
export function isOwner(userId) {
  const first = acc.prepare('SELECT id FROM workspaces ORDER BY id LIMIT 1').get();
  return !!first && roleIn(first.id, userId) === 'admin';
}

// For /api/sync: whoever runs the instance sees the Feedback page with the number of open ones (others null).
export const openFeedback = userId => (isOwner(userId) ? acc.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status = 'open'").get().n : null);

// Organizer tour (server/tour.js): the person's demo workspace and whether they have seen the invitation.
export const tourOf = userId => acc.prepare('SELECT * FROM workspaces WHERE tour_of = ? AND deleted_at IS NULL').get(userId);
export const tourInfo = userId => ({
  onboarded: !!acc.prepare('SELECT onboarded_at FROM users WHERE id = ?').get(userId)?.onboarded_at,
  tourWs: tourOf(userId)?.id ?? null,
});
