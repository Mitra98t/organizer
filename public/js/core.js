// State, network, sync and small DOM helpers shared by the views.
import { today, ymd, fromYmd, parseQuick } from './parse.js';
import { allows, entryArea } from './perms.js';
import { tr, trn, LANG, LOCALE } from './i18n.js';

export { tr, trn };

// The user's permissions in the active workspace (from the server; null = everything). See perms.js.
export const can = (area, level = 'read') => allows(S.data?.perms, area, level);
export const canEntry = (e, level = 'write') => can(entryArea(e.kind), level);

// Read-only parts of the page: those marked .ro (pages, sections, entries) have their controls disabled, the
// .rw parts inside them do not. The closest container wins. Offline everything is read-only, except the
// queued entries (see "offline" below).
export const roClass = writable => (writable && S.online ? 'rw' : 'ro');
export function isReadOnly(el) {
  const scope = el?.closest?.('.ro, .rw');
  return !!scope && scope.classList.contains('ro');
}

// After every render: controls that change things inside read-only parts are disabled. Filters, toolbars,
// collapsible sections and the choice of documents to review stay active.
export function applyReadOnly(root) {
  for (const el of root.querySelectorAll('.ro :is(input, textarea, select, button)')) {
    if (el.closest('.toolbar') || el.matches('.filter, .keep, .sec-h, .sel-btn, .fchip, [type="search"]')) continue;
    if (isReadOnly(el)) el.disabled = true;
  }
}

export const load = (k, d) => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? d : JSON.parse(v);
  } catch {
    return d;
  }
};
export const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch { /* storage full or disabled: never mind */ }
};

export const S = { me: null, setup: false, data: null, live: false, online: navigator.onLine, outbox: load('org.outbox', []) };
export const ui = {
  open: new Set(),
  sections: new Set(load('org.sections', [])),
  mine: load('org.mine', false),
  agendaKind: load('org.agendaKind', 'all'),
  q: '',
  projStatus: 'open',
  itemFilter: '',
  diaryLimit: 120,
  docKind: 'firmware',
  docVer: '',
  archive: null,
  invites: null,
  tokens: null,
  chatDraft: '',
  chatEdit: null,
  richEdit: null, // data-fk of the text field open for editing (see richField)
  trash: null,
  contactFilter: '',
  contactsUnknown: false, // "to save" panel in Contacts
  ignoredAddrs: new Set(load('org.ignoredAddrs', [])), // addresses not to suggest for the address book
  mailHelper: load('org.mailHelper', false),
  mailFilter: '',
  mailView: load('org.mailView', 'active'), // 'active' (active threads) or 'archive'
  mailType: null, // only threads in one state (unread, to send, awaiting reply, starred)
  mailSel: null, // on a topic page: the mail picked in the tree { topic, type: 'msg' | 'entry', id }
  mailSelNext: null, // draft just requested (Reply): picked as soon as it arrives
  mailAtt: false,
  mailProj: null,
  itemView: load('org.itemView', 'list'),
  treeClosed: new Set(), // collapsed inventory tree branches (key: the path of ids)
  treeFocus: null, // "Show the tree" from an item: only its trees
  itemCat: null,
  projDeep: load('org.projDeep', true),
  docNote: null,
  docEdit: null,
  docShowResolved: false,
  docNotesHidden: load('org.docNotesHidden', false),
  docFilter: '',
  docKindF: null,
  docOnlyNotes: false,
  docGroup: load('org.docGroup', 'item'),
  docSel: new Set(),
  catPicker: null,
  projPicker: null, // project whose colour popup is open
  contactPicker: null, // contact whose colour popup is open
  itemStatusF: null,
  hideDiscarded: load('org.hideDiscarded', false),
  contactGroup: load('org.contactGroup', 'none'),
  contactColor: load('org.contactColor', 'contact'), // how contacts are coloured (Settings)
  contactTab: null,
};

// ---------- render ----------
// While re-rendering, the focused element is removed: its blur/change must not save anything.
// hold: while dragging the view is not redrawn (it waits until the drop).
export const RS = { busy: false, hold: false, pending: false };
let renderFn = () => {};
let statusFn = () => {};
export const setRenderer = (fn, status) => { renderFn = fn; statusFn = status; };
export const render = () => renderFn();
export const renderStatus = () => statusFn();

const GUARDED = new Set(['blur', 'change', 'focusout']);

export function h(tag, attrs, ...kids) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    kids.unshift(attrs);
    attrs = {};
  }
  const [, name, rest] = tag.match(/^([\w-]*)(.*)$/);
  const el = document.createElement(name || 'div');
  for (const [, sigil, val] of rest.matchAll(/([#.])([\w-]+)/g)) {
    if (sigil === '#') el.id = val;
    else el.classList.add(val);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) {
      const type = k.slice(2);
      el.addEventListener(type, GUARDED.has(type) ? ev => { if (!RS.busy) v(ev); } : v);
    } else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  if (name === 'select' && attrs.value != null) el.value = attrs.value;
  return el;
}

function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false || k === true) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : String(k));
  }
}

