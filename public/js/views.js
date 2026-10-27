import {
  h, icon, S, ui, api, act, render, richText, dueInfo, dayDiff, fmtDay, fmtLongDay, fmtTime, fmtSize,
  userName, toast, save, patchEntry, addEntry, isMine, localDay, autosize, stop, copy, hue, trashIt, contactLabel,
} from './core.js';
import { today, addDays } from './parse.js';
import { mailComposer } from './mail.js';

const KIND_LABEL = { todo: 'Todo', mail: 'Mail', note: 'Nota' };
const KIND_PILL = { todo: 'todo', mail: 'mail', note: 'nota' };
const projTag = p => h('a.tag', { href: `#/p/${p.id}`, onclick: stop, style: `--h:${hue(p.tag)}` }, `@${p.tag}`);
const STATUS_LABEL = { open: 'Aperti', paused: 'In pausa', closed: 'Chiusi' };
export const DOC_KINDS = ['firmware', 'datasheet', 'schema', 'manuale', 'foto', 'altro'];

const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || b.pinned - a.pinned || a.id - b.id;
const byRecent = (a, b) => b.pinned - a.pinned || b.updated_at.localeCompare(a.updated_at);
const byDoneDesc = (a, b) => b.done_at.localeCompare(a.done_at);
const noteDay = e => e.due || localDay(e.created_at);
const byNoteDesc = (a, b) => noteDay(b).localeCompare(noteDay(a)) || b.id - a.id;

// ---------- blocchi comuni ----------
function section(id, title, children, { collapsed = false, count, cls } = {}) {
  const toggled = ui.sections.has(id);
  const closed = collapsed !== toggled;
  const toggle = () => {
    toggled ? ui.sections.delete(id) : ui.sections.add(id);
    save('org.sections', [...ui.sections]);
    render();
  };
  return h('section.sec', { class: [closed && 'closed', cls].filter(Boolean).join(' ') || null },
    h('button.sec-h', { onclick: toggle },
      h('span.caret', icon('back')), h('span.sec-t', title), h('span.count', count ?? children.length)),
    !closed && h('div.sec-b', children));
}

const empty = (...msg) => h('div.empty', ...msg);
const kbd = t => h('code.k', t);

function selectOf(value, options, onchange, attrs = {}) {
  return h('select', { value: value ?? '', onchange: ev => onchange(ev.target.value), ...attrs },
    options.map(([v, label]) => h('option', { value: v }, label)));
}

function projectOptions(current) {
  const ps = S.data.projects.filter(p => p.status !== 'closed' || p.id === current);
  return [['', '— nessuno —'], ...ps.map(p => [String(p.id), `@${p.tag}`])];
}

function toggleOpen(id) {
  ui.open.has(id) ? ui.open.delete(id) : ui.open.add(id);
  render();
}

function toggleDone(e) {
  const done = !e.done_at;
  patchEntry(e, { done });
  if (done) toast(e.kind === 'mail' ? 'Mail segnata come inviata' : 'Fatto', { action: { label: 'Annulla', fn: () => patchEntry(e, { done: false }) } });
}

function enterAdd(handler) {
  return ev => {
    if (ev.key !== 'Enter' || ev.isComposing) return;
    ev.preventDefault();
    const text = ev.target.value.trim();
    if (!text) return;
    ev.target.value = '';
    handler(text);
  };
}

// ---------- voce (todo / mail / nota) ----------
export function entryRow(e, opt = {}) {
  const D = S.data;
  const open = ui.open.has(e.id);
  const kids = D.childrenOf.get(e.id) || [];
  const logs = D.logsOf.get(e.id) || [];
  const proj = e.project_id && D.projectById.get(e.project_id);
  const parent = opt.showParent && e.parent_id && D.entryById.get(e.parent_id);

  const meta = [];
  if (e.due && !(e.kind !== 'note' && e.done_at)) {
    const d = dueInfo(e.due);
    meta.push(h('span.due', { class: e.kind === 'note' ? null : d.cls }, icon('cal'), e.kind === 'note' ? fmtDay(e.due) : d.label));
  }
  if (e.done_at && e.kind !== 'note') meta.push(h('span.muted', `${e.kind === 'mail' ? 'inviata' : 'fatta'} ${fmtTime(e.done_at)}`));
  if (proj && opt.showProject !== false) meta.push(projTag(proj));
  if (e.kind === 'mail' && e.contact) meta.push(h('span.contact', { title: e.contact }, `→ ${contactLabel(e.contact)}`));
  const atts = S.data.attachmentsOf.get(e.id);
  if (atts) meta.push(h('span.atts-n', { title: atts.map(a => a.filename).join(', ') }, icon('clip'), atts.length));
  if (e.assignee_id) meta.push(h('span.who', `+${userName(e.assignee_id)}`));
  if (kids.length) meta.push(h('span.kids', icon('check'), `${kids.filter(k => k.done_at).length}/${kids.length}`));
  if (logs.length) meta.push(h('span.logs', icon('log'), logs.length));
  if (e.notes) meta.push(h('span.has-notes', { title: 'Ha dettagli' }, '¶'));
  if (e.private) meta.push(h('span.priv', { title: 'Privata' }, icon('lock')));
  if (parent) meta.push(h('span.parent', { title: parent.title }, '↳ sotto-attività di ', h('b', parent.title)));
  if (e.pending) meta.push(h('span.pending', 'in coda offline'));

  const check = e.kind === 'note'
    ? h('span.bullet')
    : h('button.check', {
      class: e.kind,
      title: e.done_at ? 'Riapri' : e.kind === 'mail' ? 'Segna come inviata' : 'Completa',
      onclick: () => toggleDone(e),
    }, e.done_at ? icon('check') : e.kind === 'mail' ? icon('mail') : null);

  return h('div.entry', {
    class: [`k-${e.kind}`, e.done_at && 'done', open && 'open', e.pinned && 'pinned', opt.nested && 'nested'].filter(Boolean).join(' '),
  },
  h('div.row', check,
    h('div.body', { onclick: () => toggleOpen(e.id) },
      h('div.title',
        opt.showKind !== false && !opt.nested && h('span.kpill', { class: `k-${e.kind}` }, KIND_PILL[e.kind]),
        e.pinned ? icon('star', 'pin') : null, richText(e.title)),
      meta.length > 0 && h('div.meta', meta))),
  open && entryEditor(e));
}

