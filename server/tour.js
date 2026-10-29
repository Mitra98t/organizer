// Giro di Organizer: un workspace di prova solo tuo ("Tour di Organizer"), pieno di contenuti finti, su cui
// l'app mostra le sue parti un passo alla volta (public/js/tour.js). Ci si può scrivere; alla fine si elimina
// con un clic. Dentro ci sono anche due persone finte (Anna e Luca) che esistono solo in quel workspace: non
// hanno un account e non ricevono niente.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, tx, withWorkspace, UPLOAD_DIR } from './db.js';
import { acc, atx, createWorkspace, tourOf } from './accounts.js';
import { route, createEntry, updateEntry, addLog, insertId, addShares } from './api.js';
import { dropUser } from './events.js';
import { today } from '../public/js/parse.js';
import { now } from './util.js';
import { newThread } from './maildata.js';

const TOUR_NAME = 'Tour di Organizer';
const FAKE = [
  { id: 990000001, username: 'anna', name: 'Anna Bianchi' },
  { id: 990000002, username: 'luca', name: 'Luca Verdi' },
];

// ---------- file di esempio ----------
// Un PDF di una pagina, scritto a mano (testo semplice in Helvetica): la scheda tecnica di una scheda.
function samplePdf() {
  const lines = ['SCH-042 - Scheda controllo motori', '', 'Revisione: B', 'Alimentazione: 12 V, 2 A max',
    'Microcontrollore: STM32G431, 170 MHz', 'Uscite: 2 ponti H, PWM fino a 40 kHz', 'Programmazione: SWD su CN5 (1 VCC, 2 SWDIO, 3 GND, 4 SWCLK)',
    'Bootloader: jumper J3 chiuso all\'accensione', '', 'Attenzione: con bootloader 2.2 la rev B resta in reset loop.', 'Usare firmware 2.3 o successivo.'];
  const esc = s => s.replace(/[\\()]/g, '\\$&');
  const content = ['BT', '/F1 20 Tf', '60 770 Td', `(${esc(lines[0])}) Tj`, '/F1 12 Tf', '0 -34 Td',
    ...lines.slice(1).flatMap(l => [`(${esc(l)}) Tj`, '0 -20 Td']), 'ET'].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

// Una staffa a L con un perno, come STL binario: per il visore 3D.
function sampleStl() {
  const tris = [];
  const box = (x0, y0, z0, x1, y1, z1) => {
    const v = [];
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) v.push([x, y, z]);
    for (const [a, b, c, d] of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) {
      tris.push([v[a], v[b], v[c]], [v[a], v[c], v[d]]);
    }
  };
  const cyl = (cx, cy, z0, z1, r, n = 32) => {
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const b = (2 * Math.PI * (i + 1)) / n;
      const p = (t, z) => [cx + r * Math.cos(t), cy + r * Math.sin(t), z];
      tris.push([p(a, z0), p(b, z0), p(b, z1)], [p(a, z0), p(b, z1), p(a, z1)], [[cx, cy, z1], p(a, z1), p(b, z1)], [[cx, cy, z0], p(b, z0), p(a, z0)]);
    }
  };
  box(0, 0, 0, 60, 30, 4);
  box(0, 0, 4, 4, 30, 40);
  cyl(35, 15, 4, 14, 4);
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write('staffa motore', 0);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach(([a, b, c], i) => {
    const o = 84 + i * 50;
    const u = b.map((x, k) => x - a[k]);
    const w = c.map((x, k) => x - a[k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...n) || 1;
    [...n.map(x => x / l), ...a, ...b, ...c].forEach((x, k) => buf.writeFloatLE(x, o + k * 4));
  });
  return buf;
}

