import {
  h, icon, S, ui, RS, api, act, render, richText, dueInfo, dayDiff, fmtDay, fmtLongDay, fmtTime, fmtSize,
  userName, toast, save, patchEntry, addEntry, isMine, localDay, autosize, stop, copy, hue, trashIt, contactNames,
  descendants, ancestors, catStyle, itemAttrs, docFileUrl, projectsOf, DOC_KINDS, docKinds, newDocKind, projHue, catHue, huePicker,
  switchWorkspace, newWorkspace, docName, renameDoc, richField, backlinks, plainRefs, CONTACT_COLOR,
} from './core.js';
import { docMeta } from './docview.js';
import { today, addDays } from './parse.js';
import { mailComposer } from './mail.js';
import { draggable } from './dnd.js';

const KIND_LABEL = { todo: 'Todo', mail: 'Mail', note: 'Nota' };
const KIND_PILL = { todo: 'todo', mail: 'mail', note: 'nota' };
const projTag = p => h('a.tag', { href: `#/p/${p.id}`, onclick: stop, style: `--h:${projHue(p)}` }, `@${p.tag}`);
const STATUS_LABEL = { open: 'Aperti', paused: 'In pausa', closed: 'Chiusi' };
export { DOC_KINDS } from './core.js';

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

function toggleOpen(id) {
  ui.open.has(id) ? ui.open.delete(id) : ui.open.add(id);
  render();
}

function toggleDone(e) {
  if (e.kind === 'mail') return advanceMail(e);
  const done = !e.done_at;
  patchEntry(e, { done });
  if (done) toast('Fatto', { action: { label: 'Annulla', fn: () => patchEntry(e, { done: false }) } });
}

// Le mail hanno un tasto solo che le fa avanzare: da mandare → in attesa di risposta → in archivio (risposta
// arrivata). Su una mail in archivio lo stesso tasto la rimette in attesa; la freccia ↑ la riporta da mandare.
function advanceMail(e) {
  if (!e.done_at) {
    patchEntry(e, { done: true });
    toast('Mail inviata: in attesa di risposta', { action: { label: 'Nessuna risposta', fn: () => patchEntry(e, { awaiting: false }) } });
  } else if (e.awaiting_reply) {
    patchEntry(e, { awaiting: false });
    toast('Risposta arrivata: mail in archivio', { action: { label: 'Annulla', fn: () => patchEntry(e, { awaiting: true }) } });
  } else {
    patchEntry(e, { awaiting: true });
    toast('Di nuovo in attesa di risposta');
  }
}

const MAIL_STEP = {
  open: { title: 'Segna come inviata (poi resta in attesa di risposta)', icon: 'mail' },
  waiting: { title: 'Risposta arrivata: sposta in archivio', icon: 'wait' },
  archived: { title: 'Rimetti in attesa di risposta', icon: 'check' },
};
const mailStep = e => (!e.done_at ? 'open' : e.awaiting_reply ? 'waiting' : 'archived');

// Freccia in fondo alla riga di una mail mandata: torna tra quelle da mandare (es. per un sollecito).
const mailUpBtn = e => h('button.icon-btn.mail-up', {
  title: 'Riporta tra le mail da mandare',
  onclick: ev => {
    stop(ev);
    patchEntry(e, { done: false });
    toast('Mail di nuovo da mandare', { action: { label: 'Annulla', fn: () => patchEntry(e, { done: true, awaiting: !!e.awaiting_reply }) } });
  },
}, icon('up'));

// Da quanto si aspetta una risposta (giorni dall'invio).
const waitingFor = e => {
  const days = Math.floor((Date.now() - Date.parse(e.done_at)) / 864e5);
  return days < 1 ? 'da oggi' : days === 1 ? 'da ieri' : `da ${days} giorni`;
};

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
  const projs = opt.showProject === false ? [] : projectsOf(e).filter(p => p.id !== opt.hideProject);
  const parent = opt.showParent && e.parent_id && D.entryById.get(e.parent_id);

  const meta = [];
  if (e.due && !(e.kind !== 'note' && e.done_at)) {
    const d = dueInfo(e.due);
    meta.push(h('span.due', { class: e.kind === 'note' ? null : d.cls }, icon('cal'), e.kind === 'note' ? fmtDay(e.due) : d.label));
  }
  if (e.done_at && e.kind !== 'note') meta.push(h('span.muted', `${e.kind === 'mail' ? 'inviata' : 'fatta'} ${fmtTime(e.done_at)}`));
  if (e.kind === 'mail' && e.done_at && e.awaiting_reply) meta.push(h('span.awaiting', icon('wait'), `in attesa di risposta ${waitingFor(e)}`));
  for (const p of projs) meta.push(projTag(p));
  if (e.kind === 'mail' && e.contact) meta.push(h('span.contact', { title: e.contact }, '→ ', contactNames(e.contact)));
  const atts = S.data.attachmentsOf.get(e.id);
  if (atts) meta.push(h('span.atts-n', { title: atts.map(a => a.filename).join(', ') }, icon('clip'), atts.length));
  if (e.assignee_id) meta.push(h('span.who', `+${userName(e.assignee_id)}`));
  if (kids.length) meta.push(h('span.kids', icon('check'), `${kids.filter(k => k.done_at).length}/${kids.length}`));
  if (logs.length) meta.push(h('span.logs', icon('log'), logs.length));
  if (e.notes) meta.push(h('span.has-notes', { title: 'Ha dettagli' }, '¶'));
  if (e.private) meta.push(h('span.priv', { title: 'Privata' }, icon('lock')));
  if (parent) meta.push(h('span.parent', { title: parent.title }, '↳ sotto-attività di ', h('b', parent.title)));
  if (e.pending) meta.push(h('span.pending', 'in coda offline'));

  const step = e.kind === 'mail' && MAIL_STEP[mailStep(e)];
  const check = e.kind === 'note'
    ? h('span.bullet')
    : h('button.check', {
      class: e.kind,
      title: step ? step.title : e.done_at ? 'Riapri' : 'Completa',
      onclick: () => toggleDone(e),
    }, step ? icon(step.icon) : e.done_at ? icon('check') : null);

  return h('div.entry', {
    class: [`k-${e.kind}`, e.done_at && 'done', e.done_at && e.awaiting_reply && 'waiting', open && 'open', e.pinned && 'pinned', opt.nested && 'nested'].filter(Boolean).join(' '),
  },
  h('div.row', check,
    h('div.body', { onclick: () => toggleOpen(e.id) },
      h('div.title',
        opt.showKind !== false && !opt.nested && h('span.kpill', { class: `k-${e.kind}` }, KIND_PILL[e.kind]),
        e.pinned ? icon('star', 'pin') : null, richText(e.title)),
      meta.length > 0 && h('div.meta', meta)),
    e.kind === 'mail' && e.done_at && !e.pending && mailUpBtn(e)),
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
      rows: 1, value: e.title, 'data-fk': `title-${e.id}`, spellcheck: 'false', 'data-ac': e.kind, 'data-ac-entry': e.id,
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
      !e.parent_id && h('div.f.projs', h('span', 'Progetti'),
        h('div.projs-b',
          projectsOf(e).map((p, i) => h('span.chip-wrap', { title: i === 0 ? 'Progetto principale' : null }, projTag(p),
            h('button.icon-btn.sm', { title: 'Togli da questo progetto', onclick: () => act(() => api('DELETE', `/entries/${e.id}/projects/${p.id}`)) }, icon('x')))),
          h('input.sub-in', {
            placeholder: '+ progetto', size: 12, 'data-fk': `eproj-${e.id}`, 'data-ac': 'project', autocomplete: 'off',
            onkeydown: enterAdd(text => {
              const p = D.projectByTag.get(text.replace(/^@/, '').toLowerCase());
              if (!p) return toast(`Il progetto @${text.replace(/^@/, '')} non esiste`, { err: true });
              act(() => api('POST', `/entries/${e.id}/projects`, { project_id: p.id }));
            }),
          }))),
      D.members.length > 1 && h('label.f', h('span', 'Assegnata'),
        selectOf(e.assignee_id ? String(e.assignee_id) : '', [['', '— nessuno —'], ...D.members.map(u => [String(u.id), u.name || u.username])],
          v => patchEntry(e, { assignee_id: v ? +v : null }))),
      h('button.chip', { class: e.pinned && 'on', onclick: () => patchEntry(e, { pinned: !e.pinned }) }, icon('star'), 'evidenza'),
      e.created_by === me.id && h('button.chip', { class: e.private && 'on', onclick: () => patchEntry(e, { private: !e.private }) }, icon('lock'), 'privata'),
      e.kind === 'mail' && e.done_at && h('button.chip', {
        class: e.awaiting_reply && 'on', title: 'La mail compare in "In attesa di risposta" finché non arriva la risposta',
        onclick: () => patchEntry(e, { awaiting: !e.awaiting_reply }),
      }, icon('mail'), 'attende risposta'),
    ),
    e.kind === 'mail' ? mailComposer(e) : richField({
      fk: `notes-${e.id}`, cls: 'ed-notes', rows: 1, value: e.notes, placeholder: 'Dettagli (facoltativo; #codice, [[ per collegare altro)…',
      attrs: { 'data-ac': e.kind, 'data-ac-only': '#', 'data-ac-entry': e.id }, onSave: notes => patchEntry(e, { notes }),
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
        'data-ac': e.kind, 'data-ac-only': '!#+', 'data-ac-entry': e.id, autocomplete: 'off',
        onkeydown: enterAdd(text => act(() => api('POST', `/entries/${e.id}/log`, { text, today: today() }))),
      })),
    backlinksBox('voce', e.id, { title: 'Citata in', compact: true }),
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