const ICONS = {
  agenda: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  diary: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
  box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 9.5l5-5 5 5M5 20h14"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chip: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7z"/><path d="m11 13 9-9"/>',
  cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  log: '<path d="M5 6h14M5 12h14M5 18h9"/>',
  clip: '<path d="m20 11.5-8.3 8.3a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/>',
  cols: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="16" rx="1"/><rect x="17" y="4" width="4" height="16" rx="1"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.3-5.6L4 8.7"/><path d="M4 4v4.7h4.7"/>',
  contacts: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  'bell-off': '<path d="M8.5 5.6A6 6 0 0 1 18 11v4M6 11v5l-1.5 2H17"/><path d="M10 20a2 2 0 0 0 4 0M3 3l18 18"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M15.5 4.6a3.5 3.5 0 0 1 0 6.8M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  hash: '<path d="M9 4L7 20M17 4l-2 16M4.5 9h16M3.5 15h16"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.9-.6-1.3-.6-2.1 0-.9.7-1.5 1.6-1.5H17a4 4 0 0 0 4-4c0-4.9-4-8.8-9-8.8z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
  bug: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-5 4v-4h.5A1.5 1.5 0 0 1 4 14.5z"/><path d="M12 7v4M12 13.5v.5"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10"/>',
  news: '<path d="M4 20h15a2 2 0 0 0 2-2V5a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v13a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-7h5"/><path d="M11 8h6M11 12h6M11 16h4"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  wait: '<path d="M7 3h10M7 21h10M8 3c0 5 8 6 8 9s-8 4-8 9M16 3c0 5-8 6-8 9s8 4 8 9"/>',
  chat: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-5 4v-4h.5A1.5 1.5 0 0 1 4 14.5z"/><path d="M8 9h8M8 12h5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17.5v.01"/>',
};
export const icon = (name, cls = '') =>
  h('span.ic', { class: cls || null, 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>` });

export function autosize(el) {
  const t = el.target || el;
  t.style.height = 'auto';
  t.style.height = `${t.scrollHeight + 2}px`;
}

// ---------- network ----------
// X-Lang: the server answers (errors, texts it generates) in the interface language.
export async function api(method, url, body) {
  const headers = { 'X-Requested-With': 'organizer', 'X-Lang': LANG };
  const init = { method, headers, credentials: 'same-origin' };
  if (body instanceof Blob) {
    init.body = body;
    headers['Content-Type'] = body.type || 'application/octet-stream';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  let r;
  try {
    r = await fetch(`api${url}`, init);
  } catch {
    // An interrupted request does not mean offline (Safari drops a few on wake-up or when the network changes):
    // we are offline only if the server does not answer either. offline = the request did not get through.
    const up = await reachable();
    setOnline(up);
    throw Object.assign(new Error(up ? tr('Connection interrupted: try again') : tr('You are offline')), { offline: true });
  }
  setOnline(true);
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  if (r.status === 401 && !['/login', '/me', '/register', '/setup'].includes(url)) {
    S.me = null;
    render();
  }
  if (!r.ok) throw Object.assign(new Error(data?.error || tr('Error {status}', { status: r.status })), { status: r.status });
  return data;
}

// Does the server answer? (Not while it restarts for an update: the app is offline for a few seconds.)
const reachable = () => fetch('api/info', { cache: 'no-store' }).then(r => r.ok, () => false);

function setOnline(v) {
  if (S.online !== v) {
    S.online = v;
    renderStatus();
    render(); // offline the page becomes read-only (and editable again when the network is back)
  }
}

const group = (arr, key) => {
  const m = new Map();
  for (const x of arr) {
    const k = x[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
};

function indexData(d) {
  d.contacts ||= []; // cache saved by an older version
  d.attachments ||= [];
  d.projectItems ||= [];
  d.docNotes ||= [];
  d.entryProjects ||= [];
  d.categoryColors ||= [];
  d.customDocKinds ||= [];
  d.itemAliases ||= [];
  d.perms ??= null;
  d.chat ||= [];
  d.chatChannels ||= [];
  d.chatUnread ??= 0;
  d.members = d.users.filter(u => u.member !== 0); // current workspace members (the others are former ones, kept for names)
  d.catHueOf = new Map(d.categoryColors.map(c => [c.name.toLowerCase(), c.hue]));
  d.entryById = new Map(d.entries.map(e => [e.id, e]));
  d.projectById = new Map(d.projects.map(p => [p.id, p]));
  d.projectByTag = new Map(d.projects.map(p => [p.tag.toLowerCase(), p]));
  d.userById = new Map(d.users.map(u => [u.id, u]));
  d.itemById = new Map(d.items.map(i => [i.id, i]));
  d.itemByCode = new Map(d.items.map(i => [i.code.toUpperCase(), i]));
  // Alternative codes: #ALTERNATIVE leads to the item like its main code.
  d.aliasesOf = group(d.itemAliases, 'item_id');
  for (const a of d.itemAliases) if (d.itemById.has(a.item_id)) d.itemByCode.set(a.code.toUpperCase(), d.itemById.get(a.item_id));
  d.childrenOf = group(d.entries.filter(e => e.parent_id), 'parent_id');
  d.logsOf = group(d.logs, 'entry_id');
  d.itemsOfEntry = group(d.entryItems, 'entry_id');
  d.entriesOfItem = group(d.entryItems, 'item_id');
  d.docsOf = group(d.docs, 'item_id');
  d.docById = new Map(d.docs.map(x => [x.id, x]));
  d.docNotesOf = group(d.docNotes, 'doc_id');
  d.docNoteById = new Map(d.docNotes.map(n => [n.id, n]));
  d.childItems = group(d.itemLinks, 'parent_id');
  d.parentItems = group(d.itemLinks, 'child_id');
  d.contactById = new Map(d.contacts.map(c => [c.id, c]));
  d.contactByEmail = new Map(d.contacts.filter(c => c.email).map(c => [c.email.toLowerCase(), c]));
  d.attachmentsOf = group(d.attachments, 'entry_id');
  d.mailMsgs ||= [];
  d.shares ||= [];
  d.sharesOf = new Map(); // "entry:12" → ids of the people it is shared with
  for (const x of d.shares) {
    const k = `${x.kind}:${x.obj_id}`;
    if (!d.sharesOf.has(k)) d.sharesOf.set(k, []);
    d.sharesOf.get(k).push(x.user_id);
  }
  d.mine = new Set((d.myAddresses || []).map(a => a.toLowerCase())); // my addresses (Thunderbird identities)
  // Mail threads (personal): messages, mails written in Organizer and the links of each.
  d.mailTopics ||= [];
  d.mailThreads ||= [];
  d.threadLinks ||= [];
  d.topicLinks ||= [];
  d.topicById = new Map(d.mailTopics.map(t => [t.id, t]));
  d.linksOfTopic = group(d.topicLinks, 'topic_id');
  d.topicsOf = new Map(); // "progetto:3" → ids of the linked topics
  for (const l of d.topicLinks) {
    const k = `${l.kind}:${l.target_id}`;
    if (!d.topicsOf.has(k)) d.topicsOf.set(k, new Set());
    d.topicsOf.get(k).add(l.topic_id);
  }
  d.threadsOfTopic = group(d.mailThreads, 'topic_id');
  d.threadById = new Map(d.mailThreads.map(t => [t.id, t]));
  d.msgsOfThread = group(d.mailMsgs, 'thread_id');
  d.entriesOfThread = group(d.entries.filter(e => e.thread_id && e.kind === 'mail'), 'thread_id');
  d.linksOfThread = group(d.threadLinks, 'thread_id');
  d.threadsOf = new Map(); // "articolo:12" → ids of the linked threads
  for (const l of d.threadLinks) {
    const k = `${l.kind}:${l.target_id}`;
    if (!d.threadsOf.has(k)) d.threadsOf.set(k, new Set());
    d.threadsOf.get(k).add(l.thread_id);
  }
  d.itemsOfProject = group(d.projectItems, 'project_id');
  d.extraProjectsOf = group(d.entryProjects, 'entry_id');
  d.projectsOfItem = group(d.projectItems, 'item_id');
  d.subprojects = group(d.projects.filter(p => p.parent_id && d.projectById.has(p.parent_id)), 'parent_id');
  return d;
}

// Switching workspace: the data in memory and in the cache belong to the other one, so start over.
export async function switchWorkspace(id, hash = '#/agenda') {
  await api('POST', `/workspaces/${id}/switch`);
  clearLocal();
  location.hash = hash;
  location.reload();
}

export async function newWorkspace() {
  const name = await askText(tr('Name of the new workspace (you will be its admin):'), { title: tr('New workspace'), ok: tr('Create') });
  if (!name?.trim()) return;
  try {
    await api('POST', '/workspaces', { name: name.trim() });
    clearLocal();
    location.hash = '#/agenda';
    location.reload();
  } catch (e) {
    toast(e.message, { err: true });
  }
}

export function loadCache() {
  const d = load('org.cache', null);
  if (d?.me) {
    S.data = indexData(d);
    S.me = d.me;
  }
}

export function clearLocal() {
  localStorage.removeItem('org.cache');
  S.data = null;
}

let syncing = null;
let again = false;
export function sync() {
  if (syncing) {
    again = true;
    return syncing;
  }
  syncing = (async () => {
    try {
      do {
        again = false;
        const d = await api('GET', '/sync');
        if (S.data && d.rev === S.data.rev && d.me.id === S.data.me.id) continue;
        save('org.cache', d);
        const prev = S.data;
        S.data = indexData(d);
        window.dispatchEvent(new CustomEvent('org:data', { detail: { prev, data: S.data } }));
        S.me = d.me;
        S.noWorkspace = false;
        render();
        updateBadge();
      } while (again);
    } catch (e) {
      // 409: the account belongs to no workspace (removed from all of them): offer to create one.
      if (e.status === 409) {
        S.noWorkspace = true;
        S.data = null;
        render();
      } else if (!e.offline && e.status !== 401) console.warn('sync', e);
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

// ---------- real time ----------
let es = null;
let syncTimer = null;
export function connectLive() {
  es?.close();
  es = new EventSource('api/events');
  es.addEventListener('change', ev => {
    S.live = true;
    renderStatus();
    let rev;
    try { rev = JSON.parse(ev.data).rev; } catch { /* ignore */ }
    if (!S.data || rev !== S.data.rev) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(sync, 120);
    }
  });
  es.onopen = () => {
    S.live = true;
    setOnline(true);
    renderStatus();
    flushOutbox();
    window.dispatchEvent(new Event('org:live')); // the server may have restarted with a new version
  };
  es.onerror = () => {
    S.live = false;
    renderStatus();
    // Real time dropped: does the server still answer? If not we are offline (read-only pages).
    reachable().then(setOnline);
  };
}
export const liveClosed = () => !es || es.readyState === EventSource.CLOSED;
// Offline or without real time, check every 15 seconds whether the server answers: then we are back online, the
// queue is sent and, if real time had closed (a restarting server answers with an error and the browser stops
// retrying), it is reopened.
setInterval(() => {
  if (!S.me || (S.live && S.online)) return;
  reachable().then(ok => {
    setOnline(ok);
    if (!ok) return;
    flushOutbox();
    if (liveClosed()) connectLive();
  });
}, 15000);
export function disconnectLive() {
  es?.close();
  es = null;
  S.live = false;
}

// ---------- offline ----------
// Without network you can only create todos (Agenda) and notes (Journal): they wait in a queue (S.outbox) and,
// until they are sent, can be edited, marked done or deleted. Everything else is read-only: so when the network
// is back there is nothing to reconcile with the server, the new entries are simply added. client_id (generated
// here) avoids duplicates if sending is interrupted and repeated.
export const OFFLINE_KINDS = ['todo', 'note'];
const newCid = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

export async function addEntry(payload) {
  if (S.online) {
    try {
      await api('POST', '/entries', payload);
      sync();
      return true;
    } catch (e) {
      if (!e.offline) {
        toast(e.message, { err: true });
        return false;
      }
    }
  }
  const kind = parseQuick(payload.text, { kind: payload.kind || 'todo' }).kind;
  if (!OFFLINE_KINDS.includes(kind) || payload.parent_id) {
    toast(tr('Offline you can only add todos and notes: try again when the network is back'), { err: true });
    return false;
  }
  S.outbox.push({ ...payload, kind, cid: newCid(), pid: -Date.now(), queued_at: new Date().toISOString(), done: null });
  saveOutbox();
  if (S.online) setTimeout(flushOutbox, 3000); // just an interrupted request: retry right away
  toast(kind === 'note' ? tr('Offline: note queued, it is sent as soon as the network is back') : tr('Offline: todo queued, it is sent as soon as the network is back'));
  return true;
}

const saveOutbox = () => { save('org.outbox', S.outbox); renderStatus(); render(); };
const pendingOf = pid => S.outbox.find(p => p.pid === pid);

// A queued entry can be changed (text, done) or removed until it has been sent.
export function updatePending(pid, fields) {
  const p = pendingOf(pid);
  if (!p) return;
  Object.assign(p, fields);
  saveOutbox();
}

export function removePending(pid) {
  S.outbox = S.outbox.filter(p => p.pid !== pid);
  saveOutbox();
}

let flushing = false;
export async function flushOutbox() {
  if (flushing || !S.outbox.length) return;
  flushing = true;
  try {
    // Queues saved by older versions have no cid: give them one now.
    for (const p of S.outbox) p.cid ||= newCid();
    while (S.outbox.length) {
      const p = S.outbox[0];
      try {
        const { text, today: day, kind, project_id: projectId, cid, done } = p;
        await api('POST', '/entries', { text, today: day, kind, project_id: projectId, client_id: cid, done: done || undefined });
      } catch (e) {
        if (e.offline || e.status === 401) return;
        toast(tr('Queued entry discarded: {error}', { error: e.message }), { err: true });
      }
      S.outbox = S.outbox.filter(x => x !== p);
      save('org.outbox', S.outbox);
    }
  } finally {
    flushing = false;
    renderStatus();
    render();
    sync();
  }
}

export async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    sync();
    return r;
  } catch (e) {
    toast(e.offline ? tr('{error}: change not saved', { error: e.message }) : e.message, { err: true });
    sync();
  }
}

// Optimistic update: the UI changes at once, the server confirms with the next sync.
export function patchEntry(e, fields) {
  const local = { ...fields };
  if ('done' in local) {
    local.done_at = local.done ? new Date().toISOString() : null;
    delete local.done;
  }
  Object.assign(e, local);
  render();
  return act(() => api('PATCH', `/entries/${e.id}`, { ...fields, today: today() }));
}

// ---------- formatting ----------
export const dayDiff = d => Math.round((fromYmd(d) - fromYmd(today())) / 864e5);

export function fmtDay(d) {
  const x = fromYmd(d);
  return x.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', ...(x.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }).replace('.', '');
}

export function dueInfo(due) {
  const diff = dayDiff(due);
  let label;
  if (diff === 0) label = tr('today');
  else if (diff === 1) label = tr('tomorrow');
  else if (diff === -1) label = tr('yesterday');
  else if (diff > 1 && diff < 7) label = `${fromYmd(due).toLocaleDateString(LOCALE, { weekday: 'short' }).replace('.', '')} ${fromYmd(due).getDate()}`;
  else if (diff < -1 && diff > -60) label = tr('{n}d ago', { n: -diff });
  else label = fmtDay(due);
  return { label, diff, cls: diff < 0 ? 'over' : diff === 0 ? 'today' : diff <= 2 ? 'soon' : '' };
}

export const fmtLongDay = d => {
  const s = fromYmd(d).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
};
export const fmtTime = iso => new Date(iso).toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const localDay = iso => ymd(new Date(iso));
export const fmtSize = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export const userName = id => {
  const u = S.data?.userById.get(id);
  return u ? u.name || u.username : '—';
};

export const isMine = e => {
  const me = S.me.id;
  return e.assignee_id === me || (!e.assignee_id && e.created_by === me);
};

export const stop = ev => ev.stopPropagation();

// Stable hue per project (from its tag) and per inventory category: same name, same colour everywhere.
export function hue(s) {
  let x = 0;
  for (const c of String(s)) x = (x * 31 + c.codePointAt(0)) >>> 0;
  return x % 360;
}
// A document's name: the one given in the app, otherwise the file name (or the link).
export const docName = d => d.label || d.filename || d.url;

export async function renameDoc(d) {
  const name = await askText(tr('New name for the document (empty = back to the file name):'), { value: d.label || d.filename || '', title: tr('Rename'), ok: tr('Rename') });
  if (name == null) return;
  act(() => api('PATCH', `/docs/${d.id}`, { label: name.trim() }));
}

// Built-in document kinds. The stored values stay as they are (older databases have them); kindLabel() is the
// name shown, in the interface language.
export const DOC_KINDS = ['firmware', 'datasheet', 'schema', 'footprint', 'manuale', 'foto', 'altro'];
const KIND_LABELS = { schema: tr('schematic'), manuale: tr('manual'), foto: tr('photo'), altro: tr('other') };
export const kindLabel = k => KIND_LABELS[k] || k;
// Labels written in lower case (kinds, categories) shown as a tag: sentence case.
export const capFirst = s => (typeof s === 'string' && s ? s[0].toUpperCase() + s.slice(1) : s);
// All the kinds of the workspace: the built-in ones plus the added ones (whose colour comes from the name).
export const docKinds = () => S.data?.docKinds || DOC_KINDS;
export const dkAttrs = k => (DOC_KINDS.includes(k) ? { class: `k-${k}` } : { class: 'k-custom', style: `--h:${hue(k)}` });

// New document kind: asks for the name, creates it and returns it (null if cancelled or on error).
export async function newDocKind() {
  const name = await askText(tr('New document kind (one word, e.g. "certificate", "gerber", "bom"):'), { title: tr('New kind'), ok: tr('Create') });
  if (!name?.trim()) return null;
  const r = await act(() => api('POST', '/doc-kinds', { name: name.trim() }));
  return r?.name ?? null;
}

// Document kind picker: our own menu, because the options of a <select> cannot be coloured on the Mac.
// Each option is the kind with its colour; at the bottom "+ new kind…". Keyboard: ↑↓, Enter, Esc.
const kindMenu = h('div.kind-menu', { hidden: true, role: 'listbox' });
let kindMenuFor = null;

export function kindPicker(value, onPick, { title = tr('Document kind') } = {}) {
  const btn = h('button.dk-sel.kpick', {
    ...dkAttrs(value), type: 'button', title, 'aria-haspopup': 'listbox',
    onclick: ev => { ev.stopPropagation(); openKindMenu(btn, value, onPick); },
  }, capFirst(kindLabel(value)), h('span.kpick-caret', '▾'));
  return btn;
}

function closeKindMenu() {
  kindMenuFor = null;
  kindMenu.hidden = true;
}

// After a render the button may have been replaced: the menu closes.
export const kindMenuCheck = () => { if (kindMenuFor && !kindMenuFor.isConnected) closeKindMenu(); };

function openKindMenu(btn, value, onPick) {
  if (kindMenuFor === btn) return closeKindMenu();
  if (!kindMenu.isConnected) document.body.append(kindMenu);
  kindMenuFor = btn;
  const pick = async k => {
    closeKindMenu();
    btn.focus();
    const kind = k === '+' ? await newDocKind() : k;
    if (kind && kind !== value) onPick(kind);
  };
  kindMenu.replaceChildren(
    ...docKinds().map(k => h('button.km-i', { type: 'button', class: k === value ? 'on' : null, role: 'option', onclick: () => pick(k) }, h('span.dk', dkAttrs(k), kindLabel(k)))),
    h('button.km-i.new', { type: 'button', onclick: () => pick('+') }, icon('plus'), tr('new kind…')));
  kindMenu.hidden = false;
  const r = btn.getBoundingClientRect();
  const mh = kindMenu.offsetHeight;
  kindMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - kindMenu.offsetWidth - 8))}px`;
  kindMenu.style.top = `${r.bottom + 4 + mh < window.innerHeight - 8 ? r.bottom + 4 : Math.max(8, r.top - mh - 4)}px`;
  (kindMenu.querySelector('.km-i.on') || kindMenu.querySelector('.km-i')).focus();
}

document.addEventListener('pointerdown', ev => {
  if (kindMenuFor && !kindMenu.contains(ev.target) && !kindMenuFor.contains(ev.target)) closeKindMenu();
}, true);
window.addEventListener('scroll', ev => { if (kindMenuFor && !kindMenu.contains(ev.target)) closeKindMenu(); }, true);
kindMenu.addEventListener('keydown', ev => {
  const items = [...kindMenu.querySelectorAll('.km-i')];
  const i = items.indexOf(document.activeElement);
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    const b = kindMenuFor;
    closeKindMenu();
    b?.focus();
  }
});

