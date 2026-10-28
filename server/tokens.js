// Token API: la CLI (cartella cli/) e i programmi esterni (bot Telegram, script) usano gli stessi endpoint
// dell'app, autenticandosi con "Authorization: Bearer org_..." invece del cookie. Vedi docs/API.md.
import fs from 'node:fs';
import { route, throttle, noteFailure, clearFailures } from './api.js';
import { acc, createApiToken, apiTokensOf, revokeApiTokens, getAccount } from './accounts.js';
import { verifyPassword } from './auth.js';
import { fail, str } from './util.js';

// Versione delle API pubbliche: cambia solo se un client esistente smetterebbe di funzionare.
export const API_VERSION = 1;
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

route('GET', '/api/info', () => ({ app: 'organizer', version, api: API_VERSION }), { auth: 'none' });

// Novità di ogni versione (la pagina Novità dell'app): il CHANGELOG.md del progetto, così com'è.
const CHANGELOG = new URL('../CHANGELOG.md', import.meta.url);
route('GET', '/api/changelog', ({ res }) => {
  let text = '';
  try {
    text = fs.readFileSync(CHANGELOG, 'utf8');
  } catch {
    fail(404, 'Changelog non disponibile');
  }
  res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(text);
}, { ws: false });

route('GET', '/api/tokens', ({ user }) => apiTokensOf(user.id).map(t => ({ ...t, current: t.id === user.api_token })), { ws: false });

// Dall'app (sessione): un token nuovo per un bot o uno script. Un token non può crearne altri.
route('POST', '/api/tokens', async ({ user, body }) => {
  if (user.api_token) fail(403, 'I token si creano dall\'app o con utente e password');
  const b = await body();
  return createApiToken(user.id, str(b.name, 60) || fail(400, 'Dai un nome al token (es. "bot telegram")'));
}, { ws: false });

// Dalla CLI: utente e password in cambio di un token. Stessi limiti di tentativi del login.
route('POST', '/api/auth/token', async ({ req, body }) => {
  const b = await body();
  const key = `${req.socket.remoteAddress}|${String(b.username).toLowerCase()}`;
  throttle(key);
  const u = acc.prepare('SELECT id, pass FROM users WHERE username = ?').get(str(b.username, 32));
  if (!u || !(await verifyPassword(String(b.password || ''), u.pass))) {
    noteFailure(key);
    fail(401, 'Credenziali errate');
  }
  clearFailures(key);
  return { ...createApiToken(u.id, str(b.name, 60) || 'cli'), user: getAccount(u.id) };
}, { auth: 'none' });

route('DELETE', '/api/tokens/:id', ({ params, user }) => {
  if (!revokeApiTokens(user.id, +params.id)) fail(404, 'Token non trovato');
}, { ws: false });