// Voce fatta da più di 30 giorni: non è nei dati sincronizzati, si legge dal server (sola lettura, si può riaprire).
const archived = new Map();
function archivedEntry(id) {
  if (!archived.has(id)) {
    archived.set(id, null);
    api('GET', `/entries/${id}`).then(e => { archived.set(id, e); render(); }, () => { archived.set(id, false); render(); });
  }
  const e = archived.get(id);
  if (e === null) return h('div.view', empty(h('p', 'Caricamento…')));
  if (!e) return h('div.view', empty(h('p', 'Voce non trovata: forse è stata eliminata (guarda nel cestino).')));
  return h('div.view.entry-page',
    h('div.sec-b.archived',
      h('div.arch-h', h('span.kpill', { class: `k-${e.kind}` }, KIND_PILL[e.kind]), h('b', richText(e.title))),
      h('p.muted', `${e.kind === 'mail' ? 'Mandata' : 'Fatta'} il ${fmtTime(e.done_at)}`, e.kind === 'mail' && e.contact ? [' a ', contactNames(e.contact)] : '',
        e.projects.length ? ' · ' : '', e.projects.map(p => projTag(p))),
      e.notes && h('div.arch-notes', richText(e.notes)),
      e.attachments.length > 0 && h('p.muted', icon('clip'), e.attachments.map(a => a.filename).join(', ')),
      h('div.toolbar', h('button.btn.sm', {
        onclick: () => act(async () => { await api('PATCH', `/entries/${id}`, { done: false }); archived.delete(id); }, 'Riaperta'),
      }, icon('restore'), e.kind === 'mail' ? 'Rimetti tra le mail da mandare' : 'Riapri'))));
}

// Una voce da sola, aperta (i link [[voce:ID]] e i backlink portano qui).
let autoOpened = null;
export function viewEntryPage(id) {
  const D = S.data;
  const e = D.entryById.get(+id);
  if (!e) return archivedEntry(+id);
  if (autoOpened !== e.id) {
    autoOpened = e.id;
    ui.open.add(e.id);
  }
  const parent = e.parent_id && D.entryById.get(e.parent_id);
  return h('div.view.entry-page',
    parent && h('p.muted', '↳ sotto-attività di ', h('a', { href: `#/v/${parent.id}` }, parent.title)),
    h('div.sec-b', entryRow(e)));
}

// ---------- backlink ----------
// Chi collega questo elemento: mail da mandare e mandate separate (per sapere se è già partito), poi todo e note.
// Comprende le voci archiviate; si aprono nella pagina della voce.
const BL_PILL = { todo: 'todo', mail: 'mail', note: 'nota' };

function blRow(e) {
  const when = e.kind === 'mail'
    ? (e.done_at ? `mandata ${fmtTime(e.done_at)}${e.awaiting_reply ? ', attende risposta' : ''}` : e.due ? dueInfo(e.due).label : '')
    : e.done_at ? `fatta ${fmtTime(e.done_at)}` : e.due ? (e.kind === 'note' ? fmtDay(e.due) : dueInfo(e.due).label) : '';
  return h('a.bl-row', { href: `#/v/${e.id}`, class: e.done_at && e.kind !== 'mail' ? 'done' : null },
    h('span.kpill', { class: `k-${e.kind}` }, BL_PILL[e.kind]),
    h('span.bl-t', plainRefs(e.title).replace(/(^|\s)#/g, '$1')),
    e.kind === 'mail' && e.contact && h('span.muted.bl-to', '→ ', contactNames(e.contact)),
    when && h('span.muted.bl-when', when));
}

export function backlinksBox(kind, id, { title = 'Collegato in', mailsOnly = false, compact = false } = {}) {
  const list = backlinks(kind, id);
  if (!list) return null;
  const drafts = list.filter(e => e.kind === 'mail' && !e.done_at);
  const sent = list.filter(e => e.kind === 'mail' && e.done_at);
  const others = mailsOnly ? [] : list.filter(e => e.kind !== 'mail');
  const total = drafts.length + sent.length + others.length;
  if (!total) return null;
  const group = (ic, label, rows) => rows.length > 0 && h('div.bl-g',
    h('div.bl-h', icon(ic), label, h('span.count', rows.length)), rows.map(blRow));
  const groups = [
    group('mail', 'Mail da mandare', drafts),
    group('send', 'Mail mandate', sent),
    group('log', 'Todo e note', others),
  ];
  return compact
    ? h('div.backlinks', h('div.bl-title', title), groups)
    : section(`bl-${kind}-${id}`, title, groups, { count: total });
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
      D.members.length > 1 && h('span.tsep'),
      D.members.length > 1 && h('button.chip', { class: ui.mine && 'on', onclick: () => { ui.mine = !ui.mine; save('org.mine', ui.mine); render(); } }, icon('user'), 'solo mie')),
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
    for (const p of projectsOf(e)) {
      const s = stats.get(p.id) || { open: 0, over: 0, next: null, last: '' };
      if (e.kind !== 'note' && !e.done_at && !e.parent_id) {
        s.open++;
        if (e.due && dayDiff(e.due) < 0) s.over++;
        if (e.due && (!s.next || e.due < s.next)) s.next = e.due;
      }
      if (e.updated_at > s.last) s.last = e.updated_at;
      stats.set(p.id, s);
    }
  }
  return stats;
}

