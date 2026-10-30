// Barra comandi (⌘K o ⌘P, Ctrl su Windows/Linux; su telefono toccando "Cerca"): si scrive qualche parola e si apre al
// volo una pagina, una voce, una conversazione di mail, un articolo, un documento, un progetto o un contatto. La
// ricerca è la stessa di "[[" (più parole, ognuna in un campo qualsiasi, anche nel testo intero delle mail);
// in fondo "Cerca ovunque" porta alla pagina Cerca con le stesse parole. ↑↓ per scegliere, Invio per aprire.
import { h, icon, S, can } from './core.js';
import { findAll, askMailSearch, scoreWords, PILL, fitPills } from './autocomplete.js';

const lc = s => String(s ?? '').toLowerCase();

const PAGES = [
  ['progetti', 'Progetti', 'folder', () => can('progetti')],
  ['agenda', 'Agenda', 'agenda', () => can('voci') || can('mail')],
  ['diario', 'Diario', 'diary', () => can('voci')],
  ['magazzino', 'Magazzino', 'box', () => can('magazzino')],
  ['documenti', 'Documenti', 'file', () => can('documenti')],
  ['mail', 'Mail', 'mail', () => can('mail')],
  ['contatti', 'Contatti', 'contacts', () => can('contatti')],
  ['chat', 'Chat', 'chat', () => can('chat')],
  ['cestino', 'Cestino', 'trash'],
  ['impostazioni', 'Impostazioni', 'settings'],
  ['impostazioni/notifiche', 'Impostazioni · Notifiche', 'bell'],
  ['impostazioni/mail', 'Impostazioni · Mail e Thunderbird', 'mail'],
  ['impostazioni/workspace', 'Impostazioni · Workspace e persone', 'users'],
  ['impostazioni/app', 'Impostazioni · App e aiuto', 'help'],
  ['novita', 'Novità', 'news'],
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
    .map(([key, label, ic]) => ({ href: `#/${key}`, label, icon: ic, pill: 'page', r: ql ? scoreWords(words, [[label], ['pagina', 1]]) : null }))
    .filter(p => p.r != null);
  const found = S.data ? findAll(ql, { limit: 14 }) : [];
  const list = ql ? [...pages, ...found].sort((a, b) => a.r - b.r).slice(0, 14) : found.slice(0, 10);
  if (ql) list.push({ search: q.trim(), label: `Cerca ovunque "${q.trim()}"`, icon: 'search' });
  return list;
}

export function openPalette(q = '') {
  if (!S.data) return;
  if (!dialog) {
    const input = h('input.pal-in', {
      type: 'text', placeholder: 'Apri… (pagine, voci, mail, articoli, documenti, progetti, contatti)', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'go',
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
    dialog = h('dialog.pal', { 'aria-label': 'Barra comandi', onclose: () => { st = null; } },
      h('div.pal-box', h('div.pal-h', icon('search'), input, h('span.pal-k', navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl K')), h('div.pal-list', { role: 'listbox' })));
    dialog.addEventListener('click', ev => { if (ev.target === dialog) dialog.close(); }); // fuori dal riquadro
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
  if (!st.items.length) list.append(h('p.muted.pal-empty', 'Scrivi qualche parola: un pezzo del titolo, una persona, un codice…'));
  fitPills(list);
  list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}

function choose(it) {
  if (!it) return;
  dialog.close();
  if (it.search != null) return onSearch(it.search);
  location.hash = it.href;
}
