// Rubrica: persone e aziende a cui si mandano mail. Ogni contatto è privato di chi lo crea e si condivide con
// delle persone o con tutti (pannello "Condiviso con", vedi PUT /api/shares/contact/:id).
import { db } from './db.js';
import { route, insertId, CVIS_ANY } from './api.js';
import { fail, now, str } from './util.js';

const FIELDS = { name: 120, email: 200, phone: 60, company: 120, role: 120, timeslot: 60, notes: 20000 };

function fields(b) {
  const f = {};
  for (const [k, max] of Object.entries(FIELDS)) if (b[k] !== undefined) f[k] = str(b[k], max);
  if (f.email && !/^[^\s@]+@[^\s@]+$/.test(f.email)) fail(400, 'Email non valida');
  // Colore: tinta 0..359, oppure null per tornare a quello automatico.
  if (b.hue !== undefined) {
    f.hue = b.hue === null || b.hue === '' ? null : Number(b.hue);
    if (f.hue !== null && !(Number.isInteger(f.hue) && f.hue >= 0 && f.hue < 360)) fail(400, 'Colore non valido');
  }
  return f;
}

const getContact = (id, user) => db.prepare(`SELECT * FROM contacts c WHERE c.id = $id AND c.deleted_at IS NULL AND ${CVIS_ANY}`)
  .get({ id: +id, uid: user.id }) || fail(404, 'Contatto non trovato');

route('POST', '/api/contacts', async ({ user, body }) => {
  const f = fields(await body());
  if (!f.name && !f.email) fail(400, 'Serve almeno un nome o un\'email');
  const t = now();
  const cols = Object.keys(f);
  const id = insertId(db.prepare(`INSERT INTO contacts (${[...cols, 'created_by', 'created_at', 'updated_at'].join(', ')})
    VALUES (${[...cols, 'u', 't', 't'].map(c => `$${c}`).join(', ')})`).run({ ...f, u: user.id, t }));
  return { id };
}, { area: 'contatti' });

route('PATCH', '/api/contacts/:id', async ({ params, user, body }) => {
  const c = getContact(params.id, user);
  const f = fields(await body());
  f.updated_at = now();
  const cols = Object.keys(f);
  db.prepare(`UPDATE contacts SET ${cols.map(k => `${k} = $${k}`).join(', ')} WHERE id = $id`).run({ ...f, id: c.id });
}, { area: 'contatti' });

route('DELETE', '/api/contacts/:id', ({ params, user }) => {
  const c = getContact(params.id, user);
  db.prepare('UPDATE contacts SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), user.id, c.id);
}, { area: 'contatti' });
