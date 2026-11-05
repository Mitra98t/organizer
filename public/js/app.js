import {
  h, icon, S, ui, RS, api, sync, setRenderer, render, renderStatus, connectLive, disconnectLive, liveClosed,
  flushOutbox, addEntry, loadCache, clearLocal, dueInfo, autosize, toast, isMine, dayDiff, save, hue, act, catStyle, tagStyle,
  switchWorkspace, newWorkspace, kindMenuCheck, popCheck, can, applyReadOnly,
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

const root = document.getElementById('root');

const VIEWS = {
  agenda: { fn: viewAgenda, title: 'Agenda', nav: 'agenda' },
  progetti: { fn: viewProjects, title: 'Progetti', nav: 'progetti' },
  p: { fn: viewProject, title: 'Progetto', nav: 'progetti' },
  mail: { fn: viewMail, title: 'Mail', nav: 'mail' },
  t: { fn: viewTopic, title: 'Mail', nav: 'mail' },
  allegato: { fn: viewAttachment, title: 'Allegato', nav: 'mail' },
  diario: { fn: viewDiary, title: 'Diario', nav: 'diario' },
  magazzino: { fn: viewItems, title: 'Magazzino', nav: 'magazzino' },
  i: { fn: viewItem, title: 'Articolo', nav: 'magazzino' },
  contatti: { fn: viewContacts, title: 'Contatti', nav: 'contatti' },
  cestino: { fn: viewTrash, title: 'Cestino', nav: 'cestino' },
  d: { fn: viewDoc, title: 'Documento', nav: 'documenti' },
  documenti: { fn: viewDocuments, title: 'Documenti', nav: 'documenti' },
  review: { fn: viewReview, title: 'Revisione', nav: 'documenti' },
  cerca: { fn: viewSearch, title: 'Cerca', nav: null },
  chat: { fn: viewChat, title: 'Chat', nav: 'chat' },
  v: { fn: viewEntryPage, title: 'Voce', nav: null },
  novita: { fn: viewChangelog, title: 'Novità', nav: 'novita' },
  feedback: { fn: viewFeedback, title: 'Feedback', nav: 'impostazioni' },
  n: { fn: viewNotification, title: 'Notifica', nav: null },
  impostazioni: { fn: viewSettings, title: 'Impostazioni', nav: 'impostazioni' },
};

// Barra laterale: gruppi di voci; la quarta colonna dice che la voce sta sotto quella prima (rientrata).
const SIDE = [
  [['progetti', 'Progetti', 'folder']],
  [['agenda', 'Agenda', 'agenda'], ['diario', 'Diario', 'diary', 'sub']],
  [['magazzino', 'Magazzino', 'box'], ['documenti', 'Documenti', 'file', 'sub']],
  [['mail', 'Mail', 'mail'], ['contatti', 'Contatti', 'contacts', 'sub']],
  [['chat', 'Chat', 'chat']],
];

// Permessi: l'area che serve leggere per vedere ogni pagina (e la sua voce nel menu).
const PAGE_AREA = {
  agenda: () => can('voci') || can('mail'), diario: () => can('voci'), mail: () => can('mail'), t: () => can('mail'), allegato: () => can('mail'),
  progetti: () => can('progetti'), p: () => can('progetti'),
  magazzino: () => can('magazzino'), i: () => can('magazzino'),
  documenti: () => can('documenti'), d: () => can('documenti'), review: () => can('documenti'),
  contatti: () => can('contatti'), chat: () => can('chat'),
};
const pageAllowed = name => !PAGE_AREA[name] || PAGE_AREA[name]();

// La barra rapida c'è solo dove si può scrivere ciò che crea.
// Offline la barra c'è solo in Agenda (todo) e nel Diario (note): le voci vanno in coda (vedi core.js).
const offlinePage = name => name === 'agenda' || name === 'diario';

function quickAllowed(ctx) {
  if (!S.online && !offlinePage(route().name)) return false;
  if (ctx.mode === 'item') return can('magazzino', 'write');
  if (ctx.mode === 'project') return can('progetti', 'write');
  if (ctx.kind === 'mail') return can('mail', 'write');
  if (ctx.kind) return can('voci', 'write');
  return can('voci', 'write') || can('mail', 'write');
}

const noAccess = () => h('div.view', h('div.empty', h('p', h('b', 'Non hai accesso a quest\'area.')),
  h('p', 'I permessi li decide un admin del workspace (Impostazioni → Permessi).')));

function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [p, qs] = raw.split('?');
  const [name, id] = p.split('/');
  return { name: name || 'agenda', id, query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

// ---------- barra rapida ----------
function quickContext() {
  const r = route();
  const D = S.data;
  // Nelle liste di Magazzino e Progetti la barra crea articoli e progetti invece delle voci.
  if (r.name === 'magazzino') return { mode: 'item', label: 'nuovo articolo' };
  if (r.name === 'progetti') return { mode: 'project', label: 'nuovo progetto' };
  if (r.name === 'mail') return { kind: 'mail', label: 'nuova mail' };
  if (r.name === 'diario') return { kind: 'note', label: 'nuova nota' };
  if (r.name === 'p' && D) {
    const p = D.projectById.get(+r.id);
    if (p) return { project_id: p.id, label: `in @${p.tag}` };
  }
  if (r.name === 'i' && D) {
    const it = D.itemById.get(+r.id);
    if (it) return { code: it.code, label: `su #${it.code}` };
  }
  if (r.name === 'd' && D) {
    const it = D.itemById.get(D.docById.get(+r.id)?.item_id);
    if (it) return { code: it.code, label: `su #${it.code}` };
  }
  if (r.name === 'contatti' && r.id && D) {
    const c = D.contactById.get(+r.id);
    if (c?.email) return { kind: 'mail', email: c.email, label: `mail a ${c.name || c.email}` };
  }
  return {};
}

const quickInput = h('input#quick', {
  placeholder: 'Scrivi… es. flash fw #SCH-042 @rover !ven',
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
const acHint = () => h('span', 'dopo il simbolo compaiono i suggerimenti: ', h('code.k', '↑↓'), ' scegli, ', h('code.k', 'Tab'), ' o ', h('code.k', 'Invio'), ' completa');
const HELP = {
  entry: () => [
    h('span', h('code.k', 't: m: n:'), ' tipo'),
    h('span', h('code.k', '!ven !3g !25/11'), ' scadenza'),
    h('span', h('code.k', '@progetto')),
    h('span', h('code.k', '#CODICE'), ' magazzino'),
    h('span', h('code.k', '+persona'), ' la vede anche lei'),
    h('span', h('code.k', '++persona'), ' e gliela assegni'),
    h('span', h('code.k', '+all'), ' la vedono tutti (senza: solo tu)'),
    h('span', h('code.k', '>destinatario')),
    acHint()],
  item: () => [
    h('span', h('code.k', 'CODICE descrizione'), ' il primo termine è il codice'),
    h('span', h('code.k', '/categoria')),
    h('span', h('code.k', '@progetto'), ' lo collega al progetto'),
    h('span', 'se il codice esiste già, Invio apre la sua scheda'),
    acHint()],
  project: () => [
    h('span', h('code.k', 'Nome del progetto')),
    h('span', h('code.k', '@progetto'), ' lo crea come sottoprogetto'),
    h('span', h('code.k', '+persona +all'), ' lo condivide (senza: solo tu)'),
    acHint()],
};

function previewItem(text) {
  const D = S.data;
  const p = parseItemLine(text);
  const chips = [];
  const existing = D?.itemByCode.get(p.code.toUpperCase());
  if (!p.code) return chips;
  if (!p.valid) chips.push(h('span.pv.warn', `${p.code}`, h('i', ' codice non valido')));
  else if (existing) chips.push(h('span.pv.code', { class: existing.category ? 'cat' : null, style: catStyle(existing.category) }, existing.code, h('i', ' esiste: Invio la apre')));
  else chips.push(h('span.pv.code', { class: p.category ? 'cat' : null, style: catStyle(p.category) }, p.code, h('i', ' nuovo')));
  if (p.name && !existing) chips.push(h('span.pv', p.name));
  if (p.category && !existing) {
    const known = D?.items.some(i => i.category.toLowerCase() === p.category.toLowerCase());
    chips.push(h('span.pv', icon('box'), p.category, !known && h('i', ' nuova')));
  }
  if (p.project) {
    const known = D?.projectByTag.has(p.project.toLowerCase());
    chips.push(h('span.pv.tag', { class: known ? null : 'warn', style: tagStyle(p.project) }, `@${p.project}`, !known && h('i', ' inesistente')));
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
    chips.push(h('span.pv', 'dentro'), h('span.pv.tag', { class: known ? null : 'warn', style: tagStyle(p.parent) }, `@${p.parent}`, !known && h('i', ' inesistente')));
  }
  if (p.name) chips.push(...shareChips(p.share.filter(n => n !== 'all'), p.share.includes('all'), null));
  return chips;
}

// Con chi sarà condivisa: "solo tu", le persone (+, ++ = assegnata), "tutti". Nomi sconosciuti in giallo.
function shareChips(names, all, assignee) {
  const D = S.data;
  const known = n => D?.members.some(u => [u.username, u.name].some(x => x?.toLowerCase() === n.toLowerCase()));
  const chips = names.map(n => h('span.pv', { class: known(n) ? null : 'warn', title: known(n) ? null : 'Nessuno con questo nome nel workspace' },
    icon('user'), n, assignee && n.toLowerCase() === assignee.toLowerCase() && h('i', ' assegnata'), !known(n) && h('i', ' ?')));
  if (all) chips.push(h('span.pv', icon('users'), 'tutti'));
  if (!names.length && !all) chips.push(h('span.pv.muted', icon('lock'), 'solo tu'));
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
    if (p.kind !== 'todo' || p.kindExplicit) chips.push(h('span.kpill', { class: `k-${p.kind}` }, { todo: 'todo', mail: 'mail', note: 'nota' }[p.kind]));
    if (p.due === null) chips.push(h('span.pv', 'senza scadenza'));
    else if (p.due) { const d = dueInfo(p.due); chips.push(h('span.pv.due', { class: d.cls || null }, icon('cal'), d.label)); }
    if (p.project) chips.push(h('span.pv.tag', { style: tagStyle(p.project) }, `@${p.project}`, !D?.projectByTag.has(p.project.toLowerCase()) && h('i', ' nuovo')));
    for (const c of p.codes) chips.push(h('span.pv.code', c, !D?.itemByCode.has(c.toUpperCase()) && h('i', ' nuovo')));
    chips.push(...shareChips(p.shares, p.shareAll, p.assignee));
    if (p.contact) chips.push(h('span.pv', `→ ${p.contact}`));
  }
  quickInput.placeholder = {
    item: 'Nuovo articolo… es. SCH-060 scheda relè /scheda @rover',
    project: 'Nuovo progetto… es. Firmware motori @rover',
    mail: 'Mail da mandare… es. offerta 50 schede >acquisti@ditta.it !ven',
    note: 'Cosa è successo… es. la rev B vuole fw ≥ 2.3 #SCH-042',
  }[ctx.mode || ctx.kind] || 'Scrivi… es. flash fw #SCH-042 @rover !ven';
  quickCtx.textContent = ctx.label || '';
  quickCtx.hidden = !ctx.label;
  quickPreview.replaceChildren(...chips);
}

const projectByTag = tag => S.data.projectByTag.get(tag.toLowerCase());
const openAction = hash => ({ label: 'Apri', fn: () => { location.hash = hash; } });

async function submitItem(text) {
  const p = parseItemLine(text);
  if (!p.valid) return toast('Codice non valido: lettere, numeri e . _ - /', { err: true });
  const proj = p.project && projectByTag(p.project);
  if (p.project && !proj) return toast(`Il progetto @${p.project} non esiste`, { err: true });
  const existing = S.data.itemByCode.get(p.code.toUpperCase());
  quickInput.value = '';
  renderPreview();
  if (existing) {
    if (proj) await act(() => api('POST', `/projects/${proj.id}/items`, { code: existing.code }));
    location.hash = `#/i/${existing.id}`;
    return;
  }
  const r = await act(() => api('POST', '/items', { code: p.code, name: p.name, category: p.category || '', project_id: proj?.id }));
  if (r) toast(`${p.code} aggiunto`, { action: openAction(`#/i/${r.id}`) });
  else { quickInput.value = text; renderPreview(); }
}

async function submitProject(text) {
  const p = parseProjectLine(text);
  if (!p.name) return toast('Scrivi il nome del progetto', { err: true });
  const parent = p.parent && projectByTag(p.parent);
  if (p.parent && !parent) return toast(`Il progetto @${p.parent} non esiste`, { err: true });
  quickInput.value = '';
  renderPreview();
  const r = await act(() => api('POST', '/projects', { name: p.name, parent_id: parent?.id, share: p.share }));
  if (r) toast(`@${r.tag} creato`, { action: openAction(`#/p/${r.id}`) });
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

// ---------- guscio ----------
const searchInput = h('input#search', {
  type: 'search', placeholder: 'Cerca', autocomplete: 'off', spellcheck: 'false',
  oninput: () => {
    ui.q = searchInput.value;
    ui.archive = null;
    if (route().name !== 'cerca') location.hash = '#/cerca';
    else render();
  },
  onkeydown: ev => { if (ev.key === 'Escape') { searchInput.value = ''; ui.q = ''; searchInput.blur(); history.back(); } },
  // Su telefono "Cerca" apre la barra comandi (da lì "Cerca ovunque" porta qui); nella pagina Cerca si scrive qui.
  onfocus: () => {
    if (matchMedia('(max-width: 899px)').matches && route().name !== 'cerca') {
      searchInput.blur();
      openPalette();
    }
  },
});

// "Cerca ovunque" dalla barra comandi: la pagina Cerca con quelle parole.
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
        // Gruppi separati da un divisore leggero; Diario, Documenti e Contatti stanno sotto la voce a cui si legano.
        h('nav.side-nav', SIDE.map(group => h('div.nav-group',
          group.map(([k, l, i, sub]) => navLink(k, l, i, navLinks, sub ? 'nav.sub' : 'nav'))))),
        // In fondo alla barra: Cestino, Impostazioni, le novità della versione (il changelog, con "nuovo" finché
        // non si leggono) e Feedback per segnalare un errore o un'idea a chi sviluppa l'app.
        h('div.side-foot', navLink('cestino', 'Cestino', 'trash', navLinks, 'nav'),
          navLink('impostazioni', 'Impostazioni', 'settings', navLinks, 'nav'),
          navLink('novita', 'Novità', 'news', navLinks, 'nav'),
          h('button.nav.fb-btn', { type: 'button', onclick: openFeedback, title: 'Segnala un errore o un\'idea, anche con screenshot' }, icon('bug'), h('span.nl', 'Feedback')))),
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
            h('button.icon-btn', { title: 'Sintassi', type: 'button', onclick: () => { quickHelp.hidden = !quickHelp.hidden; } }, icon('help'))),
          quickPreview, quickHelp),
        viewEl),
      // Telefono: un tasto per gruppo, le altre pagine dal menu radiale (pressione lunga), vedi tabbar.js.
      tabbar({ allowed: k => !S.data || pageAllowed(k), action: k => { if (k === 'feedback') openFeedback(); } })),
    h('div#toasts'));
  shellBuilt = true;
  // La barra rapida si ferma subito sotto l'intestazione, alta quanto è davvero (cambia con caratteri, zoom e
  // notch): con un'altezza fissa restava una fessura da cui si vedeva la pagina scorrere.
  const top = root.querySelector('.top');
  const topH = () => document.documentElement.style.setProperty('--top-h', `${top.getBoundingClientRect().height}px`);
  topH();
  new ResizeObserver(topH).observe(top);
}

