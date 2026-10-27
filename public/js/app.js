import {
  h, icon, S, ui, RS, api, sync, setRenderer, render, renderStatus, connectLive, disconnectLive, liveClosed,
  flushOutbox, addEntry, loadCache, clearLocal, dueInfo, autosize, toast, isMine, dayDiff, save,
} from './core.js';
import { parseQuick, extractCodes, today } from './parse.js';
import {
  viewAgenda, viewProjects, viewProject, viewMail, viewDiary, viewItems, viewItem, viewSearch, viewSettings,
} from './views.js';

const root = document.getElementById('root');

const VIEWS = {
  agenda: { fn: viewAgenda, title: 'Agenda', nav: 'agenda' },
  progetti: { fn: viewProjects, title: 'Progetti', nav: 'progetti' },
  p: { fn: viewProject, title: 'Progetto', nav: 'progetti' },
  mail: { fn: viewMail, title: 'Mail', nav: 'mail' },
  diario: { fn: viewDiary, title: 'Diario', nav: 'diario' },
  magazzino: { fn: viewItems, title: 'Magazzino', nav: 'magazzino' },
  i: { fn: viewItem, title: 'Articolo', nav: 'magazzino' },
  cerca: { fn: viewSearch, title: 'Cerca', nav: null },
  impostazioni: { fn: viewSettings, title: 'Impostazioni', nav: 'impostazioni' },
};

const NAV = [
  ['agenda', 'Agenda', 'agenda'],
  ['progetti', 'Progetti', 'folder'],
  ['mail', 'Mail', 'mail'],
  ['diario', 'Diario', 'diary'],
  ['magazzino', 'Magazzino', 'box'],
];

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
  return {};
}

const quickInput = h('input#quick', {
  placeholder: 'Scrivi… es. flash fw #SCH-042 @rover !ven',
  autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'done',
  oninput: () => renderPreview(),
  onkeydown: ev => {
    if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); submitQuick(); }
    if (ev.key === 'Escape') quickInput.blur();
  },
});
const quickPreview = h('div.preview');
const quickCtx = h('span.ctx');
const quickHelp = h('div.qhelp', { hidden: true },
  h('span', h('code.k', 't: m: n:'), ' tipo'),
  h('span', h('code.k', '!ven !3g !25/11'), ' scadenza'),
  h('span', h('code.k', '@progetto')),
  h('span', h('code.k', '#CODICE'), ' magazzino'),
  h('span', h('code.k', '+utente')),
  h('span', h('code.k', '>destinatario')));

function renderPreview() {
  const ctx = quickContext();
  const text = quickInput.value;
  const chips = [];
  if (text.trim()) {
    const p = parseQuick(text, { today: today(), kind: ctx.kind || 'todo' });
    const D = S.data;
    if (p.kind !== 'todo' || p.kindExplicit) chips.push(h('span.pv.kind', { class: `k-${p.kind}` }, { todo: 'todo', mail: 'mail', note: 'nota' }[p.kind]));
    if (p.due === null) chips.push(h('span.pv', 'senza scadenza'));
    else if (p.due) { const d = dueInfo(p.due); chips.push(h('span.pv.due', { class: d.cls || null }, icon('cal'), d.label)); }
    if (p.project) chips.push(h('span.pv.tag', `@${p.project}`, !D?.projectByTag.has(p.project.toLowerCase()) && h('i', ' nuovo')));
    for (const c of p.codes) chips.push(h('span.pv.code', c, !D?.itemByCode.has(c.toUpperCase()) && h('i', ' nuovo')));
    if (p.assignee) {
      const known = D?.users.some(u => [u.username, u.name].some(n => n?.toLowerCase() === p.assignee.toLowerCase()));
      chips.push(h('span.pv', { class: known ? null : 'warn' }, `+${p.assignee}`, !known && h('i', ' ?')));
    }
    if (p.contact) chips.push(h('span.pv', `→ ${p.contact}`));
  }
  quickInput.placeholder = {
    mail: 'Mail da mandare… es. offerta 50 schede >acquisti@ditta.it !ven',
    note: 'Cosa è successo… es. la rev B vuole fw ≥ 2.3 #SCH-042',
  }[ctx.kind] || 'Scrivi… es. flash fw #SCH-042 @rover !ven';
  quickCtx.textContent = ctx.label || '';
  quickCtx.hidden = !ctx.label;
  quickPreview.replaceChildren(...chips);
}

async function submitQuick() {
  const ctx = quickContext();
  let text = quickInput.value.trim();
  if (!text) return;
  if (ctx.code && !extractCodes(text).some(c => c.toUpperCase() === ctx.code.toUpperCase())) text += ` #${ctx.code}`;
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
});

const statusDot = h('span.status');
const titleEl = h('h1.vtitle');
const viewEl = h('div#view');
const navLinks = new Map();
const tabLinks = new Map();
let shellBuilt = false;

function navLink(key, label, ic, map, cls) {
  const badge = h('span.nbadge');
  const a = h(`a.${cls}`, { href: `#/${key}` }, icon(ic), h('span.nl', label), badge);
  map.set(key, { a, badge });
  return a;
}

