import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes, backfillLinks } from './api.js';
import { assertCan } from './perms.js';
import './contacts.js';
import './mail.js';
import { migrateInbox } from './thunderbird.js';
import './backup.js';
import './workspaces.js';
import './remote.js';
import './tokens.js';
import './chat.js';
import './feedback.js';
import './notifications.js';
import './tour.js';
import { purgeExpired } from './trash.js';
import { resolveAuth, resolveApiToken, workspaceById, acc } from './accounts.js';
import { bump } from './events.js';
import { HttpError, sendJson, parseCookies, readJson, isHttps } from './util.js';
import { DATA_DIR, withWorkspace, closeAll } from './db.js';

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
  // CLI e programmi esterni si autenticano con un token API (Authorization: Bearer ...), l'app con il cookie.
  const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  // Con il cookie, le chiamate che modificano dati devono arrivare dalla nostra app (un form di un altro sito
  // non può impostare questo header). Il token invece il browser non lo manda da solo: il controllo non serve.
  if (!bearer && req.method !== 'GET' && req.headers['x-requested-with'] !== 'organizer') throw new HttpError(403, 'Richiesta non valida');

  const token = bearer ? null : parseCookies(req.headers.cookie).sid;
  const auth = bearer ? resolveApiToken(bearer, req.headers['x-workspace']) : resolveAuth(token);
  if (bearer && !auth) throw new HttpError(401, 'Token non valido o revocato');
  // user.is_admin = admin del workspace attivo; workspace_id = workspace attivo della sessione (o null).
  const user = auth && {
    id: auth.account.id, username: auth.account.username, name: auth.account.name,
    is_admin: auth.role === 'admin' ? 1 : 0, workspace_id: auth.ws?.id ?? null, api_token: auth.apiToken ?? null,
    perms: auth.perms, // permessi per area (null = tutto)
  };
  if (r.auth !== 'none' && !user) throw new HttpError(401, 'Accesso richiesto');
  if (r.auth === 'admin' && !user.is_admin) throw new HttpError(403, 'Solo per gli admin del workspace');
  if (r.ws && !user?.workspace_id) throw new HttpError(409, 'Non fai parte di nessun workspace');
  // Area dell'app a cui appartiene la route: lettura per GET, scrittura per il resto (salvo level).
  if (r.area) assertCan(user, r.area, r.level || (req.method === 'GET' ? 'read' : 'write'));

  // I link per l'helper delle mail non hanno sessione: il workspace è scritto nel token (<id>x<casuale>).
  let ws = auth?.ws ?? null;
  if (url.pathname.startsWith('/api/mailpkg/')) ws = workspaceById(url.pathname.split('/')[3].match(/^(\d+)x/)?.[1]) || null;

  let bodyPromise;
  const ctx = {
    req, res, url, user, token,
    query: Object.fromEntries(url.searchParams),
    params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])])),
    body: () => (bodyPromise ??= readJson(req)),
  };
  const out = ws ? await withWorkspace(ws, () => r.handler(ctx)) : await r.handler(ctx);
  if (req.method !== 'GET' && !r.quiet) bump(user?.id, r.ws ? ws?.id : null);
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
  // Il worker che converte gli STEP (OpenCascade compilato con embind) genera funzioni con new Function: gli
  // serve unsafe-eval. Un worker usa la policy della sua risposta, quindi vale solo lì, non nell'app.
  if (path.basename(file) === 'step-worker.js') headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'";
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
  // Arrivati in HTTPS (dal tunnel o da Caddy): il browser non deve più provare in HTTP semplice.
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
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
  // Ogni workspace ha il suo cestino.
  try {
    let n = 0;
    for (const w of acc.prepare('SELECT id, file FROM workspaces WHERE deleted_at IS NULL').all()) n += withWorkspace(w, purgeExpired);
    if (n) console.log(`Cestino: eliminati ${n} file scaduti`);
  } catch (e) {
    console.error('Pulizia cestino fallita', e);
  }
};
cleanTrash();
setInterval(cleanTrash, 6 * 3600e3).unref();

// Posta in arrivo delle versioni fino alla 0.14: diventa thread (una volta sola).
try {
  migrateInbox();
} catch (e) {
  console.error('Spostamento della posta in arrivo nei thread non riuscito', e);
}

// Collegamenti delle voci (backlink): calcolati una volta per i dati scritti prima che esistessero.
for (const w of acc.prepare('SELECT id, file FROM workspaces WHERE deleted_at IS NULL').all()) {
  const n = withWorkspace(w, backfillLinks);
  if (n) console.log(`Collegamenti calcolati per ${n} voci del workspace ${w.id}`);
}

server.requestTimeout = 0; // upload grandi e stream SSE
server.listen(PORT, HOST, () => {
  console.log(`Organizer in ascolto su http://${HOST}:${PORT}  (dati in ${DATA_DIR})`);
});

// Chiudere SQLite integra il WAL nel file principale: i backup del volume restano un singolo .db.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); closeAll(); acc.close(); process.exit(0); });
