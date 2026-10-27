import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Dati in una cartella temporanea: va impostata prima di importare i moduli del server.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-test-'));
process.env.DATA_DIR = dir;
const { db, withWorkspace, closeAll } = await import('../server/db.js');
const accounts = await import('../server/accounts.js');
const { acc, createWorkspace, addMember, removeMember, roleIn, workspacesOf } = accounts;

const newAccount = name => Number(acc.prepare("INSERT INTO users (username, name, pass, created_at) VALUES (?, ?, 'x', '2026-01-01')")
  .run(name, name).lastInsertRowid);

test('i dati di due workspace restano separati', () => {
  const anna = newAccount('anna');
  const a = createWorkspace('Lab', anna);
  const b = createWorkspace('Casa', anna);
  assert.equal(a.file, 'organizer.db');
  assert.equal(b.file, `ws-${b.id}.db`);
  const add = (ws, title) => withWorkspace(ws, () => db.prepare(
    "INSERT INTO entries (kind, title, created_by, created_at, updated_at) VALUES ('todo', ?, ?, '2026-01-01', '2026-01-01')").run(title, anna));
  add(a, 'solo in Lab');
  add(b, 'solo in Casa');
  const titles = ws => withWorkspace(ws, () => db.prepare('SELECT title FROM entries').all().map(r => r.title));
  assert.deepEqual(titles(a), ['solo in Lab']);
  assert.deepEqual(titles(b), ['solo in Casa']);
  assert.deepEqual(workspacesOf(anna).map(w => [w.name, w.role]), [['Casa', 'admin'], ['Lab', 'admin']]);
});

test('ruoli diversi per workspace e almeno un admin', () => {
  const owner = newAccount('owner');
  const guest = newAccount('guest');
  const ws = createWorkspace('Officina', owner);
  addMember(ws, guest, 'member');
  assert.equal(roleIn(ws.id, guest), 'member');
  assert.throws(() => removeMember(ws, owner), /unico admin/);
  // La copia dei membri nel workspace serve a nomi e chiavi esterne; chi esce resta come ex membro.
  removeMember(ws, guest);
  const mirror = withWorkspace(ws, () => db.prepare('SELECT member FROM users WHERE id = ?').get(guest));
  assert.equal(mirror.member, 0);
  assert.equal(roleIn(ws.id, guest), null);
});

test.after(() => {
  closeAll();
  acc.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
