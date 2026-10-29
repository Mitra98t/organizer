// Autocompletamento dei token (@progetto, #CODICE, !data, +utente, >destinatario) nei campi con data-ac.
// data-ac = tipo della voce ('todo' | 'mail' | 'note'), oppure 'auto' per la barra rapida
// (il tipo si ricava dal prefisso t:/m:/n: e dal contesto). data-ac-only limita i token accettati.
// data-ac="email": campo di indirizzi separati da virgola (A, Cc), suggerisce la rubrica senza simboli.
// data-ac="code" / "project": tutto il campo è un codice di magazzino / un progetto; scegliere un
// suggerimento conferma subito il campo (come premere Invio). data-ac-self esclude un codice.
// data-ac="cfield" + data-ac-field="company|timeslot|role": un campo dei contatti; suggerisce i valori già
// usati in rubrica e scegliendone uno il campo si salva.
// "[[" in qualunque campo di testo collega qualunque cosa: voci (todo, mail, note), documenti, articoli,
// progetti e contatti, ognuno con la sua etichetta di tipo nel menu. Inserisce [[voce:34]], [[doc:12]],
// [[progetto:3]], [[contatto:5]] (mostrati come link con il nome attuale); per gli articoli #CODICE.
// data-ac-entry: la voce che si sta scrivendo (non si propone di collegarla a se stessa).
// data-ac="chat": i messaggi della chat (@ # + e [[).
// data-ac-bare: si inserisce il valore senza simbolo (testo delle mail: "#SCH" → "SCH-042").
// Nella barra in alto: modalità 'item' (/categoria, @progetto) e 'project' (@progetto padre).
// Un solo menu flottante per tutta l'app, agganciato al campo che ha il focus: sopravvive ai re-render.
import { h, S, fmtDay, hue, catStyle, projHue, docName } from './core.js';
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
  if (['code', 'project', 'cfield'].includes(el.dataset.ac)) return updateWhole(el);
  const kind = kindOf(el);
  // Le barre per creare articoli e progetti non hanno collegamenti.
  if (kind !== 'item' && kind !== 'project') {
    const r = el.value.slice(0, pos).match(/\[\[([^\]\n]{0,40})$/);
    if (r) return updateRef(el, pos, r[1]);
  }
  const allowed = el.dataset.acOnly || { item: '/@', project: '@+' }[kind] || '@#!+>';
  const m = el.value.slice(0, pos).match(/(?:^|\s)(\+\+|[@#!+>/])([^\s@#!+>/]*)$/);
  if (!m || !allowed.includes(m[1])) return close();
  // Nella barra articoli il primo termine è il codice: niente suggerimenti finché non c'è.
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
    // Già scritta per intero ed è l'unica: niente menu.
    if (items.length === 1 && lc(items[0].insert) === q) items = [];
  } else {
    items = projectSuggestions(q).map(p => ({ ...p, insert: p.label.slice(1) }));
  }
  if (!items.length) return close();
  st = { el, start: 0, end: el.value.length, items, index: 0, token: el.value.trim(), suffix: '', commit };
  draw();
}

function updateRef(el, pos, q) {
  const items = refSuggestions(lc(q.trim()), { bare: el.dataset.acBare != null, self: +el.dataset.acEntry || null });
  if (!items.length) return close();
  st = { el, start: pos - q.length - 2, end: pos, items, index: 0, token: `[[${q}`, suffix: ' ' };
  draw();
}

// Etichette di tipo nel menu dei collegamenti, per distinguere al volo cosa si sta collegando.
const PILL = { todo: 'todo', mail: 'mail', note: 'nota', doc: 'documento', item: 'articolo', project: 'progetto', contact: 'contatto' };

// Tutto insieme; senza testo: le voci aperte più recenti, poi un po' di ogni altro tipo.
function refSuggestions(ql, { bare, self }) {
  const D = S.data;
  const words = ql.split(/\s+/).filter(Boolean);
  // Ogni parola scritta deve trovarsi (anche sparsa) in uno dei campi.
  const hit = (...v) => words.every(w => v.some(x => fuzzy(x, w) != null));
  const plain = t => t.replace(/(^|\s)#/g, '$1').replace(/\[\[\w+:\d+\]\]/g, '…');
  const entryState = e => (e.done_at ? (e.kind === 'mail' ? 'mandata' : e.kind === 'todo' ? 'fatta' : '') : e.kind === 'mail' ? 'da mandare' : '');
  const groups = [
    D.entries.filter(e => e.id !== self && hit(e.title, e.contact) && (ql || !e.done_at))
      .sort((a, b) => !!a.done_at - !!b.done_at || b.updated_at.localeCompare(a.updated_at))
      .map(e => ({ insert: `[[voce:${e.id}]]`, label: plain(e.title), hint: e.kind === 'mail' ? e.contact || '' : '', extra: entryState(e), pill: e.kind, r: rank(e.title, ql) })),
    D.docs.filter(d => D.itemById.has(d.item_id) && hit(docName(d), d.filename, d.kind, D.itemById.get(d.item_id).code))
      .map(d => ({ insert: `[[doc:${d.id}]]`, label: docName(d), hint: D.itemById.get(d.item_id).code, extra: d.kind, pill: 'doc', r: rank(docName(d), ql) })),
    D.items.filter(i => hit(i.code, i.name))
      .map(i => ({ insert: bare ? i.code : `#${i.code}`, label: i.code, hint: i.name, extra: i.category, code: true, cat: i.category, pill: 'item', r: rank(i.code, ql) })),
    D.projects.filter(p => hit(p.name, p.tag) && (ql || p.status !== 'closed'))
      .map(p => ({ insert: `[[progetto:${p.id}]]`, label: p.name, hint: `@${p.tag}`, extra: STATUS[p.status] || '', pill: 'project', r: rank(p.name, ql) })),
    D.contacts.filter(c => hit(c.name, c.email, c.company))
      .map(c => ({ insert: `[[contatto:${c.id}]]`, label: c.name || c.email, hint: c.company || (c.name ? c.email : ''), pill: 'contact', r: rank(c.name, ql) })),
  ];
  if (!ql) return groups.flatMap((g, i) => g.slice(0, [4, 2, 2, 1, 1][i]));
  return groups.flat().sort((a, b) => a.r - b.r).slice(0, 10);
}

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
    .map(c => ({ insert: c.name, label: c.name, extra: c.n === 1 ? '1 contatto' : `${c.n} contatti` }));
}

// Nei codici trattini, punti e barre non contano: "sch051" trova SCH-051.
const bare = s => lc(s).replace(/[-_./\s]+/g, '');

// Si cerca anche nei codici alternativi; si inserisce sempre il codice principale (quello con cui è noto),
// e nel suggerimento si vede quale alternativo ha trovato.
function itemSuggestions(ql, filter = () => true) {
  const qb = bare(ql);
  // Codice (anche senza trattini: "sch051"), codici alternativi, poi nome, firmware e categoria.
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
    .map(({ i, alt }) => ({ label: i.code, hint: alt ? `alt. ${alt} · ${i.name}` : i.name, extra: i.firmware ? `fw ${i.firmware}` : i.category, code: true, cat: i.category }));
}

function projectSuggestions(ql) {
  const order = { open: 0, paused: 1, closed: 2 };
  const score = p => best(ql, [p.tag], [p.name, 0.2]);
  return S.data.projects
    .filter(p => score(p) != null)
    .filter(p => p.status !== 'closed' || ql)
    .sort((a, b) => score(a) - score(b) || order[a.status] - order[b.status] || a.tag.localeCompare(b.tag))
    .slice(0, 8)
    .map(p => ({ label: `@${p.tag}`, hint: lc(p.name) !== lc(p.tag) ? p.name : '', extra: STATUS[p.status] || '', hue: projHue(p) }));
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

// Ricerca "fuzzy": le lettere scritte nell'ordine, anche non attaccate ("almar" trova ALDO-MARCO-LUIGI,
// "sch51" trova SCH-051). Punteggio, più basso = meglio: uguale, inizia così, contiene, poi lettere sparse
// (meglio se a inizio parola e vicine). null = non c'entra.
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

// Il punteggio migliore tra più campi; un campo secondario (nome, descrizione) pesa un po' meno.
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
      .map(([c, n]) => ({ insert: `/${c.replace(/ /g, '_')}`, label: `/${c}`, extra: `${n} articoli`, cat: c }));
  }

  // +persona la vede anche lei, ++persona in più gliela assegna, +all la vedono tutti.
  if (sig === '+' || sig === '++') {
    const me = D.me.id;
    const people = D.members
      .filter(u => u.id !== me && best(ql, [u.username], [u.name]) != null)
      .sort((a, b) => best(ql, [a.username], [a.name]) - best(ql, [b.username], [b.name]))
      .map(u => ({ insert: `${sig}${u.username}`, label: `${sig}${u.username}`, hint: lc(u.name) !== lc(u.username) ? u.name : '', extra: sig === '++' ? 'condividi e assegna' : 'condividi' }));
    const all = sig === '+' && (!ql || 'all'.startsWith(ql) || 'tutti'.startsWith(ql)) ? [{ insert: '+all', label: '+all', hint: 'tutti', extra: 'condividi con tutti' }] : [];
    return [...people, ...all];
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
  it.pill && h('span.ac-k', { class: `t-${it.pill}` }, PILL[it.pill]),
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
