// Autocomplete for tokens (@project, #CODE, !date, +user, >recipient) in fields with data-ac.
// data-ac = the entry's kind ('todo' | 'mail' | 'note'), or 'auto' for the quick bar (the kind comes from the
// t:/m:/n: prefix and from the context). data-ac-only limits the accepted tokens.
// data-ac="email": a field of comma-separated addresses (To, Cc), suggests the address book without symbols.
// data-ac="code" / "project": the whole field is an inventory code / a project; picking a suggestion confirms the
// field at once (like pressing Enter). data-ac-self excludes a code.
// data-ac="cfield" + data-ac-field="company|timeslot|role": a contact field; suggests the values already used in
// the address book and picking one saves the field.
// "[[" in any text field links anything: entries (todos, mails, notes), documents, items, projects and contacts,
// each with its kind label in the menu. Inserts [[voce:34]], [[doc:12]], [[progetto:3]], [[contatto:5]] (shown as
// links with the current name); for items #CODE.
// data-ac-entry: the entry being written (it is not offered as a link to itself).
// data-ac="chat": chat messages (@ # + and [[).
// data-ac-bare: the value is inserted without symbol (mail text: "#SCH" → "SCH-042").
// In the top bar: 'item' mode (/category, @project) and 'project' mode (@parent project).
// A single floating menu for the whole app, attached to the focused field: it survives re-renders.
import { h, S, api, fmtDay, hue, catStyle, projHue, docName, userName, plainRefs, kindLabel } from './core.js';
import { parseDate, parseQuick, today, fromYmd } from './parse.js';
import { tr, trn, LANG } from './i18n.js';

const box = h('div.ac', { hidden: true, role: 'listbox' });
let st = null; // { el, start, end, items, index, token, suffix }
let contextKind = () => 'todo';

