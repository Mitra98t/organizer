import {
  h, icon, S, ui, RS, api, sync, setRenderer, render, renderStatus, connectLive, disconnectLive, liveClosed,
  flushOutbox, addEntry, loadCache, clearLocal, dueInfo, autosize, toast, isMine, dayDiff, save, hue, act, catStyle, tagStyle,
  switchWorkspace, newWorkspace, kindMenuCheck, popCheck, can, applyReadOnly, askConfirm, isWaiting,
} from './core.js';
import { initAutocomplete, acCheck } from './autocomplete.js';
import { viewContacts } from './contacts.js';
import { viewTrash } from './trash.js';
import { viewDoc, viewReview, docCancelDraft, setDocFocus, docSearchKey } from './docview.js';
import { viewDocuments } from './documents.js';
import { viewChat } from './chat.js';
import { viewMail, viewTopic } from './topics.js';
import { viewAttachment, attachmentBack } from './mail.js';
import { tabbar, updateTabbar } from './tabbar.js';
import { openPalette, initPalette } from './palette.js';
import { tourTick } from './tour.js';
import { bell, updateBell, notifyNew, viewNotification } from './notifiche.js';
import { openFeedback, viewFeedback } from './feedback.js';
import { viewChangelog, hasNews, appVersion } from './changelog.js';
import { applyTheme, currentTheme } from './themes.js';
import { applyIcon, logoSrc } from './appicons.js';
import { parseQuick, extractCodes, today, parseItemLine, parseProjectLine } from './parse.js';
import {
  viewAgenda, viewProjects, viewProject, viewDiary, viewItems, viewItem, viewSearch, viewSettings, viewEntryPage,
} from './views.js';
import { tr, trn } from './i18n.js';

const root = document.getElementById('root');

const VIEWS = {
  agenda: { fn: viewAgenda, title: tr('Agenda'), nav: 'agenda' },
  progetti: { fn: viewProjects, title: tr('Projects'), nav: 'progetti' },
  p: { fn: viewProject, title: tr('Project'), nav: 'progetti' },
  mail: { fn: viewMail, title: tr('Mail'), nav: 'mail' },
  t: { fn: viewTopic, title: tr('Mail'), nav: 'mail' },
  allegato: { fn: viewAttachment, title: tr('Attachment'), nav: 'mail' },
  diario: { fn: viewDiary, title: tr('Journal'), nav: 'diario' },
  magazzino: { fn: viewItems, title: tr('Inventory'), nav: 'magazzino' },
  i: { fn: viewItem, title: tr('Item'), nav: 'magazzino' },
  contatti: { fn: viewContacts, title: tr('Contacts'), nav: 'contatti' },
  cestino: { fn: viewTrash, title: tr('Trash'), nav: 'cestino' },
  d: { fn: viewDoc, title: tr('Document'), nav: 'documenti' },
  documenti: { fn: viewDocuments, title: tr('Documents'), nav: 'documenti' },
  review: { fn: viewReview, title: tr('Review'), nav: 'documenti' },
  cerca: { fn: viewSearch, title: tr('Search'), nav: null },
  chat: { fn: viewChat, title: tr('Chat'), nav: 'chat' },
  v: { fn: viewEntryPage, title: tr('Entry'), nav: null },
  novita: { fn: viewChangelog, title: tr('What\'s new'), nav: 'novita' },
  feedback: { fn: viewFeedback, title: tr('Feedback'), nav: 'impostazioni' },
  n: { fn: viewNotification, title: tr('Notification'), nav: null },
  impostazioni: { fn: viewSettings, title: tr('Settings'), nav: 'impostazioni' },
};

// Sidebar: groups of pages; the fourth column says the page sits under the one before (indented).
const SIDE = [
  [['progetti', tr('Projects'), 'folder']],
  [['agenda', tr('Agenda'), 'agenda'], ['diario', tr('Journal'), 'diary', 'sub']],
  [['magazzino', tr('Inventory'), 'box'], ['documenti', tr('Documents'), 'file', 'sub']],
  [['mail', tr('Mail'), 'mail'], ['contatti', tr('Contacts'), 'contacts', 'sub']],
  [['chat', tr('Chat'), 'chat']],
];

// Permissions: the area one needs to read to see each page (and its item in the menu).
const PAGE_AREA = {
  agenda: () => can('voci') || can('mail'), diario: () => can('voci'), mail: () => can('mail'), t: () => can('mail'), allegato: () => can('mail'),
  progetti: () => can('progetti'), p: () => can('progetti'),
  magazzino: () => can('magazzino'), i: () => can('magazzino'),
  documenti: () => can('documenti'), d: () => can('documenti'), review: () => can('documenti'),
  contatti: () => can('contatti'), chat: () => can('chat'),
};
const pageAllowed = name => !PAGE_AREA[name] || PAGE_AREA[name]();