function updateStatus() {
  const pending = S.outbox.length;
  let cls; let title;
  if (!S.online) { cls = 'off'; title = navigator.onLine ? 'Server non raggiungibile' : 'Offline'; }
  else if (S.live) { cls = 'live'; title = 'Sincronizzato in tempo reale'; }
  else { cls = 'wait'; title = 'Riconnessione…'; }
  statusDot.className = `status ${cls}`;
  statusDot.title = pending ? `${title} — ${pending} in coda` : title;
  statusDot.textContent = pending ? String(pending) : '';
}

let tabBadges = {}; // segnalini per pagina, per la barra in basso

function updateBadges() {
  const D = S.data;
  if (!D) return;
  updateBell();
  const open = D.entries.filter(e => !e.done_at && e.kind !== 'note');
  const urgent = open.filter(e => e.due && dayDiff(e.due) <= 0 && isMine(e)).length;
  // Mail: da mandare più i thread con messaggi da leggere.
  const mails = open.filter(e => e.kind === 'mail').length
    + D.mailThreads.filter(t => (D.msgsOfThread.get(t.id) || []).some(m => m.direction === 'in' && !m.read_at)).length;
  navLinks.get('agenda').badge.textContent = urgent || '';
  navLinks.get('mail').badge.textContent = mails || '';
  navLinks.get('cestino').badge.textContent = D.trashCount || '';
  const news = navLinks.get('novita');
  news.badge.textContent = hasNews() ? 'nuovo' : '';
  news.a.title = appVersion() ? `Novità · versione ${appVersion()}` : 'Novità';
  const unread = D.chatUnread > 99 ? '99+' : D.chatUnread || '';
  navLinks.get('chat').badge.textContent = unread;
  navLinks.get('cestino').badge.classList.add('muted-badge');
  tabBadges = { agenda: urgent || '', mail: mails || '', chat: unread, novita: hasNews() ? 'nuovo' : '' };
}

