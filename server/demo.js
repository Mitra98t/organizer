// Carica dati dimostrativi (progetti, todo, mail, diario, magazzino con documenti).
//   node server/demo.js                rifiuta se il workspace contiene già voci o articoli
//   node server/demo.js --force        aggiunge comunque
//   node server/demo.js --workspace 2  in un workspace preciso (predefinito: il primo; se non c'è, "Demo")
// Account creati se mancanti: demo (admin del workspace) e marco, password "demo1234".
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
  console.error(`Il workspace "${ws.name}" contiene già ${counts.e} voci e ${counts.i} articoli. Usa "make reset" prima, oppure --force.`);
  process.exit(1);
}

const t = today();

tx(() => {
  const add = (text, user = demo, extra = {}) => createEntry({ text, today: t, ...extra }, user);
  const entry = id => db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  const log = (id, text, user = demo) => { addLog(id, user.id, text); syncEntryItems(id, user); };

  // --- voci: i progetti e gli articoli nascono dai token, come dalla barra rapida ---
  const flash = add('flash fw 2.3.1 su tutte le #SCH-042 @rover !dopodomani');
  add('compilare con arm-none-eabi-gcc 13.2', demo, { parent_id: flash });
  const jtag = add('trovare il programmatore #CAV-JTAG', demo, { parent_id: flash });
  updateEntry(entry(jtag), { done: true }, demo);
  log(flash, 'il cavo JTAG del banco è rotto, uso quello di Marco');
  updateEntry(entry(flash), { due: addDays(t, 5), today: t }, demo); // slittamento: lascia traccia nello storico

  add('verificare ripple alimentazione #PSU-12 @rover !ieri');
  add('aggiornare README del repo firmware https://github.com/example/rover-fw @rover');
  const saldature = add('saldare connettori motori #SCH-042 @rover');
  updateEntry(entry(saldature), { done: true }, demo);

  add('calibrare sensori umidità #SCH-051 @serra-iot !oggi +marco', marco);
  const ota = add('OTA via MQTT su #ESP32-S3-DEVKIT @serra-iot !2s');
  log(ota, 'il broker non regge payload > 256 KB, serve dividere l\'immagine', marco);
  add('ordinare 2 #CAV-JTAG !3g', marco);

  add('m: preventivo 50 #SCH-051 rev C >acquisti@pcbfab.example @serra-iot !domani');
  add('m: report test di burn-in >luca@cliente.example @banco-test !lun');
  const sent = add('m: conferma ordine connettori >ordini@fornitore.example @rover');
  updateEntry(entry(sent), { done: true }, demo);

  add('n: la rev B della #SCH-042 vuole bootloader >= 2.3, con 2.2 resta in reset loop @rover !ieri');
  add('n: gateway serra: cambiata la password di default, è nel vault @serra-iot !3/10', marco);
  add('n: il banco di burn-in scalda oltre 60°C con 8 schede, max 6 per volta @banco-test !15/9');

  add('regalo compleanno Marco !fm', demo, { private: true });

  // --- progetti: nomi leggibili, appunti, stati ---
  const proj = (tag, name, notes, status = 'open') =>
    db.prepare('UPDATE projects SET name = ?, notes = ?, status = ? WHERE tag = ?').run(name, notes, status, tag);
  proj('rover', 'Rover cingolato', 'repo: https://github.com/example/rover-fw\nIP banco: 192.168.10.20\ntoolchain: arm-none-eabi-gcc 13.2');
  proj('serra-iot', 'Serra IoT', 'broker MQTT: 192.168.10.5:1883\nnodi ESP32-S3, 1 gateway');
  proj('banco-test', 'Banco di burn-in', 'test 48h a 55°C', 'paused');

  // --- magazzino: dettagli, composizione, documenti ---
  const item = (code, f) => {
    db.prepare('INSERT OR IGNORE INTO items (code, created_by, created_at, updated_at) VALUES (?, ?, ?, ?)').run(code, demo.id, now(), now());
    db.prepare(`UPDATE items SET name = ?, category = ?, firmware = ?, location = ?, qty = ?, notes = ? WHERE code = ?`)
      .run(f.name, f.category, f.firmware || '', f.location || '', f.qty ?? null, f.notes || '', code);
    return db.prepare('SELECT id FROM items WHERE code = ?').get(code).id;
  };
  const sch042 = item('SCH-042', { name: 'Scheda controllo motori', category: 'scheda', firmware: '2.3.1', location: 'Scaffale B2', qty: 4, notes: 'Jumper J3 chiuso per entrare in bootloader.\nSWD su CN5: 1=VCC 2=SWDIO 3=GND 4=SWCLK' });
  const sch051 = item('SCH-051', { name: 'Scheda sensori serra', category: 'scheda', firmware: '1.4.0', location: 'Scaffale B3', qty: 12 });
  const psu = item('PSU-12', { name: 'Alimentatore 12V 5A', category: 'alimentatore', location: 'Cassetto 4', qty: 3 });
  item('ESP32-S3-DEVKIT', { name: 'Devkit ESP32-S3 N16R8', category: 'modulo', firmware: 'ESP-IDF 5.3', location: 'Cassetto 1', qty: 6 });
  item('CAV-JTAG', { name: 'Cavo JTAG 10 pin 1.27mm', category: 'cavo', location: 'Cassetto 2', qty: 1 });
  const rover = item('PRD-ROVER-1', { name: 'Rover cingolato completo', category: 'prodotto', qty: 1, notes: 'Numero di serie R1-0007' });
  for (const child of [sch042, sch051, psu]) db.prepare('INSERT OR IGNORE INTO item_links (parent_id, child_id) VALUES (?, ?)').run(rover, child);

  const file = (itemId, kind, version, filename, mime, content) => {
    const stored = crypto.randomBytes(16).toString('hex');
    const buf = Buffer.from(content);
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
    db.prepare(`INSERT INTO documents (item_id, kind, version, filename, mime, size, sha256, stored, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(itemId, kind, version, filename, mime, buf.length, crypto.createHash('sha256').update(buf).digest('hex'), stored, demo.id, now());
  };
  file(sch042, 'firmware', '2.3.1', 'sch042_fw_2.3.1_note.txt', 'text/plain',
    'SCH-042 firmware 2.3.1\n- fix reset loop con bootloader 2.2\n- PWM motori a 20 kHz\n');
  file(sch042, 'firmware', '2.2.0', 'sch042_fw_2.2.0_note.txt', 'text/plain', 'SCH-042 firmware 2.2.0\n- prima release stabile\n');
  file(sch051, 'schema', 'C', 'sch051_revC_bom.txt', 'text/plain', 'BOM SCH-051 rev C\nU1 SHT40\nU2 ESP32-S3-MINI\n');
  db.prepare(`INSERT INTO documents (item_id, kind, label, url, created_by, created_at) VALUES (?, 'datasheet', ?, ?, ?, ?)`)
    .run(db.prepare('SELECT id FROM items WHERE code = ?').get('ESP32-S3-DEVKIT').id, 'Datasheet ESP32-S3',
      'https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf', demo.id, now());
});

const c = db.prepare('SELECT (SELECT COUNT(*) FROM entries) AS e, (SELECT COUNT(*) FROM items) AS i, (SELECT COUNT(*) FROM projects) AS p').get();
console.log(`Dati demo caricati in "${ws.name}": ${c.e} voci, ${c.p} progetti, ${c.i} articoli.`);
console.log(`Accesso: demo / ${DEMO_PASSWORD}  (oppure marco / ${DEMO_PASSWORD})`);
});