// The quick bar is there only where one can write what it creates.
// Offline the bar is only in Agenda (todos) and in the Journal (notes): entries go into the queue (see core.js).
const offlinePage = name => name === 'agenda' || name === 'diario';

function quickAllowed(ctx) {
  if (!S.online && !offlinePage(route().name)) return false;
  if (ctx.mode === 'item') return can('magazzino', 'write');
  if (ctx.mode === 'project') return can('progetti', 'write');
  if (ctx.kind === 'mail') return can('mail', 'write');
  if (ctx.kind) return can('voci', 'write');
  return can('voci', 'write') || can('mail', 'write');
}

const noAccess = () => h('div.view', h('div.empty', h('p', h('b', tr('You have no access to this area.'))),
  h('p', tr('Permissions are decided by a workspace admin (Settings → Permissions).'))));

function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [p, qs] = raw.split('?');
  const [name, id] = p.split('/');
  return { name: name || 'agenda', id, query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

// ---------- quick bar ----------
function quickContext() {
  const r = route();
  const D = S.data;
  // In the Inventory and Projects lists the bar creates items and projects instead of entries.
  if (r.name === 'magazzino') return { mode: 'item', label: tr('new item') };
  if (r.name === 'progetti') return { mode: 'project', label: tr('new project') };
  if (r.name === 'mail') return { kind: 'mail', label: tr('new mail') };
  if (r.name === 'diario') return { kind: 'note', label: tr('new note') };
  if (r.name === 'p' && D) {
    const p = D.projectById.get(+r.id);
    if (p) return { project_id: p.id, label: `in @${p.tag}` };
  }
  if (r.name === 'i' && D) {
    const it = D.itemById.get(+r.id);
    if (it) return { code: it.code, label: tr('on #{code}', { code: it.code }) };
  }
  if (r.name === 'd' && D) {
    const it = D.itemById.get(D.docById.get(+r.id)?.item_id);
    if (it) return { code: it.code, label: tr('on #{code}', { code: it.code }) };
  }
  if (r.name === 'contatti' && r.id && D) {
    const c = D.contactById.get(+r.id);
    if (c?.email) return { kind: 'mail', email: c.email, label: tr('mail to {name}', { name: c.name || c.email }) };
  }
  return {};
}

const quickInput = h('input#quick', {
  placeholder: tr('Write… e.g. flash fw #SCH-042 @rover !fri'),
  autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'done', 'data-ac': 'auto',
  oninput: () => renderPreview(),
  onkeydown: ev => {
    if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); submitQuick(); }
    if (ev.key === 'Escape') quickInput.blur();
  },
});
const quickPreview = h('div.preview');
const quickCtx = h('span.ctx');
const quickHelp = h('div.qhelp', { hidden: true });
const acHint = () => h('span', tr('after the symbol the suggestions appear: '), h('code.k', '↑↓'), tr(' choose, '), h('code.k', 'Tab'), tr(' or '), h('code.k', tr('Enter')), tr(' completes'));
const HELP = {
  entry: () => [
    h('span', h('code.k', 't: m: n:'), ' ', tr('kind')),
    h('span', h('code.k', tr('!fri !3d !25/11')), ' ', tr('due date')),
    h('span', h('code.k', tr('@project'))),
    h('span', h('code.k', tr('#CODE')), ' ', tr('inventory')),
    h('span', h('code.k', tr('+person')), ' ', tr('they see it too')),
    h('span', h('code.k', tr('++person')), ' ', tr('and it is assigned to them')),
    h('span', h('code.k', '+all'), ' ', tr('everyone sees it (without: only you)')),
    h('span', h('code.k', tr('>recipient'))),
    h('span', h('code.k', '^'), ' ', tr('after another entry')),
    acHint()],
  item: () => [
    h('span', h('code.k', tr('CODE description')), ' ', tr('the first word is the code')),
    h('span', h('code.k', '/categoria')),
    h('span', h('code.k', tr('@project')), ' ', tr('links it to the project')),
    h('span', tr('if the code already exists, Enter opens its page')),
    acHint()],
  project: () => [
    h('span', h('code.k', tr('Project name'))),
    h('span', h('code.k', tr('@project')), ' ', tr('creates it as a subproject')),
    h('span', h('code.k', tr('+person +all')), ' ', tr('shares it (without: only you)')),
    acHint()],
};

