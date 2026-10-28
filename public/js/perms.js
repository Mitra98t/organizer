// Permessi per area dei membri di un workspace. Condiviso tra browser e server (nessuna dipendenza).
// Ogni area ha un livello: 'none' (non la vede), 'read' (la vede ma non cambia niente), 'write'.
// Gli admin del workspace hanno sempre tutto; per gli altri, senza impostazioni, vale "scrittura ovunque".
//
// Alcune aree per funzionare ne usano altre: scrivere una mail vuol dire scegliere i contatti, allegare
// documenti, citare articoli e progetti. Quindi scrivere (o leggere) un'area richiede di leggere quelle da cui
// dipende; le regole qui sotto valgono uguali nell'app e sul server.

export const AREAS = {
  voci: 'Todo e diario',
  mail: 'Mail',
  progetti: 'Progetti',
  magazzino: 'Magazzino',
  documenti: 'Documenti',
  contatti: 'Contatti',
  chat: 'Chat',
};
export const LEVELS = { none: 'nessuno', read: 'lettura', write: 'scrittura' };
const RANK = { none: 0, read: 1, write: 2 };

// Per scrivere in un'area serve leggere queste.
export const WRITE_NEEDS = {
  voci: ['progetti', 'magazzino'],
  mail: ['contatti', 'documenti', 'magazzino', 'progetti'],
  progetti: ['voci', 'magazzino'],
  magazzino: [],
  documenti: ['magazzino'],
  contatti: [],
  chat: ['voci', 'mail', 'progetti', 'magazzino', 'documenti', 'contatti'],
};
// Per leggere un'area serve leggere queste (i documenti stanno negli articoli del magazzino).
export const READ_NEEDS = { documenti: ['magazzino'] };

export const fullAccess = () => Object.fromEntries(Object.keys(AREAS).map(a => [a, 'write']));

const valid = l => (l in RANK ? l : 'write');

// Completa i permessi rispettando le dipendenze, alzando ciò che serve (mai abbassando).
export function normalize(perms) {
  const p = { ...fullAccess(), ...Object.fromEntries(Object.entries(perms || {}).filter(([a]) => a in AREAS).map(([a, l]) => [a, valid(l)])) };
  for (let changed = true; changed;) {
    changed = false;
    for (const a of Object.keys(AREAS)) {
      const needs = [...(p[a] === 'write' ? WRITE_NEEDS[a] : []), ...(RANK[p[a]] >= 1 ? READ_NEEDS[a] || [] : [])];
      for (const n of needs) if (RANK[p[n]] < 1) { p[n] = 'read'; changed = true; }
    }
  }
  return p;
}

// Cambia il livello di un'area. Alzando si alzano anche quelle che servono; abbassando un'area sotto la
// lettura si abbassano quelle che ne hanno bisogno (scrittura → lettura, oppure niente).
export function setLevel(perms, area, level) {
  const p = { ...normalize(perms), [area]: level };
  if (RANK[level] < 1) {
    for (let changed = true; changed;) {
      changed = false;
      for (const a of Object.keys(AREAS)) {
        if (p[a] === 'write' && WRITE_NEEDS[a].some(n => RANK[p[n]] < 1)) { p[a] = 'read'; changed = true; }
        if (RANK[p[a]] >= 1 && (READ_NEEDS[a] || []).some(n => RANK[p[n]] < 1)) { p[a] = 'none'; changed = true; }
      }
    }
  }
  return normalize(p);
}

// perms null/undefined = accesso pieno (admin, o chi non ha restrizioni).
export const allows = (perms, area, level = 'read') => !perms || RANK[perms[area] ?? 'write'] >= RANK[level];

// Area di una voce: le mail sono "mail", todo e note del diario "voci".
export const entryArea = kind => (kind === 'mail' ? 'mail' : 'voci');
export const isRestricted = perms => !!perms && Object.keys(AREAS).some(a => perms[a] !== 'write');
