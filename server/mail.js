// Mail scritte nell'app: destinatari, oggetto, testo, allegati (file caricati o documenti del magazzino).
// "Manda" non spedisce dal server: la mail si apre già compilata nel client di posta.
//  - helper locale (tools/organizer-mail.sh): scarica il "pacchetto" con un token monouso a tempo
//    e lancia `thunderbird -compose` con gli allegati;
//  - in alternativa si scarica un .eml, oppure si usa mailto: (senza allegati).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, UPLOAD_DIR, currentWorkspace } from './db.js';
import { route, entryFor, insertId, saveUpload, isJsonRequest } from './api.js';
import { fail, now, str } from './util.js';

const TOKEN_MINUTES = 15;
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

// Nomi file sicuri per riga di comando e URL file:// (niente spazi, virgole, apici).
function safeNames(names) {
  const seen = new Set();
  return names.map(n => {
    let s = String(n || 'allegato').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w.\-()+]+/g, '_').replace(/^[._]+/, '') || 'allegato';
    const [, base, ext] = s.match(/^(.*?)(\.[^.]*)?$/);
    for (let i = 2; seen.has(s.toLowerCase()); i++) s = `${base}-${i}${ext || ''}`;
    seen.add(s.toLowerCase());
    return s;
  });
}

// I collegamenti [[tipo:ID]] nel testo diventano il nome di ciò che collegano: la mail va a chi non usa l'app.
const REF_NAME = {
  doc: "SELECT COALESCE(NULLIF(label, ''), filename, url) AS n FROM documents WHERE id = ?",
  voce: 'SELECT title AS n FROM entries WHERE id = ?',
  contatto: "SELECT COALESCE(NULLIF(name, ''), email) AS n FROM contacts WHERE id = ?",
  progetto: 'SELECT name AS n FROM projects WHERE id = ?',
};

