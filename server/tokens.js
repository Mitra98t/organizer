// API tokens: the CLI (cli/ folder) and external programs (Telegram bots, scripts) use the same endpoints as the
// app, authenticating with "Authorization: Bearer org_..." instead of the cookie. See docs/API.md.
import fs from 'node:fs';
import { route, checkLogin } from './api.js';
import { createApiToken, apiTokensOf, revokeApiTokens, getAccount } from './accounts.js';
import { logAccess } from './access.js';
import { fail, str } from './util.js';

// Version of the public API: it changes only if an existing client would stop working.
export const API_VERSION = 1;
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

route('GET', '/api/info', () => ({ app: 'organizer', version, api: API_VERSION }), { auth: 'none' });

// What's new in every version (the app's What's new page): the project's CHANGELOG.md, as it is.
const CHANGELOG = new URL('../CHANGELOG.md', import.meta.url);
route('GET', '/api/changelog', ({ res }) => {
  let text = '';
  try {
    text = fs.readFileSync(CHANGELOG, 'utf8');
  } catch {
    fail(404, 'Changelog not available');
  }
  res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(text);
}, { ws: false });

route('GET', '/api/tokens', ({ user }) => apiTokensOf(user.id).map(t => ({ ...t, current: t.id === user.api_token })), { ws: false });

// From the app (session): a new token for a bot or a script. A token cannot create others.
route('POST', '/api/tokens', async ({ req, user, body }) => {
  if (user.api_token) fail(403, 'Tokens are created from the app or with username and password');
  const b = await body();
  const t = createApiToken(user.id, str(b.name, 60) || fail(400, 'Give the token a name (e.g. "telegram bot")'));
  logAccess(req, 'token_created', { userId: user.id, username: user.username });
  return t;
}, { ws: false });

// From the CLI: username and password in exchange for a token. Same attempt limits as the login.
route('POST', '/api/auth/token', async ({ req, body }) => {
  const b = await body();
  const u = await checkLogin(req, b);
  const t = createApiToken(u.id, str(b.name, 60) || 'cli');
  logAccess(req, 'login', { userId: u.id, username: b.username });
  logAccess(req, 'token_created', { userId: u.id, username: b.username });
  return { ...t, user: getAccount(u.id) };
}, { auth: 'none' });

route('DELETE', '/api/tokens/:id', ({ req, params, user }) => {
  if (!revokeApiTokens(user.id, +params.id)) fail(404, 'Token not found');
  logAccess(req, 'token_revoked', { userId: user.id, username: user.username });
}, { ws: false });
