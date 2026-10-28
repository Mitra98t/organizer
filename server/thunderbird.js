// Ponte con l'estensione di Thunderbird (cartella thunderbird/). Organizer non conosce le password della posta:
// è Thunderbird che apre le mail, le invia e le riceve. L'estensione si autentica con un token API e
//  - tiene aperto /api/mail/stream: il server sa che c'è e la avvisa quando c'è una mail da aprire;
//  - prende dalla coda (mail_outbox) le mail da aprire, allegati compresi, anche come risposta a un messaggio;
//  - segnala le mail inviate (diventano "mandate", con il loro Message-ID) e le risposte che arrivano a una
//    conversazione seguita (la mail esce da "in attesa di risposta").
// Le chiamate dell'estensione valgono per tutti i workspace dell'utente: il server cerca in ognuno.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, tx, withWorkspace } from './db.js';
import { acc, workspacesOf, workspaceById, permsIn, mailAddressesOf } from './accounts.js';
import { route, entryFor, updateEntry, addLog, insertId, syncEntryItems, docKind, VIS_ANY } from './api.js';
import { mailParts, sendFile } from './mail.js';
import { allows } from './perms.js';
import { bump, mailExtOn, openMailExtStream, notifyMailExt } from './events.js';
import { zip } from './zip.js';
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

// Tutta la conversazione di una mail: i messaggi della prima mail e delle risposte scritte in Organizer.
route('GET', '/api/entries/:id/thread', ({ params, user }) => {
  const e = entryFor(params.id, user, 'read');
  const root = e.mail_thread ?? e.id;
  return db.prepare(`SELECT m.* FROM mail_messages m JOIN entries e ON e.id = m.entry_id
    WHERE (e.id = $root OR e.mail_thread = $root) AND e.deleted_at IS NULL AND ${VIS_ANY} ORDER BY m.date, m.id`)
    .all({ root, uid: user.id }).map(m => ({ ...m, attachments: JSON.parse(m.attachments || '[]') }));
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

// La mail di risposta in Organizer (si scrive lì, poi "Manda" la apre in Thunderbird come risposta).
// Senza passare dalla riga rapida: un oggetto con "@" o "!" non deve diventare un progetto o una scadenza.
function insertReply(user, f) {
  const t = now();
  const id = insertId(db.prepare(`INSERT INTO entries (kind, title, contact, mail_cc, mail_subject, project_id, mail_thread, reply_to, created_by, created_at, updated_at)
    VALUES ('mail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(str(f.title, 1000) || 'Risposta', f.contact, f.mail_cc, str(f.subject, 300) || null, f.project_id ?? null, f.thread ?? null, f.reply_to ?? null, user.id, t, t));
  syncEntryItems(id, user);
  return id;
}

// "Rispondi" su un messaggio della conversazione: una mail nuova, nella stessa conversazione e negli stessi progetti.
route('POST', '/api/mail/messages/:id/reply', async ({ params, user, body }) => {
  const b = await body();
  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(+params.id) || fail(404, 'Messaggio non trovato');
  const e0 = entryFor(m.entry_id, user, 'read');
  const id = tx(() => {
    const id = insertReply(user, { title: re(e0.title), subject: re(m.subject || e0.mail_subject || e0.title), project_id: e0.project_id,
      thread: e0.mail_thread ?? e0.id, reply_to: m.id, ...replyAddresses(m, !!b.all, user.id) });
    db.prepare('INSERT OR IGNORE INTO entry_projects (entry_id, project_id) SELECT ?, project_id FROM entry_projects WHERE entry_id = ?').run(id, e0.id);
    return id;
  });
  return { id };
}, { area: 'mail' });

// ---------- posta in arrivo (personale) ----------
const inboxRow = (id, user) => acc.prepare('SELECT * FROM mail_inbox WHERE id = ? AND user_id = ?').get(+id, user.id) || fail(404, 'Mail non trovata');

route('GET', '/api/mail/inbox/:id', ({ params, user }) => {
  const m = inboxRow(params.id, user);
  return { ...m, attachments: JSON.parse(m.attachments) };
}, { ws: false });

route('PATCH', '/api/mail/inbox/:id', async ({ params, user, body }) => {
  const b = await body();
  const m = inboxRow(params.id, user);
  if (b.read !== undefined) acc.prepare('UPDATE mail_inbox SET read_at = ? WHERE id = ?').run(b.read ? m.read_at || now() : null, m.id);
  if (b.archived !== undefined) acc.prepare('UPDATE mail_inbox SET archived_at = ? WHERE id = ?').run(b.archived ? now() : null, m.id);
}, { ws: false });

// "Rispondi" (o "a tutti") su una mail in arrivo: la risposta nasce nel workspace attivo. Se la mail fa già
// parte di una conversazione di qui, la risposta entra lì; altrimenti la mail ricevuta diventa il primo
// messaggio della conversazione della risposta.
route('POST', '/api/mail/inbox/:id/reply', async ({ params, user, body }) => {
  const b = await body();
  const m = inboxRow(params.id, user);
  const id = tx(() => {
    const known = db.prepare('SELECT * FROM mail_messages WHERE message_id = ?').get(m.message_id);
    if (known) {
      const e0 = entryFor(known.entry_id, user, 'read');
      const id = insertReply(user, { title: re(e0.title), subject: re(known.subject || e0.mail_subject || e0.title), project_id: e0.project_id,
        thread: e0.mail_thread ?? e0.id, reply_to: known.id, ...replyAddresses(known, !!b.all, user.id) });
      db.prepare('INSERT OR IGNORE INTO entry_projects (entry_id, project_id) SELECT ?, project_id FROM entry_projects WHERE entry_id = ?').run(id, e0.id);
      return id;
    }
    const msg = { ...m, direction: 'in' };
    const id = insertReply(user, { title: re(m.subject || 'mail'), subject: re(m.subject), ...replyAddresses(msg, !!b.all, user.id) });
    const mid = insertId(db.prepare(`INSERT INTO mail_messages (entry_id, direction, message_id, from_addr, to_addr, cc, subject, body, attachments, date, created_at)
      VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, m.message_id, m.from_addr, m.to_addr, m.cc, m.subject, m.body, m.attachments, m.date, now()));
    db.prepare('UPDATE entries SET reply_to = ? WHERE id = ?').run(mid, id);
    return id;
  });
  const e = db.prepare('SELECT mail_thread FROM entries WHERE id = ?').get(id);
  acc.prepare('UPDATE mail_inbox SET read_at = COALESCE(read_at, ?), thread_ws = ?, thread_entry = ? WHERE id = ?')
    .run(now(), user.workspace_id, e.mail_thread ?? id, m.id);
  notifyMailExt(user.id, 'watch');
  return { id };
}, { area: 'mail' });

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
      const mid = cleanId(b.message_id);
      if (mid) {
        db.prepare(`INSERT OR IGNORE INTO mail_messages (entry_id, direction, message_id, from_addr, to_addr, cc, subject, body, date, created_at)
          VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?)`).run(e.id, mid, str(b.from, 300), str(b.to, 1000) || e.contact || '',
          str(b.cc, 1000) || e.mail_cc || '', str(b.subject, 300), mailParts(e).body, str(b.date, 40) || now(), now());
      }
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
    db.prepare(`SELECT m.message_id FROM mail_messages m JOIN entries e ON e.id = m.entry_id
      WHERE e.deleted_at IS NULL AND ${VIS_ANY} AND m.date > $since`).all({ uid: user.id, since }).map(r => r.message_id)));
}, { ws: false });