function plainRefs(text) {
  return String(text || '').replace(/\[\[(doc|voce|contatto|progetto):(\d+)\]\]/g, (m, kind, id) => {
    const name = db.prepare(REF_NAME[kind]).get(+id)?.n;
    return name ? name.replace(/(^|\s)#/g, '$1') : m;
  });
}

function mailParts(e) {
  const rows = db.prepare(`SELECT a.filename, a.mime, a.stored, d.stored AS doc_stored, d.mime AS doc_mime, d.filename AS doc_filename
    FROM mail_attachments a LEFT JOIN documents d ON d.id = a.doc_id AND d.deleted_at IS NULL
    WHERE a.entry_id = ? ORDER BY a.id`).all(e.id)
    .map(r => ({ name: r.filename || r.doc_filename, mime: r.mime || r.doc_mime || 'application/octet-stream', stored: r.stored || r.doc_stored }))
    .filter(r => r.stored && fs.existsSync(path.join(UPLOAD_DIR, r.stored)));
  const names = safeNames(rows.map(r => r.name));
  return {
    to: e.contact || '',
    cc: e.mail_cc || '',
    subject: plainRefs(e.mail_subject || e.title.replace(/(^|\s)#/g, '$1')),
    body: plainRefs(e.notes),
    files: rows.map((r, i) => ({ name: names[i], mime: r.mime, file: path.join(UPLOAD_DIR, r.stored) })),
  };
}

// ---------- allegati ----------
route('POST', '/api/entries/:id/attachments', async ({ req, params, query, user, body }) => {
  const e = entryFor(params.id, user, 'read');
  const t = now();
  if (isJsonRequest(req, query)) { // { doc_id }: documento del magazzino; altrimenti un file (?name=)
    const b = await body();
    const d = db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL AND stored IS NOT NULL').get(+b.doc_id)
      || fail(404, 'Documento non trovato (i link esterni non si possono allegare)');
    return { id: insertId(db.prepare(`INSERT INTO mail_attachments (entry_id, doc_id, filename, mime, size, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(e.id, d.id, d.filename || 'documento', d.mime, d.size, user.id, t)) };
  }
  const { stored, size, mime } = await saveUpload(req);
  return { id: insertId(db.prepare(`INSERT INTO mail_attachments (entry_id, filename, mime, size, stored, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(e.id, str(query.name, 255) || 'allegato', mime, size, stored, user.id, t)) };
}, { area: 'mail' });

function getAttachment(id, user) {
  const a = db.prepare('SELECT * FROM mail_attachments WHERE id = ?').get(+id) || fail(404, 'Allegato non trovato');
  entryFor(a.entry_id, user, 'read');
  return a;
}

route('DELETE', '/api/attachments/:id', ({ params, user }) => {
  const a = getAttachment(params.id, user);
  db.prepare('DELETE FROM mail_attachments WHERE id = ?').run(a.id);
  if (a.stored) fs.rmSync(path.join(UPLOAD_DIR, a.stored), { force: true });
}, { area: 'mail' });

route('GET', '/api/attachments/:id/file', ({ res, params, user }) => {
  const a = getAttachment(params.id, user);
  const stored = a.stored || db.prepare('SELECT stored FROM documents WHERE id = ?').get(a.doc_id)?.stored;
  const file = stored && path.join(UPLOAD_DIR, stored);
  if (!file || !fs.existsSync(file)) fail(404, 'File mancante');
  sendFile(res, file, a.filename, 'application/octet-stream');
}, { area: 'mail' });

function sendFile(res, file, name, mime) {
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': fs.statSync(file).size,
    'Content-Disposition': `attachment; filename="${String(name).replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

// ---------- .eml ----------
function buildEml(p) {
  const boundary = `=_organizer_${crypto.randomBytes(8).toString('hex')}`;
  const header = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
  const b64 = buf => buf.toString('base64').replace(/.{76}/g, '$&\r\n');
  const out = [
    `To: ${header(p.to)}`,
    p.cc ? `Cc: ${header(p.cc)}` : null,
    `Subject: ${header(p.subject)}`,
    'X-Unsent: 1',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(Buffer.from(p.body)),
  ].filter(l => l !== null); // niente riga Cc se vuota (una riga vuota chiuderebbe le intestazioni)
  for (const f of p.files) {
    out.push(`--${boundary}`, `Content-Type: ${f.mime}; name="${f.name}"`, `Content-Disposition: attachment; filename="${f.name}"`,
      'Content-Transfer-Encoding: base64', '', b64(fs.readFileSync(f.file)));
  }
  out.push(`--${boundary}--`, '');
  return out.join('\r\n');
}

route('GET', '/api/entries/:id/eml', ({ res, params, user }) => {
  const e = entryFor(params.id, user, 'read');
  const p = mailParts(e);
  const data = Buffer.from(buildEml(p));
  const name = `${safeNames([p.subject || 'mail'])[0].slice(0, 60)}.eml`;
  res.writeHead(200, {
    'Content-Type': 'message/rfc822',
    'Content-Length': data.length,
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}, { area: 'mail' });

// ---------- pacchetto per l'helper locale ----------
route('POST', '/api/entries/:id/send', ({ params, user }) => {
  const e = entryFor(params.id, user, 'read');
  db.prepare('DELETE FROM mail_tokens WHERE expires_at < ?').run(now());
  // Il token porta il numero del workspace (<id>x<casuale>): l'helper non ha sessione per saperlo.
  const token = `${currentWorkspace()}x${crypto.randomBytes(24).toString('base64url')}`;
  db.prepare('INSERT INTO mail_tokens (token_hash, entry_id, expires_at) VALUES (?, ?, ?)')
    .run(sha(token), e.id, new Date(Date.now() + TOKEN_MINUTES * 60e3).toISOString());
  return { token };
}, { area: 'mail', level: 'read' });

// Questi endpoint non usano la sessione (l'helper non ha i cookie del browser): basta il token.
function byToken(token) {
  const t = db.prepare('SELECT entry_id FROM mail_tokens WHERE token_hash = ? AND expires_at > ?').get(sha(token), now())
    || fail(404, 'Link scaduto: premi di nuovo "Manda"');
  return mailParts(db.prepare('SELECT * FROM entries WHERE id = ?').get(t.entry_id));
}

const oneLine = s => String(s || '').replace(/[\t\r\n]+/g, ' ').replace(/'/g, '’').trim();

route('GET', '/api/mailpkg/:token/manifest', ({ res, params }) => {
  const p = byToken(params.token);
  const lines = [`TO\t${oneLine(p.to)}`, `CC\t${oneLine(p.cc)}`, `SUBJECT\t${oneLine(p.subject)}`,
    ...p.files.map((f, i) => `ATTACH\t${i + 1}\t${f.name}`)];
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`${lines.join('\n')}\n`);
}, { auth: 'none' });

// Corpo in HTML: Thunderbird lo usa sia in composizione HTML che testo semplice, mantenendo gli a capo.
route('GET', '/api/mailpkg/:token/body', ({ res, params }) => {
  const p = byToken(params.token);
  const esc = p.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>\n');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': 'sandbox' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body>${esc}</body></html>\n`);
}, { auth: 'none' });

route('GET', '/api/mailpkg/:token/file/:n', ({ res, params }) => {
  const f = byToken(params.token).files[+params.n - 1] || fail(404, 'Allegato inesistente');
  sendFile(res, f.file, f.name, f.mime);
}, { auth: 'none' });
