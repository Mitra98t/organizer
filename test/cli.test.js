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

  // Note sul documento: generali prima, poi per pagina con i numeri dei segnaposto; le risolte solo con --all.
  const note = body => call('POST', `/docs/${id}/notes`, { token: config().token, body }).then(r => r.json());
  await note({ text: 'in fondo', page: 2, x: 0.5, y: 0.9 });
  await note({ text: 'in alto', page: 1, x: 0.5, y: 0.1 });
  await note({ text: 'generale' });
  const done = await note({ text: 'vecchia', page: 1, x: 0.1, y: 0.05 });
  await call('PATCH', `/doc-notes/${done.id}`, { token: config().token, body: { resolved: true } });
  const notes = JSON.parse(await org(['doc', 'notes', String(id), '--json']));
  assert.deepEqual(notes.general.map(n => n.text), ['generale']);
  assert.deepEqual(notes.pinned.map(n => [n.num, n.text]), [[1, 'in alto'], [2, 'in fondo']]);
  assert.equal(JSON.parse(await org(['doc', 'notes', String(id), '--all', '--json'])).pinned[0].text, 'vecchia');

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

test('mail mandate in attesa di risposta e tipi di documento aggiunti', async () => {
  await org(['login', url, '-u', 'fede', '--password-stdin'], { input: 'password-di-prova\n' }); // il test dei token fa logout
  const login = await call('POST', '/login', { body: { username: 'fede', password: 'password-di-prova' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const mail = (await (await call('POST', '/entries', { cookie, body: { text: 'm: richiesta campioni >fab@ditta.example' } })).json()).id;
  const entry = async () => (await (await call('GET', '/sync', { cookie })).json()).entries.find(e => e.id === mail);
  await call('PATCH', `/entries/${mail}`, { cookie, body: { done: true } });
  assert.equal((await entry()).awaiting_reply, 1); // mandata: aspetta una risposta
  await org(['mail', 'replied', String(mail)]);
  assert.equal((await entry()).awaiting_reply, 0);
  const shown = JSON.parse(await org(['show', String(mail), '--json']));
  assert.ok(shown.logs.some(l => l.system && l.text === 'risposta arrivata'));

  // Tipo nuovo: si usa nei documenti; eliminandolo i documenti tornano "altro".
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

test('colore dei contatti: tinta 0..359 o automatico', async () => {
  const login = await call('POST', '/login', { body: { username: 'fede', password: 'password-di-prova' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { id } = await (await call('POST', '/contacts', { cookie, body: { name: 'Luca', email: 'luca@ditta.example' } })).json();
  const hueOf = async () => (await (await call('GET', '/sync', { cookie })).json()).contacts.find(c => c.id === id).hue;
  assert.equal(await hueOf(), null);
  assert.equal((await call('PATCH', `/contacts/${id}`, { cookie, body: { hue: 210 } })).status, 204);
  assert.equal(await hueOf(), 210);
  assert.equal((await call('PATCH', `/contacts/${id}`, { cookie, body: { hue: 400 } })).status, 400);
  await call('PATCH', `/contacts/${id}`, { cookie, body: { hue: null } });
  assert.equal(await hueOf(), null);
});

test('codici alternativi: unici, #ALTERNATIVO porta all\'articolo, promozione a principale', async () => {
  const login = await call('POST', '/login', { body: { username: 'fede', password: 'password-di-prova' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const sync = async () => (await call('GET', '/sync', { cookie })).json();
  const { id } = await (await call('POST', '/items', { cookie, body: { code: 'LED-01', name: 'led bianco' } })).json();
  assert.equal((await call('POST', `/items/${id}/aliases`, { cookie, body: { code: 'C503D-WAN' } })).status, 204);
  // Già preso (come alternativo, o come codice principale di un altro articolo): no.
  assert.equal((await call('POST', '/items', { cookie, body: { code: 'c503d-wan' } })).status, 409);
  assert.equal((await call('POST', `/items/${id}/aliases`, { cookie, body: { code: 'SCH-042' } })).status, 409);

  // Una voce che cita il codice alternativo è collegata all'articolo (non ne crea uno nuovo).
  const e = (await (await call('POST', '/entries', { cookie, body: { text: 'ordinare #C503D-WAN' } })).json()).id;
  let d = await sync();
  assert.deepEqual(d.entryItems.filter(x => x.entry_id === e).map(x => x.item_id), [id]);
  assert.ok(!d.items.some(i => i.code.toUpperCase() === 'C503D-WAN'));

  // L'alternativo diventa il principale: il vecchio principale resta tra gli alternativi.
  await call('PATCH', `/items/${id}`, { cookie, body: { code: 'C503D-WAN' } });
  d = await sync();
  assert.equal(d.items.find(i => i.id === id).code, 'C503D-WAN');
  assert.deepEqual(d.itemAliases.filter(a => a.item_id === id).map(a => a.code), ['LED-01']);

  // Dalla CLI: elenco, aggiunta, rimozione.
  await org(['login', url, '-u', 'fede', '--password-stdin'], { input: 'password-di-prova\n' });
  await org(['item', 'alias', 'LED-01', 'NSPW500']);
  assert.deepEqual(JSON.parse(await org(['item', 'alias', 'C503D-WAN', '--json'])).sort(), ['LED-01', 'NSPW500']);
  await org(['item', 'alias', 'C503D-WAN', '--rm', 'LED-01']);
  assert.deepEqual(JSON.parse(await org(['item', 'show', 'NSPW500', '--json'])).aliases, ['NSPW500']);
});

test('file .json: si caricano come documenti e come allegati, non come link', async () => {
  await org(['login', url, '-u', 'fede', '--password-stdin'], { input: 'password-di-prova\n' });
  const src = path.join(dir, 'profilo.json');
  fs.writeFileSync(src, '{"led": "SCH-042", "corrente": 20}');
  const [id] = JSON.parse(await org(['doc', 'up', 'SCH-042', src, '--json']));
  const out = path.join(dir, 'giu-json');
  fs.mkdirSync(out);
  await org(['doc', 'get', String(id), '-o', out]);
  assert.equal(fs.readFileSync(path.join(out, 'profilo.json'), 'utf8'), fs.readFileSync(src, 'utf8'));

  const [mail] = JSON.parse(await org(['add', '--mail', 'invio profilo >ufficio@ditta.example', '--json']));
  await org(['mail', 'attach', String(mail), src]);
  const e = JSON.parse(await org(['show', String(mail), '--json']));
  assert.deepEqual(e.attachments.map(a => a.filename), ['profilo.json']);
  // Un link si crea ancora con il corpo JSON senza ?name=.
  const { token } = config();
  const item = (await (await call('GET', '/sync', { token })).json()).items.find(i => i.code === 'SCH-042');
  assert.equal((await call('POST', `/items/${item.id}/docs`, { token, body: { url: 'example.com/x' } })).status, 400);
});
