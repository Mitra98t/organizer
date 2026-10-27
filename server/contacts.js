// Rubrica condivisa: persone e aziende a cui si mandano mail.
import { db } from './db.js';
import { route, insertId } from './api.js';
import { fail, now, str } from './util.js';

const FIELDS = { name: 120, email: 200, phone: 60, company: 120, role: 120, timeslot: 60, notes: 20000 };

function fields(b) {
  const f = {};
  for (const [k, max] of Object.entries(FIELDS)) if (b[k] !== undefined) f[k] = str(b[k], max);
  if (f.email && !/^[^\s@]+@[^\s@]+$/.test(f.email)) fail(400, 'Email non valida');
  return f;
}

const getContact = id => db.prepare('SELECT * FROM contacts WHERE id = ? AND deleted_at IS NULL').get(+id) || fail(404, 'Contatto non trovato');

route('POST', '/api/contacts', async ({ user, body }) => {
  const f = fields(await body());
  if (!f.name && !f.email) fail(400, 'Serve almeno un nome o un\'email');
  const t = now();
  const cols = Object.keys(f);
  const id = insertId(db.prepare(`INSERT INTO contacts (${[...cols, 'created_by', 'created_at', 'updated_at'].join(', ')})
    VALUES (${[...cols, 'u', 't', 't'].map(c => `$${c}`).join(', ')})`).run({ ...f, u: user.id, t }));
  return { id };
});

route('PATCH', '/api/contacts/:id', async ({ params, body }) => {
  const c = getContact(params.id);
  const f = fields(await body());
  f.updated_at = now();
  const cols = Object.keys(f);
  db.prepare(`UPDATE contacts SET ${cols.map(k => `${k} = $${k}`).join(', ')} WHERE id = $id`).run({ ...f, id: c.id });
});

route('DELETE', '/api/contacts/:id', ({ params, user }) => {
  const c = getContact(params.id);
  db.prepare('UPDATE contacts SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), user.id, c.id);
});