const lc = s => String(s ?? '').toLowerCase();
// Date shortcuts in the interface language (the parser understands both).
const IT = LANG === 'it';
const DOW = IT ? ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'] : ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FUTURE_DATES = IT ? ['oggi', 'domani', 'dopodomani', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom', '1s', '2s', '1m', 'fm', 'no']
  : ['today', 'tomorrow', '2d', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', '1w', '2w', '1m', 'eom', 'no'];
const PAST_DATES = IT ? ['oggi', 'ieri', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom', 'no']
  : ['today', 'yesterday', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'no'];
const STATUS = { paused: tr('paused'), closed: tr('closed') };

export function initAutocomplete(getContextKind) {
  contextKind = getContextKind;
  document.body.append(box);
  document.addEventListener('input', ev => { if (ev.target.dataset?.ac) update(ev.target); });
  document.addEventListener('keyup', ev => {
    if (ev.target.dataset?.ac && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) update(ev.target);
  });
  document.addEventListener('keydown', onKey, true); // capturing: before the fields' Enter handlers
  document.addEventListener('focusout', ev => { if (st && ev.target === st.el) close(); });
  window.addEventListener('resize', () => st && place());
  window.addEventListener('scroll', ev => { if (st && !box.contains(ev.target)) place(); }, true);
  // Taps and clicks on the menu must not take the focus away from the field.
  box.addEventListener('pointerdown', ev => ev.preventDefault());
  box.addEventListener('mousedown', ev => ev.preventDefault());
}

// After a re-render the attached field may have been replaced.
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
  if (['code', 'project', 'cfield'].includes(el.dataset.ac)) return updateWhole(el);
  const kind = kindOf(el);
  // The bars creating items and projects have no links.
  if (kind !== 'item' && kind !== 'project') {
    const r = el.value.slice(0, pos).match(/\[\[([^\]\n]{0,60})$/);
    if (r) return updateRef(el, pos, r[1]);
  }
  const allowed = el.dataset.acOnly || { item: '/@', project: '@+' }[kind] || '@#!+>';
  const m = el.value.slice(0, pos).match(/(?:^|\s)(\+\+|[@#!+>/])([^\s@#!+>/]*)$/);
  if (!m || !allowed.includes(m[1])) return close();
  // In the items bar the first word is the code: no suggestions until there is one.
  if (kind === 'item' && m.index === 0 && !/^\s/.test(m[0])) return close();
  const [, sig, q] = m;
  const start = pos - q.length - 1;
  const end = pos + el.value.slice(pos).match(/^\S*/)[0].length;
  let items = suggest(sig, q, kind);
  if (el.dataset.acBare != null) items = items.map(i => ({ ...i, insert: i.insert.slice(1) }));
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
  } else if (el.dataset.ac === 'cfield') {
    items = contactFieldSuggestions(el.dataset.acField, q);
    commit = 'change';
    // Already written in full and the only one: no menu.
    if (items.length === 1 && lc(items[0].insert) === q) items = [];
  } else {
    items = projectSuggestions(q).map(p => ({ ...p, insert: p.label.slice(1) }));
  }
  if (!items.length) return close();
  st = { el, start: 0, end: el.value.length, items, index: 0, token: el.value.trim(), suffix: '', commit };
  draw();
}

function updateRef(el, pos, q) {
  const ql = lc(q.trim());
  const items = refSuggestions(ql, { bare: el.dataset.acBare != null, self: +el.dataset.acEntry || null });
  askMailSearch(ql, () => { if (document.activeElement === el) update(el); });
  if (!items.length) return close();
  st = { el, start: pos - q.length - 2, end: pos, items, index: 0, token: `[[${q}`, suffix: ' ' };
  draw();
}

// The full text of received mails is not in the app's data: for "[[" (and the command bar) the server is asked
// which conversations contain the words, shortly after typing stops; when the answer arrives, done().
const mailSearch = new Map(); // search → conversation ids (null = on its way)
let mailTimer = null;
export function askMailSearch(ql, done) {
  if (ql.replace(/\s/g, '').length < 2 || mailSearch.has(ql) || !S.data?.mailThreads?.length) return;
  clearTimeout(mailTimer);
  mailTimer = setTimeout(() => {
    mailSearch.set(ql, null);
    api('GET', `/mail/search?${new URLSearchParams({ q: ql })}`)
      .then(ids => { mailSearch.set(ql, ids); done(); })
      .catch(() => mailSearch.delete(ql));
  }, 250);
}

// Kind labels in the links menu, to tell at a glance what is being linked.
const PILL = { todo: 'todo', mail: 'mail', note: tr('note'), doc: tr('document'), docnote: tr('note on file'), item: tr('item'), project: tr('project'), contact: tr('contact'), conv: tr('conversation'), page: tr('page') };

// Score of several words over several fields (lower = better, null = some word is missing): every word must be in
// at least one field, the best field counts. Fields: [text, weight, long]. In short fields (titles, names, codes)
// the letters may be scattered; in long texts (notes, mail bodies) the whole piece is needed, otherwise scattered
// letters are found almost everywhere.
function scoreWords(words, fields) {
  let total = 0;
  for (const w of words) {
    let top = null;
    for (const [v, weight = 0, long = false] of fields) {
      if (!v) continue;
      const r = long ? (lc(v).includes(w) ? 3 : null) : fuzzy(v, w);
      if (r != null && (top == null || r + weight < top)) top = r + weight;
    }
    if (top == null) return null;
    total += top;
  }
  return total;
}

// Everything together; without text: the most recent open entries, then a bit of every other kind. Also searched by
// kind ("mail", "todo", "note", "document"…), people (address-book names and addresses) and text. Each result has
// insert (the token for "[[") and href (where it leads, for the command bar).
const refSuggestions = (ql, opts) => findAll(ql, opts);

export function findAll(ql, { bare = false, self = null, limit = 12 } = {}) {
  const D = S.data;
  const words = ql.split(/\s+/).filter(Boolean);
  const plain = t => plainRefs(t).replace(/(^|\s)#/g, '$1').replace(/\[\[\w+:\d+\]\]/g, '…'); // links with their name
  const entryState = e => (e.done_at ? (e.kind === 'mail' ? tr('sent') : e.kind === 'todo' ? tr('done') : '') : e.kind === 'mail' ? tr('to send') : '');
  const names = list => String(list || '').split(',').map(a => (a.match(/<([^>]+)>/)?.[1] || a).trim().toLowerCase()).filter(Boolean)
    .map(a => D.contactByEmail.get(a)?.name || '').join(' ');
  // The people of a conversation, once: the address-book name, otherwise the mail's name or the address.
  const people = list => [...new Set(String(list || '').split(',').map(a => {
    const email = (a.match(/<([^>]+)>/)?.[1] || a).trim().toLowerCase();
    return email && !D.mine.has(email) ? D.contactByEmail.get(email)?.name || a.replace(/<[^>]*>/, '').replace(/"/g, '').trim() || email : '';
  }).filter(Boolean))].slice(0, 3).join(', ');
  const KIND_WORD = { todo: 'todo', mail: 'mail', note: tr('note') };
  const scored = (list, fields, make) => list.map(x => ({ x, r: scoreWords(words, fields(x)) })).filter(o => o.r != null)
    .map(o => ({ ...make(o.x), r: o.r }));
  const mailIds = mailSearch.get(ql) || [];
  const groups = [
    scored(D.entries.filter(e => e.id !== self && (ql || !e.done_at)), e => [
      [e.title], [e.mail_subject, 0.2], [e.contact, 0.5], [names(`${e.contact},${e.mail_cc}`), 0.5], [e.mail_cc, 0.8],
      [KIND_WORD[e.kind], 1], ...projectsOfEntry(e).map(p => [p.tag, 1]), [e.notes, 0, true],
    ], e => ({ insert: `[[voce:${e.id}]]`, href: `#/v/${e.id}`, label: plain(e.title), hint: e.kind === 'mail' ? e.contact || '' : '', extra: entryState(e), pill: e.kind, sort: e.updated_at,
      sub: line(projectsOfEntry(e).map(p => `@${p.tag}`).join(' '), e.due && tr('due {date}', { date: fmtDay(e.due) }), e.assignee_id && tr('to {name}', { name: userName(e.assignee_id) }),
        (D.itemsOfEntry.get(e.id) || []).map(x => D.itemById.get(x.item_id)?.code).filter(Boolean).slice(0, 4).join(' '), snippet(e.notes)) })),
    scored(D.mailThreads, t => {
      const msgs = D.msgsOfThread.get(t.id) || [];
      const addrs = msgs.map(m => `${m.from_addr},${m.to_addr},${m.cc}`).join(',');
      return [[t.subject], [D.topicById.get(t.topic_id)?.title, 0.3], [addrs, 0.5, true], [names(addrs), 0.3, true], ['mail', 1], [tr('conversation'), 1],
        ...msgs.map(m => [m.snippet, 0.5, true]), ...(mailIds.includes(t.id) ? [[ql, 0, true]] : [])];
    }, t => {
      const msgs = D.msgsOfThread.get(t.id) || [];
      const topic = D.topicById.get(t.topic_id)?.title;
      return { insert: `[[mail:${t.id}]]`, href: `#/t/${t.topic_id}?th=${t.id}`, label: plain(t.subject), hint: people(msgs.map(m => m.direction === 'in' ? m.from_addr : m.to_addr).join(',')),
        extra: t.archived_at ? 'archiviata' : '', pill: 'conv', sort: t.last_at,
        sub: line(topic && lc(topic) !== lc(t.subject) && `topic: ${topic}`, trn(msgs.length, '1 message', '{n} messages'), t.last_at && tr('last {date}', { date: fmtDay(t.last_at.slice(0, 10)) }), snippet(msgs.at(-1)?.snippet)) };
    }),
    scored(D.docs.filter(d => D.itemById.has(d.item_id)), d => {
      const it = D.itemById.get(d.item_id);
      return [[docName(d)], [d.filename, 0.3], [kindLabel(d.kind), 0.5], [it.code, 0.3], ...(D.aliasesOf.get(it.id) || []).map(a => [a.code, 0.4]), [it.name, 0.8], [d.version, 1], [tr('document'), 1]];
    }, d => {
      const it = D.itemById.get(d.item_id);
      const open = (D.docNotesOf.get(d.id) || []).filter(n => !n.resolved_at).length;
      return { insert: `[[doc:${d.id}]]`, href: `#/d/${d.id}`, label: docName(d), hint: '', extra: d.kind, pill: 'doc', sort: d.created_at,
        sub: line(`${it.code} · ${it.name || ''}`, d.version && tr('version {v}', { v: d.version }), d.label && d.filename, d.url && d.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60),
          open && trn(open, '1 open note', '{n} open notes')) };
    }),
    // Notes on documents (also those on a piece of a PDF's text): searched by text, quoted text and document.
    scored(D.docNotes.filter(n => D.docById.has(n.doc_id) && (ql || !n.resolved_at)), n => {
      const d = D.docById.get(n.doc_id);
      const it = D.itemById.get(d.item_id);
      return [[n.text.split('\n')[0]], [n.text, 0.3, true], [n.quote, 0.3, true], [docName(d), 0.6], [it?.code, 0.6], [tr('note'), 1]];
    }, n => {
      const d = D.docById.get(n.doc_id);
      const first = plain(n.text.split('\n')[0]);
      const it = D.itemById.get(d.item_id);
      const page = n.page != null && n.z == null && /pdf/i.test(d.mime || d.filename || d.url || '') ? tr('p. {n}', { n: n.page }) : '';
      return { insert: `[[nota:${n.id}]]`, href: `#/d/${n.doc_id}?n=${n.id}`, label: first.length > 120 ? `${first.slice(0, 120)}…` : first,
        hint: '', extra: n.resolved_at ? 'risolta' : page, pill: 'docnote', sort: n.updated_at,
        // Where it is: item › document (kind), who wrote it and the highlighted text.
        sub: line(it && `${it.code}${it.name ? ` ${it.name}` : ''}`, `${docName(d)} (${kindLabel(d.kind)})`, n.created_by !== S.data.me.id && userName(n.created_by), n.quote && `«${snippet(n.quote, 90)}»`) };
    }),
    scored(D.items, i => [[i.code], ...(D.aliasesOf.get(i.id) || []).map(a => [a.code, 0.2]), [i.name, 0.5], [i.category, 1], [i.firmware, 1], [tr('item'), 1]],
      i => ({ insert: bare ? i.code : `#${i.code}`, href: `#/i/${i.id}`, label: i.code, hint: i.name, extra: i.category, code: true, cat: i.category, pill: 'item', sort: i.updated_at || '', sub: itemSub(i) })),
    scored(D.projects.filter(p => ql || p.status !== 'closed'), p => [[p.name], [p.tag], [tr('project'), 1], [p.notes, 0.5, true]],
      p => ({ insert: `[[progetto:${p.id}]]`, href: `#/p/${p.id}`, label: p.name, hint: `@${p.tag}`, extra: STATUS[p.status] || '', pill: 'project', sort: p.updated_at || '', sub: projectSub(p) })),
    scored(D.contacts, c => [[c.name], [c.email, 0.2], [c.company, 0.5], [c.role, 0.8], [tr('contact'), 1]],
      c => ({ insert: `[[contatto:${c.id}]]`, href: `#/contatti/${c.id}`, label: c.name || c.email, hint: c.company || (c.name ? c.email : ''), pill: 'contact', sort: c.updated_at || '',
        sub: line(c.name && c.email, c.role, c.phone, c.timeslot) })),
  ];
  const recent = (a, b) => String(b.sort).localeCompare(String(a.sort));
  if (!ql) return groups.flatMap((g, i) => g.sort(recent).slice(0, [4, 2, 2, 1, 2, 1, 1][i]));
  return groups.flat().sort((a, b) => a.r - b.r || recent(a, b)).slice(0, limit);
}

export { scoreWords, PILL };

// Kind labels as wide as the longest in the list: measured at their natural width and then fixed.
export function fitPills(list) {
  list.style.removeProperty('--kw');
  const w = Math.max(0, ...[...list.querySelectorAll('.ac-k')].map(k => k.getBoundingClientRect().width));
  if (w) list.style.setProperty('--kw', `${Math.ceil(w)}px`);
}

// Second line of the suggestions: the context (which item it belongs to, where it is, whose it is…), pieces separated by ·.
const line = (...parts) => parts.filter(x => x && String(x).trim()).join(' · ');
const snippet = (t, n = 70) => {
  const s = String(t || '').replace(/\[\[\w+:\d+\]\]/g, '…').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

function itemSub(i) {
  const D = S.data;
  const docs = (D.docsOf.get(i.id) || []).length;
  const alts = (D.aliasesOf.get(i.id) || []).map(a => a.code);
  return line(i.category, i.location && tr('in {where}', { where: i.location }), i.firmware && `fw ${i.firmware}`, alts.length && `alt. ${alts.slice(0, 3).join(', ')}`,
    docs && trn(docs, '1 document', '{n} documents'), i.qty != null && tr('{n} pcs', { n: i.qty }));
}

function projectSub(p) {
  const D = S.data;
  const open = D.entries.filter(e => !e.done_at && projectsOfEntry(e).some(x => x.id === p.id)).length;
  const parent = p.parent_id && D.projectById.get(p.parent_id);
  return line(parent && `in @${parent.tag}`, trn(open, '1 open entry', '{n} open entries'), snippet(p.notes));
}

const projectsOfEntry = e => [e.project_id, ...(S.data.extraProjectsOf.get(e.id) || []).map(x => x.project_id)]
  .map(id => id && S.data.projectById.get(id)).filter(Boolean);

function contactFieldSuggestions(field, ql) {
  const counts = new Map();
  for (const c of S.data.contacts) {
    const name = c[field]?.trim();
    if (!name) continue;
    const key = lc(name);
    const cur = counts.get(key) || { name, n: 0 };
    cur.n++;
    counts.set(key, cur);
  }
  return [...counts.values()].filter(c => fuzzy(c.name, ql) != null)
    .sort((a, b) => rank(a.name, ql) - rank(b.name, ql) || b.n - a.n || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map(c => ({ insert: c.name, label: c.name, extra: trn(c.n, '1 contact', '{n} contacts') }));
}

// In codes dashes, dots and slashes do not count: "sch051" finds SCH-051.
const bare = s => lc(s).replace(/[-_./\s]+/g, '');

// Alternative codes are searched too; the main code (the one it is known by) is always inserted, and the suggestion
// shows which alternative it found.
function itemSuggestions(ql, filter = () => true) {
  const qb = bare(ql);
  // Code (also without dashes: "sch051"), alternative codes, then name, firmware and category.
  const codeScore = c => best(ql, [c]) ?? (qb ? best(qb, [bare(c)]) : null);
  const scored = S.data.items.filter(filter).map(i => {
    const alts = (S.data.aliasesOf.get(i.id) || []).map(a => a.code);
    const main = codeScore(i.code);
    const altScores = alts.map(a => [a, codeScore(a)]).filter(([, r]) => r != null).sort((a, b) => a[1] - b[1]);
    const alt = main == null && altScores[0];
    const r = !ql ? 0 : [main, alt ? alt[1] + 0.1 : null, best(ql, [i.name, 0.5], [i.firmware, 1], [i.category, 1])].filter(x => x != null).sort((a, b) => a - b)[0];
    return { i, r, alt: alt ? alt[0] : null };
  }).filter(x => x.r != null);
  return scored.sort((a, b) => a.r - b.r || a.i.code.localeCompare(b.i.code))
    .slice(0, 8)
    .map(({ i, alt }) => ({ label: i.code, hint: alt ? `alt. ${alt} · ${i.name}` : i.name, extra: i.firmware ? `fw ${i.firmware}` : i.category, code: true, cat: i.category, sub: itemSub(i) }));
}

function projectSuggestions(ql) {
  const order = { open: 0, paused: 1, closed: 2 };
  const score = p => best(ql, [p.tag], [p.name, 0.2]);
  return S.data.projects
    .filter(p => score(p) != null)
    .filter(p => p.status !== 'closed' || ql)
    .sort((a, b) => score(a) - score(b) || order[a.status] - order[b.status] || a.tag.localeCompare(b.tag))
    .slice(0, 8)
    .map(p => ({ label: `@${p.tag}`, hint: lc(p.name) !== lc(p.tag) ? p.name : '', extra: STATUS[p.status] || '', hue: projHue(p), sub: projectSub(p) }));
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

// Address book first, then the addresses recently used in mails.
function contactItems(ql) {
  const D = S.data;
  const out = [];
  const seen = new Set();
  for (const c of D.contacts) {
    const r = best(ql, [c.name], [c.email, 0.1], [c.company, 0.5]);
    if (!c.email || r == null) continue;
    out.push({ email: c.email, label: c.name || c.email, hint: c.name ? c.email : '', extra: c.company, r });
    seen.add(lc(c.email));
  }
  for (const e of [...D.entries].sort((a, b) => b.updated_at.localeCompare(a.updated_at))) {
    for (const a of String(e.contact || '').split(',').map(s => s.trim())) {
      if (!a || seen.has(lc(a)) || fuzzy(a, ql) == null) continue;
      seen.add(lc(a));
      out.push({ email: a, label: a, hint: '', extra: 'usato', r: rank(a, ql) + 1 });
    }
  }
  return out.sort((a, b) => a.r - b.r).slice(0, 8);
}

// "Fuzzy" search: the letters typed in order, also not adjacent ("almar" finds ALDO-MARCO-LUIGI, "sch51" finds
// SCH-051). Score, lower = better: equal, starts like this, contains, then scattered letters (better at the start of
// a word and close together). null = unrelated.
export function fuzzy(s, q) {
  const v = lc(s);
  if (!q) return 0;
  if (!v) return null;
  if (v === q) return 0;
  if (v.startsWith(q)) return 1;
  const at = v.indexOf(q);
  if (at >= 0) return 2 + at / 1000;
  let pos = -1;
  let gaps = 0;
  let starts = 0;
  for (const ch of q) {
    const j = v.indexOf(ch, pos + 1);
    if (j < 0) return null;
    if (j === 0 || /[\s\-_./@#:]/.test(v[j - 1])) starts++;
    gaps += j - pos - 1;
    pos = j;
  }
  return 3 + Math.min(gaps, 90) / 100 - starts / 100;
}

// The best score among several fields; a secondary field (name, description) weighs a bit less.
function best(q, ...fields) {
  let out = null;
  for (const [value, weight = 0] of fields) {
    const r = fuzzy(value, q);
    if (r != null && (out == null || r + weight < out)) out = r + weight;
  }
  return out;
}

const rank = (s, q) => fuzzy(s, q) ?? 9;

function suggest(sig, q, kind) {
  const D = S.data;
  if (!D) return [];
  const ql = lc(q);

  if (sig === '@') return projectSuggestions(ql).map(p => ({ ...p, insert: p.label }));

  if (sig === '#') return itemSuggestions(ql).map(i => ({ ...i, insert: `#${i.label}` }));

  if (sig === '/') {
    const counts = new Map();
    for (const i of D.items) if (i.category) counts.set(i.category, (counts.get(i.category) || 0) + 1);
    return [...counts].filter(([c]) => fuzzy(c, ql) != null)
      .sort((a, b) => rank(a[0], ql) - rank(b[0], ql) || b[1] - a[1])
      .slice(0, 8)
      .map(([c, n]) => ({ insert: `/${c.replace(/ /g, '_')}`, label: `/${c}`, extra: trn(n, '1 item', '{n} items'), cat: c }));
  }

  // +person sees it too, ++person also gets it assigned, +all everyone sees it.
  if (sig === '+' || sig === '++') {
    const me = D.me.id;
    const people = D.members
      .filter(u => u.id !== me && best(ql, [u.username], [u.name]) != null)
      .sort((a, b) => best(ql, [a.username], [a.name]) - best(ql, [b.username], [b.name]))
      .map(u => ({ insert: `${sig}${u.username}`, label: `${sig}${u.username}`, hint: lc(u.name) !== lc(u.username) ? u.name : '', extra: sig === '++' ? tr('share and assign') : tr('share') }));
    const all = sig === '+' && (!ql || 'all'.startsWith(ql) || 'tutti'.startsWith(ql)) ? [{ insert: '+all', label: '+all', hint: tr('everyone'), extra: tr('share with everyone') }] : [];
    return [...people, ...all];
  }

  if (sig === '>') {
    return contactItems(ql).map(c => ({ insert: `>${c.email}`, label: c.label === c.email ? `>${c.email}` : c.label, hint: c.hint, extra: c.extra }));
  }

  // !date: shortcuts with the resolved date next to them, so you see at once where it falls.
  const past = kind === 'note';
  let toks = (past ? PAST_DATES : FUTURE_DATES).filter(t => t.startsWith(ql));
  if (/^\d{1,3}$/.test(q)) toks = past ? [] : IT ? [`${q}g`, `${q}s`, `${q}m`] : [`${q}d`, `${q}w`, `${q}m`];
  else if (/^\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?$/.test(q)) toks = [q];
  const t = today();
  return toks.map(tok => ({ tok, d: parseDate(tok, t, { past }) }))
    .filter(x => x.d !== undefined)
    .map(({ tok, d }) => ({
      insert: `!${tok}`,
      label: `!${tok}`,
      hint: d === null ? tr('remove the date') : `${DOW[fromYmd(d).getDay()]} ${fmtDay(d)}`,
      extra: d === null ? '' : relative(d, t),
    }));
}

function relative(d, t) {
  const diff = Math.round((fromYmd(d) - fromYmd(t)) / 864e5);
  if (diff === 0) return tr('today');
  if (diff === 1) return tr('tomorrow');
  if (diff === -1) return tr('yesterday');
  return diff > 0 ? tr('in {n}d', { n: diff }) : tr('{n}d ago', { n: -diff });
}

function draw() {
  box.replaceChildren(...st.items.map((it, i) => h('div.ac-i', {
    class: i === st.index ? 'on' : null,
    role: 'option',
    onclick: () => accept(i),
  },
  it.pill && h('span.ac-k', { class: `t-${it.pill}` }, PILL[it.pill]),
  h('div.ac-m',
    h('div.ac-r',
      h('span.ac-l', {
        class: [it.code && 'code', it.cat && 'cat', it.hue != null && 'proj'].filter(Boolean).join(' ') || null,
        style: it.hue != null ? `--h:${it.hue}` : catStyle(it.cat),
      }, it.label),
      it.hint && h('span.ac-h', it.hint)),
    it.sub && h('div.ac-sub', { title: it.sub }, it.sub)),
  it.extra && h('span.ac-x', it.extra))));
  box.classList.toggle('wide', st.items.some(it => it.sub));
  box.hidden = false;
  fitPills(box); // after hidden = false: hidden it cannot be measured
  place();
  // The menu scrolls with the selection (arrows up and down), also when going from the last back to the first.
  box.querySelector('.ac-i.on')?.scrollIntoView({ block: 'nearest' });
}

function place() {
  if (!st.el.isConnected) return close();
  const r = st.el.getBoundingClientRect();
  const vh = window.visualViewport?.height ?? window.innerHeight;
  // With the context (second line) the menu takes all the space needed to read it, wherever the field is (also in
  // the notes on the right of the document: it widens to the left); the others at least as wide as the field.
  const vw = window.innerWidth;
  const margin = vw < 700 ? 8 : 16;
  const width = box.classList.contains('wide') ? Math.min(960, vw - 2 * margin) : Math.min(Math.max(r.width, 420), 720, vw - 2 * margin);
  box.style.width = `${width}px`;
  box.style.left = `${Math.max(margin, Math.min(r.left, vw - width - margin))}px`;
  const below = r.bottom + 4;
  const height = box.offsetHeight;
  // With the phone keyboard open the space below may be missing: then the menu goes above.
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
    // Token already written in full: Enter confirms the line instead of completing.
    if (ev.key === 'Enter' && lc(st.token) === lc(st.items[st.index].insert)) return close();
    swallow();
    accept(st.index);
  } else if (ev.key === 'Escape') {
    swallow();
    close();
  }
}