function previewItem(text) {
  const D = S.data;
  const p = parseItemLine(text);
  const chips = [];
  const existing = D?.itemByCode.get(p.code.toUpperCase());
  if (!p.code) return chips;
  if (!p.valid) chips.push(h('span.pv.warn', `${p.code}`, h('i', ` ${tr('invalid code')}`)));
  else if (existing) chips.push(h('span.pv.code', { class: existing.category ? 'cat' : null, style: catStyle(existing.category) }, existing.code, h('i', ` ${tr('exists: Enter opens it')}`)));
  else chips.push(h('span.pv.code', { class: p.category ? 'cat' : null, style: catStyle(p.category) }, p.code, h('i', ` ${tr('new')}`)));
  if (p.name && !existing) chips.push(h('span.pv', p.name));
  if (p.category && !existing) {
    const known = D?.items.some(i => i.category.toLowerCase() === p.category.toLowerCase());
    chips.push(h('span.pv', icon('box'), p.category, !known && h('i', ` ${tr('new')}`)));
  }
  if (p.project) {
    const known = D?.projectByTag.has(p.project.toLowerCase());
    chips.push(h('span.pv.tag', { class: known ? null : 'warn', style: tagStyle(p.project) }, `@${p.project}`, !known && h('i', ` ${tr('does not exist')}`)));
  }
  return chips;
}

function previewProject(text) {
  const D = S.data;
  const p = parseProjectLine(text);
  const chips = [];
  if (p.name) chips.push(h('span.pv', icon('folder'), p.name));
  if (p.parent) {
    const known = D?.projectByTag.has(p.parent.toLowerCase());
    chips.push(h('span.pv', tr('inside')), h('span.pv.tag', { class: known ? null : 'warn', style: tagStyle(p.parent) }, `@${p.parent}`, !known && h('i', ` ${tr('does not exist')}`)));
  }
  if (p.name) chips.push(...shareChips(p.share.filter(n => n !== 'all'), p.share.includes('all'), null));
  return chips;
}

// Who it will be shared with: "only you", the people (+, ++ = assigned), "everyone". Unknown names in yellow.
function shareChips(names, all, assignee) {
  const D = S.data;
  const known = n => D?.members.some(u => [u.username, u.name].some(x => x?.toLowerCase() === n.toLowerCase()));
  const chips = names.map(n => h('span.pv', { class: known(n) ? null : 'warn', title: known(n) ? null : tr('Nobody with this name in the workspace') },
    icon('user'), n, assignee && n.toLowerCase() === assignee.toLowerCase() && h('i', ` ${tr('assigned')}`), !known(n) && h('i', ' ?')));
  if (all) chips.push(h('span.pv', icon('users'), tr('everyone')));
  if (!names.length && !all) chips.push(h('span.pv.muted', icon('lock'), tr('only you')));
  return chips;
}

function renderPreview() {
  const ctx = quickContext();
  const text = quickInput.value;
  const chips = [];
  quickHelp.replaceChildren(...HELP[ctx.mode || 'entry']());
  if (ctx.mode === 'item') chips.push(...previewItem(text));
  else if (ctx.mode === 'project') chips.push(...previewProject(text));
  else if (text.trim()) {
    const p = parseQuick(text, { today: today(), kind: ctx.kind || 'todo' });
    const D = S.data;
    if (p.kind !== 'todo' || p.kindExplicit) chips.push(h('span.kpill', { class: `k-${p.kind}` }, { todo: 'todo', mail: 'mail', note: tr('note') }[p.kind]));
    if (p.due === null) chips.push(h('span.pv', tr('no due date')));
    else if (p.due) { const d = dueInfo(p.due); chips.push(h('span.pv.due', { class: d.cls || null }, icon('cal'), d.label)); }
    if (p.project) chips.push(h('span.pv.tag', { style: tagStyle(p.project) }, `@${p.project}`, !D?.projectByTag.has(p.project.toLowerCase()) && h('i', ` ${tr('new')}`)));
    for (const c of p.codes) chips.push(h('span.pv.code', c, !D?.itemByCode.has(c.toUpperCase()) && h('i', ` ${tr('new')}`)));
    chips.push(...shareChips(p.shares, p.shareAll, p.assignee));
    if (p.contact) chips.push(h('span.pv', `→ ${p.contact}`));
    for (const id of p.after) chips.push(h('span.pv', icon('wait'), tr('after'), ' ', D?.entryById.get(id)?.title || `^${id}`));
  }
  quickInput.placeholder = {
    item: tr('New item… e.g. SCH-060 relay board /board @rover'),
    project: tr('New project… e.g. Motor firmware @rover'),
    mail: tr('Mail to send… e.g. offer for 50 boards >purchasing@company.example !fri'),
    note: tr('What happened… e.g. rev B needs fw ≥ 2.3 #SCH-042'),
  }[ctx.mode || ctx.kind] || tr('Write… e.g. flash fw #SCH-042 @rover !fri');
  quickCtx.textContent = ctx.label || '';
  quickCtx.hidden = !ctx.label;
  quickPreview.replaceChildren(...chips);
}