function entryEditor(e) {
  const D = S.data;
  const me = D.me;
  const kids = (D.childrenOf.get(e.id) || []).slice().sort((a, b) => !!a.done_at - !!b.done_at || byDue(a, b));
  const logs = D.logsOf.get(e.id) || [];
  const isNote = e.kind === 'note';
  const t = today();

  const dueBtn = (label, value) => h('button.chip', { class: e.due === value && 'on', onclick: () => patchEntry(e, { due: value }) }, label);

  return h('div.editor',
    h('textarea.ed-title', {
      rows: 1, value: e.title, 'data-fk': `title-${e.id}`, spellcheck: 'false', 'data-ac': e.kind,
      oninput: autosize,
      onkeydown: ev => {
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); ev.target.blur(); }
        if (ev.key === 'Escape') { ev.target.value = e.title; ev.target.blur(); }
      },
      onblur: ev => {
        const v = ev.target.value.trim();
        if (v && v !== e.title) patchEntry(e, { title: v });
      },
    }),
    h('div.fields',
      h('label.f', h('span', 'Tipo'), selectOf(e.kind, Object.entries(KIND_LABEL), v => patchEntry(e, { kind: v }))),
      h('label.f', h('span', isNote ? 'Data' : 'Scadenza'),
        h('input', { type: 'date', value: e.due || '', onchange: ev => patchEntry(e, { due: ev.target.value || null }) })),
      !isNote && h('div.chips',
        dueBtn('oggi', t), dueBtn('domani', addDays(t, 1)), dueBtn('+1 sett', addDays(t, 7)),
        e.due && h('button.chip', { onclick: () => patchEntry(e, { due: null }) }, icon('x'))),
      !e.parent_id && h('label.f', h('span', 'Progetto'),
        selectOf(e.project_id ? String(e.project_id) : '', projectOptions(e.project_id), v => patchEntry(e, { project_id: v ? +v : null }))),
      D.users.length > 1 && h('label.f', h('span', 'Assegnata'),
        selectOf(e.assignee_id ? String(e.assignee_id) : '', [['', '— nessuno —'], ...D.users.map(u => [String(u.id), u.name || u.username])],
          v => patchEntry(e, { assignee_id: v ? +v : null }))),
      h('button.chip', { class: e.pinned && 'on', onclick: () => patchEntry(e, { pinned: !e.pinned }) }, icon('star'), 'evidenza'),
      e.created_by === me.id && h('button.chip', { class: e.private && 'on', onclick: () => patchEntry(e, { private: !e.private }) }, icon('lock'), 'privata'),
    ),
    e.kind === 'mail' ? mailComposer(e) : h('textarea.ed-notes', {
      rows: 1, value: e.notes, placeholder: 'Dettagli (facoltativo)…', 'data-fk': `notes-${e.id}`,
      oninput: autosize,
      onblur: ev => { if (ev.target.value !== e.notes) patchEntry(e, { notes: ev.target.value }); },
    }),
    !isNote && !e.parent_id && h('div.subs',
      kids.map(k => entryRow(k, { nested: true, showProject: false })),
      h('input.sub-in', {
        placeholder: '+ sotto-attività', 'data-fk': `sub-${e.id}`, 'data-ac': 'todo', autocomplete: 'off',
        onkeydown: enterAdd(text => addEntry({ text, today: today(), parent_id: e.id })),
      })),
    h('div.log',
      logs.map(l => h('div.log-l', { class: l.system ? 'sys' : null },
        h('span.log-t', fmtTime(l.created_at)),
        D.users.length > 1 && h('span.log-u', userName(l.user_id)),
        h('span.log-x', richText(l.text)),
        (l.user_id === me.id || me.is_admin) && h('button.icon-btn.sm', { title: 'Elimina', onclick: () => act(() => api('DELETE', `/logs/${l.id}`)) }, icon('x')))),
      h('input.log-in', {
        placeholder: 'Aggiornamento: cosa hai scoperto? (anche !data +utente #CODICE)', 'data-fk': `log-${e.id}`,
        'data-ac': e.kind, 'data-ac-only': '!#+', autocomplete: 'off',
        onkeydown: enterAdd(text => act(() => api('POST', `/entries/${e.id}/log`, { text, today: today() }))),
      })),
    h('div.ed-foot',
      h('span.muted', `${userName(e.created_by)} · ${fmtTime(e.created_at)}`),
      h('span.grow'),
      h('button.btn.sm.danger', {
        onclick: () => {
          ui.open.delete(e.id);
          trashIt('entry', `/entries/${e.id}`, kids.length ? 'Voce e sotto-attività' : 'Voce');
        },
      }, icon('trash'), 'Elimina')));
}

