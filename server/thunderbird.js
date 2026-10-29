// Ponte con l'estensione di Thunderbird (cartella thunderbird/). Organizer non conosce le password della posta:
// è Thunderbird che apre le mail, le invia e le riceve. L'estensione si autentica con un token API e
//  - tiene aperto /api/mail/stream: il server sa che c'è e la avvisa quando c'è una mail da aprire;
//  - prende dalla coda (mail_outbox) le mail da aprire, allegati compresi, anche come risposta a un messaggio;
//  - segnala le mail inviate (diventano "mandate", con il loro Message-ID) e le risposte che arrivano a una
//    conversazione seguita (la mail esce da "in attesa di risposta").
// Le mail stanno in thread personali (maildata.js): ricevute, mandate e scritte in Organizer. Quando arriva o
// parte una risposta a mail che Organizer non ha, il server le chiede all'estensione (missing) per completare
// il thread. Le chiamate dell'estensione valgono per tutti i workspace dell'utente: il server cerca in ognuno.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, tx, withWorkspace } from './db.js';
import { acc, workspacesOf, workspaceById, permsIn, mailAddressesOf, defaultWorkspace } from './accounts.js';
import { route, entryFor, updateEntry, addLog, insertId, syncEntryItems, docKind, CVIS_ANY } from './api.js';
import { newThread, ensureEntryThread, touchThread, autoLink, findThread, dropEmptyTopics, ensureTopic } from './maildata.js';
import { mailParts, sendFile } from './mail.js';
import { allows } from './perms.js';
import { bump, mailExtOn, openMailExtStream, notifyMailExt } from './events.js';
import { zip } from './zip.js';
import { notify } from './notify.js';
import { fail, now, str, isHttps } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTBOX_HOURS = 2; // una richiesta non presa entro questo tempo si lascia perdere
const WATCH_DAYS = 365; // conversazioni seguite: i messaggi dell'ultimo anno

// Message-ID senza parentesi angolari (Thunderbird li dà così).
const cleanId = s => str(s, 500).replace(/^<|>$/g, '');
const emailOf = s => (String(s || '').match(/<([^>]+)>/)?.[1] || String(s || '')).trim();
const emailsOf = s => String(s || '').split(',').map(emailOf).filter(a => a.includes('@'));
const re = s => (/^re:/i.test(s) ? s : `Re: ${s}`);

// Allegati di una mail ricevuta: nome, parte del messaggio (per farsi dare il file da Thunderbird), dimensione e tipo.
// Le prime versioni dell'estensione mandavano solo il nome.
const cleanAttachments = list => JSON.stringify((Array.isArray(list) ? list : []).slice(0, 50).map(a => (typeof a === 'string'
  ? { name: str(a, 255) }
  : { name: str(a?.name, 255) || 'allegato', part: str(a?.part, 50) || null, size: Number(a?.size) || null, type: str(a?.type, 100) || null })));

// L'utente come lo vedrebbe una richiesta dell'app in quel workspace (ruolo e permessi di lì).
function asMember(user, ws, role) {
  return { ...user, workspace_id: ws.id, is_admin: role === 'admin' ? 1 : 0, perms: permsIn(ws.id, user.id) };
}

// I workspace in cui l'utente può usare le mail al livello chiesto, con l'utente "di quel workspace".
function mailWorkspaces(user, level) {
  return workspacesOf(user.id).map(w => [workspaceById(w.id), w.role])
    .filter(([ws]) => ws)
    .map(([ws, role]) => ({ ws, u: asMember(user, ws, role) }))
    .filter(({ u }) => allows(u.perms, 'mail', level));
}

function inWorkspace(user, wsId, level, fn) {
  const hit = mailWorkspaces(user, level).find(x => x.ws.id === +wsId) || fail(404, 'Workspace non trovato');
  return withWorkspace(hit.ws, () => fn(hit.u, hit.ws));
}

// ---------- dall'app ----------
// "Manda" quando l'estensione è collegata: la mail va in coda e Thunderbird la apre.
route('POST', '/api/entries/:id/compose', ({ params, user }) => {
  const e = entryFor(params.id, user, 'read');
  if (e.kind !== 'mail') fail(400, 'Non è una mail');
  if (!mailExtOn(user.id)) fail(409, 'Thunderbird non è collegato: aprilo e controlla l\'estensione Organizer');
  tx(() => {
    db.prepare('DELETE FROM mail_outbox WHERE entry_id = ? AND user_id = ? AND claimed_at IS NULL').run(e.id, user.id);
    db.prepare('INSERT INTO mail_outbox (entry_id, user_id, created_at) VALUES (?, ?, ?)').run(e.id, user.id, now());
  });
  notifyMailExt(user.id, 'outbox');
}, { area: 'mail', level: 'read', quiet: true });