const projectByTag = tag => S.data.projectByTag.get(tag.toLowerCase());
const openAction = hash => ({ label: tr('Open'), fn: () => { location.hash = hash; } });

async function submitItem(text) {
  const p = parseItemLine(text);
  if (!p.valid) return toast(tr('Invalid code: letters, digits and . _ - /'), { err: true });
  const proj = p.project && projectByTag(p.project);
  if (p.project && !proj) return toast(tr('Project @{tag} does not exist', { tag: p.project }), { err: true });
  const existing = S.data.itemByCode.get(p.code.toUpperCase());
  quickInput.value = '';
  renderPreview();
  if (existing) {
    if (proj) await act(() => api('POST', `/projects/${proj.id}/items`, { code: existing.code }));
    location.hash = `#/i/${existing.id}`;
    return;
  }
  const r = await act(() => api('POST', '/items', { code: p.code, name: p.name, category: p.category || '', project_id: proj?.id }));
  if (r) toast(tr('{code} added', { code: p.code }), { action: openAction(`#/i/${r.id}`) });
  else { quickInput.value = text; renderPreview(); }
}

async function submitProject(text) {
  const p = parseProjectLine(text);
  if (!p.name) return toast(tr('Write the project\'s name'), { err: true });
  const parent = p.parent && projectByTag(p.parent);
  if (p.parent && !parent) return toast(tr('Project @{tag} does not exist', { tag: p.parent }), { err: true });
  quickInput.value = '';
  renderPreview();
  const r = await act(() => api('POST', '/projects', { name: p.name, parent_id: parent?.id, share: p.share }));
  if (r) toast(tr('@{tag} created', { tag: r.tag }), { action: openAction(`#/p/${r.id}`) });
  else { quickInput.value = text; renderPreview(); }
}

async function submitQuick() {
  const ctx = quickContext();
  let text = quickInput.value.trim();
  if (!text) return;
  if (ctx.mode === 'item') return submitItem(text);
  if (ctx.mode === 'project') return submitProject(text);
  if (ctx.code && !extractCodes(text).some(c => c.toUpperCase() === ctx.code.toUpperCase())) text += ` #${ctx.code}`;
  if (ctx.email && !/(^|\s)>\S/.test(text)) text += ` >${ctx.email}`;
  quickInput.value = '';
  renderPreview();
  const ok = await addEntry({ text, today: today(), kind: ctx.kind, project_id: ctx.project_id });
  if (!ok) { quickInput.value = text; renderPreview(); }
}

// ---------- shell ----------
const searchInput = h('input#search', {
  type: 'search', placeholder: tr('Search'), autocomplete: 'off', spellcheck: 'false',
  oninput: () => {
    ui.q = searchInput.value;
    ui.archive = null;
    if (route().name !== 'cerca') location.hash = '#/cerca';
    else render();
  },
  onkeydown: ev => { if (ev.key === 'Escape') { searchInput.value = ''; ui.q = ''; searchInput.blur(); history.back(); } },
  // On a phone "Search" opens the command bar (from there "Search everywhere" leads here); on the Search page you type here.
  onfocus: () => {
    if (matchMedia('(max-width: 899px)').matches && route().name !== 'cerca') {
      searchInput.blur();
      openPalette();
    }
  },
});

// "Search everywhere" from the command bar: the Search page with those words.
initPalette(q => {
  searchInput.value = q;
  ui.q = q;
  ui.archive = null;
  if (route().name !== 'cerca') location.hash = '#/cerca';
  else render();
});

const statusDot = h('span.status');
const titleEl = h('h1.vtitle');
const viewEl = h('div#view');
const navLinks = new Map();
let shellBuilt = false;

function navLink(key, label, ic, map, cls) {
  const badge = h('span.nbadge');
  const a = h(`a.${cls}`, { href: `#/${key}` }, icon(ic), h('span.nl', label), badge);
  map.set(key, { a, badge });
  return a;
}