function pendingRows(filter = () => true) {
  return S.outbox.filter(filter).map((p, i) => entryRow({
    id: -1 - i, kind: p.kind || 'todo', title: p.text, notes: '', pinned: 0, pending: true, created_at: new Date().toISOString(),
  }, { showProject: false }));
}

// ---------- agenda ----------
export function viewAgenda() {
  const D = S.data;
  let list = D.entries.filter(e => e.kind !== 'note' && !e.done_at && (!e.parent_id || e.due));
  if (ui.mine) list = list.filter(isMine);
  const kindCount = { all: list.length, todo: list.filter(e => e.kind === 'todo').length, mail: list.filter(e => e.kind === 'mail').length };
  if (ui.agendaKind !== 'all') list = list.filter(e => e.kind === ui.agendaKind);
  const g = { over: [], today: [], tomorrow: [], week: [], later: [], none: [] };
  for (const e of list) {
    if (!e.due) { g.none.push(e); continue; }
    const d = dayDiff(e.due);
    (d < 0 ? g.over : d === 0 ? g.today : d === 1 ? g.tomorrow : d <= 7 ? g.week : g.later).push(e);
  }
  const done = D.entries.filter(e => e.kind !== 'note' && e.done_at && Date.now() - Date.parse(e.done_at) < 864e5
    && (!ui.mine || isMine(e)) && (ui.agendaKind === 'all' || e.kind === ui.agendaKind));
  const setKind = k => { ui.agendaKind = k; save('org.agendaKind', k); render(); };
  const rows = arr => arr.map(e => entryRow(e, { showParent: true }));

  return h('div.view',
    h('div.toolbar',
      [['all', 'Tutto'], ['todo', 'Todo'], ['mail', 'Mail']].map(([k, label]) =>
        h('button.chip', { class: ui.agendaKind === k && 'on', onclick: () => setKind(k) },
          k !== 'all' && h('span.kdot', { class: `k-${k}` }), label, h('span.n', kindCount[k]))),
      D.users.length > 1 && h('span.tsep'),
      D.users.length > 1 && h('button.chip', { class: ui.mine && 'on', onclick: () => { ui.mine = !ui.mine; save('org.mine', ui.mine); render(); } }, icon('user'), 'solo mie')),
    pendingRows(),
    !list.length && ui.agendaKind !== 'all' && kindCount.all > 0 && empty(h('p', 'Niente di questo tipo. ', h('a', { href: '#/agenda', onclick: ev => { ev.preventDefault(); setKind('all'); } }, 'Mostra tutto'))),
    !kindCount.all && !S.outbox.length && empty(
      h('p', 'Niente in agenda.'),
      h('p', 'Scrivi nella barra in alto, ad esempio:'),
      h('p', kbd('flash fw nuovo #SCH-042 @rover !ven')),
      h('p', kbd('m: chiedere preventivo >fornitore@ditta.it !domani')),
      h('p', kbd('n: la rev B vuole il bootloader 2.x #SCH-042'))),
    g.over.length > 0 && section('ag-over', 'Scadute', rows(g.over.sort(byDue)), { cls: 'over' }),
    g.today.length > 0 && section('ag-today', 'Oggi', rows(g.today.sort(byDue)), { cls: 'today' }),
    g.tomorrow.length > 0 && section('ag-tom', 'Domani', rows(g.tomorrow.sort(byDue))),
    g.week.length > 0 && section('ag-week', 'Prossimi 7 giorni', rows(g.week.sort(byDue))),
    g.later.length > 0 && section('ag-later', 'Più avanti', rows(g.later.sort(byDue))),
    g.none.length > 0 && section('ag-none', 'Senza scadenza', rows(g.none.sort(byRecent))),
    done.length > 0 && section('ag-done', 'Fatte nelle ultime 24 ore', rows(done.sort(byDoneDesc)), { collapsed: true }));
}

// ---------- progetti ----------
function projectStats() {
  const stats = new Map();
  for (const e of S.data.entries) {
    if (!e.project_id) continue;
    const s = stats.get(e.project_id) || { open: 0, over: 0, next: null, last: '' };
    if (e.kind !== 'note' && !e.done_at && !e.parent_id) {
      s.open++;
      if (e.due && dayDiff(e.due) < 0) s.over++;
      if (e.due && (!s.next || e.due < s.next)) s.next = e.due;
    }
    if (e.updated_at > s.last) s.last = e.updated_at;
    stats.set(e.project_id, s);
  }
  return stats;
}