// ---------- workspace ----------
const wsLabel = h('span.ws-name');
const wsMenu = h('div.ws-menu', { hidden: true });
const wsSwitch = h('div.ws-switch',
  h('button.ws-btn', { title: 'Cambia workspace', onclick: () => { wsMenu.hidden = !wsMenu.hidden; renderWsMenu(); } }, icon('folder'), wsLabel, h('span.caret', '▾')),
  wsMenu);
document.addEventListener('click', ev => { if (!wsSwitch.contains(ev.target)) wsMenu.hidden = true; });

function renderWsMenu() {
  const D = S.data;
  if (!D?.workspace) return;
  wsMenu.replaceChildren(
    ...D.workspaces.map(w => h('button.ws-item', {
      class: w.id === D.workspace.id ? 'on' : null,
      onclick: () => { if (w.id !== D.workspace.id) switchWorkspace(w.id); },
    }, h('span', w.name), h('span.muted', w.tour ? 'di prova' : w.role === 'admin' ? 'admin' : 'membro'))),
    h('button.ws-item.new', { onclick: newWorkspace }, icon('plus'), 'Nuovo workspace'));
}

// Account senza workspace (tolto da tutti): si crea il proprio o si aspetta un invito.
function viewNoWorkspace() {
  return h('div.empty.no-ws',
    h('p', h('b', 'Non fai parte di nessun workspace.')),
    h('p', 'Creane uno (ne sarai admin) oppure apri il link di un invito.'),
    h('button.btn.primary', { onclick: newWorkspace }, icon('plus'), 'Crea un workspace'));
}

