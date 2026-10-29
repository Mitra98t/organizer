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
import { route, entryFor, updateEntry, addLog, insertId, syncEntryItems, docKind } from './api.js';
import { newThread, ensureEntryThread, touchThread, autoLinkItems } from './maildata.js';
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

// Il thread con i messaggi interi (dal più vecchio) e le mail scritte in Organizer che ne fanno parte.
route('GET', '/api/mail/threads/:id', ({ params, user }) => {
  const t = getThread(params.id, user);
  return {
    ...t,
    messages: db.prepare('SELECT * FROM mail_messages WHERE thread_id = ? ORDER BY date, id').all(t.id).map(parseMsg),
    entries: db.prepare('SELECT id FROM entries WHERE thread_id = ? AND deleted_at IS NULL ORDER BY id').all(t.id).map(r => r.id),
  };
}, { area: 'mail' });

// Letto (i messaggi ricevuti), archiviato o di nuovo attivo. Archiviare lo segna anche letto.
route('PATCH', '/api/mail/threads/:id', async ({ params, user, body }) => {
  const b = await body();
  const t = getThread(params.id, user);
  const at = now();
  if (b.read !== undefined || b.archived) {
    db.prepare(`UPDATE mail_messages SET read_at = ${b.read === false ? 'NULL' : 'COALESCE(read_at, ?)'} WHERE thread_id = ? AND direction = 'in'`)
      .run(...(b.read === false ? [t.id] : [at, t.id]));
  }
  if (b.archived !== undefined) db.prepare('UPDATE mail_threads SET archived_at = ? WHERE id = ?').run(b.archived ? at : null, t.id);
  if (b.subject !== undefined) db.prepare('UPDATE mail_threads SET subject = ? WHERE id = ?').run(str(b.subject, 300) || t.subject, t.id);
  // Letto il thread, anche le sue notifiche.
  if (b.read || b.archived) acc.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND url = ? AND read_at IS NULL').run(at, user.id, `#/t/${t.id}`);
}, { area: 'mail' });

// Nel cestino, con le mail scritte in Organizer che ne fanno parte (tornano insieme con Ripristina). In
// Thunderbird le mail restano; se le ripassa, i messaggi già visti non riaprono il thread.
route('DELETE', '/api/mail/threads/:id', ({ params, user }) => {
  const t = getThread(params.id, user);
  const at = now();
  tx(() => {
    db.prepare('UPDATE mail_threads SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(at, user.id, t.id);
    db.prepare('UPDATE entries SET deleted_at = ?, deleted_by = ? WHERE thread_id = ? AND deleted_at IS NULL').run(at, user.id, t.id);
  });
  acc.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND url = ? AND read_at IS NULL').run(at, user.id, `#/t/${t.id}`);
}, { area: 'mail' });

// Collegamenti scelti a mano: articoli, documenti, progetti, contatti, voci (come i [[…]] e i #codici).
const THREAD_LINK = { articolo: 'items', doc: 'documents', progetto: 'projects', contatto: 'contacts', voce: 'entries' };
route('POST', '/api/mail/threads/:id/links', async ({ params, user, body }) => {
  const b = await body();
  const t = getThread(params.id, user);
  const table = THREAD_LINK[b.kind] || fail(400, 'Tipo di collegamento non valido');
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(+b.id)) fail(404, 'Elemento non trovato');
  db.prepare('INSERT INTO mail_thread_links (thread_id, kind, target_id) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET auto = 0').run(t.id, b.kind, +b.id);
}, { area: 'mail' });