// ---------- thread ----------
const parseMsg = m => ({ ...m, attachments: JSON.parse(m.attachments || '[]') });
const getThread = (id, user) => db.prepare('SELECT * FROM mail_threads WHERE id = ? AND owner_id = ? AND deleted_at IS NULL').get(+id, user.id) || fail(404, 'Thread non trovato');

const fullThread = t => ({
  ...t,
  messages: db.prepare('SELECT * FROM mail_messages WHERE thread_id = ? ORDER BY date, id').all(t.id).map(parseMsg),
  entries: db.prepare('SELECT id FROM entries WHERE thread_id = ? AND deleted_at IS NULL ORDER BY id').all(t.id).map(r => r.id),
});
const getTopic = (id, user) => db.prepare('SELECT * FROM mail_topics WHERE id = ? AND owner_id = ?').get(+id, user.id) || fail(404, 'Topic non trovato');
const hueOf = v => (v === null || v === '' ? null : Math.max(0, Math.min(359, Math.round(+v) || 0)));
// Le notifiche di un thread portano al suo topic (#/t/topic?th=thread): lette anche quelle.
const readNotifications = (user, t, at) => acc.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL
  AND (url = ? OR url LIKE ?)`).run(at, user.id, `#/t/${t.id}`, `#/t/%th=${t.id}`);

// Il thread con i messaggi interi (dal più vecchio) e le mail scritte in Organizer che ne fanno parte.
route('GET', '/api/mail/threads/:id', ({ params, user }) => fullThread(getThread(params.id, user)), { area: 'mail' });

// Il topic con tutte le sue conversazioni (archiviate comprese), messaggi interi.
route('GET', '/api/mail/topics/:id', ({ params, user }) => {
  const topic = getTopic(params.id, user);
  const threads = db.prepare('SELECT * FROM mail_threads WHERE topic_id = ? AND deleted_at IS NULL ORDER BY created_at').all(topic.id);
  return { ...topic, threads: threads.map(fullThread) };
}, { area: 'mail' });

// Una conversazione: letta (i messaggi ricevuti), archiviata o di nuovo attiva (archiviare la segna letta),
// rinominata, con stella e colore (hue null = automatico), spostata in un altro topic (topic: id, o "new").
route('PATCH', '/api/mail/threads/:id', async ({ params, user, body }) => {
  const b = await body();
  const t = getThread(params.id, user);
  const at = now();
  tx(() => {
    if (b.read !== undefined || b.archived) {
      db.prepare(`UPDATE mail_messages SET read_at = ${b.read === false ? 'NULL' : 'COALESCE(read_at, ?)'} WHERE thread_id = ? AND direction = 'in'`)
        .run(...(b.read === false ? [t.id] : [at, t.id]));
    }
    if (b.archived !== undefined) db.prepare('UPDATE mail_threads SET archived_at = ? WHERE id = ?').run(b.archived ? at : null, t.id);
    if (b.subject !== undefined) db.prepare('UPDATE mail_threads SET subject = ? WHERE id = ?').run(str(b.subject, 300) || t.subject, t.id);
    if (b.starred !== undefined) db.prepare('UPDATE mail_threads SET starred = ? WHERE id = ?').run(b.starred ? 1 : 0, t.id);
    if (b.hue !== undefined) db.prepare('UPDATE mail_threads SET hue = ? WHERE id = ?').run(hueOf(b.hue), t.id);
    if (b.topic !== undefined) {
      const to = b.topic === 'new' ? null : getTopic(b.topic, user).id;
      db.prepare('UPDATE mail_threads SET topic_id = ? WHERE id = ?').run(to, t.id);
      ensureTopic(t.id);
      dropEmptyTopics(user.id);
    }
  });
  if (b.read || b.archived) readNotifications(user, t, at);
  return { topic: db.prepare('SELECT topic_id FROM mail_threads WHERE id = ?').get(t.id).topic_id };
}, { area: 'mail' });

// Un topic: titolo, stella, colore.
route('PATCH', '/api/mail/topics/:id', async ({ params, user, body }) => {
  const b = await body();
  const t = getTopic(params.id, user);
  if (b.title !== undefined) db.prepare('UPDATE mail_topics SET title = ? WHERE id = ?').run(str(b.title, 300) || t.title, t.id);
  if (b.starred !== undefined) db.prepare('UPDATE mail_topics SET starred = ? WHERE id = ?').run(b.starred ? 1 : 0, t.id);
  if (b.hue !== undefined) db.prepare('UPDATE mail_topics SET hue = ? WHERE id = ?').run(hueOf(b.hue), t.id);
}, { area: 'mail' });

