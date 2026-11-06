// Organizer tour: a demo workspace of your own ("Organizer tour"), full of fake content, on which the app shows its
// parts one step at a time (public/js/tour.js). You can write in it; at the end it is deleted with a click. It also
// has two fake people (Anna and Luca) who exist only in that workspace: they have no account and receive nothing.
// The content is created in the language of whoever starts the tour (tr(), see i18n.js).
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
import { tr } from './i18n.js';

const FAKE = [
  { id: 990000001, username: 'anna', name: 'Anna Bianchi' },
  { id: 990000002, username: 'luca', name: 'Luca Verdi' },
];

// ---------- sample files ----------
// A one-page PDF, written by hand (plain text in Helvetica, so ASCII only): the datasheet of a board.
function samplePdf() {
  const lines = [tr('SCH-042 - Motor control board'), '', tr('Revision: B'), tr('Supply: 12 V, 2 A max'),
    tr('Microcontroller: STM32G431, 170 MHz'), tr('Outputs: 2 H-bridges, PWM up to 40 kHz'), tr('Programming: SWD on CN5 (1 VCC, 2 SWDIO, 3 GND, 4 SWCLK)'),
    tr('Bootloader: jumper J3 closed at power-up'), '', tr('Warning: with bootloader 2.2 rev B stays in a reset loop.'), tr('Use firmware 2.3 or later.')]
    .map(l => l.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
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

// An L-shaped bracket with a pin, as binary STL: for the 3D viewer.
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
  buf.write('motor bracket', 0);
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

// ---------- content ----------
export function seed(ws, owner) {
  const me = { id: owner.id, username: owner.username, name: owner.name, is_admin: 1, workspace_id: ws.id, perms: null };
  const [anna, luca] = FAKE.map(f => ({ ...f, is_admin: 0, workspace_id: ws.id, perms: null }));
  const t = today();
  const out = {};
  const [greenhouse, bench] = [tr('greenhouse'), tr('bench')]; // project tags
  withWorkspace(ws, () => tx(() => {
    for (const f of FAKE) {
      db.prepare(`INSERT OR IGNORE INTO users (id, username, name, pass, is_admin, member, created_at) VALUES (?, ?, ?, '', 0, 1, ?)`).run(f.id, f.username, f.name, now());
    }
    const add = (text, user = me, extra = {}) => createEntry({ text, today: t, ...extra }, user);
    const entry = id => db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
    const shareAll = (kind, id) => addShares(kind, id, [], true);

    // Projects: created by whoever takes the tour and seen by everyone, as in a real workspace.
    const proj = (tag, name, notes, status = 'open') => {
      const id = insertId(db.prepare('INSERT INTO projects (name, tag, notes, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(name, tag, notes, status, me.id, now(), now()));
      shareAll('project', id);
      return id;
    };
    proj('rover', tr('Tracked rover'), tr('repo: https://github.com/example/rover-fw\nbench IP: 192.168.10.20'));
    proj(greenhouse, tr('IoT greenhouse'), tr('MQTT broker: 192.168.10.5:1883\nESP32-S3 nodes, 1 gateway'));
    proj(bench, tr('Burn-in bench'), tr('48h test at 55°C'), 'paused');

    // Inventory and documents (everyone's), with a PDF and a 3D model for the previews.
    const item = (code, f) => {
      db.prepare(`INSERT OR IGNORE INTO items (code, name, category, firmware, location, qty, notes, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(code, f.name, f.category, f.firmware || '', f.location || '', f.qty ?? null, f.notes || '', me.id, now(), now());
      return db.prepare('SELECT id FROM items WHERE code = ?').get(code).id;
    };
    const sch042 = item('SCH-042', { name: tr('Motor control board'), category: tr('board'), firmware: '2.3.1', location: tr('Shelf B2'), qty: 4, notes: tr('Jumper J3 closed to enter the bootloader.') });
    const sch051 = item('SCH-051', { name: tr('Greenhouse sensor board'), category: tr('board'), firmware: '1.4.0', location: tr('Shelf B3'), qty: 12 });
    const psu = item('PSU-12', { name: tr('12V 5A power supply'), category: tr('power supply'), location: tr('Drawer 4'), qty: 3 });
    const mec = item('MEC-BRACKET', { name: tr('Printed motor bracket'), category: tr('mechanics'), location: tr('Drawer 6'), qty: 8 });
    item('CAB-JTAG', { name: tr('10-pin JTAG cable'), category: tr('cable'), location: tr('Drawer 2'), qty: 1 });
    const rover = item('PRD-ROVER', { name: tr('Complete tracked rover'), category: tr('product'), qty: 1 });
    for (const child of [sch042, psu, mec]) db.prepare('INSERT OR IGNORE INTO item_links (parent_id, child_id) VALUES (?, ?)').run(rover, child);
    db.prepare('INSERT OR IGNORE INTO project_items (project_id, item_id) SELECT id, ? FROM projects WHERE tag = ?').run(rover, 'rover');
    const file = (itemId, kind, version, filename, mime, buf, label = '') => {
      const stored = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
      return insertId(db.prepare(`INSERT INTO documents (item_id, kind, label, version, filename, mime, size, sha256, stored, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(itemId, kind, label, version, filename, mime, buf.length,
        crypto.createHash('sha256').update(buf).digest('hex'), stored, me.id, now()));
    };
    out.pdf = file(sch042, 'datasheet', 'B', 'sch042_revB_datasheet.pdf', 'application/pdf', samplePdf(), tr('SCH-042 datasheet'));
    out.model = file(mec, 'altro', '3', 'motor_bracket.stl', 'model/stl', sampleStl(), tr('Motor bracket'));
    file(sch042, 'firmware', '2.3.1', 'sch042_fw_2.3.1_notes.txt', 'text/plain', Buffer.from(tr('SCH-042 firmware 2.3.1\n- fix reset loop with bootloader 2.2\n- motor PWM at 20 kHz\n')));
    file(sch051, 'schema', 'C', 'sch051_revC_bom.txt', 'text/plain', Buffer.from('BOM SCH-051 rev C\nU1 SHT40\nU2 ESP32-S3-MINI\n'));
    const note = (docId, text, pos, user = me) => {
      const id = insertId(db.prepare(`INSERT INTO doc_notes (doc_id, page, x, y, z, text, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(docId, pos.page, pos.x, pos.y, pos.z ?? null, text, user.id, now(), now()));
      return id;
    };
    note(out.pdf, tr('This is the reset loop problem: marked in red on rev B'), { page: 1, x: 0.12, y: 0.44 });
    shareAll('docnote', note(out.pdf, tr('Checked on the bench with fw 2.3.1: ok'), { page: 1, x: 0.12, y: 0.47 }, anna));
    note(out.model, tr('Widen this hole to 3.2 mm for M3 screws'), { page: 1, x: 0.58, y: 0.5, z: 1 });

    // Entries: todos, subtasks, updates, due dates, shared and assigned.
    const flash = add(tr('flash fw 2.3.1 on all the #SCH-042 @rover !2d'));
    add(tr('build with arm-none-eabi-gcc 13.2'), me, { parent_id: flash });
    const jtag = add(tr('find the #CAB-JTAG programmer'), me, { parent_id: flash });
    updateEntry(entry(jtag), { done: true }, me);
    addLog(flash, me.id, tr('the bench JTAG cable is broken, I am using Luca\'s'));
    out.entry = flash;
    add(tr('check the #PSU-12 supply ripple @rover !yesterday'));
    add(tr('print 4 new #MEC-BRACKET @rover !fri +anna'));
    add(tr('calibrate humidity sensors #SCH-051 @{tag} !today ++{me}', { tag: greenhouse, me: me.username }), anna);
    const ota = add(tr('OTA over MQTT on the #SCH-051 @{tag} !2w +{me}', { tag: greenhouse, me: me.username }), luca);
    addLog(ota, luca.id, tr('the broker cannot handle payloads > 256 KB, the image must be split'));
    add(tr('order 2 #CAB-JTAG !3d +all'), anna);
    add(tr('birthday present for Luca !eom'));

    // Journal.
    add(tr('n: rev B of #SCH-042 needs bootloader >= 2.3, with 2.2 it stays in a reset loop @rover !yesterday'));
    add(tr('n: the burn-in bench goes above 60°C with 8 boards, max 6 at a time @{tag} !15/9 +all', { tag: bench }));

    // Contacts and mail: one to send with an attachment from the inventory, one sent with its reply received.
    const contact = (name, email, company, role) => {
      const id = insertId(db.prepare('INSERT INTO contacts (name, email, company, role, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(name, email, company, role, me.id, now(), now()));
      shareAll('contact', id);
    };
    contact('Marta Neri', 'purchasing@pcbfab.example', 'PCB Fab', tr('purchasing'));
    contact('Paolo Rossi', 'paolo@customer.example', tr('Customer Ltd'), tr('technical lead'));
    const quote = add(tr('m: quote for 50 #SCH-051 rev C >purchasing@pcbfab.example @{tag} !tomorrow', { tag: greenhouse }));
    db.prepare('UPDATE entries SET notes = ? WHERE id = ?').run(tr('Hello Marta,\nwe would need a quote for 50 SCH-051 rev C boards (BOM attached).\n\nThanks'), quote);
    const bom = db.prepare("SELECT * FROM documents WHERE filename = 'sch051_revC_bom.txt'").get();
    db.prepare('INSERT INTO mail_attachments (entry_id, doc_id, filename, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(quote, bom.id, bom.filename, bom.mime, bom.size, me.id, now());
    const subject = tr('Demo rover delivery');
    const sentText = tr('Hi Paolo,\nthe demo rover is ready: we ship it on Monday.');
    const sent = add(tr('m: demo rover delivery >paolo@customer.example @rover'));
    db.prepare('UPDATE entries SET notes = ?, mail_subject = ? WHERE id = ?').run(sentText, subject, sent);
    updateEntry(entry(sent), { done: true }, me);
    // Thread messages: the delivery one (sent and reply received, unread) and a received mail opening a thread of
    // its own (unread, linked to an item).
    const tSent = entry(sent).thread_id;
    db.prepare('UPDATE mail_threads SET subject = ? WHERE id = ?').run(subject, tSent);
    db.prepare('UPDATE mail_topics SET title = ? WHERE id = (SELECT topic_id FROM mail_threads WHERE id = ?)').run(subject, tSent);
    const mid = id => `tour-${ws.id}-${id}@organizer.local`;
    const msg = (thread, direction, id, from, to, subj, body, hoursAgo, read = true, parent = '') => db.prepare(`INSERT INTO mail_messages
      (thread_id, entry_id, direction, message_id, in_reply_to, refs, from_addr, to_addr, subject, body, date, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(thread, direction === 'out' ? sent : null, direction, mid(id), parent ? mid(parent) : '', JSON.stringify(parent ? [mid(parent)] : []), from, to, subj, body,
        new Date(Date.now() - hoursAgo * 3600e3).toISOString(), read ? now() : null, now());
    msg(tSent, 'out', 1, owner.username, 'paolo@customer.example', subject, sentText, 26);
    msg(tSent, 'in', 2, 'Paolo Rossi <paolo@customer.example>', owner.username, `Re: ${subject}`, tr('Perfect, thanks! Could you also send us the SCH-042 datasheet?'), 3, false, 1);
    db.prepare('UPDATE entries SET awaiting_reply = 0 WHERE id = ?').run(sent);
    db.prepare('UPDATE mail_threads SET last_at = ?, archived_at = NULL WHERE id = ?').run(new Date(Date.now() - 3 * 3600e3).toISOString(), tSent);
    const psuSubject = tr('12V power supplies available');
    const tIn = newThread(me.id, psuSubject, new Date(Date.now() - 5 * 3600e3).toISOString());
    msg(tIn, 'in', 3, 'Marta Neri <purchasing@pcbfab.example>', owner.username, psuSubject,
      tr('Hello,\nwe have the PSU-12 (12V 5A) in stock again: do you need any? Same price.\n\nMarta'), 5, false);
    db.prepare("INSERT OR IGNORE INTO mail_thread_links (thread_id, kind, target_id, auto) VALUES (?, 'articolo', ?, 1)").run(tIn, psu);
    db.prepare("INSERT OR REPLACE INTO mail_thread_links (thread_id, kind, target_id) SELECT ?, 'progetto', id FROM projects WHERE tag = 'rover'").run(tSent);
    out.thread = db.prepare('SELECT topic_id FROM mail_threads WHERE id = ?').get(tSent).topic_id; // the tour opens its topic

    // Chat: everyone's #general and a channel with only some people.
    db.prepare('UPDATE chat_channels SET name = ? WHERE id = 1').run(tr('general'));
    const say = (channel, user, text, minutesAgo) => db.prepare('INSERT INTO chat_messages (channel_id, user_id, text, created_at) VALUES (?, ?, ?, ?)')
      .run(channel, user.id, text, new Date(Date.now() - minutesAgo * 60e3).toISOString());
    say(1, anna, tr('Good morning! I am in the lab until 5pm today'), 180);
    say(1, luca, tr('The @rover leaves on Monday, is the #SCH-042 ready? +{me}', { me: me.username }), 95);
    say(1, anna, tr('The note about the reset loop is here: [[doc:{id}]]', { id: out.pdf }), 60);
    const off = insertId(db.prepare('INSERT INTO chat_channels (name, everyone, created_by, created_at) VALUES (?, 0, ?, ?)').run(tr('workshop'), me.id, now()));
    for (const [u, w] of [[me, 1], [anna, 1], [luca, 0]]) db.prepare('INSERT INTO chat_members (channel_id, user_id, can_write) VALUES (?, ?, ?)').run(off, u.id, w);
    say(off, anna, tr('I printed 2 test brackets, the hole is too tight'), 40);
    db.prepare('INSERT OR REPLACE INTO chat_reads (channel_id, user_id, read_id) VALUES (1, ?, 0)').run(me.id);
  }));
  // A couple of notifications, to see the bell (only in the app, no push).
  for (const [kind, title, body, url] of [
    ['mention', tr('{actor} assigned you a todo', { actor: 'Anna Bianchi' }), tr('calibrate humidity sensors'), '#/agenda'],
    ['mail', tr('Mail from {name}', { name: 'Paolo Rossi' }), `Re: ${tr('Demo rover delivery')}`, `#/t/${out.thread}`],
    ['chat', tr('{who} mentioned you in #{channel}', { who: 'Luca Verdi', channel: tr('general') }), tr('The rover leaves on Monday, is the SCH-042 ready?'), '#/chat?c=1'],
  ]) {
    acc.prepare('INSERT INTO notifications (user_id, workspace_id, kind, title, body, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(owner.id, ws.id, kind, title, body, url, now());
  }
  return out;
}

// The documents to show in the tour (also if the workspace was already there). Older tours have the Italian file
// names; the delivery thread is the one of the tour's first message.
function tourIds(ws, userId) {
  return withWorkspace(ws, () => ({
    pdf: db.prepare("SELECT id FROM documents WHERE filename IN ('sch042_revB_datasheet.pdf', 'sch042_revB_scheda.pdf') AND deleted_at IS NULL").get()?.id ?? null,
    model: db.prepare("SELECT id FROM documents WHERE filename IN ('motor_bracket.stl', 'staffa_motore.stl') AND deleted_at IS NULL").get()?.id ?? null,
    entry: db.prepare("SELECT id FROM entries WHERE title LIKE 'flash fw 2.3.1%' AND created_by = ? AND deleted_at IS NULL").get(userId)?.id ?? null,
    thread: db.prepare(`SELECT t.topic_id FROM mail_threads t JOIN mail_messages m ON m.thread_id = t.id
      WHERE t.owner_id = ? AND m.message_id = ?`).get(userId, `tour-${ws.id}-1@organizer.local`)?.topic_id ?? null,
  }));
}

// ---------- routes ----------
// Starts (or resumes) the tour: the demo workspace is created the first time.
route('POST', '/api/tour/start', ({ user }) => {
  let ws = tourOf(user.id);
  if (!ws) {
    const owner = acc.prepare('SELECT id, username, name FROM users WHERE id = ?').get(user.id);
    ws = createWorkspace(tr('Organizer tour'), user.id);
    acc.prepare('UPDATE workspaces SET tour_of = ? WHERE id = ?').run(user.id, ws.id);
    seed(ws, owner);
  }
  acc.prepare('UPDATE users SET onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?').run(now(), user.id);
  return { workspace_id: ws.id, ids: tourIds(ws, user.id) };
}, { ws: false });

// End of the tour: the demo workspace is deleted (its notifications with it) or kept.
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

// "Later": the invitation does not come back (the tour stays in Settings → App and help).
route('POST', '/api/tour/seen', ({ user }) => {
  acc.prepare('UPDATE users SET onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?').run(now(), user.id);
}, { ws: false, quiet: true });
