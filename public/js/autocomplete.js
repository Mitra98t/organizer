// Autocompletamento dei token (@progetto, #CODICE, !data, +utente, >destinatario) nei campi con data-ac.
// data-ac = tipo della voce ('todo' | 'mail' | 'note'), oppure 'auto' per la barra rapida
// (il tipo si ricava dal prefisso t:/m:/n: e dal contesto). data-ac-only limita i token accettati.
// data-ac="email": campo di indirizzi separati da virgola (A, Cc), suggerisce la rubrica senza simboli.
// data-ac="code" / "project": tutto il campo è un codice di magazzino / un progetto; scegliere un
// suggerimento conferma subito il campo (come premere Invio). data-ac-self esclude un codice.
// data-ac="company": tutto il campo è un'azienda già usata in rubrica; scegliendola il campo si salva.
// Nella barra in alto: modalità 'item' (/categoria, @progetto) e 'project' (@progetto padre).
// Un solo menu flottante per tutta l'app, agganciato al campo che ha il focus: sopravvive ai re-render.
import { h, S, fmtDay, hue, catStyle } from './core.js';
import { parseDate, parseQuick, today, fromYmd } from './parse.js';

const box = h('div.ac', { hidden: true, role: 'listbox' });
let st = null; // { el, start, end, items, index, token, suffix }
let contextKind = () => 'todo';