export function viewProjects() {
  const D = S.data;
  const stats = projectStats();
  const counts = { open: 0, paused: 0, closed: 0 };
  for (const p of D.projects) counts[p.status]++;
  const ps = D.projects.filter(p => p.status === ui.projStatus)
    .sort((a, b) => ((stats.get(b.id)?.last || b.updated_at).localeCompare(stats.get(a.id)?.last || a.updated_at)));

  return h('div.view',
    h('div.toolbar',
      Object.entries(STATUS_LABEL).map(([k, label]) =>
        h('button.chip', { class: ui.projStatus === k && 'on', onclick: () => { ui.projStatus = k; render(); } }, label, h('span.n', counts[k])))),
    h('form.inline-add', {
      onsubmit: ev => {
        ev.preventDefault();
        const name = ev.target.elements.name.value.trim();
        if (!name) return;
        ev.target.elements.name.value = '';
        act(async () => { const r = await api('POST', '/projects', { name }); location.hash = `#/p/${r.id}`; });
      },
    }, h('input', { name: 'name', placeholder: 'Nuovo progetto…', 'data-fk': 'newproj', autocomplete: 'off' }), h('button.btn', { type: 'submit' }, icon('plus'), 'Crea')),
    !ps.length && empty(h('p', ui.projStatus === 'open'
      ? ['Nessun progetto aperto. Puoi anche crearli al volo scrivendo ', kbd('@nome'), ' nella barra in alto.']
      : 'Nessun progetto qui.')),
    h('div.cards', ps.map(p => {
      const s = stats.get(p.id) || { open: 0, over: 0, next: null };
      const next = s.next && dueInfo(s.next);
      return h('a.card', { href: `#/p/${p.id}` },
        h('div.card-h', h('span.card-t', p.name), p.private ? icon('lock') : null),
        h('div.card-tag', { style: `--h:${hue(p.tag)}` }, `@${p.tag}`),
        h('div.card-m',
          h('span', `${s.open} aperte`),
          s.over > 0 && h('span.over', `${s.over} scadute`),
          next && h('span', { class: next.cls || null }, `prossima ${next.label}`)));
    })));
}

export function viewProject(id) {
  const D = S.data;
  const p = D.projectById.get(+id);
  if (!p) return empty(h('p', 'Progetto non trovato (o privato).'), h('a', { href: '#/progetti' }, 'Torna ai progetti'));
  const me = D.me;
  const es = D.entries.filter(e => e.project_id === p.id);
  const top = es.filter(e => !e.parent_id);
  const todos = top.filter(e => e.kind === 'todo' && !e.done_at).sort(byDue);
  const mails = top.filter(e => e.kind === 'mail' && !e.done_at).sort(byDue);
  const notes = top.filter(e => e.kind === 'note').sort(byNoteDesc);
  const done = top.filter(e => e.kind !== 'note' && e.done_at).sort(byDoneDesc);
  const itemIds = new Set(es.flatMap(e => (D.itemsOfEntry.get(e.id) || []).map(x => x.item_id)));
  const patch = f => act(() => api('PATCH', `/projects/${p.id}`, f));
  const rows = (arr, showKind = false) => arr.map(e => entryRow(e, { showProject: false, showKind }));

  return h('div.view',
    h('div.head',
      h('a.icon-btn', { href: '#/progetti', title: 'Progetti' }, icon('back')),
      h('input.h-title', { value: p.name, 'data-fk': `pname-${p.id}`, onchange: ev => patch({ name: ev.target.value }) })),
    h('div.fields',
      h('label.f', h('span', 'Tag @'), h('input.mono', { value: p.tag, size: 14, 'data-fk': `ptag-${p.id}`, onchange: ev => patch({ tag: ev.target.value }) })),
      h('label.f', h('span', 'Stato'), selectOf(p.status, [['open', 'Aperto'], ['paused', 'In pausa'], ['closed', 'Chiuso']], v => patch({ status: v }))),
      p.created_by === me.id && h('button.chip', { class: p.private && 'on', onclick: () => patch({ private: !p.private }) }, icon('lock'), 'privato'),
      h('span.grow'),
      (p.created_by === me.id || me.is_admin) && h('button.btn.sm.danger', {
        onclick: () => {
          if (!confirm(`Spostare @${p.tag} nel cestino? Le sue voci restano visibili, senza progetto.`)) return;
          trashIt('project', `/projects/${p.id}`, `@${p.tag}`).then(ok => { if (ok) location.hash = '#/progetti'; });
        },
      }, icon('trash'), 'Elimina')),
    h('textarea.proj-notes', {
      rows: 2, value: p.notes, placeholder: 'Appunti di progetto: repo, IP delle schede, toolchain, riferimenti…', 'data-fk': `pnotes-${p.id}`,
      oninput: autosize, onblur: ev => { if (ev.target.value !== p.notes) patch({ notes: ev.target.value }); },
    }),
    section(`p${p.id}-todo`, 'Da fare', todos.length ? rows(todos) : [empty(h('p', 'Scrivi nella barra in alto: le voci finiscono in ', kbd(`@${p.tag}`), '.'))], { count: todos.length }),
    mails.length > 0 && section(`p${p.id}-mail`, 'Mail da mandare', rows(mails)),
    notes.length > 0 && section(`p${p.id}-notes`, 'Diario', rows(notes)),
    itemIds.size > 0 && section(`p${p.id}-items`, 'Magazzino coinvolto', [h('div.item-chips', [...itemIds].map(i => itemChip(D.itemById.get(i))))], { count: itemIds.size }),
    done.length > 0 && section(`p${p.id}-done`, 'Completate', rows(done, true), { collapsed: true }));
}

// ---------- mail ----------
export function viewMail() {
  const D = S.data;
  const open = D.entries.filter(e => e.kind === 'mail' && !e.done_at).sort(byDue);
  const sent = D.entries.filter(e => e.kind === 'mail' && e.done_at).sort(byDoneDesc);
  return h('div.view',
    pendingRows(p => p.kind === 'mail'),
    !open.length && empty(h('p', 'Nessuna mail da mandare.'), h('p', 'Esempio: ', kbd('offerta 50 schede >acquisti@ditta.it !ven'))),
    open.length > 0 && section('mail-open', 'Da mandare', open.map(e => entryRow(e, { showKind: false }))),
    sent.length > 0 && section('mail-sent', 'Inviate (ultimi 30 giorni)', sent.map(e => entryRow(e, { showKind: false })), { collapsed: true }));
}

