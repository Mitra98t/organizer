// The workspace data (GET /api/sync) with the indexes to resolve @projects, CODES and users by name.
import { fail } from './term.js';
import { tr } from './i18n.js';

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
  // Alternative codes: they find the item like the main code.
  D.aliasesOf = group(D.itemAliases || [], 'item_id', 'code');
  for (const a of D.itemAliases || []) if (D.itemById.has(a.item_id)) D.itemByCode.set(a.code.toLowerCase(), D.itemById.get(a.item_id));
  return D;
}

// [[doc:12]] [[voce:34]] [[contatto:5]] [[progetto:3]] [[mail:7]] [[nota:9]] → «current name» (like the links in the app).
// The prefixes are the stored format (Italian words: entry, contact, project, note).
export function refName(D, kind, id) {
  if (kind === 'doc') {
    const d = D.docById.get(id);
    return d ? `${d.label || d.filename || d.url} (${D.itemById.get(d.item_id)?.code ?? '?'})` : tr('deleted document');
  }
  if (kind === 'voce') return D.entryById.get(id)?.title.replace(/(^|\s)#/g, '$1').replace(/\[\[\w+:\d+\]\]/g, '…') ?? tr('entry {id}', { id });
  if (kind === 'progetto') return D.projectById.get(id)?.name ?? tr('deleted project');
  if (kind === 'mail') return D.mailThreads?.find(t => t.id === id)?.subject ?? tr('mail conversation');
  if (kind === 'nota') {
    const n = D.docNotes?.find(x => x.id === id);
    return n ? n.text.split('\n')[0].slice(0, 80) : tr('note');
  }
  const ct = D.contacts.find(x => x.id === id);
  return ct ? ct.name || ct.email : tr('deleted contact');
}

export const linkRefs = (D, text, color = s => s) =>
  String(text ?? '').replace(/\[\[(doc|voce|contatto|progetto|mail|nota):(\d+)\]\]/g, (_, kind, id) => color(`«${refName(D, kind, +id)}»`));

export const userName = (D, id) => {
  const u = D.userById.get(id);
  return u ? u.username : '?';
};

// As in the app: it is "mine" if it is assigned to me, or if it is assigned to nobody and I wrote it.
export const isMine = (D, e) => e.assignee_id === D.me.id || (!e.assignee_id && e.created_by === D.me.id);

// Main project first, then the others.
export const entryProjects = (D, e) =>
  [e.project_id, ...(D.extraProjectsOf.get(e.id) || [])].filter(Boolean).map(id => D.projectById.get(id)).filter(Boolean);

// The project and all its subprojects.
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
  return D.projectByTag.get(key) || fail(tr('Project @{tag} not found (org proj for the list)', { tag: key }));
}

export function itemRef(D, ref) {
  const key = String(ref).replace(/^#/, '').toLowerCase();
  return D.itemByCode.get(key) || fail(tr('Item {code} not found (org item for the list)', { code: String(ref).replace(/^#/, '') }));
}

export function userRef(D, ref) {
  const key = String(ref).replace(/^\+/, '').toLowerCase();
  return D.users.find(u => u.member && (u.username.toLowerCase() === key || u.name.toLowerCase() === key))
    || fail(tr('Nobody is called "{name}" in this workspace', { name: key }));
}

// Entries, documents and attachments are given by number. missing: the error when it is not there.
export function numRef(ref, missing = tr('The entry number is missing')) {
  if (ref == null) fail(missing);
  return /^\d+$/.test(ref) ? +ref : fail(tr('"{ref}" is not a valid number', { ref }));
}