// URL of a document's file. The fingerprint (sha256) in the address stops the browser from showing from its cache
// an old file with the same document number (after a reset or restoring a backup).
// src: a file that is not a document (the preview of a received attachment, already downloaded).
export const docFileUrl = (d, { inline = false } = {}) => d.src
  || `api/docs/${d.id}/file?v=${(d.sha256 || '').slice(0, 12)}${inline ? '&inline=1' : ''}`;

// The colour picked by hand if there is one, otherwise the automatic one.
export const projHue = p => p?.hue ?? hue(p?.tag ?? '');
// For a typed @tag: the project's colour if it exists, otherwise the one it will get.
export const tagStyle = tag => {
  const p = S.data?.projectByTag.get(String(tag).toLowerCase());
  return `--h:${p ? projHue(p) : hue(String(tag).toLowerCase())}`;
};
export const catHue = cat => S.data?.catHueOf?.get(String(cat).toLowerCase()) ?? hue(String(cat).toLowerCase());
export const catStyle = cat => (cat ? `--h:${catHue(cat)}` : null);

// Hues offered by the colour picker (same lightness as the automatic colours, in light and dark themes).
export const HUES = [0, 25, 45, 85, 130, 160, 190, 210, 235, 265, 290, 320];

// Colour picker: fixed hues + "automatic". onPick(hue | null).
export function huePicker(current, auto, onPick) {
  return h('div.hues',
    HUES.map(x => h('button.hue', { class: current === x ? 'on' : null, style: `--h:${x}`, title: tr('Hue {n}', { n: x }), onclick: () => onPick(x) })),
    h('button.hue.auto', { class: current == null ? 'on' : null, style: `--h:${auto}`, title: tr('Automatic colour'), onclick: () => onPick(null) }, 'A'));
}
// Filter chip, the same on every page. With "tint" it is the word on a background of its colour (category,
// document kind, entry kind, status); when on it has a solid border. Without "tint" it is a neutral chip.
export function filterChip({ on, onclick, label, n, cls, style, title }) {
  return h('button.chip.fchip', { class: [on && 'on', cls].filter(Boolean).join(' ') || null, style, title, onclick }, capFirst(label), n != null && h('span.n', n));
}

