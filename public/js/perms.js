// Workspace members' permissions per area. Shared by browser and server (no dependencies: the labels are in English,
// whoever shows them translates them). Each area has a level: 'none' (cannot see it), 'read' (sees it but changes
// nothing), 'write'. Workspace admins always have everything; for the others, with nothing set, "write everywhere".
//
// Some areas need others to work: writing a mail means picking contacts, attaching documents, mentioning items and
// projects. So writing (or reading) an area requires reading the ones it depends on; the rules below are the same
// in the app and on the server.

export const AREAS = {
  voci: 'Todos and journal',
  mail: 'Mail',
  progetti: 'Projects',
  magazzino: 'Inventory',
  documenti: 'Documents',
  contatti: 'Contacts',
  chat: 'Chat',
};
export const LEVELS = { none: 'none', read: 'read', write: 'write' };

// Capabilities that are not an area: yes ('write') or no ('none'), no by default. They live in the same permissions.
export const CAPS = { canali: 'Manage chat channels' };

// What one sees (checked by the server, VIS_ANY and the like in server/api.js): permissions decide what can be done
// in the areas, they do not show other people's things.
export const PRIVACY_NOTE = 'Everything is private to whoever creates it, except inventory and documents: todos, journal, mails, projects, contacts and notes on documents are seen only by their creator (and whoever has an entry assigned), until they share them with +person or +all. Nobody, not even an admin, sees what is not shared with them. Incoming mail from Thunderbird always belongs only to whoever receives it. The permissions below decide what each person can do in the areas.';
const RANK = { none: 0, read: 1, write: 2 };

// To write an area you need to read these.
export const WRITE_NEEDS = {
  voci: ['progetti', 'magazzino'],
  mail: ['contatti', 'documenti', 'magazzino', 'progetti'],
  progetti: ['voci', 'magazzino'],
  magazzino: [],
  documenti: ['magazzino'],
  contatti: [],
  chat: ['voci', 'mail', 'progetti', 'magazzino', 'documenti', 'contatti'],
};
// To read an area you need to read these (documents live in inventory items).
export const READ_NEEDS = { documenti: ['magazzino'] };

export const fullAccess = () => Object.fromEntries(Object.keys(AREAS).map(a => [a, 'write']));

const valid = l => (l in RANK ? l : 'write');

// Completes the permissions respecting the dependencies, raising what is needed (never lowering).
export function normalize(perms) {
  const p = {
    ...fullAccess(),
    ...Object.fromEntries(Object.entries(perms || {}).filter(([a]) => a in AREAS).map(([a, l]) => [a, valid(l)])),
    ...Object.fromEntries(Object.keys(CAPS).map(c => [c, perms?.[c] === 'write' ? 'write' : 'none'])),
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const a of Object.keys(AREAS)) {
      const needs = [...(p[a] === 'write' ? WRITE_NEEDS[a] : []), ...(RANK[p[a]] >= 1 ? READ_NEEDS[a] || [] : [])];
      for (const n of needs) if (RANK[p[n]] < 1) { p[n] = 'read'; changed = true; }
    }
  }
  return p;
}

// Changes an area's level. Raising it also raises those it needs; lowering an area below reading lowers those that
// need it (write → read, or nothing).
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

// perms null/undefined = full access (admin, or someone without restrictions).
export const allows = (perms, area, level = 'read') => !perms || RANK[perms[area] ?? 'write'] >= RANK[level];

// An entry's area: mails are "mail", todos and journal notes "voci".
export const entryArea = kind => (kind === 'mail' ? 'mail' : 'voci');
export const isRestricted = perms => !!perms && Object.keys(AREAS).some(a => perms[a] !== 'write');
