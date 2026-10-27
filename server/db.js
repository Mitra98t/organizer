import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'organizer.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Ogni elemento è una migrazione; non modificare quelle già rilasciate, aggiungerne di nuove in coda.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    pass TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );
  CREATE TABLE invites (
    code TEXT PRIMARY KEY,
    created_by INTEGER REFERENCES users ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_by INTEGER REFERENCES users ON DELETE SET NULL,
    used_at TEXT
  );
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paused', 'closed')),
    notes TEXT NOT NULL DEFAULT '',
    private INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE entries (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('todo', 'mail', 'note')),
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    contact TEXT,
    due TEXT,
    done_at TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    private INTEGER NOT NULL DEFAULT 0,
    project_id INTEGER REFERENCES projects ON DELETE SET NULL,
    parent_id INTEGER REFERENCES entries ON DELETE CASCADE,
    assignee_id INTEGER REFERENCES users ON DELETE SET NULL,
    created_by INTEGER REFERENCES users ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX entries_project ON entries(project_id);
  CREATE INDEX entries_parent ON entries(parent_id);
  CREATE INDEX entries_done ON entries(done_at);
  CREATE TABLE entry_log (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES entries ON DELETE CASCADE,
    user_id INTEGER REFERENCES users ON DELETE SET NULL,
    text TEXT NOT NULL,
    system INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX entry_log_entry ON entry_log(entry_id);
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    firmware TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    qty INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE item_links (
    parent_id INTEGER NOT NULL REFERENCES items ON DELETE CASCADE,
    child_id INTEGER NOT NULL REFERENCES items ON DELETE CASCADE,
    PRIMARY KEY (parent_id, child_id)
  );
  CREATE TABLE entry_items (
    entry_id INTEGER NOT NULL REFERENCES entries ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items ON DELETE CASCADE,
    PRIMARY KEY (entry_id, item_id)
  );
  CREATE INDEX entry_items_item ON entry_items(item_id);
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'altro',
    label TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '',
    filename TEXT,
    mime TEXT,
    size INTEGER,
    sha256 TEXT,
    stored TEXT,
    url TEXT,
    created_by INTEGER REFERENCES users ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX documents_item ON documents(item_id);
  `,
  // v2: cestino (soft delete), rubrica, mail con allegati
  `
  ALTER TABLE entries ADD COLUMN deleted_at TEXT;
  ALTER TABLE entries ADD COLUMN deleted_by INTEGER REFERENCES users ON DELETE SET NULL;
  ALTER TABLE projects ADD COLUMN deleted_at TEXT;
  ALTER TABLE projects ADD COLUMN deleted_by INTEGER REFERENCES users ON DELETE SET NULL;
  ALTER TABLE items ADD COLUMN deleted_at TEXT;
  ALTER TABLE items ADD COLUMN deleted_by INTEGER REFERENCES users ON DELETE SET NULL;
  ALTER TABLE documents ADD COLUMN deleted_at TEXT;
  ALTER TABLE documents ADD COLUMN deleted_by INTEGER REFERENCES users ON DELETE SET NULL;
  ALTER TABLE entries ADD COLUMN mail_cc TEXT;
  ALTER TABLE entries ADD COLUMN mail_subject TEXT;
  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    deleted_by INTEGER REFERENCES users ON DELETE SET NULL
  );
  CREATE TABLE mail_attachments (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES entries ON DELETE CASCADE,
    doc_id INTEGER REFERENCES documents ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime TEXT,
    size INTEGER,
    stored TEXT,
    created_by INTEGER REFERENCES users ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX mail_attachments_entry ON mail_attachments(entry_id);
  CREATE TABLE mail_tokens (
    token_hash TEXT PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES entries ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  `,
  // v3: sottoprogetti e articoli di magazzino collegati a mano a un progetto
  `
  ALTER TABLE projects ADD COLUMN parent_id INTEGER REFERENCES projects ON DELETE SET NULL;
  CREATE TABLE project_items (
    project_id INTEGER NOT NULL REFERENCES projects ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, item_id)
  );
  CREATE INDEX project_items_item ON project_items(item_id);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

// Porta un database (quello in uso o un backup da ripristinare) all'ultima versione dello schema.
export function migrate(conn) {
  const { user_version: version } = conn.prepare('PRAGMA user_version').get();
  for (let i = version; i < MIGRATIONS.length; i++) {
    conn.exec('BEGIN');
    try {
      conn.exec(MIGRATIONS[i]);
      conn.exec(`PRAGMA user_version = ${i + 1}`);
      conn.exec('COMMIT');
    } catch (e) {
      conn.exec('ROLLBACK');
      throw e;
    }
  }
}

migrate(db);

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
