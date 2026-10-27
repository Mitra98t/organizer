// Ripristino di un backup del database (il file .db scaricato da Impostazioni → Backup).
// Prima di sovrascrivere si salva una copia del database attuale in DATA_DIR (pre-restore-*.db).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, tx, migrate, DATA_DIR, UPLOAD_DIR, SCHEMA_VERSION } from './db.js';
import { route, saveUpload } from './api.js';
import { fail } from './util.js';

const KEEP_SAFETY_COPIES = 3;
// Sessioni e token non si ripristinano: dopo il ripristino tutti rientrano con le credenziali del backup.
const SKIP = new Set(['sessions', 'mail_tokens']);

function checkBackup(file) {
  let src;
  try {
    src = new DatabaseSync(file);
    const ok = Object.values(src.prepare('PRAGMA integrity_check').get())[0];
    if (ok !== 'ok') fail(400, 'Il database del backup è danneggiato');
  } catch (e) {
    src?.close();
    if (e.status) throw e;
    fail(400, 'Il file non è un database SQLite');
  }
  try {
    const { user_version: v } = src.prepare('PRAGMA user_version').get();
    const hasUsers = src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
    if (!v || !hasUsers) fail(400, 'Il file non è un backup di Organizer');
    if (v > SCHEMA_VERSION) fail(400, 'Il backup viene da una versione più nuova dell\'app: aggiorna prima l\'app');
    migrate(src);
    if (!src.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n) fail(400, 'Il backup non contiene nessun amministratore');
    return src.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  } finally {
    src.close();
  }
}

function safetyCopy() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = path.join(DATA_DIR, `pre-restore-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(DATA_DIR).filter(f => /^pre-restore-.*\.db$/.test(f)).sort().reverse().slice(KEEP_SAFETY_COPIES);
  for (const f of old) fs.rmSync(path.join(DATA_DIR, f), { force: true });
  return path.basename(file);
}

const cols = (schema, table) => db.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(table, schema).map(c => c.name);

route('POST', '/api/admin/restore', async ({ req }) => {
  const { stored } = await saveUpload(req);
  const file = path.join(UPLOAD_DIR, stored);
  try {
    const users = checkBackup(file);
    const copy = safetyCopy();
    // foreign_keys si può cambiare solo fuori da una transazione: le tabelle si svuotano e ricopiano in blocco.
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
        if (bad.length) fail(400, 'Il backup contiene riferimenti incoerenti: ripristino annullato');
      });
    } finally {
      db.exec('DETACH DATABASE src');
      db.exec('PRAGMA foreign_keys = ON');
    }
    // I file caricati non sono nel .db: si segnala quanti documenti e allegati non hanno il file sul server.
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