// Unire: tutte le conversazioni del topic passano in un altro (questo sparisce).
route('POST', '/api/mail/topics/:id/merge', async ({ params, user, body }) => {
  const from = getTopic(params.id, user);
  const into = getTopic((await body()).into, user);
  if (from.id === into.id) return;
  tx(() => {
    db.prepare('UPDATE mail_threads SET topic_id = ? WHERE topic_id = ?').run(into.id, from.id);
    db.prepare('INSERT OR IGNORE INTO mail_topic_links (topic_id, kind, target_id) SELECT ?, kind, target_id FROM mail_topic_links WHERE topic_id = ?').run(into.id, from.id);
    dropEmptyTopics(user.id);
  });
}, { area: 'mail' });

// Ricerca nella posta della persona (per "[[" e per il filtro): le conversazioni in cui ogni parola si trova in
// un messaggio (oggetto, testo intero, indirizzi e nomi), nell'oggetto della conversazione o nel titolo del suo
// topic. Una parola che è il nome di un contatto in rubrica cerca anche i suoi indirizzi.
route('GET', '/api/mail/search', ({ user, query }) => {
  const words = String(query.q || '').toLowerCase().split(/\s+/).filter(w => w.length >= 2).slice(0, 8);
  if (!words.length) return [];
  const like = w => `%${w.replace(/[\\%_]/g, m => `\\${m}`)}%`;
  let ids = null;
  for (const w of words) {
    const emails = db.prepare(`SELECT lower(c.email) AS e FROM contacts c WHERE c.deleted_at IS NULL AND c.email != '' AND ${CVIS_ANY}
      AND lower(c.name) LIKE $w ESCAPE '\\'`).all({ uid: user.id, w: like(w) }).map(r => r.e);
    const found = new Set(db.prepare(`SELECT t.id FROM mail_threads t LEFT JOIN mail_topics p ON p.id = t.topic_id
      WHERE t.owner_id = ? AND t.deleted_at IS NULL AND (lower(t.subject) LIKE ? ESCAPE '\\' OR lower(p.title) LIKE ? ESCAPE '\\'
        OR t.id IN (SELECT thread_id FROM mail_messages WHERE lower(subject || ' ' || from_addr || ' ' || to_addr || ' ' || cc || ' ' || body) LIKE ? ESCAPE '\\'
          ${emails.map(() => "OR lower(from_addr || ' ' || to_addr || ' ' || cc) LIKE ?").join(' ')}))`)
      .all(user.id, like(w), like(w), like(w), ...emails.map(e => `%${e}%`)).map(r => r.id));
    ids = ids ? new Set([...ids].filter(id => found.has(id))) : found;
    if (!ids.size) return [];
  }
  return db.prepare(`SELECT id FROM mail_threads WHERE id IN (SELECT value FROM json_each(?)) ORDER BY last_at DESC LIMIT 30`)
    .all(JSON.stringify([...ids])).map(r => r.id);
}, { area: 'mail', quiet: true });

// Un messaggio letto o da leggere (aprirlo nell'albero lo legge).
route('PATCH', '/api/mail/messages/:id', async ({ params, user, body }) => {
  const b = await body();
  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(+params.id) || fail(404, 'Messaggio non trovato');
  const t = getThread(m.thread_id, user);
  if (b.read !== undefined) db.prepare('UPDATE mail_messages SET read_at = ? WHERE id = ?').run(b.read ? m.read_at || now() : null, m.id);
  if (b.read && !db.prepare("SELECT 1 FROM mail_messages WHERE thread_id = ? AND direction = 'in' AND read_at IS NULL").get(t.id)) readNotifications(user, t, now());
}, { area: 'mail' });

// Nel cestino, con le mail scritte in Organizer che ne fanno parte (tornano insieme con Ripristina). In
// Thunderbird le mail restano; se le ripassa, i messaggi già visti non riaprono il thread.
route('DELETE', '/api/mail/threads/:id', ({ params, user }) => {
  const t = getThread(params.id, user);
  const at = now();
  tx(() => trashThread(t, user, at));
  readNotifications(user, t, at);
}, { area: 'mail' });

