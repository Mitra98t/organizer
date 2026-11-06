// Command bar (⌘K or ⌘P, Ctrl on Windows/Linux; on a phone by tapping "Search"): type a few words and open on the
// fly a page, an entry, a mail conversation, an item, a document, a project or a contact. The search is the same as
// "[[" (several words, each in any field, also in the full text of mails); at the bottom "Search everywhere" leads
// to the Search page with the same words. ↑↓ to choose, Enter to open.
import { h, icon, S, can } from './core.js';
import { findAll, askMailSearch, scoreWords, PILL, fitPills } from './autocomplete.js';
import { tr } from './i18n.js';

const lc = s => String(s ?? '').toLowerCase();

const PAGES = [
  ['progetti', tr('Projects'), 'folder', () => can('progetti')],
  ['agenda', tr('Agenda'), 'agenda', () => can('voci') || can('mail')],
  ['diario', tr('Journal'), 'diary', () => can('voci')],
  ['magazzino', tr('Inventory'), 'box', () => can('magazzino')],
  ['documenti', tr('Documents'), 'file', () => can('documenti')],
  ['mail', tr('Mail'), 'mail', () => can('mail')],
  ['contatti', tr('Contacts'), 'contacts', () => can('contatti')],
  ['chat', tr('Chat'), 'chat', () => can('chat')],
  ['cestino', tr('Trash'), 'trash'],
  ['impostazioni', tr('Settings'), 'settings'],
  ['impostazioni/notifiche', `${tr('Settings')} · ${tr('Notifications')}`, 'bell'],
  ['impostazioni/mail', `${tr('Settings')} · ${tr('Mail and Thunderbird')}`, 'mail'],
  ['impostazioni/workspace', `${tr('Settings')} · ${tr('Workspace and people')}`, 'users'],
  ['impostazioni/app', `${tr('Settings')} · ${tr('App and help')}`, 'help'],
  ['novita', tr('What\'s new'), 'news'],
];

let dialog = null;
let st = null; // { q, items, index }
let onSearch = () => {};

export function initPalette(searchAll) {
  onSearch = searchAll;
}

function results(q) {
  const ql = lc(q.trim());
  const words = ql.split(/\s+/).filter(Boolean);
  const pages = PAGES.filter(([, , , ok]) => !ok || ok())
    .map(([key, label, ic]) => ({ href: `#/${key}`, label, icon: ic, pill: 'page', r: ql ? scoreWords(words, [[label], [tr('page'), 1]]) : null }))
    .filter(p => p.r != null);
  const found = S.data ? findAll(ql, { limit: 14 }) : [];
  const list = ql ? [...pages, ...found].sort((a, b) => a.r - b.r).slice(0, 14) : found.slice(0, 10);
  if (ql) list.push({ search: q.trim(), label: tr('Search everywhere "{q}"', { q: q.trim() }), icon: 'search' });
  return list;
}

export function openPalette(q = '') {
  if (!S.data) return;
  if (!dialog) {
    const input = h('input.pal-in', {
      type: 'text', placeholder: tr('Open… (pages, entries, mails, items, documents, projects, contacts)'), autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'go',
      oninput: () => update(input.value),
      onkeydown: ev => {
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          const n = st.items.length;
          st.index = (st.index + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
          draw();
        } else if (ev.key === 'Enter' && !ev.isComposing) {
          ev.preventDefault();
          choose(st.items[st.index]);
        }
      },
    });
    dialog = h('dialog.pal', { 'aria-label': tr('Command bar'), onclose: () => { st = null; } },
      h('div.pal-box', h('div.pal-h', icon('search'), input, h('span.pal-k', navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl K')), h('div.pal-list', { role: 'listbox' })));
    dialog.addEventListener('click', ev => { if (ev.target === dialog) dialog.close(); }); // outside the box
    document.body.append(dialog);
  }
  const input = dialog.querySelector('.pal-in');
  input.value = q;
  if (!dialog.open) dialog.showModal();
  update(q);
  input.focus();
  input.select();
}

function update(q) {
  st = { q, items: results(q), index: 0 };
  draw();
  const ql = lc(q.trim());
  askMailSearch(ql, () => { if (dialog?.open && st?.q === q) { st.items = results(q); draw(); } });
}

function draw() {
  const list = dialog.querySelector('.pal-list');
  list.replaceChildren(...st.items.map((it, i) => h('button.pal-i', {
    type: 'button', role: 'option', class: i === st.index ? 'on' : null, 'aria-selected': String(i === st.index),
    onmousemove: () => { if (st.index !== i) { st.index = i; draw(); } },
    onclick: () => choose(it),
  },
  it.icon ? h('span.pal-ic', icon(it.icon)) : it.pill && h('span.ac-k', { class: `t-${it.pill}` }, PILL[it.pill]),
  h('span.pal-m',
    h('span.pal-r', h('span.pal-l', it.code ? h('span.code', it.label) : it.label), it.hint && h('span.pal-hint', it.hint)),
    it.sub && h('span.pal-sub', it.sub)),
  it.extra && h('span.pal-x', it.extra))));
  if (!st.items.length) list.append(h('p.muted.pal-empty', tr('Type a few words: part of the title, a person, a code…')));
  fitPills(list);
  list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}

function choose(it) {
  if (!it) return;
  dialog.close();
  if (it.search != null) return onSearch(it.search);
  location.hash = it.href;
}
