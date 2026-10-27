import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes } from './api.js';
import './contacts.js';
import './mail.js';
import './backup.js';
import { purgeExpired } from './trash.js';
import { userFromToken } from './auth.js';
import { bump } from './events.js';
import { HttpError, sendJson, parseCookies, readJson } from './util.js';
import { DATA_DIR, db } from './db.js';

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  // wasm-unsafe-eval: PDF.js decodifica alcune immagini dei PDF con WebAssembly.
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; font-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

async function handleApi(req, res, url) {
  let match;
  const r = routes.find(r => r.method === req.method && (match = url.pathname.match(r.re)));
  if (!r) throw new HttpError(404, 'Endpoint inesistente');
  // Le chiamate che modificano dati devono arrivare dalla nostra app (un form di un altro sito non può impostare questo header).
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'organizer') throw new HttpError(403, 'Richiesta non valida');

  const token = parseCookies(req.headers.cookie).sid;
  const user = userFromToken(token);
  if (r.auth !== 'none' && !user) throw new HttpError(401, 'Accesso richiesto');
  if (r.auth === 'admin' && !user.is_admin) throw new HttpError(403, 'Solo per amministratori');

  let bodyPromise;
  const ctx = {
    req, res, url, user, token,
    query: Object.fromEntries(url.searchParams),
    params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])])),
    body: () => (bodyPromise ??= readJson(req)),
  };
  const out = await r.handler(ctx);
  if (req.method !== 'GET') bump(user?.id);
  if (res.headersSent) return;
  if (out === undefined) {
    res.writeHead(204);
    res.end();
  } else {
    sendJson(res, 200, out);
  }
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Metodo non consentito');
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, 'Non trovato');
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new HttpError(404, 'Non trovato');
  }
  if (!st.isFile()) throw new HttpError(404, 'Non trovato');
  const etag = `W/"${st.size}-${st.mtimeMs.toString(36)}"`;
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
  if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    serveStatic(req, res, url.pathname);
  } catch (e) {
    let status = e instanceof HttpError ? e.status : 500;
    let message = e.message;
    if (e.code === 'ERR_SQLITE_ERROR' && /constraint/i.test(e.message)) {
      status = 409;
      message = 'Conflitto con dati esistenti';
    }
    if (status >= 500) console.error(req.method, req.url, e);
    if (res.headersSent) return res.destroy();
    // Se il client sta ancora inviando (upload rifiutato) chiudiamo dopo la risposta.
    if (!req.complete) res.setHeader('Connection', 'close');
    sendJson(res, status, { error: status >= 500 ? 'Errore interno del server' : message });
  }
});

// Il cestino si svuota da solo degli elementi più vecchi di TRASH_DAYS: all'avvio e poi ogni 6 ore.
const cleanTrash = () => {
  try {
    const n = purgeExpired();
    if (n) console.log(`Cestino: eliminati ${n} file scaduti`);
  } catch (e) {
    console.error('Pulizia cestino fallita', e);
  }
};
cleanTrash();
setInterval(cleanTrash, 6 * 3600e3).unref();

server.requestTimeout = 0; // upload grandi e stream SSE
server.listen(PORT, HOST, () => {
  console.log(`Organizer in ascolto su http://${HOST}:${PORT}  (dati in ${DATA_DIR})`);
});

// Chiudere SQLite integra il WAL nel file principale: i backup del volume restano un singolo .db.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
