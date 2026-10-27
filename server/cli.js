// Comandi di manutenzione. Esempi:
//   npm run cli -- reset-password mario
//   docker compose exec app node server/cli.js invite 2
import { hashPassword, randomCode } from './auth.js';
import { acc, workspaceById, roleIn, syncMirror } from './accounts.js';
import { now } from './util.js';

const [cmd, arg, arg2] = process.argv.slice(2);
const account = name => acc.prepare('SELECT id FROM users WHERE username = ?').get(name) || (console.error(`Utente "${name}" inesistente`), process.exit(1));
const firstWorkspace = () => acc.prepare('SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY id LIMIT 1').get()?.id;

if (cmd === 'reset-password' && arg) {
  const u = account(arg);
  const pw = randomCode(12);
  acc.prepare('UPDATE users SET pass = ? WHERE id = ?').run(await hashPassword(pw), u.id);
  acc.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  acc.prepare('DELETE FROM api_tokens WHERE user_id = ?').run(u.id);
  console.log(`Nuova password per ${arg}: ${pw}`);
} else if (cmd === 'make-admin' && arg) {
  // make-admin <utente> [workspace]: admin nel workspace indicato (predefinito: il primo).
  const u = account(arg);
  const ws = workspaceById(arg2 || firstWorkspace());
  if (!ws) {
    console.error('Workspace inesistente');
    process.exit(1);
  }
  if (roleIn(ws.id, u.id)) acc.prepare("UPDATE memberships SET role = 'admin' WHERE workspace_id = ? AND user_id = ?").run(ws.id, u.id);
  else acc.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)").run(ws.id, u.id, now());
  syncMirror(ws, u.id);
  console.log(`${arg} ora è admin di "${ws.name}"`);
} else if (cmd === 'invite') {
  // invite [workspace]: codice per entrare nel workspace indicato (predefinito: il primo).
  const ws = workspaceById(arg || firstWorkspace());
  if (!ws) {
    console.error('Workspace inesistente: crealo dall\'app');
    process.exit(1);
  }
  const code = randomCode(10);
  acc.prepare('INSERT INTO invites (code, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(code, ws.id, now(), new Date(Date.now() + 7 * 864e5).toISOString());
  console.log(`Codice invito per "${ws.name}" (valido 7 giorni): ${code}`);
} else if (cmd === 'users') {
  console.table(acc.prepare(`SELECT u.id, u.username, u.name,
    (SELECT group_concat(w.name || ' (' || m.role || ')', ', ') FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = u.id AND w.deleted_at IS NULL) AS workspace
    FROM users u ORDER BY u.id`).all());
} else if (cmd === 'workspaces') {
  console.table(acc.prepare(`SELECT w.id, w.name, w.file, (SELECT COUNT(*) FROM memberships m WHERE m.workspace_id = w.id) AS membri
    FROM workspaces w WHERE w.deleted_at IS NULL ORDER BY w.id`).all());
} else {
  console.log('Comandi: reset-password <utente> | make-admin <utente> [workspace] | invite [workspace] | users | workspaces');
}
