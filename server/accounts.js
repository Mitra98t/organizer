// Account e workspace: utenti con password, sessioni, workspace, appartenenze (admin o membro) e inviti.
// Tutto in accounts.db; i dati di ogni workspace stanno nel suo file (vedi db.js).
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
  // Token per la CLI e per i programmi esterni (bot, script): si mandano come "Authorization: Bearer ...".
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
  // Permessi per area dei membri (JSON, vedi public/js/perms.js); NULL = accesso pieno.
  `
  ALTER TABLE memberships ADD COLUMN perms TEXT;
  `,
  // Posta in arrivo passata dall'estensione di Thunderbird (server/thunderbird.js): è personale, la vede solo
  // chi la riceve, in qualunque workspace. thread_ws/thread_entry: la mail di Organizer a cui appartiene.
  // mail_addresses: gli indirizzi delle identità di Thunderbird (per "rispondi a tutti" senza sé stessi).
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
  // Feedback sull'app (errori, idee) con screenshot: li rivede chi gestisce l'istanza (server/feedback.js).
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
  // Notifiche (server/notify.js): citazioni, mail arrivate, messaggi nei canali. Sono della persona, in ogni
  // workspace (workspace_id dice dove porta l'url). push_subs: i dispositivi a cui mandarle anche ad app chiusa.
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
  // Giro di Organizer (server/tour.js): onboarded_at = l'invito è già stato visto (chi c'era già non lo
  // riceve); tour_of = il workspace di prova di quella persona.
  `
  ALTER TABLE users ADD COLUMN onboarded_at TEXT;
  UPDATE users SET onboarded_at = created_at;
  ALTER TABLE workspaces ADD COLUMN tour_of INTEGER REFERENCES users ON DELETE CASCADE;
  `,
  // Posta a topic: mail_backfill_at = l'estensione di Thunderbird ha già caricato l'ultimo mese (NULL = da
  // fare al prossimo collegamento, anche per chi c'era già: la posta riparte da zero).
  `
  ALTER TABLE users ADD COLUMN mail_backfill_at TEXT;
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
// Permessi di un membro nel workspace: null = accesso pieno (admin, o nessuna restrizione impostata).
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

// Copia del membro nella tabella users del workspace (serve alle chiavi esterne e ai nomi).
export function syncMirror(ws, userId) {
  const u = getAccount(userId);
  const role = roleIn(ws.id, userId);
  const data = openDataDb(ws.file);
  // Chi entra nel workspace trova la chat già letta: i messaggi di prima non contano come nuovi.
  data.prepare(`INSERT INTO users (id, username, name, pass, is_admin, member, created_at, chat_read_id)
    VALUES ($id, $username, $name, '', $admin, $member, $t, (SELECT IFNULL(MAX(id), 0) FROM chat_messages))
    ON CONFLICT(id) DO UPDATE SET username = $username, name = $name, is_admin = $admin, member = $member`)
    .run({ id: u.id, username: u.username, name: u.name, admin: role === 'admin' ? 1 : 0, member: role ? 1 : 0, t: now() });
  // Anche per canale: chi entra trova letti i canali di tutti (gli altri quando ci viene aggiunto, vedi chat.js).
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
  // Con un token API non c'è sessione: cambia solo il workspace predefinito dell'account.
  if (token) acc.prepare('UPDATE sessions SET workspace_id = ? WHERE token_hash = ?').run(wsId, sha(token));
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
  return { account, ws, role: ws ? roleIn(ws.id, account.id) : null, perms: ws ? permsIn(ws.id, account.id) : null };
}

// ---------- token API ----------
// Il token si vede una volta sola, alla creazione; nel database resta l'hash e le ultime 4 lettere (per riconoscerlo).
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

// Come resolveAuth, ma per un token API. Il workspace si sceglie a ogni richiesta (header X-Workspace),
// altrimenti è quello predefinito dell'account. Token sconosciuto → null.
export function resolveApiToken(token, wsHeader) {
  const t = acc.prepare('SELECT id, user_id, last_used_at FROM api_tokens WHERE token_hash = ?').get(sha(token));
  if (!t) return null;
  // "Ultimo uso" con la precisione di un minuto: non serve scrivere a ogni richiesta.
  if (!t.last_used_at || Date.now() - Date.parse(t.last_used_at) > 60e3) acc.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), t.id);
  const account = getAccount(t.user_id);
  let wsId = defaultWorkspace(account.id);
  if (wsHeader) {
    wsId = +wsHeader;
    if (!workspaceById(wsId) || !roleIn(wsId, account.id)) fail(403, `Non fai parte del workspace ${wsHeader}`);
  }
  const ws = wsId ? workspaceById(wsId) : null;
  return { account, ws, role: ws ? roleIn(ws.id, account.id) : null, perms: ws ? permsIn(ws.id, account.id) : null, apiToken: t.id };
}

// Indirizzi delle identità di Thunderbird dell'utente (li manda l'estensione): sono i "miei" indirizzi.
export const mailAddressesOf = userId => JSON.parse(acc.prepare('SELECT mail_addresses FROM users WHERE id = ?').get(userId)?.mail_addresses || '[]');

// Chi gestisce l'istanza (per i feedback): gli admin del primo workspace, quello creato all'installazione.
export function isOwner(userId) {
  const first = acc.prepare('SELECT id FROM workspaces ORDER BY id LIMIT 1').get();
  return !!first && roleIn(first.id, userId) === 'admin';
}

// Per /api/sync: chi gestisce l'istanza vede la pagina Feedback con il numero di quelli aperti (gli altri null).
export const openFeedback = userId => (isOwner(userId) ? acc.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status = 'open'").get().n : null);

// Giro di Organizer (server/tour.js): il workspace di prova della persona e se l'invito l'ha già visto.
export const tourOf = userId => acc.prepare('SELECT * FROM workspaces WHERE tour_of = ? AND deleted_at IS NULL').get(userId);
export const tourInfo = userId => ({
  onboarded: !!acc.prepare('SELECT onboarded_at FROM users WHERE id = ?').get(userId)?.onboarded_at,
  tourWs: tourOf(userId)?.id ?? null,
});