function trashThread(t, user, at) {
  db.prepare('UPDATE mail_threads SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(at, user.id, t.id);
  db.prepare('UPDATE entries SET deleted_at = ?, deleted_by = ? WHERE thread_id = ? AND deleted_at IS NULL').run(at, user.id, t.id);
  dropEmptyTopics(user.id);
}

// Un topic nel cestino: ogni sua conversazione ci va (e si ripristina da sola, in un topic nuovo).
route('DELETE', '/api/mail/topics/:id', ({ params, user }) => {
  const topic = getTopic(params.id, user);
  const at = now();
  const threads = db.prepare('SELECT * FROM mail_threads WHERE topic_id = ? AND deleted_at IS NULL').all(topic.id);
  tx(() => { for (const t of threads) trashThread(t, user, at); });
  for (const t of threads) readNotifications(user, t, at);
}, { area: 'mail' });

// Collegamenti scelti a mano: articoli, documenti, progetti, contatti, voci (come i [[…]] e i #codici).
const THREAD_LINK = { articolo: 'items', doc: 'documents', progetto: 'projects', contatto: 'contacts', voce: 'entries', mail: 'mail_threads' };
route('POST', '/api/mail/threads/:id/links', async ({ params, user, body }) => {
  const b = await body();
  const t = getThread(params.id, user);
  const table = THREAD_LINK[b.kind] || fail(400, 'Tipo di collegamento non valido');
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(+b.id)) fail(404, 'Elemento non trovato');
  db.prepare('INSERT INTO mail_thread_links (thread_id, kind, target_id) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET auto = 0, hidden = 0').run(t.id, b.kind, +b.id);
}, { area: 'mail' });

// Collegamenti del topic intero (es. al suo progetto), oltre a quelli delle conversazioni.
route('POST', '/api/mail/topics/:id/links', async ({ params, user, body }) => {
  const b = await body();
  const t = getTopic(params.id, user);
  const table = THREAD_LINK[b.kind] || fail(400, 'Tipo di collegamento non valido');
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(+b.id)) fail(404, 'Elemento non trovato');
  db.prepare('INSERT OR IGNORE INTO mail_topic_links (topic_id, kind, target_id) VALUES (?, ?, ?)').run(t.id, b.kind, +b.id);
}, { area: 'mail' });

route('DELETE', '/api/mail/topics/:id/links/:kind/:target', ({ params, user }) => {
  const t = getTopic(params.id, user);
  db.prepare('DELETE FROM mail_topic_links WHERE topic_id = ? AND kind = ? AND target_id = ?').run(t.id, params.kind, +params.target);
}, { area: 'mail' });

// Togliere un collegamento, anche automatico o citato in una mail scritta qui: resta nascosto e non torna.
route('DELETE', '/api/mail/threads/:id/links/:kind/:target', ({ params, user }) => {
  const t = getThread(params.id, user);
  if (!THREAD_LINK[params.kind]) fail(400, 'Tipo di collegamento non valido');
  db.prepare(`INSERT INTO mail_thread_links (thread_id, kind, target_id, auto, hidden) VALUES (?, ?, ?, 1, 1)
    ON CONFLICT DO UPDATE SET hidden = 1`).run(t.id, params.kind, +params.target);
}, { area: 'mail' });

// ---------- risposte ----------
// Destinatari di una risposta: chi ha scritto (o, a un messaggio mandato da noi, a chi era andato); "a tutti"
// aggiunge in Cc gli altri destinatari, tranne i nostri indirizzi (quelli delle identità di Thunderbird).
function replyAddresses(m, all, userId) {
  const own = new Set(mailAddressesOf(userId).map(a => a.toLowerCase()));
  const to = m.direction === 'out' ? emailsOf(m.to_addr) : emailsOf(m.from_addr);
  const seen = new Set([...own, ...to.map(a => a.toLowerCase())]);
  const cc = !all ? [] : [...emailsOf(m.to_addr), ...emailsOf(m.cc)].filter(a => {
    const k = a.toLowerCase();
    return !seen.has(k) && seen.add(k);
  });
  return { contact: to.join(', ') || null, mail_cc: cc.join(', ') || null };
}