// Statistiche di un progetto insieme a tutti i suoi sottoprogetti; ogni voce conta una volta sola
// anche se sta in più progetti dell'albero.
function deepStats(id) {
  const ids = new Set([id, ...descendants(id)]);
  const out = { open: 0, over: 0, next: null, last: '' };
  for (const e of S.data.entries) {
    if (!projectsOf(e).some(p => ids.has(p.id))) continue;
    if (e.kind !== 'note' && !e.done_at && !e.parent_id) {
      out.open++;
      if (e.due && dayDiff(e.due) < 0) out.over++;
      if (e.due && (!out.next || e.due < out.next)) out.next = e.due;
    }
    if (e.updated_at > out.last) out.last = e.updated_at;
  }
  return out;
}

function projectCard(p, stats, { compact = false, dnd = false } = {}) {
  const own = stats.get(p.id) || { open: 0 };
  const s = deepStats(p.id);
  const next = s.next && dueInfo(s.next);
  const subs = descendants(p.id).length;
  return h('a.card', { href: `#/p/${p.id}`, class: compact ? 'compact' : null, 'data-pid': dnd ? p.id : null, draggable: 'false' },
    h('div.card-h', h('span.card-t', p.name), p.private ? icon('lock') : null, p.status !== 'open' && h('span.muted', STATUS_LABEL[p.status].toLowerCase().replace(/i$/, 'o'))),
    h('div.card-tag', { style: `--h:${projHue(p)}` }, `@${p.tag}`),
    h('div.card-m',
      h('span', subs && s.open !== own.open ? `${s.open} aperte (${own.open} qui)` : `${s.open} aperte`),
      s.over > 0 && h('span.over', `${s.over} scadute`),
      next && h('span', { class: next.cls || null }, `prossima ${next.label}`),
      subs > 0 && h('span', `${subs} sotto`)));
}

export function viewProjects() {
  const D = S.data;
  const stats = projectStats();
  const counts = { open: 0, paused: 0, closed: 0 };
  for (const p of D.projects) counts[p.status]++;
  const lastOf = new Map(D.projects.map(p => [p.id, deepStats(p.id).last || p.updated_at])); // calcolato una volta, non a ogni confronto
  const last = p => lastOf.get(p.id);
  const inList = p => p.status === ui.projStatus;
  // Albero: radici = progetti dello stato scelto il cui padre non è anch'esso in elenco.
  const roots = D.projects.filter(p => inList(p) && !(p.parent_id && D.projectById.get(p.parent_id) && inList(D.projectById.get(p.parent_id))))
    .sort((a, b) => last(b).localeCompare(last(a)));
  const tree = (p, depth) => {
    const kids = (D.subprojects.get(p.id) || []).filter(inList).sort((a, b) => a.name.localeCompare(b.name));
    return h('div.ptree', { class: depth ? 'sub' : null },
      projectCard(p, stats, { dnd: true }),
      kids.length > 0 && h('div.pkids', kids.map(k => tree(k, depth + 1))));
  };

  return h('div.view',
    h('div.toolbar',
      Object.entries(STATUS_LABEL).map(([k, label]) =>
        h('button.chip', { class: ui.projStatus === k && 'on', onclick: () => { ui.projStatus = k; render(); } }, label, h('span.n', counts[k])))),
    !roots.length && empty(h('p', ui.projStatus === 'open'
      ? ['Nessun progetto aperto. Crealo dalla barra in alto (', kbd('Nome @padre'), ' per un sottoprogetto) o al volo scrivendo ', kbd('@nome'), ' in una voce.']
      : 'Nessun progetto qui.')),
    // La riga in cima è anche la zona di rilascio "progetto principale": ha sempre la stessa altezza,
    // così all'inizio del trascinamento l'elenco non si sposta sotto il puntatore.
    roots.length > 0 && h('div.proot',
      h('span.idle', matchMedia('(pointer: coarse)').matches
        ? 'Tieni premuto un progetto e trascinalo su un altro per spostarlo dentro.'
        : 'Trascina un progetto su un altro per spostarlo dentro.'),
      h('span.active', 'Rilascia qui per renderlo un progetto principale')),
    h('div.pforest', roots.map(p => tree(p, 0))));
}

// ---------- drag and drop dell'albero progetti ----------
draggable({
  handle: '.pforest .card[data-pid]',
  bodyClass: 'pdnd',
  data: el => +el.dataset.pid,
  ghost: id => {
    const p = S.data.projectById.get(id);
    return [h('span', p.name), h('span.tag', { style: `--h:${projHue(p)}` }, `@${p.tag}`)];
  },
  target: (el, id) => {
    const card = el.closest('.pforest .card[data-pid]');
    if (card) {
      const tid = +card.dataset.pid;
      return { el: card, value: tid, ok: tid !== id && !descendants(id).includes(tid) };
    }
    const root = el.closest('.proot');
    return root ? { el: root, value: null, ok: true } : null;
  },
  drop: (id, t) => {
    const p = S.data.projectById.get(id);
    const before = p.parent_id ?? null;
    if (before === t.value) return;
    const where = t.value ? `dentro @${S.data.projectById.get(t.value).tag}` : 'tra i principali';
    act(() => api('PATCH', `/projects/${id}`, { parent_id: t.value })).then(() => {
      toast(`@${p.tag} spostato ${where}`, { action: { label: 'Annulla', fn: () => act(() => api('PATCH', `/projects/${id}`, { parent_id: before })) } });
    });
  },
});

// ---------- drag and drop degli articoli tra le categorie (vista per categoria) ----------
draggable({
  handle: '.cat-cols .cat-item[data-iid]',
  bodyClass: 'idnd',
  data: el => +el.dataset.iid,
  onStart: () => hidePeek(),
  ghost: id => {
    const it = S.data.itemById.get(id);
    return [h('span.code', itemAttrs(it), it.code), h('span', it.name || '')];
  },
  target: (el, id) => {
    const col = el.closest('.cat-col[data-cat]');
    if (!col) return null;
    const it = S.data.itemById.get(id);
    return { el: col, value: col.dataset.cat, ok: col.dataset.new != null || col.dataset.cat !== (it.category || '') };
  },
  drop: (id, t) => {
    const it = S.data.itemById.get(id);
    const before = it.category || '';
    let category = t.value;
    if (t.el.dataset.new != null) {
      category = (prompt(`Nuova categoria per ${it.code}:`) || '').trim();
      if (!category) return;
    }
    if (category === before) return;
    act(() => api('PATCH', `/items/${id}`, { category })).then(() => {
      toast(`${it.code} → ${category || 'senza categoria'}`, { action: { label: 'Annulla', fn: () => act(() => api('PATCH', `/items/${id}`, { category: before })) } });
    });
  },
});