// ---------- contenuti ----------
export function seed(ws, owner) {
  const me = { id: owner.id, username: owner.username, name: owner.name, is_admin: 1, workspace_id: ws.id, perms: null };
  const [anna, luca] = FAKE.map(f => ({ ...f, is_admin: 0, workspace_id: ws.id, perms: null }));
  const t = today();
  const out = {};
  withWorkspace(ws, () => tx(() => {
    for (const f of FAKE) {
      db.prepare(`INSERT OR IGNORE INTO users (id, username, name, pass, is_admin, member, created_at) VALUES (?, ?, ?, '', 0, 1, ?)`).run(f.id, f.username, f.name, now());
    }
    const add = (text, user = me, extra = {}) => createEntry({ text, today: t, ...extra }, user);
    const entry = id => db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
    const shareAll = (kind, id) => addShares(kind, id, [], true);

    // Progetti: li crea chi fa il giro e li vedono tutti, come in un workspace vero.
    const proj = (tag, name, notes, status = 'open') => {
      const id = insertId(db.prepare('INSERT INTO projects (name, tag, notes, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(name, tag, notes, status, me.id, now(), now()));
      shareAll('project', id);
      return id;
    };
    proj('rover', 'Rover cingolato', 'repo: https://github.com/example/rover-fw\nIP banco: 192.168.10.20');
    proj('serra', 'Serra IoT', 'broker MQTT: 192.168.10.5:1883\nnodi ESP32-S3, 1 gateway');
    proj('banco', 'Banco di burn-in', 'test 48h a 55°C', 'paused');

    // Magazzino e documenti (di tutti), con un PDF e un modello 3D per le anteprime.
    const item = (code, f) => {
      db.prepare(`INSERT OR IGNORE INTO items (code, name, category, firmware, location, qty, notes, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(code, f.name, f.category, f.firmware || '', f.location || '', f.qty ?? null, f.notes || '', me.id, now(), now());
      return db.prepare('SELECT id FROM items WHERE code = ?').get(code).id;
    };
    const sch042 = item('SCH-042', { name: 'Scheda controllo motori', category: 'scheda', firmware: '2.3.1', location: 'Scaffale B2', qty: 4, notes: 'Jumper J3 chiuso per entrare in bootloader.' });
    const sch051 = item('SCH-051', { name: 'Scheda sensori serra', category: 'scheda', firmware: '1.4.0', location: 'Scaffale B3', qty: 12 });
    const psu = item('PSU-12', { name: 'Alimentatore 12V 5A', category: 'alimentatore', location: 'Cassetto 4', qty: 3 });
    const mec = item('MEC-STAFFA', { name: 'Staffa motore stampata', category: 'meccanica', location: 'Cassetto 6', qty: 8 });
    item('CAV-JTAG', { name: 'Cavo JTAG 10 pin', category: 'cavo', location: 'Cassetto 2', qty: 1 });
    const rover = item('PRD-ROVER', { name: 'Rover cingolato completo', category: 'prodotto', qty: 1 });
    for (const child of [sch042, psu, mec]) db.prepare('INSERT OR IGNORE INTO item_links (parent_id, child_id) VALUES (?, ?)').run(rover, child);
    db.prepare('INSERT OR IGNORE INTO project_items (project_id, item_id) SELECT id, ? FROM projects WHERE tag = ?').run(rover, 'rover');
    const file = (itemId, kind, version, filename, mime, buf, label = '') => {
      const stored = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
      return insertId(db.prepare(`INSERT INTO documents (item_id, kind, label, version, filename, mime, size, sha256, stored, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(itemId, kind, label, version, filename, mime, buf.length,
        crypto.createHash('sha256').update(buf).digest('hex'), stored, me.id, now()));
    };
    out.pdf = file(sch042, 'datasheet', 'B', 'sch042_revB_scheda.pdf', 'application/pdf', samplePdf(), 'Scheda tecnica SCH-042');
    out.model = file(mec, 'altro', '3', 'staffa_motore.stl', 'model/stl', sampleStl(), 'Staffa motore');
    file(sch042, 'firmware', '2.3.1', 'sch042_fw_2.3.1_note.txt', 'text/plain', Buffer.from('SCH-042 firmware 2.3.1\n- fix reset loop con bootloader 2.2\n- PWM motori a 20 kHz\n'));
    file(sch051, 'schema', 'C', 'sch051_revC_bom.txt', 'text/plain', Buffer.from('BOM SCH-051 rev C\nU1 SHT40\nU2 ESP32-S3-MINI\n'));
    const note = (docId, text, pos, user = me) => {
      const id = insertId(db.prepare(`INSERT INTO doc_notes (doc_id, page, x, y, z, text, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(docId, pos.page, pos.x, pos.y, pos.z ?? null, text, user.id, now(), now()));
      return id;
    };
    note(out.pdf, 'Questo è il problema del reset loop: segnato in rosso sulla rev B', { page: 1, x: 0.12, y: 0.44 });
    shareAll('docnote', note(out.pdf, 'Verificato sul banco con fw 2.3.1: ok', { page: 1, x: 0.12, y: 0.47 }, anna));
    note(out.model, 'Allargare questo foro a 3.2 mm per le M3', { page: 1, x: 0.58, y: 0.5, z: 1 });

    // Voci: todo, sotto-attività, aggiornamenti, scadenze, condivise e assegnate.
    const flash = add('flash fw 2.3.1 su tutte le #SCH-042 @rover !dopodomani');
    add('compilare con arm-none-eabi-gcc 13.2', me, { parent_id: flash });
    const jtag = add('trovare il programmatore #CAV-JTAG', me, { parent_id: flash });
    updateEntry(entry(jtag), { done: true }, me);
    addLog(flash, me.id, 'il cavo JTAG del banco è rotto, uso quello di Luca');
    out.entry = flash;
    add('verificare ripple alimentazione #PSU-12 @rover !ieri');
    add('stampare 4 staffe nuove #MEC-STAFFA @rover !ven +anna');
    add(`calibrare sensori umidità #SCH-051 @serra !oggi ++${me.username}`, anna);
    const ota = add(`OTA via MQTT sulle #SCH-051 @serra !2s +${me.username}`, luca);
    addLog(ota, luca.id, 'il broker non regge payload > 256 KB, serve dividere l\'immagine');
    add('ordinare 2 #CAV-JTAG !3g +all', anna);
    add('regalo compleanno Luca !fm');

    // Diario.
    add('n: la rev B della #SCH-042 vuole bootloader >= 2.3, con 2.2 resta in reset loop @rover !ieri');
    add('n: il banco di burn-in scalda oltre 60°C con 8 schede, max 6 per volta @banco !15/9 +all');

    // Contatti e mail: una da mandare con allegato dal magazzino, una mandata con la risposta arrivata.
    const contact = (name, email, company, role) => {
      const id = insertId(db.prepare('INSERT INTO contacts (name, email, company, role, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(name, email, company, role, me.id, now(), now()));
      shareAll('contact', id);
    };
    contact('Marta Neri', 'acquisti@pcbfab.example', 'PCB Fab', 'acquisti');
    contact('Paolo Rossi', 'paolo@cliente.example', 'Cliente Spa', 'responsabile tecnico');
    const quote = add('m: preventivo 50 #SCH-051 rev C >acquisti@pcbfab.example @serra !domani');
    db.prepare('UPDATE entries SET notes = ? WHERE id = ?').run('Buongiorno Marta,\nci servirebbe un preventivo per 50 schede SCH-051 rev C (BOM in allegato).\n\nGrazie', quote);
    const bom = db.prepare("SELECT * FROM documents WHERE filename = 'sch051_revC_bom.txt'").get();
    db.prepare('INSERT INTO mail_attachments (entry_id, doc_id, filename, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(quote, bom.id, bom.filename, bom.mime, bom.size, me.id, now());
    const sent = add('m: consegna rover di prova >paolo@cliente.example @rover');
    db.prepare('UPDATE entries SET notes = ?, mail_subject = ? WHERE id = ?').run('Ciao Paolo,\nil rover di prova è pronto: lo spediamo lunedì.', 'Consegna rover di prova', sent);
    updateEntry(entry(sent), { done: true }, me);
    // Messaggi dei thread: quello della consegna (mandata e risposta arrivata, da leggere) e una mail ricevuta
    // che apre un thread suo (da leggere, collegata a un articolo).
    const tSent = entry(sent).thread_id;
    db.prepare('UPDATE mail_threads SET subject = ? WHERE id = ?').run('Consegna rover di prova', tSent);
    db.prepare('UPDATE mail_topics SET title = ? WHERE id = (SELECT topic_id FROM mail_threads WHERE id = ?)').run('Consegna rover di prova', tSent);
    const mid = id => `tour-${ws.id}-${id}@organizer.local`;
    const msg = (thread, direction, id, from, to, subject, body, hoursAgo, read = true, parent = '') => db.prepare(`INSERT INTO mail_messages
      (thread_id, entry_id, direction, message_id, in_reply_to, refs, from_addr, to_addr, subject, body, date, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(thread, direction === 'out' ? sent : null, direction, mid(id), parent ? mid(parent) : '', JSON.stringify(parent ? [mid(parent)] : []), from, to, subject, body,
        new Date(Date.now() - hoursAgo * 3600e3).toISOString(), read ? now() : null, now());
    msg(tSent, 'out', 1, owner.username, 'paolo@cliente.example', 'Consegna rover di prova', 'Ciao Paolo,\nil rover di prova è pronto: lo spediamo lunedì.', 26);
    msg(tSent, 'in', 2, 'Paolo Rossi <paolo@cliente.example>', owner.username, 'Re: Consegna rover di prova', 'Perfetto, grazie! Ci mandate anche la scheda tecnica della SCH-042?', 3, false, 1);
    db.prepare('UPDATE entries SET awaiting_reply = 0 WHERE id = ?').run(sent);
    db.prepare('UPDATE mail_threads SET last_at = ?, archived_at = NULL WHERE id = ?').run(new Date(Date.now() - 3 * 3600e3).toISOString(), tSent);
    const tIn = newThread(me.id, 'Disponibilità alimentatori 12V', new Date(Date.now() - 5 * 3600e3).toISOString());
    msg(tIn, 'in', 3, 'Marta Neri <acquisti@pcbfab.example>', owner.username, 'Disponibilità alimentatori 12V',
      'Buongiorno,\nabbiamo di nuovo a magazzino i PSU-12 (12V 5A): ne servono? Prezzo invariato.\n\nMarta', 5, false);
    db.prepare("INSERT OR IGNORE INTO mail_thread_links (thread_id, kind, target_id, auto) VALUES (?, 'articolo', ?, 1)").run(tIn, psu);
    db.prepare("INSERT OR REPLACE INTO mail_thread_links (thread_id, kind, target_id) SELECT ?, 'progetto', id FROM projects WHERE tag = 'rover'").run(tSent);
    out.thread = db.prepare('SELECT topic_id FROM mail_threads WHERE id = ?').get(tSent).topic_id; // il giro apre il suo topic

    // Chat: #generale di tutti e un canale con solo alcune persone.
    const say = (channel, user, text, minutesAgo) => db.prepare('INSERT INTO chat_messages (channel_id, user_id, text, created_at) VALUES (?, ?, ?, ?)')
      .run(channel, user.id, text, new Date(Date.now() - minutesAgo * 60e3).toISOString());
    say(1, anna, 'Buongiorno! Oggi sono in laboratorio fino alle 17', 180);
    say(1, luca, `Il rover @rover parte lunedì, la #SCH-042 è pronta? +${me.username}`, 95);
    say(1, anna, `La nota sul reset loop è qui: [[doc:${out.pdf}]]`, 60);
    const off = insertId(db.prepare('INSERT INTO chat_channels (name, everyone, created_by, created_at) VALUES (?, 0, ?, ?)').run('officina', me.id, now()));
    for (const [u, w] of [[me, 1], [anna, 1], [luca, 0]]) db.prepare('INSERT INTO chat_members (channel_id, user_id, can_write) VALUES (?, ?, ?)').run(off, u.id, w);
    say(off, anna, 'Ho stampato 2 staffe di prova, il foro è stretto', 40);
    db.prepare('INSERT OR REPLACE INTO chat_reads (channel_id, user_id, read_id) VALUES (1, ?, 0)').run(me.id);
  }));
  // Un paio di notifiche, per vedere la campanella (solo nell'app, niente push).
  for (const [kind, title, body, url] of [
    ['mention', 'Anna Bianchi ti ha assegnato una todo', 'calibrare sensori umidità', '#/agenda'],
    ['mail', 'Mail da Paolo Rossi', 'Re: Consegna rover di prova', `#/t/${out.thread}`],
    ['chat', 'Luca Verdi ti ha citato in #generale', 'Il rover parte lunedì, la SCH-042 è pronta?', '#/chat?c=1'],
  ]) {
    acc.prepare('INSERT INTO notifications (user_id, workspace_id, kind, title, body, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(owner.id, ws.id, kind, title, body, url, now());
  }
  return out;
}

// I documenti da mostrare nel giro (anche se il workspace c'era già).
function tourIds(ws, userId) {
  return withWorkspace(ws, () => ({
    pdf: db.prepare("SELECT id FROM documents WHERE filename = 'sch042_revB_scheda.pdf' AND deleted_at IS NULL").get()?.id ?? null,
    model: db.prepare("SELECT id FROM documents WHERE filename = 'staffa_motore.stl' AND deleted_at IS NULL").get()?.id ?? null,
    entry: db.prepare("SELECT id FROM entries WHERE title LIKE 'flash fw 2.3.1%' AND created_by = ? AND deleted_at IS NULL").get(userId)?.id ?? null,
    thread: db.prepare("SELECT topic_id FROM mail_threads WHERE owner_id = ? AND subject = 'Consegna rover di prova' COLLATE NOCASE").get(userId)?.topic_id ?? null,
  }));
}

// ---------- route ----------
// Inizia (o riprende) il giro: il workspace di prova si crea la prima volta.
route('POST', '/api/tour/start', ({ user }) => {
  let ws = tourOf(user.id);
  if (!ws) {
    const owner = acc.prepare('SELECT id, username, name FROM users WHERE id = ?').get(user.id);
    ws = createWorkspace(TOUR_NAME, user.id);
    acc.prepare('UPDATE workspaces SET tour_of = ? WHERE id = ?').run(user.id, ws.id);
    seed(ws, owner);
  }
  acc.prepare('UPDATE users SET onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?').run(now(), user.id);
  return { workspace_id: ws.id, ids: tourIds(ws, user.id) };
}, { ws: false });

// Fine del giro: si elimina il workspace di prova (le sue notifiche con lui) oppure si tiene.
route('POST', '/api/tour/end', async ({ user, body }) => {
  const b = await body();
  const ws = tourOf(user.id);
  if (ws && b.delete) {
    atx(() => {
      acc.prepare('UPDATE workspaces SET deleted_at = ? WHERE id = ?').run(now(), ws.id);
      acc.prepare('DELETE FROM memberships WHERE workspace_id = ?').run(ws.id);
      acc.prepare('UPDATE sessions SET workspace_id = NULL WHERE workspace_id = ?').run(ws.id);
      acc.prepare('DELETE FROM notifications WHERE workspace_id = ?').run(ws.id);
    });
    dropUser(user.id, ws.id);
  }
}, { ws: false });

// "Più tardi": l'invito non torna (il giro resta in Impostazioni → App e aiuto).
route('POST', '/api/tour/seen', ({ user }) => {
  acc.prepare('UPDATE users SET onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?').run(now(), user.id);
}, { ws: false, quiet: true });
