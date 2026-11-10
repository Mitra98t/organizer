// The CLI against a real server (free port, data in a temporary folder): tokens, entries, documents.
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

// org with the configuration in a temporary folder; input = stdin.
async function org(args, { input, env = {} } = {}) {
  const p = promisify(execFile)(process.execPath, [path.join(root, 'cli/bin/org.js'), ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: path.join(dir, 'config'), NO_COLOR: '1', ORG_LANG: 'en', ...env },
  });
  if (input !== undefined) p.child.stdin.end(input);
  else p.child.stdin.end();
  return (await p).stdout;
}

const call = (method, p, { body, token, cookie, signal, headers = {} } = {}) => fetch(`${url}/api${p}`, {
  method,
  signal,
  headers: {
    ...headers,
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
  const r = await call('POST', '/setup', { body: { username: 'fede', password: 'test-password' } });
  assert.equal(r.status, 200);
});

after(() => {
  server?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('login with password: token saved, only for me', async () => {
  const out = await org(['login', url, '-u', 'fede', '--password-stdin'], { input: 'test-password\n' });
  assert.match(out, /fede on/);
  // ORG_LANG=it: the CLI in Italian, and the server's errors too (X-Lang).
  assert.match(await org(['whoami'], { env: { ORG_LANG: 'it' } }), /fede su/);
  await assert.rejects(org(['show', '999'], { env: { ORG_LANG: 'it' } }), /non trovat/);
  assert.match(config().token, /^org_/);
  assert.equal(fs.statSync(path.join(dir, 'config/organizer/cli.json')).mode & 0o777, 0o600);
  await assert.rejects(org(['login', url, '-u', 'fede', '--password-stdin'], { input: 'sbagliata\n' }), /Wrong credentials/);
});

test('entries: quick bar syntax, due dates, done', async () => {
  const [id] = JSON.parse(await org(['add', 'flash fw #SCH-042 @rover', '-d', 'tomorrow', '--json']));
  const e = JSON.parse(await org(['show', String(id), '--json']));
  assert.equal(e.title, 'flash fw #SCH-042');
  assert.deepEqual(e.projects.map(p => p.tag), ['rover']);
  assert.deepEqual(e.items.map(i => i.code), ['SCH-042']);
  assert.ok(e.due);

  await org(['due', String(id), 'no']);
  // mv does not create projects (a typo must not invent one): it is created first.
  await assert.rejects(org(['mv', String(id), 'greenhouse']), /@greenhouse not found/);
  await org(['proj', 'add', 'Greenhouse IoT', '--tag', 'greenhouse']);
  await org(['mv', String(id), 'greenhouse']);
  await org(['done', String(id)]);
  const after = JSON.parse(await org(['show', String(id), '--json']));
  assert.equal(after.due, null);
  assert.deepEqual(after.projects.map(p => p.tag), ['greenhouse']);
  assert.ok(after.done_at);
  assert.doesNotMatch(await org(['ls']), /flash fw/);
  assert.match(await org(['ls', '--done']), /flash fw/);
});

test('documents: upload, rename, download', async () => {
  const src = path.join(dir, 'fw_1.1.bin');
  fs.writeFileSync(src, Buffer.from([0, 1, 2, 3, 255]));
  const [id] = JSON.parse(await org(['doc', 'up', 'SCH-042', src, '-V', '1.1', '--json']));
  const item = JSON.parse(await org(['item', 'show', 'SCH-042', '--json']));
  assert.equal(item.firmware, '1.1');
  // Status "being evaluated" (from the CLI as "evaluation", the Italian "valutazione" works too); an unknown status is refused.
  await org(['item', 'set', 'SCH-042', '-s', 'evaluation']);
  assert.equal(JSON.parse(await org(['item', 'show', 'SCH-042', '--json'])).status, 'evaluation');
  assert.match(await org(['item', 'show', 'SCH-042']), /being evaluated/);
  assert.equal((await call('PATCH', `/items/${item.id}`, { token: config().token, body: { status: 'whatever' } })).status, 400);
  await org(['item', 'set', 'SCH-042', '-s', 'ok']);
  assert.equal(item.docs[0].kind, 'firmware');

  // Notes on the document: general ones first, then by page with the pin numbers; resolved ones only with --all.
  const note = body => call('POST', `/docs/${id}/notes`, { token: config().token, body }).then(r => r.json());
  await note({ text: 'at the bottom', page: 2, x: 0.5, y: 0.9 });
  await note({ text: 'at the top', page: 1, x: 0.5, y: 0.1 });
  await note({ text: 'general note' });
  const done = await note({ text: 'old one', page: 1, x: 0.1, y: 0.05 });
  await call('PATCH', `/doc-notes/${done.id}`, { token: config().token, body: { resolved: true } });
  const notes = JSON.parse(await org(['doc', 'notes', String(id), '--json']));
  assert.deepEqual(notes.general.map(n => n.text), ['general note']);
  assert.deepEqual(notes.pinned.map(n => [n.num, n.text]), [[1, 'at the top'], [2, 'at the bottom']]);
  assert.equal(JSON.parse(await org(['doc', 'notes', String(id), '--all', '--json'])).pinned[0].text, 'old one');

  // Note on a piece of text: the selected text and the highlighted boxes (on two pages too).
  const marks = [[1, 0.1, 0.3, 0.5, 0.02], [2, 0.1, 0.05, 0.2, 0.02]];
  await note({ text: 'check the value', page: 1, x: 0.1, y: 0.3, quote: '  output   voltage\n12 V ', marks });
  const q = JSON.parse(await org(['doc', 'notes', String(id), '--json'])).pinned.find(n => n.text === 'check the value');
  assert.equal(q.quote, 'output voltage 12 V');
  assert.deepEqual(JSON.parse(q.marks), marks);
  assert.match(await org(['doc', 'notes', String(id)]), /«output voltage 12 V»/);
  const bad = await call('POST', `/docs/${id}/notes`, { token: config().token, body: { text: 'x', page: 1, x: 0.1, y: 0.1, quote: 'x', marks: [[0, 0.1, 0.1, 2, 0.1]] } });
  assert.equal(bad.status, 400);

  // 3D models: the point also has z (0..1 in the model's box).
  const stl = path.join(dir, 'bracket.stl');
  fs.writeFileSync(stl, 'solid bracket\nendsolid bracket\n');
  const [mid] = JSON.parse(await org(['doc', 'up', 'SCH-042', stl, '-k', 'altro', '--json']));
  const n3 = await call('POST', `/docs/${mid}/notes`, { token: config().token, body: { text: 'M3 hole', page: 1, x: 0.2, y: 0.4, z: 1 } }).then(r => r.json());
  assert.equal((await call('POST', `/docs/${mid}/notes`, { token: config().token, body: { text: 'outside', page: 1, x: 0.2, y: 0.4, z: 1.5 } })).status, 400);
  await call('PATCH', `/doc-notes/${n3.id}`, { token: config().token, body: { page: 1, x: 0.3, y: 0.4, z: 0.7 } });
  const m = JSON.parse(await org(['doc', 'notes', String(mid), '--json']));
  assert.deepEqual(m.pinned.map(n => [n.text, n.x, n.z]), [['M3 hole', 0.3, 0.7]]);
  assert.match(await org(['doc', 'notes', String(mid)]), /On the model/);

  await org(['doc', 'rename', String(id), 'relay firmware']);
  const out = path.join(dir, 'giu');
  fs.mkdirSync(out);
  await org(['doc', 'get', String(id), '-o', out]);
  assert.deepEqual(fs.readFileSync(path.join(out, 'relay firmware.bin')), fs.readFileSync(src));

  // Download all: the item's files in a .zip, with the app's names; two equal names do not overwrite each other.
  await org(['doc', 'up', 'SCH-042', stl, '-k', 'altro']);
  const zr = await call('GET', `/items/${item.id}/docs.zip`, { token: config().token });
  assert.equal(zr.status, 200);
  assert.match(zr.headers.get('content-disposition'), /SCH-042-documents\.zip/);
  const { unzip } = await import('../server/zip.js');
  const files = unzip(Buffer.from(await zr.arrayBuffer()));
  assert.deepEqual([...files.keys()].sort(), ['bracket (2).stl', 'bracket.stl', 'relay firmware.bin']);
  assert.deepEqual(files.get('relay firmware.bin')(), fs.readFileSync(src));
  assert.equal(files.get('bracket (2).stl')().toString(), fs.readFileSync(stl, 'utf8'));
  assert.equal((await call('GET', '/items/999999/docs.zip', { token: config().token })).status, 404);
});

test('thunderbird: thread, sent, reply, history, links, archive', async () => {
  const { token } = config();
  const tb = (method, p, body) => call(method, p, { token, body });
  const json = r => (r.status === 204 ? null : r.json());
  const { id } = await tb('POST', '/entries', { text: 'relay offer', kind: 'mail' }).then(json);
  await tb('PATCH', `/entries/${id}`, { contact: 'mario@supplier.example', mail_subject: 'Relay offer' });
  assert.equal((await tb('POST', `/entries/${id}/compose`)).status, 409); // no extension connected
  const tid = (await tb('GET', `/entries/${id}`).then(json)).thread_id;
  assert.ok(tid); // every mail written in Organizer is in a thread

  // The extension keeps the stream open: the server knows it is there and tells it about the mails to open.
  const ctrl = new AbortController();
  const stream = await fetch(`${url}/api/mail/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  assert.match((await reader.read()).value, /event: hello/);
  const sync = await tb('GET', '/sync').then(json);
  assert.equal(sync.mailExt, true);
  const ws = sync.workspace.id;

  assert.equal((await tb('POST', `/entries/${id}/compose`)).status, 204);
  assert.match((await reader.read()).value, /event: outbox/);
  const [req] = await tb('GET', '/mail/outbox').then(json);
  assert.deepEqual([req.to, req.subject, req.reply_to], ['mario@supplier.example', 'Relay offer', null]);
  assert.equal((await tb('POST', `/mail/outbox/${ws}/${req.id}/claim`)).status, 204);
  assert.equal((await tb('POST', `/mail/outbox/${ws}/${req.id}/claim`)).status, 409); // only one Thunderbird opens it

  await tb('POST', '/mail/sent', { ws, outbox_id: req.id, message_id: '<abc@organizer.test>', to: 'mario@supplier.example', subject: 'Relay offer' });
  let e = await tb('GET', `/entries/${id}`).then(json);
  assert.deepEqual([!!e.done_at, e.awaiting_reply], [true, 1]);
  assert.deepEqual(await tb('GET', '/mail/watch').then(json), ['abc@organizer.test']);

  // Replies only: any mail does not get in; the reply does and closes the wait. It quotes an old mail that
  // Organizer does not have: the server asks for it (missing) and the extension sends it as history.
  assert.deepEqual(await tb('POST', '/mail/incoming', { message_id: 'altro@x', in_reply_to: '<nessuno@x>' }).then(json), { matched: false, missing: [] });
  const reply = { message_id: '<r1@supplier.example>', in_reply_to: '<abc@organizer.test>', references: ['<old@supplier.example>', '<abc@organizer.test>'],
    from: 'Mario Rossi <mario@supplier.example>', subject: 'Re: Relay offer', body: 'Fine, I am sending the quote for SCH-042.\n\nOn 28/10 Fede wrote:\n> Offer' };
  const r1 = await tb('POST', '/mail/incoming', reply).then(json);
  assert.deepEqual([r1.thread, r1.missing], [tid, ['old@supplier.example']]);
  assert.deepEqual((await tb('POST', '/mail/incoming', reply).then(json)).thread, tid); // already seen: no duplicate
  await tb('POST', '/mail/incoming', { message_id: '<old@supplier.example>', from: 'Mario Rossi <mario@supplier.example>', subject: 'Price list',
    body: 'old price list', date: '2026-09-01T10:00:00.000Z', history: true, thread: r1.thread });
  e = await tb('GET', `/entries/${id}`).then(json);
  assert.equal(e.awaiting_reply, 0);
  const th = await tb('GET', `/mail/threads/${tid}`).then(json);
  assert.deepEqual(th.messages.map(m => [m.direction, m.message_id, !!m.read_at]),
    [['in', 'old@supplier.example', true], ['out', 'abc@organizer.test', true], ['in', 'r1@supplier.example', false]]);

  // The inventory code written in the reply links the thread to the item; links are added by hand.
  let s = await tb('GET', '/sync').then(json);
  const sch = s.items.find(i => i.code === 'SCH-042');
  assert.ok(s.threadLinks.some(l => l.thread_id === tid && l.kind === 'articolo' && l.target_id === sch.id));
  const contact = await tb('POST', '/contacts', { name: 'Mario', email: 'mario@supplier.example' }).then(json);
  await tb('POST', `/mail/threads/${tid}/links`, { kind: 'contatto', id: contact.id });
  s = await tb('GET', '/sync').then(json);
  assert.ok(s.threadLinks.some(l => l.thread_id === tid && l.kind === 'contatto' && l.manual));

  // Reading does not archive; archiving does (and marks read). A new reply brings the thread back among the active ones.
  await tb('PATCH', `/mail/threads/${tid}`, { read: true });
  s = await tb('GET', '/sync').then(json);
  assert.deepEqual([s.mailThreads.find(t => t.id === tid).archived_at, s.mailMsgs.filter(m => m.thread_id === tid && !m.read_at).length], [null, 0]);
  await tb('PATCH', `/mail/threads/${tid}`, { archived: true });
  assert.ok((await tb('GET', '/sync').then(json)).mailThreads.find(t => t.id === tid).archived_at);
  await tb('POST', '/mail/incoming', { message_id: '<r2@supplier.example>', in_reply_to: '<r1@supplier.example>', from: 'mario@supplier.example', subject: 'Re: Relay offer', body: 'me again' });
  assert.equal((await tb('GET', '/sync').then(json)).mailThreads.find(t => t.id === tid).archived_at, null);

  // Reply: a new mail in the thread, which Thunderbird will open as a reply to the message.
  const { id: rid } = await tb('POST', `/mail/messages/${th.messages[2].id}/reply`).then(json);
  const r = await tb('GET', `/entries/${rid}`).then(json);
  assert.deepEqual([r.kind, r.contact, r.mail_subject, r.thread_id], ['mail', 'mario@supplier.example', 'Re: Relay offer', tid]);
  await tb('POST', `/entries/${rid}/compose`);
  assert.equal((await tb('GET', '/mail/outbox').then(json)).at(-1).reply_to, 'r1@supplier.example');

  // All incoming mail: a new mail opens a thread; Reply all without our own addresses.
  await tb('POST', '/mail/identities', { addresses: ['Fede <fede@organizer.test>'] });
  const news = { message_id: '<n1@customer.example>', from: 'Anna Bianchi <anna@customer.example>', to: 'fede@organizer.test, luca@customer.example',
    cc: 'Office <office@customer.example>', subject: 'Samples request', body: 'We need 5 samples @ 12V !urgent', inbox: true,
    attachments: [{ name: 'relay.pdf', part: '1.2', size: 1234, type: 'application/pdf' }, { name: 'photo.png', part: '1.3', size: 10, type: 'image/png' }] };
  const n1 = await tb('POST', '/mail/incoming', news).then(json);
  assert.ok(n1.thread && n1.thread !== tid);
  const nt = await tb('GET', `/mail/threads/${n1.thread}`).then(json);
  assert.deepEqual([nt.subject, nt.messages.length], ['Samples request', 1]);
  const { id: aid } = await tb('POST', `/mail/messages/${nt.messages[0].id}/reply`, { all: true }).then(json);
  const a = await tb('GET', `/entries/${aid}`).then(json);
  assert.deepEqual([a.contact, a.mail_cc, a.mail_subject, a.thread_id], ['anna@customer.example', 'luca@customer.example, office@customer.example', 'Re: Samples request', n1.thread]);

  // Received attachment → document: Organizer asks the extension for it, which uploads it to the item.
  assert.equal((await tb('POST', '/mail/attachments/save', { id: nt.messages[0].id, n: 0, item_id: sch.id, kind: 'datasheet' })).status, 200);
  const [f] = await tb('GET', '/mail/fetches').then(json);
  assert.deepEqual([f.part, f.name, f.kind, f.message_id, f.item_id], ['1.2', 'relay.pdf', 'datasheet', 'n1@customer.example', sch.id]);
  assert.equal((await tb('POST', `/mail/fetches/${f.id}/claim`)).status, 204);
  const up = await fetch(`${url}/api/items/${f.item_id}/docs?${new URLSearchParams({ name: f.name, kind: f.kind })}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Workspace': String(f.ws), 'Content-Type': 'application/pdf' }, body: Buffer.from('%PDF-1.4 test') });
  assert.equal(up.status, 200);
  await tb('POST', `/mail/fetches/${f.id}/done`);
  assert.deepEqual(await tb('GET', '/mail/fetches').then(json), []);

  // Preview of a received attachment: needs extension 1.6. The server asks for the file, waits for it and keeps it.
  const msg = nt.messages[0].id;
  const meta = await tb('GET', `/mail/messages/${msg}`).then(json);
  assert.deepEqual([meta.thread_id, meta.attachments.map(x => x.name)], [n1.thread, ['relay.pdf', 'photo.png']]);
  const old15 = await tb('GET', `/mail/messages/${msg}/attachments/0`);
  assert.deepEqual([old15.status, /1\.6/.test((await old15.json()).error)], [409, true]);
  const ctrl16 = new AbortController();
  const ext = { Authorization: `Bearer ${token}`, 'X-Organizer-Ext': '1.6' };
  const stream16 = await fetch(`${url}/api/mail/stream`, { headers: ext, signal: ctrl16.signal });
  const reader16 = stream16.body.pipeThrough(new TextDecoderStream()).getReader();
  await reader16.read();
  const extCall = (method, p, body) => fetch(`${url}/api${p}`, { method, headers: { ...ext, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}) },
    body: Buffer.isBuffer(body) ? body : body && JSON.stringify(body) });
  const pdf = Buffer.from('%PDF-1.4 preview');
  const waiting = tb('GET', `/mail/messages/${msg}/attachments/0`);
  let pf;
  for (let i = 0; i < 50 && !pf; i++) {
    await new Promise(res => setTimeout(res, 20));
    [pf] = await extCall('GET', '/mail/fetches').then(json);
  }
  assert.deepEqual([pf.preview, pf.part, pf.message_id], [true, '1.2', 'n1@customer.example']);
  assert.deepEqual(await tb('GET', '/mail/fetches').then(json), []); // old extensions do not see it
  assert.equal((await extCall('POST', `/mail/fetches/${pf.id}/claim`)).status, 204);
  assert.equal((await extCall('POST', `/mail/fetches/${pf.id}/file`, pdf)).status, 204);
  const got = await waiting;
  assert.deepEqual([got.status, Buffer.from(await got.arrayBuffer()).equals(pdf)], [200, true]);
  // Reopened: from memory, without asking Thunderbird again; "→ inventory" saves it right away.
  assert.equal((await tb('GET', `/mail/messages/${msg}/attachments/0`)).status, 200);
  assert.deepEqual(await extCall('GET', '/mail/fetches').then(json), []);
  assert.deepEqual(await tb('POST', '/mail/attachments/save', { id: msg, n: 0, item_id: sch.id, kind: 'datasheet' }).then(json), { code: 'SCH-042', saved: true });
  const saved = (await tb('GET', '/sync').then(json)).docs.filter(d => d.item_id === sch.id && d.filename === 'relay.pdf');
  assert.deepEqual(saved.map(d => d.size).sort((x, y) => x - y), ['%PDF-1.4 test'.length, pdf.length]);
  // Thunderbird does not find the file: the preview says so.
  const missingPng = tb('GET', `/mail/messages/${msg}/attachments/1`);
  let pf2;
  for (let i = 0; i < 50 && !pf2; i++) {
    await new Promise(res => setTimeout(res, 20));
    [pf2] = await extCall('GET', '/mail/fetches').then(json);
  }
  await extCall('POST', `/mail/fetches/${pf2.id}/claim`);
  await extCall('POST', `/mail/fetches/${pf2.id}/done`, { error: 'mail not found in Thunderbird' });
  const miss = await missingPng;
  assert.deepEqual([miss.status, (await miss.json()).error], [409, 'Thunderbird: mail not found in Thunderbird']);
  assert.equal((await tb('GET', `/mail/messages/${msg}/attachments/5`)).status, 404);
  ctrl16.abort();

  // Thread brought by hand from Thunderbird (old ones too, even without "all mail"): from the oldest, all in the
  // same thread, already read but among the active ones; an archived thread with a message already seen becomes active.
  const old = { from: 'Giulia <giulia@studio.example>', to: 'fede@organizer.test', subject: 'Bracket drawings', date: '2025-03-01T10:00:00Z' };
  const i1 = await tb('POST', '/mail/incoming', { ...old, message_id: '<s1@studio.example>', body: 'here is the DXF', import: true }).then(json);
  const i2 = await tb('POST', '/mail/incoming', { ...old, message_id: '<s2@studio.example>', in_reply_to: '<s1@studio.example>', references: ['<s1@studio.example>'],
    subject: 'Re: Bracket drawings', date: '2025-03-02T10:00:00Z', import: true, thread: i1.thread }).then(json);
  assert.equal(i2.thread, i1.thread);
  let it = (await tb('GET', '/sync').then(json));
  assert.deepEqual([it.mailThreads.find(t => t.id === i1.thread).archived_at, it.mailMsgs.filter(m => m.thread_id === i1.thread && !m.read_at).length], [null, 0]);
  await tb('PATCH', `/mail/threads/${i1.thread}`, { archived: true });
  await tb('POST', '/mail/incoming', { ...old, message_id: '<s1@studio.example>', import: true });
  it = (await tb('GET', '/sync').then(json));
  assert.equal(it.mailThreads.find(t => t.id === i1.thread).archived_at, null);

  // Without references: same subject and a person in common → same conversation; different person → new one.
  const s3 = await tb('POST', '/mail/incoming', { ...old, message_id: '<s3@studio.example>', subject: 'R: Bracket drawings', date: '2025-03-03T10:00:00Z', import: true }).then(json);
  assert.equal(s3.thread, i1.thread);
  const s4 = await tb('POST', '/mail/incoming', { ...old, from: 'altri@ditta.it', message_id: '<s4@ditta.it>', date: '2025-03-03T11:00:00Z', import: true }).then(json);
  assert.notEqual(s4.thread, i1.thread);
  const tree = await tb('GET', `/mail/threads/${i1.thread}`).then(json);
  assert.deepEqual(tree.messages.map(m => [m.message_id, m.in_reply_to]), [['s1@studio.example', ''], ['s2@studio.example', 's1@studio.example'], ['s3@studio.example', '']]);

  // Topics: each conversation in its own; moving it to another merges them (the empty topic disappears), "new" splits it.
  it = await tb('GET', '/sync').then(json);
  const topicOf = (d, t) => d.mailThreads.find(x => x.id === t).topic_id;
  const [ta, tb4] = [topicOf(it, i1.thread), topicOf(it, s4.thread)];
  assert.notEqual(ta, tb4);
  await tb('PATCH', `/mail/threads/${s4.thread}`, { topic: ta, starred: true, hue: 200 });
  it = await tb('GET', '/sync').then(json);
  assert.deepEqual([topicOf(it, s4.thread), it.mailTopics.some(t => t.id === tb4)], [ta, false]);
  assert.deepEqual([it.mailThreads.find(x => x.id === s4.thread).starred, it.mailThreads.find(x => x.id === s4.thread).hue], [1, 200]);
  const topic = await tb('GET', `/mail/topics/${ta}`).then(json);
  assert.deepEqual(topic.threads.map(t => t.id).sort(), [i1.thread, s4.thread].sort());
  const { topic: alone } = await tb('PATCH', `/mail/threads/${s4.thread}`, { topic: 'new' }).then(json);
  assert.notEqual(alone, ta);
  await tb('POST', `/mail/topics/${alone}/merge`, { into: ta });
  await tb('PATCH', `/mail/topics/${ta}`, { title: 'Motor bracket', starred: true });
  it = await tb('GET', '/sync').then(json);
  assert.deepEqual([topicOf(it, s4.thread), it.mailTopics.find(t => t.id === ta).title, it.mailTopics.some(t => t.id === alone)], [ta, 'Motor bracket', false]);

  // The whole topic can be linked too (e.g. to its project); merging topics the links move over.
  const proj = await tb('POST', '/projects', { name: 'Brackets', tag: 'brackets' }).then(json);
  await tb('POST', `/mail/topics/${ta}/links`, { kind: 'progetto', id: proj.id });
  const { topic: t2 } = await tb('PATCH', `/mail/threads/${s4.thread}`, { topic: 'new' }).then(json);
  await tb('POST', `/mail/topics/${ta}/merge`, { into: t2 });
  it = await tb('GET', '/sync').then(json);
  assert.deepEqual(it.topicLinks.filter(l => l.topic_id === t2).map(l => [l.kind, l.target_id]), [['progetto', proj.id]]);
  await tb('DELETE', `/mail/topics/${t2}/links/progetto/${proj.id}`);
  assert.equal((await tb('GET', '/sync').then(json)).topicLinks.length, 0);

  // "New mail" from the topic page: a new conversation in the topic with an empty draft, which, while it is alone,
  // gives the conversation its subject.
  const { id: nm } = await tb('POST', `/mail/topics/${t2}/draft`).then(json);
  it = await tb('GET', '/sync').then(json);
  const draft = it.entries.find(e => e.id === nm);
  const nth = it.mailThreads.find(x => x.id === draft.thread_id);
  assert.deepEqual([draft.kind, draft.done_at, nth.topic_id, nth.subject], ['mail', null, t2, 'New mail']);
  await tb('PATCH', `/entries/${nm}`, { mail_subject: 'Brackets quote' });
  assert.equal((await tb('GET', '/sync').then(json)).mailThreads.find(x => x.id === nth.id).subject, 'Brackets quote');
  assert.equal((await tb('POST', '/mail/topics/999999/draft')).status, 404);

  // Automatic link removed by hand: it does not come back, not even with another mail quoting the code.
  await tb('DELETE', `/mail/threads/${tid}/links/articolo/${sch.id}`);
  await tb('POST', '/mail/incoming', { message_id: '<r3@supplier.example>', in_reply_to: '<r2@supplier.example>', from: 'mario@supplier.example', subject: 'Re: Relay offer', body: 'SCH-042 again' });
  assert.ok(!(await tb('GET', '/sync').then(json)).threadLinks.some(l => l.thread_id === tid && l.kind === 'articolo' && l.target_id === sch.id));

  // Full-text search (for "[["): each word in subject, text, addresses or address-book name.
  await tb('POST', '/mail/incoming', { message_id: '<p1@customer.example>', from: 'mb@customer.example', to: 'fede@organizer.test', subject: 'Bench power supply',
    body: 'The regulator only handles 500mA, a bigger PSU is needed.', inbox: true });
  await tb('POST', '/contacts', { name: 'Marco Bianchi', email: 'mb@customer.example' });
  const found = await tb('GET', `/mail/search?${new URLSearchParams({ q: 'marco 500mA' })}`).then(json);
  assert.equal(found.length, 1);
  assert.deepEqual(await tb('GET', `/mail/search?${new URLSearchParams({ q: 'marco 800mA' })}`).then(json), []);
  // [[mail:ID]] in an entry: the conversation is quoted (backlink); for the others it stays "not accessible".
  const { id: cite } = await tb('POST', '/entries', { text: `ask Marco [[mail:${found[0]}]]` }).then(json);
  assert.deepEqual((await tb('GET', `/backlinks/mail/${found[0]}`).then(json)).map(e => e.id), [cite]);
  assert.equal((await tb('POST', '/refs', { refs: [['mail', found[0]]] }).then(json))[`mail:${found[0]}`].status, 'ok');

  // Codes written loosely in mails (without the dash, with or without leading zeros): they link all the same.
  const { id: s44 } = await tb('POST', '/items', { code: 'SCH-44', name: 'Test board' }).then(json);
  const loose = await tb('POST', '/mail/incoming', { message_id: '<l1@supplier.example>', from: 'mario@supplier.example', subject: 'Availability',
    body: 'We have the sch44 and some sch042 too, but not the sch4.', inbox: true }).then(json);
  const looseLinks = (await tb('GET', '/sync').then(json)).threadLinks.filter(l => l.thread_id === loose.thread && l.kind === 'articolo').map(l => l.target_id);
  assert.deepEqual(looseLinks.sort(), [s44, sch.id].sort());

  // 2-character codes (a letter and a digit): they link as a word of their own, not inside "Q55".
  const { id: q5 } = await tb('POST', '/items', { code: 'Q5' }).then(json);
  const short = await tb('POST', '/mail/incoming', { message_id: '<g1@supplier.example>', from: 'g@supplier.example', subject: 'Thermal test',
    body: 'The Q5 gets a bit hot under load.', inbox: true }).then(json);
  const notShort = await tb('POST', '/mail/incoming', { message_id: '<g2@supplier.example>', from: 'h@supplier.example', subject: 'Other',
    body: 'The Q55 model does not.', inbox: true }).then(json);
  const linked = async th => (await tb('GET', '/sync').then(json)).threadLinks.some(l => l.thread_id === th && l.kind === 'articolo' && l.target_id === q5);
  assert.deepEqual([await linked(short.thread), await linked(notShort.thread)], [true, false]);

  // New codes in the inventory (item created, code changed, alternative added): the active conversations that
  // quote them link up; the archived ones do not, until they become active again.
  const mk = (n, body) => tb('POST', '/mail/incoming', { message_id: `<rl${n}@supplier.example>`, from: `p${n}@supplier.example`, subject: `Relay ${n}`, body, inbox: true }).then(json);
  const ra = await mk(1, 'We need RLY-77 and module G5V1, then the new RLY-88.');
  const rb = await mk(2, 'RLY-77 here too.');
  await tb('PATCH', `/mail/threads/${rb.thread}`, { archived: true });
  const linksOf = async th => (await tb('GET', '/sync').then(json)).threadLinks.filter(l => l.thread_id === th && l.kind === 'articolo').map(l => l.target_id);
  const { id: rly } = await tb('POST', '/items', { code: 'RLY-77' }).then(json);
  assert.deepEqual([await linksOf(ra.thread), await linksOf(rb.thread)], [[rly], []]);
  const { id: abc } = await tb('POST', '/items', { code: 'ABC-100' }).then(json);
  await tb('POST', `/items/${abc}/aliases`, { code: 'G5V-1' });
  assert.deepEqual((await linksOf(ra.thread)).sort(), [rly, abc].sort());
  const { id: third } = await tb('POST', '/items', { code: 'XYZ-1' }).then(json);
  await tb('PATCH', `/items/${third}`, { code: 'RLY-88' });
  assert.ok((await linksOf(ra.thread)).includes(third));
  await tb('PATCH', `/mail/threads/${rb.thread}`, { archived: false });
  assert.deepEqual(await linksOf(rb.thread), [rly]);
  // The code changes (or an alternative is removed): the automatic links that no longer apply disappear,
  // the manual ones stay.
  await tb('POST', `/mail/threads/${rb.thread}/links`, { kind: 'articolo', id: rly });
  await tb('PATCH', `/items/${rly}`, { code: 'RLY-99' });
  assert.deepEqual([await linksOf(ra.thread), await linksOf(rb.thread)].map(l => l.includes(rly)), [false, true]);
  await tb('DELETE', `/items/${abc}/aliases/G5V-1`);
  assert.ok(!(await linksOf(ra.thread)).includes(abc));

  // Contacts not to suggest: the account's rules (lowercase, without duplicates).
  await tb('PATCH', '/me', { mailIgnore: ['NoReply', 'noreply', '@amazon.example'] });
  assert.deepEqual((await tb('GET', '/sync').then(json)).mailIgnore, ['noreply', '@amazon.example']);

  // First connection: the extension loads the last month, then marks it done.
  assert.ok((await tb('GET', '/mail/backfill').then(json)).since);
  await tb('POST', '/mail/backfill/done');
  assert.equal((await tb('GET', '/mail/backfill').then(json)).since, null);

  // Rename; Delete takes the thread to the trash with its draft (a single row), Restore brings them back.
  await tb('PATCH', `/mail/threads/${tid}`, { subject: 'Relays for the bench' });
  assert.equal((await tb('GET', '/sync').then(json)).mailThreads.find(t => t.id === tid).subject, 'Relays for the bench');
  const trashBefore = (await tb('GET', '/sync').then(json)).trashCount;
  assert.equal((await tb('DELETE', `/mail/threads/${n1.thread}`)).status, 204);
  let d = await tb('GET', '/sync').then(json);
  assert.ok(!d.mailThreads.some(t => t.id === n1.thread) && !d.entries.some(x => x.id === aid));
  assert.equal(d.trashCount, trashBefore + 1);
  let bin = await tb('GET', '/trash').then(json);
  assert.deepEqual(bin.threads.map(t => [t.subject, t.messages]), [['Samples request', 1]]);
  assert.ok(!bin.entries.some(x => x.id === aid));
  assert.equal((await tb('GET', `/mail/threads/${n1.thread}`)).status, 404);
  // Thunderbird passes it again (e.g. on restart): already seen, it reopens nothing.
  assert.deepEqual(await tb('POST', '/mail/incoming', news).then(json), { matched: true, thread: null, missing: [] });
  assert.equal((await tb('GET', '/sync').then(json)).mailThreads.length, d.mailThreads.length);
  await tb('POST', `/trash/thread/${n1.thread}/restore`);
  d = await tb('GET', '/sync').then(json);
  assert.ok(d.mailThreads.some(t => t.id === n1.thread) && d.entries.find(x => x.id === aid)?.thread_id === n1.thread);
  // Deleted for good: the draft goes too.
  await tb('DELETE', `/mail/threads/${n1.thread}`);
  assert.equal((await tb('DELETE', `/trash/thread/${n1.thread}`)).status, 204);
  bin = await tb('GET', '/trash').then(json);
  assert.deepEqual([bin.threads.length, bin.entries.some(x => x.id === aid)], [0, false]);
  assert.equal((await tb('GET', `/entries/${aid}`)).status, 404);

  // Mail is personal: another member of the workspace sees neither mails nor threads, not even as admin.
  const { code } = await tb('POST', '/admin/invites').then(json);
  const reg = await call('POST', '/register', { body: { code, username: 'luca', password: 'luca-password' } });
  const cookie = reg.headers.get('set-cookie').split(';')[0];
  const other = await call('GET', '/sync', { cookie }).then(json);
  assert.deepEqual([other.entries.length, other.mailThreads.length, other.mailMsgs.length], [0, 0, 0]);
  assert.equal((await call('GET', `/mail/threads/${tid}`, { cookie })).status, 404);
  assert.equal((await call('POST', '/refs', { cookie, body: { refs: [['mail', tid]] } }).then(json))[`mail:${tid}`].status, 'hidden');
  assert.deepEqual(await call('GET', `/mail/search?q=offerta`, { cookie }).then(json), []);

  // The extension downloads already set up for this server.
  const xpi = Buffer.from(await (await tb('GET', '/mail/thunderbird.xpi')).arrayBuffer());
  assert.equal(xpi.subarray(0, 2).toString(), 'PK');
  assert.ok(xpi.includes('_locales/en/messages.json') && xpi.includes('_locales/it/messages.json'));
  ctrl.abort();
});

test('private by default: +person, ++person, +all for entries, projects, contacts, notes', async () => {
  const { token } = config();
  const me = (method, p, body) => call(method, p, { token, body }).then(r => (r.status === 204 ? null : r.json()));
  const login = await call('POST', '/login', { body: { username: 'luca', password: 'luca-password' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const luca = () => call('GET', '/sync', { cookie }).then(r => r.json());
  const lucaId = (await luca()).me.id;
  const titles = d => d.entries.map(e => e.title).sort();

  const { id: mine } = await me('POST', '/entries', { text: 'just mine' });
  const { id: shared } = await me('POST', '/entries', { text: 'to see +luca' });
  const { id: assigned } = await me('POST', '/entries', { text: 'to do ++luca' });
  await me('POST', '/entries', { text: 'for everyone +all' });
  await me('POST', '/entries', { text: 'for whom? +nobody' });
  let d = await luca();
  assert.deepEqual(titles(d), ['for everyone', 'to do', 'to see']);
  assert.equal(d.entries.find(e => e.id === assigned).assignee_id, lucaId);
  assert.equal(d.entries.find(e => e.id === shared).assignee_id, null);
  assert.ok(d.shares.some(s => s.kind === 'entry' && s.obj_id === shared && s.user_id === lucaId));
  assert.equal((await call('GET', `/entries/${mine}`, { cookie })).status, 404);
  assert.equal((await me('GET', `/entries/${(await me('GET', '/sync')).entries.find(e => e.title.startsWith('for whom?')).id}`)).title, 'for whom? +nobody');

  // Only its creator decides who to share it with; the sharing can be removed too.
  assert.equal((await call('PUT', `/shares/entry/${shared}`, { cookie, body: { users: [] } })).status, 403);
  await me('PUT', `/shares/entry/${shared}`, { users: [], all: false });
  assert.deepEqual(titles(await luca()), ['for everyone', 'to do']);
  await me('PUT', `/shares/entry/${mine}`, { users: [lucaId] });
  assert.ok(titles(await luca()).includes('just mine'));

  // Private projects and contacts, shared from the bar or the panel; notes on documents with +person in the text.
  const { id: pid } = await me('POST', '/projects', { name: 'Secret' });
  await me('POST', '/projects', { name: 'Shared', share: ['luca'] });
  const { id: cid } = await me('POST', '/contacts', { name: 'Supplier', email: 'f@x.example' });
  const doc = (await me('GET', '/sync')).docs[0];
  await me('POST', `/docs/${doc.id}/notes`, { text: 'my note' });
  await me('POST', `/docs/${doc.id}/notes`, { text: 'look here +luca' });
  d = await luca();
  assert.deepEqual(d.projects.map(p => p.name), ['Shared']);
  assert.equal(d.contacts.length, 0);
  assert.deepEqual(d.docNotes.map(n => n.text), ['look here']);
  assert.ok(d.docs.some(x => x.id === doc.id)); // inventory and documents stay everyone's
  await me('PUT', `/shares/project/${pid}`, { all: true });
  await me('PUT', `/shares/contact/${cid}`, { users: [lucaId] });
  d = await luca();
  assert.deepEqual([d.projects.length, d.contacts.map(c => c.name)], [2, ['Supplier']]);

  // "all" is not a username.
  const { code } = await me('POST', '/admin/invites');
  assert.equal((await call('POST', '/register', { body: { code, username: 'all', password: 'all-password' } })).status, 400);
});

test('quoted links: archived, not shared, deleted', async () => {
  const { token } = config();
  const json = r => (r.status === 204 ? null : r.json());
  const me = (method, p, body) => call(method, p, { token, body }).then(json);
  const cookie = (await call('POST', '/login', { body: { username: 'luca', password: 'luca-password' } })).headers.get('set-cookie').split(';')[0];
  const { id: priv } = await me('POST', '/entries', { text: 'segreta' });
  const { id: open } = await me('POST', '/entries', { text: 'for luca +luca' });
  const { id: gone } = await me('POST', '/entries', { text: 'to delete +luca' });
  await me('DELETE', `/entries/${gone}`);
  const { id: pid } = await me('POST', '/projects', { name: 'Reserved' });
  const r = await call('POST', '/refs', { cookie, body: { refs: [['voce', priv], ['voce', open], ['voce', gone], ['progetto', pid], ['voce', 999999]] } }).then(json);
  assert.deepEqual(r[`voce:${priv}`], { status: 'hidden' });
  assert.deepEqual([r[`voce:${open}`].status, r[`voce:${open}`].title], ['ok', 'for luca']);
  assert.equal(r[`voce:${gone}`].status, 'gone');
  assert.equal(r[`progetto:${pid}`].status, 'hidden');
  assert.equal(r['voce:999999'].status, 'gone');
});

test('notifications: assigned, shared, mentioned, chat (muted too)', async () => {
  const { token } = config();
  const json = r => (r.status === 204 ? null : r.json());
  const me = (method, p, body) => call(method, p, { token, body }).then(json);
  const cookie = (await call('POST', '/login', { body: { username: 'luca', password: 'luca-password' } })).headers.get('set-cookie').split(';')[0];
  const luca = (method, p, body) => call(method, p, { cookie, body }).then(json);
  await luca('POST', '/notifications/read', { all: true });
  const fresh = async () => (await luca('GET', '/sync')).notifications.filter(n => !n.read_at).map(n => [n.kind, n.title, n.body]);

  const { id: a } = await me('POST', '/entries', { text: 'solder the connector ++luca' });
  await me('POST', '/entries', { text: 'read the manual +luca' });
  await me('POST', '/entries', { text: 'just mine too' });
  let n = await fresh();
  assert.deepEqual(n.map(x => x[1]).sort(), ['fede assigned you a todo', 'fede shared a todo with you']);
  assert.ok(n.some(x => x[2] === 'solder the connector'));
  await me('POST', `/entries/${a}/log`, { text: 'half done, your turn +luca' });
  assert.ok((await fresh()).some(x => x[1] === 'fede mentioned you in an update'));

  // Chat: every message to whoever has not muted; muted, only mentions. Reading the channel clears them.
  await luca('POST', '/notifications/read', { all: true });
  await me('POST', '/chat', { text: 'coffee break', channel: 'general' });
  assert.deepEqual((await fresh()).map(x => x[1]), ['#general · fede']);
  const gen = (await luca('GET', '/sync')).chatChannels.find(c => c.name === 'general');
  await luca('POST', `/chat/channels/${gen.id}/mute`, { muted: true });
  await luca('POST', '/notifications/read', { all: true });
  await me('POST', '/chat', { text: 'another message', channel: 'general' });
  assert.deepEqual(await fresh(), []);
  const { id: mid } = await me('POST', '/chat', { text: 'need a hand +luca', channel: 'general' });
  assert.deepEqual((await fresh()).map(x => x[1]), ['fede mentioned you in #general']);
  assert.equal((await luca('GET', '/sync')).chatChannels.find(c => c.name === 'general').muted, 1);
  await luca('POST', '/chat/read', { id: mid, channel: gen.id });
  assert.deepEqual(await fresh(), []);
  await luca('POST', `/chat/channels/${gen.id}/mute`, { muted: false });

  // Note on a document with +luca; a system notification leads to the right address.
  const doc = (await me('GET', '/sync')).docs[0];
  await me('POST', `/docs/${doc.id}/notes`, { text: 'check the dimension +luca' });
  const [note] = (await luca('GET', '/sync')).notifications;
  assert.match(note.title, /mentioned you in a note on/);
  assert.deepEqual(await luca('GET', `/notifications/${note.id}`).then(x => [x.url.split('?')[0], !!x.workspace_id]), [`#/d/${doc.id}`, true]);
  assert.equal((await luca('GET', '/sync')).notifications[0].read_at !== null, true);
  assert.equal((await call('POST', '/push/subscribe', { cookie, body: { endpoint: 'http://non-https', keys: {} } })).status, 400);
});

test('Organizer tour: test workspace with fake content, then deleted', async () => {
  const cookie = (await call('POST', '/login', { body: { username: 'fede', password: 'test-password' } })).headers.get('set-cookie').split(';')[0];
  const json = r => (r.status === 204 ? null : r.json());
  const me = (method, p, body) => call(method, p, { cookie, body }).then(json);
  const before = await me('GET', '/sync');
  assert.equal(before.onboarded, false); // new account: it gets the tour invitation
  // In Italian: the tour's content is created in the language of the request.
  const start = await call('POST', '/tour/start', { cookie, headers: { 'X-Lang': 'it' } }).then(json);
  assert.ok(start.ids.pdf && start.ids.model && start.ids.entry && start.ids.thread);
  assert.equal((await me('GET', '/sync')).onboarded, true);
  assert.deepEqual(await me('POST', '/tour/start').then(x => x.workspace_id), start.workspace_id); // the same one is resumed
  await me('POST', `/workspaces/${start.workspace_id}/switch`);
  const d = await me('GET', '/sync');
  assert.equal(d.tourWs, start.workspace_id);
  assert.ok(d.workspaces.find(w => w.id === start.workspace_id).tour);
  assert.deepEqual(d.users.filter(u => u.member).map(u => u.username).sort(), ['anna', 'fede', 'luca'].sort());
  assert.ok(d.entries.some(e => e.title.startsWith('calibrare sensori') && e.assignee_id === d.me.id)); // by Anna, assigned to you
  assert.ok(d.entries.some(e => e.kind === 'mail' && e.awaiting_reply === 0 && e.done_at));
  assert.deepEqual([d.mailThreads.length, d.mailMsgs.length], [3, 3]); // quote (draft), delivery (2 messages), power supplies
  assert.deepEqual(d.chatChannels.map(c => c.name), ['generale', 'officina']);
  assert.ok(d.docNotes.some(n => n.z != null));
  assert.equal((await call('GET', `/docs/${start.ids.pdf}/file`, { cookie })).headers.get('content-type'), 'application/pdf');
  // With the app open in the test workspace (live updates): deleting it closes the connection and the server
  // must not write to it any more.
  const live = new AbortController();
  const stream = await call('GET', '/events', { cookie, signal: live.signal });
  await stream.body.getReader().read();
  await me('POST', '/tour/end', { delete: true });
  live.abort();
  const after = await me('GET', '/sync');
  assert.equal(after.tourWs, null);
  assert.ok(!after.workspaces.some(w => w.id === start.workspace_id));
  assert.notEqual(after.workspace.id, start.workspace_id);
});

test('entries created offline: no duplicates if the send is repeated, todo already done', async () => {
  const { token } = config();
  const post = body => call('POST', '/entries', { token, body }).then(r => r.json());
  const a = await post({ text: 'written on the train', kind: 'todo', client_id: 'cid-123' });
  const b = await post({ text: 'written on the train', kind: 'todo', client_id: 'cid-123' });
  assert.equal(a.id, b.id);
  const done = await post({ text: 'done offline', kind: 'todo', client_id: 'cid-456', done: '2026-10-29T08:00:00.000Z' });
  const e = await call('GET', `/entries/${done.id}`, { token }).then(r => r.json());
  assert.equal(e.done_at, '2026-10-29T08:00:00.000Z');
  const n = await post({ text: 'offline note', kind: 'note', client_id: 'cid-789', done: true });
  assert.equal((await call('GET', `/entries/${n.id}`, { token }).then(r => r.json())).done_at, null); // notes are not "done"
});

test('chat with channels: members, read only, permission to manage them', async () => {
  const { token } = config();
  const me = (method, p, body) => call(method, p, { token, body });
  const json = r => (r.status === 204 ? null : r.json());
  const cookie = (await call('POST', '/login', { body: { username: 'luca', password: 'luca-password' } })).headers.get('set-cookie').split(';')[0];
  const luca = (method, p, body) => call(method, p, { cookie, body });
  const lucaId = (await luca('GET', '/sync').then(json)).me.id;

  // #general belongs to everyone (the previous chat); new channels only to the chosen people.
  const { id: off } = await me('POST', '/chat/channels', { name: 'workshop', members: [{ user_id: lucaId, can_write: false }] }).then(json);
  const { id: secret } = await me('POST', '/chat/channels', { name: 'reserved' }).then(json);
  await me('POST', '/chat', { text: 'just for a few', channel: secret });
  await me('POST', '/chat', { text: 'in the workshop', channel: 'workshop' });
  let d = await luca('GET', '/sync').then(json);
  assert.deepEqual(d.chatChannels.map(c => [c.name, c.can_write]), [['general', 1], ['workshop', 0]]);
  assert.ok(d.chat.every(m => m.channel_id !== secret));
  assert.equal(d.chatChannels.find(c => c.id === off).unread, 1);
  assert.equal((await luca('POST', '/chat', { text: 'may I?', channel: off })).status, 403);
  assert.equal((await luca('GET', `/chat?channel=${secret}`)).status, 404);
  await luca('POST', '/chat/read', { id: d.chat.at(-1).id, channel: off });
  assert.equal((await luca('GET', '/sync').then(json)).chatChannels.find(c => c.id === off).unread, 0);

  // Managing channels: admins, or whoever has the "canali" permission.
  assert.equal((await luca('POST', '/chat/channels', { name: 'mine' })).status, 403);
  await me('PATCH', `/admin/users/${lucaId}`, { perms: { canali: 'write' } });
  assert.equal((await luca('POST', '/chat/channels', { name: 'mine' })).status, 200);
  d = await luca('GET', '/sync').then(json);
  assert.equal(d.canManageChannels, true);
  assert.ok(d.chatChannels.some(c => c.name === 'reserved' && !c.member)); // sees it to manage it, without messages
  assert.ok(d.chat.every(m => m.channel_id !== secret));
  await me('PATCH', `/admin/users/${lucaId}`, { perms: null });
});

test('feedback: text and screenshots, seen by whoever runs the instance, export', async () => {
  const { token } = config();
  const json = r => (r.status === 204 ? null : r.json());
  const cookie = (await call('POST', '/login', { body: { username: 'luca', password: 'luca-password' } })).headers.get('set-cookie').split(';')[0];
  const { id } = await call('POST', '/feedback', { cookie, body: { text: 'the Send button does not respond', page: '#/mail', version: '0.13.0' } }).then(json);
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const up = await fetch(`${url}/api/feedback/${id}/files?name=screen.png`, { method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'organizer', 'Content-Type': 'image/png' }, body: png });
  assert.equal(up.status, 200);
  const txt = await fetch(`${url}/api/feedback/${id}/files?name=x.txt`, { method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'organizer', 'Content-Type': 'text/plain' }, body: 'no' });
  assert.equal(txt.status, 400);
  assert.equal((await call('GET', '/feedback', { cookie })).status, 403); // luca does not run the instance
  assert.equal((await call('GET', '/sync', { token }).then(json)).feedbackOpen, 1);
  const [f] = await call('GET', '/feedback', { token }).then(json);
  assert.deepEqual([f.text, f.username, f.page, f.files.map(x => x.name)], ['the Send button does not respond', 'luca', '#/mail', ['screen.png']]);
  const img = await fetch(`${url}/api/feedback/files/${f.files[0].id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);

  const out = path.join(dir, 'fb');
  await promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'server/feedback-export.js'), out],
    { env: { ...process.env, DATA_DIR: path.join(dir, 'data') } });
  const [sub] = fs.readdirSync(out);
  assert.match(fs.readFileSync(path.join(out, sub, 'feedback.md'), 'utf8'), /the Send button does not respond[\s\S]*1-screen\.png/);
  await call('PATCH', `/feedback/${id}`, { token, body: { status: 'done' } });
  assert.deepEqual(await call('GET', '/feedback', { token }).then(json), []);
});

test('tokens: no CSRF with Bearer, workspace per request, revocation', async () => {
  const { token } = config();
  // Without a token and without the app's header changes stay blocked.
  assert.equal((await fetch(`${url}/api/entries`, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await call('POST', '/entries', { token, body: { text: 'from the bot' } })).status, 200);
  assert.equal((await fetch(`${url}/api/me`, { headers: { Authorization: `Bearer ${token}`, 'X-Workspace': '99' } })).status, 403);
  assert.equal((await call('POST', '/tokens', { token, body: { name: 'another' } })).status, 403);

  await org(['logout']);
  assert.equal((await call('GET', '/me', { token })).status, 401);
  await assert.rejects(org(['ls']), /not signed in/);
});

test('chat: write, read, unread, only one\'s own messages', async () => {
  // A second person in the workspace, who joined with an invite.
  const login = await call('POST', '/login', { body: { username: 'fede', password: 'test-password' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { code } = await (await call('POST', '/admin/invites', { cookie })).json();
  const reg = await call('POST', '/register', { body: { code, username: 'marco', password: 'test-password' } });
  const marco = reg.headers.get('set-cookie').split(';')[0];
  const sync = async c => (await call('GET', '/sync', { cookie: c })).json();
  assert.equal((await sync(marco)).chatUnread, 0); // the chat before joining does not count

  const { id } = await (await call('POST', '/chat', { cookie, body: { text: 'look at [[doc:1]] of #SCH-042' } })).json();
  assert.equal((await sync(marco)).chatUnread, 1);
  assert.equal((await sync(cookie)).chatUnread, 0); // one's own messages are not "unread"
  assert.equal((await call('PATCH', `/chat/${id}`, { cookie: marco, body: { text: 'no' } })).status, 403);

  await call('POST', '/chat/read', { cookie: marco, body: { id } });
  const s = await sync(marco);
  assert.equal(s.chatUnread, 0);
  assert.equal(s.chat.at(-1).text, 'look at [[doc:1]] of #SCH-042');
  assert.deepEqual((await (await call('GET', `/chat?after=${id - 1}`, { cookie: marco })).json()).map(m => m.id), [id]);
});

test('links: mail backlinks (to send / sent) and resolved mail text', async () => {
  const login = await call('POST', '/login', { body: { username: 'fede', password: 'test-password' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = async text => (await (await call('POST', '/entries', { cookie, body: { text } })).json()).id;
  const todo = await post('check solder joints');
  const mail = await post('m: send firmware >customer@company.example');
  // In the mail's text: the code without # (as autocomplete writes it) and a link to another entry.
  await call('PATCH', `/entries/${mail}`, { cookie, body: { notes: `Here is the firmware of SCH-042, after [[voce:${todo}]].` } });
  const item = (await (await call('GET', '/sync', { cookie })).json()).items.find(i => i.code === 'SCH-042');
  const back = async (kind, id) => (await (await call('GET', `/backlinks/${kind}/${id}`, { cookie })).json());
  assert.deepEqual((await back('voce', todo)).map(e => [e.id, e.done_at]), [[mail, null]]);
  assert.ok((await back('articolo', item.id)).some(e => e.id === mail && !e.done_at));

  // Sent: it stays in the backlinks, with the date.
  await call('PATCH', `/entries/${mail}`, { cookie, body: { done: true } });
  assert.ok((await back('voce', todo))[0].done_at);

  // In the .eml the link becomes the title; the subject stays a header even without Cc.
  const eml = await (await call('GET', `/entries/${mail}/eml`, { cookie })).text();
  const head = eml.slice(0, eml.indexOf('\r\n\r\n'));
  assert.match(head, /^Subject: send firmware$/m);
  const b64 = eml.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0];
  const body = Buffer.from(b64.replace(/\r\n/g, ''), 'base64').toString();
  assert.equal(body, 'Here is the firmware of SCH-042, after check solder joints.');
});

test('sent mails awaiting reply and added document kinds', async () => {
  await org(['login', url, '-u', 'fede', '--password-stdin'], { input: 'test-password\n' }); // the tokens test logs out
  const login = await call('POST', '/login', { body: { username: 'fede', password: 'test-password' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const mail = (await (await call('POST', '/entries', { cookie, body: { text: 'm: samples request >fab@company.example' } })).json()).id;
  const entry = async () => (await (await call('GET', '/sync', { cookie })).json()).entries.find(e => e.id === mail);
  await call('PATCH', `/entries/${mail}`, { cookie, body: { done: true } });
  assert.equal((await entry()).awaiting_reply, 1); // sent: it waits for a reply
  await org(['mail', 'replied', String(mail)]);
  assert.equal((await entry()).awaiting_reply, 0);
  const shown = JSON.parse(await org(['show', String(mail), '--json']));
  assert.ok(shown.logs.some(l => l.system && l.text === 'reply received'));

  // New kind: used in documents; deleting it the documents go back to "altro" (other).
  await org(['doc', 'kinds', '--add', 'Gerber']);
  const src = path.join(dir, 'board.zip');
  fs.writeFileSync(src, 'zip');
  const [doc] = JSON.parse(await org(['doc', 'up', 'SCH-042', src, '-k', 'gerber', '--json']));
  const kindOf = async () => (await (await call('GET', '/sync', { cookie })).json()).docs.find(d => d.id === doc).kind;
  assert.equal(await kindOf(), 'gerber');
  assert.equal((await call('POST', '/doc-kinds', { cookie, body: { name: 'gerber' } })).status, 409);
  await org(['doc', 'kinds', '--rm', 'gerber']);
  assert.equal(await kindOf(), 'altro');
});

test('contact colour: hue 0..359 or automatic', async () => {
  const login = await call('POST', '/login', { body: { username: 'fede', password: 'test-password' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { id } = await (await call('POST', '/contacts', { cookie, body: { name: 'Luca', email: 'luca@company.example' } })).json();
  const hueOf = async () => (await (await call('GET', '/sync', { cookie })).json()).contacts.find(c => c.id === id).hue;
  assert.equal(await hueOf(), null);
  assert.equal((await call('PATCH', `/contacts/${id}`, { cookie, body: { hue: 210 } })).status, 204);
  assert.equal(await hueOf(), 210);
  assert.equal((await call('PATCH', `/contacts/${id}`, { cookie, body: { hue: 400 } })).status, 400);
  await call('PATCH', `/contacts/${id}`, { cookie, body: { hue: null } });
  assert.equal(await hueOf(), null);
});

test('alternative codes: unique, #ALTERNATIVE leads to the item, promotion to main', async () => {
  const login = await call('POST', '/login', { body: { username: 'fede', password: 'test-password' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const sync = async () => (await call('GET', '/sync', { cookie })).json();
  const { id } = await (await call('POST', '/items', { cookie, body: { code: 'LED-01', name: 'white led' } })).json();
  assert.equal((await call('POST', `/items/${id}/aliases`, { cookie, body: { code: 'C503D-WAN' } })).status, 204);
  // Already taken (as an alternative, or as another item's main code): no.
  assert.equal((await call('POST', '/items', { cookie, body: { code: 'c503d-wan' } })).status, 409);
  assert.equal((await call('POST', `/items/${id}/aliases`, { cookie, body: { code: 'SCH-042' } })).status, 409);

  // An entry quoting the alternative code is linked to the item (it does not create a new one).
  const e = (await (await call('POST', '/entries', { cookie, body: { text: 'order #C503D-WAN' } })).json()).id;
  let d = await sync();
  assert.deepEqual(d.entryItems.filter(x => x.entry_id === e).map(x => x.item_id), [id]);
  assert.ok(!d.items.some(i => i.code.toUpperCase() === 'C503D-WAN'));

  // The alternative becomes the main one: the old main one stays among the alternatives.
  await call('PATCH', `/items/${id}`, { cookie, body: { code: 'C503D-WAN' } });
  d = await sync();
  assert.equal(d.items.find(i => i.id === id).code, 'C503D-WAN');
  assert.deepEqual(d.itemAliases.filter(a => a.item_id === id).map(a => a.code), ['LED-01']);

  // From the CLI: list, add, remove.
  await org(['login', url, '-u', 'fede', '--password-stdin'], { input: 'test-password\n' });
  await org(['item', 'alias', 'LED-01', 'NSPW500']);
  assert.deepEqual(JSON.parse(await org(['item', 'alias', 'C503D-WAN', '--json'])).sort(), ['LED-01', 'NSPW500']);
  await org(['item', 'alias', 'C503D-WAN', '--rm', 'LED-01']);
  assert.deepEqual(JSON.parse(await org(['item', 'show', 'NSPW500', '--json'])).aliases, ['NSPW500']);
});

test('.json files: uploaded as documents and as attachments, not as links', async () => {
  await org(['login', url, '-u', 'fede', '--password-stdin'], { input: 'test-password\n' });
  const src = path.join(dir, 'profilo.json');
  fs.writeFileSync(src, '{"led": "SCH-042", "current": 20}');
  const [id] = JSON.parse(await org(['doc', 'up', 'SCH-042', src, '--json']));
  const out = path.join(dir, 'giu-json');
  fs.mkdirSync(out);
  await org(['doc', 'get', String(id), '-o', out]);
  assert.equal(fs.readFileSync(path.join(out, 'profilo.json'), 'utf8'), fs.readFileSync(src, 'utf8'));

  const [mail] = JSON.parse(await org(['add', '--mail', 'send profile >office@company.example', '--json']));
  await org(['mail', 'attach', String(mail), src]);
  const e = JSON.parse(await org(['show', String(mail), '--json']));
  assert.deepEqual(e.attachments.map(a => a.filename), ['profilo.json']);
  // A link is still created with the JSON body without ?name=.
  const { token } = config();
  const item = (await (await call('GET', '/sync', { token })).json()).items.find(i => i.code === 'SCH-042');
  assert.equal((await call('POST', `/items/${item.id}/docs`, { token, body: { url: 'example.com/x' } })).status, 400);
});

test('permissions per area: filtered data, blocked writes, dependencies respected', async () => {
  const login = async (username) => (await call('POST', '/login', { body: { username, password: 'test-password' } })).headers.get('set-cookie').split(';')[0];
  const admin = await login('fede');
  const sync = async c => (await call('GET', '/sync', { cookie: c })).json();
  // A new person in the workspace (invite).
  const { code } = await (await call('POST', '/admin/invites', { cookie: admin })).json();
  const reg = await call('POST', '/register', { body: { code, username: 'intern', password: 'test-password' } });
  const intern = reg.headers.get('set-cookie').split(';')[0];
  const id = (await sync(intern)).me.id;
  await call('POST', '/entries', { cookie: admin, body: { text: 'm: reserved offer >customer@company.example' } });

  // Mail and chat hidden, inventory read only, contacts hidden.
  const r = await (await call('PATCH', `/admin/users/${id}`, { cookie: admin, body: { perms: { mail: 'none', chat: 'none', magazzino: 'read', contatti: 'none' } } })).json();
  // Dependencies complete themselves: writing todos needs reading projects and inventory (already fine).
  assert.equal(r.perms.voci, 'write');
  const d = await sync(intern);
  assert.equal(d.perms.mail, 'none');
  assert.ok(!d.entries.some(e => e.kind === 'mail'));
  assert.deepEqual([d.chat.length, d.contacts.length], [0, 0]);
  assert.ok(d.items.length > 0);

  // Writes outside the permissions: 403. A new #CODE in a todo stays text (no item created).
  assert.equal((await call('POST', '/entries', { cookie: intern, body: { text: 'm: trying to write' } })).status, 403);
  assert.equal((await call('POST', '/chat', { cookie: intern, body: { text: 'ciao' } })).status, 403);
  const item = d.items[0];
  assert.equal((await call('PATCH', `/items/${item.id}`, { cookie: intern, body: { name: 'x' } })).status, 403);
  assert.equal((await call('POST', '/entries', { cookie: intern, body: { text: 'check #NEW-999' } })).status, 200);
  assert.ok(!(await sync(admin)).items.some(i => i.code === 'NEW-999'));

  // Giving write access to mail raises to read what is needed (contacts, documents, inventory, projects).
  const r2 = await (await call('PATCH', `/admin/users/${id}`, { cookie: admin, body: { perms: { ...r.perms, mail: 'write' } } })).json();
  assert.equal(r2.perms.contatti, 'read');
  assert.equal((await call('POST', '/entries', { cookie: intern, body: { text: 'm: now I can' } })).status, 200);

  // Permissions are not taken from admins; null brings them all back.
  assert.equal((await call('PATCH', `/admin/users/${(await sync(admin)).me.id}`, { cookie: admin, body: { perms: { mail: 'none' } } })).status, 400);
  await call('PATCH', `/admin/users/${id}`, { cookie: admin, body: { perms: null } });
  assert.equal((await sync(intern)).perms, null);
});

test('app icons: SVG, PNG at the right sizes, manifest with the chosen icon', async () => {
  const get = p => fetch(`${url}${p}`);
  const svg = await get('/icons/app/min-dot.svg');
  assert.deepEqual([svg.status, svg.headers.get('content-type')], [200, 'image/svg+xml']);
  assert.match(await svg.text(), /<circle/);
  for (const p of ['/icons/app/t-nord-180.png', '/icons/app/t-synthwave-512-maskable.png']) {
    const r = await get(p);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.deepEqual([r.status, buf.subarray(1, 4).toString()], [200, 'PNG']);
  }
  assert.equal((await get('/icons/app/t-nord-64.png')).status, 404); // size not provided
  assert.equal((await get('/icons/app/does-not-exist-192.png')).status, 404);
  const m = await get('/manifest.webmanifest?icon=min-ring').then(r => r.json());
  assert.ok(m.icons.some(i => i.src === 'icons/app/min-ring-512-maskable.png' && i.purpose === 'maskable'));
  assert.equal(m.start_url, './#/agenda');
});

test('export and import one\'s own data: inventory with files, entries, links, mail, into another workspace', async () => {
  const cookie = (await call('POST', '/login', { body: { username: 'fede', password: 'test-password' } })).headers.get('set-cookie').split(';')[0];
  const json = r => (r.status === 204 ? null : r.json());
  const me = (method, p, body) => call(method, p, { cookie, body }).then(json);
  const { id: item } = await me('POST', '/items', { code: 'EXP-1', name: 'Board to export', category: 'test' });
  const up = await fetch(`${url}/api/items/${item}/docs?${new URLSearchParams({ name: 'exp1.txt', kind: 'altro' })}`, {
    method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'organizer', 'Content-Type': 'text/plain' }, body: 'test content',
  }).then(r => r.json());
  await me('POST', '/projects', { name: 'Export', tag: 'export-test' });
  const { id: todo } = await me('POST', '/entries', { text: `check the file #EXP-1 @export-test` });
  const { id: dn } = await me('POST', `/docs/${up.id}/notes`, { text: 'line 3 to review', page: 1, x: 0.1, y: 0.2 });
  await me('PATCH', `/entries/${todo}`, { notes: `see [[doc:${up.id}]] and [[nota:${dn}]]` });
  // The quoted note: the entry shows among its links, and the status can be read even without the data.
  assert.deepEqual((await me('GET', `/backlinks/nota/${dn}`)).map(x => x.id), [todo]);
  assert.equal((await me('POST', '/refs', { refs: [['nota', dn]] }))[`nota:${dn}`].status, 'ok');
  await me('POST', '/mail/incoming', { message_id: '<exp1@supplier.example>', from: 'x@supplier.example', subject: 'Export', body: 'EXP-1 needed', inbox: true });

  const zipFile = Buffer.from(await (await fetch(`${url}/api/export`, { headers: { Cookie: cookie, 'X-Requested-With': 'organizer' } })).arrayBuffer());
  assert.equal(zipFile.subarray(0, 2).toString(), 'PK');

  // In a new (empty) workspace: everything arrives, with new ids and updated links.
  await me('POST', '/workspaces', { name: 'Elsewhere' });
  const imp = body => fetch(`${url}/api/import`, { method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'organizer', 'Content-Type': 'application/zip' }, body }).then(r => r.json());
  const r1 = await imp(zipFile);
  assert.ok(r1.articoli >= 1 && r1.documenti >= 1 && r1.voci >= 1 && r1.progetti >= 1 && r1.conversazioni >= 1, JSON.stringify(r1));
  const d = await me('GET', '/sync');
  const it = d.items.find(i => i.code === 'EXP-1');
  const doc = d.docs.find(x => x.item_id === it.id && x.filename === 'exp1.txt');
  assert.equal(await fetch(`${url}/api/docs/${doc.id}/file`, { headers: { Cookie: cookie } }).then(r => r.text()), 'test content');
  const e = d.entries.find(x => x.title.startsWith('check the file'));
  const note = d.docNotes.find(x => x.doc_id === doc.id && x.text === 'line 3 to review');
  assert.equal(e.notes, `see [[doc:${doc.id}]] and [[nota:${note.id}]]`);
  assert.equal(e.project_id, d.projects.find(p => p.tag === 'export-test').id);
  assert.ok(d.mailThreads.some(t => t.subject === 'Export'));
  // A second time: the items and documents already there are not duplicated.
  const r2 = await imp(zipFile);
  assert.deepEqual([r2.articoli, r2.documenti, r2.progetti], [0, 0, 0]);
  assert.ok(r2.articoliUniti >= 1 && r2.progettiUniti >= 1);
  // A file that is not an export: refused.
  assert.match((await imp(Buffer.from('ciao'))).error, /not an Organizer export/);
});

test('documents moved and copied, topic into another workspace, workspace per account, Open in Thunderbird', async () => {
  const { token } = config();
  const json = r => (r.status === 204 ? null : r.json());
  const as = wsId => (method, p, body, extra = {}) => fetch(`${url}/api${p}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'X-Workspace': String(wsId), 'Content-Type': 'application/json', ...extra }, body: body && JSON.stringify(body),
  });
  const { workspaces } = await call('GET', '/sync', { token }).then(json);
  const home = workspaces.find(w => w.name !== 'Elsewhere' && !w.tour).id;
  const other = workspaces.find(w => w.name === 'Elsewhere').id;
  const H = as(home);
  const O = as(other);

  // Documents: copy (its own file, the item's firmware too) and move to another item.
  const { id: a } = await H('POST', '/items', { code: 'MV-1', name: 'sorgente' }).then(json);
  const { id: b } = await H('POST', '/items', { code: 'MV-2', name: 'destinazione' }).then(json);
  const up = await fetch(`${url}/api/items/${a}/docs?${new URLSearchParams({ name: 'fw.bin', kind: 'firmware', version: '2.0' })}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Workspace': String(home), 'Content-Type': 'application/octet-stream' }, body: Buffer.from('firmware 2.0'),
  }).then(json);
  const cp = await H('POST', `/docs/${up.id}/copy`, { item_id: b }).then(json);
  assert.ok(cp.id && cp.id !== up.id);
  assert.equal(await H('GET', `/docs/${cp.id}/file`).then(r => r.text()), 'firmware 2.0');
  assert.equal((await H('PATCH', `/docs/${up.id}`, { item_id: b })).status, 204);
  let s = await H('GET', '/sync').then(json);
  assert.deepEqual(s.docs.filter(d => d.item_id === b).map(d => d.filename), ['fw.bin', 'fw.bin']);
  assert.equal(s.items.find(i => i.id === b).firmware, '2.0');
  assert.equal((await H('PATCH', `/docs/${up.id}`, { item_id: 999999 })).status, 404);

  // Workspace per account: the extension lists where mail can go and a new conversation goes there.
  assert.deepEqual((await H('GET', '/mail/workspaces').then(json)).map(w => w.id).sort(), [home, other].sort());
  const r1 = await H('POST', '/mail/incoming', { message_id: '<ws1@customer.example>', from: 'anna@customer.example', subject: 'For Elsewhere', body: 'hello', inbox: true, ws: other }).then(json);
  assert.ok((await O('GET', '/sync').then(json)).mailThreads.some(t => t.id === r1.thread && t.subject === 'For Elsewhere'));
  assert.ok(!(await H('GET', '/sync').then(json)).mailThreads.some(t => t.subject === 'For Elsewhere'));

  // A topic into another workspace: conversations, messages and the draft written here; replies then arrive there.
  const r2 = await H('POST', '/mail/incoming', { message_id: '<sp1@supplier.example>', from: 'mario@supplier.example', subject: 'Move me', body: 'about MV-1', inbox: true, ws: home }).then(json);
  s = await H('GET', '/sync').then(json);
  const topic = s.mailThreads.find(t => t.id === r2.thread).topic_id;
  const { id: draft } = await H('POST', `/mail/topics/${topic}/draft`).then(json);
  await H('PATCH', `/entries/${draft}`, { notes: 'reply to finish' });
  assert.equal((await H('POST', `/mail/topics/${topic}/move`, { ws: home })).status, 400);
  const mv = await H('POST', `/mail/topics/${topic}/move`, { ws: other }).then(json);
  assert.equal(mv.ws, other);
  s = await H('GET', '/sync').then(json);
  assert.ok(!s.mailTopics.some(t => t.id === topic && t.title === 'Move me') && !s.entries.some(e => e.id === draft));
  const o = await O('GET', '/sync').then(json);
  const moved = o.mailThreads.filter(t => t.topic_id === mv.topic);
  assert.deepEqual(moved.map(t => t.subject).sort(), ['Move me', 'New mail']);
  assert.ok(o.entries.some(e => e.kind === 'mail' && e.notes === 'reply to finish' && moved.some(t => t.id === e.thread_id)));
  const spost = moved.find(t => t.subject === 'Move me');
  const reply = await H('POST', '/mail/incoming', { message_id: '<sp2@supplier.example>', in_reply_to: '<sp1@supplier.example>', from: 'mario@supplier.example', subject: 'Re: Move me', body: 'again' }).then(json);
  assert.equal(reply.thread, spost.id);

  // Open in Thunderbird: needs extension 1.7; the Message-ID reaches the extension once.
  const msg = (await O('GET', `/mail/threads/${spost.id}`).then(json)).messages[0];
  assert.equal((await O('POST', `/mail/messages/${msg.id}/open`)).status, 409);
  const ctrl = new AbortController();
  const stream = await fetch(`${url}/api/mail/stream`, { headers: { Authorization: `Bearer ${token}`, 'X-Organizer-Ext': '1.7' }, signal: ctrl.signal });
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  await reader.read();
  assert.equal((await O('POST', `/mail/messages/${msg.id}/open`)).status, 204);
  assert.match((await reader.read()).value, /event: open/);
  assert.deepEqual(await call('GET', '/mail/opens', { token }).then(json), ['sp1@supplier.example']);
  assert.deepEqual(await call('GET', '/mail/opens', { token }).then(json), []);
  ctrl.abort();
});

test('thunderbird: mails read in Organizer are marked read in Thunderbird (and unread again)', async () => {
  const { token } = config();
  const tb = (method, p, body, headers) => call(method, p, { token, body, headers });
  const json = r => (r.status === 204 ? null : r.json());
  const r = await tb('POST', '/mail/incoming', { message_id: '<read1@supplier.example>', from: 'Anna <anna@supplier.example>', subject: 'Board B', body: 'hi', inbox: true }).then(json);
  const th = await tb('GET', `/mail/threads/${r.thread}`).then(json);
  const msg = th.messages.find(m => m.message_id === 'read1@supplier.example');
  await tb('GET', '/mail/reads'); // what the previous tests read

  const ctrl = new AbortController();
  const stream = await fetch(`${url}/api/mail/stream`, { headers: { Authorization: `Bearer ${token}`, 'X-Organizer-Ext': '1.9' }, signal: ctrl.signal });
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  assert.match((await reader.read()).value, /event: hello/);

  await tb('PATCH', `/mail/messages/${msg.id}`, { read: true });
  assert.match((await reader.read()).value, /event: read/);
  assert.deepEqual(await tb('GET', '/mail/reads').then(json), [['read1@supplier.example', true]]);
  assert.deepEqual(await tb('GET', '/mail/reads').then(json), []); // taken once

  await tb('PATCH', `/mail/threads/${r.thread}`, { read: false });
  assert.match((await reader.read()).value, /event: read/);
  assert.deepEqual(await tb('GET', '/mail/reads').then(json), [['read1@supplier.example', false]]);
  ctrl.abort();
});
