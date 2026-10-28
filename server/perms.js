// Controllo dei permessi per area sul server (le regole stanno in public/js/perms.js, condivise con l'app).
import { allows, AREAS, entryArea } from '../public/js/perms.js';
import { fail } from './util.js';

export { allows, entryArea };

const WHAT = { read: 'vedere', write: 'modificare' };

export function assertCan(user, area, level = 'read') {
  if (!allows(user?.perms, area, level)) fail(403, `Non hai il permesso di ${WHAT[level]} l'area ${AREAS[area]} in questo workspace`);
}

// Tipi di voce che l'utente può leggere (per filtrare le query): 'todo', 'note', 'mail'.
export function readableKinds(user) {
  const out = [];
  if (allows(user?.perms, 'voci')) out.push('todo', 'note');
  if (allows(user?.perms, 'mail')) out.push('mail');
  return out;
}
