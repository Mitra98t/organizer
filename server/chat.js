// Chat del workspace: messaggi brevi tra i membri, con i collegamenti a ciò che sta nell'app
// (#CODICE, @progetto, [[doc:ID]], [[voce:ID]], [[contatto:ID]]) scritti nel testo e mostrati come link.
// Gli ultimi 100 messaggi arrivano con /api/sync (vedi api.js); i precedenti si leggono qui.
import { db } from './db.js';
import { route, insertId } from './api.js';
import { fail, now, str } from './util.js';

const MAX_TEXT = 4000;
const COLS = 'id, user_id, text, created_at, edited_at';

const getMessage = id => db.prepare('SELECT * FROM chat_messages WHERE id = ? AND deleted_at IS NULL').get(+id) || fail(404, 'Messaggio non trovato');

// ?before=ID: i precedenti (per scorrere indietro); ?after=ID: i successivi (per chi segue la chat, es. org chat -f).
route('GET', '/api/chat', ({ query }) => {
  const limit = Math.min(Math.max(+query.limit || 50, 1), 500);
  if (query.after) {
    return db.prepare(`SELECT ${COLS} FROM chat_messages WHERE deleted_at IS NULL AND id > ? ORDER BY id LIMIT ?`).all(+query.after, limit);
  }
  const before = +query.before || Number.MAX_SAFE_INTEGER;
  return db.prepare(`SELECT ${COLS} FROM chat_messages WHERE deleted_at IS NULL AND id < ? ORDER BY id DESC LIMIT ?`).all(before, limit).reverse();
}, { area: 'chat' });

route('POST', '/api/chat', async ({ user, body }) => {
  const text = str((await body()).text, MAX_TEXT) || fail(400, 'Scrivi qualcosa');
  const id = insertId(db.prepare('INSERT INTO chat_messages (user_id, text, created_at) VALUES (?, ?, ?)').run(user.id, text, now()));
  // Chi scrive ha letto tutto fino al proprio messaggio.
  db.prepare('UPDATE users SET chat_read_id = ? WHERE id = ?').run(id, user.id);
  return { id };
}, { area: 'chat' });

route('PATCH', '/api/chat/:id', async ({ params, user, body }) => {
  const m = getMessage(params.id);
  if (m.user_id !== user.id) fail(403, 'Puoi modificare solo i tuoi messaggi');
  const text = str((await body()).text, MAX_TEXT) || fail(400, 'Il messaggio non può essere vuoto');
  db.prepare('UPDATE chat_messages SET text = ?, edited_at = ? WHERE id = ?').run(text, now(), m.id);
}, { area: 'chat' });

route('DELETE', '/api/chat/:id', ({ params, user }) => {
  const m = getMessage(params.id);
  if (m.user_id !== user.id && !user.is_admin) fail(403, 'Puoi eliminare solo i tuoi messaggi');
  db.prepare('UPDATE chat_messages SET deleted_at = ? WHERE id = ?').run(now(), m.id);
}, { area: 'chat' });

// Letto fino a ID (non si torna mai indietro). Riguarda solo chi legge: niente notifica agli altri.
route('POST', '/api/chat/read', async ({ user, body }) => {
  const id = Number((await body()).id);
  if (!Number.isInteger(id) || id < 0) fail(400, 'Messaggio non valido');
  db.prepare('UPDATE users SET chat_read_id = MAX(chat_read_id, ?) WHERE id = ?').run(id, user.id);
}, { area: 'chat', level: 'read', quiet: true });
