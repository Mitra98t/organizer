// Loads demo data (projects, todos, mails, journal, inventory with documents).
//   node server/demo.js                refuses if the workspace already has entries or items
//   node server/demo.js --force        adds them anyway
//   node server/demo.js --workspace 2  into a given workspace (default: the first one; if none, "Demo")
// Accounts created if missing: demo (workspace admin) and marco, password "demo1234".
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, tx, UPLOAD_DIR, withWorkspace } from './db.js';
import { hashPassword } from './auth.js';
import { acc, createWorkspace, addMember, workspaceById, roleIn, syncMirror } from './accounts.js';
import { createEntry, updateEntry, addLog, syncEntryItems } from './api.js';
import { today, addDays } from '../public/js/parse.js';
import { now } from './util.js';

const DEMO_PASSWORD = 'demo1234';
const wsArg = process.argv.includes('--workspace') ? process.argv[process.argv.indexOf('--workspace') + 1] : null;

async function ensureAccount(username, name) {
  const found = acc.prepare('SELECT id, username, name FROM users WHERE username = ?').get(username);
  if (found) return found;
  acc.prepare('INSERT INTO users (username, name, pass, created_at) VALUES (?, ?, ?, ?)')
    .run(username, name, await hashPassword(DEMO_PASSWORD), now());
  return acc.prepare('SELECT id, username, name FROM users WHERE username = ?').get(username);
}

const demo = await ensureAccount('demo', 'Demo');
const marco = await ensureAccount('marco', 'Marco');
const firstId = acc.prepare('SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY id LIMIT 1').get()?.id;
const ws = workspaceById(wsArg || firstId) || createWorkspace('Demo', demo.id);
addMember(ws, demo.id, 'admin');
if (roleIn(ws.id, demo.id) !== 'admin') {
  acc.prepare("UPDATE memberships SET role = 'admin' WHERE workspace_id = ? AND user_id = ?").run(ws.id, demo.id);
  syncMirror(ws, demo.id);
}
addMember(ws, marco.id, 'member');

