import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes, backfillLinks } from './api.js';
import { assertCan } from './perms.js';
import './contacts.js';
import './mail.js';
import { migrateInbox, relinkAllActive } from './thunderbird.js';
import { serveAppIcon } from './appicons.js';
import './backup.js';
import './workspaces.js';
import './remote.js';
import './webpage.js';
import './tokens.js';
import './chat.js';
import './feedback.js';
import './notifications.js';
import './tour.js';
import './transfer.js';
import { purgeExpired } from './trash.js';
import { resolveAuth, resolveApiToken, workspaceById, acc } from './accounts.js';
import { bump } from './events.js';
import { HttpError, sendJson, parseCookies, readJson, isHttps, wantsGzip } from './util.js';
import { langOf, trIn, withLang } from './i18n.js';
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
  // wasm-unsafe-eval: PDF.js decodes some PDF images with WebAssembly.
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; font-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

async function handleApi(req, res, url, lang) {
  let match;
  const r = routes.find(r => r.method === req.method && (match = url.pathname.match(r.re)));
  if (!r) throw new HttpError(404, 'No such endpoint');
  // The CLI and external programs authenticate with an API token (Authorization: Bearer ...), the app with the cookie.
  const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  // With the cookie, calls that change data must come from our app (a form on another site cannot set this
  // header). The browser never sends the token by itself, so the check is not needed there.
  if (!bearer && req.method !== 'GET' && req.headers['x-requested-with'] !== 'organizer') throw new HttpError(403, 'Invalid request');

  const token = bearer ? null : parseCookies(req.headers.cookie).sid;
  const auth = bearer ? resolveApiToken(bearer, req.headers['x-workspace']) : resolveAuth(token);
  if (bearer && !auth) throw new HttpError(401, 'Invalid or revoked token');
  // user.is_admin = admin of the active workspace; workspace_id = the session's active workspace (or null).
  const user = auth && {
    id: auth.account.id, username: auth.account.username, name: auth.account.name,
    is_admin: auth.role === 'admin' ? 1 : 0, workspace_id: auth.ws?.id ?? null, api_token: auth.apiToken ?? null,
    perms: auth.perms, // permissions per area (null = everything)
    lang,
  };
  // The interface language, kept for what is written to this person later (notifications, see notify.js).
  if (user && req.headers['x-lang'] && auth.account.lang !== lang) acc.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, user.id);
  if (r.auth !== 'none' && !user) throw new HttpError(401, 'Login required');
  if (r.auth === 'admin' && !user.is_admin) throw new HttpError(403, 'Workspace admins only');
  if (r.ws && !user?.workspace_id) throw new HttpError(409, 'You are not in any workspace');
  // The app area the route belongs to: read for GET, write for the rest (unless level says otherwise).
  if (r.area) assertCan(user, r.area, r.level || (req.method === 'GET' ? 'read' : 'write'));

  // Links for the mail helper have no session: the workspace is written in the token (<id>x<random>).
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
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, 'Not found');
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new HttpError(404, 'Not found');
  }
  if (!st.isFile()) throw new HttpError(404, 'Not found');
  const etag = `W/"${st.size}-${st.mtimeMs.toString(36)}"`;
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
  if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
  // The worker that converts STEP files (OpenCascade compiled with embind) builds functions with new Function: it
  // needs unsafe-eval. A worker uses the policy of its own response, so it applies only there, not to the app.
  if (path.basename(file) === 'step-worker.js') headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'";
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  // Texts (scripts, styles, pages) compressed on the way: the first load goes through the home line too.
  if (st.size > 1024 && /^(text\/|application\/(javascript|json|manifest\+json)|image\/svg)/.test(headers['Content-Type']) && wantsGzip(req)) {
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(zlib.createGzip()).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const lang = langOf(req);
  // Reached over HTTPS (from the tunnel or Caddy): the browser must not try plain HTTP any more.
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  try {
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await withLang(lang, () => handleApi(req, res, url, lang));
    if (req.method === 'GET' && serveAppIcon(res, url, PUBLIC)) return; // the chosen app icons (see appicons.js)
    serveStatic(req, res, url.pathname);
  } catch (e) {
    let status = e instanceof HttpError ? e.status : 500;
    let message = e.message;
    let vars = e.vars;
    if (e.code === 'ERR_SQLITE_ERROR' && /constraint/i.test(e.message)) {
      status = 409;
      message = 'Conflict with existing data';
      vars = null;
    }
    // Unexpected errors (not an HttpError) are logged and not described to the client; the 5xx thrown on purpose
    // (e.g. 502 for a site that does not answer) keep their message.
    const known = e instanceof HttpError;
    if (status >= 500 && !known) console.error(req.method, req.url, e);
    if (res.headersSent) return res.destroy();
    // If the client is still sending (rejected upload) close after the response.
    if (!req.complete) res.setHeader('Connection', 'close');
    sendJson(res, status, { error: trIn(lang, status >= 500 && !known ? 'Internal server error' : message, vars) });
  }
});

// The trash empties itself of what is older than TRASH_DAYS: at start-up and then every 6 hours.
const cleanTrash = () => {
  // Every workspace has its own trash.
  try {
    let n = 0;
    for (const w of acc.prepare('SELECT id, file FROM workspaces WHERE deleted_at IS NULL').all()) n += withWorkspace(w, purgeExpired);
    if (n) console.log(`Trash: deleted ${n} expired files`);
  } catch (e) {
    console.error('Emptying the trash failed', e);
  }
};
cleanTrash();
setInterval(cleanTrash, 6 * 3600e3).unref();

// Inbox of versions up to 0.14: becomes threads (only once).
try {
  migrateInbox();
} catch (e) {
  console.error('Moving the inbox into threads failed', e);
}

// Automatic links of the active conversations, with this version's rules (shortly after start-up).
setTimeout(() => {
  try {
    relinkAllActive();
  } catch (e) {
    console.error('Re-checking the mail links failed', e);
  }
}, 1500).unref();

// Entry links (backlinks): computed once for data written before they existed.
for (const w of acc.prepare('SELECT id, file FROM workspaces WHERE deleted_at IS NULL').all()) {
  const n = withWorkspace(w, backfillLinks);
  if (n) console.log(`Links computed for ${n} entries of workspace ${w.id}`);
}

server.requestTimeout = 0; // large uploads and SSE streams
server.listen(PORT, HOST, () => {
  console.log(`Organizer listening on http://${HOST}:${PORT}  (data in ${DATA_DIR})`);
});

// Closing SQLite folds the WAL into the main file: backups of the volume stay a single .db.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); closeAll(); acc.close(); process.exit(0); });