function buildShell() {
  navLinks.clear();
  root.replaceChildren(
    h('div.app',
      h('aside.side',
        h('div.brand', h('img.app-logo', { src: logoSrc(), alt: '' }), h('span', 'Organizer')),
        wsSwitch,
        // Groups separated by a light divider; Journal, Documents and Contacts sit under the page they belong to.
        h('nav.side-nav', SIDE.map(group => h('div.nav-group',
          group.map(([k, l, i, sub]) => navLink(k, l, i, navLinks, sub ? 'nav.sub' : 'nav'))))),
        // At the bottom of the bar: Trash, Settings, the version's news (the changelog, with "new" until it is read)
        // and Feedback to report a bug or an idea to whoever develops the app.
        h('div.side-foot', navLink('cestino', tr('Trash'), 'trash', navLinks, 'nav'),
          navLink('impostazioni', tr('Settings'), 'settings', navLinks, 'nav'),
          navLink('novita', tr('What\'s new'), 'news', navLinks, 'nav'),
          h('button.nav.fb-btn', { type: 'button', onclick: openFeedback, title: tr('Report a bug or an idea, also with screenshots') }, icon('bug'), h('span.nl', tr('Feedback'))))),
      h('main.main',
        updateBar,
        offlineBar,
        h('header.top',
          titleEl,
          h('label.search', icon('search'), searchInput),
          statusDot,
          bell),
        h('div.quick',
          h('div.qrow', icon('plus', 'qplus'), quickInput, quickCtx,
            h('button.icon-btn', { title: tr('Syntax'), type: 'button', onclick: () => { quickHelp.hidden = !quickHelp.hidden; } }, icon('help'))),
          quickPreview, quickHelp),
        viewEl),
      // Phone: one button per group, the other pages from the radial menu (long press), see tabbar.js.
      tabbar({ allowed: k => !S.data || pageAllowed(k), action: k => { if (k === 'feedback') openFeedback(); } })),
    h('div#toasts'));
  shellBuilt = true;
  // The quick bar stops right under the header, as tall as it really is (it changes with fonts, zoom and notch):
  // with a fixed height a gap was left through which the page could be seen scrolling.
  const top = root.querySelector('.top');
  const topH = () => document.documentElement.style.setProperty('--top-h', `${top.getBoundingClientRect().height}px`);
  topH();
  new ResizeObserver(topH).observe(top);
}

function updateStatus() {
  const pending = S.outbox.length;
  let cls; let title;
  if (!S.online) { cls = 'off'; title = navigator.onLine ? tr('Server not reachable') : tr('Offline'); }
  else if (S.live) { cls = 'live'; title = tr('Synced in real time'); }
  else { cls = 'wait'; title = tr('Reconnecting…'); }
  statusDot.className = `status ${cls}`;
  statusDot.title = pending ? tr('{status} — {n} queued', { status: title, n: pending }) : title;
  statusDot.textContent = pending ? String(pending) : '';
}

let tabBadges = {}; // badges per page, for the bottom bar

function updateBadges() {
  const D = S.data;
  if (!D) return;
  updateBell();
  const open = D.entries.filter(e => !e.done_at && e.kind !== 'note');
  const urgent = open.filter(e => e.due && dayDiff(e.due) <= 0 && isMine(e) && !isWaiting(e)).length;
  // Mail: to send plus the threads with unread messages.
  const mails = open.filter(e => e.kind === 'mail').length
    + D.mailThreads.filter(t => (D.msgsOfThread.get(t.id) || []).some(m => m.direction === 'in' && !m.read_at)).length;
  navLinks.get('agenda').badge.textContent = urgent || '';
  navLinks.get('mail').badge.textContent = mails || '';
  navLinks.get('cestino').badge.textContent = D.trashCount || '';
  const news = navLinks.get('novita');
  news.badge.textContent = hasNews() ? tr('new') : '';
  news.a.title = appVersion() ? tr('What\'s new · version {v}', { v: appVersion() }) : tr('What\'s new');
  const unread = D.chatUnread > 99 ? '99+' : D.chatUnread || '';
  navLinks.get('chat').badge.textContent = unread;
  navLinks.get('cestino').badge.classList.add('muted-badge');
  tabBadges = { agenda: urgent || '', mail: mails || '', chat: unread, novita: hasNews() ? tr('new') : '' };
}

// ---------- workspace ----------
const wsLabel = h('span.ws-name');
const wsMenu = h('div.ws-menu', { hidden: true });
const wsSwitch = h('div.ws-switch',
  h('button.ws-btn', { title: tr('Switch workspace'), onclick: () => { wsMenu.hidden = !wsMenu.hidden; renderWsMenu(); } }, icon('folder'), wsLabel, h('span.caret', '▾')),
  wsMenu);
document.addEventListener('click', ev => { if (!wsSwitch.contains(ev.target)) wsMenu.hidden = true; });

function renderWsMenu() {
  const D = S.data;
  if (!D?.workspace) return;
  wsMenu.replaceChildren(
    ...D.workspaces.map(w => h('button.ws-item', {
      class: w.id === D.workspace.id ? 'on' : null,
      onclick: () => { if (w.id !== D.workspace.id) switchWorkspace(w.id); },
    }, h('span', w.name), h('span.muted', w.tour ? tr('demo') : w.role === 'admin' ? 'admin' : tr('member')))),
    h('button.ws-item.new', { onclick: newWorkspace }, icon('plus'), tr('New workspace')));
}

