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

const call = (method, p, { body, token, cookie, signal } = {}) => fetch(`${url}/api${p}`, {
  method,
  signal,
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

  // Nota su un pezzo di testo: il testo selezionato e i riquadri evidenziati (anche su due pagine).
  const marks = [[1, 0.1, 0.3, 0.5, 0.02], [2, 0.1, 0.05, 0.2, 0.02]];
  await note({ text: 'controlla il valore', page: 1, x: 0.1, y: 0.3, quote: '  tensione   di uscita\n12 V ', marks });
  const q = JSON.parse(await org(['doc', 'notes', String(id), '--json'])).pinned.find(n => n.text === 'controlla il valore');
  assert.equal(q.quote, 'tensione di uscita 12 V');
  assert.deepEqual(JSON.parse(q.marks), marks);
  assert.match(await org(['doc', 'notes', String(id)]), /«tensione di uscita 12 V»/);
  const bad = await call('POST', `/docs/${id}/notes`, { token: config().token, body: { text: 'x', page: 1, x: 0.1, y: 0.1, quote: 'x', marks: [[0, 0.1, 0.1, 2, 0.1]] } });
  assert.equal(bad.status, 400);

  // Modelli 3D: il punto ha anche z (0..1 nel riquadro del modello).
  const stl = path.join(dir, 'staffa.stl');
  fs.writeFileSync(stl, 'solid staffa\nendsolid staffa\n');
  const [mid] = JSON.parse(await org(['doc', 'up', 'SCH-042', stl, '-k', 'altro', '--json']));
  const n3 = await call('POST', `/docs/${mid}/notes`, { token: config().token, body: { text: 'foro M3', page: 1, x: 0.2, y: 0.4, z: 1 } }).then(r => r.json());
  assert.equal((await call('POST', `/docs/${mid}/notes`, { token: config().token, body: { text: 'fuori', page: 1, x: 0.2, y: 0.4, z: 1.5 } })).status, 400);
  await call('PATCH', `/doc-notes/${n3.id}`, { token: config().token, body: { page: 1, x: 0.3, y: 0.4, z: 0.7 } });
  const m = JSON.parse(await org(['doc', 'notes', String(mid), '--json']));
  assert.deepEqual(m.pinned.map(n => [n.text, n.x, n.z]), [['foro M3', 0.3, 0.7]]);
  assert.match(await org(['doc', 'notes', String(mid)]), /Sul modello/);

  await org(['doc', 'rename', String(id), 'firmware relè']);
  const out = path.join(dir, 'giu');
  fs.mkdirSync(out);
  await org(['doc', 'get', String(id), '-o', out]);
  assert.deepEqual(fs.readFileSync(path.join(out, 'firmware relè.bin')), fs.readFileSync(src));
});