withWorkspace(ws, () => {
const counts = db.prepare('SELECT (SELECT COUNT(*) FROM entries) AS e, (SELECT COUNT(*) FROM items) AS i').get();
if ((counts.e || counts.i) && !process.argv.includes('--force')) {
  console.error(`Workspace "${ws.name}" already has ${counts.e} entries and ${counts.i} items. Run "make reset" first, or use --force.`);
  process.exit(1);
}

const t = today();

tx(() => {
  const add = (text, user = demo, extra = {}) => createEntry({ text, today: t, ...extra }, user);
  const entry = id => db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  const log = (id, text, user = demo) => { addLog(id, user.id, text); syncEntryItems(id, user); };

  // --- entries: projects and items are born from the tokens, as from the quick bar ---
  const flash = add('flash fw 2.3.1 on all the #SCH-042 @rover !2d');
  add('build with arm-none-eabi-gcc 13.2', demo, { parent_id: flash });
  const jtag = add('find the #CAB-JTAG programmer', demo, { parent_id: flash });
  updateEntry(entry(jtag), { done: true }, demo);
  log(flash, 'the bench JTAG cable is broken, I am using Marco\'s');
  updateEntry(entry(flash), { due: addDays(t, 5), today: t }, demo); // postponed: leaves a trace in the history

  add('check the #PSU-12 supply ripple @rover !yesterday');
  add('update the README of the firmware repo https://github.com/example/rover-fw @rover');
  const solder = add('solder the motor connectors #SCH-042 @rover');
  updateEntry(entry(solder), { done: true }, demo);

  add('calibrate humidity sensors #SCH-051 @greenhouse-iot !today +marco', marco);
  // Projects are private to whoever creates them: Marco's is shared with everyone, so demo works on it too.
  db.prepare("UPDATE projects SET shared_all = 1 WHERE tag = 'greenhouse-iot'").run();
  const ota = add('OTA over MQTT on #ESP32-S3-DEVKIT @greenhouse-iot !2w');
  log(ota, 'the broker cannot handle payloads > 256 KB, the image must be split', marco);
  add('order 2 #CAB-JTAG !3d', marco);

  add('m: quote for 50 #SCH-051 rev C >purchasing@pcbfab.example @greenhouse-iot !tomorrow');
  add('m: burn-in test report >luca@customer.example @test-bench !mon');
  const sent = add('m: confirm the connector order >orders@supplier.example @rover');
  updateEntry(entry(sent), { done: true }, demo);

  add('n: rev B of #SCH-042 needs bootloader >= 2.3, with 2.2 it stays in a reset loop @rover !yesterday');
  add('n: greenhouse gateway: default password changed, it is in the vault @greenhouse-iot !3/10', marco);
  add('n: the burn-in bench goes above 60°C with 8 boards, max 6 at a time @test-bench !15/9');

  add('birthday present for Marco !eom', demo, { private: true });

  // --- projects: readable names, notes, statuses ---
  const proj = (tag, name, notes, status = 'open') =>
    db.prepare('UPDATE projects SET name = ?, notes = ?, status = ? WHERE tag = ?').run(name, notes, status, tag);
  proj('rover', 'Tracked rover', 'repo: https://github.com/example/rover-fw\nbench IP: 192.168.10.20\ntoolchain: arm-none-eabi-gcc 13.2');
  proj('greenhouse-iot', 'IoT greenhouse', 'MQTT broker: 192.168.10.5:1883\nESP32-S3 nodes, 1 gateway');
  proj('test-bench', 'Burn-in bench', '48h test at 55°C', 'paused');

  // --- inventory: details, composition, documents ---
  const item = (code, f) => {
    db.prepare('INSERT OR IGNORE INTO items (code, created_by, created_at, updated_at) VALUES (?, ?, ?, ?)').run(code, demo.id, now(), now());
    db.prepare(`UPDATE items SET name = ?, category = ?, firmware = ?, location = ?, qty = ?, notes = ? WHERE code = ?`)
      .run(f.name, f.category, f.firmware || '', f.location || '', f.qty ?? null, f.notes || '', code);
    return db.prepare('SELECT id FROM items WHERE code = ?').get(code).id;
  };
  const sch042 = item('SCH-042', { name: 'Motor control board', category: 'board', firmware: '2.3.1', location: 'Shelf B2', qty: 4, notes: 'Jumper J3 closed to enter the bootloader.\nSWD on CN5: 1=VCC 2=SWDIO 3=GND 4=SWCLK' });
  const sch051 = item('SCH-051', { name: 'Greenhouse sensor board', category: 'board', firmware: '1.4.0', location: 'Shelf B3', qty: 12 });
  const psu = item('PSU-12', { name: '12V 5A power supply', category: 'power supply', location: 'Drawer 4', qty: 3 });
  item('ESP32-S3-DEVKIT', { name: 'ESP32-S3 N16R8 devkit', category: 'module', firmware: 'ESP-IDF 5.3', location: 'Drawer 1', qty: 6 });
  item('CAB-JTAG', { name: '10-pin 1.27mm JTAG cable', category: 'cable', location: 'Drawer 2', qty: 1 });
  const rover = item('PRD-ROVER-1', { name: 'Complete tracked rover', category: 'product', qty: 1, notes: 'Serial number R1-0007' });
  for (const child of [sch042, sch051, psu]) db.prepare('INSERT OR IGNORE INTO item_links (parent_id, child_id) VALUES (?, ?)').run(rover, child);

  const file = (itemId, kind, version, filename, mime, content) => {
    const stored = crypto.randomBytes(16).toString('hex');
    const buf = Buffer.from(content);
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
    db.prepare(`INSERT INTO documents (item_id, kind, version, filename, mime, size, sha256, stored, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(itemId, kind, version, filename, mime, buf.length, crypto.createHash('sha256').update(buf).digest('hex'), stored, demo.id, now());
  };
  file(sch042, 'firmware', '2.3.1', 'sch042_fw_2.3.1_notes.txt', 'text/plain',
    'SCH-042 firmware 2.3.1\n- fix reset loop with bootloader 2.2\n- motor PWM at 20 kHz\n');
  file(sch042, 'firmware', '2.2.0', 'sch042_fw_2.2.0_notes.txt', 'text/plain', 'SCH-042 firmware 2.2.0\n- first stable release\n');
  file(sch051, 'schema', 'C', 'sch051_revC_bom.txt', 'text/plain', 'BOM SCH-051 rev C\nU1 SHT40\nU2 ESP32-S3-MINI\n');
  db.prepare(`INSERT INTO documents (item_id, kind, label, url, created_by, created_at) VALUES (?, 'datasheet', ?, ?, ?, ?)`)
    .run(db.prepare('SELECT id FROM items WHERE code = ?').get('ESP32-S3-DEVKIT').id, 'Datasheet ESP32-S3',
      'https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf', demo.id, now());
});

const c = db.prepare('SELECT (SELECT COUNT(*) FROM entries) AS e, (SELECT COUNT(*) FROM items) AS i, (SELECT COUNT(*) FROM projects) AS p').get();
console.log(`Demo data loaded into "${ws.name}": ${c.e} entries, ${c.p} projects, ${c.i} items.`);
console.log(`Login: demo / ${DEMO_PASSWORD}  (or marco / ${DEMO_PASSWORD})`);
});