// La mail di risposta in Organizer, nel thread (si scrive lì, poi "Manda" la apre in Thunderbird come
// risposta). Senza passare dalla riga rapida: un oggetto con "@" o "!" non deve diventare un progetto o una
// scadenza. I progetti sono quelli delle altre mail del thread.
function insertReply(user, t, f) {
  const at = now();
  const last = db.prepare('SELECT id, title, project_id FROM entries WHERE thread_id = ? AND deleted_at IS NULL ORDER BY id DESC').get(t.id);
  const id = insertId(db.prepare(`INSERT INTO entries (kind, title, contact, mail_cc, mail_subject, project_id, thread_id, reply_to, created_by, created_at, updated_at)
    VALUES ('mail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(str(re(last?.title || t.subject), 1000), f.contact, f.mail_cc, str(f.subject, 300) || null, last?.project_id ?? null, t.id, f.reply_to ?? null, user.id, at, at));
  if (last) db.prepare('INSERT OR IGNORE INTO entry_projects (entry_id, project_id) SELECT ?, project_id FROM entry_projects WHERE entry_id = ?').run(id, last.id);
  syncEntryItems(id, user);
  touchThread(t.id, at);
  return id;
}

// "Rispondi" (o "a tutti") su un messaggio del thread.
route('POST', '/api/mail/messages/:id/reply', async ({ params, user, body }) => {
  const b = await body();
  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(+params.id) || fail(404, 'Messaggio non trovato');
  const t = getThread(m.thread_id, user);
  return { id: tx(() => insertReply(user, t, { subject: re(m.subject || t.subject), reply_to: m.id, ...replyAddresses(m, !!b.all, user.id) })) };
}, { area: 'mail' });

// Una mail nuova nel thread, a chi c'era (senza rispondere a un messaggio preciso).
route('POST', '/api/mail/threads/:id/draft', ({ params, user }) => {
  const t = getThread(params.id, user);
  const last = db.prepare('SELECT * FROM mail_messages WHERE thread_id = ? ORDER BY date DESC').get(t.id);
  return { id: tx(() => insertReply(user, t, { subject: re(t.subject), ...(last ? replyAddresses(last, true, user.id) : { contact: null, mail_cc: null }) })) };
}, { area: 'mail' });

// ---------- posta in arrivo di prima (fino alla v0.14) ----------
// Stava in accounts.db (mail_inbox); ora ogni mail è in un thread del workspace della posta. Si sposta una volta.
export function migrateInbox() {
  const users = acc.prepare('SELECT DISTINCT user_id FROM mail_inbox').all().map(r => r.user_id);
  for (const uid of users) {
    const wsId = defaultWorkspace(uid);
    const ws = wsId && workspaceById(wsId);
    if (!ws) continue;
    const rows = acc.prepare('SELECT * FROM mail_inbox WHERE user_id = ? AND archived_at IS NULL ORDER BY date').all(uid);
    withWorkspace(ws, () => tx(() => {
      for (const m of rows) {
        if (db.prepare('SELECT 1 FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id WHERE t.owner_id = ? AND m.message_id = ?').get(uid, m.message_id)) continue;
        // Lette = già viste: si mettono tra gli archiviati, come stavano nell'Archivio di prima.
        const tid = newThread(uid, m.subject, m.date);
        db.prepare(`INSERT INTO mail_messages (thread_id, direction, message_id, from_addr, to_addr, cc, subject, body, attachments, date, read_at, created_at)
          VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(tid, m.message_id, m.from_addr, m.to_addr, m.cc, m.subject, m.body, m.attachments, m.date, m.read_at, now());
        if (m.read_at) db.prepare('UPDATE mail_threads SET archived_at = ? WHERE id = ?').run(m.read_at, tid);
        autoLink(tid, uid, `${m.subject} ${m.body}`);
      }
    }));
    acc.prepare('DELETE FROM mail_inbox WHERE user_id = ?').run(uid);
  }
}

// Gli indirizzi delle identità di Thunderbird (l'estensione li manda quando si collega).
route('POST', '/api/mail/identities', async ({ user, body }) => {
  const b = await body();
  const list = (Array.isArray(b.addresses) ? b.addresses : []).map(a => emailOf(str(a, 300))).filter(a => a.includes('@')).slice(0, 50);
  acc.prepare('UPDATE users SET mail_addresses = ? WHERE id = ?').run(JSON.stringify([...new Set(list)]), user.id);
}, { ws: false, quiet: true });

// ---------- dall'estensione ----------
route('GET', '/api/mail/stream', ({ req, res, user }) => openMailExtStream(req, res, user), { ws: false });

