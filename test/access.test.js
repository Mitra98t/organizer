// Access log: logins, failed attempts, blocks, refused tokens; seen only by whoever runs the instance.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-access-test-'));
let server;
let url;
let cookie;

const freePort = () => new Promise(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const call = (method, p, body) => fetch(`${url}/api${p}`, {
  method,
  headers: { 'X-Requested-With': 'organizer', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: body && JSON.stringify(body),
});
const json = async (method, p, body) => {
  const r = await call(method, p, body);
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};

before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: root, stdio: 'ignore', env: { ...process.env, DATA_DIR: path.join(dir, 'data'), PORT: String(port), HOST: '127.0.0.1' },
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${url}/healthz`).then(r => r.ok, () => false)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const r = await call('POST', '/setup', { username: 'fede', password: 'test-password' });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
});

after(() => {
  server?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});


const as = (c, method, p, b) => fetch(`${url}/api${p}`, {
  method,
  headers: { 'X-Requested-With': 'organizer', 'Content-Type': 'application/json', Cookie: c },
  body: b && JSON.stringify(b),
});
const login = (username, password) => fetch(`${url}/api/login`, {
  method: 'POST', headers: { 'X-Requested-With': 'organizer', 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
});

test('access log: logins, failures, blocks and tokens, for the owner only', async () => {
  // Wrong password, unknown account, then a good login.
  assert.equal((await login('fede', 'wrong-password')).status, 401);
  assert.equal((await login('nobody', 'whatever-1')).status, 401);
  assert.equal((await login('fede', 'test-password')).status, 200);
  // Ten wrong attempts on one account block it: then the block is written and the owner is told.
  for (let i = 0; i < 10; i++) await login('ghost', `try-${i}`);
  assert.equal((await login('ghost', 'again')).status, 429);
  // A request with a token that does not exist.
  assert.equal((await fetch(`${url}/api/sync`, { headers: { Authorization: 'Bearer org_nope' } })).status, 401);
  // A wrong current password when changing it.
  assert.equal((await as(cookie, 'PATCH', '/me', { current: 'not-it', password: 'new-password-1' })).status, 400);

  const log = await json('GET', '/admin/access');
  assert.equal(log.status, 200);
  const events = log.body.rows.map(r => `${r.event}:${r.username}`);
  for (const e of ['setup:fede', 'login_failed:fede', 'login_failed:nobody', 'login:fede', 'login_blocked:ghost', 'token_refused:', 'password_failed:fede']) {
    assert.ok(events.includes(e), `${e} in ${events.join(', ')}`);
  }
  assert.equal(log.body.rows.find(r => r.event === 'login_failed' && r.username === 'nobody').user_id, null);
  assert.ok(log.body.rows.every(r => r.ip)); // the address is always there
  assert.ok(log.body.failed24h >= 13);
  const failedOnly = await json('GET', '/admin/access?failed=1');
  assert.ok(failedOnly.body.rows.every(r => log.body.failed.includes(r.event)));

  const sync = (await json('GET', '/sync')).body;
  assert.equal(sync.accessFailed, log.body.failed24h);
  assert.ok(sync.notifications.some(n => n.kind === 'security' && n.title.includes('ghost')));

  // Someone else (not whoever runs the instance) does not see it.
  const { code } = (await json('POST', '/admin/invites')).body;
  const reg = await fetch(`${url}/api/register`, {
    method: 'POST', headers: { 'X-Requested-With': 'organizer', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, username: 'marco', password: 'marco-password' }),
  });
  assert.equal(reg.status, 200);
  const marco = reg.headers.get('set-cookie').split(';')[0];
  assert.equal((await as(marco, 'GET', '/admin/access')).status, 403);
  const theirs = await as(marco, 'GET', '/sync').then(r => r.json());
  assert.equal(theirs.accessFailed, null);
  assert.ok((await json('GET', '/admin/access')).body.rows.some(r => r.event === 'register' && r.username === 'marco'));
});

test('usage per person: sections opened, changes per area, devices, who involved whom; owner only', async () => {
  const owner = (await json('GET', '/me')).body.user;
  assert.equal((await json('POST', '/usage', { page: 'agenda' })).status, 204);
  await json('POST', '/usage', { page: 'agenda' });
  await json('POST', '/usage', { page: 'mail' });
  assert.equal((await json('POST', '/usage', { page: '../etc' })).status, 400);
  // A change (entries are the "voci" area) that also mentions marco: it reaches him.
  assert.equal((await json('POST', '/entries', { text: 'check the bench ++marco' })).status, 200);

  const r = await json('GET', '/admin/usage?days=7');
  assert.equal(r.status, 200);
  const me = r.body.users.find(u => u.id === owner.id);
  const area = a => me.areas.find(x => x.area === a) || { views: 0, writes: 0 };
  assert.equal(area('agenda').views, 2);
  assert.equal(area('mail').views, 1);
  assert.ok(area('voci').writes >= 1);
  assert.equal(me.activeDays, 1);
  assert.ok(me.lastUse && me.lastLogin);
  assert.ok(me.sessions.some(s => s.ip)); // the session in use, with its address
  const marco = r.body.users.find(u => u.username === 'marco');
  assert.ok(me.involved.some(i => i.user_id === marco.id && i.n >= 1));
  assert.ok(me.workspaces.length >= 1);

  const login2 = await login('marco', 'marco-password');
  const marcoCookie = login2.headers.get('set-cookie').split(';')[0];
  assert.equal((await as(marcoCookie, 'GET', '/admin/usage')).status, 403);
});

test('API requests: with a token and without login (refused, unknown endpoints) are written; the app is only counted', async () => {
  const { token } = (await json('POST', '/tokens', { name: 'test bot' })).body;
  const bot = p => fetch(`${url}/api${p}`, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'test-bot/1.0' } });
  assert.equal((await bot('/sync')).status, 200);
  assert.equal((await bot('/entries/999999')).status, 404);
  // Without login: refused, an endpoint that does not exist, and the routine ones that are not written.
  assert.equal((await fetch(`${url}/api/sync`)).status, 401);
  assert.equal((await fetch(`${url}/api/wp-admin`)).status, 404);
  assert.equal((await fetch(`${url}/api/info`)).status, 200);
  assert.equal((await fetch(`${url}/api/sync`, { headers: { Authorization: 'Bearer org_fake' } })).status, 401);
  await json('GET', '/sync'); // the app's own request
  await new Promise(r => setTimeout(r, 100)); // written when the answer is over

  const r = (await json('GET', '/admin/requests')).body;
  const line = (m, p) => r.rows.find(x => x.method === m && x.path === p && (p !== '/api/sync' || x.status === 401));
  const viaBot = r.rows.filter(x => x.token_name === 'test bot');
  assert.ok(viaBot.some(x => x.path === '/api/sync' && x.status === 200 && x.route === '/api/sync' && x.agent === 'test-bot/1.0'));
  assert.ok(viaBot.some(x => x.route === '/api/entries/:id' && x.status === 404));
  assert.ok(line('GET', '/api/wp-admin') && line('GET', '/api/wp-admin').route === '(unknown)');
  assert.ok(r.rows.some(x => x.path === '/api/sync' && x.status === 401 && x.user_id === null && x.token_name === ''));
  assert.ok(r.rows.some(x => x.token_name === '(invalid token)'));
  assert.ok(!r.rows.some(x => x.path === '/api/info')); // routine, not written
  assert.ok(r.anon.n >= 3 && r.anon.refused >= 3);
  assert.ok(r.tokens.some(t => t.token_name === 'test bot' && t.n >= 2 && t.errors >= 1));
  const anonOnly = (await json('GET', '/admin/requests?who=anon&errors=1')).body.rows;
  assert.ok(anonOnly.length && anonOnly.every(x => x.user_id === null && x.status >= 400));

  const me = (await json('GET', '/admin/usage?days=7')).body.users.find(u => u.username === 'fede');
  assert.ok(me.requests.app >= 1 && me.requests.api >= 2 && me.requests.errors >= 1);
});
