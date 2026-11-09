// Dependencies between entries: "try the PS5 ^12" waits for entry 12 until it is done.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-deps-test-'));
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

test('dependencies: ^ID in the text, from the entry, loops refused, shown both ways', async () => {
  const add = async text => (await json('POST', '/entries', { text })).body.id;
  const lands = await add('Mirko lands');
  const ps5 = await add(`try the PS5 with Mirko ^${lands} !yesterday`);
  const party = await add('party');

  let sync = (await json('GET', '/sync')).body;
  assert.deepEqual(sync.entryDeps, [{ entry_id: ps5, after_id: lands }]);
  assert.equal(sync.entries.find(e => e.id === ps5).title, 'try the PS5 with Mirko');

  // From the entry; a third one after the second: a chain.
  assert.equal((await json('POST', `/entries/${party}/after`, { after_id: ps5 })).status, 204);
  const e = (await json('GET', `/entries/${ps5}`)).body;
  assert.deepEqual(e.after.map(x => x.title), ['Mirko lands']);
  assert.deepEqual(e.then.map(x => x.title), ['party']);

  // Refused: loops (also through others), itself, notes, entries that do not exist.
  let r = await json('POST', `/entries/${lands}/after`, { after_id: party });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already waits for this entry/);
  assert.equal((await json('POST', `/entries/${lands}/after`, { after_id: lands })).status, 400);
  const note = await add('n: Mirko wrote from the airport');
  assert.match((await json('POST', `/entries/${note}/after`, { after_id: lands })).body.error, /Only todos and mails/);
  assert.equal((await json('POST', `/entries/${party}/after`, { after_id: 99999 })).status, 404);
  // A failed ^ in the bar does not create the entry.
  assert.equal((await json('POST', '/entries', { text: `waits for nothing ^${note}` })).status, 400);

  // ^ while editing the title adds one more.
  await json('PATCH', `/entries/${party}`, { title: `party ^${lands}` });
  sync = (await json('GET', '/sync')).body;
  assert.deepEqual(sync.entryDeps.filter(d => d.entry_id === party).map(d => d.after_id).sort(), [lands, ps5].sort());

  // Removed; deleting an entry takes its dependencies away.
  await json('DELETE', `/entries/${party}/after/${lands}`);
  await json('DELETE', `/entries/${ps5}`);
  sync = (await json('GET', '/sync')).body;
  assert.deepEqual(sync.entryDeps.filter(d => d.entry_id === party), [{ entry_id: party, after_id: ps5 }]); // ps5 in the trash: still there
  assert.equal(sync.entries.some(x => x.id === ps5), false); // but the app does not have it: party is no longer waiting
});

test('!eventually: set from the text, from the date menu, removed by a date', async () => {
  const { id } = (await json('POST', '/entries', { text: 'visit the warehouse !eventually' })).body;
  const get = async () => (await json('GET', `/entries/${id}`)).body;
  let e = await get();
  assert.deepEqual([e.eventually, e.due, e.title], [1, null, 'visit the warehouse']);
  await json('PATCH', `/entries/${id}`, { due: 'fri' });
  e = await get();
  assert.equal(e.eventually, 0);
  assert.match(e.due, /^\d{4}-/);
  await json('PATCH', `/entries/${id}`, { eventually: true });
  e = await get();
  assert.deepEqual([e.eventually, e.due], [1, null]);
  assert.match(e.logs.at(-1).text, /→ eventually/);
  await json('PATCH', `/entries/${id}`, { due: null }); // "No due date": no longer eventually either
  assert.equal((await get()).eventually, 0);
  await json('PATCH', `/entries/${id}`, { due: '!primaopoi' });
  assert.equal((await get()).eventually, 1);
});

test('dependencies replaced at once: moved under another entry, or waiting for nothing', async () => {
  const add = async text => (await json('POST', '/entries', { text })).body.id;
  const a = await add('first');
  const b = await add('second');
  const c = await add(`third ^${a}`);
  const deps = async () => (await json('GET', '/sync')).body.entryDeps.filter(d => d.entry_id === c).map(d => d.after_id);
  assert.equal((await json('PUT', `/entries/${c}/after`, { after_ids: [b] })).status, 204);
  assert.deepEqual(await deps(), [b]);
  assert.equal((await json('PUT', `/entries/${b}/after`, { after_ids: [c] })).status, 400); // loop: nothing changes
  assert.deepEqual((await json('GET', '/sync')).body.entryDeps.filter(d => d.entry_id === b), []);
  await json('PUT', `/entries/${c}/after`, { after_ids: [] });
  assert.deepEqual(await deps(), []);
});


test('an entry can be created with its details (from a piece of a mail)', async () => {
  const notes = '> the board arrives on Monday\n\nFrom the mail: [[mail:7]]';
  const id = (await json('POST', '/entries', { text: 'check the board', kind: 'note', notes })).body.id;
  const e = (await json('GET', `/entries/${id}`)).body;
  assert.equal(e.kind, 'note');
  assert.equal(e.notes, notes);
  const links = (await json('GET', '/backlinks/mail/7')).body.map(x => x.id);
  assert.ok(links.includes(id));
});

test('journal notes can be archived and brought back; only notes', async () => {
  const note = (await json('POST', '/entries', { text: 'the bench needs the new fuse', kind: 'note' })).body.id;
  const todo = (await json('POST', '/entries', { text: 'order fuses' })).body.id;
  assert.equal((await call('PATCH', `/entries/${note}`, { archived: true })).status, 204);
  let e = (await json('GET', `/entries/${note}`)).body;
  assert.ok(e.archived_at);
  // Still in the data (the Journal hides it), not in the trash.
  assert.ok((await json('GET', '/sync')).body.entries.some(x => x.id === note && x.archived_at));
  assert.equal((await call('PATCH', `/entries/${todo}`, { archived: true })).status, 400);
  assert.equal((await call('PATCH', `/entries/${note}`, { archived: false })).status, 204);
  e = (await json('GET', `/entries/${note}`)).body;
  assert.equal(e.archived_at, null);
  // Becoming a todo removes the archiving.
  await call('PATCH', `/entries/${note}`, { archived: true });
  await call('PATCH', `/entries/${note}`, { kind: 'todo' });
  assert.equal((await json('GET', `/entries/${note}`)).body.archived_at, null);
});