// Il pacchetto dell'estensione, già configurato per questo server (indirizzo e permesso di collegarsi qui).
route('GET', '/api/mail/thunderbird.xpi', ({ req, res }) => {
  const origin = `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
  const dir = path.join(ROOT, 'thunderbird');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.permissions.push(`${origin}/*`);
  const files = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { name: 'config.json', data: Buffer.from(JSON.stringify({ server: origin })) },
    { name: 'icon.png', data: fs.readFileSync(path.join(ROOT, 'public/icons/icon-192.png')) },
    ...['background.js', 'options.html', 'options.js'].map(name => ({ name, data: fs.readFileSync(path.join(dir, name)) })),
  ];
  const data = zip(files);
  res.writeHead(200, {
    'Content-Type': 'application/x-xpinstall',
    'Content-Length': data.length,
    'Content-Disposition': 'attachment; filename="organizer-thunderbird.xpi"',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}, { ws: false });

// Mail da aprire, in tutti i workspace.
route('GET', '/api/mail/outbox', ({ user }) => {
  const since = new Date(Date.now() - OUTBOX_HOURS * 3600e3).toISOString();
  return mailWorkspaces(user, 'read').flatMap(({ ws }) => withWorkspace(ws, () => {
    db.prepare('DELETE FROM mail_outbox WHERE created_at < ?').run(new Date(Date.now() - 864e5).toISOString());
    return db.prepare(`SELECT o.id AS outbox_id, e.* FROM mail_outbox o JOIN entries e ON e.id = o.entry_id AND e.deleted_at IS NULL
      WHERE o.user_id = ? AND o.claimed_at IS NULL AND o.created_at > ? ORDER BY o.id`).all(user.id, since)
      .map(({ outbox_id: id, ...e }) => {
        const p = mailParts(e);
        const reply = e.reply_to && db.prepare('SELECT message_id FROM mail_messages WHERE id = ?').get(e.reply_to)?.message_id;
        return { ws: ws.id, id, to: p.to, cc: p.cc, subject: p.subject, body: p.body, reply_to: reply || null,
          files: p.files.map((f, i) => ({ n: i + 1, name: f.name, mime: f.mime })) };
      });
  }));
}, { ws: false });

const outboxRow = (id, user) => db.prepare('SELECT * FROM mail_outbox WHERE id = ? AND user_id = ?').get(+id, user.id) || fail(404, 'Richiesta non trovata');

// Una sola estensione apre la mail, anche se ne sono collegate due (due computer).
route('POST', '/api/mail/outbox/:ws/:id/claim', ({ params, user }) => inWorkspace(user, params.ws, 'read', () => {
  outboxRow(params.id, user);
  if (!db.prepare('UPDATE mail_outbox SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL').run(now(), +params.id).changes) fail(409, 'Già aperta altrove');
}), { ws: false, quiet: true });

route('GET', '/api/mail/outbox/:ws/:id/file/:n', ({ res, params, user }) => inWorkspace(user, params.ws, 'read', () => {
  const o = outboxRow(params.id, user);
  const f = mailParts(db.prepare('SELECT * FROM entries WHERE id = ?').get(o.entry_id)).files[+params.n - 1] || fail(404, 'Allegato inesistente');
  sendFile(res, f.file, f.name, f.mime);
}), { ws: false });

// Mail inviata da Thunderbird: è "mandata", in attesa di risposta, e il suo Message-ID entra nella conversazione.
route('POST', '/api/mail/sent', async ({ user, body }) => {
  const b = await body();
  const wsId = inWorkspace(user, b.ws, 'write', (u, ws) => {
    const o = outboxRow(b.outbox_id, u);
    const e = entryFor(o.entry_id, u, 'write');
    tx(() => {
      updateEntry(e, { done: true, awaiting: true }, u);
      const tid = ensureEntryThread(e);
      const mid = cleanId(b.message_id);
      const date = str(b.date, 40) || now();
      if (mid) {
        // Nell'albero sta sotto il messaggio a cui risponde.
        const parent = e.reply_to ? db.prepare('SELECT message_id FROM mail_messages WHERE id = ?').get(e.reply_to)?.message_id || '' : '';
        db.prepare(`INSERT OR IGNORE INTO mail_messages (thread_id, entry_id, direction, message_id, in_reply_to, refs, from_addr, to_addr, cc, subject, body, date, read_at, created_at)
          VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(tid, e.id, mid, parent, JSON.stringify(parent ? [parent] : []), str(b.from, 300), str(b.to, 1000) || e.contact || '',
          str(b.cc, 1000) || e.mail_cc || '', str(b.subject, 300), mailParts(e).body, date, now(), now());
      }
      touchThread(tid, date);
      db.prepare('DELETE FROM mail_outbox WHERE id = ?').run(o.id);
      addLog(e.id, u.id, 'mandata da Thunderbird', true);
    });
    return ws.id;
  });
  bump(user.id, wsId);
  notifyMailExt(user.id, 'watch');
}, { ws: false, quiet: true });

// Message-ID delle conversazioni seguite: l'estensione guarda se una mail in arrivo risponde a uno di questi.
route('GET', '/api/mail/watch', ({ user }) => {
  const since = new Date(Date.now() - WATCH_DAYS * 864e5).toISOString();
  return mailWorkspaces(user, 'read').flatMap(({ ws }) => withWorkspace(ws, () =>
    db.prepare(`SELECT m.message_id FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id
      WHERE t.owner_id = ? AND t.deleted_at IS NULL AND m.date > ?`).all(user.id, since).map(r => r.message_id)));
}, { ws: false });

// Una mail di Thunderbird: arrivata, mandata senza passare da Organizer, una vecchia chiesta per completare
// una conversazione (history), una conversazione portata a mano (import) o il primo caricamento dell'ultimo
// mese (backfill). Va nella conversazione giusta, in qualunque workspace (vedi findThread: riferimenti, poi il
// thread indicato dall'estensione, poi oggetto e persone); se non ce n'è una ne apre una nuova (nel suo topic)
// nel workspace della posta (quello predefinito), ma solo con inbox (tutta la posta), import, backfill o
// history. Le vecchie, portate a mano e caricate entrano già lette e senza notifiche; import riporta la
// conversazione tra le attive. Risponde con i Message-ID citati che Organizer non ha: l'estensione li cerca in
// Thunderbird e li manda con history: true.
route('POST', '/api/mail/incoming', async ({ user, body }) => {
  const b = await body();
  const mid = cleanId(b.message_id) || fail(400, 'Manca il Message-ID');
  const inReplyTo = cleanId(b.in_reply_to);
  const refs = [...new Set([...(Array.isArray(b.references) ? b.references : []), b.in_reply_to].map(cleanId).filter(Boolean))].slice(-50);
  const direction = b.direction === 'out' ? 'out' : 'in';
  const history = !!b.history;
  const imported = !!b.import; // scelta a mano in Thunderbird ("Porta il thread in Organizer")
  const backfill = !!b.backfill;
  const quiet = history || imported || backfill;
  const date = str(b.date, 40) || now();
  const spaces = mailWorkspaces(user, 'write');
  const mine = new Set(mailAddressesOf(user.id).map(a => a.toLowerCase()));
  const people = [...new Set([b.from, b.to, b.cc].flatMap(emailsOf).map(a => a.toLowerCase()))].filter(a => !mine.has(a));
  const each = fn => { for (const { ws } of spaces) { const r = withWorkspace(ws, () => fn(ws)); if (r) return r; } return null; };
  // Un messaggio di una conversazione nel cestino è già visto: non la riapre e non ne crea un'altra (a mano sì).
  if (!imported && each(() => db.prepare(`SELECT 1 FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id
    WHERE m.message_id = ? AND t.owner_id = ? AND t.deleted_at IS NOT NULL`).get(mid, user.id))) return { matched: true, thread: null, missing: [] };
  const live = 'SELECT 1 FROM mail_threads t WHERE t.id = m.thread_id AND t.owner_id = ? AND t.deleted_at IS NULL';
  let hit = each(ws => {
    const seen = db.prepare(`SELECT m.id, m.thread_id FROM mail_messages m WHERE m.message_id = ? AND EXISTS (${live})`).get(mid, user.id);
    return seen && { ws, thread: seen.thread_id, seen };
  });
  hit ||= each(ws => { const t = findThread(user.id, { refs }); return t && { ws, thread: t }; });
  if (!hit && b.thread) {
    hit = each(ws => (db.prepare('SELECT 1 FROM mail_threads WHERE id = ? AND owner_id = ? AND deleted_at IS NULL').get(+b.thread, user.id) ? { ws, thread: +b.thread } : null));
  }
  hit ||= each(ws => { const t = findThread(user.id, { subject: b.subject, people, date }); return t && { ws, thread: t }; });
  if (!hit && !b.inbox && !quiet) return { matched: false, missing: [] };
  if (!hit) {
    const ws = spaces.find(x => x.ws.id === defaultWorkspace(user.id))?.ws || spaces[0]?.ws || fail(409, 'Nessun workspace in cui mettere la posta');
    hit = { ws, thread: withWorkspace(ws, () => newThread(user.id, b.subject, date)) };
  }
  const fromName = (String(b.from || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim() || emailOf(b.from) || 'qualcuno');
  const { missing, topic } = withWorkspace(hit.ws, () => {
    tx(() => {
      if (hit.seen) {
        // Già qui (es. da una versione vecchia dell'estensione): si completano i riferimenti per l'albero.
        db.prepare("UPDATE mail_messages SET in_reply_to = ?, refs = ? WHERE id = ? AND refs = '[]'").run(inReplyTo, JSON.stringify(refs), hit.seen.id);
        if (imported) touchThread(hit.thread, date);
        return;
      }
      db.prepare(`INSERT OR IGNORE INTO mail_messages (thread_id, direction, message_id, in_reply_to, refs, from_addr, to_addr, cc, subject, body,
        attachments, date, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(hit.thread, direction, mid, inReplyTo, JSON.stringify(refs),
        str(b.from, 300), str(b.to, 1000), str(b.cc, 1000), str(b.subject, 300), str(b.body, 100000), cleanAttachments(b.attachments), date,
        direction === 'out' || quiet ? now() : null, now());
      // Una risposta nuova (o una conversazione portata a mano) torna tra le attive e chiude le attese.
      touchThread(hit.thread, date, { reactivate: imported || !quiet });
      if (direction === 'in' && !quiet) {
        db.prepare('UPDATE entries SET awaiting_reply = 0, updated_at = ? WHERE thread_id = ? AND awaiting_reply = 1').run(now(), hit.thread);
      }
      autoLink(hit.thread, user.id, `${b.subject || ''} ${b.body || ''}`);
    });
    const have = new Set(db.prepare('SELECT message_id FROM mail_messages WHERE thread_id = ?').all(hit.thread).map(r => r.message_id));
    return { missing: refs.filter(r => !have.has(r)), topic: db.prepare('SELECT topic_id FROM mail_threads WHERE id = ?').get(hit.thread).topic_id };
  });
  // Notifica per le mail appena arrivate (non per la storia, i caricamenti, quelle recuperate al collegamento).
  const fresh = Date.now() - Date.parse(date) < 15 * 60e3;
  if (!hit.seen && direction === 'in' && !quiet && fresh) {
    notify([user.id], { ws: hit.ws.id, kind: 'mail', title: `Mail da ${fromName}`, body: str(b.subject, 300) || '(senza oggetto)', url: `#/t/${topic}?th=${hit.thread}`, tag: `mail-${hit.thread}` });
  }
  bump(user.id, hit.ws.id);
  notifyMailExt(user.id, 'watch');
  return { matched: true, thread: hit.thread, missing };
}, { ws: false, quiet: true });

// Primo collegamento di una persona (o dopo il passaggio ai topic): l'estensione carica l'ultimo mese da tutte le
// cartelle e poi lo dice. since null = già fatto.
route('GET', '/api/mail/backfill', ({ user }) => ({
  since: acc.prepare('SELECT mail_backfill_at FROM users WHERE id = ?').get(user.id)?.mail_backfill_at ? null : new Date(Date.now() - 31 * 864e5).toISOString(),
}), { ws: false });

route('POST', '/api/mail/backfill/done', ({ user }) => {
  acc.prepare('UPDATE users SET mail_backfill_at = ? WHERE id = ?').run(now(), user.id);
}, { ws: false, quiet: true });

// ---------- allegati ricevuti → documenti del magazzino ----------
// Il file sta in Thunderbird: Organizer chiede all'estensione di caricarlo come documento dell'articolo (con la
// stessa API dei caricamenti, nel workspace attivo). Le richieste stanno in memoria: se il server riparte si
// rifanno dall'app.
const fetches = new Map(); // id → richiesta
let fetchSeq = 0;

route('POST', '/api/mail/attachments/save', async ({ user, body }) => {
  const b = await body();
  const it = db.prepare('SELECT id, code FROM items WHERE id = ? AND deleted_at IS NULL').get(+b.item_id) || fail(404, 'Articolo non trovato');
  const src = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(+b.id) || fail(404, 'Messaggio non trovato');
  getThread(src.thread_id, user);
  const att = JSON.parse(src.attachments || '[]')[+b.n];
  if (!att?.part) fail(400, 'Questo allegato non si può prendere: la mail è arrivata con una versione vecchia dell\'estensione');
  if (!mailExtOn(user.id)) fail(409, 'Thunderbird non è collegato: il file è lì, aprilo e riprova');
  const id = ++fetchSeq;
  fetches.set(id, { id, user: user.id, ws: user.workspace_id, item_id: it.id, kind: docKind(b.kind), message_id: src.message_id,
    part: att.part, name: att.name, type: att.type, created: Date.now() });
  notifyMailExt(user.id, 'fetch');
  return { code: it.code };
}, { area: 'documenti', quiet: true });

route('GET', '/api/mail/fetches', ({ user }) => {
  for (const [id, f] of fetches) if (Date.now() - f.created > 3600e3) fetches.delete(id);
  return [...fetches.values()].filter(f => f.user === user.id && !f.claimed).map(({ user: _u, created: _c, ...f }) => f);
}, { ws: false });

route('POST', '/api/mail/fetches/:id/claim', ({ params, user }) => {
  const f = fetches.get(+params.id);
  if (!f || f.user !== user.id) fail(404, 'Richiesta non trovata');
  if (f.claimed) fail(409, 'Già presa');
  f.claimed = true;
}, { ws: false, quiet: true });

route('POST', '/api/mail/fetches/:id/done', ({ params, user }) => {
  const f = fetches.get(+params.id);
  if (f?.user === user.id) fetches.delete(f.id);
}, { ws: false, quiet: true });
