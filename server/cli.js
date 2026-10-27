// Comandi di manutenzione. Esempi:
//   npm run cli -- reset-password mario
//   docker compose exec app node server/cli.js invite
import { db } from './db.js';
import { hashPassword, randomCode } from './auth.js';
import { now } from './util.js';

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'reset-password' && arg) {
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(arg);
  if (!u) {
    console.error(`Utente "${arg}" inesistente`);
    process.exit(1);
  }
  const pw = randomCode(12);
  db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(await hashPassword(pw), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  console.log(`Nuova password per ${arg}: ${pw}`);
} else if (cmd === 'make-admin' && arg) {
  const r = db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(arg);
  console.log(r.changes ? `${arg} ora è amministratore` : `Utente "${arg}" inesistente`);
} else if (cmd === 'invite') {
  const code = randomCode(10);
  db.prepare('INSERT INTO invites (code, created_at, expires_at) VALUES (?, ?, ?)')
    .run(code, now(), new Date(Date.now() + 7 * 864e5).toISOString());
  console.log(`Codice invito (valido 7 giorni): ${code}`);
} else if (cmd === 'users') {
  console.table(db.prepare('SELECT id, username, name, is_admin, created_at FROM users').all());
} else {
  console.log('Comandi: reset-password <utente> | make-admin <utente> | invite | users');
}