// Account without a workspace (removed from all): create your own or wait for an invite.
function viewNoWorkspace() {
  return h('div.empty.no-ws',
    h('p', h('b', tr('You are not in any workspace.'))),
    h('p', tr('Create one (you will be its admin) or open an invite link.')),
    h('button.btn.primary', { onclick: newWorkspace }, icon('plus'), tr('Create a workspace')));
}

// Invite opened by someone already logged in: they join the workspace with their own account.
function viewJoin(code) {
  const box = h('div.auth-card', h('p.muted', tr('Checking the invite…')));
  api('GET', `/invites/${encodeURIComponent(code)}`).then(r => {
    box.replaceChildren(
      h('h2', tr('Join "{ws}"', { ws: r.workspace })),
      h('p.muted', tr('You are logged in as {user}: the workspace will be added to yours.', { user: S.me.username })),
      h('button.btn.primary', {
        onclick: () => act(async () => {
          await api('POST', `/invites/${encodeURIComponent(code)}/accept`);
          clearLocal();
          location.hash = '#/agenda';
          location.reload();
        }),
      }, tr('Join the workspace')),
      h('a.muted', { href: '#/agenda' }, tr('Not now')));
  }).catch(e => box.replaceChildren(h('h2', tr('Invalid invite')), h('p.muted', e.message), h('a', { href: '#/agenda' }, tr('Back to the app'))));
  return h('div.view', box);
}

function renderApp() {
  if (RS.hold) {
    RS.pending = true;
    return;
  }
  if (!S.me) return renderAuth();
  if (!shellBuilt) buildShell();
  const r = route();
  const v = VIEWS[r.name] || VIEWS.agenda;
  // Areas that cannot be read disappear from the menu (and from the bottom bar, which shrinks).
  if (S.data) for (const [k, { a }] of navLinks) a.hidden = !pageAllowed(k);
  for (const [k, { a }] of navLinks) a.classList.toggle('on', k === v.nav);
  titleEl.textContent = v.title;
  wsLabel.textContent = S.data?.workspace?.name || (S.noWorkspace ? tr('No workspace') : '…');
  if (!wsMenu.hidden) renderWsMenu();
  document.title = `${v.title} · Organizer`;
  if (r.name !== 'cerca' && document.activeElement !== searchInput && searchInput.value) { searchInput.value = ''; ui.q = ''; }
  renderPreview();
  updateStatus();
  updateBadges();
  updateTabbar(v.nav, tabBadges);

  // Rebuilds the view keeping focus, text and cursor of the field being edited.
  const a = document.activeElement;
  const keep = a && viewEl.contains(a) && a.dataset.fk
    ? { fk: a.dataset.fk, value: a.value, s: a.selectionStart, e: a.selectionEnd } : null;
  RS.busy = true;
  try {
    viewEl.replaceChildren(
      r.name === 'registrati' && r.query.code ? viewJoin(r.query.code)
        : S.noWorkspace ? viewNoWorkspace()
          : !S.data ? h('div.empty', tr('Loading…'))
            : pageAllowed(r.name) ? v.fn(r.id, r.query) : noAccess());
    document.body.classList.toggle('doc-page', !!S.data && (r.name === 'd' || r.name === 'review' || r.name === 'allegato'));
    document.body.classList.toggle('chat-page', !!S.data && r.name === 'chat');
    // Pages without the quick bar at the top (there is nothing to add there).
    document.body.classList.toggle('no-quick', r.name === 'novita' || r.name === 't' || r.name === 'allegato' || (!!S.data && !quickAllowed(quickContext())));
  } catch (e) {
    console.error(e);
    viewEl.replaceChildren(h('div.empty', tr('Display error: {error}', { error: e.message })));
  } finally {
    RS.busy = false;
  }
  // Offline the whole page is read-only, except the queued entries (.rw) and the filters.
  viewEl.classList.toggle('ro', !S.online);
  updateOfflineBar();
  applyReadOnly(viewEl);
  viewEl.querySelectorAll('textarea').forEach(autosize);
  acCheck();
  kindMenuCheck();
  popCheck();
  tourTick();
  if (keep) {
    const el = viewEl.querySelector(`[data-fk="${CSS.escape(keep.fk)}"]`);
    if (el) {
      if (el.value !== keep.value) el.value = keep.value;
      el.focus({ preventScroll: true });
      try { el.setSelectionRange(keep.s, keep.e); } catch { /* campi senza selezione */ }
    }
  }
}