// Invito aperto da chi è già collegato: si entra nel workspace con il proprio account.
function viewJoin(code) {
  const box = h('div.auth-card', h('p.muted', 'Controllo l\'invito…'));
  api('GET', `/invites/${encodeURIComponent(code)}`).then(r => {
    box.replaceChildren(
      h('h2', `Entra in "${r.workspace}"`),
      h('p.muted', `Sei collegato come ${S.me.username}: il workspace si aggiungerà ai tuoi.`),
      h('button.btn.primary', {
        onclick: () => act(async () => {
          await api('POST', `/invites/${encodeURIComponent(code)}/accept`);
          clearLocal();
          location.hash = '#/agenda';
          location.reload();
        }),
      }, 'Entra nel workspace'),
      h('a.muted', { href: '#/agenda' }, 'Non ora'));
  }).catch(e => box.replaceChildren(h('h2', 'Invito non valido'), h('p.muted', e.message), h('a', { href: '#/agenda' }, 'Torna all\'app')));
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
  // Le aree che non si possono leggere spariscono dal menu (e dalla barra in basso, che si stringe).
  if (S.data) for (const [k, { a }] of navLinks) a.hidden = !pageAllowed(k);
  for (const [k, { a }] of navLinks) a.classList.toggle('on', k === v.nav);
  titleEl.textContent = v.title;
  wsLabel.textContent = S.data?.workspace?.name || (S.noWorkspace ? 'Nessun workspace' : '…');
  if (!wsMenu.hidden) renderWsMenu();
  document.title = `${v.title} · Organizer`;
  if (r.name !== 'cerca' && document.activeElement !== searchInput && searchInput.value) { searchInput.value = ''; ui.q = ''; }
  renderPreview();
  updateStatus();
  updateBadges();
  updateTabbar(v.nav, tabBadges);

  // Ricostruisce la vista mantenendo focus, testo e cursore del campo in modifica.
  const a = document.activeElement;
  const keep = a && viewEl.contains(a) && a.dataset.fk
    ? { fk: a.dataset.fk, value: a.value, s: a.selectionStart, e: a.selectionEnd } : null;
  RS.busy = true;
  try {
    viewEl.replaceChildren(
      r.name === 'registrati' && r.query.code ? viewJoin(r.query.code)
        : S.noWorkspace ? viewNoWorkspace()
          : !S.data ? h('div.empty', 'Caricamento…')
            : pageAllowed(r.name) ? v.fn(r.id, r.query) : noAccess());
    document.body.classList.toggle('doc-page', !!S.data && (r.name === 'd' || r.name === 'review' || r.name === 'allegato'));
    document.body.classList.toggle('chat-page', !!S.data && r.name === 'chat');
    // Pagine senza la barra rapida in alto (lì non c'è niente da aggiungere).
    document.body.classList.toggle('no-quick', r.name === 'novita' || r.name === 't' || r.name === 'allegato' || (!!S.data && !quickAllowed(quickContext())));
  } catch (e) {
    console.error(e);
    viewEl.replaceChildren(h('div.empty', `Errore di visualizzazione: ${e.message}`));
  } finally {
    RS.busy = false;
  }
  // Offline tutta la pagina è in sola lettura, tranne le voci in coda (.rw) e i filtri.
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

// ---------- accesso ----------
function renderAuth() {
  shellBuilt = false;
  const r = route();
  const code = r.query.code || '';
  const mode = S.setup ? 'setup' : r.name === 'registrati' && !r.query.login ? 'register' : 'login';
  const titles = { setup: 'Primo avvio: crea il tuo account', register: 'Registrati con un invito', login: code ? 'Accedi ed entra nel workspace' : 'Accedi' };
  const inviteInfo = h('p.muted');
  if (code) api('GET', `/invites/${encodeURIComponent(code)}`).then(i => { inviteInfo.textContent = `Invito per il workspace "${i.workspace}".`; }).catch(e => { inviteInfo.textContent = e.message; });
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
  mode === 'register' && h('label.f', h('span', 'Codice invito'), h('input', { name: 'code', value: code, required: true, autocapitalize: 'characters' })),
  mode === 'login' && code && h('input', { type: 'hidden', name: 'code', value: code }),
  mode === 'setup' && h('label.f', h('span', 'Nome del workspace'), h('input', { name: 'workspace', placeholder: 'es. Laboratorio, Lavoro, Casa' })),
  h('label.f', h('span', 'Username'), h('input', { name: 'username', required: true, autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off' })),
  mode !== 'login' && h('label.f', h('span', 'Nome'), h('input', { name: 'name', autocomplete: 'name', placeholder: 'come ti vedono gli altri' })),
  h('label.f', h('span', 'Password'), h('input', { name: 'password', type: 'password', required: true, minlength: mode === 'login' ? null : 8, autocomplete: mode === 'login' ? 'current-password' : 'new-password' })),
  err,
  h('button.btn.primary', { type: 'submit' }, mode === 'login' ? 'Entra' : 'Crea account'),
  mode === 'login' && h('p.muted', 'Hai un invito? ', h('a', { href: '#/registrati' }, 'Registrati')),
  mode === 'register' && h('p.muted', 'Hai già un account? ', h('a', { href: `#/registrati?code=${encodeURIComponent(code)}&login=1` }, 'Accedi ed entra nel workspace')));
  root.replaceChildren(h('div.auth', form), h('div#toasts'));
}

async function logout() {
  if (S.outbox.length && !confirm(`Ci sono ${S.outbox.length} voci in coda offline che andranno perse. Uscire?`)) return;
  try { await api('POST', '/logout'); } catch { /* offline: si esce comunque in locale */ }
  disconnectLive();
  clearLocal();
  S.outbox = [];
  save('org.outbox', []);
  S.me = null;
  location.hash = '#/';
  render();
}

// ---------- versione nuova ----------
// La versione con cui si è aperta l'app è quella del codice caricato: se il server ne ha una diversa (aggiornato
// mentre l'app era aperta), compare l'avviso con "Ricarica". Si controlla quando il tempo reale si riconnette
// (a ogni aggiornamento il server riparte), quando l'app torna in primo piano e ogni 30 minuti.
let loadedVersion = null;
const updateText = h('span');
// Offline: cosa si può fare (e cosa aspetta in coda).
const offlineText = h('span');
const offlineBar = h('div.update-bar.offline-bar', { hidden: true, role: 'status' }, icon('wait'), offlineText);
function updateOfflineBar() {
  offlineBar.hidden = S.online;
  const n = S.outbox.length;
  // Rete del dispositivo presente: è il server che non risponde (di solito sta ripartendo dopo un aggiornamento).
  const why = navigator.onLine ? 'Il server non risponde (se si sta aggiornando torna da solo tra pochi secondi)' : 'Sei offline';
  offlineText.textContent = `${why}: puoi leggere tutto e aggiungere todo in Agenda e note nel Diario${n ? ` (${n} in coda, partono appena torna la rete)` : ''}. Il resto si modifica quando torni online.`;
}

const updateBar = h('div.update-bar', { hidden: true, role: 'status' },
  icon('news'), updateText, h('span.grow'),
  h('a.btn.sm.ghost', { href: '#/novita' }, 'Novità'),
  h('button.btn.sm.primary', { onclick: reloadApp }, icon('restore'), 'Ricarica'));

async function reloadApp() {
  try {
    await (await navigator.serviceWorker?.getRegistration())?.update();
  } catch {
    // senza service worker basta ricaricare
  }
  location.reload();
}

function checkVersion() {
  return api('GET', '/info').then(i => {
    const first = S.version == null;
    S.version = i.version;
    loadedVersion ??= i.version;
    updateBar.hidden = i.version === loadedVersion;
    updateText.textContent = `È disponibile Organizer ${i.version} (stai usando la ${loadedVersion}).`;
    if (first) render(); // per la pagina Novità e il suo "nuovo" nella barra
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

// ---------- avvio ----------
setRenderer(renderApp, updateStatus);
initAutocomplete(() => { const c = quickContext(); return c.mode || c.kind; });
applyTheme(currentTheme());
applyIcon(currentTheme()); // icona della scheda e dell'installazione (vedi appicons.js)
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
window.addEventListener('org:logout', logout);
window.addEventListener('org:data', ev => notifyNew(ev.detail.prev, ev.detail.data));
// Altre viste chiedono di precompilare la barra rapida (es. "Nuova mail" da un contatto).
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
  render(); // le etichette "oggi/domani" cambiano a mezzanotte
});
document.addEventListener('keydown', ev => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName);
  // ⌘F (Ctrl+F) in un documento cerca nel documento; altrove resta la ricerca del browser.
  if ((/Mac|iPhone|iPad/.test(navigator.userAgent) ? ev.metaKey : ev.ctrlKey) && ev.key.toLowerCase() === 'f' && !ev.altKey && docSearchKey()) {
    ev.preventDefault();
  } else if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ['k', 'p'].includes(ev.key.toLowerCase())) {
    // Barra comandi (⌘P al posto di "Stampa").
    ev.preventDefault();
    openPalette();
  } else if (!inField && !ev.metaKey && !ev.ctrlKey && (ev.key === 'n' || ev.key === '/')) {
    ev.preventDefault();
    quickInput.focus();
  } else if (ev.key === 'Escape' && !ev.defaultPrevented) {
    goUp(inField ? ev.target : null);
  }
});

// Esc: esce dal campo; fuori dai campi chiude le voci aperte, poi risale alla lista (progetto → Progetti…).
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
  // Clic su una notifica con l'app già aperta (dove il service worker non può navigare da sé).
  navigator.serviceWorker.addEventListener('message', ev => { if (ev.data?.open) location.href = ev.data.open; });
}

(async function boot() {
  loadCache();
  if (S.me) render(); // apertura istantanea dai dati in cache, poi si aggiorna
  try {
    const r = await api('GET', '/me');
    S.setup = r.setup;
    if (!r.user) {
      S.me = null;
      clearLocal();
      return render();
    }
    S.me = r.user;
    // La cache locale è di un workspace: se nel frattempo è cambiato (altra scheda, altro dispositivo) non vale.
    if (S.data && S.data.workspace?.id !== r.workspace?.id) {
      clearLocal();
      S.data = null;
    }
    start();
  } catch {
    if (S.me) {
      toast('Offline: stai vedendo gli ultimi dati sincronizzati');
      renderStatus();
      connectLive();
    } else {
      root.replaceChildren(h('div.auth', h('div.auth-card', h('h2', 'Server non raggiungibile'), h('p.muted', 'Controlla la connessione e riprova.'),
        h('button.btn.primary', { onclick: () => location.reload() }, 'Riprova'))));
    }
  }
})();