function buildShell() {
  navLinks.clear();
  tabLinks.clear();
  root.replaceChildren(
    h('div.app',
      h('aside.side',
        h('div.brand', h('img', { src: 'icons/icon.svg', alt: '' }), h('span', 'Organizer')),
        h('nav.side-nav', NAV.map(([k, l, i]) => navLink(k, l, i, navLinks, 'nav')),
          h('span.sep'), navLink('impostazioni', 'Impostazioni', 'settings', navLinks, 'nav'))),
      h('main.main',
        h('header.top',
          titleEl,
          h('label.search', icon('search'), searchInput),
          statusDot,
          h('a.icon-btn.only-mobile', { href: '#/impostazioni', title: 'Impostazioni' }, icon('settings'))),
        h('div.quick',
          h('div.qrow', icon('plus', 'qplus'), quickInput, quickCtx,
            h('button.icon-btn', { title: 'Sintassi', type: 'button', onclick: () => { quickHelp.hidden = !quickHelp.hidden; } }, icon('help'))),
          quickPreview, quickHelp),
        viewEl),
      h('nav.tabs', NAV.map(([k, l, i]) => navLink(k, l, i, tabLinks, 'tab')))),
    h('div#toasts'));
  shellBuilt = true;
}

function updateStatus() {
  const pending = S.outbox.length;
  let cls; let title;
  if (!S.online) { cls = 'off'; title = 'Offline'; }
  else if (S.live) { cls = 'live'; title = 'Sincronizzato in tempo reale'; }
  else { cls = 'wait'; title = 'Riconnessione…'; }
  statusDot.className = `status ${cls}`;
  statusDot.title = pending ? `${title} — ${pending} in coda` : title;
  statusDot.textContent = pending ? String(pending) : '';
}

function updateBadges() {
  const D = S.data;
  if (!D) return;
  const open = D.entries.filter(e => !e.done_at && e.kind !== 'note');
  const urgent = open.filter(e => e.due && dayDiff(e.due) <= 0 && isMine(e)).length;
  const mails = open.filter(e => e.kind === 'mail').length;
  for (const map of [navLinks, tabLinks]) {
    map.get('agenda').badge.textContent = urgent || '';
    map.get('mail').badge.textContent = mails || '';
  }
}

function renderApp() {
  if (!S.me) return renderAuth();
  if (!shellBuilt) buildShell();
  const r = route();
  const v = VIEWS[r.name] || VIEWS.agenda;
  for (const map of [navLinks, tabLinks]) for (const [k, { a }] of map) a.classList.toggle('on', k === v.nav);
  titleEl.textContent = v.title;
  document.title = `${v.title} · Organizer`;
  if (r.name !== 'cerca' && document.activeElement !== searchInput && searchInput.value) { searchInput.value = ''; ui.q = ''; }
  renderPreview();
  updateStatus();
  updateBadges();

  // Ricostruisce la vista mantenendo focus, testo e cursore del campo in modifica.
  const a = document.activeElement;
  const keep = a && viewEl.contains(a) && a.dataset.fk
    ? { fk: a.dataset.fk, value: a.value, s: a.selectionStart, e: a.selectionEnd } : null;
  RS.busy = true;
  try {
    viewEl.replaceChildren(S.data ? v.fn(r.id) : h('div.empty', 'Caricamento…'));
  } catch (e) {
    console.error(e);
    viewEl.replaceChildren(h('div.empty', `Errore di visualizzazione: ${e.message}`));
  } finally {
    RS.busy = false;
  }
  viewEl.querySelectorAll('textarea').forEach(autosize);
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
  const mode = S.setup ? 'setup' : r.name === 'registrati' ? 'register' : 'login';
  const titles = { setup: 'Primo avvio: crea l\'amministratore', register: 'Registrati con un invito', login: 'Accedi' };
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
        if (mode === 'register') location.hash = '#/agenda';
        start();
      } catch (e) {
        err.textContent = e.message;
      }
    },
  },
  h('div.brand', h('img', { src: 'icons/icon.svg', alt: '' }), h('span', 'Organizer')),
  h('h2', titles[mode]),
  mode === 'register' && h('label.f', h('span', 'Codice invito'), h('input', { name: 'code', value: r.query.code || '', required: true, autocapitalize: 'characters' })),
  h('label.f', h('span', 'Username'), h('input', { name: 'username', required: true, autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off' })),
  mode !== 'login' && h('label.f', h('span', 'Nome'), h('input', { name: 'name', autocomplete: 'name', placeholder: 'come ti vedono gli altri' })),
  h('label.f', h('span', 'Password'), h('input', { name: 'password', type: 'password', required: true, minlength: mode === 'login' ? null : 8, autocomplete: mode === 'login' ? 'current-password' : 'new-password' })),
  err,
  h('button.btn.primary', { type: 'submit' }, mode === 'login' ? 'Entra' : 'Crea account'),
  mode === 'login' && h('p.muted', 'Hai un invito? ', h('a', { href: '#/registrati' }, 'Registrati')),
  mode === 'register' && h('p.muted', h('a', { href: '#/' }, 'Ho già un account')));
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

function start() {
  render();
  sync();
  connectLive();
  flushOutbox();
}

// ---------- avvio ----------
setRenderer(renderApp, updateStatus);
document.documentElement.dataset.theme = localStorage.getItem('org.theme') || 'auto';
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
window.addEventListener('org:logout', logout);
window.addEventListener('online', () => { S.online = true; flushOutbox(); sync(); if (liveClosed()) connectLive(); renderStatus(); });
window.addEventListener('offline', () => { S.online = false; S.live = false; renderStatus(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.me) return;
  sync();
  if (liveClosed()) connectLive();
  render(); // le etichette "oggi/domani" cambiano a mezzanotte
});
document.addEventListener('keydown', ev => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName);
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
    ev.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (!inField && !ev.metaKey && !ev.ctrlKey && (ev.key === 'n' || ev.key === '/')) {
    ev.preventDefault();
    quickInput.focus();
  }
});

if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});

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
