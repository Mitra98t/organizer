// Data databases: one per workspace (separate SQLite files). Which one to use is decided by the current request:
// `db` is a reference pointing to the active workspace's database (AsyncLocalStorage), so the rest of the server
// writes `db.prepare(...)` without knowing which workspace it is serving.
// Users, sessions and workspace memberships live in accounts.db instead (see accounts.js).
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads'); // shared: the files have random names
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export function openSqlite(file) {
  const conn = new DatabaseSync(path.join(DATA_DIR, file));
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return conn;
}

// Each element is a migration; do not change released ones, add new ones at the end.
// A migration is SQL, or (steps) SQL followed by JS steps on the same connection, in the same transaction.
const steps = (sql, ...fns) => conn => { conn.exec(sql); for (const f of fns) f(conn); };

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
  // v2: trash (soft delete), address book, mails with attachments
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
  // v3: subprojects and inventory items linked to a project by hand
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
  // v4: notes on documents. With page/x/y it is a pin on a point of the file (x, y in 0..1),
  // without them it is a general note on the file.
  `
  CREATE TABLE doc_notes (
    id INTEGER PRIMARY KEY,
    doc_id INTEGER NOT NULL REFERENCES documents ON DELETE CASCADE,
    page INTEGER,
    x REAL,
    y REAL,
    text TEXT NOT NULL,
    resolved_at TEXT,
    created_by INTEGER REFERENCES users ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    deleted_by INTEGER REFERENCES users ON DELETE SET NULL
  );
  CREATE INDEX doc_notes_doc ON doc_notes(doc_id);
  `,
  // v5: optional link on items; entries in several projects (project_id stays the main one,
  // entry_projects holds the others).
  `
  ALTER TABLE items ADD COLUMN url TEXT NOT NULL DEFAULT '';
  CREATE TABLE entry_projects (
    entry_id INTEGER NOT NULL REFERENCES entries ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects ON DELETE CASCADE,
    PRIMARY KEY (entry_id, project_id)
  );
  CREATE INDEX entry_projects_project ON entry_projects(project_id);
  `,
  // v6: contacts' time slot; colours picked by hand (hue 0..359) for projects and categories.
  `
  ALTER TABLE contacts ADD COLUMN timeslot TEXT NOT NULL DEFAULT '';
  ALTER TABLE projects ADD COLUMN hue INTEGER;
  CREATE TABLE category_colors (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    hue INTEGER NOT NULL
  );
  `,
  // v7: workspaces. Each workspace's users table becomes a copy of its members (names and role) for foreign keys
  // and names; passwords and sessions live in accounts.db. member = 0: former member.
  `
  ALTER TABLE users ADD COLUMN member INTEGER NOT NULL DEFAULT 1;
  `,
  // v8: item status: '' active, 'outdated' superseded, 'discarded' (evaluated and then dropped).
  // Since 0.20.5 also 'evaluation' (being evaluated), without changing the schema.
  `
  ALTER TABLE items ADD COLUMN status TEXT NOT NULL DEFAULT '';
  `,
  // v9: workspace chat. Links live in the text: #CODE, @project, [[doc:12]], [[voce:34]], [[contatto:5]].
  // chat_read_id: the last message read by each person (for the unread count).
  `
  CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at TEXT,
    deleted_at TEXT
  );
  ALTER TABLE users ADD COLUMN chat_read_id INTEGER NOT NULL DEFAULT 0;
  `,
  // v10: links written in entries, for backlinks: [[doc:ID]] [[voce:ID]] [[contatto:ID]] [[progetto:ID]]
  // and, in mails, inventory codes written without # (kind 'articolo'). Computed again at every text change.
  `
  CREATE TABLE entry_links (
    entry_id INTEGER NOT NULL REFERENCES entries ON DELETE CASCADE,
    kind TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    PRIMARY KEY (entry_id, kind, target_id)
  );
  CREATE INDEX entry_links_target ON entry_links(kind, target_id);
  `,
  // v11: document kinds added by the workspace (besides the built-in ones) and mails awaiting a reply.
  `
  CREATE TABLE doc_kinds (
    name TEXT PRIMARY KEY,
    created_by INTEGER REFERENCES users ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  ALTER TABLE entries ADD COLUMN awaiting_reply INTEGER NOT NULL DEFAULT 0;
  `,
  // v12: colour picked for a contact (hue 0..359; NULL = automatic from the address).
  `
  ALTER TABLE contacts ADD COLUMN hue INTEGER;
  `,
  // v13: items' alternative codes (besides the main code, by which the item is known).
  // Each code, main or alternative, belongs to one item only.
  `
  CREATE TABLE item_aliases (
    code TEXT PRIMARY KEY COLLATE NOCASE,
    item_id INTEGER NOT NULL REFERENCES items ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  CREATE INDEX item_aliases_item ON item_aliases(item_id);
  `,
  // v14: notes on 3D models. The point is x, y, z (0..1 in the box containing the model), with page = 1.
  `
  ALTER TABLE doc_notes ADD COLUMN z REAL;
  `,
  // v15: mail with the Thunderbird extension (server/thunderbird.js). mail_outbox: the mails to open in
  // Thunderbird; mail_messages: the conversations' messages (sent and replies received), tied to the Organizer
  // mail they belong to. A mail written as a reply has mail_thread (the conversation's first mail) and reply_to
  // (the message it replies to).
  `
  CREATE TABLE mail_outbox (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES entries ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    claimed_at TEXT
  );
  CREATE TABLE mail_messages (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES entries ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('out', 'in')),
    message_id TEXT NOT NULL UNIQUE,
    from_addr TEXT NOT NULL DEFAULT '',
    to_addr TEXT NOT NULL DEFAULT '',
    cc TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    date TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX mail_messages_entry ON mail_messages(entry_id);
  ALTER TABLE entries ADD COLUMN mail_thread INTEGER REFERENCES entries ON DELETE SET NULL;
  ALTER TABLE entries ADD COLUMN reply_to INTEGER REFERENCES mail_messages ON DELETE SET NULL;
  `,
  // v16: everything is private to whoever creates it, except inventory and documents. Entries, projects, contacts
  // and notes on documents are shared with some people (shares) or with everyone (shared_all). The private column
  // no longer counts. Earlier data becomes private to whoever created it (whoever had an entry assigned still sees
  // it); what has no author any more stays everyone's.
  // Channel chat: "everyone" = all workspace members read and write, otherwise chat_members (can_write 0 =
  // read-only). chat_reads: the last message read per channel. The earlier chat becomes "general".
  `
  CREATE TABLE shares (
    kind TEXT NOT NULL CHECK (kind IN ('entry', 'project', 'contact', 'docnote')),
    obj_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    PRIMARY KEY (kind, obj_id, user_id)
  );
  CREATE INDEX shares_user ON shares(user_id, kind);
  ALTER TABLE entries ADD COLUMN shared_all INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE projects ADD COLUMN shared_all INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE contacts ADD COLUMN shared_all INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE doc_notes ADD COLUMN shared_all INTEGER NOT NULL DEFAULT 0;
  UPDATE entries SET shared_all = 1 WHERE created_by IS NULL;
  UPDATE projects SET shared_all = 1 WHERE created_by IS NULL;
  UPDATE contacts SET shared_all = 1 WHERE created_by IS NULL;
  UPDATE doc_notes SET shared_all = 1 WHERE created_by IS NULL;

  CREATE TABLE chat_channels (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    everyone INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE TABLE chat_members (
    channel_id INTEGER NOT NULL REFERENCES chat_channels ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    can_write INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE TABLE chat_reads (
    channel_id INTEGER NOT NULL REFERENCES chat_channels ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
  );
  ALTER TABLE chat_messages ADD COLUMN channel_id INTEGER REFERENCES chat_channels ON DELETE CASCADE;
  INSERT INTO chat_channels (id, name, everyone, created_at) VALUES (1, 'general', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE chat_messages SET channel_id = 1;
  INSERT INTO chat_reads (channel_id, user_id, read_id) SELECT 1, id, chat_read_id FROM users WHERE chat_read_id > 0;
  CREATE INDEX chat_messages_channel ON chat_messages(channel_id, id);
  `,
  // v17: entries created offline in the app. The app generates client_id: if sending is repeated (network dropped
  // halfway) the entry is not created twice.
  `
  ALTER TABLE entries ADD COLUMN client_id TEXT;
  CREATE UNIQUE INDEX entries_client ON entries(created_by, client_id) WHERE client_id IS NOT NULL;
  `,
  // v18: muted channels (per person): no notification for every message, only for mentions.
  `
  ALTER TABLE chat_reads ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
  `,
  // v19: mail threads. A thread (personal, of owner_id) gathers the messages received and sent and the mails
  // written in Organizer (entries.thread_id); active until archived. mail_thread_links: the links picked by hand
  // or found in the messages (inventory codes); those mentioned in mails written in Organizer come from
  // entry_links. Messages now belong to the thread (entry_id only for those sent from an Organizer mail);
  // read_at for the received ones. The earlier conversations become threads: a sent mail not awaiting a reply
  // ends up among the archived ones.
  steps(`
  CREATE TABLE mail_threads (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    subject TEXT NOT NULL DEFAULT '',
    archived_at TEXT,
    last_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX mail_threads_owner ON mail_threads(owner_id, last_at);
  CREATE TABLE mail_thread_links (
    thread_id INTEGER NOT NULL REFERENCES mail_threads ON DELETE CASCADE,
    kind TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    auto INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (thread_id, kind, target_id)
  );
  ALTER TABLE entries ADD COLUMN thread_id INTEGER REFERENCES mail_threads ON DELETE SET NULL;

  INSERT INTO mail_threads (id, owner_id, subject, archived_at, last_at, created_at)
    SELECT e.id, e.created_by, COALESCE(NULLIF(e.mail_subject, ''), e.title),
      CASE WHEN e.done_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entries x WHERE (x.id = e.id OR x.mail_thread = e.id)
        AND x.kind = 'mail' AND x.deleted_at IS NULL AND (x.done_at IS NULL OR x.awaiting_reply = 1)) THEN e.done_at END,
      COALESCE((SELECT MAX(m.date) FROM mail_messages m JOIN entries x ON x.id = m.entry_id WHERE x.id = e.id OR x.mail_thread = e.id), e.updated_at),
      e.created_at
    FROM entries e WHERE e.kind = 'mail' AND e.mail_thread IS NULL AND e.created_by IS NOT NULL;
  UPDATE entries SET thread_id = COALESCE(mail_thread, id) WHERE kind = 'mail' AND COALESCE(mail_thread, id) IN (SELECT id FROM mail_threads);

  CREATE TABLE mail_messages_v19 (
    id INTEGER PRIMARY KEY,
    thread_id INTEGER NOT NULL REFERENCES mail_threads ON DELETE CASCADE,
    entry_id INTEGER REFERENCES entries ON DELETE SET NULL,
    direction TEXT NOT NULL CHECK (direction IN ('out', 'in')),
    message_id TEXT NOT NULL,
    from_addr TEXT NOT NULL DEFAULT '',
    to_addr TEXT NOT NULL DEFAULT '',
    cc TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    date TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (thread_id, message_id)
  );
  INSERT INTO mail_messages_v19 (id, thread_id, entry_id, direction, message_id, from_addr, to_addr, cc, subject, body, attachments, date, read_at, created_at)
    SELECT m.id, e.thread_id, CASE WHEN m.direction = 'out' THEN m.entry_id END, m.direction, m.message_id, m.from_addr, m.to_addr, m.cc, m.subject,
      m.body, m.attachments, m.date, m.created_at, m.created_at
    FROM mail_messages m JOIN entries e ON e.id = m.entry_id WHERE e.thread_id IS NOT NULL;
  -- Dropping the old table SQLite clears entries.reply_to (ON DELETE SET NULL): save it and put it back.
  CREATE TEMP TABLE keep_reply AS SELECT id, reply_to FROM entries WHERE reply_to IS NOT NULL;
  DROP TABLE mail_messages;
  ALTER TABLE mail_messages_v19 RENAME TO mail_messages;
  UPDATE entries SET reply_to = (SELECT k.reply_to FROM keep_reply k WHERE k.id = entries.id)
    WHERE id IN (SELECT id FROM keep_reply) AND (SELECT k.reply_to FROM keep_reply k WHERE k.id = entries.id) IN (SELECT id FROM mail_messages);
  DROP TABLE keep_reply;
  CREATE INDEX mail_messages_thread ON mail_messages(thread_id, date);
  CREATE INDEX mail_messages_mid ON mail_messages(message_id);
  `, conn => {
    // Threads born from earlier mails take the subject without "Re:", "R:", "Fwd:"… (like cleanSubject).
    const re = /^\s*((re|r|fw|fwd|i|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i;
    const set = conn.prepare('UPDATE mail_threads SET subject = ? WHERE id = ?');
    for (const t of conn.prepare('SELECT id, subject FROM mail_threads').all()) {
      const s = t.subject.replace(re, '').trim();
      if (s && s !== t.subject) set.run(s, t.id);
    }
  }),
  // v20: threads in the trash. When deleted, it takes along the mails written in Organizer that belong to it (same
  // deleted_at): they are restored together.
  `
  ALTER TABLE mail_threads ADD COLUMN deleted_at TEXT;
  ALTER TABLE mail_threads ADD COLUMN deleted_by INTEGER;
  `,
  // v21: mail by topic. A topic (personal) gathers one or more conversations (mail_threads), each with star and
  // colour; the mail tree comes from in_reply_to and refs (References). Links removed by hand stay as hidden: they
  // do not come back. Starting over: only threads with mails written in Organizer stay (each in its own topic);
  // the rest is loaded again by the Thunderbird extension (the last month).
  `
  CREATE TABLE mail_topics (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    hue INTEGER,
    starred INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX mail_topics_owner ON mail_topics(owner_id);
  ALTER TABLE mail_threads ADD COLUMN topic_id INTEGER REFERENCES mail_topics ON DELETE SET NULL;
  ALTER TABLE mail_threads ADD COLUMN hue INTEGER;
  ALTER TABLE mail_threads ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE mail_messages ADD COLUMN in_reply_to TEXT NOT NULL DEFAULT '';
  ALTER TABLE mail_messages ADD COLUMN refs TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE mail_thread_links ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
  DELETE FROM mail_threads WHERE id NOT IN (SELECT thread_id FROM entries WHERE thread_id IS NOT NULL);
  INSERT INTO mail_topics (id, owner_id, title, created_at) SELECT id, owner_id, subject, created_at FROM mail_threads;
  UPDATE mail_threads SET topic_id = id;
  `,
  // v22: a topic can be linked too (to a project, an item…), besides its conversations.
  `
  CREATE TABLE mail_topic_links (
    topic_id INTEGER NOT NULL REFERENCES mail_topics ON DELETE CASCADE,
    kind TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    PRIMARY KEY (topic_id, kind, target_id)
  );
  `,
  // v23: notes on a piece of a PDF's text: quote is the selected text, marks the highlighted boxes
  // (JSON [[page, x, y, w, h], …] in 0..1); page/x/y stay the pin, at the end of the first line.
  `
  ALTER TABLE doc_notes ADD COLUMN quote TEXT;
  ALTER TABLE doc_notes ADD COLUMN marks TEXT;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

// Brings a database (the one in use or a backup to restore) to the latest schema version.
export function migrate(conn) {
  const { user_version: version } = conn.prepare('PRAGMA user_version').get();
  for (let i = version; i < MIGRATIONS.length; i++) {
    conn.exec('BEGIN');
    try {
      const m = MIGRATIONS[i];
      if (typeof m === 'function') m(conn);
      else conn.exec(m);
      conn.exec(`PRAGMA user_version = ${i + 1}`);
      conn.exec('COMMIT');
    } catch (e) {
      conn.exec('ROLLBACK');
      throw e;
    }
  }
}

const als = new AsyncLocalStorage();
const opened = new Map(); // file → connection

export function openDataDb(file) {
  if (!opened.has(file)) {
    const conn = openSqlite(file);
    migrate(conn);
    opened.set(file, conn);
  }
  return opened.get(file);
}

// Runs fn with `db` pointing to the database of workspace ws ({ id, file }).
export const withWorkspace = (ws, fn) => als.run({ ws: ws.id, db: openDataDb(ws.file) }, fn);
export const currentWorkspace = () => als.getStore()?.ws ?? null;

export const db = new Proxy({}, {
  get(_, key) {
    const conn = als.getStore()?.db;
    if (!conn) throw new Error('No active workspace for this operation');
    const v = conn[key];
    return typeof v === 'function' ? v.bind(conn) : v;
  },
});

export function closeAll() {
  for (const conn of opened.values()) conn.close();
  opened.clear();
}

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
