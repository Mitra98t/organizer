// Right-click menu: on an inventory code, an entry, a project, a document, a contact or a mail conversation,
// the quick things (copy the code, the title, the link; open). Where there is nothing of the app under the mouse,
// in fields, on selected text or with Shift held down the browser's own menu stays.
import { S, tr, copy, docName, popAt, popItem, popSep } from './core.js';
import { hidePeek } from './views.js';

const appUrl = hash => `${location.origin}${location.pathname}${hash}`;
const short = s => (s.length > 30 ? `${s.slice(0, 29)}…` : s);

// What is under the mouse: { kind, x, href } or null.
function targetOf(el) {
  const D = S.data;
  const code = el.closest('.code');
  if (code) {
    const text = code.textContent.trim();
    const it = D.itemByCode.get(text.toUpperCase());
    if (it) return { kind: 'item', x: it, href: `#/i/${it.id}` };
    const p = text.startsWith('@') && D.projectByTag.get(text.slice(1).toLowerCase());
    if (p) return { kind: 'project', x: p, href: `#/p/${p.id}` };
  }
  const a = el.closest('a[href^="#/"]');
  const m = a?.getAttribute('href').match(/^#\/([a-z]+)\/(\d+)(?:\?th=(\d+))?/);
  if (m) {
    const [href, name, id, th] = [m[0], m[1], +m[2], +m[3]];
    const x = {
      i: ['item', D.itemById], p: ['project', D.projectById], v: ['entry', D.entryById], d: ['doc', D.docById],
      contatti: ['contact', D.contactById], t: th ? ['thread', D.threadById] : ['topic', D.topicById],
    }[name];
    const found = x?.[1].get(th || id);
    if (found) return { kind: x[0], x: found, href };
  }
  const row = el.closest('.entry[data-eid]');
  const e = row && D.entryById.get(+row.dataset.eid);
  if (e) return { kind: 'entry', x: e, href: `#/v/${e.id}` };
  return null;
}

function content({ kind, x, href }, close) {
  const run = fn => () => { close(); fn(); };
  // "Copy …", with what gets copied on the right when it is short; nothing when there is nothing to copy.
  const c = (label, value) => value && popItem(label, run(() => copy(value)), { hint: String(value).length <= 20 ? String(value) : null });
  const head = {
    item: x.code, project: `@${x.tag}`, entry: x.title, doc: docName(x), contact: x.name || x.email,
    topic: x.title, thread: x.subject,
  }[kind];
  const rows = {
    item: () => [c(tr('Copy the code'), x.code), x.name && c(tr('Copy code and description'), `${x.code} ${x.name}`),
      c(tr('Copy the description'), x.name), c(tr('Copy the firmware version'), x.firmware), c(tr('Copy the position'), x.location)],
    project: () => [c(tr('Copy the tag'), `@${x.tag}`), c(tr('Copy the name'), x.name)],
    entry: () => [c(tr('Copy the title'), x.title)],
    doc: () => [c(tr('Copy the name'), docName(x))],
    contact: () => [c(tr('Copy the name'), x.name), c(tr('Copy the address'), x.email), c(tr('Copy the phone'), x.phone)],
    topic: () => [c(tr('Copy the title'), x.title)],
    thread: () => [c(tr('Copy the subject'), x.subject)],
  }[kind]();
  const here = location.hash.split('?')[0] === href.split('?')[0];
  return [
    head && popSep(short(head)),
    rows,
    c(tr('Copy the link'), appUrl(href)),
    !here && popSep(),
    !here && popItem(tr('Open'), run(() => { location.hash = href; })),
  ];
}

document.addEventListener('contextmenu', ev => {
  if (ev.defaultPrevented || ev.shiftKey || !S.data) return;
  const el = ev.target instanceof Element ? ev.target : ev.target.parentElement;
  if (!el || el.closest('input, textarea, select, [contenteditable], .popmenu')) return;
  if (String(window.getSelection?.() || '').trim()) return;
  const t = targetOf(el);
  if (!t) return;
  ev.preventDefault();
  hidePeek();
  // From the keyboard (menu key, Shift+F10) there is no point: under the element.
  let { clientX: x, clientY: y } = ev;
  if (!x && !y) { const r = el.getBoundingClientRect(); [x, y] = [r.left, r.bottom]; }
  popAt(x, y, close => content(t, close));
});
