// Database dei dati: uno per workspace (file SQLite separati). Quale usare lo decide la richiesta in corso:
// `db` è un riferimento che punta al database del workspace attivo (AsyncLocalStorage), così il resto
// del server scrive `db.prepare(...)` senza sapere quale workspace sta servendo.
// Utenti, sessioni e appartenenze ai workspace stanno invece in accounts.db (vedi accounts.js).
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads'); // condivisa: i file hanno nomi casuali
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export function openSqlite(file) {
  const conn = new DatabaseSync(path.join(DATA_DIR, file));
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return conn;
}

// Ogni elemento è una migrazione; non modificare quelle già rilasciate, aggiungerne di nuove in coda.
// Una migrazione è SQL, oppure (steps) SQL e poi passi in JS sulla stessa connessione, nella stessa transazione.
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
  // v4: note sui documenti. Con page/x/y è un segnaposto su un punto del file (x, y in 0..1),
  // senza è una nota generale sul file.
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
  // v5: link opzionale sugli articoli; voci in più progetti (project_id resta il principale,
  // entry_projects contiene gli altri).
  `
  ALTER TABLE items ADD COLUMN url TEXT NOT NULL DEFAULT '';
  CREATE TABLE entry_projects (
    entry_id INTEGER NOT NULL REFERENCES entries ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects ON DELETE CASCADE,
    PRIMARY KEY (entry_id, project_id)
  );
  CREATE INDEX entry_projects_project ON entry_projects(project_id);
  `,
  // v6: fascia oraria dei contatti; colori scelti a mano (tinta 0..359) per progetti e categorie.
  `
  ALTER TABLE contacts ADD COLUMN timeslot TEXT NOT NULL DEFAULT '';
  ALTER TABLE projects ADD COLUMN hue INTEGER;
  CREATE TABLE category_colors (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    hue INTEGER NOT NULL
  );
  `,
  // v7: workspace. La tabella users di ogni workspace diventa una copia dei suoi membri (nomi e ruolo)
  // per le chiavi esterne e i nomi; password e sessioni vivono in accounts.db. member = 0: ex membro.
  `
  ALTER TABLE users ADD COLUMN member INTEGER NOT NULL DEFAULT 1;
  `,
  // v8: stato dell'articolo: '' attivo, 'outdated' superato, 'discarded' scartato (valutato e poi lasciato perdere).
  `
  ALTER TABLE items ADD COLUMN status TEXT NOT NULL DEFAULT '';
  `,
  // v9: chat del workspace. I collegamenti stanno nel testo: #CODICE, @progetto, [[doc:12]], [[voce:34]], [[contatto:5]].
  // chat_read_id: l'ultimo messaggio letto da ogni persona (per il numero di non letti).
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
  // v10: collegamenti scritti nelle voci, per i backlink: [[doc:ID]] [[voce:ID]] [[contatto:ID]] [[progetto:ID]]
  // e, nelle mail, i codici di magazzino scritti senza # (kind 'articolo'). Ricalcolati a ogni modifica del testo.
  `
  CREATE TABLE entry_links (
    entry_id INTEGER NOT NULL REFERENCES entries ON DELETE CASCADE,
    kind TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    PRIMARY KEY (entry_id, kind, target_id)
  );
  CREATE INDEX entry_links_target ON entry_links(kind, target_id);
  `,
  // v11: tipi di documento aggiunti dal workspace (oltre a quelli fissi) e mail in attesa di risposta.
  `
  CREATE TABLE doc_kinds (
    name TEXT PRIMARY KEY,
    created_by INTEGER REFERENCES users ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  ALTER TABLE entries ADD COLUMN awaiting_reply INTEGER NOT NULL DEFAULT 0;
  `,
  // v12: colore scelto per un contatto (tinta 0..359; NULL = automatico dall'indirizzo).
  `
  ALTER TABLE contacts ADD COLUMN hue INTEGER;
  `,
  // v13: codici alternativi degli articoli (oltre al codice principale, con cui l'articolo è noto).
  // Ogni codice, principale o alternativo, appartiene a un solo articolo.
  `
  CREATE TABLE item_aliases (
    code TEXT PRIMARY KEY COLLATE NOCASE,
    item_id INTEGER NOT NULL REFERENCES items ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  CREATE INDEX item_aliases_item ON item_aliases(item_id);
  `,
  // v14: note sui modelli 3D. Il punto è x, y, z (0..1 nel riquadro che contiene il modello), con page = 1.
  `
  ALTER TABLE doc_notes ADD COLUMN z REAL;
  `,
  // v15: mail con l'estensione di Thunderbird (server/thunderbird.js). mail_outbox: le mail da aprire in
  // Thunderbird; mail_messages: i messaggi delle conversazioni (mandati e risposte arrivate), legati alla mail
  // di Organizer a cui appartengono. Una mail scritta come risposta ha mail_thread (la prima mail della
  // conversazione) e reply_to (il messaggio a cui risponde).
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
  // v16: tutto è privato di chi lo crea, tranne magazzino e documenti. Voci, progetti, contatti e note sui
  // documenti si condividono con delle persone (shares) o con tutti (shared_all). La colonna private non conta
  // più. I dati di prima diventano privati di chi li ha creati (chi aveva una voce assegnata la vede ancora);
  // ciò che non ha più un autore resta di tutti.
  // Chat a canali: "everyone" = tutti i membri del workspace leggono e scrivono, altrimenti chat_members
  // (can_write 0 = solo lettura). chat_reads: l'ultimo messaggio letto per canale. La chat di prima è "generale".
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
  INSERT INTO chat_channels (id, name, everyone, created_at) VALUES (1, 'generale', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE chat_messages SET channel_id = 1;
  INSERT INTO chat_reads (channel_id, user_id, read_id) SELECT 1, id, chat_read_id FROM users WHERE chat_read_id > 0;
  CREATE INDEX chat_messages_channel ON chat_messages(channel_id, id);
  `,
  // v17: voci create offline nell'app. client_id lo genera l'app: se l'invio si ripete (rete caduta a metà)
  // la voce non si crea due volte.
  `
  ALTER TABLE entries ADD COLUMN client_id TEXT;
  CREATE UNIQUE INDEX entries_client ON entries(created_by, client_id) WHERE client_id IS NOT NULL;
  `,
  // v18: canali silenziati (per persona): niente notifiche per ogni messaggio, solo per le citazioni.
  `
  ALTER TABLE chat_reads ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
  `,
  // v19: mail a thread. Un thread (personale, di owner_id) raccoglie i messaggi ricevuti e mandati e le mail
  // scritte in Organizer (entries.thread_id); attivo finché non lo si archivia. mail_thread_links: i
  // collegamenti scelti a mano o trovati nei messaggi (codici di magazzino); quelli citati nelle mail scritte in
  // Organizer arrivano da entry_links. I messaggi ora appartengono al thread (entry_id solo per quelli mandati
  // da una mail di Organizer); read_at per quelli ricevuti. Le conversazioni di prima diventano thread: una
  // mail mandata che non aspetta risposta finisce tra gli archiviati.
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
  -- Cancellando la tabella vecchia SQLite azzera entries.reply_to (ON DELETE SET NULL): si salva e si rimette.
  CREATE TEMP TABLE keep_reply AS SELECT id, reply_to FROM entries WHERE reply_to IS NOT NULL;
  DROP TABLE mail_messages;
  ALTER TABLE mail_messages_v19 RENAME TO mail_messages;
  UPDATE entries SET reply_to = (SELECT k.reply_to FROM keep_reply k WHERE k.id = entries.id)
    WHERE id IN (SELECT id FROM keep_reply) AND (SELECT k.reply_to FROM keep_reply k WHERE k.id = entries.id) IN (SELECT id FROM mail_messages);
  DROP TABLE keep_reply;
  CREATE INDEX mail_messages_thread ON mail_messages(thread_id, date);
  CREATE INDEX mail_messages_mid ON mail_messages(message_id);
  `, conn => {
    // I thread nati dalle mail di prima prendono l'oggetto senza "Re:", "R:", "Fwd:"… (come cleanSubject).
    const re = /^\s*((re|r|fw|fwd|i|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i;
    const set = conn.prepare('UPDATE mail_threads SET subject = ? WHERE id = ?');
    for (const t of conn.prepare('SELECT id, subject FROM mail_threads').all()) {
      const s = t.subject.replace(re, '').trim();
      if (s && s !== t.subject) set.run(s, t.id);
    }
  }),
  // v20: thread nel cestino. Eliminato, porta con sé le mail scritte in Organizer che ne fanno parte (stesso
  // deleted_at): si ripristinano insieme.
  `
  ALTER TABLE mail_threads ADD COLUMN deleted_at TEXT;
  ALTER TABLE mail_threads ADD COLUMN deleted_by INTEGER;
  `,
  // v21: la posta a topic. Un topic (personale) raccoglie una o più conversazioni (mail_threads), ognuna con
  // stella e colore; l'albero delle mail viene da in_reply_to e refs (References). I collegamenti tolti a mano
  // restano come hidden: non tornano. Si riparte da zero: restano solo i thread con mail scritte in Organizer
  // (ognuno nel suo topic); il resto lo ricarica l'estensione di Thunderbird (l'ultimo mese).
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
  // v22: anche un topic si collega (a un progetto, un articolo…), oltre alle sue conversazioni.
  `
  CREATE TABLE mail_topic_links (
    topic_id INTEGER NOT NULL REFERENCES mail_topics ON DELETE CASCADE,
    kind TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    PRIMARY KEY (topic_id, kind, target_id)
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

// Porta un database (quello in uso o un backup da ripristinare) all'ultima versione dello schema.
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
const opened = new Map(); // file → connessione

export function openDataDb(file) {
  if (!opened.has(file)) {
    const conn = openSqlite(file);
    migrate(conn);
    opened.set(file, conn);
  }
  return opened.get(file);
}

// Esegue fn con `db` che punta al database del workspace ws ({ id, file }).
export const withWorkspace = (ws, fn) => als.run({ ws: ws.id, db: openDataDb(ws.file) }, fn);
export const currentWorkspace = () => als.getStore()?.ws ?? null;

export const db = new Proxy({}, {
  get(_, key) {
    const conn = als.getStore()?.db;
    if (!conn) throw new Error('Nessun workspace attivo per questa operazione');
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
