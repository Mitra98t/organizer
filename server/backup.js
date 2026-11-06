// Restoring a database backup (the .db file downloaded from Settings → Backup).
// Before overwriting, a copy of the current database is saved in DATA_DIR (pre-restore-*.db).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, tx, migrate, DATA_DIR, UPLOAD_DIR, SCHEMA_VERSION, currentWorkspace } from './db.js';
import { acc, workspaceById, syncMirror } from './accounts.js';
import { route, saveUpload } from './api.js';
import { fail } from './util.js';

const KEEP_SAFETY_COPIES = 3;
// Accounts, sessions and invites are no longer in the workspace's data (see accounts.js): they are not restored.
const SKIP = new Set(['sessions', 'mail_tokens', 'invites']);

function checkBackup(file) {
  let src;
  try {
    src = new DatabaseSync(file);
    const ok = Object.values(src.prepare('PRAGMA integrity_check').get())[0];
    if (ok !== 'ok') fail(400, 'The backup\'s database is damaged');
  } catch (e) {
    src?.close();
    if (e.status) throw e;
    fail(400, 'The file is not an SQLite database');
  }
  try {
    const { user_version: v } = src.prepare('PRAGMA user_version').get();
    const hasUsers = src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
    if (!v || !hasUsers) fail(400, 'The file is not an Organizer backup');
    if (v > SCHEMA_VERSION) fail(400, 'The backup comes from a newer version of the app: update the app first');
    migrate(src);
    return src.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  } finally {
    src.close();
  }
}

function safetyCopy() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const prefix = `pre-restore-ws${currentWorkspace()}-`; // separate copies per workspace
  const file = path.join(DATA_DIR, `${prefix}${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(DATA_DIR).filter(f => f.startsWith(prefix) && f.endsWith('.db')).sort().reverse().slice(KEEP_SAFETY_COPIES);
  for (const f of old) fs.rmSync(path.join(DATA_DIR, f), { force: true });
  return path.basename(file);
}

const cols = (schema, table) => db.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(table, schema).map(c => c.name);

route('POST', '/api/admin/restore', async ({ req }) => {
  const { stored } = await saveUpload(req);
  const file = path.join(UPLOAD_DIR, stored);
  try {
    checkBackup(file);
    const copy = safetyCopy();
    // foreign_keys can only change outside a transaction: the tables are emptied and copied back in one go.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`ATTACH DATABASE '${file}' AS src`);
    try {
      tx(() => {
        const tables = db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
        for (const t of tables) db.exec(`DELETE FROM main."${t}"`);
        for (const t of tables) {
          if (SKIP.has(t)) continue;
          const shared = cols('main', t).filter(c => cols('src', t).includes(c)).map(c => `"${c}"`).join(', ');
          if (shared) db.exec(`INSERT INTO main."${t}" (${shared}) SELECT ${shared} FROM src."${t}"`);
        }
        const bad = db.prepare('PRAGMA foreign_key_check').all();
        if (bad.length) fail(400, 'The backup has inconsistent references: restore cancelled');
        // The backup's users stay as names (former members); current members come from the accounts.
        db.exec("UPDATE users SET pass = '', member = 0");
      });
    } finally {
      db.exec('DETACH DATABASE src');
      db.exec('PRAGMA foreign_keys = ON');
    }
    const ws = workspaceById(currentWorkspace());
    for (const m of acc.prepare('SELECT user_id FROM memberships WHERE workspace_id = ?').all(ws.id)) syncMirror(ws, m.user_id);
    const users = acc.prepare('SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ?').get(ws.id).n;
    // Uploaded files are not in the .db: report how many documents and attachments have no file on the server.
    const stores = db.prepare(`SELECT stored FROM documents WHERE stored IS NOT NULL
      UNION ALL SELECT stored FROM mail_attachments WHERE stored IS NOT NULL`).all();
    const missing = stores.filter(r => !fs.existsSync(path.join(UPLOAD_DIR, r.stored))).length;
    return { users, missing, safetyCopy: copy };
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
}, { auth: 'admin' });