// ---------- diario ----------
export function viewDiary() {
  const D = S.data;
  const notes = D.entries.filter(e => e.kind === 'note' && !e.parent_id).sort(byNoteDesc);
  const shown = notes.slice(0, ui.diaryLimit);
  const days = [];
  for (const e of shown) {
    const d = noteDay(e);
    if (days.at(-1)?.day !== d) days.push({ day: d, items: [] });
    days.at(-1).items.push(e);
  }
  return h('div.view',
    pendingRows(p => p.kind === 'note'),
    !notes.length && empty(
      h('p', 'Il diario raccoglie le cose successe una volta che vanno ricordate.'),
      h('p', 'Esempio: ', kbd('scoperto che la SCH-042 rev B vuole fw ≥ 2.3 #SCH-042 @rover')),
      h('p', 'Con ', kbd('!ieri'), ' o ', kbd('!12/10'), ' registri quando è successo.')),
    days.map(g => h('div.day',
      h('div.day-h', fmtLongDay(g.day)),
      g.items.map(e => entryRow(e, { showKind: false })))),
    notes.length > shown.length && h('button.btn.ghost.more', { onclick: () => { ui.diaryLimit += 200; render(); } }, `Mostra altre ${notes.length - shown.length}`));
}

// ---------- magazzino ----------
function itemChip(it) {
  if (!it) return null;
  return h('a.item-chip', { href: `#/i/${it.id}` }, h('span.code', it.code), it.name && h('span', it.name), it.firmware && h('span.fw', `fw ${it.firmware}`));
}

function openCountOf(itemId) {
  const D = S.data;
  return (D.entriesOfItem.get(itemId) || []).filter(x => {
    const e = D.entryById.get(x.entry_id);
    return e && e.kind !== 'note' && !e.done_at;
  }).length;
}

export function viewItems() {
  const D = S.data;
  const f = ui.itemFilter.trim().toLowerCase();
  const docNames = id => (D.docsOf.get(id) || []).map(d => `${d.filename || ''} ${d.label} ${d.version}`).join(' ');
  const items = D.items.filter(i => !f || [i.code, i.name, i.category, i.firmware, i.location, i.notes, docNames(i.id)].join(' ').toLowerCase().includes(f));

  return h('div.view',
    h('div.toolbar',
      h('input.filter', {
        type: 'search', placeholder: 'Filtra per codice, nome, firmware, posizione, documento…', value: ui.itemFilter, 'data-fk': 'itemfilter',
        oninput: ev => { ui.itemFilter = ev.target.value; render(); },
      })),
    h('form.inline-add', {
      onsubmit: ev => {
        ev.preventDefault();
        const els = ev.target.elements;
        const code = els.code.value.trim().replace(/^#/, '');
        if (!code) return;
        act(async () => {
          const r = await api('POST', '/items', { code, name: els.name.value.trim() });
          location.hash = `#/i/${r.id}`;
        });
      },
    },
    h('input.mono', { name: 'code', placeholder: 'Codice (es. SCH-042)', 'data-fk': 'newcode', autocomplete: 'off', autocapitalize: 'characters', size: 14 }),
    h('input', { name: 'name', placeholder: 'Descrizione', 'data-fk': 'newname', autocomplete: 'off' }),
    h('button.btn', { type: 'submit' }, icon('plus'), 'Aggiungi')),
    !D.items.length && empty(
      h('p', 'Il magazzino è vuoto.'),
      h('p', 'Ogni ', kbd('#CODICE'), ' scritto in una voce crea e collega automaticamente l\'articolo.'),
      h('p', 'Nella scheda dell\'articolo carichi firmware, datasheet e schemi.')),
    D.items.length > 0 && !items.length && empty(h('p', 'Nessun articolo corrisponde al filtro.')),
    h('div.items', items.map(i => {
      const n = openCountOf(i.id);
      const docs = (D.docsOf.get(i.id) || []).length;
      return h('a.item-row', { href: `#/i/${i.id}` },
        h('span.code', i.code),
        h('span.name', i.name || h('span.muted', 'senza descrizione')),
        h('span.item-meta',
          i.category && h('span.cat', i.category),
          i.firmware && h('span.fw', icon('chip'), i.firmware),
          i.location && h('span.loc', i.location),
          i.qty != null && h('span.qty', `×${i.qty}`),
          docs > 0 && h('span.docs', icon('link'), docs),
          n > 0 && h('span.badge', n)));
    })));
}

async function uploadDocs(it, files) {
  for (const f of files) {
    const q = new URLSearchParams({ name: f.name, kind: ui.docKind, version: ui.docVer.trim() });
    toast(`Caricamento di ${f.name}…`);
    await act(() => api('POST', `/items/${it.id}/docs?${q}`, f), `${f.name} caricato`);
  }
  ui.docVer = '';
  render();
}

function docSection(it) {
  const D = S.data;
  const docs = D.docsOf.get(it.id) || [];
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: ev => { const files = [...ev.target.files]; ev.target.value = ''; uploadDocs(it, files); } });
  const addLink = () => {
    const url = prompt('URL del documento (repo, wiki, drive…)');
    if (!url) return;
    const label = prompt('Etichetta', '') || '';
    act(() => api('POST', `/items/${it.id}/docs`, { url, label, kind: ui.docKind, version: ui.docVer.trim() }));
  };
  const body = [
    h('div.upload',
      selectOf(ui.docKind, DOC_KINDS.map(k => [k, k]), v => { ui.docKind = v; }),
      h('input', { placeholder: 'versione', size: 9, value: ui.docVer, 'data-fk': `docver-${it.id}`, oninput: ev => { ui.docVer = ev.target.value; } }),
      h('button.btn', { onclick: () => fileInput.click() }, icon('upload'), 'File'),
      h('button.btn.ghost', { onclick: addLink }, icon('link'), 'Link'),
      fileInput),
    !docs.length && h('p.muted.drop-hint', 'Trascina qui i file, oppure usa i pulsanti. Un firmware con versione aggiorna il campo "Firmware".'),
    docs.map(d => h('div.doc',
      h('span.dk', { class: `k-${d.kind}` }, d.kind),
      h('div.doc-main',
        h('a', { href: d.url || `api/docs/${d.id}/file?inline=1`, target: '_blank', rel: 'noopener noreferrer' }, d.label || d.filename || d.url),
        h('div.meta',
          d.version && h('span.ver', `v${d.version}`),
          d.label && d.filename && h('span', d.filename),
          d.size != null && h('span', fmtSize(d.size)),
          d.sha256 && h('button.sha', { title: `sha256 ${d.sha256} (clic per copiare)`, onclick: () => copy(d.sha256) }, d.sha256.slice(0, 10)),
          h('span', fmtTime(d.created_at)))),
      !d.url && h('a.icon-btn', { href: `api/docs/${d.id}/file`, title: 'Scarica', download: '' }, icon('download')),
      h('button.icon-btn', {
        title: 'Elimina',
        onclick: () => trashIt('doc', `/docs/${d.id}`, d.label || d.filename || 'Link'),
      }, icon('trash')))),
  ];
  const sec = section(`i-docs`, 'Documenti', body, { count: docs.length });
  sec.addEventListener('dragover', ev => { ev.preventDefault(); sec.classList.add('drag'); });
  sec.addEventListener('dragleave', () => sec.classList.remove('drag'));
  sec.addEventListener('drop', ev => {
    ev.preventDefault();
    sec.classList.remove('drag');
    if (ev.dataTransfer.files.length) uploadDocs(it, [...ev.dataTransfer.files]);
  });
  return sec;
}

