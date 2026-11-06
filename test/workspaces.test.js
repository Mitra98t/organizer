import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Data in a temporary folder: it must be set before importing the server's modules.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-test-'));
process.env.DATA_DIR = dir;
const { db, withWorkspace, closeAll } = await import('../server/db.js');
const accounts = await import('../server/accounts.js');
const { acc, createWorkspace, addMember, removeMember, roleIn, workspacesOf } = accounts;

const newAccount = name => Number(acc.prepare("INSERT INTO users (username, name, pass, created_at) VALUES (?, ?, 'x', '2026-01-01')")
  .run(name, name).lastInsertRowid);

test('the data of two workspaces stays separate', () => {
  const anna = newAccount('anna');
  const a = createWorkspace('Lab', anna);
  const b = createWorkspace('Home', anna);
  assert.equal(a.file, 'organizer.db');
  assert.equal(b.file, `ws-${b.id}.db`);
  const add = (ws, title) => withWorkspace(ws, () => db.prepare(
    "INSERT INTO entries (kind, title, created_by, created_at, updated_at) VALUES ('todo', ?, ?, '2026-01-01', '2026-01-01')").run(title, anna));
  add(a, 'only in Lab');
  add(b, 'only at Home');
  const titles = ws => withWorkspace(ws, () => db.prepare('SELECT title FROM entries').all().map(r => r.title));
  assert.deepEqual(titles(a), ['only in Lab']);
  assert.deepEqual(titles(b), ['only at Home']);
  assert.deepEqual(workspacesOf(anna).map(w => [w.name, w.role]), [['Home', 'admin'], ['Lab', 'admin']]);
});

test('different roles per workspace and at least one admin', () => {
  const owner = newAccount('owner');
  const guest = newAccount('guest');
  const ws = createWorkspace('Workshop', owner);
  addMember(ws, guest, 'member');
  assert.equal(roleIn(ws.id, guest), 'member');
  assert.throws(() => removeMember(ws, owner), /only admin/);
  // The copy of the members in the workspace serves names and foreign keys; whoever leaves stays as a former member.
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
