// I dati del workspace (GET /api/sync) con gli indici per risolvere @progetti, CODICI e utenti per nome.
import { fail } from './term.js';

export async function loadData(api) {
  const D = await api.get('/sync');
  const byId = list => new Map(list.map(x => [x.id, x]));
  D.userById = byId(D.users);
  D.projectById = byId(D.projects);
  D.projectByTag = new Map(D.projects.map(p => [p.tag.toLowerCase(), p]));
  D.itemById = byId(D.items);
  D.itemByCode = new Map(D.items.map(i => [i.code.toLowerCase(), i]));
  D.entryById = byId(D.entries);
  D.docById = byId(D.docs);
  const group = (rows, key, val) => {
    const m = new Map();
    for (const r of rows) m.set(r[key], [...(m.get(r[key]) || []), r[val]]);
    return m;
  };
  D.extraProjectsOf = group(D.entryProjects, 'entry_id', 'project_id');
  D.itemsOfEntry = group(D.entryItems, 'entry_id', 'item_id');
  D.childrenOf = group(D.itemLinks, 'parent_id', 'child_id');
  D.parentsOf = group(D.itemLinks, 'child_id', 'parent_id');
  D.itemsOfProject = group(D.projectItems, 'project_id', 'item_id');
  return D;
}

export const userName = (D, id) => {
  const u = D.userById.get(id);
  return u ? u.username : '?';
};

// Come nell'app: è "mia" se è assegnata a me, o se non è assegnata a nessuno e l'ho scritta io.
export const isMine = (D, e) => e.assignee_id === D.me.id || (!e.assignee_id && e.created_by === D.me.id);

// Progetto principale per primo, poi gli altri.
export const entryProjects = (D, e) =>
  [e.project_id, ...(D.extraProjectsOf.get(e.id) || [])].filter(Boolean).map(id => D.projectById.get(id)).filter(Boolean);

// Il progetto e tutti i suoi sottoprogetti.
export function descendants(D, id) {
  const out = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of D.projects) if (p.parent_id && out.has(p.parent_id) && !out.has(p.id)) { out.add(p.id); grew = true; }
  }
  return out;
}

export function projectRef(D, ref) {
  const key = String(ref).replace(/^@/, '').toLowerCase();
  return D.projectByTag.get(key) || fail(`Progetto @${key} non trovato (org proj per l'elenco)`);
}

export function itemRef(D, ref) {
  const key = String(ref).replace(/^#/, '').toLowerCase();
  return D.itemByCode.get(key) || fail(`Articolo ${String(ref).replace(/^#/, '')} non trovato (org item per l'elenco)`);
}

export function userRef(D, ref) {
  const key = String(ref).replace(/^\+/, '').toLowerCase();
  return D.users.find(u => u.member && (u.username.toLowerCase() === key || u.name.toLowerCase() === key))
    || fail(`Nessuno si chiama "${key}" in questo workspace`);
}

// Voci, documenti e allegati si indicano con il numero. what: "della voce", "del documento"...
export function numRef(ref, what = 'della voce') {
  if (ref == null) fail(`Manca il numero ${what}`);
  return /^\d+$/.test(ref) ? +ref : fail(`"${ref}" non è un numero valido`);
}
