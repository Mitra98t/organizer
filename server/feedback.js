// Feedback sull'app: chiunque segnala un errore o un'idea, con testo e screenshot; pagina, versione e browser
// si aggiungono da soli. Li rivede chi gestisce l'istanza (admin del primo workspace, vedi isOwner) nella pagina
// Feedback dell'app, oppure dal terminale con `make feedback` (server/feedback-export.js).
// I file stanno in DATA_DIR/feedback: finiscono nei backup insieme al resto.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { DATA_DIR } from './db.js';
import { acc, isOwner } from './accounts.js';
import { route, insertId } from './api.js';
import { HttpError, fail, now, str } from './util.js';
import { bump } from './events.js';

export const FEEDBACK_DIR = path.join(DATA_DIR, 'feedback');
fs.mkdirSync(FEEDBACK_DIR, { recursive: true });
const MAX_FILE = 15 * 1048576;
const MAX_FILES = 6;
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

const getFeedback = id => acc.prepare('SELECT * FROM feedback WHERE id = ?').get(+id) || fail(404, 'Feedback non trovato');
const filesOf = id => acc.prepare('SELECT id, name, mime, size FROM feedback_files WHERE feedback_id = ? ORDER BY id').all(id);
const assertOwner = user => isOwner(user.id) || fail(403, 'Solo chi gestisce l\'istanza vede i feedback');

route('POST', '/api/feedback', async ({ user, body }) => {
  const b = await body();
  const text = str(b.text, 10000) || fail(400, 'Scrivi cosa è successo');
  const id = insertId(acc.prepare(`INSERT INTO feedback (user_id, workspace_id, text, page, version, client, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(user.id, user.workspace_id, text, str(b.page, 300), str(b.version, 30), str(b.client, 500), now()));
  bump(user.id);
  return { id };
}, { ws: false, quiet: true });

// Screenshot: il corpo è l'immagine (come i documenti), ?name= il nome. Solo chi l'ha scritto, entro un'ora.
route('POST', '/api/feedback/:id/files', async ({ req, params, query, user }) => {
  const f = getFeedback(params.id);
  if (f.user_id !== user.id || Date.now() - Date.parse(f.created_at) > 3600e3) fail(403, 'Non puoi aggiungere file a questo feedback');
  const mime = str(req.headers['content-type'], 100);
  if (!IMAGE.test(mime)) fail(400, 'Solo immagini (PNG, JPEG, GIF, WebP)');
  if (acc.prepare('SELECT COUNT(*) AS n FROM feedback_files WHERE feedback_id = ?').get(f.id).n >= MAX_FILES) fail(400, `Al massimo ${MAX_FILES} immagini`);
  const stored = crypto.randomBytes(16).toString('hex');
  const dest = path.join(FEEDBACK_DIR, stored);
  let size = 0;
  const meter = new Transform({
    transform(chunk, _e, cb) {
      size += chunk.length;
      cb(size > MAX_FILE ? new HttpError(413, `Immagine troppo grande (max ${MAX_FILE >> 20} MB)`) : null, chunk);
    },
  });
  try {
    await pipeline(req, meter, fs.createWriteStream(dest));
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
  return { id: insertId(acc.prepare('INSERT INTO feedback_files (feedback_id, stored, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(f.id, stored, str(query.name, 200) || 'screenshot.png', mime, size, now())) };
}, { ws: false, quiet: true });

route('GET', '/api/feedback', ({ user, query }) => {
  assertOwner(user);
  const rows = acc.prepare(`SELECT f.*, u.username, u.name AS user_name FROM feedback f LEFT JOIN users u ON u.id = f.user_id
    WHERE ? = 'all' OR f.status = ? ORDER BY f.created_at DESC LIMIT 500`).all(query.status || 'open', query.status || 'open');
  return rows.map(f => ({ ...f, files: filesOf(f.id) }));
}, { ws: false });

route('PATCH', '/api/feedback/:id', async ({ user, params, body }) => {
  assertOwner(user);
  const f = getFeedback(params.id);
  const status = (await body()).status === 'done' ? 'done' : 'open';
  acc.prepare('UPDATE feedback SET status = ?, resolved_at = ? WHERE id = ?').run(status, status === 'done' ? now() : null, f.id);
}, { ws: false });

// L'immagine: la vede chi gestisce l'istanza e chi l'ha mandata.
route('GET', '/api/feedback/files/:id', ({ res, user, params }) => {
  const file = acc.prepare('SELECT ff.*, f.user_id FROM feedback_files ff JOIN feedback f ON f.id = ff.feedback_id WHERE ff.id = ?').get(+params.id)
    || fail(404, 'File non trovato');
  if (file.user_id !== user.id) assertOwner(user);
  const p = path.join(FEEDBACK_DIR, file.stored);
  if (!fs.existsSync(p)) fail(404, 'File mancante');
  res.writeHead(200, {
    'Content-Type': file.mime, 'Content-Length': fs.statSync(p).size, 'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'",
  });
  fs.createReadStream(p).pipe(res);
}, { ws: false });