// An item's alternative codes (text), for filters and searches.
export const aliasCodes = it => (S.data?.aliasesOf.get(it.id) || []).map(a => a.code);

export const itemAttrs = it => (it?.category ? { class: 'cat', style: catStyle(it.category) } : {});

// An entry's projects: the main one first, then the others (only visible ones, not in the trash).
export function projectsOf(e) {
  const D = S.data;
  const ids = [e.project_id, ...(D.extraProjectsOf.get(e.id) || []).map(x => x.project_id)];
  return [...new Set(ids)].map(id => id && D.projectById.get(id)).filter(Boolean);
}

// All the subprojects (at every level) of a project.
export function descendants(id) {
  const out = [];
  const walk = pid => {
    for (const c of S.data.subprojects.get(pid) || []) {
      if (out.includes(c.id)) continue;
      out.push(c.id);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

export function ancestors(id) {
  const out = [];
  for (let p = S.data.projectById.get(id); p?.parent_id && out.length < 50;) {
    p = S.data.projectById.get(p.parent_id);
    if (p) out.unshift(p);
  }
  return out;
}

const RICH_RE = /(https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]'"])|(^|[\s(\[,;:])#([A-Za-z0-9](?:[\w.\-/]*[A-Za-z0-9_])?)/g;

// Text with clickable #CODES (they lead to the inventory item), live URLs and [[kind:ID]] links.
// bare: inventory codes written without # (mail text) become links too.
export function richText(text, { bare = false } = {}) {
  const s = String(text || '');
  const out = [];
  let last = 0;
  for (const m of s.matchAll(REF_RE)) {
    out.push(...codesAndUrls(s.slice(last, m.index), bare), refChip(m[1], +m[2]));
    last = m.index + m[0].length;
  }
  out.push(...codesAndUrls(s.slice(last), bare));
  return out;
}

const codeLink = (code, it) => h('a.code', {
  href: it ? `#/i/${it.id}` : '#/magazzino', onclick: stop, title: [it?.name, it?.category].filter(Boolean).join(' · '), ...itemAttrs(it),
}, code);

function codesAndUrls(text, bare) {
  const plain = bare ? bareCodes : x => [x];
  const out = [];
  let last = 0;
  for (const m of String(text || '').matchAll(RICH_RE)) {
    if (m[1]) {
      out.push(...plain(text.slice(last, m.index)));
      const internal = m[1].startsWith(`${location.origin}${location.pathname}#/`);
      const short = m[1].replace(/^https?:\/\/(www\.)?/, '');
      out.push(internal
        ? h('a.ext', { href: m[1].slice(m[1].indexOf('#')), onclick: stop }, m[1].includes('#/d/') ? tr('open the note in the document') : tr('open'))
        : h('a.ext', { href: m[1], target: '_blank', rel: 'noopener noreferrer', onclick: stop }, short.length > 42 ? `${short.slice(0, 40)}…` : short));
    } else {
      out.push(...plain(text.slice(last, m.index + m[2].length)));
      out.push(codeLink(m[3], S.data?.itemByCode.get(m[3].toUpperCase())));
    }
    last = m.index + m[0].length;
  }
  out.push(...plain(String(text || '').slice(last)));
  return out;
}

// Codes of existing items written without # (whole words only: "SCH-051" yes, "SCH-051B" no).
const WORD_RE = /[A-Za-z0-9](?:[\w.\-/]*[A-Za-z0-9_])?/g;
function bareCodes(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(WORD_RE)) {
    const it = S.data?.itemByCode.get(m[0].toUpperCase());
    if (!it) continue;
    out.push(text.slice(last, m.index), codeLink(m[0], it));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

// ---------- collapsible cards (phone) ----------
// Inventory, Documents and Mail: on a phone the cards (categories, groups, topics) collapse to their header, with
// its count. "Collapse all / Expand all" at the top; each card opens or closes on its own by tapping its header.
// Remembered on this device; on a wide screen the cards are always open.
const folds = load('org.folds', {}); // page → { all, open: [keys open with all], closed: [keys closed without all] }
const phone = () => matchMedia('(max-width: 899px)').matches;
const isFolded = (page, key) => { const f = folds[page] || {}; return f.all ? !(f.open || []).includes(key) : (f.closed || []).includes(key); };

function toggleFold(page, key) {
  const f = (folds[page] ||= {});
  const was = isFolded(page, key);
  if (f.all) f.open = was ? [...(f.open || []), key] : (f.open || []).filter(k => k !== key);
  else f.closed = was ? (f.closed || []).filter(k => k !== key) : [...(f.closed || []), key];
  save('org.folds', folds);
  render();
}

// el: the card; its first child is the header (it gets the arrow to open and close).
export function fold(page, key, el) {
  const k = String(key);
  el.dataset.fold = `${page}|${k}`;
  el.classList.toggle('folded', isFolded(page, k));
  el.firstElementChild?.append(h('button.fold-t.only-mobile', {
    type: 'button', title: tr('Open or close'), 'aria-expanded': String(!isFolded(page, k)), onclick: ev => { ev.stopPropagation(); toggleFold(page, k); },
  }, '▾'));
  return el;
}

export function foldBar(page) {
  const all = !!folds[page]?.all;
  return h('div.fold-bar.only-mobile',
    h('button.btn.sm.ghost', { type: 'button', onclick: () => { folds[page] = { all: !all }; save('org.folds', folds); render(); } },
      all ? tr('Expand all') : tr('Collapse all')));
}

document.addEventListener('click', ev => {
  if (!phone() || ev.target.closest('a, button, input, select, textarea, .pop-b')) return;
  const head = ev.target.closest('[data-fold] > :first-child');
  if (!head) return;
  const [page, key] = head.parentElement.dataset.fold.split('|');
  toggleFold(page, key);
});

// ---------- "wall" columns (like Pinterest's home) ----------
// The blocks (inventory categories, document groups) go in N columns: each, in order, into the shortest column,
// so no empty space is left under a short block. N: 3 on a large screen, 2 medium, 1 on a phone (like --cols in
// the CSS). Heights are measured as soon as the view is in the page.
const COLS_MQ = [['(max-width: 899px)', 1], ['(max-width: 1399px)', 2]];
const masonryCols = () => COLS_MQ.find(([q]) => matchMedia(q).matches)?.[1] ?? 3;

export function masonry(cls, blocks) {
  const list = blocks.filter(Boolean);
  const n = masonryCols();
  const cols = Array.from({ length: n }, () => h('div.mcol'));
  list.forEach((b, i) => cols[i % n].append(b));
  const box = h(`div.${cls}.masonry`, { style: `--cols:${n}` }, cols);
  box.blocks = list;
  queueMicrotask(() => pack(box));
  masonryWatch.observe(box);
  return box;
}

function pack(box) {
  if (!box.isConnected) return;
  const cols = [...box.children];
  const sizes = box.blocks.map(b => b.offsetHeight); // equally wide columns: heights are already right
  const heights = cols.map(() => 0);
  box.blocks.forEach((b, i) => {
    const c = heights.indexOf(Math.min(...heights));
    cols[c].append(b);
    heights[c] += sizes[i] + 12; // plus the gap between blocks
  });
}

// When the container changes width (window, phone rotation…): if the number of columns changes, re-render,
// otherwise re-pack the columns (text may wrap differently).
let packTimer = null;
const masonryWatch = new ResizeObserver(entries => {
  clearTimeout(packTimer);
  packTimer = setTimeout(() => {
    for (const e of entries) if (!e.target.isConnected) masonryWatch.unobserve(e.target); // old views
    const boxes = entries.map(e => e.target).filter(b => b.isConnected);
    if (boxes.some(b => b.children.length !== masonryCols())) render();
    else boxes.forEach(pack);
  }, 100);
});

// ---------- text fields that read like the chat ----------
// The text is shown already coloured (#CODES, [[…]] links, URLs) and the links can be clicked; a click on the
// text (or Enter when it has focus) opens the field for writing, leaving it saves and goes back to reading.
// Simple Markdown for long notes: headings (# ## ###), lists (- * 1.), checkboxes (- [ ] / - [x]), quotes (>),
// code blocks (```), rules (---), **bold**, *italic*, ~~strikethrough~~, `code` and [text](url); #CODES, URLs and
// [[…]] links keep working inside. "#CODE" is not a heading: a heading needs a space after the #.
const MD_INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|~~([^~\n]+?)~~|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)_(?![\w_])|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
function mdInline(s, opts) {
  const out = [];
  let last = 0;
  for (const m of s.matchAll(MD_INLINE)) {
    if (m.index > last) out.push(...richText(s.slice(last, m.index), opts));
    if (m[1] != null) out.push(h('code.md-code', m[1]));
    else if (m[2] != null) out.push(h('b', mdInline(m[2], opts)));
    else if (m[3] != null) out.push(h('s', mdInline(m[3], opts)));
    else if (m[4] != null || m[5] != null) out.push(h('i', mdInline(m[4] ?? m[5], opts)));
    else out.push(h('a.ext', { href: m[7], target: '_blank', rel: 'noopener noreferrer', onclick: stop }, m[6]));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(...richText(s.slice(last), opts));
  return out;
}

export function mdText(text, opts = {}) {
  const out = [];
  const lines = String(text || '').split('\n');
  let para = null;
  let list = null;
  const end = () => { para = null; list = null; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      end();
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push(h('pre.md-pre', code.join('\n')));
      continue;
    }
    if (!line.trim()) { end(); continue; }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { end(); out.push(h(`div.md-h${m[1].length}`, mdInline(m[2], opts))); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { end(); out.push(h('hr.md-hr')); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { end(); out.push(h('blockquote.md-q', mdInline(m[1], opts))); continue; }
    if ((m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      para = null;
      const ordered = /\d/.test(m[2]);
      if (!list || list.ordered !== ordered) {
        list = { ordered, el: h(ordered ? 'ol.md-list' : 'ul.md-list') };
        out.push(list.el);
      }
      const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
      list.el.append(h('li', { class: [m[1].length >= 2 && 'md-sub', task && 'md-task'].filter(Boolean).join(' ') || null },
        task ? [h('span.md-box', task[1] === ' ' ? '☐' : '☑'), ' ', ...mdInline(task[2], opts)] : mdInline(m[3], opts)));
      continue;
    }
    list = null;
    if (!para) out.push(para = h('p.md-p'));
    else para.append(h('br'));
    para.append(...mdInline(line, opts));
  }
  return out;
}

export function richField({ fk, value, placeholder, cls, rows = 2, attrs = {}, onSave, bare = false, md = false }) {
  if (ui.richEdit === fk) {
    return h(`textarea.${cls}`, {
      rows, value: value || '', placeholder, 'data-fk': fk, ...attrs,
      oninput: autosize,
      onkeydown: ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); ev.target.blur(); } },
      onblur: ev => {
        ui.richEdit = null;
        if (ev.target.value !== (value || '')) onSave(ev.target.value);
        render();
      },
    });
  }
  const edit = () => {
    ui.richEdit = fk;
    render();
    const el = document.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    autosize(el);
  };
  // Read-only (see isReadOnly): the text can be read and its links work, but the field does not open.
  const editable = ev => !isReadOnly(ev.currentTarget);
  return h(`div.${cls}.rich-view${md ? '.md' : ''}`, {
    tabindex: 0, role: 'textbox', title: tr('Click to edit'), style: `--rows:${rows}`,
    onclick: ev => { if (editable(ev) && !ev.target.closest('a, button') && !String(getSelection())) edit(); },
    onkeydown: ev => { if (editable(ev) && ev.key === 'Enter' && ev.target === ev.currentTarget) { ev.preventDefault(); edit(); } },
  }, value ? (md ? mdText(value, { bare }) : richText(value, { bare })) : h('span.rich-ph', placeholder));
}

// ---------- [[kind:ID]] links ----------
// Typed with "[[" in any text field (autocomplete inserts the token) and shown as links with an always up-to-date
// name. Items stay #CODE. Mails send them as plain text. The kinds keep their Italian names in stored text:
// [[doc:]], [[voce:]] (entry), [[contatto:]] (contact), [[progetto:]] (project), [[mail:]] (a mail conversation:
// personal, whoever does not receive it sees "not enough permissions") and [[nota:]] (a note on a document, also
// on a piece of a PDF's text: private unless shared).
const REF_RE = /\[\[(doc|voce|contatto|progetto|mail|nota):(\d+)\]\]/g;
const ENTRY_ICON = { todo: 'check', mail: 'mail', note: 'diary' };
const plainTitle = t => t.replace(/(^|\s)#/g, '$1');

const REF_AREA = { doc: 'documenti', progetto: 'progetti', contatto: 'contatti', mail: 'mail', nota: 'documenti' };

// Links to things the app does not have in its data (archived, not shared, deleted): ask the server once, all
// together after the render. The server only says the status (and the title if it can be seen).
const refInfo = new Map(); // "voce:12" → { status: 'ok' | 'hidden' | 'gone', title… } (null = on its way)
let refAsk = null;
function askRef(kind, id) {
  const key = `${kind}:${id}`;
  if (refInfo.has(key)) return refInfo.get(key);
  refInfo.set(key, null);
  refAsk ||= new Set();
  refAsk.add(key);
  queueMicrotask(() => {
    if (!refAsk) return;
    const refs = [...refAsk].map(k => k.split(':'));
    refAsk = null;
    api('POST', '/refs', { refs }).then(r => { for (const [k, v] of Object.entries(r)) refInfo.set(k, v); render(); })
      .catch(() => { for (const [k, i] of refs) refInfo.delete(`${k}:${i}`); });
  });
  return null;
}

const noAccess = () => h('span.ref.gone.denied', { title: tr('The link leads to something not shared with you (or to an area you cannot see)') },
  icon('lock'), tr('Note: not enough permissions'));

export function refChip(kind, id) {
  const D = S.data;
  // Link to an area you cannot see: say so, without a name (the data does not arrive).
  if (REF_AREA[kind] && !can(REF_AREA[kind])) return noAccess();
  if (kind === 'doc') {
    const d = D.docById.get(id);
    const it = d && D.itemById.get(d.item_id);
    return d ? h('a.ref', { href: `#/d/${id}`, onclick: stop, title: it ? tr('{kind} of {code}', { kind: kindLabel(d.kind), code: it.code }) : kindLabel(d.kind) }, icon('file'), docName(d), it && h('span.ref-x', it.code))
      : h('span.ref.gone', icon('file'), tr('document deleted'));
  }
  if (kind === 'voce') {
    // Not in the data: archived (it opens anyway), not shared, or deleted.
    const e = D.entryById.get(id) || refInfoEntry(id);
    if (e === 'hidden') return noAccess();
    if (e === 'gone') return h('span.ref.gone', icon('check'), tr('entry deleted'));
    return h('a.ref', { href: `#/v/${id}`, onclick: stop, class: e?.done_at ? 'done' : null },
      icon(ENTRY_ICON[e?.kind] || 'check'), e ? plainTitle(e.title.replace(REF_RE, '…')) : tr('entry {id}', { id }));
  }
  if (kind === 'mail') {
    const t = D.threadById.get(id);
    const r = !t && askRef('mail', id);
    if (r?.status === 'hidden') return noAccess();
    if (!t && r?.status !== 'ok') return h('span.ref.gone', icon('mail'), r ? tr('conversation deleted') : tr('conversation…'));
    const subject = t ? t.subject : r.title;
    return h('a.ref', { href: `#/t/${t ? t.topic_id : r.topic}?th=${id}`, onclick: stop, title: tr('Mail conversation') }, icon('mail'), plainTitle(subject || tr('(no subject)')));
  }
  if (kind === 'nota') {
    const n = D.docNoteById.get(id);
    const r = !n && askRef('nota', id);
    if (r?.status === 'hidden') return noAccess();
    if (!n && r?.status !== 'ok') return h('span.ref.gone', icon('log'), r ? tr('note deleted') : tr('note…'));
    const d = D.docById.get(n ? n.doc_id : r.doc);
    return h('a.ref', { href: `#/d/${n ? n.doc_id : r.doc}?n=${id}`, onclick: stop, class: (n ? n.resolved_at : r.done) ? 'done' : null, title: n?.quote ? `«${n.quote}»` : tr('Note on a document') },
      icon('log'), noteTitle(n ? n.text : r.title), d && h('span.ref-x', `${docName(d)}${n?.page && n.z == null && /pdf/i.test(d.mime || d.filename || d.url || '') ? ` · ${tr('p. {n}', { n: n.page })}` : ''}`));
  }
  if (kind === 'progetto') {
    const p = D.projectById.get(id);
    const st = !p && askRef('progetto', id)?.status;
    if (st === 'hidden') return noAccess();
    return p ? h('a.ref', { href: `#/p/${id}`, onclick: stop, style: `--h:${projHue(p)}` }, icon('folder'), p.name, h('span.ref-x', `@${p.tag}`))
      : h('span.ref.gone', icon('folder'), st ? tr('project deleted') : tr('project…'));
  }
  const c = D.contactById.get(id);
  const st = !c && askRef('contatto', id)?.status;
  if (st === 'hidden') return noAccess();
  return c ? h('a.ref', { href: `#/contatti/${id}`, onclick: stop, title: c.email }, icon('user'), c.name || c.email)
    : h('span.ref.gone', icon('user'), st ? tr('contact deleted') : tr('contact…'));
}

// Title of a note on a document: its first line, shortened.
const noteTitle = t => {
  const first = String(t || '').split('\n')[0].trim();
  return first.length > 80 ? `${first.slice(0, 80)}…` : first || tr('note');
};

function refInfoEntry(id) {
  const r = askRef('voce', id);
  if (!r) return null;
  if (r.status !== 'ok') return r.status;
  return { kind: r.kind, title: r.title, done_at: r.done ? 'x' : null };
}

// Plain name of a link (for mails opened with mailto: and for notifications).
export function plainRefs(text) {
  const D = S.data;
  return String(text || '').replace(REF_RE, (m, kind, id) => {
    const x = { doc: D.docById, voce: D.entryById, contatto: D.contactById, progetto: D.projectById, mail: D.threadById, nota: D.docNoteById }[kind].get(+id);
    const name = x && (kind === 'doc' ? docName(x) : kind === 'voce' ? plainTitle(x.title) : kind === 'mail' ? plainTitle(x.subject)
      : kind === 'nota' ? noteTitle(x.text) : x.name || x.email);
    return name || m;
  });
}

// Backlinks: the entries that link to something (from the server: archived entries included).
// Read again when the data changes; meanwhile the last result is shown.
const backlinkCache = new Map();
export function backlinks(kind, id) {
  const key = `${kind}:${id}`;
  const c = backlinkCache.get(key);
  const rev = S.data.rev;
  if (!c || (c.rev !== rev && !c.loading)) {
    backlinkCache.set(key, { ...c, loading: true });
    api('GET', `/backlinks/${kind}/${id}`)
      .then(list => { backlinkCache.set(key, { rev, list }); render(); })
      .catch(() => backlinkCache.set(key, { rev, list: c?.list || [] }));
  }
  return c?.list || null;
}

// Chat: on top of what richText does, @project and +person become links.
const CHAT_RE = /(^|[\s(\[,;:])([@+])([\p{L}\d_][\p{L}\d_.-]*[\p{L}\d_]|[\p{L}\d_])/gu;

export function chatText(text) {
  const D = S.data;
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(CHAT_RE)) {
    const [, pre, sig, name] = m;
    const p = sig === '@' && D.projectByTag.get(name.toLowerCase());
    const u = sig === '+' && D.users.find(x => x.username.toLowerCase() === name.toLowerCase());
    if (!p && !u) continue; // not a link: stays text
    out.push(...richText(text.slice(last, m.index + pre.length)));
    out.push(p ? h('a.tag', { href: `#/p/${p.id}`, onclick: stop, style: `--h:${projHue(p)}` }, `@${p.tag}`)
      : h('span.mention', { class: u.id === D.me.id ? 'me' : null, title: u.name }, `+${u.username}`));
    last = m.index + m[0].length;
  }
  out.push(...richText(String(text).slice(last)));
  return out;
}

// Delete (move to the trash) and offer "Undo" in the toast.
export async function trashIt(type, url, label) {
  const ok = await act(() => api('DELETE', url).then(() => true));
  const id = url.split('/').pop();
  if (ok) toast(tr('{what} moved to the trash', { what: label }), { action: { label: tr('Undo'), fn: () => act(() => api('POST', `/trash/${type}/${id}/restore`)) } });
  return ok;
}

// Contact colour, chosen in Settings (a preference of this device, like the theme): per contact (the one picked
// from the dot, otherwise automatic from the address) or the same for everyone with the same company, time slot or
// role (without that field: no colour).
export const CONTACT_COLOR = { contact: tr('Per contact (automatic or picked)'), company: tr('Per company'), timeslot: tr('Per time slot'), role: tr('Per role') };
export function contactHue(c) {
  if (ui.contactColor in CONTACT_COLOR && ui.contactColor !== 'contact') {
    const v = String(c[ui.contactColor] || '').trim().toLowerCase();
    return v ? hue(v) : null;
  }
  return c.hue ?? hue(String(c.email || c.name).toLowerCase());
}
export const contactStyle = c => { const x = contactHue(c); return x == null ? null : `--h:${x}`; };

// Recipients as elements: contacts in the address book with their name and colour, other addresses as they are.
export function contactNames(list) {
  const out = [];
  for (const a of String(list || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const c = S.data?.contactByEmail.get(a.toLowerCase());
    if (out.length) out.push(', ');
    out.push(c ? h('span.ccol', { style: contactStyle(c), title: a }, c.name || c.email) : a);
  }
  return out;
}

export function toast(msg, { err = false, action } = {}) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = h('div.toast', { class: err && 'err' }, h('span', msg),
    action && h('button', { onclick: () => { action.fn(); el.remove(); } }, action.label));
  box.append(el);
  setTimeout(() => el.remove(), action ? 6000 : 3500);
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(tr('Copied'));
  } catch {
    showText(tr('Copy:'), text);
  }
}

// ---------- dialogs ----------
// The app's own windows (<dialog>) instead of the browser's prompt, confirm and alert: same look as the app,
// Enter confirms, Esc or Cancel closes. Each returns a Promise: the text (null if cancelled), true/false, nothing.
function modal({ title, message, fields = [], ok = tr('OK'), cancel = tr('Cancel'), danger = false, read = null }) {
  return new Promise(resolve => {
    let done = false;
    const inputs = fields.map(f => h('input', {
      name: f.name, type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || null,
      readonly: f.readonly || null, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    }));
    const finish = v => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    const dlg = h('dialog.mdl', { 'aria-label': title || message || '' },
      h('form.mdl-f', { method: 'dialog', onsubmit: ev => { ev.preventDefault(); finish(read ? read(inputs) : true); } },
        title && h('h3.mdl-t', title),
        message && h('p.mdl-m', message),
        fields.map((f, i) => h('label.mdl-l',
          f.label && h('span', f.label),
          h('span.mdl-in', inputs[i], f.copy && h('button.btn', { type: 'button', onclick: () => copy(inputs[i].value) }, icon('copy'), tr('Copy'))))),
        h('div.mdl-b',
          cancel && h('button.btn.ghost', { type: 'button', onclick: () => finish(read ? null : false) }, cancel),
          h(`button.btn.${danger ? 'danger-fill' : 'primary'}`, { type: 'submit' }, ok))));
    dlg.addEventListener('cancel', ev => { ev.preventDefault(); finish(read ? null : false); }); // Esc
    // The app's shortcuts (Esc goes up a page, n and / open the quick bar, ⌘K) stay out while the window is open.
    dlg.addEventListener('keydown', ev => ev.stopPropagation());
    // A click outside closes only the windows without fields (nothing typed is lost).
    if (!fields.length) dlg.addEventListener('click', ev => { if (ev.target === dlg) finish(false); });
    document.body.append(dlg);
    dlg.showModal();
    const first = inputs.find(i => !i.readOnly) || inputs[0];
    if (first) {
      first.focus();
      first.select();
    } else dlg.querySelector('[type="submit"]').focus();
  });
}

// A line of text; null if cancelled. Options: value, placeholder, title, ok.
export const askText = (message, { value = '', placeholder, title, ok } = {}) =>
  modal({ title, message, ok, fields: [{ name: 'v', value, placeholder }], read: ([i]) => i.value });

// Several fields at once ({name, label, value, placeholder, type}); null if cancelled, otherwise {name: value}.
export const askFields = (fields, { title, message, ok } = {}) =>
  modal({ title, message, ok, fields, read: ins => Object.fromEntries(fields.map((f, i) => [f.name, ins[i].value])) });

// Yes or no. danger: the button is red (deletions). ok: the button's text (e.g. "Delete").
export const askConfirm = (message, { ok, danger = false, title } = {}) => modal({ title, message, ok, danger });

// A message with only OK.
export const notice = (message, { title } = {}) => modal({ title, message, cancel: null }).then(() => undefined);

// Text to copy (a token, a password): selected, with a Copy button.
export const showText = (message, text, { title } = {}) =>
  modal({ title, message, cancel: null, ok: tr('Done'), fields: [{ name: 'v', value: text, readonly: true, copy: true }], read: () => undefined });

export function updateBadge() {
  if (!S.data || !navigator.setAppBadge) return;
  const n = S.data.entries.filter(e => e.kind !== 'note' && !e.done_at && e.due && dayDiff(e.due) <= 0 && isMine(e)).length;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

// ---------- sharing ----------
// Everything is private to whoever creates it (except inventory and documents): it is shared with some people or
// with everyone. The creator opens the panel and chooses; the others only see who it is shared with.
export const sharedWithOf = (kind, o) => (S.data.sharesOf.get(`${kind}:${o.id}`) || []);

export function shareLabel(kind, o) {
  const D = S.data;
  if (o.shared_all) return tr('everyone');
  const ids = sharedWithOf(kind, o);
  if (!ids.length) return o.created_by === D.me.id ? tr('only you') : tr('{name} and you', { name: userName(o.created_by) });
  return ids.map(userName).join(', ');
}

export function shareBox(kind, o) {
  const D = S.data;
  const mine = o.created_by === D.me.id;
  const ids = sharedWithOf(kind, o);
  const label = [icon(o.shared_all ? 'users' : ids.length ? 'user' : 'lock'), h('span', tr('Visible to:'), ' ', h('b', shareLabel(kind, o)))];
  // Whoever did not create it only sees who it is shared with.
  if (!mine) return h('span.share-b.ro-info', { title: tr('Created by {name}: only they choose who to share it with', { name: userName(o.created_by) }) }, label, h('span.muted', ` · ${tr('by {name}', { name: userName(o.created_by) })}`));
  const save = (users, all) => act(() => api('PUT', `/shares/${kind}/${o.id}`, { users, all }));
  return popButton(`share:${kind}:${o.id}`, label, () => {
    const x = (kind === 'entry' ? S.data.entryById : kind === 'project' ? S.data.projectById : kind === 'contact' ? S.data.contactById : new Map(S.data.docNotes.map(n => [n.id, n]))).get(o.id) || o;
    const cur = sharedWithOf(kind, x);
    const others = S.data.members.filter(u => u.id !== S.data.me.id);
    return [
      popSep(tr('Visible to')),
      popItem(tr('Only me'), () => save([], false), { on: !x.shared_all && !cur.length, check: true }),
      popItem(tr('Everyone'), () => save(cur, !x.shared_all), { on: !!x.shared_all, check: true, hint: '+all' }),
      others.length > 0 && popSep(tr('People')),
      others.map(u => popItem(u.name || u.username, () => save(cur.includes(u.id) ? cur.filter(v => v !== u.id) : [...cur, u.id], !!x.shared_all),
        { on: !!x.shared_all || cur.includes(u.id), check: true, hint: `@${u.username}` })),
      !others.length && h('p.muted.pop-note', tr('There is nobody else in the workspace.')),
      h('p.muted.pop-note', tr('From the bar too: +person, ++person (also assigns it to them), +all.')),
    ];
  }, { class: 'share-b', title: tr('Choose who to share with') });
}

// ---------- popup menus ----------
// Context menus (like a right click) next to the button that opens them: Visible to, Assigned, Due date, Kind.
// They close on a click outside, with Esc or when the page scrolls; ↑↓ move from one item to the next.
// After a render the button is replaced: if it is still there (same data-pop) the menu stays open on it and is
// updated, so multiple choices (the people in "Visible to") do not close it.
const pop = h('div.popmenu', { hidden: true, role: 'menu' });
let popState = null; // { key, btn, content }

export function closePop(focus = false) {
  if (!popState) return;
  const btn = popState.btn;
  popState = null;
  pop.hidden = true;
  if (focus && btn.isConnected) btn.focus();
}

function placePop(btn) {
  const r = btn.getBoundingClientRect();
  const mh = pop.offsetHeight;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${r.bottom + 4 + mh < window.innerHeight - 8 ? r.bottom + 4 : Math.max(8, r.top - mh - 4)}px`;
}

function drawPop() {
  pop.replaceChildren(...[popState.content(closePop)].flat(Infinity).filter(Boolean));
  placePop(popState.btn);
}

// Button that opens a menu: content(close) draws the content (called again on every update).
export function popButton(key, label, content, attrs = {}) {
  const btn = h('button.pop-b', {
    type: 'button', 'data-pop': key, 'aria-haspopup': 'menu', 'aria-expanded': String(popState?.key === key), ...attrs,
    onclick: ev => {
      ev.stopPropagation();
      if (popState?.key === key) return closePop();
      if (!pop.isConnected) document.body.append(pop);
      popState = { key, btn, content };
      pop.hidden = false;
      drawPop();
      pop.querySelector('.pop-i.on, .pop-i, input')?.focus();
    },
  }, label, h('span.kpick-caret', '▾'));
  return btn;
}

export const popCheck = () => {
  if (!popState || popState.btn.isConnected) return;
  const btn = document.querySelector(`[data-pop="${CSS.escape(popState.key)}"]`);
  if (!btn) return closePop();
  popState.btn = btn;
  btn.setAttribute('aria-expanded', 'true');
  drawPop();
};

// A menu item: on = the current choice (or ticked, in multiple-choice menus).
export const popItem = (label, onclick, { on = false, check = false, hint = null } = {}) =>
  h('button.pop-i', { type: 'button', role: check ? 'menuitemcheckbox' : 'menuitem', class: on ? 'on' : null, 'aria-checked': check ? String(on) : null, onclick },
    check ? h('span.pop-ck', on ? icon('check') : null) : null, h('span.pop-l', label), hint && h('span.muted.pop-h', hint));
export const popSep = title => h('div.pop-sep', title || '');

document.addEventListener('pointerdown', ev => {
  if (popState && !pop.contains(ev.target) && !popState.btn.contains(ev.target)) closePop();
}, true);
window.addEventListener('scroll', ev => { if (popState && !pop.contains(ev.target)) closePop(); }, true);
window.addEventListener('resize', () => closePop());
pop.addEventListener('keydown', ev => {
  const items = [...pop.querySelectorAll('.pop-i, input')];
  const i = items.indexOf(document.activeElement);
  if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && document.activeElement?.type !== 'date') {
    ev.preventDefault();
    items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    closePop(true);
  } else if (ev.key === 'Tab') {
    closePop(true);
  }
});
