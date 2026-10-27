// La CLI contro un server vero (porta libera, dati in una cartella temporanea): token, voci, documenti.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-cli-test-'));
let server;
let url;

const freePort = () => new Promise(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

// org con la configurazione in una cartella temporanea; input = stdin.
async function org(args, { input, env = {} } = {}) {
  const p = promisify(execFile)(process.execPath, [path.join(root, 'cli/bin/org.js'), ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: path.join(dir, 'config'), NO_COLOR: '1', ...env },
  });
  if (input !== undefined) p.child.stdin.end(input);
  else p.child.stdin.end();
  return (await p).stdout;
}

const call = (method, p, { body, token, cookie } = {}) => fetch(`${url}/api${p}`, {
  method,
  headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : { 'X-Requested-With': 'organizer' }),
    ...(cookie ? { Cookie: cookie } : {}),
    'Content-Type': 'application/json',
  },
  body: body && JSON.stringify(body),
});

const config = () => JSON.parse(fs.readFileSync(path.join(dir, 'config/organizer/cli.json'), 'utf8'));

before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: root, env: { ...process.env, DATA_DIR: path.join(dir, 'data'), PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${url}/healthz`).then(r => r.ok, () => false)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const r = await call('POST', '/setup', { body: { username: 'fede', password: 'password-di-prova' } });
  assert.equal(r.status, 200);
});

after(() => {
  server?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('login con password: token salvato, solo per me', async () => {
  const out = await org(['login', url, '-u', 'fede', '--password-stdin'], { input: 'password-di-prova\n' });
  assert.match(out, /fede su/);
  assert.match(config().token, /^org_/);
  assert.equal(fs.statSync(path.join(dir, 'config/organizer/cli.json')).mode & 0o777, 0o600);
  await assert.rejects(org(['login', url, '-u', 'fede', '--password-stdin'], { input: 'sbagliata\n' }), /Credenziali errate/);
});

test('voci: sintassi della barra rapida, scadenze, fatto', async () => {
  const [id] = JSON.parse(await org(['add', 'flash fw #SCH-042 @rover', '-d', 'domani', '--json']));
  const e = JSON.parse(await org(['show', String(id), '--json']));
  assert.equal(e.title, 'flash fw #SCH-042');
  assert.deepEqual(e.projects.map(p => p.tag), ['rover']);
  assert.deepEqual(e.items.map(i => i.code), ['SCH-042']);
  assert.ok(e.due);

  await org(['due', String(id), 'no']);
  // mv non crea progetti (un errore di battitura non deve inventarne uno): prima si crea.
  await assert.rejects(org(['mv', String(id), 'serra']), /@serra non trovato/);
  await org(['proj', 'add', 'Serra IoT', '--tag', 'serra']);
  await org(['mv', String(id), 'serra']);
  await org(['done', String(id)]);
  const after = JSON.parse(await org(['show', String(id), '--json']));
  assert.equal(after.due, null);
  assert.deepEqual(after.projects.map(p => p.tag), ['serra']);
  assert.ok(after.done_at);
  assert.doesNotMatch(await org(['ls']), /flash fw/);
  assert.match(await org(['ls', '--done']), /flash fw/);
});

test('documenti: carica, rinomina, scarica', async () => {
  const src = path.join(dir, 'fw_1.1.bin');
  fs.writeFileSync(src, Buffer.from([0, 1, 2, 3, 255]));
  const [id] = JSON.parse(await org(['doc', 'up', 'SCH-042', src, '-V', '1.1', '--json']));
  const item = JSON.parse(await org(['item', 'show', 'SCH-042', '--json']));
  assert.equal(item.firmware, '1.1');
  assert.equal(item.docs[0].kind, 'firmware');

  await org(['doc', 'rename', String(id), 'firmware relè']);
  const out = path.join(dir, 'giu');
  fs.mkdirSync(out);
  await org(['doc', 'get', String(id), '-o', out]);
  assert.deepEqual(fs.readFileSync(path.join(out, 'firmware relè.bin')), fs.readFileSync(src));
});

test('token: niente CSRF col Bearer, workspace per richiesta, revoca', async () => {
  const { token } = config();
  // Senza token e senza header dell'app le modifiche restano bloccate.
  assert.equal((await fetch(`${url}/api/entries`, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await call('POST', '/entries', { token, body: { text: 'dal bot' } })).status, 200);
  assert.equal((await fetch(`${url}/api/me`, { headers: { Authorization: `Bearer ${token}`, 'X-Workspace': '99' } })).status, 403);
  assert.equal((await call('POST', '/tokens', { token, body: { name: 'altro' } })).status, 403);

  await org(['logout']);
  assert.equal((await call('GET', '/me', { token })).status, 401);
  await assert.rejects(org(['ls']), /Non sei collegato/);
});

test('chat: scrivere, leggere, non letti, solo i propri messaggi', async () => {
  // Una seconda persona nel workspace, entrata con un invito.
  const login = await call('POST', '/login', { body: { username: 'fede', password: 'password-di-prova' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { code } = await (await call('POST', '/admin/invites', { cookie })).json();
  const reg = await call('POST', '/register', { body: { code, username: 'marco', password: 'password-di-prova' } });
  const marco = reg.headers.get('set-cookie').split(';')[0];
  const sync = async c => (await call('GET', '/sync', { cookie: c })).json();
  assert.equal((await sync(marco)).chatUnread, 0); // la chat di prima dell'ingresso non conta

  const { id } = await (await call('POST', '/chat', { cookie, body: { text: 'guarda [[doc:1]] di #SCH-042' } })).json();
  assert.equal((await sync(marco)).chatUnread, 1);
  assert.equal((await sync(cookie)).chatUnread, 0); // i propri messaggi non sono "da leggere"
  assert.equal((await call('PATCH', `/chat/${id}`, { cookie: marco, body: { text: 'no' } })).status, 403);

  await call('POST', '/chat/read', { cookie: marco, body: { id } });
  const s = await sync(marco);
  assert.equal(s.chatUnread, 0);
  assert.deepEqual(s.chat.map(m => m.text), ['guarda [[doc:1]] di #SCH-042']);
  assert.deepEqual((await (await call('GET', `/chat?after=${id - 1}`, { cookie: marco })).json()).map(m => m.id), [id]);
});

test('collegamenti: backlink delle mail (da mandare / mandate) e testo della mail risolto', async () => {
  const login = await call('POST', '/login', { body: { username: 'fede', password: 'password-di-prova' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = async text => (await (await call('POST', '/entries', { cookie, body: { text } })).json()).id;
  const todo = await post('verificare saldature');
  const mail = await post('m: invio firmware >cliente@ditta.example');
  // Nel testo della mail: il codice senza # (come lo scrive l'autocompletamento) e un collegamento a un'altra voce.
  await call('PATCH', `/entries/${mail}`, { cookie, body: { notes: `Vi mando il firmware di SCH-042, dopo [[voce:${todo}]].` } });
  const item = (await (await call('GET', '/sync', { cookie })).json()).items.find(i => i.code === 'SCH-042');
  const back = async (kind, id) => (await (await call('GET', `/backlinks/${kind}/${id}`, { cookie })).json());
  assert.deepEqual((await back('voce', todo)).map(e => [e.id, e.done_at]), [[mail, null]]);
  assert.ok((await back('articolo', item.id)).some(e => e.id === mail && !e.done_at));

  // Mandata: resta nei backlink, con la data.
  await call('PATCH', `/entries/${mail}`, { cookie, body: { done: true } });
  assert.ok((await back('voce', todo))[0].done_at);

  // Nel .eml il collegamento diventa il titolo; l'oggetto resta un'intestazione anche senza Cc.
  const eml = await (await call('GET', `/entries/${mail}/eml`, { cookie })).text();
  const head = eml.slice(0, eml.indexOf('\r\n\r\n'));
  assert.match(head, /^Subject: invio firmware$/m);
  const b64 = eml.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0];
  const body = Buffer.from(b64.replace(/\r\n/g, ''), 'base64').toString();
  assert.equal(body, 'Vi mando il firmware di SCH-042, dopo verificare saldature.');
});