export function viewProject(id) {
  const D = S.data;
  const p = D.projectById.get(+id);
  if (!p) return empty(h('p', 'Progetto non trovato (o privato).'), h('a', { href: '#/progetti' }, 'Torna ai progetti'));
  const me = D.me;
  const subIds = descendants(p.id);
  const ids = new Set(ui.projDeep ? [p.id, ...subIds] : [p.id]);
  const es = D.entries.filter(e => projectsOf(e).some(x => ids.has(x.id)));
  const top = es.filter(e => !e.parent_id);
  const todos = top.filter(e => e.kind === 'todo' && !e.done_at).sort(byDue);
  const mails = top.filter(e => e.kind === 'mail' && !e.done_at).sort(byDue);
  const notes = top.filter(e => e.kind === 'note').sort(byNoteDesc);
  const waiting = top.filter(e => e.kind === 'mail' && e.done_at && e.awaiting_reply).sort((a, b) => a.done_at.localeCompare(b.done_at));
  const done = top.filter(e => e.kind !== 'note' && e.done_at && !(e.kind === 'mail' && e.awaiting_reply)).sort(byDoneDesc);
  const patch = f => act(() => api('PATCH', `/projects/${p.id}`, f));
  const rows = (arr, showKind = false) => arr.map(e => entryRow(e, { hideProject: p.id, showKind }));

  // Magazzino: collegati a mano (rimovibili) + citati con #CODICE nelle voci o collegati ai sottoprogetti.
  const manual = (D.itemsOfProject.get(p.id) || []).map(x => D.itemById.get(x.item_id)).filter(Boolean);
  const manualIds = new Set(manual.map(i => i.id));
  const other = new Set();
  for (const e of es) for (const x of D.itemsOfEntry.get(e.id) || []) other.add(x.item_id);
  if (ui.projDeep) for (const sid of subIds) for (const x of D.itemsOfProject.get(sid) || []) other.add(x.item_id);
  const cited = [...other].filter(i => !manualIds.has(i)).map(i => D.itemById.get(i)).filter(Boolean);

  const parentOptions = [['', '— nessuno (progetto principale) —'],
    ...D.projects.filter(x => x.id !== p.id && !subIds.includes(x.id)).sort((a, b) => a.tag.localeCompare(b.tag)).map(x => [String(x.id), `@${x.tag}`])];
  const kids = (D.subprojects.get(p.id) || []).sort((a, b) => a.name.localeCompare(b.name));
  const stats = projectStats();

  return h('div.view',
    ancestors(p.id).length > 0 && h('div.crumbs', ancestors(p.id).map(a => [projTag(a), h('span.muted', ' › ')])),
    h('div.head',
      h('a.icon-btn', { href: '#/progetti', title: 'Progetti (Esc)' }, icon('back')),
      // Colore del progetto dietro al pallino, come per le categorie del magazzino.
      h('button.cdot.big.pick.cat', {
        style: `--h:${projHue(p)}`, title: `Colore di @${p.tag}`,
        onclick: () => { ui.projPicker = ui.projPicker === p.id ? null : p.id; render(); },
      }),
      h('input.h-title', { value: p.name, 'data-fk': `pname-${p.id}`, onchange: ev => patch({ name: ev.target.value }) })),
    ui.projPicker === p.id && h('div.cat-pick', h('span.muted', `Colore di @${p.tag}: `),
      huePicker(p.hue ?? null, hue(p.tag), x => { ui.projPicker = null; patch({ hue: x }); })),
    h('div.fields',
      h('label.f', h('span', 'Tag @'), h('input.mono', { value: p.tag, size: 14, 'data-fk': `ptag-${p.id}`, onchange: ev => patch({ tag: ev.target.value }) })),
      h('label.f', h('span', 'Stato'), selectOf(p.status, [['open', 'Aperto'], ['paused', 'In pausa'], ['closed', 'Chiuso']], v => patch({ status: v }))),
      h('label.f', h('span', 'Dentro'), selectOf(p.parent_id ? String(p.parent_id) : '', parentOptions, v => patch({ parent_id: v ? +v : null }))),
      p.created_by === me.id && h('button.chip', { class: p.private && 'on', onclick: () => patch({ private: !p.private }) }, icon('lock'), 'privato'),
      h('span.grow'),
      (p.created_by === me.id || me.is_admin) && h('button.btn.sm.danger', {
        onclick: () => {
          if (!confirm(`Spostare @${p.tag} nel cestino? Le sue voci restano visibili, senza progetto.`)) return;
          trashIt('project', `/projects/${p.id}`, `@${p.tag}`).then(ok => { if (ok) location.hash = '#/progetti'; });
        },
      }, icon('trash'), 'Elimina')),
    richField({
      fk: `pnotes-${p.id}`, cls: 'proj-notes', value: p.notes, placeholder: 'Appunti di progetto: repo, IP delle schede, toolchain, riferimenti…',
      attrs: { 'data-ac': 'text', 'data-ac-only': '#' }, onSave: notes => patch({ notes }),
    }),
    section(`p${p.id}-subs`, 'Sottoprogetti', [
      kids.length > 0 && h('div.cards.subcards', kids.map(k => projectCard(k, stats, { compact: true }))),
      h('input.sub-in', {
        placeholder: '+ nuovo sottoprogetto (nome, Invio)', 'data-fk': `newsub-${p.id}`, autocomplete: 'off',
        onkeydown: enterAdd(name => act(() => api('POST', '/projects', { name, parent_id: p.id }))),
      }),
    ], { count: kids.length, collapsed: !kids.length }),
    subIds.length > 0 && h('div.toolbar',
      h('button.chip', { class: ui.projDeep && 'on', onclick: () => { ui.projDeep = !ui.projDeep; save('org.projDeep', ui.projDeep); render(); } },
        icon('folder'), 'includi le voci dei sottoprogetti')),
    section(`p${p.id}-todo`, 'Da fare', todos.length ? rows(todos) : [empty(h('p', 'Scrivi nella barra in alto: le voci finiscono in ', kbd(`@${p.tag}`), '.'))], { count: todos.length }),
    mails.length > 0 && section(`p${p.id}-mail`, 'Mail da mandare', rows(mails)),
    waiting.length > 0 && section(`p${p.id}-wait`, 'In attesa di risposta', rows(waiting), { cls: 'waiting' }),
    notes.length > 0 && section(`p${p.id}-notes`, 'Diario', rows(notes)),
    section(`p${p.id}-items`, 'Magazzino del progetto', [
      h('div.comp',
        h('div.item-chips', manual.map(i => h('span.chip-wrap', itemChip(i),
          h('button.icon-btn.sm', { title: 'Scollega dal progetto', onclick: () => act(() => api('DELETE', `/projects/${p.id}/items/${i.id}`)) }, icon('x'))))),
        h('input.sub-in.mono', {
          placeholder: '+ codice articolo', 'data-fk': `pitem-${p.id}`, size: 18, 'data-ac': 'code', autocomplete: 'off', autocapitalize: 'characters',
          onkeydown: enterAdd(code => act(() => api('POST', `/projects/${p.id}/items`, { code }))),
        })),
      cited.length > 0 && h('div.comp', h('span.muted', ui.projDeep && subIds.length ? 'Citati nelle voci e nei sottoprogetti' : 'Citati nelle voci'),
        h('div.item-chips', cited.map(itemChip))),
    ], { count: manual.length + cited.length }),
    backlinksBox('progetto', p.id, { title: 'Citato in' }),
    done.length > 0 && section(`p${p.id}-done`, 'Completate', rows(done, true), { collapsed: true }));
}