export function viewItem(id) {
  const D = S.data;
  const it = D.itemById.get(+id);
  if (!it) return empty(h('p', 'Articolo non trovato.'), h('a', { href: '#/magazzino' }, 'Torna al magazzino'));
  const patch = f => act(() => api('PATCH', `/items/${it.id}`, f));
  const field = (key, label, attrs = {}) => h('label.f', h('span', label),
    h('input', { value: it[key] ?? '', 'data-fk': `it-${key}-${it.id}`, ...attrs, onchange: ev => patch({ [key]: ev.target.value }) }));

  const children = (D.childItems.get(it.id) || []).map(l => D.itemById.get(l.child_id)).filter(Boolean);
  const parents = (D.parentItems.get(it.id) || []).map(l => D.itemById.get(l.parent_id)).filter(Boolean);
  const linked = (D.entriesOfItem.get(it.id) || []).map(x => D.entryById.get(x.entry_id)).filter(Boolean);
  const open = linked.filter(e => e.kind !== 'note' && !e.done_at).sort(byDue);
  const notes = linked.filter(e => e.kind === 'note').sort(byNoteDesc);
  const done = linked.filter(e => e.kind !== 'note' && e.done_at).sort(byDoneDesc);

  return h('div.view',
    h('div.head',
      h('a.icon-btn', { href: '#/magazzino', title: 'Magazzino' }, icon('back')),
      h('input.h-title.mono', { value: it.code, 'data-fk': `icode-${it.id}`, onchange: ev => patch({ code: ev.target.value }) }),
      h('button.icon-btn', { title: 'Copia codice', onclick: () => copy(it.code) }, icon('copy'))),
    h('div.grid',
      field('name', 'Descrizione', { placeholder: 'es. scheda controllo motori' }),
      field('category', 'Categoria', { placeholder: 'scheda, prodotto, cavo…', list: 'item-cats' }),
      field('firmware', 'Firmware', { placeholder: 'versione attuale', class: 'mono' }),
      field('location', 'Posizione', { placeholder: 'scaffale, cassetto…' }),
      field('qty', 'Quantità', { type: 'number', inputmode: 'numeric' }),
      h('datalist#item-cats', [...new Set(D.items.map(i => i.category).filter(Boolean))].map(c => h('option', { value: c })))),
    h('textarea.proj-notes', {
      rows: 2, value: it.notes, placeholder: 'Note: pinout, jumper, procedura di flash, password di default…', 'data-fk': `inotes-${it.id}`,
      oninput: autosize, onblur: ev => { if (ev.target.value !== it.notes) patch({ notes: ev.target.value }); },
    }),
    docSection(it),
    section('i-comp', 'Composizione', [
      h('div.comp',
        h('span.muted', 'Contiene'),
        h('div.item-chips', children.map(c => h('span.chip-wrap', itemChip(c),
          h('button.icon-btn.sm', { title: 'Scollega', onclick: () => act(() => api('DELETE', `/items/${it.id}/children/${c.id}`)) }, icon('x'))))),
        h('input.sub-in.mono', {
          placeholder: '+ codice componente', 'data-fk': `child-${it.id}`, size: 16,
          onkeydown: enterAdd(code => act(() => api('POST', `/items/${it.id}/children`, { code }))),
        })),
      parents.length > 0 && h('div.comp', h('span.muted', 'Usato in'), h('div.item-chips', parents.map(itemChip))),
    ], { count: children.length + parents.length }),
    section('i-todo', 'Da fare', open.length ? open.map(e => entryRow(e)) : [empty(h('p', 'Scrivi nella barra in alto: le voci verranno collegate a ', kbd(`#${it.code}`), '.'))], { count: open.length }),
    notes.length > 0 && section('i-notes', 'Diario', notes.map(e => entryRow(e, { showKind: false }))),
    done.length > 0 && section('i-done', 'Completate', done.map(e => entryRow(e)), { collapsed: true }),
    h('div.danger-zone',
      h('span.muted', `Creato ${fmtTime(it.created_at)} da ${userName(it.created_by)}`),
      h('button.btn.sm.danger', {
        onclick: () => {
          if (!confirm(`Spostare ${it.code} e i suoi documenti nel cestino?`)) return;
          trashIt('item', `/items/${it.id}`, it.code).then(ok => { if (ok) location.hash = '#/magazzino'; });
        },
      }, icon('trash'), 'Elimina articolo')));
}