route('DELETE', '/api/mail/threads/:id/links/:kind/:target', ({ params, user }) => {
  const t = getThread(params.id, user);
  db.prepare('DELETE FROM mail_thread_links WHERE thread_id = ? AND kind = ? AND target_id = ?').run(t.id, params.kind, +params.target);
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
        autoLinkItems(tid, `${m.subject} ${m.body}`);
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
        db.prepare(`INSERT OR IGNORE INTO mail_messages (thread_id, entry_id, direction, message_id, from_addr, to_addr, cc, subject, body, date, read_at, created_at)
          VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(tid, e.id, mid, str(b.from, 300), str(b.to, 1000) || e.contact || '',
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

// Una mail di Thunderbird (arrivata, o mandata senza passare da Organizer, o una vecchia chiesta per completare
// un thread). Entra nel thread a cui risponde, in qualunque workspace; se non risponde a niente ne apre uno
// nuovo nel workspace della posta (quello predefinito), ma solo con inbox: true ("tutta la posta") o import: true
// (thread portato a mano: entra già letto, ma tra gli attivi, anche se era nel cestino). Risponde con i
// Message-ID citati che Organizer non ha: l'estensione li cerca in Thunderbird e li manda con history: true.
route('POST', '/api/mail/incoming', async ({ user, body }) => {
  const b = await body();
  const mid = cleanId(b.message_id) || fail(400, 'Manca il Message-ID');
  const refs = [...new Set([...(Array.isArray(b.references) ? b.references : []), b.in_reply_to].map(cleanId).filter(Boolean))].slice(-50);
  const direction = b.direction === 'out' ? 'out' : 'in';
  const history = !!b.history;
  const imported = !!b.import; // scelta a mano in Thunderbird ("Porta il thread in Organizer")
  const date = str(b.date, 40) || now();
  const spaces = mailWorkspaces(user, 'write');
  const ownThread = 'SELECT 1 FROM mail_threads t WHERE t.id = m.thread_id AND t.owner_id = ? AND t.deleted_at IS NULL';
  // Un messaggio di un thread nel cestino è già visto: non lo riapre e non ne crea un altro.
  for (const { ws } of imported ? [] : spaces) {
    const trashed = withWorkspace(ws, () => db.prepare(`SELECT 1 FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id
      WHERE m.message_id = ? AND t.owner_id = ? AND t.deleted_at IS NOT NULL`).get(mid, user.id));
    if (trashed) return { matched: true, thread: null, missing: [] };
  }
  // Il thread: quello che ha già questo messaggio, o quello di un messaggio citato (il più recente).
  let hit = null;
  for (const { ws } of spaces) {
    hit ||= withWorkspace(ws, () => {
      const seen = db.prepare(`SELECT m.thread_id FROM mail_messages m WHERE m.message_id = ? AND EXISTS (${ownThread})`).get(mid, user.id);
      if (seen) return { ws, thread: seen.thread_id, seen: true };
      const r = refs.length && db.prepare(`SELECT m.thread_id FROM mail_messages m WHERE m.message_id IN (${refs.map(() => '?').join(',')})
        AND EXISTS (${ownThread}) ORDER BY m.date DESC LIMIT 1`).get(...refs, user.id);
      return r ? { ws, thread: r.thread_id } : null;
    });
  }
  // Una mail vecchia chiesta dal server (missing) arriva con il thread che l'ha chiesta.
  if (!hit && b.thread) {
    for (const { ws } of spaces) {
      hit ||= withWorkspace(ws, () => (db.prepare('SELECT 1 FROM mail_threads WHERE id = ? AND owner_id = ? AND deleted_at IS NULL').get(+b.thread, user.id) ? { ws, thread: +b.thread } : null));
    }
  }
  if (!hit && !b.inbox && !history && !imported) return { matched: false, missing: [] };
  if (!hit) {
    const ws = spaces.find(x => x.ws.id === defaultWorkspace(user.id))?.ws || spaces[0]?.ws || fail(409, 'Nessun workspace in cui mettere la posta');
    hit = { ws, thread: withWorkspace(ws, () => newThread(user.id, b.subject, date)) };
  }
  const fromName = (String(b.from || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim() || emailOf(b.from) || 'qualcuno');
  const missing = withWorkspace(hit.ws, () => {
    if (!hit.seen) {
      tx(() => {
        db.prepare(`INSERT OR IGNORE INTO mail_messages (thread_id, direction, message_id, from_addr, to_addr, cc, subject, body, attachments, date, read_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(hit.thread, direction, mid, str(b.from, 300), str(b.to, 1000), str(b.cc, 1000), str(b.subject, 300),
          str(b.body, 100000), cleanAttachments(b.attachments), date, direction === 'out' || history || imported ? now() : null, now());
        // Una risposta nuova (o un thread portato a mano) torna tra gli attivi e chiude le attese; la storia no.
        touchThread(hit.thread, date, { reactivate: !history || imported });
        if (direction === 'in' && !history) {
          db.prepare('UPDATE entries SET awaiting_reply = 0, updated_at = ? WHERE thread_id = ? AND awaiting_reply = 1').run(now(), hit.thread);
        }
        autoLinkItems(hit.thread, `${b.subject || ''} ${b.body || ''}`);
      });
    }
    if (hit.seen && imported) touchThread(hit.thread, date);
    const have = new Set(db.prepare('SELECT message_id FROM mail_messages WHERE thread_id = ?').all(hit.thread).map(r => r.message_id));
    return refs.filter(r => !have.has(r));
  });
  // Notifica per le mail appena arrivate (non per la storia né per quelle recuperate al primo collegamento).
  const fresh = Date.now() - Date.parse(date) < 15 * 60e3;
  if (!hit.seen && direction === 'in' && !history && !imported && fresh) {
    notify([user.id], { ws: hit.ws.id, kind: 'mail', title: `Mail da ${fromName}`, body: str(b.subject, 300) || '(senza oggetto)', url: `#/t/${hit.thread}`, tag: `mail-${hit.thread}` });
  }
  bump(user.id, hit.ws.id);
  notifyMailExt(user.id, 'watch');
  return { matched: true, thread: hit.thread, missing };
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