// ---------- mail ----------
export function viewMail() {
  const D = S.data;
  const open = D.entries.filter(e => e.kind === 'mail' && !e.done_at).sort(byDue);
  // Thread aperti: mandate e in attesa di risposta, dalla più vecchia (anche oltre i 30 giorni).
  const waiting = D.entries.filter(e => e.kind === 'mail' && e.done_at && e.awaiting_reply).sort((a, b) => a.done_at.localeCompare(b.done_at));
  const sent = D.entries.filter(e => e.kind === 'mail' && e.done_at && !e.awaiting_reply).sort(byDoneDesc);
  return h('div.view',
    pendingRows(p => p.kind === 'mail'),
    !open.length && empty(h('p', 'Nessuna mail da mandare.'), h('p', 'Esempio: ', kbd('offerta 50 schede >acquisti@ditta.it !ven'))),
    open.length > 0 && section('mail-open', 'Da mandare', open.map(e => entryRow(e, { showKind: false }))),
    waiting.length > 0 && section('mail-wait', 'In attesa di risposta', waiting.map(e => entryRow(e, { showKind: false })), { cls: 'waiting' }),
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
// Stato dell'articolo: pallino visibile negli elenchi (nessun pallino = attivo).
const ITEM_STATUS = { outdated: 'outdated', discarded: 'scartato' };
const statusDot = it => it?.status && h('span.sdot', { class: `s-${it.status}`, title: ITEM_STATUS[it.status] });

function itemChip(it) {
  if (!it) return null;
  return h('a.item-chip', { href: `#/i/${it.id}`, class: it.status ? `st-${it.status}` : null }, statusDot(it), h('span.code', itemAttrs(it), it.code), it.name && h('span', it.name), it.firmware && h('span.fw', `fw ${it.firmware}`));
}

function openCountOf(itemId) {
  const D = S.data;
  return (D.entriesOfItem.get(itemId) || []).filter(x => {
    const e = D.entryById.get(x.entry_id);
    return e && e.kind !== 'note' && !e.done_at;
  }).length;
}

const NO_CAT = 'Senza categoria';

function catColorPicker(cat) {
  const custom = S.data.catHueOf.get(cat.toLowerCase());
  return huePicker(custom ?? null, hue(cat.toLowerCase()), x => {
    ui.catPicker = null;
    act(() => api('PUT', '/categories/color', { name: cat, hue: x }));
  });
}

// ---------- scheda rapida al passaggio del mouse (solo con il mouse: su touch si apre la pagina) ----------
const peekBox = h('div.peek', { hidden: true });
let peekTimer = null;
let peekAnchor = null;

function hidePeek() {
  clearTimeout(peekTimer);
  peekAnchor = null;
  peekBox.hidden = true;
}

function peekContent(it) {
  const D = S.data;
  const docs = D.docsOf.get(it.id) || [];
  const fw = docs.find(d => d.kind === 'firmware' && !d.url);
  const projects = [
    ...(D.projectsOfItem.get(it.id) || []).map(x => D.projectById.get(x.project_id)),
    ...(D.entriesOfItem.get(it.id) || []).map(x => D.projectById.get(D.entryById.get(x.entry_id)?.project_id)),
  ].filter((p, i, a) => p && a.indexOf(p) === i);
  const open = (D.entriesOfItem.get(it.id) || []).map(x => D.entryById.get(x.entry_id))
    .filter(e => e && e.kind !== 'note' && !e.done_at).sort(byDue);
  const children = (D.childItems.get(it.id) || []).map(l => D.itemById.get(l.child_id)).filter(Boolean);
  const parents = (D.parentItems.get(it.id) || []).map(l => D.itemById.get(l.parent_id)).filter(Boolean);
  const row = (label, ...val) => h('div.peek-r', h('span.muted', label), h('span', ...val));
  const codes = list => list.slice(0, 6).map(c => h('span.code', itemAttrs(c), c.code)).concat(list.length > 6 ? [h('span.muted', `+${list.length - 6}`)] : []);

  return [
    h('div.peek-h', h('span.code', itemAttrs(it), it.code), it.category && h('span.peek-cat', h('span.cdot.cat', { style: catStyle(it.category) }), it.category)),
    h('div.peek-name', it.name || h('span.muted', 'senza descrizione')),
    it.status && h('div.peek-status', statusDot(it), ITEM_STATUS[it.status]),
    h('div.peek-grid',
      it.firmware && row('Firmware', h('span.mono', it.firmware), fw && h('span.muted', ` · ${fw.filename}`)),
      it.location && row('Posizione', it.location),
      it.url && row('Link', it.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)),
      it.qty != null && row('Quantità', String(it.qty)),
      docs.length > 0 && row('Documenti', `${docs.length}`, h('span.muted', ` · ${[...new Set(docs.map(d => d.kind))].join(', ')}`)),
      projects.length > 0 && row('Progetti', projects.map(p => h('span.tag', { style: `--h:${projHue(p)}` }, `@${p.tag}`))),
      children.length > 0 && row('Contiene', codes(children)),
      parents.length > 0 && row('Usato in', codes(parents)),
      open.length > 0 && row('Da fare', `${open.length}`, h('span.muted', ` · ${open[0].title.replace(/(^|\s)#/g, '$1').slice(0, 48)}`))),
    it.notes && h('div.peek-notes', it.notes.length > 280 ? `${it.notes.slice(0, 280)}…` : it.notes),
  ];
}

function placePeek() {
  const r = peekAnchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = peekBox.offsetWidth;
  const ph = peekBox.offsetHeight;
  // A destra dell'elemento se c'è spazio (vista a colonne), altrimenti sotto o sopra (vista a lista).
  if (r.right + 12 + w < vw - 8) {
    peekBox.style.left = `${r.right + 12}px`;
    peekBox.style.top = `${Math.max(8, Math.min(r.top - 8, vh - ph - 8))}px`;
  } else {
    peekBox.style.left = `${Math.max(8, Math.min(r.left + 120, vw - w - 8))}px`;
    peekBox.style.top = `${r.bottom + 6 + ph < vh - 8 ? r.bottom + 6 : Math.max(8, r.top - ph - 6)}px`;
  }
}

function peekable(el, it) {
  el.addEventListener('pointerenter', ev => {
    if (ev.pointerType !== 'mouse') return;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      if (!el.isConnected) return;
      if (!peekBox.isConnected) document.body.append(peekBox);
      peekAnchor = el;
      peekBox.replaceChildren(...peekContent(it));
      peekBox.hidden = false;
      placePeek();
    }, 250);
  });
  el.addEventListener('pointerleave', hidePeek);
  el.addEventListener('click', hidePeek);
  return el;
}

window.addEventListener('hashchange', hidePeek);
window.addEventListener('scroll', hidePeek, true);
// Se la lista viene ridisegnata (sincronizzazione) mentre la scheda è aperta, l'elemento sotto il mouse cambia.
document.addEventListener('pointermove', () => { if (peekAnchor && !peekAnchor.isConnected) hidePeek(); });

function itemRow(i) {
  const D = S.data;
  const n = openCountOf(i.id);
  const docs = (D.docsOf.get(i.id) || []).length;
  return peekable(h('a.item-row', { href: `#/i/${i.id}`, class: i.status ? `st-${i.status}` : null },
    statusDot(i),
    h('span.code', itemAttrs(i), i.code),
    h('span.name', i.name || h('span.muted', 'senza descrizione')),
    h('span.item-meta',
      i.firmware && h('span.fw', icon('chip'), i.firmware),
      i.location && h('span.loc', i.location),
      i.qty != null && h('span.qty', `×${i.qty}`),
      docs > 0 && h('span.docs', icon('link'), docs),
      n > 0 && h('span.badge', n))), i);
}