// ---------- ricerca ----------
export function viewSearch() {
  const D = S.data;
  const q = ui.q.trim().toLowerCase();
  if (!q) return empty(h('p', 'Cerca tra voci, progetti, magazzino, documenti e contatti.'), h('p', kbd('Ctrl/⌘ K'), ' per arrivare qui dalla tastiera.'));
  const has = s => String(s || '').toLowerCase().includes(q);
  const entries = D.entries.filter(e => has(e.title) || has(e.notes) || has(e.contact) || (D.logsOf.get(e.id) || []).some(l => has(l.text)))
    .sort((a, b) => !!a.done_at - !!b.done_at || b.updated_at.localeCompare(a.updated_at));
  const projects = D.projects.filter(p => has(p.name) || has(p.tag) || has(p.notes));
  const contacts = D.contacts.filter(c => [c.name, c.email, c.company, c.role, c.phone, c.notes].some(has));
  const items = D.items.filter(i => [i.code, i.name, i.category, i.firmware, i.location, i.notes].some(has)
    || (D.docsOf.get(i.id) || []).some(d => has(d.filename) || has(d.label) || has(d.version)));

  return h('div.view',
    projects.length > 0 && section('s-proj', 'Progetti', [h('div.item-chips', projects.map(p => h('a.item-chip', { href: `#/p/${p.id}` }, h('span', p.name), h('span.code', `@${p.tag}`))))], { count: projects.length }),
    items.length > 0 && section('s-items', 'Magazzino', [h('div.item-chips', items.map(itemChip))], { count: items.length }),
    contacts.length > 0 && section('s-contacts', 'Contatti', [h('div.item-chips', contacts.map(c =>
      h('a.item-chip', { href: `#/contatti/${c.id}` }, icon('user'), h('span', c.name || c.email), c.company && h('span.muted', c.company))))], { count: contacts.length }),
    section('s-entries', 'Voci', entries.length ? entries.slice(0, 200).map(e => entryRow(e, { showParent: true })) : [empty(h('p', 'Nessuna voce recente corrisponde.'))], { count: entries.length }),
    ui.archive?.q === q
      ? section('s-arch', 'Archivio (completate da più di 30 giorni)', ui.archive.rows.length ? ui.archive.rows.map(e => entryRow(e)) : [empty(h('p', 'Niente in archivio.'))], { count: ui.archive.rows.length })
      : h('button.btn.ghost.more', {
        onclick: () => act(async () => { ui.archive = { q, rows: await api('GET', `/archive?q=${encodeURIComponent(q)}`) }; render(); }),
      }, 'Cerca anche nell\'archivio'));
}

// ---------- impostazioni ----------
function loadInvites() {
  ui.invites = [];
  api('GET', '/admin/invites').then(r => { ui.invites = r; render(); }).catch(() => {});
}

const inviteLink = code => `${location.origin}${location.pathname}#/registrati?code=${code}`;

