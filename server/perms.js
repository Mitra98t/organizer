// Permission checks per area on the server (the rules live in public/js/perms.js, shared with the app).
import { allows, AREAS, entryArea } from '../public/js/perms.js';
import { fail } from './util.js';

export { allows, entryArea };

const DENIED = { read: 'You are not allowed to see the {_area} area in this workspace', write: 'You are not allowed to change the {_area} area in this workspace' };

export function assertCan(user, area, level = 'read') {
  if (!allows(user?.perms, area, level)) fail(403, DENIED[level], { _area: AREAS[area] });
}

// Entry kinds the user can read (to filter queries): 'todo', 'note', 'mail'.
export function readableKinds(user) {
  const out = [];
  if (allows(user?.perms, 'voci')) out.push('todo', 'note');
  if (allows(user?.perms, 'mail')) out.push('mail');
  return out;
}