export function viewItems() {
  const D = S.data;
  const f = ui.itemFilter.trim().toLowerCase();
  const docNames = id => (D.docsOf.get(id) || []).map(d => `${d.filename || ''} ${d.label} ${d.version}`).join(' ');
  const cats = new Map();
  for (const i of D.items) cats.set(i.category || '', (cats.get(i.category || '') || 0) + 1);
  if (ui.itemCat != null && !cats.has(ui.itemCat)) ui.itemCat = null;
  const statusCount = { outdated: 0, discarded: 0 };
  for (const i of D.items) if (statusCount[i.status] != null) statusCount[i.status]++;
  if (ui.itemStatusF && !statusCount[ui.itemStatusF]) ui.itemStatusF = null;
  const items = D.items
    .filter(i => (ui.itemStatusF ? i.status === ui.itemStatusF : !(ui.hideDiscarded && i.status === 'discarded')))
    .filter(i => ui.itemCat == null || (i.category || '') === ui.itemCat)
    .filter(i => !f || [i.code, i.name, i.category, i.firmware, i.location, i.notes, docNames(i.id)].join(' ').toLowerCase().includes(f));
  const setView = v => { ui.itemView = v; save('org.itemView', v); render(); };

  // Vista per categoria: una colonna per tipo di articolo (affiancate sugli schermi larghi).
  const groups = new Map();
  for (const i of items) {
    const c = i.category || '';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(i);
  }
  const ordered = [...groups].sort(([a], [b]) => (!a) - (!b) || a.localeCompare(b));

  return h('div.view',
    h('div.toolbar',
      h('input.filter', {
        type: 'search', placeholder: 'Filtra per codice, nome, firmware, posizione, documento…', value: ui.itemFilter, 'data-fk': 'itemfilter',
        oninput: ev => { ui.itemFilter = ev.target.value; render(); },
      }),
      h('div.seg',
        h('button', { class: ui.itemView === 'list' && 'on', onclick: () => setView('list'), title: 'Elenco' }, icon('log')),
        h('button', { class: ui.itemView === 'groups' && 'on', onclick: () => setView('groups'), title: 'Per categoria' }, icon('cols'))),
      h('a.btn.ghost', { href: '#/documenti', title: 'Tutti i documenti, per la revisione' }, icon('file'), h('span.only-wide', 'Documenti'))),
    ui.itemView === 'groups' && D.items.length > 1 && h('p.muted.dnd-hint', 'Trascina un articolo in un\'altra colonna per cambiargli categoria; clicca il pallino colorato per cambiarne il colore.'),
    cats.size > 1 && h('div.toolbar.cats',
      [...cats].sort(([a], [b]) => (!a) - (!b) || a.localeCompare(b)).map(([c, n]) =>
        h('button.chip', { class: ui.itemCat === c && 'on', onclick: () => { ui.itemCat = ui.itemCat === c ? null : c; render(); } },
          h('span.cdot', { class: c ? 'cat' : null, style: catStyle(c) }), c || NO_CAT, h('span.n', n)))),
    (statusCount.outdated > 0 || statusCount.discarded > 0) && h('div.toolbar.cats',
      Object.entries(ITEM_STATUS).filter(([k]) => statusCount[k]).map(([k, label]) =>
        h('button.chip', { class: ui.itemStatusF === k && 'on', title: `Solo gli articoli ${label}`, onclick: () => { ui.itemStatusF = ui.itemStatusF === k ? null : k; render(); } },
          h('span.sdot', { class: `s-${k}` }), label, h('span.n', statusCount[k]))),
      statusCount.discarded > 0 && h('button.chip', {
        class: ui.hideDiscarded && 'on',
        onclick: () => { ui.hideDiscarded = !ui.hideDiscarded; save('org.hideDiscarded', ui.hideDiscarded); render(); },
      }, 'nascondi scartati')),
    !D.items.length && empty(
      h('p', 'Il magazzino è vuoto.'),
      h('p', 'Aggiungi articoli dalla barra in alto: ', kbd('SCH-042 scheda motori /scheda'), '.'),
      h('p', 'Ogni ', kbd('#CODICE'), ' scritto in una voce crea e collega automaticamente l\'articolo.')),
    D.items.length > 0 && !items.length && empty(h('p', 'Nessun articolo corrisponde al filtro.')),
    ui.itemView === 'groups'
      ? h('div.cat-cols', ordered.map(([c, list]) => h('section.cat-col', { class: c ? 'cat' : null, style: catStyle(c), 'data-cat': c },
        h('div.cat-h',
          c ? h('button.cdot.pick', { class: 'cat', style: catStyle(c), title: 'Cambia colore della categoria', onclick: () => { ui.catPicker = ui.catPicker === c ? null : c; render(); } })
            : h('span.cdot'),
          h('span', c || NO_CAT), h('span.count', list.length)),
        c && ui.catPicker === c && h('div.cat-pick', catColorPicker(c)),
        h('div.cat-items', list.map(i => peekable(h('a.cat-item', { href: `#/i/${i.id}`, 'data-iid': i.id, draggable: 'false', class: i.status ? `st-${i.status}` : null },
          statusDot(i),
          h('span.code', itemAttrs(i), i.code),
          h('span.name', i.name || ''),
          i.firmware && h('span.fw', i.firmware),
          openCountOf(i.id) > 0 && h('span.badge', openCountOf(i.id))), i)))))
        // Visibile solo durante il trascinamento: rilasciando qui si crea una categoria nuova.
        .concat(h('section.cat-col.cat-new', { 'data-cat': '', 'data-new': '' }, h('div.cat-h', icon('plus'), 'Nuova categoria'))))
      : h('div.items', items.map(itemRow)));
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
      selectOf(ui.docKind, [...docKinds().map(k => [k, k]), ['+', '+ nuovo tipo…']], async v => {
        ui.docKind = v === '+' ? (await newDocKind()) || ui.docKind : v;
        render();
      }),
      h('input', { placeholder: 'versione', size: 9, value: ui.docVer, 'data-fk': `docver-${it.id}`, oninput: ev => { ui.docVer = ev.target.value; } }),
      h('button.btn', { onclick: () => fileInput.click() }, icon('upload'), 'File'),
      h('button.btn.ghost', { onclick: addLink }, icon('link'), 'Link'),
      fileInput),
    !docs.length && h('p.muted.drop-hint', 'Trascina qui i file, oppure usa i pulsanti. Un firmware con versione aggiorna il campo "Firmware".'),
    docs.map(d => h('div.doc',
      docMeta(d),
      h('div.doc-main',
        h('span.doc-name',
          h('a', { href: `#/d/${d.id}`, title: 'Apri con le note' }, docName(d)),
          h('button.icon-btn.sm', { title: 'Rinomina', onclick: () => renameDoc(d) }, icon('edit'))),
        h('div.meta',
          d.label && d.filename && h('span', d.filename),
          d.size != null && h('span', fmtSize(d.size)),
          d.sha256 && h('button.sha', { title: `sha256 ${d.sha256} (clic per copiare)`, onclick: () => copy(d.sha256) }, d.sha256.slice(0, 10)),
          (() => {
            const n = (D.docNotesOf.get(d.id) || []).filter(x => !x.resolved_at).length;
            return n > 0 && h('a.doc-notes', { href: `#/d/${d.id}`, title: 'Note sul documento' }, icon('log'), n);
          })(),
          h('span', fmtTime(d.created_at)))),
      !d.url && h('a.icon-btn', { href: docFileUrl(d), title: 'Scarica', download: '' }, icon('download')),
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
  // Le mail stanno nel riquadro "Nelle mail" (da mandare / mandate), con anche quelle che citano il codice senza #.
  const open = linked.filter(e => e.kind === 'todo' && !e.done_at).sort(byDue);
  const notes = linked.filter(e => e.kind === 'note').sort(byNoteDesc);
  const done = linked.filter(e => e.kind === 'todo' && e.done_at).sort(byDoneDesc);
  const manualProjects = (D.projectsOfItem.get(it.id) || []).map(x => D.projectById.get(x.project_id)).filter(Boolean);
  const viaEntries = [...new Set(linked.map(e => e.project_id).filter(Boolean))]
    .filter(pid => !manualProjects.some(p => p.id === pid)).map(pid => D.projectById.get(pid)).filter(Boolean);
  const linkProject = text => {
    const p = D.projectByTag.get(text.replace(/^@/, '').toLowerCase());
    if (!p) return toast(`Il progetto @${text.replace(/^@/, '')} non esiste`, { err: true });
    act(() => api('POST', `/projects/${p.id}/items`, { code: it.code }));
  };

  return h('div.view',
    h('div.head',
      h('a.icon-btn', { href: '#/magazzino', title: 'Magazzino (Esc)' }, icon('back')),
      it.category && h('button.cdot.big.pick', {
        class: 'cat', style: catStyle(it.category), title: `Colore della categoria "${it.category}"`,
        onclick: () => { ui.catPicker = ui.catPicker === it.category ? null : it.category; render(); },
      }),
      h('input.h-title.mono', { value: it.code, 'data-fk': `icode-${it.id}`, onchange: ev => patch({ code: ev.target.value }) }),
      h('button.icon-btn', { title: 'Copia codice', onclick: () => copy(it.code) }, icon('copy')),
      h('div.seg.status-seg', { title: 'Stato dell\'articolo' },
        [['', 'attivo'], ['outdated', 'outdated'], ['discarded', 'scartato']].map(([k, label]) =>
          h('button', { class: (it.status || '') === k && 'on', onclick: () => patch({ status: k }) }, k && h('span.sdot', { class: `s-${k}` }), label)))),
    it.category && ui.catPicker === it.category && h('div.cat-pick', h('span.muted', `Colore della categoria "${it.category}" (vale per tutti i suoi articoli): `), catColorPicker(it.category)),
    h('div.grid',
      field('name', 'Descrizione', { placeholder: 'es. scheda controllo motori' }),
      field('category', 'Categoria', { placeholder: 'scheda, prodotto, cavo…', list: 'item-cats' }),
      field('firmware', 'Firmware', { placeholder: 'versione attuale', class: 'mono' }),
      field('location', 'Posizione', { placeholder: 'scaffale, cassetto…' }),
      field('qty', 'Quantità', { type: 'number', inputmode: 'numeric' }),
      h('label.f', h('span', 'Link (facoltativo)'),
        h('span.url-f',
          h('input', { value: it.url || '', type: 'url', placeholder: 'pagina prodotto, repo, wiki…', 'data-fk': `it-url-${it.id}`, onchange: ev => patch({ url: ev.target.value.trim() }) }),
          it.url && h('a.icon-btn', { href: it.url, target: '_blank', rel: 'noopener noreferrer', title: 'Apri il link' }, icon('link')))),
      h('datalist#item-cats', [...new Set(D.items.map(i => i.category).filter(Boolean))].map(c => h('option', { value: c })))),
    richField({
      fk: `inotes-${it.id}`, cls: 'proj-notes', value: it.notes, placeholder: 'Note: pinout, jumper, procedura di flash, password di default…',
      attrs: { 'data-ac': 'text', 'data-ac-only': '#' }, onSave: notes => patch({ notes }),
    }),
    docSection(it),
    section('i-comp', 'Composizione', [
      h('div.comp',
        h('span.muted', 'Contiene'),
        h('div.item-chips', children.map(c => h('span.chip-wrap', itemChip(c),
          h('button.icon-btn.sm', { title: 'Scollega', onclick: () => act(() => api('DELETE', `/items/${it.id}/children/${c.id}`)) }, icon('x'))))),
        h('input.sub-in.mono', {
          placeholder: '+ codice componente (nuovo se non esiste)', 'data-fk': `child-${it.id}`, size: 22,
          'data-ac': 'code', 'data-ac-self': it.code, autocomplete: 'off', autocapitalize: 'characters',
          onkeydown: enterAdd(code => act(() => api('POST', `/items/${it.id}/children`, { code }))),
        })),
      parents.length > 0 && h('div.comp', h('span.muted', 'Usato in'), h('div.item-chips', parents.map(itemChip))),
    ], { count: children.length + parents.length }),
    section('i-proj', 'Progetti', [
      h('div.comp',
        h('div.item-chips', manualProjects.map(p => h('span.chip-wrap', projTag(p),
          h('button.icon-btn.sm', { title: 'Scollega dal progetto', onclick: () => act(() => api('DELETE', `/projects/${p.id}/items/${it.id}`)) }, icon('x'))))),
        h('input.sub-in', {
          placeholder: '+ collega a un progetto', 'data-fk': `iproj-${it.id}`, size: 20, 'data-ac': 'project', autocomplete: 'off',
          onkeydown: enterAdd(linkProject),
        })),
      viaEntries.length > 0 && h('div.comp', h('span.muted', 'Citato in voci di'), h('div.item-chips', viaEntries.map(projTag))),
    ], { count: manualProjects.length + viaEntries.length }),
    section('i-todo', 'Da fare', open.length ? open.map(e => entryRow(e)) : [empty(h('p', 'Scrivi nella barra in alto: le voci verranno collegate a ', kbd(`#${it.code}`), '.'))], { count: open.length }),
    backlinksBox('articolo', it.id, { title: 'Nelle mail', mailsOnly: true }),
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
  const docNotes = D.docNotes.filter(n => has(n.text) && D.docById.has(n.doc_id));
  const items = D.items.filter(i => [i.code, i.name, i.category, i.firmware, i.location, i.notes].some(has)
    || (D.docsOf.get(i.id) || []).some(d => has(d.filename) || has(d.label) || has(d.version)));

  return h('div.view',
    projects.length > 0 && section('s-proj', 'Progetti', [h('div.item-chips', projects.map(p => h('a.item-chip', { href: `#/p/${p.id}` }, h('span', p.name), h('span.code', `@${p.tag}`))))], { count: projects.length }),
    items.length > 0 && section('s-items', 'Magazzino', [h('div.item-chips', items.map(itemChip))], { count: items.length }),
    docNotes.length > 0 && section('s-docnotes', 'Note sui documenti', docNotes.slice(0, 50).map(n => {
      const d = D.docById.get(n.doc_id);
      return h('a.search-note', { href: `#/d/${d.id}?n=${n.id}` },
        h('span.muted', `${d.label || d.filename}${n.page ? ` · pag. ${n.page}` : ''}`), h('span', n.text));
    }), { count: docNotes.length }),
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

function loadTokens() {
  ui.tokens = [];
  api('GET', '/tokens').then(r => { ui.tokens = r; render(); }).catch(() => {});
}

// Token per la CLI e per i programmi esterni (bot, script): si vede una volta sola, alla creazione.
function tokensSection() {
  if (ui.tokens == null) loadTokens();
  const create = () => {
    const name = prompt('Nome del token (es. "bot telegram", "script backup"):');
    if (!name?.trim()) return;
    act(async () => {
      const r = await api('POST', '/tokens', { name });
      loadTokens();
      prompt('Copia il token adesso: non verrà più mostrato.', r.token);
    });
  };
  return section('set-tokens', 'CLI e token API', [
    h('p', 'Dal terminale: installa la CLI con ', kbd('make cli'), ' e accedi con ', kbd(`org login ${location.origin}`), '.'),
    h('p.muted', 'Per un bot o uno script crea un token: dà accesso a tutto ciò che vedi tu, in tutti i tuoi workspace. Le API sono descritte in docs/API.md.'),
    h('button.btn', { onclick: create }, icon('plus'), 'Crea token'),
    ui.tokens.map(t => h('div.invite',
      h('code', `…${t.hint}`),
      h('span', t.name),
      h('span.muted', t.last_used_at ? `usato ${fmtTime(t.last_used_at)}` : 'mai usato'),
      h('span.grow'),
      h('button.icon-btn', {
        title: 'Revoca',
        onclick: () => { if (confirm(`Revocare il token "${t.name}"? Chi lo usa non potrà più accedere.`)) act(async () => { await api('DELETE', `/tokens/${t.id}`); loadTokens(); }, 'Token revocato'); },
      }, icon('x')))),
  ], { count: ui.tokens.length || '', collapsed: true });
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

    section('set-contacts', 'Contatti', [
      h('div.grid', h('label.f', h('span', 'Colore dei contatti'),
        selectOf(ui.contactColor, Object.entries(CONTACT_COLOR), v => { ui.contactColor = v; save('org.contactColor', v); render(); }))),
      h('p.muted', 'Il nome dei contatti è colorato nelle mail, in rubrica e nei collegamenti. Per azienda, fascia oraria o ruolo: stesso colore per chi ha lo stesso valore (senza quel dato, nessun colore). Vale per questo dispositivo.'),
    ], { count: '', collapsed: true }),

    section('set-mail', 'Mail e Thunderbird', [
      h('p', '"Manda" apre la mail già compilata in Thunderbird, allegati compresi. Serve un piccolo helper sul computer, da installare una volta dalla cartella del progetto:'),
      h('p', kbd('make mail-helper')),
      h('label.check-row',
        h('input', { type: 'checkbox', checked: ui.mailHelper, onchange: ev => { ui.mailHelper = ev.target.checked; save('org.mailHelper', ui.mailHelper); render(); } }),
        'Helper Thunderbird installato su questo computer'),
      h('p.muted', 'Senza helper (per esempio dal telefono) "Manda" usa l\'app mail predefinita, ma senza allegati: per quelli c\'è il pulsante ".eml".'),
    ], { count: '', collapsed: true }),

    workspaceSection(D),

    tokensSection(),

    section('set-users', `Persone in "${D.workspace.name}"`, [
      D.members.map(u => h('div.user-row',
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
            onclick: () => { if (confirm(`Togliere ${u.username} da "${D.workspace.name}"? Le sue voci restano; il suo account e gli altri workspace no.`)) act(() => api('DELETE', `/admin/users/${u.id}`)); },
          }, 'Togli'),
        ])),
      me.is_admin && h('div.invites',
        h('p.muted', `Per far entrare qualcuno in "${D.workspace.name}" crea un invito e mandagli il link (valido 7 giorni, una sola persona). Chi ha già un account entra con le sue credenziali.`),
        h('button.btn', { onclick: () => act(async () => { const r = await api('POST', '/admin/invites'); loadInvites(); share(inviteLink(r.code)); }) }, icon('plus'), 'Crea invito'),
        (ui.invites || []).map(i => h('div.invite',
          h('code', i.code),
          h('span.muted', `scade ${fmtTime(i.expires_at)}`),
          h('span.grow'),
          h('button.icon-btn', { title: 'Copia link', onclick: () => share(inviteLink(i.code)) }, icon('copy')),
          h('button.icon-btn', { title: 'Revoca', onclick: () => act(async () => { await api('DELETE', `/admin/invites/${i.code}`); loadInvites(); }) }, icon('x'))))),
    ], { count: D.members.length }),

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

    me.is_admin && section('set-admin', 'Backup e ripristino', [
      h('p.muted', 'Il backup contiene voci, progetti, magazzino, contatti e utenti. I file caricati (documenti, allegati) restano sul server: per una copia completa usa ', kbd('make backup'), '.'),
      h('div.toolbar',
        h('a.btn', { href: 'api/admin/backup', download: '' }, icon('download'), 'Scarica backup'),
        h('button.btn.danger', { onclick: () => restoreInput.click() }, icon('restore'), 'Ripristina da backup…')),
      h('p.muted', 'Il ripristino sostituisce tutti i dati con quelli del file .db scelto (anche di una versione precedente dell\'app). Vale solo per questo workspace; prima il server salva una copia di sicurezza dei dati attuali. Account e membri non cambiano.'),
      restoreInput,
    ], { count: '', collapsed: true }),

    h('div.danger-zone',
      h('span.muted', `Connesso come ${me.username}`),
      h('button.btn.sm', { onclick: () => window.dispatchEvent(new Event('org:logout')) }, icon('logout'), 'Esci')));
}