// ---------- access ----------
function renderAuth() {
  shellBuilt = false;
  const r = route();
  const code = r.query.code || '';
  const mode = S.setup ? 'setup' : r.name === 'registrati' && !r.query.login ? 'register' : 'login';
  const titles = { setup: tr('First start: create your account'), register: tr('Sign up with an invite'), login: code ? tr('Log in and join the workspace') : tr('Log in') };
  const inviteInfo = h('p.muted');
  if (code) api('GET', `/invites/${encodeURIComponent(code)}`).then(i => { inviteInfo.textContent = tr('Invite to the workspace "{ws}".', { ws: i.workspace }); }).catch(e => { inviteInfo.textContent = e.message; });
  const err = h('p.err');
  const form = h('form.auth-card', {
    onsubmit: async ev => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target));
      err.textContent = '';
      try {
        const res = await api('POST', `/${mode}`, f);
        S.me = res.user;
        S.setup = false;
        clearLocal();
        if (mode === 'register' || code) location.hash = '#/agenda';
        start();
      } catch (e) {
        err.textContent = e.message;
      }
    },
  },
  h('div.brand', h('img.app-logo', { src: logoSrc(), alt: '' }), h('span', 'Organizer')),
  h('h2', titles[mode]),
  code && inviteInfo,
  mode === 'register' && h('label.f', h('span', tr('Invite code')), h('input', { name: 'code', value: code, required: true, autocapitalize: 'characters' })),
  mode === 'login' && code && h('input', { type: 'hidden', name: 'code', value: code }),
  mode === 'setup' && h('label.f', h('span', tr('Workspace name')), h('input', { name: 'workspace', placeholder: tr('e.g. Lab, Work, Home') })),
  h('label.f', h('span', 'Username'), h('input', { name: 'username', required: true, autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off' })),
  mode !== 'login' && h('label.f', h('span', tr('Name')), h('input', { name: 'name', autocomplete: 'name', placeholder: tr('how the others see you') })),
  h('label.f', h('span', 'Password'), h('input', { name: 'password', type: 'password', required: true, minlength: mode === 'login' ? null : 8, autocomplete: mode === 'login' ? 'current-password' : 'new-password' })),
  err,
  h('button.btn.primary', { type: 'submit' }, mode === 'login' ? tr('Log in') : tr('Create account')),
  mode === 'login' && h('p.muted', tr('Have an invite? '), h('a', { href: '#/registrati' }, tr('Sign up'))),
  mode === 'register' && h('p.muted', tr('Already have an account? '), h('a', { href: `#/registrati?code=${encodeURIComponent(code)}&login=1` }, tr('Log in and join the workspace'))));
  root.replaceChildren(h('div.auth', form), h('div#toasts'));
}

async function logout() {
  if (S.outbox.length && !await askConfirm(tr('There are {n} entries queued offline that will be lost. Log out?', { n: S.outbox.length }), { ok: tr('Log out'), danger: true })) return;
  try { await api('POST', '/logout'); } catch { /* offline: si esce comunque in locale */ }
  disconnectLive();
  clearLocal();
  S.outbox = [];
  save('org.outbox', []);
  S.me = null;
  location.hash = '#/';
  render();
}

// ---------- new version ----------
// The version the app opened with is that of the loaded code: if the server has a different one (updated while the
// app was open), the notice with "Reload" appears. Checked when real time reconnects (at every update the server
// restarts), when the app comes back to the foreground and every 30 minutes.
let loadedVersion = null;
const updateText = h('span');
// Offline: what can be done (and what is waiting in the queue).
const offlineText = h('span');
const offlineBar = h('div.update-bar.offline-bar', { hidden: true, role: 'status' }, icon('wait'), offlineText);
function updateOfflineBar() {
  offlineBar.hidden = S.online;
  const n = S.outbox.length;
  // The device has a network: it is the server that does not answer (usually restarting after an update).
  const why = navigator.onLine ? tr('The server does not answer (if it is updating it comes back by itself in a few seconds)') : tr('You are offline');
  offlineText.textContent = n ? tr('{why}: you can read everything and add todos in Agenda and notes in the Journal ({n} queued, sent as soon as the network is back). The rest can be changed when you are back online.', { why, n }) : tr('{why}: you can read everything and add todos in Agenda and notes in the Journal. The rest can be changed when you are back online.', { why });
}

const updateBar = h('div.update-bar', { hidden: true, role: 'status' },
  icon('up'), updateText, h('span.grow'),
  h('a.btn.sm.ghost', { href: '#/novita' }, tr('What\'s new')),
  h('button.btn.sm.primary', { onclick: reloadApp }, icon('restore'), tr('Reload')));

async function reloadApp() {
  try {
    await (await navigator.serviceWorker?.getRegistration())?.update();
  } catch {
    // without a service worker reloading is enough
  }
  location.reload();
}

function checkVersion() {
  return api('GET', '/info').then(i => {
    const first = S.version == null;
    S.version = i.version;
    loadedVersion ??= i.version;
    updateBar.hidden = i.version === loadedVersion;
    updateText.textContent = tr('Organizer {v} is available (you are using {old}).', { v: i.version, old: loadedVersion });
    if (first) render(); // for the What's new page and its "new" in the bar
  }).catch(() => {});
}
window.addEventListener('org:live', () => { if (loadedVersion) checkVersion(); });
setInterval(() => { if (S.me && document.visibilityState === 'visible') checkVersion(); }, 30 * 60e3);

function start() {
  render();
  checkVersion();
  sync();
  connectLive();
  flushOutbox();
}

// ---------- start ----------
setRenderer(renderApp, updateStatus);
initAutocomplete(() => { const c = quickContext(); return c.mode || c.kind; });
applyTheme(currentTheme());
applyIcon(currentTheme()); // browser tab and installation icon (see appicons.js)
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
window.addEventListener('org:logout', logout);
window.addEventListener('org:data', ev => notifyNew(ev.detail.prev, ev.detail.data));
// Other views ask to prefill the quick bar (e.g. "New mail" from a contact).
window.addEventListener('org:quick', ev => {
  quickInput.value = ev.detail;
  renderPreview();
  quickInput.focus();
  quickInput.setSelectionRange(quickInput.value.length, quickInput.value.length);
  window.scrollTo(0, 0);
});
window.addEventListener('online', () => { S.online = true; flushOutbox(); sync(); if (liveClosed()) connectLive(); renderStatus(); });
window.addEventListener('offline', () => { S.online = false; S.live = false; renderStatus(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.me) return;
  sync();
  checkVersion();
  if (liveClosed()) connectLive();
  render(); // the "today/tomorrow" labels change at midnight
});
document.addEventListener('keydown', ev => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName);
  // ⌘F (Ctrl+F) in a document searches the document; elsewhere the browser's search stays.
  if ((/Mac|iPhone|iPad/.test(navigator.userAgent) ? ev.metaKey : ev.ctrlKey) && ev.key.toLowerCase() === 'f' && !ev.altKey && docSearchKey()) {
    ev.preventDefault();
  } else if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ['k', 'p'].includes(ev.key.toLowerCase())) {
    // Command bar (⌘P instead of "Print").
    ev.preventDefault();
    openPalette();
  } else if (!inField && !ev.metaKey && !ev.ctrlKey && (ev.key === 'n' || ev.key === '/')) {
    ev.preventDefault();
    quickInput.focus();
  } else if (ev.key === 'Escape' && !ev.defaultPrevented) {
    goUp(inField ? ev.target : null);
  }
});

