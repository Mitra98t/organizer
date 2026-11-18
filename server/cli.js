// Maintenance commands (the make targets use them). Examples:
//   npm run cli -- reset-password mario
//   docker compose exec app node server/cli.js invite 2
// Messages follow the terminal's language (LANG, or ORG_LANG=it / en).
import { hashPassword, randomCode } from './auth.js';
import { acc, workspaceById, roleIn, syncMirror } from './accounts.js';
import { now } from './util.js';
import { logAccess, FAILED } from './access.js';
import { trIn, sysLang } from './i18n.js';

const lang = sysLang();
const say = (s, vars) => trIn(lang, s, vars);
const [cmd, arg, arg2] = process.argv.slice(2);
const account = name => acc.prepare('SELECT id FROM users WHERE username = ?').get(name) || (console.error(say('User "{name}" does not exist', { name })), process.exit(1));
const firstWorkspace = () => acc.prepare('SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY id LIMIT 1').get()?.id;

if (cmd === 'reset-password' && arg) {
  const u = account(arg);
  const pw = randomCode(12);
  acc.prepare('UPDATE users SET pass = ? WHERE id = ?').run(await hashPassword(pw), u.id);
  acc.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  acc.prepare('DELETE FROM api_tokens WHERE user_id = ?').run(u.id);
  logAccess(null, 'password_reset', { userId: u.id, username: arg });
  console.log(say('New password for {name}: {password}', { name: arg, password: pw }));
} else if (cmd === 'make-admin' && arg) {
  // make-admin <user> [workspace]: admin in the given workspace (default: the first one).
  const u = account(arg);
  const ws = workspaceById(arg2 || firstWorkspace());
  if (!ws) {
    console.error(say('No such workspace'));
    process.exit(1);
  }
  if (roleIn(ws.id, u.id)) acc.prepare("UPDATE memberships SET role = 'admin' WHERE workspace_id = ? AND user_id = ?").run(ws.id, u.id);
  else acc.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)").run(ws.id, u.id, now());
  syncMirror(ws, u.id);
  console.log(say('{name} is now admin of "{ws}"', { name: arg, ws: ws.name }));
} else if (cmd === 'invite') {
  // invite [workspace]: code to join the given workspace (default: the first one).
  const ws = workspaceById(arg || firstWorkspace());
  if (!ws) {
    console.error(say('No such workspace: create it from the app'));
    process.exit(1);
  }
  const code = randomCode(10);
  acc.prepare('INSERT INTO invites (code, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(code, ws.id, now(), new Date(Date.now() + 7 * 864e5).toISOString());
  console.log(say('Invite code for "{ws}" (valid for 7 days): {code}', { ws: ws.name, code }));
} else if (cmd === 'users') {
  console.table(acc.prepare(`SELECT u.id, u.username, u.name,
    (SELECT group_concat(w.name || ' (' || m.role || ')', ', ') FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = u.id AND w.deleted_at IS NULL) AS workspace
    FROM users u ORDER BY u.id`).all());
} else if (cmd === 'workspaces') {
  console.table(acc.prepare(`SELECT w.id, w.name, w.file, (SELECT COUNT(*) FROM memberships m WHERE m.workspace_id = w.id) AS members
    FROM workspaces w WHERE w.deleted_at IS NULL ORDER BY w.id`).all());
} else if (cmd === 'access') {
  // access [N] [failed]: the last N entries of the access log (default 50); "failed" only the failed attempts.
  const n = Math.min(Number(arg) || 50, 5000);
  const failed = [arg, arg2].includes('failed');
  const rows = acc.prepare(`SELECT l.at, l.event, COALESCE(u.username, l.username) AS user, l.ip, l.country, substr(l.agent, 1, 60) AS agent
    FROM access_log l LEFT JOIN users u ON u.id = l.user_id
    ${failed ? `WHERE l.event IN (${FAILED.map(e => `'${e}'`).join(', ')})` : ''} ORDER BY l.id DESC LIMIT ?`).all(n);
  console.table(rows.reverse());
} else {
  console.log(say('Commands: reset-password <user> | make-admin <user> [workspace] | invite [workspace] | users | workspaces | access [N] [failed]'));
}