const restoreInput = h('input', {
  type: 'file', accept: '.db,application/octet-stream', hidden: true,
  onchange: async ev => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f || !confirm(`Ripristinare "${f.name}"? Tutti i dati attuali verranno sostituiti (resta una copia di sicurezza sul server).`)) return;
    toast('Ripristino in corso…');
    try {
      const r = await api('POST', '/admin/restore', f);
      alert(`Backup ripristinato.${r.missing ? ` ${r.missing} documenti o allegati non hanno il file sul server.` : ''}\nCopia di sicurezza: ${r.safetyCopy}`);
      location.reload();
    } catch (e) {
      toast(e.message, { err: true });
    }
  },
});

function workspaceSection(D) {
  const ws = D.workspace;
  const admin = ws.role === 'admin';
  return section('set-ws', 'Workspace', [
    h('div.grid',
      h('label.f', h('span', 'Nome'), h('input', {
        value: ws.name, disabled: !admin, 'data-fk': 'wsname',
        onchange: ev => act(() => api('PATCH', `/workspaces/${ws.id}`, { name: ev.target.value })),
      })),
      h('label.f', h('span', 'Il tuo ruolo'), h('input', { value: admin ? 'admin' : 'membro', disabled: true }))),
    h('div.ws-list', D.workspaces.map(w => h('div.user-row',
      icon('folder'), h('span', w.name), h('span.muted', w.role === 'admin' ? 'admin' : 'membro'),
      h('span.grow'),
      w.id === ws.id ? h('span.chip.on', 'attivo') : h('button.btn.sm', { onclick: () => switchWorkspace(w.id) }, 'Apri')))),
    h('div.toolbar',
      h('button.btn', { onclick: newWorkspace }, icon('plus'), 'Nuovo workspace'),
      h('span.grow'),
      h('button.btn.sm.ghost', {
        onclick: () => {
          if (!confirm(`Uscire da "${ws.name}"? Per rientrare servirà un nuovo invito.`)) return;
          act(async () => { await api('POST', `/workspaces/${ws.id}/leave`); location.hash = '#/agenda'; location.reload(); });
        },
      }, 'Esci dal workspace'),
      admin && h('button.btn.sm.danger', {
        onclick: () => {
          const name = prompt(`Eliminare "${ws.name}" per tutti i membri? Scrivi il nome del workspace per confermare:`);
          if (name == null) return;
          act(async () => { await api('DELETE', `/workspaces/${ws.id}`, { confirm: name }); location.hash = '#/agenda'; location.reload(); });
        },
      }, icon('trash'), 'Elimina workspace')),
  ], { count: D.workspaces.length });
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