// Esc: leaves the field; outside the fields it closes the open entries, then goes up to the list (project → Projects…).
function goUp(field) {
  if (field) return field.blur();
  if (document.querySelector('.ac:not([hidden])')) return;
  if (docCancelDraft()) return;
  if (document.body.classList.contains('doc-focus')) return setDocFocus(false);
  if (ui.open.size) {
    ui.open.clear();
    return render();
  }
  const r = route();
  if (r.name === 'allegato') return attachmentBack();
  const doc = r.name === 'd' && S.data?.docById.get(+r.id);
  const up = { p: '#/progetti', i: '#/magazzino', cerca: '#/agenda', review: '#/documenti', t: '#/mail' }[r.name]
    || (r.name === 'contatti' && r.id ? '#/contatti' : null)
    || (doc ? `#/i/${doc.item_id}` : null);
  if (up) location.hash = up;
}

if ('serviceWorker' in navigator && isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // Click on a notification with the app already open (where the service worker cannot navigate by itself).
  navigator.serviceWorker.addEventListener('message', ev => { if (ev.data?.open) location.href = ev.data.open; });
}

(async function boot() {
  loadCache();
  if (S.me) render(); // instant opening from the cached data, then it updates
  try {
    const r = await api('GET', '/me');
    S.setup = r.setup;
    if (!r.user) {
      S.me = null;
      clearLocal();
      return render();
    }
    S.me = r.user;
    // The local cache belongs to a workspace: if it changed meanwhile (another tab, another device) it is not valid.
    if (S.data && S.data.workspace?.id !== r.workspace?.id) {
      clearLocal();
      S.data = null;
    }
    start();
  } catch {
    if (S.me) {
      toast(tr('Offline: you are seeing the last synced data'));
      renderStatus();
      connectLive();
    } else {
      root.replaceChildren(h('div.auth', h('div.auth-card', h('h2', tr('Server not reachable')), h('p.muted', tr('Check the connection and try again.')),
        h('button.btn.primary', { onclick: () => location.reload() }, tr('Try again')))));
    }
  }
})();