export function viewSettings() {
  const D = S.data;
  const me = D.me;
  if (me.is_admin && ui.invites == null) loadInvites();
  const theme = localStorage.getItem('org.theme') || 'auto';

  return h('div.view.settings',
    section('set-me', 'Profilo', [
      h('div.grid',
        h('label.f', h('span', 'Username'), h('input', { value: me.username, disabled: true })),
        h('label.f', h('span', 'Nome visualizzato'), h('input', { value: me.name, 'data-fk': 'myname', onchange: ev => act(() => api('PATCH', '/me', { name: ev.target.value }), 'Nome aggiornato') })),
        h('label.f', h('span', 'Tema'), selectOf(theme, [['auto', 'Automatico'], ['light', 'Chiaro'], ['dark', 'Scuro']], v => {
          localStorage.setItem('org.theme', v);
          document.documentElement.dataset.theme = v;
        }))),
      h('form.grid', {
        onsubmit: ev => {
          ev.preventDefault();
          const f = ev.target.elements;
          act(async () => { await api('PATCH', '/me', { current: f.current.value, password: f.password.value }); ev.target.reset(); }, 'Password cambiata');
        },
      },
      h('label.f', h('span', 'Password attuale'), h('input', { name: 'current', type: 'password', autocomplete: 'current-password' })),
      h('label.f', h('span', 'Nuova password'), h('input', { name: 'password', type: 'password', autocomplete: 'new-password', minlength: 8 })),
      h('button.btn', { type: 'submit' }, 'Cambia password')),
    ], { count: '' }),

    h('a.trash-link', { href: '#/cestino' }, icon('trash'), 'Cestino', h('span.muted', D.trashCount ? `${D.trashCount} elementi` : 'vuoto')),

    section('set-mail', 'Mail e Thunderbird', [
      h('p', '"Manda" apre la mail già compilata in Thunderbird, allegati compresi. Serve un piccolo helper sul computer, da installare una volta dalla cartella del progetto:'),
      h('p', kbd('make mail-helper')),
      h('label.check-row',
        h('input', { type: 'checkbox', checked: ui.mailHelper, onchange: ev => { ui.mailHelper = ev.target.checked; save('org.mailHelper', ui.mailHelper); render(); } }),
        'Helper Thunderbird installato su questo computer'),
      h('p.muted', 'Senza helper (per esempio dal telefono) "Manda" usa l\'app mail predefinita, ma senza allegati: per quelli c\'è il pulsante ".eml".'),
    ], { count: '', collapsed: true }),

    section('set-users', 'Persone', [
      D.users.map(u => h('div.user-row',
        icon('user'),
        h('span', u.name || u.username), h('span.muted', `@${u.username}`),
        u.is_admin ? h('span.chip.on', 'admin') : null,
        h('span.grow'),
        me.is_admin && u.id !== me.id && [
          h('button.btn.sm.ghost', { onclick: () => act(() => api('PATCH', `/admin/users/${u.id}`, { is_admin: !u.is_admin })) }, u.is_admin ? 'Togli admin' : 'Rendi admin'),
          h('button.btn.sm.ghost', {
            onclick: () => {
              if (!confirm(`Generare una nuova password per ${u.username}?`)) return;
              act(async () => { const r = await api('PATCH', `/admin/users/${u.id}`, { reset_password: true }); prompt(`Nuova password per ${u.username}:`, r.password); });
            },
          }, 'Reset password'),
          h('button.btn.sm.danger', {
            onclick: () => { if (confirm(`Eliminare ${u.username}? Le sue voci restano.`)) act(() => api('DELETE', `/admin/users/${u.id}`)); },
          }, icon('trash')),
        ])),
      me.is_admin && h('div.invites',
        h('p.muted', 'Per far entrare un amico crea un invito e mandagli il link (valido 7 giorni, una sola registrazione).'),
        h('button.btn', { onclick: () => act(async () => { const r = await api('POST', '/admin/invites'); loadInvites(); share(inviteLink(r.code)); }) }, icon('plus'), 'Crea invito'),
        (ui.invites || []).map(i => h('div.invite',
          h('code', i.code),
          h('span.muted', `scade ${fmtTime(i.expires_at)}`),
          h('span.grow'),
          h('button.icon-btn', { title: 'Copia link', onclick: () => share(inviteLink(i.code)) }, icon('copy')),
          h('button.icon-btn', { title: 'Revoca', onclick: () => act(async () => { await api('DELETE', `/admin/invites/${i.code}`); loadInvites(); }) }, icon('x'))))),
    ], { count: D.users.length }),

    section('set-syntax', 'Sintassi della barra rapida', [
      h('table.syntax', h('tbody',
        [
          ['t: m: n:', 'tipo: todo (predefinito), mail, nota'],
          ['!oggi !domani !ven !3g !2s !1m !fm !25/11 !no', 'scadenza (per le note: quando è successo); !no la toglie'],
          ['@progetto', 'progetto, creato al volo se non esiste'],
          ['#CODICE', 'articolo di magazzino, resta nel testo come link'],
          ['+utente', 'assegna a un utente'],
          ['>destinatario', 'destinatario della mail'],
        ].map(([k, v]) => h('tr', h('td', kbd(k)), h('td', v))))),
      h('p.muted', 'Gli stessi token funzionano modificando il titolo di una voce e negli aggiornamenti: scrivi "slitta tutto !lun" e la scadenza si sposta, lasciando traccia.'),
      h('p.muted', 'Da tastiera: ', kbd('n'), ' o ', kbd('/'), ' scrive una voce, ', kbd('Ctrl/⌘ K'), ' cerca, ', kbd('Esc'), ' esce dal campo.'),
    ], { count: '', collapsed: true }),

    section('set-app', 'Installa l\'app', [
      h('ul.install',
        h('li', h('b', 'iPhone/iPad: '), 'apri in Safari → Condividi → "Aggiungi alla schermata Home".'),
        h('li', h('b', 'Android: '), 'apri in Chrome → menu ⋮ → "Installa app" (serve HTTPS, vedi README).'),
        h('li', h('b', 'Mac: '), 'Safari → File → "Aggiungi al Dock", oppure Chrome → icona di installazione nella barra indirizzi.'),
        h('li', h('b', 'Linux: '), 'Chrome/Chromium → icona di installazione nella barra indirizzi.')),
      h('p.muted', `Indirizzo attuale: ${location.origin}${isSecureContext ? '' : ' (non HTTPS: niente modalità offline)'}`),
    ], { count: '', collapsed: true }),

    me.is_admin && section('set-admin', 'Backup', [
      h('p.muted', 'Scarica una copia del database (voci, progetti, magazzino). I file caricati restano nel volume dati: vedi README.'),
      h('a.btn', { href: 'api/admin/backup', download: '' }, icon('download'), 'Scarica backup database'),
    ], { count: '', collapsed: true }),

    h('div.danger-zone',
      h('span.muted', `Connesso come ${me.username}`),
      h('button.btn.sm', { onclick: () => window.dispatchEvent(new Event('org:logout')) }, icon('logout'), 'Esci')));
}

async function share(url) {
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Invito Organizer', url });
      return;
    } catch { /* annullato: copia */ }
  }
  copy(url);
}