const lc = s => String(s ?? '').toLowerCase();
const DOW = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const FUTURE_DATES = ['oggi', 'domani', 'dopodomani', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom', '1s', '2s', '1m', 'fm', 'no'];
const PAST_DATES = ['oggi', 'ieri', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom', 'no'];
const STATUS = { paused: 'in pausa', closed: 'chiuso' };

export function initAutocomplete(getContextKind) {
  contextKind = getContextKind;
  document.body.append(box);
  document.addEventListener('input', ev => { if (ev.target.dataset?.ac) update(ev.target); });
  document.addEventListener('keyup', ev => {
    if (ev.target.dataset?.ac && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) update(ev.target);
  });
  document.addEventListener('keydown', onKey, true); // in cattura: prima dei gestori Invio dei campi
  document.addEventListener('focusout', ev => { if (st && ev.target === st.el) close(); });
  window.addEventListener('resize', () => st && place());
  window.addEventListener('scroll', ev => { if (st && !box.contains(ev.target)) place(); }, true);
  // Tocchi e clic sul menu non devono togliere il focus al campo.
  box.addEventListener('pointerdown', ev => ev.preventDefault());
  box.addEventListener('mousedown', ev => ev.preventDefault());
}

// Dopo un re-render il campo agganciato può essere stato sostituito.
export function acCheck() {
  if (st && !st.el.isConnected) close();
}

function close() {
  st = null;
  box.hidden = true;
}

function kindOf(el) {
  if (el.dataset.ac !== 'auto') return el.dataset.ac;
  return parseQuick(el.value, { kind: contextKind() || 'todo' }).kind;
}

function update(el) {
  const pos = el.selectionStart;
  if (pos == null || pos !== el.selectionEnd) return close();
  if (el.dataset.ac === 'email') return updateEmail(el, pos);
  if (['code', 'project', 'company'].includes(el.dataset.ac)) return updateWhole(el);
  const kind = kindOf(el);
  const allowed = el.dataset.acOnly || { item: '/@', project: '@' }[kind] || '@#!+>';
  const m = el.value.slice(0, pos).match(/(?:^|\s)([@#!+>/])([^\s@#!+>/]*)$/);
  if (!m || !allowed.includes(m[1])) return close();
  // Nella barra articoli il primo termine è il codice: niente suggerimenti finché non c'è.
  if (kind === 'item' && m.index === 0 && !/^\s/.test(m[0])) return close();
  const [, sig, q] = m;
  const start = pos - q.length - 1;
  const end = pos + el.value.slice(pos).match(/^\S*/)[0].length;
  const items = suggest(sig, q, kind);
  if (!items.length) return close();
  st = { el, start, end, items, index: 0, token: sig + q, suffix: ' ' };
  draw();
}

function updateWhole(el) {
  const q = lc(el.value.trim().replace(/^[#@]/, ''));
  if (!q) return close();
  const D = S.data;
  let items;
  let commit = 'submit';
  if (el.dataset.ac === 'code') {
    const self = lc(el.dataset.acSelf);
    items = itemSuggestions(q, i => lc(i.code) !== self).map(i => ({ ...i, insert: i.label }));
  } else if (el.dataset.ac === 'company') {
    items = companySuggestions(q);
    commit = 'change';
    // Già scritta per intero ed è l'unica: niente menu.
    if (items.length === 1 && lc(items[0].insert) === q) items = [];
  } else {
    items = projectSuggestions(q).map(p => ({ ...p, insert: p.label.slice(1) }));
  }
  if (!items.length) return close();
  st = { el, start: 0, end: el.value.length, items, index: 0, token: el.value.trim(), suffix: '', commit };
  draw();
}

function companySuggestions(ql) {
  const counts = new Map();
  for (const c of S.data.contacts) {
    const name = c.company?.trim();
    if (!name) continue;
    const key = lc(name);
    const cur = counts.get(key) || { name, n: 0 };
    cur.n++;
    counts.set(key, cur);
  }
  return [...counts.values()].filter(c => lc(c.name).includes(ql))
    .sort((a, b) => rank(a.name, ql) - rank(b.name, ql) || b.n - a.n || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map(c => ({ insert: c.name, label: c.name, extra: c.n === 1 ? '1 contatto' : `${c.n} contatti` }));
}

function itemSuggestions(ql, filter = () => true) {
  return S.data.items
    .filter(i => filter(i) && (!ql || [i.code, i.name, i.firmware, i.category].some(v => lc(v).includes(ql))))
    .sort((a, b) => rank(a.code, ql) - rank(b.code, ql) || a.code.localeCompare(b.code))
    .slice(0, 8)
    .map(i => ({ label: i.code, hint: i.name, extra: i.firmware ? `fw ${i.firmware}` : i.category, code: true, cat: i.category }));
}

function projectSuggestions(ql) {
  const order = { open: 0, paused: 1, closed: 2 };
  return S.data.projects
    .filter(p => !ql || lc(p.tag).includes(ql) || lc(p.name).includes(ql))
    .filter(p => p.status !== 'closed' || ql)
    .sort((a, b) => rank(a.tag, ql) - rank(b.tag, ql) || order[a.status] - order[b.status] || a.tag.localeCompare(b.tag))
    .slice(0, 8)
    .map(p => ({ label: `@${p.tag}`, hint: lc(p.name) !== lc(p.tag) ? p.name : '', extra: STATUS[p.status] || '', hue: hue(p.tag) }));
}

function updateEmail(el, pos) {
  const q = el.value.slice(0, pos).match(/([^,]*)$/)[1].trimStart();
  if (!q) return close();
  const start = pos - q.length;
  const end = pos + el.value.slice(pos).match(/^[^,]*/)[0].length;
  const items = contactItems(lc(q)).map(c => ({ insert: c.email, label: c.label, hint: c.hint, extra: c.extra }));
  if (!items.length) return close();
  st = { el, start, end, items, index: 0, token: q, suffix: ', ' };
  draw();
}

// Rubrica prima, poi gli indirizzi usati di recente nelle mail.
function contactItems(ql) {
  const D = S.data;
  const out = [];
  const seen = new Set();
  for (const c of D.contacts) {
    if (!c.email || (ql && ![c.name, c.email, c.company].some(v => lc(v).includes(ql)))) continue;
    out.push({ email: c.email, label: c.name || c.email, hint: c.name ? c.email : '', extra: c.company, r: Math.min(rank(c.name, ql), rank(c.email, ql)) });
    seen.add(lc(c.email));
  }
  for (const e of [...D.entries].sort((a, b) => b.updated_at.localeCompare(a.updated_at))) {
    for (const a of String(e.contact || '').split(',').map(s => s.trim())) {
      if (!a || seen.has(lc(a)) || (ql && !lc(a).includes(ql))) continue;
      seen.add(lc(a));
      out.push({ email: a, label: a, hint: '', extra: 'usato', r: rank(a, ql) + 1 });
    }
  }
  return out.sort((a, b) => a.r - b.r).slice(0, 8);
}

function rank(s, q) {
  const v = lc(s);
  return v === q ? 0 : v.startsWith(q) ? 1 : 2;
}

function suggest(sig, q, kind) {
  const D = S.data;
  if (!D) return [];
  const ql = lc(q);

  if (sig === '@') return projectSuggestions(ql).map(p => ({ ...p, insert: p.label }));

  if (sig === '#') return itemSuggestions(ql).map(i => ({ ...i, insert: `#${i.label}` }));

  if (sig === '/') {
    const counts = new Map();
    for (const i of D.items) if (i.category) counts.set(i.category, (counts.get(i.category) || 0) + 1);
    return [...counts].filter(([c]) => !ql || lc(c).includes(ql))
      .sort((a, b) => rank(a[0], ql) - rank(b[0], ql) || b[1] - a[1])
      .slice(0, 8)
      .map(([c, n]) => ({ insert: `/${c.replace(/ /g, '_')}`, label: `/${c}`, extra: `${n} articoli`, cat: c }));
  }

  if (sig === '+') {
    return D.users
      .filter(u => !ql || lc(u.username).includes(ql) || lc(u.name).includes(ql))
      .map(u => ({ insert: `+${u.username}`, label: `+${u.username}`, hint: lc(u.name) !== lc(u.username) ? u.name : '' }));
  }

  if (sig === '>') {
    return contactItems(ql).map(c => ({ insert: `>${c.email}`, label: c.label === c.email ? `>${c.email}` : c.label, hint: c.hint, extra: c.extra }));
  }

  // !data: scorciatoie con la data risolta accanto, così si vede subito dove cade.
  const past = kind === 'note';
  let toks = (past ? PAST_DATES : FUTURE_DATES).filter(t => t.startsWith(ql));
  if (/^\d{1,3}$/.test(q)) toks = past ? [] : [`${q}g`, `${q}s`, `${q}m`];
  else if (/^\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?$/.test(q)) toks = [q];
  const t = today();
  return toks.map(tok => ({ tok, d: parseDate(tok, t, { past }) }))
    .filter(x => x.d !== undefined)
    .map(({ tok, d }) => ({
      insert: `!${tok}`,
      label: `!${tok}`,
      hint: d === null ? 'togli la data' : `${DOW[fromYmd(d).getDay()]} ${fmtDay(d)}`,
      extra: d === null ? '' : relative(d, t),
    }));
}

function relative(d, t) {
  const diff = Math.round((fromYmd(d) - fromYmd(t)) / 864e5);
  if (diff === 0) return 'oggi';
  if (diff === 1) return 'domani';
  if (diff === -1) return 'ieri';
  return diff > 0 ? `tra ${diff}g` : `${-diff}g fa`;
}

function draw() {
  box.replaceChildren(...st.items.map((it, i) => h('div.ac-i', {
    class: i === st.index ? 'on' : null,
    role: 'option',
    onclick: () => accept(i),
  },
  h('span.ac-l', {
    class: [it.code && 'code', it.cat && 'cat', it.hue != null && 'proj'].filter(Boolean).join(' ') || null,
    style: it.hue != null ? `--h:${it.hue}` : catStyle(it.cat),
  }, it.label),
  it.hint && h('span.ac-h', it.hint),
  it.extra && h('span.ac-x', it.extra))));
  box.hidden = false;
  place();
}

function place() {
  if (!st.el.isConnected) return close();
  const r = st.el.getBoundingClientRect();
  const vh = window.visualViewport?.height ?? window.innerHeight;
  const width = Math.min(Math.max(r.width, 260), 460, window.innerWidth - 16);
  box.style.width = `${width}px`;
  box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
  const below = r.bottom + 4;
  const height = box.offsetHeight;
  // Con la tastiera del telefono aperta lo spazio sotto può mancare: allora il menu va sopra.
  box.style.top = `${below + height > vh - 8 && r.top - height - 4 > 8 ? r.top - height - 4 : below}px`;
}

function accept(i) {
  const { el, start, end } = st;
  const ins = st.items[i].insert + st.suffix;
  const after = el.value.slice(end).replace(/^[ ,]+/, '');
  el.value = el.value.slice(0, start) + ins + after;
  const caret = start + ins.length;
  el.setSelectionRange(caret, caret);
  const { commit } = st;
  close();
  el.dispatchEvent(new Event('input', { bubbles: true }));
  if (commit === 'submit') el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  else if (commit === 'change') el.dispatchEvent(new Event('change', { bubbles: true }));
}

function onKey(ev) {
  if (!st || ev.target !== st.el || ev.isComposing) return;
  const n = st.items.length;
  const swallow = () => { ev.preventDefault(); ev.stopImmediatePropagation(); };
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    swallow();
    st.index = (st.index + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
    draw();
  } else if (ev.key === 'Tab' || ev.key === 'Enter') {
    // Token già scritto per intero: Invio conferma la riga invece di completare.
    if (ev.key === 'Enter' && lc(st.token) === lc(st.items[st.index].insert)) return close();
    swallow();
    accept(st.index);
  } else if (ev.key === 'Escape') {
    swallow();
    close();
  }
}