test('thunderbird: thread, mandata, risposta, storia, collegamenti, archivio', async () => {
  const { token } = config();
  const tb = (method, p, body) => call(method, p, { token, body });
  const json = r => (r.status === 204 ? null : r.json());
  const { id } = await tb('POST', '/entries', { text: 'offerta relè', kind: 'mail' }).then(json);
  await tb('PATCH', `/entries/${id}`, { contact: 'mario@fornitore.it', mail_subject: 'Offerta relè' });
  assert.equal((await tb('POST', `/entries/${id}/compose`)).status, 409); // nessuna estensione collegata
  const tid = (await tb('GET', `/entries/${id}`).then(json)).thread_id;
  assert.ok(tid); // ogni mail scritta in Organizer sta in un thread

  // L'estensione tiene aperto il flusso: il server sa che c'è e la avvisa delle mail da aprire.
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
  assert.deepEqual([req.to, req.subject, req.reply_to], ['mario@fornitore.it', 'Offerta relè', null]);
  assert.equal((await tb('POST', `/mail/outbox/${ws}/${req.id}/claim`)).status, 204);
  assert.equal((await tb('POST', `/mail/outbox/${ws}/${req.id}/claim`)).status, 409); // un solo Thunderbird la apre

  await tb('POST', '/mail/sent', { ws, outbox_id: req.id, message_id: '<abc@organizer.test>', to: 'mario@fornitore.it', subject: 'Offerta relè' });
  let e = await tb('GET', `/entries/${id}`).then(json);
  assert.deepEqual([!!e.done_at, e.awaiting_reply], [true, 1]);
  assert.deepEqual(await tb('GET', '/mail/watch').then(json), ['abc@organizer.test']);

  // Solo risposte: una mail qualsiasi non entra; la risposta sì e chiude l'attesa. Cita una mail vecchia che
  // Organizer non ha: il server la chiede (missing) e l'estensione la manda come storia.
  assert.deepEqual(await tb('POST', '/mail/incoming', { message_id: 'altro@x', in_reply_to: '<nessuno@x>' }).then(json), { matched: false, missing: [] });
  const reply = { message_id: '<r1@fornitore.it>', in_reply_to: '<abc@organizer.test>', references: ['<old@fornitore.it>', '<abc@organizer.test>'],
    from: 'Mario Rossi <mario@fornitore.it>', subject: 'Re: Offerta relè', body: 'Va bene, mando il preventivo per la SCH-042.\n\nIl giorno 28/10 Fede ha scritto:\n> Offerta' };
  const r1 = await tb('POST', '/mail/incoming', reply).then(json);
  assert.deepEqual([r1.thread, r1.missing], [tid, ['old@fornitore.it']]);
  assert.deepEqual((await tb('POST', '/mail/incoming', reply).then(json)).thread, tid); // già vista: nessun doppione
  await tb('POST', '/mail/incoming', { message_id: '<old@fornitore.it>', from: 'Mario Rossi <mario@fornitore.it>', subject: 'Listino',
    body: 'listino vecchio', date: '2026-09-01T10:00:00.000Z', history: true, thread: r1.thread });
  e = await tb('GET', `/entries/${id}`).then(json);
  assert.equal(e.awaiting_reply, 0);
  const th = await tb('GET', `/mail/threads/${tid}`).then(json);
  assert.deepEqual(th.messages.map(m => [m.direction, m.message_id, !!m.read_at]),
    [['in', 'old@fornitore.it', true], ['out', 'abc@organizer.test', true], ['in', 'r1@fornitore.it', false]]);

  // Il codice di magazzino scritto nella risposta collega il thread all'articolo; i collegamenti si aggiungono a mano.
  let s = await tb('GET', '/sync').then(json);
  const sch = s.items.find(i => i.code === 'SCH-042');
  assert.ok(s.threadLinks.some(l => l.thread_id === tid && l.kind === 'articolo' && l.target_id === sch.id));
  const contact = await tb('POST', '/contacts', { name: 'Mario', email: 'mario@fornitore.it' }).then(json);
  await tb('POST', `/mail/threads/${tid}/links`, { kind: 'contatto', id: contact.id });
  s = await tb('GET', '/sync').then(json);
  assert.ok(s.threadLinks.some(l => l.thread_id === tid && l.kind === 'contatto' && l.manual));

  // Leggere non archivia; archiviare sì (e segna letto). Una risposta nuova riporta il thread tra gli attivi.
  await tb('PATCH', `/mail/threads/${tid}`, { read: true });
  s = await tb('GET', '/sync').then(json);
  assert.deepEqual([s.mailThreads.find(t => t.id === tid).archived_at, s.mailMsgs.filter(m => m.thread_id === tid && !m.read_at).length], [null, 0]);
  await tb('PATCH', `/mail/threads/${tid}`, { archived: true });
  assert.ok((await tb('GET', '/sync').then(json)).mailThreads.find(t => t.id === tid).archived_at);
  await tb('POST', '/mail/incoming', { message_id: '<r2@fornitore.it>', in_reply_to: '<r1@fornitore.it>', from: 'mario@fornitore.it', subject: 'Re: Offerta relè', body: 'ancora io' });
  assert.equal((await tb('GET', '/sync').then(json)).mailThreads.find(t => t.id === tid).archived_at, null);

  // Rispondi: una mail nuova nel thread, che Thunderbird aprirà come risposta al messaggio.
  const { id: rid } = await tb('POST', `/mail/messages/${th.messages[2].id}/reply`).then(json);
  const r = await tb('GET', `/entries/${rid}`).then(json);
  assert.deepEqual([r.kind, r.contact, r.mail_subject, r.thread_id], ['mail', 'mario@fornitore.it', 'Re: Offerta relè', tid]);
  await tb('POST', `/entries/${rid}/compose`);
  assert.equal((await tb('GET', '/mail/outbox').then(json)).at(-1).reply_to, 'r1@fornitore.it');

  // Tutta la posta in arrivo: una mail nuova apre un thread; Rispondi a tutti senza i nostri indirizzi.
  await tb('POST', '/mail/identities', { addresses: ['Fede <fede@organizer.test>'] });
  const news = { message_id: '<n1@cliente.it>', from: 'Anna Bianchi <anna@cliente.it>', to: 'fede@organizer.test, luca@cliente.it',
    cc: 'Ufficio <ufficio@cliente.it>', subject: 'Richiesta campioni', body: 'Ci servono 5 campioni @ 12V !urgente', inbox: true,
    attachments: [{ name: 'relè.pdf', part: '1.2', size: 1234, type: 'application/pdf' }] };
  const n1 = await tb('POST', '/mail/incoming', news).then(json);
  assert.ok(n1.thread && n1.thread !== tid);
  const nt = await tb('GET', `/mail/threads/${n1.thread}`).then(json);
  assert.deepEqual([nt.subject, nt.messages.length], ['Richiesta campioni', 1]);
  const { id: aid } = await tb('POST', `/mail/messages/${nt.messages[0].id}/reply`, { all: true }).then(json);
  const a = await tb('GET', `/entries/${aid}`).then(json);
  assert.deepEqual([a.contact, a.mail_cc, a.mail_subject, a.thread_id], ['anna@cliente.it', 'luca@cliente.it, ufficio@cliente.it', 'Re: Richiesta campioni', n1.thread]);

  // Allegato ricevuto → documento: Organizer lo chiede all'estensione, che lo carica sull'articolo.
  assert.equal((await tb('POST', '/mail/attachments/save', { id: nt.messages[0].id, n: 0, item_id: sch.id, kind: 'datasheet' })).status, 200);
  const [f] = await tb('GET', '/mail/fetches').then(json);
  assert.deepEqual([f.part, f.name, f.kind, f.message_id, f.item_id], ['1.2', 'relè.pdf', 'datasheet', 'n1@cliente.it', sch.id]);
  assert.equal((await tb('POST', `/mail/fetches/${f.id}/claim`)).status, 204);
  const up = await fetch(`${url}/api/items/${f.item_id}/docs?${new URLSearchParams({ name: f.name, kind: f.kind })}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Workspace': String(f.ws), 'Content-Type': 'application/pdf' }, body: Buffer.from('%PDF-1.4 prova') });
  assert.equal(up.status, 200);
  await tb('POST', `/mail/fetches/${f.id}/done`);
  assert.deepEqual(await tb('GET', '/mail/fetches').then(json), []);

  // Thread portato a mano da Thunderbird (anche vecchio, anche senza "tutta la posta"): dal più vecchio, tutto
  // nello stesso thread, già letto ma tra gli attivi; un thread archiviato con un messaggio già visto torna attivo.
  const old = { from: 'Giulia <giulia@studio.it>', to: 'fede@organizer.test', subject: 'Disegni staffa', date: '2025-03-01T10:00:00Z' };
  const i1 = await tb('POST', '/mail/incoming', { ...old, message_id: '<s1@studio.it>', body: 'ecco il DXF', import: true }).then(json);
  const i2 = await tb('POST', '/mail/incoming', { ...old, message_id: '<s2@studio.it>', in_reply_to: '<s1@studio.it>', references: ['<s1@studio.it>'],
    subject: 'Re: Disegni staffa', date: '2025-03-02T10:00:00Z', import: true, thread: i1.thread }).then(json);
  assert.equal(i2.thread, i1.thread);
  let it = (await tb('GET', '/sync').then(json));
  assert.deepEqual([it.mailThreads.find(t => t.id === i1.thread).archived_at, it.mailMsgs.filter(m => m.thread_id === i1.thread && !m.read_at).length], [null, 0]);
  await tb('PATCH', `/mail/threads/${i1.thread}`, { archived: true });
  await tb('POST', '/mail/incoming', { ...old, message_id: '<s1@studio.it>', import: true });
  it = (await tb('GET', '/sync').then(json));
  assert.equal(it.mailThreads.find(t => t.id === i1.thread).archived_at, null);

  // Senza riferimenti: stesso oggetto e una persona in comune → stessa conversazione; persona diversa → nuova.
  const s3 = await tb('POST', '/mail/incoming', { ...old, message_id: '<s3@studio.it>', subject: 'R: Disegni staffa', date: '2025-03-03T10:00:00Z', import: true }).then(json);
  assert.equal(s3.thread, i1.thread);
  const s4 = await tb('POST', '/mail/incoming', { ...old, from: 'altri@ditta.it', message_id: '<s4@ditta.it>', date: '2025-03-03T11:00:00Z', import: true }).then(json);
  assert.notEqual(s4.thread, i1.thread);
  const tree = await tb('GET', `/mail/threads/${i1.thread}`).then(json);
  assert.deepEqual(tree.messages.map(m => [m.message_id, m.in_reply_to]), [['s1@studio.it', ''], ['s2@studio.it', 's1@studio.it'], ['s3@studio.it', '']]);

  // Topic: ogni conversazione nel suo; spostarla in un altro li unisce (il topic vuoto sparisce), "new" la separa.
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
  await tb('PATCH', `/mail/topics/${ta}`, { title: 'Staffa motore', starred: true });
  it = await tb('GET', '/sync').then(json);
  assert.deepEqual([topicOf(it, s4.thread), it.mailTopics.find(t => t.id === ta).title, it.mailTopics.some(t => t.id === alone)], [ta, 'Staffa motore', false]);

  // Anche il topic intero si collega (es. al suo progetto); unendo i topic i collegamenti passano.
  const proj = await tb('POST', '/projects', { name: 'Staffe', tag: 'staffe' }).then(json);
  await tb('POST', `/mail/topics/${ta}/links`, { kind: 'progetto', id: proj.id });
  const { topic: t2 } = await tb('PATCH', `/mail/threads/${s4.thread}`, { topic: 'new' }).then(json);
  await tb('POST', `/mail/topics/${ta}/merge`, { into: t2 });
  it = await tb('GET', '/sync').then(json);
  assert.deepEqual(it.topicLinks.filter(l => l.topic_id === t2).map(l => [l.kind, l.target_id]), [['progetto', proj.id]]);
  await tb('DELETE', `/mail/topics/${t2}/links/progetto/${proj.id}`);
  assert.equal((await tb('GET', '/sync').then(json)).topicLinks.length, 0);

  // Collegamento automatico tolto a mano: non torna, nemmeno con un'altra mail che cita il codice.
  await tb('DELETE', `/mail/threads/${tid}/links/articolo/${sch.id}`);
  await tb('POST', '/mail/incoming', { message_id: '<r3@fornitore.it>', in_reply_to: '<r2@fornitore.it>', from: 'mario@fornitore.it', subject: 'Re: Offerta relè', body: 'SCH-042 di nuovo' });
  assert.ok(!(await tb('GET', '/sync').then(json)).threadLinks.some(l => l.thread_id === tid && l.kind === 'articolo' && l.target_id === sch.id));

  // Ricerca nel testo intero (per "[["): ogni parola in oggetto, testo, indirizzi o nome in rubrica.
  await tb('POST', '/mail/incoming', { message_id: '<p1@cliente.it>', from: 'mb@cliente.it', to: 'fede@organizer.test', subject: 'Alimentazione banco',
    body: 'Il regolatore regge solo 500mA, serve un PSU più grosso.', inbox: true });
  await tb('POST', '/contacts', { name: 'Marco Bianchi', email: 'mb@cliente.it' });
  const found = await tb('GET', `/mail/search?${new URLSearchParams({ q: 'marco 500mA' })}`).then(json);
  assert.equal(found.length, 1);
  assert.deepEqual(await tb('GET', `/mail/search?${new URLSearchParams({ q: 'marco 800mA' })}`).then(json), []);
  // [[mail:ID]] in una voce: la conversazione è citata (backlink); per gli altri resta "non accessibile".
  const { id: cite } = await tb('POST', '/entries', { text: `chiedere a Marco [[mail:${found[0]}]]` }).then(json);
  assert.deepEqual((await tb('GET', `/backlinks/mail/${found[0]}`).then(json)).map(e => e.id), [cite]);
  assert.equal((await tb('POST', '/refs', { refs: [['mail', found[0]]] }).then(json))[`mail:${found[0]}`].status, 'ok');

  // Codici scritti alla buona nelle mail (senza trattino, con o senza zeri davanti): si collegano lo stesso.
  const { id: s44 } = await tb('POST', '/items', { code: 'SCH-44', name: 'Scheda di prova' }).then(json);
  const loose = await tb('POST', '/mail/incoming', { message_id: '<l1@fornitore.it>', from: 'mario@fornitore.it', subject: 'Disponibilità',
    body: 'Abbiamo la sch44 e anche qualche sch042, ma non la sch4.', inbox: true }).then(json);
  const looseLinks = (await tb('GET', '/sync').then(json)).threadLinks.filter(l => l.thread_id === loose.thread && l.kind === 'articolo').map(l => l.target_id);
  assert.deepEqual(looseLinks.sort(), [s44, sch.id].sort());

  // Codici di 2 caratteri (una lettera e una cifra): si collegano come parola a sé, non dentro "Q55".
  const { id: q5 } = await tb('POST', '/items', { code: 'Q5' }).then(json);
  const short = await tb('POST', '/mail/incoming', { message_id: '<g1@fornitore.it>', from: 'g@fornitore.it', subject: 'Prova termica',
    body: 'Il Q5 scalda un po\' sotto carico.', inbox: true }).then(json);
  const notShort = await tb('POST', '/mail/incoming', { message_id: '<g2@fornitore.it>', from: 'h@fornitore.it', subject: 'Altro',
    body: 'Il modello Q55 invece no.', inbox: true }).then(json);
  const linked = async th => (await tb('GET', '/sync').then(json)).threadLinks.some(l => l.thread_id === th && l.kind === 'articolo' && l.target_id === q5);
  assert.deepEqual([await linked(short.thread), await linked(notShort.thread)], [true, false]);

  // Codici nuovi in magazzino (articolo creato, codice cambiato, alternativo aggiunto): le conversazioni attive
  // che li citano si collegano; quelle archiviate no, finché non tornano attive.
  const mk = (n, body) => tb('POST', '/mail/incoming', { message_id: `<rl${n}@fornitore.it>`, from: `p${n}@fornitore.it`, subject: `Relè ${n}`, body, inbox: true }).then(json);
  const ra = await mk(1, 'Serve il RLY-77 e il modulo G5V1, poi il nuovo RLY-88.');
  const rb = await mk(2, 'Anche qui RLY-77.');
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
  // Il codice cambia (o un alternativo si toglie): i collegamenti automatici che non valgono più spariscono,
  // quelli messi a mano restano.
  await tb('POST', `/mail/threads/${rb.thread}/links`, { kind: 'articolo', id: rly });
  await tb('PATCH', `/items/${rly}`, { code: 'RLY-99' });
  assert.deepEqual([await linksOf(ra.thread), await linksOf(rb.thread)].map(l => l.includes(rly)), [false, true]);
  await tb('DELETE', `/items/${abc}/aliases/G5V-1`);
  assert.ok(!(await linksOf(ra.thread)).includes(abc));

  // Contatti da non proporre: regole dell'account (minuscole, senza doppioni).
  await tb('PATCH', '/me', { mailIgnore: ['NoReply', 'noreply', '@amazon.it'] });
  assert.deepEqual((await tb('GET', '/sync').then(json)).mailIgnore, ['noreply', '@amazon.it']);

  // Primo collegamento: l'estensione carica l'ultimo mese, poi lo segna fatto.
  assert.ok((await tb('GET', '/mail/backfill').then(json)).since);
  await tb('POST', '/mail/backfill/done');
  assert.equal((await tb('GET', '/mail/backfill').then(json)).since, null);

  // Rinomina; Elimina porta il thread nel cestino con la sua bozza (una riga sola), Ripristina li riporta.
  await tb('PATCH', `/mail/threads/${tid}`, { subject: 'Relè per il banco' });
  assert.equal((await tb('GET', '/sync').then(json)).mailThreads.find(t => t.id === tid).subject, 'Relè per il banco');
  const trashBefore = (await tb('GET', '/sync').then(json)).trashCount;
  assert.equal((await tb('DELETE', `/mail/threads/${n1.thread}`)).status, 204);
  let d = await tb('GET', '/sync').then(json);
  assert.ok(!d.mailThreads.some(t => t.id === n1.thread) && !d.entries.some(x => x.id === aid));
  assert.equal(d.trashCount, trashBefore + 1);
  let bin = await tb('GET', '/trash').then(json);
  assert.deepEqual(bin.threads.map(t => [t.subject, t.messages]), [['Richiesta campioni', 1]]);
  assert.ok(!bin.entries.some(x => x.id === aid));
  assert.equal((await tb('GET', `/mail/threads/${n1.thread}`)).status, 404);
  // Thunderbird la ripassa (es. al riavvio): già vista, non riapre niente.
  assert.deepEqual(await tb('POST', '/mail/incoming', news).then(json), { matched: true, thread: null, missing: [] });
  assert.equal((await tb('GET', '/sync').then(json)).mailThreads.length, d.mailThreads.length);
  await tb('POST', `/trash/thread/${n1.thread}/restore`);
  d = await tb('GET', '/sync').then(json);
  assert.ok(d.mailThreads.some(t => t.id === n1.thread) && d.entries.find(x => x.id === aid)?.thread_id === n1.thread);
  // Eliminato definitivamente: via anche la bozza.
  await tb('DELETE', `/mail/threads/${n1.thread}`);
  assert.equal((await tb('DELETE', `/trash/thread/${n1.thread}`)).status, 204);
  bin = await tb('GET', '/trash').then(json);
  assert.deepEqual([bin.threads.length, bin.entries.some(x => x.id === aid)], [0, false]);
  assert.equal((await tb('GET', `/entries/${aid}`)).status, 404);

  // La posta è personale: un altro membro del workspace non vede né mail né thread, nemmeno da admin.
  const { code } = await tb('POST', '/admin/invites').then(json);
  const reg = await call('POST', '/register', { body: { code, username: 'luca', password: 'password-di-luca' } });
  const cookie = reg.headers.get('set-cookie').split(';')[0];
  const other = await call('GET', '/sync', { cookie }).then(json);
  assert.deepEqual([other.entries.length, other.mailThreads.length, other.mailMsgs.length], [0, 0, 0]);
  assert.equal((await call('GET', `/mail/threads/${tid}`, { cookie })).status, 404);
  assert.equal((await call('POST', '/refs', { cookie, body: { refs: [['mail', tid]] } }).then(json))[`mail:${tid}`].status, 'hidden');
  assert.deepEqual(await call('GET', `/mail/search?q=offerta`, { cookie }).then(json), []);

  // L'estensione si scarica già impostata per questo server.
  const xpi = Buffer.from(await (await tb('GET', '/mail/thunderbird.xpi')).arrayBuffer());
  assert.equal(xpi.subarray(0, 2).toString(), 'PK');
  ctrl.abort();
});

test('privato di default: +persona, ++persona, +all per voci, progetti, contatti, note', async () => {
  const { token } = config();
  const me = (method, p, body) => call(method, p, { token, body }).then(r => (r.status === 204 ? null : r.json()));
  const login = await call('POST', '/login', { body: { username: 'luca', password: 'password-di-luca' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const luca = () => call('GET', '/sync', { cookie }).then(r => r.json());
  const lucaId = (await luca()).me.id;
  const titles = d => d.entries.map(e => e.title).sort();

  const { id: mine } = await me('POST', '/entries', { text: 'solo mio' });
  const { id: shared } = await me('POST', '/entries', { text: 'da vedere +luca' });
  const { id: assigned } = await me('POST', '/entries', { text: 'da fare ++luca' });
  await me('POST', '/entries', { text: 'per tutti +all' });
  await me('POST', '/entries', { text: 'a chi? +nessuno' });
  let d = await luca();
  assert.deepEqual(titles(d), ['da fare', 'da vedere', 'per tutti']);
  assert.equal(d.entries.find(e => e.id === assigned).assignee_id, lucaId);
  assert.equal(d.entries.find(e => e.id === shared).assignee_id, null);
  assert.ok(d.shares.some(s => s.kind === 'entry' && s.obj_id === shared && s.user_id === lucaId));
  assert.equal((await call('GET', `/entries/${mine}`, { cookie })).status, 404);
  assert.equal((await me('GET', `/entries/${(await me('GET', '/sync')).entries.find(e => e.title.startsWith('a chi?')).id}`)).title, 'a chi? +nessuno');

  // Solo chi l'ha creata decide con chi condividerla; si può anche togliere.
  assert.equal((await call('PUT', `/shares/entry/${shared}`, { cookie, body: { users: [] } })).status, 403);
  await me('PUT', `/shares/entry/${shared}`, { users: [], all: false });
  assert.deepEqual(titles(await luca()), ['da fare', 'per tutti']);
  await me('PUT', `/shares/entry/${mine}`, { users: [lucaId] });
  assert.ok(titles(await luca()).includes('solo mio'));

  // Progetti e contatti privati, condivisi dalla barra o dal pannello; note sui documenti con +persona nel testo.
  const { id: pid } = await me('POST', '/projects', { name: 'Segreto' });
  await me('POST', '/projects', { name: 'Comune', share: ['luca'] });
  const { id: cid } = await me('POST', '/contacts', { name: 'Fornitore', email: 'f@x.it' });
  const doc = (await me('GET', '/sync')).docs[0];
  await me('POST', `/docs/${doc.id}/notes`, { text: 'nota mia' });
  await me('POST', `/docs/${doc.id}/notes`, { text: 'guarda qui +luca' });
  d = await luca();
  assert.deepEqual(d.projects.map(p => p.name), ['Comune']);
  assert.equal(d.contacts.length, 0);
  assert.deepEqual(d.docNotes.map(n => n.text), ['guarda qui']);
  assert.ok(d.docs.some(x => x.id === doc.id)); // magazzino e documenti restano di tutti
  await me('PUT', `/shares/project/${pid}`, { all: true });
  await me('PUT', `/shares/contact/${cid}`, { users: [lucaId] });
  d = await luca();
  assert.deepEqual([d.projects.length, d.contacts.map(c => c.name)], [2, ['Fornitore']]);

  // "all" non è un nome utente.
  const { code } = await me('POST', '/admin/invites');
  assert.equal((await call('POST', '/register', { body: { code, username: 'all', password: 'password-di-all' } })).status, 400);
});

test('collegamenti citati: archiviati, non condivisi, eliminati', async () => {
  const { token } = config();
  const json = r => (r.status === 204 ? null : r.json());
  const me = (method, p, body) => call(method, p, { token, body }).then(json);
  const cookie = (await call('POST', '/login', { body: { username: 'luca', password: 'password-di-luca' } })).headers.get('set-cookie').split(';')[0];
  const { id: priv } = await me('POST', '/entries', { text: 'segreta' });
  const { id: open } = await me('POST', '/entries', { text: 'per luca +luca' });
  const { id: gone } = await me('POST', '/entries', { text: 'da eliminare +luca' });
  await me('DELETE', `/entries/${gone}`);
  const { id: pid } = await me('POST', '/projects', { name: 'Riservato' });
  const r = await call('POST', '/refs', { cookie, body: { refs: [['voce', priv], ['voce', open], ['voce', gone], ['progetto', pid], ['voce', 999999]] } }).then(json);
  assert.deepEqual(r[`voce:${priv}`], { status: 'hidden' });
  assert.deepEqual([r[`voce:${open}`].status, r[`voce:${open}`].title], ['ok', 'per luca']);
  assert.equal(r[`voce:${gone}`].status, 'gone');
  assert.equal(r[`progetto:${pid}`].status, 'hidden');
  assert.equal(r['voce:999999'].status, 'gone');
});

test('notifiche: assegnate, condivise, citate, chat (anche silenziata)', async () => {
  const { token } = config();
  const json = r => (r.status === 204 ? null : r.json());
  const me = (method, p, body) => call(method, p, { token, body }).then(json);
  const cookie = (await call('POST', '/login', { body: { username: 'luca', password: 'password-di-luca' } })).headers.get('set-cookie').split(';')[0];
  const luca = (method, p, body) => call(method, p, { cookie, body }).then(json);
  await luca('POST', '/notifications/read', { all: true });
  const fresh = async () => (await luca('GET', '/sync')).notifications.filter(n => !n.read_at).map(n => [n.kind, n.title, n.body]);

  const { id: a } = await me('POST', '/entries', { text: 'saldare connettore ++luca' });
  await me('POST', '/entries', { text: 'leggi il manuale +luca' });
  await me('POST', '/entries', { text: 'solo mia' });
  let n = await fresh();
  assert.deepEqual(n.map(x => x[1]).sort(), ['fede ti ha assegnato una todo', 'fede ti ha condiviso una todo']);
  assert.ok(n.some(x => x[2] === 'saldare connettore'));
  await me('POST', `/entries/${a}/log`, { text: 'fatto metà, guarda tu +luca' });
  assert.ok((await fresh()).some(x => x[1] === 'fede ti ha citato in un aggiornamento'));

  // Chat: ogni messaggio a chi non ha silenziato; silenziato, solo le citazioni. Leggere il canale le spegne.
  await luca('POST', '/notifications/read', { all: true });
  await me('POST', '/chat', { text: 'pausa caffè', channel: 'generale' });
  assert.deepEqual((await fresh()).map(x => x[1]), ['#generale · fede']);
  const gen = (await luca('GET', '/sync')).chatChannels.find(c => c.name === 'generale');
  await luca('POST', `/chat/channels/${gen.id}/mute`, { muted: true });
  await luca('POST', '/notifications/read', { all: true });
  await me('POST', '/chat', { text: 'altro messaggio', channel: 'generale' });
  assert.deepEqual(await fresh(), []);
  const { id: mid } = await me('POST', '/chat', { text: 'serve una mano +luca', channel: 'generale' });
  assert.deepEqual((await fresh()).map(x => x[1]), ['fede ti ha citato in #generale']);
  assert.equal((await luca('GET', '/sync')).chatChannels.find(c => c.name === 'generale').muted, 1);
  await luca('POST', '/chat/read', { id: mid, channel: gen.id });
  assert.deepEqual(await fresh(), []);
  await luca('POST', `/chat/channels/${gen.id}/mute`, { muted: false });

  // Nota su un documento con +luca; da una notifica di sistema si arriva all'indirizzo giusto.
  const doc = (await me('GET', '/sync')).docs[0];
  await me('POST', `/docs/${doc.id}/notes`, { text: 'controlla la quota +luca' });
  const [note] = (await luca('GET', '/sync')).notifications;
  assert.match(note.title, /ti ha citato in una nota su/);
  assert.deepEqual(await luca('GET', `/notifications/${note.id}`).then(x => [x.url.split('?')[0], !!x.workspace_id]), [`#/d/${doc.id}`, true]);
  assert.equal((await luca('GET', '/sync')).notifications[0].read_at !== null, true);
  assert.equal((await call('POST', '/push/subscribe', { cookie, body: { endpoint: 'http://non-https', keys: {} } })).status, 400);
});

test('giro di Organizer: workspace di prova con contenuti finti, poi eliminato', async () => {
  const cookie = (await call('POST', '/login', { body: { username: 'fede', password: 'password-di-prova' } })).headers.get('set-cookie').split(';')[0];
  const json = r => (r.status === 204 ? null : r.json());
  const me = (method, p, body) => call(method, p, { cookie, body }).then(json);
  const before = await me('GET', '/sync');
  assert.equal(before.onboarded, false); // account nuovo: riceve l'invito al giro
  const start = await me('POST', '/tour/start');
  assert.ok(start.ids.pdf && start.ids.model && start.ids.entry && start.ids.thread);
  assert.equal((await me('GET', '/sync')).onboarded, true);
  assert.deepEqual(await me('POST', '/tour/start').then(x => x.workspace_id), start.workspace_id); // si riprende lo stesso
  await me('POST', `/workspaces/${start.workspace_id}/switch`);
  const d = await me('GET', '/sync');
  assert.equal(d.tourWs, start.workspace_id);
  assert.ok(d.workspaces.find(w => w.id === start.workspace_id).tour);
  assert.deepEqual(d.users.filter(u => u.member).map(u => u.username).sort(), ['anna', 'fede', 'luca'].sort());
  assert.ok(d.entries.some(e => e.title.startsWith('calibrare sensori') && e.assignee_id === d.me.id)); // di Anna, assegnata a te
  assert.ok(d.entries.some(e => e.kind === 'mail' && e.awaiting_reply === 0 && e.done_at));
  assert.deepEqual([d.mailThreads.length, d.mailMsgs.length], [3, 3]); // preventivo (bozza), consegna (2 messaggi), alimentatori
  assert.deepEqual(d.chatChannels.map(c => c.name), ['generale', 'officina']);
  assert.ok(d.docNotes.some(n => n.z != null));
  assert.equal((await call('GET', `/docs/${start.ids.pdf}/file`, { cookie })).headers.get('content-type'), 'application/pdf');
  // Con l'app aperta nel workspace di prova (aggiornamenti in diretta): eliminarlo chiude la connessione e il
  // server non deve più scriverci.
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

test('voci create offline: niente doppioni se l\'invio si ripete, todo già fatta', async () => {
  const { token } = config();
  const post = body => call('POST', '/entries', { token, body }).then(r => r.json());
  const a = await post({ text: 'scritta in treno', kind: 'todo', client_id: 'cid-123' });
  const b = await post({ text: 'scritta in treno', kind: 'todo', client_id: 'cid-123' });
  assert.equal(a.id, b.id);
  const done = await post({ text: 'fatta offline', kind: 'todo', client_id: 'cid-456', done: '2026-10-29T08:00:00.000Z' });
  const e = await call('GET', `/entries/${done.id}`, { token }).then(r => r.json());
  assert.equal(e.done_at, '2026-10-29T08:00:00.000Z');
  const n = await post({ text: 'nota offline', kind: 'note', client_id: 'cid-789', done: true });
  assert.equal((await call('GET', `/entries/${n.id}`, { token }).then(r => r.json())).done_at, null); // le note non si "fanno"
});

test('chat a canali: membri, sola lettura, permesso di gestirli', async () => {
  const { token } = config();
  const me = (method, p, body) => call(method, p, { token, body });
  const json = r => (r.status === 204 ? null : r.json());
  const cookie = (await call('POST', '/login', { body: { username: 'luca', password: 'password-di-luca' } })).headers.get('set-cookie').split(';')[0];
  const luca = (method, p, body) => call(method, p, { cookie, body });
  const lucaId = (await luca('GET', '/sync').then(json)).me.id;

  // #generale è di tutti (la chat di prima); i canali nuovi solo delle persone scelte.
  const { id: off } = await me('POST', '/chat/channels', { name: 'officina', members: [{ user_id: lucaId, can_write: false }] }).then(json);
  const { id: secret } = await me('POST', '/chat/channels', { name: 'riservato' }).then(json);
  await me('POST', '/chat', { text: 'solo per pochi', channel: secret });
  await me('POST', '/chat', { text: 'in officina', channel: 'officina' });
  let d = await luca('GET', '/sync').then(json);
  assert.deepEqual(d.chatChannels.map(c => [c.name, c.can_write]), [['generale', 1], ['officina', 0]]);
  assert.ok(d.chat.every(m => m.channel_id !== secret));
  assert.equal(d.chatChannels.find(c => c.id === off).unread, 1);
  assert.equal((await luca('POST', '/chat', { text: 'posso?', channel: off })).status, 403);
  assert.equal((await luca('GET', `/chat?channel=${secret}`)).status, 404);
  await luca('POST', '/chat/read', { id: d.chat.at(-1).id, channel: off });
  assert.equal((await luca('GET', '/sync').then(json)).chatChannels.find(c => c.id === off).unread, 0);

  // Gestire i canali: admin, o chi ha il permesso "canali".
  assert.equal((await luca('POST', '/chat/channels', { name: 'mio' })).status, 403);
  await me('PATCH', `/admin/users/${lucaId}`, { perms: { canali: 'write' } });
  assert.equal((await luca('POST', '/chat/channels', { name: 'mio' })).status, 200);
  d = await luca('GET', '/sync').then(json);
  assert.equal(d.canManageChannels, true);
  assert.ok(d.chatChannels.some(c => c.name === 'riservato' && !c.member)); // lo vede per gestirlo, senza messaggi
  assert.ok(d.chat.every(m => m.channel_id !== secret));
  await me('PATCH', `/admin/users/${lucaId}`, { perms: null });
});

test('feedback: testo e screenshot, li vede chi gestisce l\'istanza, esportazione', async () => {
  const { token } = config();
  const json = r => (r.status === 204 ? null : r.json());
  const cookie = (await call('POST', '/login', { body: { username: 'luca', password: 'password-di-luca' } })).headers.get('set-cookie').split(';')[0];
  const { id } = await call('POST', '/feedback', { cookie, body: { text: 'il pulsante Manda non risponde', page: '#/mail', version: '0.13.0' } }).then(json);
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const up = await fetch(`${url}/api/feedback/${id}/files?name=schermo.png`, { method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'organizer', 'Content-Type': 'image/png' }, body: png });
  assert.equal(up.status, 200);
  const txt = await fetch(`${url}/api/feedback/${id}/files?name=x.txt`, { method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'organizer', 'Content-Type': 'text/plain' }, body: 'no' });
  assert.equal(txt.status, 400);
  assert.equal((await call('GET', '/feedback', { cookie })).status, 403); // luca non gestisce l'istanza
  assert.equal((await call('GET', '/sync', { token }).then(json)).feedbackOpen, 1);
  const [f] = await call('GET', '/feedback', { token }).then(json);
  assert.deepEqual([f.text, f.username, f.page, f.files.map(x => x.name)], ['il pulsante Manda non risponde', 'luca', '#/mail', ['schermo.png']]);
  const img = await fetch(`${url}/api/feedback/files/${f.files[0].id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);

  const out = path.join(dir, 'fb');
  await promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'server/feedback-export.js'), out],
    { env: { ...process.env, DATA_DIR: path.join(dir, 'data') } });
  const [sub] = fs.readdirSync(out);
  assert.match(fs.readFileSync(path.join(out, sub, 'feedback.md'), 'utf8'), /il pulsante Manda non risponde[\s\S]*1-schermo\.png/);
  await call('PATCH', `/feedback/${id}`, { token, body: { status: 'done' } });
  assert.deepEqual(await call('GET', '/feedback', { token }).then(json), []);
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
  assert.equal(s.chat.at(-1).text, 'guarda [[doc:1]] di #SCH-042');
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

test('permessi per area: dati filtrati, scritture bloccate, dipendenze rispettate', async () => {
  const login = async (username) => (await call('POST', '/login', { body: { username, password: 'password-di-prova' } })).headers.get('set-cookie').split(';')[0];
  const admin = await login('fede');
  const sync = async c => (await call('GET', '/sync', { cookie: c })).json();
  // Una persona nuova nel workspace (invito).
  const { code } = await (await call('POST', '/admin/invites', { cookie: admin })).json();
  const reg = await call('POST', '/register', { body: { code, username: 'stagista', password: 'password-di-prova' } });
  const intern = reg.headers.get('set-cookie').split(';')[0];
  const id = (await sync(intern)).me.id;
  await call('POST', '/entries', { cookie: admin, body: { text: 'm: offerta riservata >cliente@ditta.example' } });

  // Mail e chat nascoste, magazzino in sola lettura, contatti nascosti.
  const r = await (await call('PATCH', `/admin/users/${id}`, { cookie: admin, body: { perms: { mail: 'none', chat: 'none', magazzino: 'read', contatti: 'none' } } })).json();
  // Le dipendenze si completano da sole: per scrivere todo serve leggere progetti e magazzino (già ok).
  assert.equal(r.perms.voci, 'write');
  const d = await sync(intern);
  assert.equal(d.perms.mail, 'none');
  assert.ok(!d.entries.some(e => e.kind === 'mail'));
  assert.deepEqual([d.chat.length, d.contacts.length], [0, 0]);
  assert.ok(d.items.length > 0);

  // Scritture fuori dai permessi: 403. Un #CODICE nuovo in un todo resta testo (niente articolo creato).
  assert.equal((await call('POST', '/entries', { cookie: intern, body: { text: 'm: provo a scrivere' } })).status, 403);
  assert.equal((await call('POST', '/chat', { cookie: intern, body: { text: 'ciao' } })).status, 403);
  const item = d.items[0];
  assert.equal((await call('PATCH', `/items/${item.id}`, { cookie: intern, body: { name: 'x' } })).status, 403);
  assert.equal((await call('POST', '/entries', { cookie: intern, body: { text: 'controllare #NUOVO-999' } })).status, 200);
  assert.ok(!(await sync(admin)).items.some(i => i.code === 'NUOVO-999'));

  // Dare la scrittura alle mail alza a lettura ciò che serve (contatti, documenti, magazzino, progetti).
  const r2 = await (await call('PATCH', `/admin/users/${id}`, { cookie: admin, body: { perms: { ...r.perms, mail: 'write' } } })).json();
  assert.equal(r2.perms.contatti, 'read');
  assert.equal((await call('POST', '/entries', { cookie: intern, body: { text: 'm: ora posso' } })).status, 200);

  // Agli admin non si tolgono permessi; null li riporta tutti.
  assert.equal((await call('PATCH', `/admin/users/${(await sync(admin)).me.id}`, { cookie: admin, body: { perms: { mail: 'none' } } })).status, 400);
  await call('PATCH', `/admin/users/${id}`, { cookie: admin, body: { perms: null } });
  assert.equal((await sync(intern)).perms, null);
});

test('icone dell\'app: SVG, PNG nelle misure giuste, manifest con l\'icona scelta', async () => {
  const get = p => fetch(`${url}${p}`);
  const svg = await get('/icons/app/min-dot.svg');
  assert.deepEqual([svg.status, svg.headers.get('content-type')], [200, 'image/svg+xml']);
  assert.match(await svg.text(), /<circle/);
  for (const p of ['/icons/app/t-nord-180.png', '/icons/app/t-synthwave-512-maskable.png']) {
    const r = await get(p);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.deepEqual([r.status, buf.subarray(1, 4).toString()], [200, 'PNG']);
  }
  assert.equal((await get('/icons/app/t-nord-64.png')).status, 404); // misura non prevista
  assert.equal((await get('/icons/app/non-esiste-192.png')).status, 404);
  const m = await get('/manifest.webmanifest?icon=min-ring').then(r => r.json());
  assert.ok(m.icons.some(i => i.src === 'icons/app/min-ring-512-maskable.png' && i.purpose === 'maskable'));
  assert.equal(m.start_url, './#/agenda');
});

test('esporta e importa i propri dati: magazzino con i file, voci, collegamenti, posta, in un altro workspace', async () => {
  const cookie = (await call('POST', '/login', { body: { username: 'fede', password: 'password-di-prova' } })).headers.get('set-cookie').split(';')[0];
  const json = r => (r.status === 204 ? null : r.json());
  const me = (method, p, body) => call(method, p, { cookie, body }).then(json);
  const { id: item } = await me('POST', '/items', { code: 'EXP-1', name: 'Scheda da esportare', category: 'prova' });
  const up = await fetch(`${url}/api/items/${item}/docs?${new URLSearchParams({ name: 'exp1.txt', kind: 'altro' })}`, {
    method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'organizer', 'Content-Type': 'text/plain' }, body: 'contenuto di prova',
  }).then(r => r.json());
  await me('POST', '/projects', { name: 'Esportazione', tag: 'export-prova' });
  const { id: todo } = await me('POST', '/entries', { text: `controllare il file #EXP-1 @export-prova` });
  const { id: dn } = await me('POST', `/docs/${up.id}/notes`, { text: 'riga 3 da rivedere', page: 1, x: 0.1, y: 0.2 });
  await me('PATCH', `/entries/${todo}`, { notes: `vedi [[doc:${up.id}]] e [[nota:${dn}]]` });
  // La nota citata: la voce compare tra i suoi collegamenti, e lo stato si legge anche senza i dati.
  assert.deepEqual((await me('GET', `/backlinks/nota/${dn}`)).map(x => x.id), [todo]);
  assert.equal((await me('POST', '/refs', { refs: [['nota', dn]] }))[`nota:${dn}`].status, 'ok');
  await me('POST', '/mail/incoming', { message_id: '<exp1@fornitore.it>', from: 'x@fornitore.it', subject: 'Esportazione', body: 'serve EXP-1', inbox: true });

  const zipFile = Buffer.from(await (await fetch(`${url}/api/export`, { headers: { Cookie: cookie, 'X-Requested-With': 'organizer' } })).arrayBuffer());
  assert.equal(zipFile.subarray(0, 2).toString(), 'PK');

  // In un workspace nuovo (vuoto): arriva tutto, con id nuovi e collegamenti aggiornati.
  await me('POST', '/workspaces', { name: 'Altrove' });
  const imp = body => fetch(`${url}/api/import`, { method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'organizer', 'Content-Type': 'application/zip' }, body }).then(r => r.json());
  const r1 = await imp(zipFile);
  assert.ok(r1.articoli >= 1 && r1.documenti >= 1 && r1.voci >= 1 && r1.progetti >= 1 && r1.conversazioni >= 1, JSON.stringify(r1));
  const d = await me('GET', '/sync');
  const it = d.items.find(i => i.code === 'EXP-1');
  const doc = d.docs.find(x => x.item_id === it.id && x.filename === 'exp1.txt');
  assert.equal(await fetch(`${url}/api/docs/${doc.id}/file`, { headers: { Cookie: cookie } }).then(r => r.text()), 'contenuto di prova');
  const e = d.entries.find(x => x.title.startsWith('controllare il file'));
  const note = d.docNotes.find(x => x.doc_id === doc.id && x.text === 'riga 3 da rivedere');
  assert.equal(e.notes, `vedi [[doc:${doc.id}]] e [[nota:${note.id}]]`);
  assert.equal(e.project_id, d.projects.find(p => p.tag === 'export-prova').id);
  assert.ok(d.mailThreads.some(t => t.subject === 'Esportazione'));
  // Una seconda volta: gli articoli e i documenti che ci sono già non si duplicano.
  const r2 = await imp(zipFile);
  assert.deepEqual([r2.articoli, r2.documenti, r2.progetti], [0, 0, 0]);
  assert.ok(r2.articoliUniti >= 1 && r2.progettiUniti >= 1);
  // Un file che non è un'esportazione: rifiutato.
  assert.match((await imp(Buffer.from('ciao'))).error, /esportazione/);
});