// Mail arrivata. Se risponde a una conversazione si aggiunge al filo e la mail non è più in attesa; con
// inbox: true (l'estensione passa tutta la posta in arrivo) entra anche nella posta in arrivo personale.
route('POST', '/api/mail/incoming', async ({ user, body }) => {
  const b = await body();
  const mid = cleanId(b.message_id) || fail(400, 'Manca il Message-ID');
  const refs = [...new Set([b.in_reply_to, ...(Array.isArray(b.references) ? b.references : [])].map(cleanId).filter(Boolean))].slice(-50);
  const attachments = cleanAttachments(b.attachments);
  const matched = []; // { ws, entry }
  for (const { ws, u } of refs.length ? mailWorkspaces(user, 'write') : []) {
    withWorkspace(ws, () => {
      const seen = db.prepare('SELECT entry_id FROM mail_messages WHERE message_id = ?').get(mid);
      if (seen) return matched.push({ ws: ws.id, entry: seen.entry_id });
      const hit = db.prepare(`SELECT m.entry_id FROM mail_messages m JOIN entries e ON e.id = m.entry_id
        WHERE m.message_id IN (${refs.map(() => '?').join(',')}) AND e.deleted_at IS NULL
        AND (e.created_by = ? OR e.assignee_id = ?) ORDER BY m.date DESC LIMIT 1`).get(...refs, u.id, u.id); // posta personale
      if (!hit) return;
      const e = db.prepare('SELECT * FROM entries WHERE id = ?').get(hit.entry_id);
      const from = str(b.from, 300);
      tx(() => {
        insertId(db.prepare(`INSERT INTO mail_messages (entry_id, direction, message_id, from_addr, to_addr, cc, subject, body, attachments, date, created_at)
          VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(e.id, mid, from, str(b.to, 1000), str(b.cc, 1000), str(b.subject, 300),
          str(b.body, 100000), attachments, str(b.date, 40) || now(), now()));
        const root = e.mail_thread ?? e.id;
        db.prepare('UPDATE entries SET awaiting_reply = 0, updated_at = ? WHERE (id = ? OR mail_thread = ?) AND awaiting_reply = 1').run(now(), root, root);
        addLog(e.id, u.id, `risposta da ${from || 'sconosciuto'}`, true);
      });
      matched.push({ ws: ws.id, entry: e.id });
    });
  }
  const thread = matched[0] || null;
  if (b.inbox) {
    const r = acc.prepare(`INSERT OR IGNORE INTO mail_inbox (user_id, message_id, from_addr, to_addr, cc, subject, body, attachments, date, thread_ws, thread_entry, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, mid, str(b.from, 300), str(b.to, 1000), str(b.cc, 1000), str(b.subject, 300),
      str(b.body, 100000), attachments, str(b.date, 40) || now(), thread?.ws ?? null, thread?.entry ?? null, now());
    if (r.changes) bump(user.id);
  }
  for (const { ws } of matched) bump(user.id, ws);
  if (matched.length) notifyMailExt(user.id, 'watch');
  return { matched: matched.length > 0 };
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
  let src;
  if (b.source === 'inbox') src = inboxRow(b.id, user);
  else {
    src = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(+b.id) || fail(404, 'Messaggio non trovato');
    entryFor(src.entry_id, user, 'read');
  }
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
