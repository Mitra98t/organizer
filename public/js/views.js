import {
  h, icon, S, ui, RS, api, act, render, richText, mdText, dueInfo, dayDiff, fmtDay, fmtLongDay, fmtTime, fmtSize,
  userName, toast, save, patchEntry, addEntry, isMine, localDay, autosize, stop, copy, hue, trashIt, contactNames, shareBox, sharedWithOf,
  popButton, popItem, popSep,
  updatePending, removePending,
  descendants, ancestors, catStyle, itemAttrs, docFileUrl, projectsOf, DOC_KINDS, kindLabel, projHue, catHue, huePicker,
  switchWorkspace, newWorkspace, docName, renameDoc, richField, backlinks, plainRefs, CONTACT_COLOR, masonry, filterChip, aliasCodes, kindPicker, can, canEntry, roClass,
  fold, foldBar, capFirst, askConfirm, askText, askFields, notice, showText, openBlockers, isWaiting, waitersOf, isReadOnly,
} from './core.js';
import { docMeta, docPeek } from './docview.js';
import { openFeedback } from './feedback.js';
import { pushState, enablePush, disablePush } from './notifiche.js';
import { today, addDays, parseQuick } from './parse.js';
import { mailComposer, mailSide } from './mail.js';
import { threadLink, threadInfo, threadSubject, topicTitle } from './topics.js';
import { THEMES, BASE_THEMES, currentTheme, setTheme } from './themes.js';
import { APP_ICONS, currentIcon, setIcon, applyIcon, themeIcon } from './appicons.js';
import { AREAS, LEVELS, CAPS, WRITE_NEEDS, READ_NEEDS, PRIVACY_NOTE, fullAccess, setLevel, isRestricted } from './perms.js';
import { draggable } from './dnd.js';
import { moveDoc } from './pickers.js';
import { openBrowser } from './web.js';
import { startTour, deleteTour, tourState } from './tour.js';
import { tr, trn, LANG, LANGS, setLang } from './i18n.js';

const KIND_LABEL = { todo: tr('Todo'), mail: tr('Mail'), note: tr('Note') };
const KIND_PILL = { todo: 'todo', mail: 'mail', note: 'nota' };
const projTag = p => h('a.tag', { href: `#/p/${p.id}`, onclick: stop, style: `--h:${projHue(p)}` }, `@${p.tag}`);
const STATUS_LABEL = { open: tr('Open||project status'), paused: tr('Paused'), closed: tr('Closed') };
const STATUS_ONE = { paused: tr('paused||one project'), closed: tr('closed||one project') }; // on a single project's card
export { DOC_KINDS } from './core.js';

const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || b.pinned - a.pinned || a.id - b.id;
const byRecent = (a, b) => b.pinned - a.pinned || b.updated_at.localeCompare(a.updated_at);
const byDoneDesc = (a, b) => b.done_at.localeCompare(a.done_at);
const noteDay = e => e.due || localDay(e.created_at);
const byNoteDesc = (a, b) => noteDay(b).localeCompare(noteDay(a)) || b.id - a.id;

// ---------- shared blocks ----------
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
  if (e.pending) return updatePending(e.id, { done: e.done_at ? null : new Date().toISOString() });
  if (e.kind === 'mail') return advanceMail(e);
  const done = !e.done_at;
  patchEntry(e, { done });
  if (done) toast(tr('Done'), { action: { label: tr('Undo'), fn: () => patchEntry(e, { done: false }) } });
}

// Mails have a single button that moves them forward: to send → awaiting reply → in the archive (reply received).
// On an archived mail the same button puts it back awaiting a reply; the ↑ arrow brings it back to the ones to send.
function advanceMail(e) {
  if (!e.done_at) {
    patchEntry(e, { done: true });
    toast(tr('Mail sent: awaiting reply'), { action: { label: tr('No reply'), fn: () => patchEntry(e, { awaiting: false }) } });
  } else if (e.awaiting_reply) {
    patchEntry(e, { awaiting: false });
    toast(tr('Reply received: mail archived'), { action: { label: tr('Undo'), fn: () => patchEntry(e, { awaiting: true }) } });
  } else {
    patchEntry(e, { awaiting: true });
    toast(tr('Awaiting reply again'));
  }
}

const MAIL_STEP = {
  open: { title: tr('Mark as sent (then it stays awaiting reply)'), icon: 'mail' },
  waiting: { title: tr('Reply received: move to the archive'), icon: 'wait' },
  archived: { title: tr('Put back awaiting reply'), icon: 'check' },
};
const mailStep = e => (!e.done_at ? 'open' : e.awaiting_reply ? 'waiting' : 'archived');

// Arrow at the end of a sent mail's row: back among the ones to send (e.g. for a reminder).
const mailUpBtn = e => h('button.icon-btn.mail-up', {
  title: tr('Back among the mails to send'),
  onclick: ev => {
    stop(ev);
    patchEntry(e, { done: false });
    toast(tr('Mail to send again'), { action: { label: tr('Undo'), fn: () => patchEntry(e, { done: true, awaiting: !!e.awaiting_reply }) } });
  },
}, icon('up'));

// How long a reply has been awaited (days since sending).
const waitingFor = e => {
  const days = Math.floor((Date.now() - Date.parse(e.done_at)) / 864e5);
  return days < 1 ? tr('since today') : days === 1 ? tr('since yesterday') : tr('for {n} days', { n: days });
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

// ---------- entry (todo / mail / note) ----------
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
    // Waiting for something: the date is not "overdue" (it cannot start yet).
    meta.push(h('span.due', { class: e.kind === 'note' || isWaiting(e) ? null : d.cls }, icon('cal'), e.kind === 'note' ? fmtDay(e.due) : d.label));
  }
  if (e.archived_at && !opt.inArchive) meta.push(h('span.muted.arch', icon('archive'), tr('archived')));
  if (e.eventually && !e.done_at && !opt.inEventually) meta.push(h('span.due.ev', icon('wait'), tr('eventually')));
  if (e.done_at && e.kind !== 'note') meta.push(h('span.muted', e.kind === 'mail' ? tr('sent {when}', { when: fmtTime(e.done_at) }) : tr('done {when}', { when: fmtTime(e.done_at) })));
  if (e.kind === 'mail' && e.done_at && e.awaiting_reply) meta.push(h('span.awaiting', icon('wait'), tr('awaiting reply {since}', { since: waitingFor(e) })));
  for (const p of projs) meta.push(projTag(p));
  if (e.kind === 'mail' && e.contact) meta.push(h('span.contact', { title: e.contact }, '→ ', contactNames(e.contact)));
  // Replies that arrived in the thread after it was sent.
  const replies = e.kind === 'mail' && e.done_at
    ? (S.data.msgsOfThread.get(e.thread_id) || []).filter(m => m.direction === 'in' && m.date > e.done_at) : [];
  if (replies.length) meta.push(h('span.replies', { title: tr('Replies received (the last one {when})', { when: fmtTime(replies.at(-1).date) }) }, '↩ ', replies.length));
  const atts = S.data.attachmentsOf.get(e.id);
  if (atts) meta.push(h('span.atts-n', { title: atts.map(a => a.filename).join(', ') }, icon('clip'), atts.length));
  if (e.assignee_id) meta.push(h('span.who', `+${userName(e.assignee_id)}`));
  if (kids.length) meta.push(h('span.kids', icon('check'), `${kids.filter(k => k.done_at).length}/${kids.length}`));
  if (logs.length) meta.push(h('span.logs', icon('log'), logs.length));
  if (e.notes) meta.push(h('span.has-notes', { title: tr('Has details') }, '¶'));
  // Sharing: whose it is (if not mine) and who I share it with (my private ones have nothing: it is the default).
  const sharedIds = sharedWithOf('entry', e);
  if (e.created_by !== D.me.id && e.created_by) meta.push(h('span.who', { title: tr('Created by') }, tr('by {name}', { name: userName(e.created_by) })));
  else if (e.shared_all) meta.push(h('span.shared', { title: tr('Visible to everyone') }, icon('users'), tr('everyone')));
  else if (sharedIds.length) meta.push(h('span.shared', { title: tr('Shared with {names}', { names: sharedIds.map(userName).join(', ') }) }, icon('user'), sharedIds.length === 1 ? userName(sharedIds[0]) : sharedIds.length));
  if (parent) meta.push(h('span.parent', { title: parent.title }, `↳ ${tr('subtask of')} `, h('b', parent.title)));
  // Waiting for something (outside its chain in the agenda: there it is already under what it waits for).
  const blockers = opt.chain ? [] : openBlockers(e);
  if (blockers.length && !e.done_at) {
    meta.push(h('span.after', { title: blockers.map(a => a.title).join('\n') }, icon('wait'), tr('after'), ' ', h('b', plainRefs(blockers[0].title)),
      blockers.length > 1 ? ` +${blockers.length - 1}` : ''));
  }
  const then = waitersOf(e).filter(x => !x.done_at);
  if (then.length && !opt.chain && !opt.hideThen) meta.push(h('span.then', { title: then.map(x => x.title).join('\n') }, '→ ', trn(then.length, '1 waits for it', '{n} wait for it')));
  if (e.pending) meta.push(h('span.pending', tr('queued offline')));

  const step = e.kind === 'mail' && MAIL_STEP[mailStep(e)];
  const check = e.kind === 'note'
    ? h('span.bullet')
    : h('button.check', {
      class: e.kind,
      title: step ? step.title : e.done_at ? tr('Reopen') : tr('Complete'),
      onclick: () => toggleDone(e),
    }, step ? icon(step.icon) : e.done_at ? icon('check') : null);

  return h('div.entry', {
    'data-eid': e.id,
    class: [`k-${e.kind}`, e.done_at && 'done', e.archived_at && 'archived', e.done_at && e.awaiting_reply && 'waiting', open && 'open', e.pinned && 'pinned', opt.nested && 'nested', opt.chain && 'chained',
      e.pending ? 'rw' : roClass(canEntry(e))].filter(Boolean).join(' '),
  },
  h('div.row', check,
    h('div.body', { onclick: () => toggleOpen(e.id) },
      h('div.title',
        opt.showKind !== false && !opt.nested && h('span.kpill', { class: `k-${e.kind}` }, KIND_PILL[e.kind]),
        e.pinned ? icon('star', 'pin') : null, richText(e.title)),
      meta.length > 0 && h('div.meta', meta)),
    e.kind === 'mail' && e.done_at && !e.pending && mailUpBtn(e)),
  open && (e.pending ? pendingEditor(e) : entryEditor(e)));
}

// Entry created offline, still queued: its text changes (with the same tokens as the bar), it can be deleted.
// The rest (projects, sharing, subtasks…) once it has reached the server.
function pendingEditor(e) {
  const p = S.outbox.find(x => x.pid === e.id);
  if (!p) return null;
  return h('div.editor.rw',
    h('textarea.ed-title', {
      rows: 1, value: p.text, 'data-fk': `ptitle-${e.id}`, spellcheck: 'false', 'data-ac': e.kind, 'aria-label': tr('Text of the queued entry'),
      oninput: autosize,
      onkeydown: ev => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); ev.target.blur(); } },
      onblur: ev => { const v = ev.target.value.trim(); if (v && v !== p.text) updatePending(e.id, { text: v }); },
    }),
    h('p.muted', icon('wait'), ' ', tr('Queued: sent as soon as the network is back. Until then you can change or delete it; projects, sharing and the rest afterwards.')),
    h('div.ed-foot',
      h('span.muted', tr('created offline · {when}', { when: fmtTime(p.queued_at) })),
      h('span.grow'),
      h('button.btn.sm.danger', { onclick: () => { ui.open.delete(e.id); removePending(e.id); toast(tr('Queued entry deleted')); } }, icon('trash'), tr('Delete'))));
}

// ---------- entry menus: kind, due date (or date), assignee ----------
function kindPop(e) {
  const pill = k => h('span.kpill', { class: `k-${k}` }, KIND_PILL[k]);
  return popButton(`kind:${e.id}`, [pill(e.kind), KIND_LABEL[e.kind]], close => [
    popSep(tr('Kind')),
    Object.entries(KIND_LABEL).map(([k, label]) => popItem(h('span', pill(k), label), () => { close(); if (k !== e.kind) patchEntry(e, { kind: k }); }, { on: k === e.kind })),
  ], { title: tr('Kind') });
}

function duePop(e) {
  const isNote = e.kind === 'note';
  const t = today();
  const dow = new Date(`${t}T12:00:00`).getDay();
  const label = e.due ? (isNote ? fmtDay(e.due) : dueInfo(e.due).label) : isNote ? tr('no date') : e.eventually ? tr('eventually') : tr('none');
  return popButton(`due:${e.id}`, [icon('cal'), label], close => {
    const set = v => { close(); if (v !== e.due) patchEntry(e, { due: v }); };
    const opts = isNote
      ? [[tr('Today'), t], [tr('Yesterday'), addDays(t, -1)], [tr('Two days ago'), addDays(t, -2)]]
      : [[tr('Today'), t], [tr('Tomorrow'), addDays(t, 1)], [tr('Next Monday'), addDays(t, ((8 - dow) % 7) || 7)], [tr('In a week'), addDays(t, 7)], [tr('In a month'), addDays(t, 30)]];
    return [
      popSep(isNote ? tr('When it happened') : tr('Due date')),
      opts.map(([l, v]) => popItem(l, () => set(v), { on: e.due === v, hint: fmtDay(v) })),
      h('label.pop-date', h('span', tr('Another date')), h('input', { type: 'date', value: e.due || '', onchange: ev => set(ev.target.value || null) })),
      !isNote && popItem(tr('Eventually'), () => { close(); if (!e.eventually) patchEntry(e, { eventually: true }); }, { on: !!e.eventually, hint: tr('no date, it will happen') }),
      (e.due || e.eventually) && popItem(isNote ? tr('Remove the date') : tr('No due date'), () => { close(); patchEntry(e, { due: null }); }),
      h('p.muted.pop-note', isNote ? tr('From the bar too: !fri, !3d, !25/11, !no.') : tr('From the bar too: !fri, !3d, !25/11, !eventually, !no.')),
    ];
  }, { title: isNote ? tr('Date') : tr('Due date'), class: e.due && !isNote ? dueInfo(e.due).cls : null });
}

function assignPop(e) {
  const D = S.data;
  return popButton(`assign:${e.id}`, [icon('user'), e.assignee_id ? userName(e.assignee_id) : tr('nobody')], close => {
    const set = v => { close(); if (v !== e.assignee_id) patchEntry(e, { assignee_id: v }); };
    return [
      popSep(tr('Assigned to')),
      popItem(tr('Nobody'), () => set(null), { on: !e.assignee_id }),
      D.members.map(u => popItem(u.name || u.username, () => set(u.id), { on: e.assignee_id === u.id, hint: u.id === D.me.id ? tr('you') : `@${u.username}` })),
      h('p.muted.pop-note', tr('Whoever is assigned sees the entry. From the bar: ++person.')),
    ];
  }, { title: tr('Assigned') });
}

function entryEditor(e) {
  const D = S.data;
  const me = D.me;
  const kids = (D.childrenOf.get(e.id) || []).slice().sort((a, b) => !!a.done_at - !!b.done_at || byDue(a, b));
  const logs = D.logsOf.get(e.id) || [];
  const isNote = e.kind === 'note';

  const title = h('textarea.ed-title', {
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
    });
  const fields = h('div.fields',
      h('div.f', h('span', tr('Kind')), kindPop(e)),
      h('div.f', h('span', isNote ? tr('Date') : tr('Due date')), duePop(e)),
      !e.parent_id && h('div.f.projs', h('span', tr('Projects')),
        h('div.projs-b',
          projectsOf(e).map((p, i) => h('span.chip-wrap', { title: i === 0 ? tr('Main project') : null }, projTag(p),
            h('button.icon-btn.sm', { title: tr('Remove from this project'), onclick: () => act(() => api('DELETE', `/entries/${e.id}/projects/${p.id}`)) }, icon('x')))),
          h('input.sub-in', {
            placeholder: tr('+ project'), size: 12, 'data-fk': `eproj-${e.id}`, 'data-ac': 'project', autocomplete: 'off',
            onkeydown: enterAdd(text => {
              const p = D.projectByTag.get(text.replace(/^@/, '').toLowerCase());
              if (!p) return toast(tr('Project @{tag} does not exist', { tag: text.replace(/^@/, '') }), { err: true });
              act(() => api('POST', `/entries/${e.id}/projects`, { project_id: p.id }));
            }),
          }))),
      D.members.length > 1 && h('div.f', h('span', tr('Assigned')), assignPop(e)),
      !e.parent_id && h('div.f', h('span', tr('Sharing')), shareBox('entry', e)),
      h('button.chip', { class: e.pinned && 'on', onclick: () => patchEntry(e, { pinned: !e.pinned }) }, icon('star'), tr('pinned')),
      e.kind === 'mail' && e.done_at && h('button.chip', {
        class: e.awaiting_reply && 'on', title: tr('The mail shows in "Awaiting reply" until the reply arrives'),
        onclick: () => patchEntry(e, { awaiting: !e.awaiting_reply }),
      }, icon('mail'), tr('awaits reply')),
  );
  const subs = !isNote && !e.parent_id && h('div.subs',
      kids.map(k => entryRow(k, { nested: true, showProject: false })),
      h('input.sub-in', {
        placeholder: tr('+ subtask'), 'data-fk': `sub-${e.id}`, 'data-ac': 'todo', autocomplete: 'off',
        onkeydown: enterAdd(text => addEntry({ text, today: today(), parent_id: e.id })),
      }));
  // Dependencies: what it waits for (it stays under it in the agenda until it is done) and what comes after it.
  const blockers = (D.afterOf.get(e.id) || []).map(x => D.entryById.get(x.after_id)).filter(Boolean);
  const after = !isNote && h('div.deps',
      h('div.deps-row',
        h('span.deps-l', icon('wait'), tr('Waits for')),
        blockers.map(a => h('span.chip-wrap.dep', { class: a.done_at ? 'done' : null },
          h('a', { href: `#/v/${a.id}`, title: a.done_at ? tr('done') : tr('still to do') }, a.done_at && icon('check'), plainRefs(a.title)),
          h('button.icon-btn.sm', { title: tr('Stop waiting for it'), onclick: () => act(() => api('DELETE', `/entries/${e.id}/after/${a.id}`)) }, icon('x')))),
        h('input.sub-in', {
          placeholder: blockers.length ? tr('+ another') : tr('+ an entry it waits for'), size: 18, 'data-fk': `after-${e.id}`, 'data-ac': 'after', 'data-ac-self': e.id, autocomplete: 'off',
          onkeydown: enterAdd(text => {
            const id = +text.replace(/^\^/, '');
            if (!id) return toast(tr('Pick an entry from the list'), { err: true });
            act(() => api('POST', `/entries/${e.id}/after`, { after_id: id }));
          }),
        })),
      h('div.deps-row',
        h('span.deps-l', h('span', '→'), tr('Then')),
        waitersOf(e).map(x => h('span.chip-wrap.dep', { class: x.done_at ? 'done' : null },
          h('a', { href: `#/v/${x.id}` }, x.done_at && icon('check'), plainRefs(x.title)),
          h('button.icon-btn.sm', { title: tr('It does not wait for this any more'), onclick: () => act(() => api('DELETE', `/entries/${x.id}/after/${e.id}`)) }, icon('x')))),
        h('input.sub-in', {
          placeholder: tr('+ what comes after (a new entry)'), size: 32, 'data-fk': `then-${e.id}`, 'data-ac': 'todo', autocomplete: 'off',
          onkeydown: enterAdd(text => addEntry({ text, today: today(), after_id: e.id })),
        })));
  const log = h('div.log',
      logs.map(l => h('div.log-l', { class: l.system ? 'sys' : null },
        h('span.log-t', fmtTime(l.created_at)),
        D.users.length > 1 && h('span.log-u', userName(l.user_id)),
        h('span.log-x', richText(l.text)),
        (l.user_id === me.id || me.is_admin) && h('button.icon-btn.sm', { title: tr('Delete'), onclick: () => act(() => api('DELETE', `/logs/${l.id}`)) }, icon('x')))),
      h('input.log-in', {
        placeholder: tr('Update: what did you find out? (also !date +user #CODE)'), 'data-fk': `log-${e.id}`,
        'data-ac': e.kind, 'data-ac-only': '!#+', 'data-ac-entry': e.id, autocomplete: 'off',
        onkeydown: enterAdd(text => act(() => api('POST', `/entries/${e.id}/log`, { text, today: today() }))),
      }));
  const foot = h('div.ed-foot',
      h('span.muted', `${userName(e.created_by)} · ${fmtTime(e.created_at)}`),
      h('span.grow'),
      e.kind === 'note' && h('button.btn.sm', { onclick: () => archiveNote(e, !e.archived_at) },
        icon(e.archived_at ? 'restore' : 'archive'), e.archived_at ? tr('Active again') : tr('Archive')),
      h('button.btn.sm.danger', {
        onclick: () => {
          ui.open.delete(e.id);
          trashIt('entry', `/entries/${e.id}`, kids.length ? tr('Entry and subtasks') : tr('Entry'));
        },
      }, icon('trash'), tr('Delete')));

  // Mail: two columns. On the left the mail (conversation, text, updates), on the right what ties it to the rest of
  // Organizer (details, people, attachments both ways, links, who mentions it).
  if (e.kind === 'mail') {
    return h('div.editor.mail-ed',
      title,
      h('div.mail-cols',
        h('div.mail-main', threadLink(e), mailComposer(e), log),
        h('aside.mail-side', h('div.ms-b', h('div.ms-h', tr('Details')), fields), mailSide(e))),
      foot);
  }
  return h('div.editor',
    title,
    fields,
    richField({
      fk: `notes-${e.id}`, cls: 'ed-notes', rows: 1, value: e.notes, placeholder: tr('Details (optional; #code, [[ to link something else, Markdown)…'),
      attrs: { 'data-ac': e.kind, 'data-ac-only': '#', 'data-ac-entry': e.id }, onSave: notes => patchEntry(e, { notes }), md: true,
    }),
    subs,
    after,
    log,
    backlinksBox('voce', e.id, { title: tr('Mentioned in'), compact: true }),
    foot);
}

// Entry done more than 30 days ago: not in the synced data, read from the server (read-only, it can be reopened).
const archived = new Map();
function archivedEntry(id) {
  if (!archived.has(id)) {
    archived.set(id, null);
    api('GET', `/entries/${id}`).then(e => { archived.set(id, e); render(); }, () => { archived.set(id, false); render(); });
  }
  const e = archived.get(id);
  if (e === null) return h('div.view', empty(h('p', tr('Loading…'))));
  if (!e) return h('div.view', empty(h('p', tr('Entry not found: maybe it was deleted (look in the trash).'))));
  return h('div.view.entry-page',
    h('div.sec-b.archived',
      h('div.arch-h', h('span.kpill', { class: `k-${e.kind}` }, KIND_PILL[e.kind]), h('b', richText(e.title))),
      h('p.muted', e.kind === 'mail' ? tr('Sent on {when}', { when: fmtTime(e.done_at) }) : tr('Done on {when}', { when: fmtTime(e.done_at) }), e.kind === 'mail' && e.contact ? [` ${tr('to')} `, contactNames(e.contact)] : '',
        e.projects.length ? ' · ' : '', e.projects.map(p => projTag(p))),
      e.notes && (e.kind === 'mail' ? h('div.arch-notes', richText(e.notes)) : h('div.arch-notes.md', mdText(e.notes))),
      e.attachments.length > 0 && h('p.muted', icon('clip'), e.attachments.map(a => a.filename).join(', ')),
      h('div.toolbar', h('button.btn.sm', {
        onclick: () => act(async () => { await api('PATCH', `/entries/${id}`, { done: false }); archived.delete(id); }, tr('Reopened')),
      }, icon('restore'), e.kind === 'mail' ? tr('Back among the mails to send') : tr('Reopen')))));
}

// A single entry, open (the [[voce:ID]] links and the backlinks lead here).
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
    parent && h('p.muted', `↳ ${tr('subtask of')} `, h('a', { href: `#/v/${parent.id}` }, parent.title)),
    h('div.sec-b', entryRow(e)));
}

// ---------- backlinks ----------
// Who links this element: mails to send and sent ones apart (to know if it has already left), then todos and notes.
// Archived entries included; they open in the entry's page.
const BL_PILL = { todo: 'todo', mail: 'mail', note: 'nota' };

function blRow(e) {
  const when = e.kind === 'mail'
    ? (e.done_at ? `${tr('sent {when}', { when: fmtTime(e.done_at) })}${e.awaiting_reply ? `, ${tr('awaits reply')}` : ''}` : e.due ? dueInfo(e.due).label : '')
    : e.done_at ? tr('done {when}', { when: fmtTime(e.done_at) }) : e.due ? (e.kind === 'note' ? fmtDay(e.due) : dueInfo(e.due).label) : '';
  return h('a.bl-row', { href: `#/v/${e.id}`, class: e.done_at && e.kind !== 'mail' ? 'done' : null },
    h('span.kpill', { class: `k-${e.kind}` }, BL_PILL[e.kind]),
    h('span.bl-t', plainRefs(e.title).replace(/(^|\s)#/g, '$1')),
    e.kind === 'mail' && e.contact && h('span.muted.bl-to', '→ ', contactNames(e.contact)),
    when && h('span.muted.bl-when', when));
}

export function backlinksBox(kind, id, { title = tr('Linked in'), mailsOnly = false, compact = false } = {}) {
  const list = backlinks(kind, id);
  const topics = [...(S.data.topicsOf.get(`${kind}:${id}`) || [])].map(t => S.data.topicById.get(t)).filter(Boolean);
  // The conversations of topics already listed are not repeated.
  const threads = linkedThreads(kind, id).filter(t => !topics.some(x => x.id === t.topic_id));
  if (!list && !threads.length && !topics.length) return null;
  const drafts = (list || []).filter(e => e.kind === 'mail' && !e.done_at);
  const sent = (list || []).filter(e => e.kind === 'mail' && e.done_at);
  const others = mailsOnly ? [] : (list || []).filter(e => e.kind !== 'mail');
  const total = topics.length + threads.length + drafts.length + sent.length + others.length;
  if (!total) return null;
  const group = (ic, label, rows, fn = blRow) => rows.length > 0 && h('div.bl-g',
    h('div.bl-h', icon(ic), label, h('span.count', rows.length)), rows.map(fn));
  const groups = [
    group('mail', tr('Mail conversations'), [...topics.map(t => ({ topic: t })), ...threads], x => (x.topic ? topicBlRow(x.topic) : threadBlRow(x))),
    group('edit', tr('Mails to send'), drafts),
    group('send', tr('Sent mails'), sent),
    group('log', tr('Todos and notes'), others),
  ];
  return compact
    ? h('div.backlinks', h('div.bl-title', title), groups)
    : section(`bl-${kind}-${id}`, title, groups, { count: total });
}

// My threads linked to the element (by hand, from the codes in the messages, from the mails written); for a contact
// also those where they write or receive.
function linkedThreads(kind, id) {
  const D = S.data;
  const ids = new Set(D.threadsOf.get(`${kind}:${id}`) || []);
  const email = kind === 'contatto' && D.contactById.get(id)?.email?.toLowerCase();
  if (email) {
    for (const m of D.mailMsgs) if (`${m.from_addr},${m.to_addr},${m.cc}`.toLowerCase().includes(email)) ids.add(m.thread_id);
  }
  // In a thread the mails written there are already "linked": it is not offered again in the mail itself.
  if (kind === 'voce') ids.delete(D.entryById.get(id)?.thread_id);
  return [...ids].map(t => D.threadById.get(t)).filter(Boolean).sort((a, b) => b.last_at.localeCompare(a.last_at));
}

function topicBlRow(topic) {
  const threads = S.data.threadsOfTopic.get(topic.id) || [];
  const last = threads.map(t => t.last_at).sort().at(-1);
  return h('a.bl-row', { href: `#/t/${topic.id}` },
    h('span.kpill.k-mail', 'topic'),
    h('span.bl-t', topicTitle(topic)),
    h('span.muted.bl-to', trn(threads.length, '1 conversation', '{n} conversations')),
    last && h('span.muted.bl-when', fmtTime(last)));
}

function threadBlRow(t) {
  const x = threadInfo(t);
  return h('a.bl-row', { href: `#/t/${t.topic_id}?th=${t.id}`, class: x.unread ? 'unread' : null },
    h('span.kpill.k-mail', 'mail'),
    h('span.bl-t', threadSubject(t)),
    x.who.length > 0 && h('span.muted.bl-to', x.who.map(a => S.data.contactByEmail.get(a.email.toLowerCase())?.name || a.name || a.email).slice(0, 2).join(', ')),
    h('span.muted.bl-when', t.archived_at ? tr('archived · {when}', { when: fmtTime(t.last_at) }) : fmtTime(t.last_at)));
}

// Entries created offline and still queued (see core.js): like the others, with "queued offline".
function pendingRows(filter = () => true) {
  return S.outbox.filter(p => filter({ ...p, kind: p.kind || 'todo' })).map((p, i) => {
    const q = parseQuick(p.text, { today: p.today || today(), kind: p.kind || 'todo' });
    return entryRow({
      id: p.pid ?? -1 - i, kind: p.kind || 'todo', title: q.title, due: q.due ?? null, notes: '', pinned: 0, pending: true,
      done_at: p.done || null, created_by: S.data.me.id, shared_all: 0, created_at: p.queued_at || new Date().toISOString(),
    }, { showProject: false });
  });
}

// ---------- agenda ----------
export function viewAgenda() {
  const D = S.data;
  let list = D.entries.filter(e => e.kind !== 'note' && !e.done_at && (!e.parent_id || e.due));
  if (ui.mine) list = list.filter(isMine);
  const kindCount = { all: list.length, todo: list.filter(e => e.kind === 'todo').length, mail: list.filter(e => e.kind === 'mail').length };
  if (ui.agendaKind !== 'all') list = list.filter(e => e.kind === ui.agendaKind);
  // Waiting entries are not placed by date: they go under what they wait for (the first one still open that is in
  // the list), in a chain; those whose chain is not in the list (filtered out, or waiting for an entry without a
  // date that is a subtask…) go in "Waiting".
  const inList = new Set(list.map(e => e.id));
  const chainOf = new Map(); // host id → entries waiting for it
  const waiting = list.filter(isWaiting);
  for (const w of waiting) {
    const host = openBlockers(w).find(a => inList.has(a.id));
    if (host) chainOf.set(host.id, [...(chainOf.get(host.id) || []), w]);
  }
  const g = { over: [], today: [], tomorrow: [], week: [], later: [], none: [], ev: [] };
  for (const e of list) {
    if (isWaiting(e)) continue;
    if (e.eventually) { g.ev.push(e); continue; } // !eventually: the column on the right
    if (!e.due) { g.none.push(e); continue; }
    const d = dayDiff(e.due);
    (d < 0 ? g.over : d === 0 ? g.today : d === 1 ? g.tomorrow : d <= 7 ? g.week : g.later).push(e);
  }
  const done = D.entries.filter(e => e.kind !== 'note' && e.done_at && Date.now() - Date.parse(e.done_at) < 864e5
    && (!ui.mine || isMine(e)) && (ui.agendaKind === 'all' || e.kind === ui.agendaKind));
  const setKind = k => { ui.agendaKind = k; save('org.agendaKind', k); render(); };
  const placed = new Set();
  // An entry and, under it, what waits for it (and so on, a few levels).
  const withChain = (e, depth = 0, extra = {}) => {
    placed.add(e.id);
    const next = depth < 6 ? (chainOf.get(e.id) || []).filter(x => !placed.has(x.id)).sort((a, b) => byDue(a, b) || a.id - b.id) : [];
    return [entryRow(e, { showParent: true, chain: depth > 0, hideThen: next.length > 0, ...extra }),
      next.length > 0 && h('div.chain', next.map(x => withChain(x, depth + 1)))];
  };
  const rows = (arr, extra) => arr.map(e => withChain(e, 0, extra));

  // Built first: the chains under these entries must not end up in "Waiting".
  // Always there (also empty): it is where entries are dropped to make them "eventually" (the zone shows only while
  // dragging).
  const side = [section('ag-ev', tr('Eventually'), rows(g.ev.sort(byRecent), { inEventually: true }), { cls: 'ev', count: g.ev.length }),
    h('div.ag-drop', tr('Drop here: eventually'))];
  return h('div.view.agenda',
    h('div.toolbar',
      [['all', tr('Everything')], ['todo', tr('Todo')], ['mail', tr('Mail')]].filter(([k]) => k === 'all' || can(k === 'mail' ? 'mail' : 'voci')).map(([k, label]) => filterChip({
        on: ui.agendaKind === k, label, n: kindCount[k], cls: k === 'all' ? null : `tint k-${k}`, onclick: () => setKind(k),
      })),
      D.members.length > 1 && h('span.tsep'),
      D.members.length > 1 && filterChip({ on: ui.mine, label: [icon('user'), tr('only mine')], onclick: () => { ui.mine = !ui.mine; save('org.mine', ui.mine); render(); } })),
    pendingRows(p => p.kind !== 'note'),
    !list.length && ui.agendaKind !== 'all' && kindCount.all > 0 && empty(h('p', tr('Nothing of this kind. '), h('a', { href: '#/agenda', onclick: ev => { ev.preventDefault(); setKind('all'); } }, tr('Show everything')))),
    !kindCount.all && !S.outbox.length && empty(
      h('p', tr('Nothing in the agenda.')),
      h('p', tr('Write in the bar at the top, for example:')),
      h('p', kbd(tr('flash new fw #SCH-042 @rover !fri'))),
      h('p', kbd(tr('m: ask for a quote >supplier@company.example !tomorrow'))),
      h('p', kbd(tr('n: rev B needs bootloader 2.x #SCH-042')))),
    h('div.ag-cols', h('div.ag-main',
    g.over.length > 0 && section('ag-over', tr('Overdue'), rows(g.over.sort(byDue)), { cls: 'over' }),
    g.today.length > 0 && section('ag-today', tr('Today'), rows(g.today.sort(byDue)), { cls: 'today' }),
    g.tomorrow.length > 0 && section('ag-tom', tr('Tomorrow'), rows(g.tomorrow.sort(byDue))),
    g.week.length > 0 && section('ag-week', tr('Next 7 days'), rows(g.week.sort(byDue))),
    g.later.length > 0 && section('ag-later', tr('Later'), rows(g.later.sort(byDue))),
    g.none.length > 0 && section('ag-none', tr('No due date'), rows(g.none.sort(byRecent))),
    (() => {
      const rest = waiting.filter(w => !placed.has(w.id)).sort(byRecent);
      return rest.length > 0 && section('ag-wait', tr('Waiting'), rows(rest));
    })(),
    done.length > 0 && section('ag-done', tr('Done in the last 24 hours'), rows(done.sort(byDoneDesc)), { collapsed: true })),
    h('aside.ag-side', side)),
    h('div.ag-root-drop', tr('Drop here: it no longer waits')));
}

// ---------- projects ----------
function projectStats() {
  const stats = new Map();
  for (const e of S.data.entries) {
    for (const p of projectsOf(e)) {
      const s = stats.get(p.id) || { open: 0, over: 0, next: null, last: '' };
      if (e.kind !== 'note' && !e.done_at && !e.parent_id) {
        s.open++;
        if (e.due && !isWaiting(e) && dayDiff(e.due) < 0) s.over++;
        if (e.due && !isWaiting(e) && (!s.next || e.due < s.next)) s.next = e.due;
      }
      if (e.updated_at > s.last) s.last = e.updated_at;
      stats.set(p.id, s);
    }
  }
  return stats;
}

// Stats of a project together with all its subprojects; each entry counts only once even if it is in several
// projects of the tree.
function deepStats(id) {
  const ids = new Set([id, ...descendants(id)]);
  const out = { open: 0, over: 0, next: null, last: '' };
  for (const e of S.data.entries) {
    if (!projectsOf(e).some(p => ids.has(p.id))) continue;
    if (e.kind !== 'note' && !e.done_at && !e.parent_id) {
      out.open++;
      if (e.due && !isWaiting(e) && dayDiff(e.due) < 0) out.over++;
      if (e.due && !isWaiting(e) && (!out.next || e.due < out.next)) out.next = e.due;
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
    h('div.card-h', h('span.card-t', p.name), p.shared_all ? icon('users') : sharedWithOf('project', p).length ? icon('user') : null, p.status !== 'open' && h('span.muted', STATUS_ONE[p.status])),
    h('div.card-tag', { style: `--h:${projHue(p)}` }, `@${p.tag}`),
    h('div.card-m',
      h('span', subs && s.open !== own.open ? tr('{n} open ({own} here)', { n: s.open, own: own.open }) : tr('{n} open', { n: s.open })),
      s.over > 0 && h('span.over', tr('{n} overdue', { n: s.over })),
      next && h('span', { class: next.cls || null }, tr('next {when}', { when: next.label })),
      subs > 0 && h('span', tr('{n} under', { n: subs }))));
}

export function viewProjects() {
  const D = S.data;
  const stats = projectStats();
  const counts = { open: 0, paused: 0, closed: 0 };
  for (const p of D.projects) counts[p.status]++;
  const lastOf = new Map(D.projects.map(p => [p.id, deepStats(p.id).last || p.updated_at])); // computed once, not at every comparison
  const last = p => lastOf.get(p.id);
  const inList = p => p.status === ui.projStatus;
  // Tree: roots = projects in the chosen status whose parent is not in the list too.
  const roots = D.projects.filter(p => inList(p) && !(p.parent_id && D.projectById.get(p.parent_id) && inList(D.projectById.get(p.parent_id))))
    .sort((a, b) => last(b).localeCompare(last(a)));
  const tree = (p, depth) => {
    const kids = (D.subprojects.get(p.id) || []).filter(inList).sort((a, b) => a.name.localeCompare(b.name));
    return h('div.ptree', { class: depth ? 'sub' : null },
      projectCard(p, stats, { dnd: true }),
      kids.length > 0 && h('div.pkids', kids.map(k => tree(k, depth + 1))));
  };

  return h('div.view', { class: roClass(can('progetti', 'write')) },
    h('div.toolbar',
      Object.entries(STATUS_LABEL).map(([k, label]) =>
        filterChip({ on: ui.projStatus === k, label, n: counts[k], onclick: () => { ui.projStatus = k; render(); } }))),
    !roots.length && empty(h('p', ui.projStatus === 'open'
      ? [tr('No open project. Create it from the bar at the top ('), kbd(tr('Name @parent')), tr(' for a subproject) or on the fly by writing '), kbd(tr('@name')), tr(' in an entry.')]
      : tr('No project here.'))),
    // The row at the top is also the "main project" drop zone: it always has the same height, so when dragging
    // starts the list does not move under the pointer.
    // Drop zone for "main project": it shows only while dragging, floating at the bottom (the list does not move).
    roots.length > 0 && h('div.proot', tr('Drop here to make it a main project')),
    h('div.pforest', roots.map(p => tree(p, 0))));
}

// ---------- drag and drop in the agenda ----------
// An entry dropped on another waits for it (it goes under it); dropped on the "Eventually" column it becomes
// "eventually". Loops are refused here already (the server checks again).
const waitsFor = (id, other) => {
  const seen = new Set();
  for (const stack = [id]; stack.length;) {
    const x = stack.pop();
    if (x === other) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    stack.push(...(S.data.afterOf.get(x) || []).map(d => d.after_id));
  }
  return false;
};
draggable({
  handle: '.agenda .entry[data-eid]:not(.open) > .row',
  bodyClass: 'edd',
  // The dragged entry and the one it is shown under in a chain (host), if any.
  data: el => {
    const row = el.closest('.entry');
    const host = row.parentElement.classList.contains('chain') ? +row.parentElement.previousElementSibling?.dataset.eid || null : null;
    return { id: +row.dataset.eid, host };
  },
  // The "it waits for nothing" zone shows only for entries that wait for something.
  onStart: ({ id }) => document.body.classList.toggle('edd-w', (S.data.afterOf.get(id) || []).length > 0),
  ghost: ({ id }) => [h('span', plainRefs(S.data.entryById.get(id)?.title || ''))],
  target: (el, { id, host }) => {
    const D = S.data;
    if (el.closest('.ag-root-drop')) return { el: el.closest('.ag-root-drop'), value: 'root', ok: (D.afterOf.get(id) || []).length > 0 };
    const row = el.closest('.agenda .entry[data-eid]');
    if (row) {
      const tid = +row.dataset.eid;
      const t = D.entryById.get(tid);
      const already = (D.afterOf.get(id) || []).some(d => d.after_id === tid);
      return { el: row, value: tid, ok: !!t && tid !== id && tid !== host && t.kind !== 'note' && !t.done_at && !already && !waitsFor(tid, id) && !isReadOnly(row) };
    }
    const col = el.closest('.ag-side');
    if (col) {
      const e = D.entryById.get(id);
      return { el: col, value: 'eventually', ok: !!e && (!e.eventually || (D.afterOf.get(id) || []).length > 0) };
    }
    return null;
  },
  drop: ({ id, host }, t) => {
    const D = S.data;
    const e = D.entryById.get(id);
    const before = (D.afterOf.get(id) || []).map(d => d.after_id);
    const setAfter = ids => api('PUT', `/entries/${id}/after`, { after_ids: ids });
    const name = plainRefs(e.title).slice(0, 50);
    if (t.value === 'eventually') {
      // In the column as an entry of its own: it waits for nothing any more.
      const was = { due: e.due, eventually: !!e.eventually };
      return act(async () => {
        if (!e.eventually) await api('PATCH', `/entries/${id}`, { eventually: true });
        if (before.length) await setAfter([]);
      }).then(() => toast(tr('"{title}": eventually', { title: name }), { action: { label: tr('Undo'), fn: () => act(async () => {
        await api('PATCH', `/entries/${id}`, was.eventually ? { eventually: true } : { due: was.due });
        if (before.length) await setAfter(before);
      }) } }));
    }
    if (t.value === 'root') {
      return act(() => setAfter([])).then(() => toast(tr('"{title}" no longer waits', { title: name }), { action: { label: tr('Undo'), fn: () => act(() => setAfter(before)) } }));
    }
    // Under another entry: it leaves the one it was under (if it was in a chain) and waits for this one.
    const other = D.entryById.get(t.value);
    const next = [...before.filter(x => x !== host), t.value];
    act(() => setAfter(next)).then(() =>
      toast(tr('"{title}" waits for "{other}"', { title: name, other: plainRefs(other.title).slice(0, 40) }),
        { action: { label: tr('Undo'), fn: () => act(() => setAfter(before)) } }));
  },
});

// ---------- drag and drop of the projects tree ----------
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
    const where = t.value ? tr('inside @{tag}', { tag: S.data.projectById.get(t.value).tag }) : tr('among the main ones');
    act(() => api('PATCH', `/projects/${id}`, { parent_id: t.value })).then(() => {
      toast(tr('@{tag} moved {where}', { tag: p.tag, where }), { action: { label: tr('Undo'), fn: () => act(() => api('PATCH', `/projects/${id}`, { parent_id: before })) } });
    });
  },
});

// ---------- drag and drop of items between categories (view by category) ----------
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
  drop: async (id, t) => {
    const it = S.data.itemById.get(id);
    const before = it.category || '';
    let category = t.value;
    if (t.el.dataset.new != null) {
      category = ((await askText(tr('New category for {code}:', { code: it.code }), { title: tr('New category'), ok: tr('Move') })) || '').trim();
      if (!category) return;
    }
    if (category === before) return;
    act(() => api('PATCH', `/items/${id}`, { category })).then(() => {
      toast(`${it.code} → ${category || tr('no category')}`, { action: { label: tr('Undo'), fn: () => act(() => api('PATCH', `/items/${id}`, { category: before })) } });
    });
  },
});

export function viewProject(id) {
  const D = S.data;
  const p = D.projectById.get(+id);
  if (!p) return empty(h('p', tr('Project not found (or private).')), h('a', { href: '#/progetti' }, tr('Back to the projects')));
  const me = D.me;
  const subIds = descendants(p.id);
  const ids = new Set(ui.projDeep ? [p.id, ...subIds] : [p.id]);
  const es = D.entries.filter(e => projectsOf(e).some(x => ids.has(x.id)));
  const top = es.filter(e => !e.parent_id);
  const todos = top.filter(e => e.kind === 'todo' && !e.done_at).sort(byDue);
  const mails = top.filter(e => e.kind === 'mail' && !e.done_at).sort(byDue);
  const allNotes = top.filter(e => e.kind === 'note');
  const notes = allNotes.filter(e => !e.archived_at).sort(byNoteDesc);
  const waiting = top.filter(e => e.kind === 'mail' && e.done_at && e.awaiting_reply).sort((a, b) => a.done_at.localeCompare(b.done_at));
  const done = top.filter(e => e.kind !== 'note' && e.done_at && !(e.kind === 'mail' && e.awaiting_reply)).sort(byDoneDesc);
  const patch = f => act(() => api('PATCH', `/projects/${p.id}`, f));
  const rows = (arr, showKind = false) => arr.map(e => entryRow(e, { hideProject: p.id, showKind }));

  // Inventory: linked by hand (removable) + mentioned with #CODE in entries or linked to subprojects.
  const manual = (D.itemsOfProject.get(p.id) || []).map(x => D.itemById.get(x.item_id)).filter(Boolean);
  const manualIds = new Set(manual.map(i => i.id));
  const other = new Set();
  for (const e of es) for (const x of D.itemsOfEntry.get(e.id) || []) other.add(x.item_id);
  if (ui.projDeep) for (const sid of subIds) for (const x of D.itemsOfProject.get(sid) || []) other.add(x.item_id);
  const cited = [...other].filter(i => !manualIds.has(i)).map(i => D.itemById.get(i)).filter(Boolean);

  const parentOptions = [['', tr('— none (main project) —')],
    ...D.projects.filter(x => x.id !== p.id && !subIds.includes(x.id)).sort((a, b) => a.tag.localeCompare(b.tag)).map(x => [String(x.id), `@${x.tag}`])];
  const kids = (D.subprojects.get(p.id) || []).sort((a, b) => a.name.localeCompare(b.name));
  const stats = projectStats();

  return h('div.view', { class: roClass(can('progetti', 'write')) },
    ancestors(p.id).length > 0 && h('div.crumbs', ancestors(p.id).map(a => [projTag(a), h('span.muted', ' › ')])),
    h('div.head',
      h('a.icon-btn', { href: '#/progetti', title: tr('Projects (Esc)') }, icon('back')),
      // The project's colour behind the dot, as for inventory categories.
      h('button.cdot.big.pick.cat', {
        style: `--h:${projHue(p)}`, title: tr('Colour of @{tag}', { tag: p.tag }),
        onclick: () => { ui.projPicker = ui.projPicker === p.id ? null : p.id; render(); },
      }),
      h('input.h-title', { value: p.name, 'data-fk': `pname-${p.id}`, onchange: ev => patch({ name: ev.target.value }) })),
    ui.projPicker === p.id && h('div.cat-pick', h('span.muted', `${tr('Colour of @{tag}', { tag: p.tag })}: `),
      huePicker(p.hue ?? null, hue(p.tag), x => { ui.projPicker = null; patch({ hue: x }); })),
    h('div.fields',
      h('label.f', h('span', tr('Tag @')), h('input.mono', { value: p.tag, size: 14, 'data-fk': `ptag-${p.id}`, onchange: ev => patch({ tag: ev.target.value }) })),
      h('label.f', h('span', tr('Status')), selectOf(p.status, [['open', tr('Open')], ['paused', tr('Paused')], ['closed', tr('Closed')]], v => patch({ status: v }))),
      h('label.f', h('span', tr('Inside')), selectOf(p.parent_id ? String(p.parent_id) : '', parentOptions, v => patch({ parent_id: v ? +v : null }))),
      shareBox('project', p),
      h('span.grow'),
      (p.created_by === me.id || me.is_admin) && h('button.btn.sm.danger', {
        onclick: async () => {
          if (!await askConfirm(tr('Move @{tag} to the trash? Its entries stay visible, without a project.', { tag: p.tag }), { ok: tr('Move to the trash'), danger: true })) return;
          trashIt('project', `/projects/${p.id}`, `@${p.tag}`).then(ok => { if (ok) location.hash = '#/progetti'; });
        },
      }, icon('trash'), tr('Delete'))),
    richField({
      fk: `pnotes-${p.id}`, cls: 'proj-notes', value: p.notes, placeholder: tr('Project notes: repo, board IPs, toolchain, references… (Markdown: # heading, **bold**, - list)'),
      attrs: { 'data-ac': 'text', 'data-ac-only': '#' }, onSave: notes => patch({ notes }), md: true,
    }),
    section(`p${p.id}-subs`, tr('Subprojects'), [
      kids.length > 0 && h('div.cards.subcards', kids.map(k => projectCard(k, stats, { compact: true }))),
      h('input.sub-in', {
        placeholder: tr('+ new subproject (name, Enter)'), 'data-fk': `newsub-${p.id}`, autocomplete: 'off',
        onkeydown: enterAdd(name => act(() => api('POST', '/projects', { name, parent_id: p.id }))),
      }),
    ], { count: kids.length, collapsed: !kids.length }),
    subIds.length > 0 && h('div.toolbar',
      h('button.chip', { class: ui.projDeep && 'on', onclick: () => { ui.projDeep = !ui.projDeep; save('org.projDeep', ui.projDeep); render(); } },
        icon('folder'), tr('include the subprojects\' entries'))),
    section(`p${p.id}-todo`, tr('To do'), todos.length ? rows(todos) : [empty(h('p', tr('Write in the bar at the top: the entries end up in '), kbd(`@${p.tag}`), '.'))], { count: todos.length }),
    mails.length > 0 && section(`p${p.id}-mail`, tr('Mails to send'), rows(mails)),
    waiting.length > 0 && section(`p${p.id}-wait`, tr('Awaiting reply'), rows(waiting), { cls: 'waiting' }),
    notes.length > 0 && section(`p${p.id}-notes`, tr('Journal'), rows(notes)),
    archivedNotes(`p${p.id}`, allNotes, { hideProject: p.id }),
    section(`p${p.id}-items`, tr('Project inventory'), [
      h('div.comp',
        h('div.item-chips', manual.map(i => h('span.chip-wrap', itemChip(i),
          h('button.icon-btn.sm', { title: tr('Unlink from the project'), onclick: () => act(() => api('DELETE', `/projects/${p.id}/items/${i.id}`)) }, icon('x'))))),
        h('input.sub-in.mono', {
          placeholder: tr('+ item code'), 'data-fk': `pitem-${p.id}`, size: 18, 'data-ac': 'code', autocomplete: 'off', autocapitalize: 'characters',
          onkeydown: enterAdd(code => act(() => api('POST', `/projects/${p.id}/items`, { code }))),
        })),
      cited.length > 0 && h('div.comp', h('span.muted', ui.projDeep && subIds.length ? tr('Mentioned in entries and subprojects') : tr('Mentioned in entries')),
        h('div.item-chips', cited.map(itemChip))),
    ], { count: manual.length + cited.length }),
    backlinksBox('progetto', p.id, { title: tr('Mentioned in') }),
    done.length > 0 && section(`p${p.id}-done`, tr('Completed'), rows(done, true), { collapsed: true }));
}

// ---------- journal ----------
export function viewDiary() {
  const D = S.data;
  const all = D.entries.filter(e => e.kind === 'note' && !e.parent_id).sort(byNoteDesc);
  const notes = all.filter(e => !e.archived_at);
  const shown = notes.slice(0, ui.diaryLimit);
  const days = [];
  for (const e of shown) {
    const d = noteDay(e);
    if (days.at(-1)?.day !== d) days.push({ day: d, items: [] });
    days.at(-1).items.push(e);
  }
  return h('div.view',
    pendingRows(p => p.kind === 'note'),
    !all.length && empty(
      h('p', tr('The journal collects things that happened once and should be remembered.')),
      h('p', tr('Example: '), kbd(tr('found out that SCH-042 rev B needs fw ≥ 2.3 #SCH-042 @rover'))),
      h('p', tr('With '), kbd(tr('!yesterday')), tr(' or '), kbd('!12/10'), tr(' you record when it happened.'))),
    days.map(g => h('div.day',
      h('div.day-h', fmtLongDay(g.day)),
      g.items.map(e => entryRow(e, { showKind: false })))),
    notes.length > shown.length && h('button.btn.ghost.more', { onclick: () => { ui.diaryLimit += 200; render(); } }, tr('Show {n} more', { n: notes.length - shown.length })),
    archivedNotes('diary', all));
}

// Notes no longer needed: out of the lists, kept in a section of their own at the bottom (closed).
function archivedNotes(key, notes, opt = {}) {
  const arch = notes.filter(e => e.archived_at).sort((a, b) => b.archived_at.localeCompare(a.archived_at));
  return arch.length > 0 && section(`${key}-archived`, tr('Archived notes'), arch.map(e => entryRow(e, { showKind: false, inArchive: true, ...opt })), { collapsed: true });
}

export function archiveNote(e, archived) {
  act(async () => {
    await api('PATCH', `/entries/${e.id}`, { archived });
    if (archived) {
      ui.open.delete(e.id);
      toast(tr('Note archived'), { action: { label: tr('Undo'), fn: () => archiveNote(e, false) } });
    }
  });
}

// ---------- inventory ----------
// Item status: dot shown in the lists (no dot = active).
const ITEM_STATUS = { evaluation: tr('being evaluated'), outdated: tr('outdated'), discarded: tr('discarded') };
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

const NO_CAT = tr('No category');

function catColorPicker(cat) {
  const custom = S.data.catHueOf.get(cat.toLowerCase());
  return huePicker(custom ?? null, hue(cat.toLowerCase()), x => {
    ui.catPicker = null;
    act(() => api('PUT', '/categories/color', { name: cat, hue: x }));
  });
}

// ---------- quick card on hover (only with the mouse: on touch the page opens) ----------
// Used by items (here) and by documents (Documents page, with the file preview).
const peekBox = h('div.peek', { hidden: true });
// The content may grow later (a PDF preview arriving): the card repositions itself.
new ResizeObserver(() => { if (peekAnchor && !peekBox.hidden) placePeek(); }).observe(peekBox);
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
    h('div.peek-name', it.name || h('span.muted', tr('no description'))),
    it.status && h('div.peek-status', statusDot(it), ITEM_STATUS[it.status]),
    h('div.peek-grid',
      aliasCodes(it).length > 0 && row(tr('Alternatives'), h('span.mono', aliasCodes(it).join(' · '))),
      it.firmware && row(tr('Firmware'), h('span.mono', it.firmware), fw && h('span.muted', ` · ${fw.filename}`)),
      it.location && row(tr('Location'), it.location),
      it.url && row(tr('Link'), it.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)),
      it.qty != null && row(tr('Quantity'), String(it.qty)),
      docs.length > 0 && row(tr('Documents'), `${docs.length}`, h('span.muted', ` · ${[...new Set(docs.map(d => kindLabel(d.kind)))].join(', ')}`)),
      projects.length > 0 && row(tr('Projects'), projects.map(p => h('span.tag', { style: `--h:${projHue(p)}` }, `@${p.tag}`))),
      children.length > 0 && row(tr('Contains'), codes(children)),
      parents.length > 0 && row(tr('Used in'), codes(parents)),
      open.length > 0 && row(tr('To do'), `${open.length}`, h('span.muted', ` · ${open[0].title.replace(/(^|\s)#/g, '$1').slice(0, 48)}`))),
    it.notes && h('div.peek-notes', it.notes.length > 280 ? `${it.notes.slice(0, 280)}…` : it.notes),
  ];
}

function placePeek() {
  const r = peekAnchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = peekBox.offsetWidth;
  const ph = peekBox.offsetHeight;
  // To the right of the element if there is room (column view), otherwise below or above (list view).
  if (r.right + 12 + w < vw - 8) {
    peekBox.style.left = `${r.right + 12}px`;
    peekBox.style.top = `${Math.max(8, Math.min(r.top - 8, vh - ph - 8))}px`;
  } else {
    peekBox.style.left = `${Math.max(8, Math.min(r.left + 120, vw - w - 8))}px`;
    peekBox.style.top = `${r.bottom + 6 + ph < vh - 8 ? r.bottom + 6 : Math.max(8, r.top - ph - 6)}px`;
  }
}

// content: function building the content (called only when the card opens).
export function peekable(el, content, cls = null) {
  el.addEventListener('pointerenter', ev => {
    if (ev.pointerType !== 'mouse') return;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      if (!el.isConnected) return;
      if (!peekBox.isConnected) document.body.append(peekBox);
      peekAnchor = el;
      peekBox.className = ['peek', cls].filter(Boolean).join(' ');
      peekBox.replaceChildren(...[content()].flat());
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
// If the list is redrawn (sync) while the card is open, the element under the mouse changes.
document.addEventListener('pointermove', () => { if (peekAnchor && !peekAnchor.isConnected) hidePeek(); });

function itemRow(i) {
  const D = S.data;
  const n = openCountOf(i.id);
  const docs = (D.docsOf.get(i.id) || []).length;
  const alts = aliasCodes(i);
  return peekable(h('a.item-row', { href: `#/i/${i.id}`, class: i.status ? `st-${i.status}` : null },
    statusDot(i),
    h('span.code', itemAttrs(i), i.code),
    alts.length > 0 && h('span.alts', { title: tr('Alternative codes') }, alts.join(' · ')),
    h('span.name', i.name || h('span.muted', tr('no description'))),
    h('span.item-meta',
      i.firmware && h('span.fw', icon('chip'), i.firmware),
      i.location && h('span.loc', i.location),
      i.qty != null && h('span.qty', `×${i.qty}`),
      docs > 0 && h('span.docs', icon('link'), docs),
      n > 0 && h('span.badge', n))), () => peekContent(i));
}

export function viewItems() {
  const D = S.data;
  const f = ui.itemFilter.trim().toLowerCase();
  const docNames = id => (D.docsOf.get(id) || []).map(d => `${d.filename || ''} ${d.label} ${d.version}`).join(' ');
  const cats = new Map();
  for (const i of D.items) cats.set(i.category || '', (cats.get(i.category || '') || 0) + 1);
  if (ui.itemCat != null && !cats.has(ui.itemCat)) ui.itemCat = null;
  const statusCount = { evaluation: 0, outdated: 0, discarded: 0 };
  for (const i of D.items) if (statusCount[i.status] != null) statusCount[i.status]++;
  if (ui.itemStatusF && !statusCount[ui.itemStatusF]) ui.itemStatusF = null;
  const items = D.items
    .filter(i => (ui.itemStatusF ? i.status === ui.itemStatusF : !(ui.hideDiscarded && i.status === 'discarded')))
    .filter(i => ui.itemCat == null || (i.category || '') === ui.itemCat)
    .filter(i => !f || [i.code, ...aliasCodes(i), i.name, i.category, i.firmware, i.location, i.notes, docNames(i.id)].join(' ').toLowerCase().includes(f));
  const setView = v => { ui.itemView = v; save('org.itemView', v); render(); };

  // View by category: a column per item type (side by side on wide screens).
  const groups = new Map();
  for (const i of items) {
    const c = i.category || '';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(i);
  }
  const ordered = [...groups].sort(([a], [b]) => (!a) - (!b) || a.localeCompare(b));

  return h('div.view', { class: roClass(can('magazzino', 'write')) },
    h('div.toolbar',
      h('input.filter', {
        type: 'search', placeholder: tr('Filter by code, name, firmware, location, document…'), value: ui.itemFilter, 'data-fk': 'itemfilter',
        oninput: ev => { ui.itemFilter = ev.target.value; render(); },
      }),
      h('div.seg',
        h('button', { class: ui.itemView === 'list' && 'on', onclick: () => setView('list'), title: tr('List') }, icon('log')),
        h('button', { class: ui.itemView === 'groups' && 'on', onclick: () => setView('groups'), title: tr('By category') }, icon('cols')),
        h('button', { class: ui.itemView === 'tree' && 'on', onclick: () => setView('tree'), title: tr('Trees: what makes up what') }, icon('hash')))),
    cats.size > 1 && h('div.toolbar.cats',
      [...cats].sort(([a], [b]) => (!a) - (!b) || a.localeCompare(b)).map(([c, n]) => filterChip({
        on: ui.itemCat === c, label: c || NO_CAT, n, cls: c ? 'tint by-hue' : 'tint', style: catStyle(c),
        onclick: () => { ui.itemCat = ui.itemCat === c ? null : c; render(); },
      }))),
    Object.values(statusCount).some(Boolean) && h('div.toolbar.cats',
      Object.entries(ITEM_STATUS).filter(([k]) => statusCount[k]).map(([k, label]) => filterChip({
        on: ui.itemStatusF === k, label, n: statusCount[k], cls: `tint s-${k}`, title: tr('Only items {status}', { status: label }),
        onclick: () => { ui.itemStatusF = ui.itemStatusF === k ? null : k; render(); },
      })),
      statusCount.discarded > 0 && filterChip({
        on: ui.hideDiscarded, label: tr('hide discarded'),
        onclick: () => { ui.hideDiscarded = !ui.hideDiscarded; save('org.hideDiscarded', ui.hideDiscarded); render(); },
      })),
    // The explanations always sit under the filters.
    !D.items.length && empty(
      h('p', tr('The inventory is empty.')),
      h('p', tr('Add items from the bar at the top: '), kbd(tr('SCH-042 motor board /board')), '.'),
      h('p', tr('Every '), kbd(tr('#CODE')), tr(' written in an entry creates and links the item automatically.'))),
    D.items.length > 0 && !items.length && empty(h('p', tr('No item matches the filter.'))),
    ui.itemView === 'groups' && items.length > 0 && foldBar('magazzino'),
    ui.itemView === 'groups'
      ? masonry('cat-cols', ordered.map(([c, list]) => fold('magazzino', c || '', h('section.cat-col', { class: c ? 'cat' : null, style: catStyle(c), 'data-cat': c },
        h('div.cat-h',
          c ? h('button.cdot.pick', { class: 'cat', style: catStyle(c), title: tr('Change the category colour'), onclick: () => { ui.catPicker = ui.catPicker === c ? null : c; render(); } })
            : h('span.cdot'),
          h('span', capFirst(c) || NO_CAT), h('span.count', list.length)),
        c && ui.catPicker === c && h('div.cat-pick', catColorPicker(c)),
        h('div.cat-items', list.map(i => peekable(h('a.cat-item', { href: `#/i/${i.id}`, 'data-iid': i.id, draggable: 'false', class: i.status ? `st-${i.status}` : null },
          statusDot(i),
          h('span.code', itemAttrs(i), i.code),
          h('span.name', i.name || ''),
          i.firmware && h('span.fw', i.firmware),
          openCountOf(i.id) > 0 && h('span.badge', openCountOf(i.id))), () => peekContent(i)))))))
        // Visible only while dragging: dropping here creates a new category.
        .concat(h('section.cat-col.cat-new', { 'data-cat': '', 'data-new': '' }, h('div.cat-h', icon('plus'), tr('New category')))))
      : ui.itemView === 'tree' ? itemTrees(items)
        : h('div.items', items.map(itemRow)));
}

// ---------- trees ----------
// What makes up what (Composition on the item page). At the top the items that contain others and are inside none;
// below, their components, all the way down. An item used in several places shows under each; a loop (A inside B
// inside A) stops. With a filter the trees containing an item that passes it stay (highlighted); "tree" on the item
// page shows only that item's trees.
function itemTrees(items) {
  const D = S.data;
  const byCode = (a, b) => a.code.localeCompare(b.code, undefined, { numeric: true });
  const kids = id => (D.childItems.get(id) || []).map(l => D.itemById.get(l.child_id)).filter(Boolean).sort(byCode);
  const focus = D.itemById.get(ui.treeFocus);
  if (!focus) ui.treeFocus = null;
  const filtered = !!(ui.itemFilter.trim() || ui.itemCat != null || ui.itemStatusF);
  const hit = new Set(focus ? [focus.id] : filtered ? items.map(i => i.id) : []);
  // Roots: whoever contains something and is inside nothing; then, for loops, the first item not reached yet.
  const reached = new Set();
  const reach = id => { if (reached.has(id)) return; reached.add(id); for (const c of kids(id)) reach(c.id); };
  const roots = D.items.filter(i => D.childItems.has(i.id) && !(D.parentItems.get(i.id) || []).some(l => D.itemById.has(l.parent_id))).sort(byCode);
  roots.forEach(r => reach(r.id));
  for (const i of D.items.slice().sort(byCode)) if (D.childItems.has(i.id) && !reached.has(i.id)) { roots.push(i); reach(i.id); }
  const contains = (id, seen = new Set()) => hit.has(id) || (!seen.has(id) && kids(id).some(c => contains(c.id, new Set(seen).add(id))));
  const shown = hit.size || filtered ? roots.filter(r => contains(r.id)) : roots;

  // A node: the item's card (category colour on the left) and, on the right, its components joined by lines. The
  // round number closes and reopens the branch.
  const node = (it, path, key, root = false) => {
    const loop = path.has(it.id);
    const ch = loop ? [] : kids(it.id);
    const closed = ui.treeClosed.has(key);
    const card = h('div.g-node', {
      class: [root && 'root', it.category && 'cat', hit.has(it.id) && 'hit', loop && 'loop', it.status && `st-${it.status}`].filter(Boolean).join(' '),
      style: catStyle(it.category),
    },
    h('a.g-main', { href: `#/i/${it.id}`, title: [it.code, it.name, it.category].filter(Boolean).join(' · ') },
      h('span.g-top', statusDot(it), h('span.code', itemAttrs(it), it.code), it.firmware && h('span.fw', it.firmware)),
      it.name && h('span.g-name', it.name),
      loop && h('span.g-name', tr('↻ already further left'))),
    ch.length > 0 && h('button.g-toggle', {
      class: closed ? 'closed' : null, title: closed ? tr('Show the {n} components', { n: ch.length }) : tr('Hide the components'),
      onclick: () => { if (closed) ui.treeClosed.delete(key); else ui.treeClosed.add(key); render(); },
    }, closed ? `+${ch.length}` : String(ch.length)));
    const next = new Set(path).add(it.id);
    return h('li', card, ch.length > 0 && !closed && h('ul', ch.map(c => node(c, next, `${key}>${c.id}`))));
  };

  return h('div.trees',
    focus && h('div.toolbar', filterChip({ on: true, label: [h('span.code', itemAttrs(focus), focus.code), ` ${tr('only its trees')}`, icon('x')],
      onclick: () => { ui.treeFocus = null; render(); } })),
    !roots.length ? empty(h('p', tr('No item contains others.')), h('p', tr('Components are added on the item\'s page, Composition section.')))
      : !shown.length ? empty(h('p', tr('No tree contains items matching the filter.')))
        : shown.map(r => h('section.g-tree', h('ul.g-root', node(r, new Set(), String(r.id), true)))));
}

async function uploadDocs(it, files) {
  for (const f of files) {
    const q = new URLSearchParams({ name: f.name, kind: ui.docKind, version: ui.docVer.trim() });
    toast(tr('Uploading {name}…', { name: f.name }));
    await act(() => api('POST', `/items/${it.id}/docs?${q}`, f), tr('{name} uploaded', { name: f.name }));
  }
  ui.docVer = '';
  render();
}

function docSection(it) {
  const D = S.data;
  const docs = D.docsOf.get(it.id) || [];
  const files = docs.filter(d => !d.url).length;
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: ev => { const files = [...ev.target.files]; ev.target.value = ''; uploadDocs(it, files); } });
  const addLink = async () => {
    const f = await askFields([
      { name: 'url', label: tr('URL of the document (repo, wiki, drive…)'), type: 'url', placeholder: 'https://' },
      { name: 'label', label: tr('Label'), placeholder: tr('optional') },
    ], { title: tr('Link'), ok: tr('Add') });
    const url = f?.url.trim();
    if (!url) return;
    const label = f.label.trim();
    act(() => api('POST', `/items/${it.id}/docs`, { url, label, kind: ui.docKind, version: ui.docVer.trim() }));
  };
  const body = [
    h('div.upload',
      kindPicker(ui.docKind, k => { ui.docKind = k; render(); }, { title: tr('Kind of the documents to upload') }),
      h('input', { placeholder: tr('version'), size: 9, value: ui.docVer, 'data-fk': `docver-${it.id}`, oninput: ev => { ui.docVer = ev.target.value; } }),
      h('button.btn', { onclick: () => fileInput.click() }, icon('upload'), tr('File')),
      h('button.btn.ghost', { onclick: addLink }, icon('link'), tr('Link')),
      fileInput,
      // A link and not a button: it stays active also for those who can only read.
      files > 1 && h('a.btn.ghost.dl-all', { href: `api/items/${it.id}/docs.zip`, download: '', title: tr('The item\'s {n} files in a .zip (not the links)', { n: files }) },
        icon('download'), tr('Download all'))),
    h('p.muted.drop-hint', tr('Drop the files here. A firmware with a version updates the "Firmware" field.')), // only while dragging files
    docs.map(d => h('div.doc',
      docMeta(d),
      h('div.doc-main',
        h('span.doc-name',
          peekable(h('a', { href: `#/d/${d.id}` }, docName(d)), () => docPeek(d), 'peek-doc'),
          h('button.icon-btn.sm', { title: tr('Rename'), onclick: () => renameDoc(d) }, icon('edit')),
          h('button.icon-btn.sm', { title: tr('Move or copy to another item'), onclick: () => moveDoc(d) }, icon('copy'))),
        h('div.meta',
          d.label && d.filename && h('span', d.filename),
          d.size != null && h('span', fmtSize(d.size)),
          d.sha256 && h('button.sha', { title: tr('sha256 {hash} (click to copy)', { hash: d.sha256 }), onclick: () => copy(d.sha256) }, d.sha256.slice(0, 10)),
          (() => {
            const n = (D.docNotesOf.get(d.id) || []).filter(x => !x.resolved_at).length;
            return n > 0 && h('a.doc-notes', { href: `#/d/${d.id}`, title: tr('Notes on the document') }, icon('log'), n);
          })(),
          h('span', fmtTime(d.created_at)))),
      !d.url && h('a.icon-btn', { href: docFileUrl(d), title: tr('Download'), download: '' }, icon('download')),
      h('button.icon-btn', {
        title: tr('Delete'),
        onclick: () => trashIt('doc', `/docs/${d.id}`, d.label || d.filename || tr('Link')),
      }, icon('trash')))),
  ];
  const sec = section(`i-docs`, tr('Documents'), body, { count: docs.length, cls: roClass(can('documenti', 'write')) });
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
  if (!it) return empty(h('p', tr('Item not found.')), h('a', { href: '#/magazzino' }, tr('Back to the inventory')));
  const patch = f => act(() => api('PATCH', `/items/${it.id}`, f));
  const field = (key, label, attrs = {}, cls = null) => h('label.f', { class: cls }, h('span', label),
    h('input', { value: it[key] ?? '', 'data-fk': `it-${key}-${it.id}`, ...attrs, onchange: ev => patch({ [key]: ev.target.value }) }));

  const children = (D.childItems.get(it.id) || []).map(l => D.itemById.get(l.child_id)).filter(Boolean);
  const parents = (D.parentItems.get(it.id) || []).map(l => D.itemById.get(l.parent_id)).filter(Boolean);
  const linked = (D.entriesOfItem.get(it.id) || []).map(x => D.entryById.get(x.entry_id)).filter(Boolean);
  // Mails are in the "In the mails" box (to send / sent), together with those mentioning the code without #.
  const open = linked.filter(e => e.kind === 'todo' && !e.done_at).sort(byDue);
  const allNotes = linked.filter(e => e.kind === 'note');
  const notes = allNotes.filter(e => !e.archived_at).sort(byNoteDesc);
  const done = linked.filter(e => e.kind === 'todo' && e.done_at).sort(byDoneDesc);
  const manualProjects = (D.projectsOfItem.get(it.id) || []).map(x => D.projectById.get(x.project_id)).filter(Boolean);
  const viaEntries = [...new Set(linked.map(e => e.project_id).filter(Boolean))]
    .filter(pid => !manualProjects.some(p => p.id === pid)).map(pid => D.projectById.get(pid)).filter(Boolean);
  const linkProject = text => {
    const p = D.projectByTag.get(text.replace(/^@/, '').toLowerCase());
    if (!p) return toast(tr('Project @{tag} does not exist', { tag: text.replace(/^@/, '') }), { err: true });
    act(() => api('POST', `/projects/${p.id}/items`, { code: it.code }));
  };

  return h('div.view', { class: roClass(can('magazzino', 'write')) },
    h('div.head',
      h('a.icon-btn', { href: '#/magazzino', title: tr('Inventory (Esc)') }, icon('back')),
      it.category && h('button.cdot.big.pick', {
        class: 'cat', style: catStyle(it.category), title: tr('Colour of the category "{cat}"', { cat: it.category }),
        onclick: () => { ui.catPicker = ui.catPicker === it.category ? null : it.category; render(); },
      }),
      h('input.h-title.mono', { value: it.code, 'data-fk': `icode-${it.id}`, onchange: ev => patch({ code: ev.target.value }) }),
      h('button.icon-btn', { title: tr('Copy code'), onclick: () => copy(it.code) }, icon('copy')),
      h('div.seg.status-seg', { title: tr('Item status') },
        [['', tr('active')], ...Object.entries(ITEM_STATUS)].map(([k, label]) =>
          h('button', { class: (it.status || '') === k && 'on', onclick: () => patch({ status: k }) }, k && h('span.sdot', { class: `s-${k}` }), label)))),
    it.category && ui.catPicker === it.category && h('div.cat-pick', h('span.muted', tr('Colour of the category "{cat}" (applies to all its items): ', { cat: it.category })), catColorPicker(it.category)),
    // Alternative codes: the main one stays the one the item is known by; these find it as well.
    h('div.aliases',
      h('span.muted', tr('Alternative codes')),
      aliasCodes(it).map(code => h('span.chip-wrap',
        h('span.code', itemAttrs(it), code),
        h('button.icon-btn.sm', { title: tr('Remove {code}', { code }), onclick: () => act(() => api('DELETE', `/items/${it.id}/aliases/${encodeURIComponent(code)}`)) }, icon('x')))),
      h('input.sub-in.mono', {
        placeholder: tr('+ alternative code'), size: 20, 'data-fk': `ialias-${it.id}`, autocomplete: 'off', autocapitalize: 'characters',
        onkeydown: enterAdd(code => act(() => api('POST', `/items/${it.id}/aliases`, { code }))),
      })),
    h('div.grid',
      field('name', tr('Description'), { placeholder: tr('e.g. motor control board') }, 'wide'),
      field('category', tr('Category'), { placeholder: tr('board, product, cable…'), list: 'item-cats' }),
      field('firmware', tr('Firmware'), { placeholder: tr('current version'), class: 'mono' }),
      field('location', tr('Location'), { placeholder: tr('shelf, drawer…') }),
      field('qty', tr('Quantity'), { type: 'number', inputmode: 'numeric' }),
      h('label.f', h('span', tr('Link (optional)')),
        h('span.url-f',
          h('input', { value: it.url || '', type: 'url', placeholder: tr('product page, repo, wiki…'), 'data-fk': `it-url-${it.id}`, onchange: ev => patch({ url: ev.target.value.trim() }) }),
          /^https?:\/\//i.test(it.url || '') && h('button.icon-btn', { type: 'button', title: tr('Preview the page'), onclick: () => openBrowser(it.url, { item: it }) }, icon('globe')),
          it.url && h('a.icon-btn', { href: it.url, target: '_blank', rel: 'noopener noreferrer', title: tr('Open the link') }, icon('link')))),
      h('datalist#item-cats', [...new Set(D.items.map(i => i.category).filter(Boolean))].map(c => h('option', { value: c })))),
    richField({
      fk: `inotes-${it.id}`, cls: 'proj-notes', value: it.notes, placeholder: tr('Notes: pinout, jumpers, flashing procedure, default passwords… (Markdown: # heading, **bold**, - list)'),
      attrs: { 'data-ac': 'text', 'data-ac-only': '#' }, onSave: notes => patch({ notes }), md: true,
    }),
    docSection(it),
    section('i-comp', tr('Composition'), [
      h('div.comp',
        h('span.muted', tr('Contains')),
        h('div.item-chips', children.map(c => h('span.chip-wrap', itemChip(c),
          h('button.icon-btn.sm', { title: tr('Unlink'), onclick: () => act(() => api('DELETE', `/items/${it.id}/children/${c.id}`)) }, icon('x'))))),
        h('input.sub-in.mono', {
          placeholder: tr('+ component code (new if it does not exist)'), 'data-fk': `child-${it.id}`, size: 22,
          'data-ac': 'code', 'data-ac-self': it.code, autocomplete: 'off', autocapitalize: 'characters',
          onkeydown: enterAdd(code => act(() => api('POST', `/items/${it.id}/children`, { code }))),
        })),
      parents.length > 0 && h('div.comp', h('span.muted', tr('Used in')), h('div.item-chips', parents.map(itemChip))),
      (children.length > 0 || parents.length > 0) && h('a.btn.sm.ghost', {
        href: '#/magazzino', title: tr('The trees it is part of, in the inventory'),
        onclick: () => { ui.itemView = 'tree'; save('org.itemView', 'tree'); ui.treeFocus = it.id; },
      }, icon('hash'), tr('Show the tree')),
    ], { count: children.length + parents.length }),
    section('i-proj', tr('Projects'), [
      h('div.comp',
        h('div.item-chips', manualProjects.map(p => h('span.chip-wrap', projTag(p),
          h('button.icon-btn.sm', { title: tr('Unlink from the project'), onclick: () => act(() => api('DELETE', `/projects/${p.id}/items/${it.id}`)) }, icon('x'))))),
        h('input.sub-in', {
          placeholder: tr('+ link to a project'), 'data-fk': `iproj-${it.id}`, size: 20, 'data-ac': 'project', autocomplete: 'off',
          onkeydown: enterAdd(linkProject),
        })),
      viaEntries.length > 0 && h('div.comp', h('span.muted', tr('Mentioned in entries of')), h('div.item-chips', viaEntries.map(projTag))),
    ], { count: manualProjects.length + viaEntries.length }),
    section('i-todo', tr('To do'), open.length ? open.map(e => entryRow(e)) : [empty(h('p', tr('Write in the bar at the top: the entries will be linked to '), kbd(`#${it.code}`), '.'))], { count: open.length }),
    backlinksBox('articolo', it.id, { title: tr('In the mails'), mailsOnly: true }),
    notes.length > 0 && section('i-notes', tr('Journal'), notes.map(e => entryRow(e, { showKind: false }))),
    archivedNotes(`i${it.id}`, allNotes),
    done.length > 0 && section('i-done', tr('Completed'), done.map(e => entryRow(e)), { collapsed: true }),
    h('div.danger-zone',
      h('span.muted', tr('Created {when} by {name}', { when: fmtTime(it.created_at), name: userName(it.created_by) })),
      h('button.btn.sm.danger', {
        onclick: async () => {
          if (!await askConfirm(tr('Move {code} and its documents to the trash?', { code: it.code }), { ok: tr('Move to the trash'), danger: true })) return;
          trashIt('item', `/items/${it.id}`, it.code).then(ok => { if (ok) location.hash = '#/magazzino'; });
        },
      }, icon('trash'), tr('Delete item'))));
}

// ---------- search ----------
export function viewSearch() {
  const D = S.data;
  const q = ui.q.trim().toLowerCase();
  if (!q) return empty(h('p', tr('Search entries, projects, inventory, documents and contacts.')), h('p', kbd('Ctrl/⌘ K'), tr(' to get here from the keyboard.')));
  const has = s => String(s || '').toLowerCase().includes(q);
  const entries = D.entries.filter(e => has(e.title) || has(e.notes) || has(e.contact) || (D.logsOf.get(e.id) || []).some(l => has(l.text)))
    .sort((a, b) => !!a.done_at - !!b.done_at || b.updated_at.localeCompare(a.updated_at));
  const projects = D.projects.filter(p => has(p.name) || has(p.tag) || has(p.notes));
  const contacts = D.contacts.filter(c => [c.name, c.email, c.company, c.role, c.phone, c.notes].some(has));
  const docNotes = D.docNotes.filter(n => has(n.text) && D.docById.has(n.doc_id));
  const items = D.items.filter(i => [i.code, ...aliasCodes(i), i.name, i.category, i.firmware, i.location, i.notes].some(has)
    || (D.docsOf.get(i.id) || []).some(d => has(d.filename) || has(d.label) || has(d.version)));

  return h('div.view',
    projects.length > 0 && section('s-proj', tr('Projects'), [h('div.item-chips', projects.map(p => h('a.item-chip', { href: `#/p/${p.id}` }, h('span', p.name), h('span.code', `@${p.tag}`))))], { count: projects.length }),
    items.length > 0 && section('s-items', tr('Inventory'), [h('div.item-chips', items.map(itemChip))], { count: items.length }),
    docNotes.length > 0 && section('s-docnotes', tr('Notes on documents'), docNotes.slice(0, 50).map(n => {
      const d = D.docById.get(n.doc_id);
      return h('a.search-note', { href: `#/d/${d.id}?n=${n.id}` },
        h('span.muted', `${d.label || d.filename}${n.page ? ` · ${tr('p. {n}', { n: n.page })}` : ''}`), h('span', n.text));
    }), { count: docNotes.length }),
    contacts.length > 0 && section('s-contacts', tr('Contacts'), [h('div.item-chips', contacts.map(c =>
      h('a.item-chip', { href: `#/contatti/${c.id}` }, icon('user'), h('span', c.name || c.email), c.company && h('span.muted', c.company))))], { count: contacts.length }),
    section('s-entries', tr('Entries'), entries.length ? entries.slice(0, 200).map(e => entryRow(e, { showParent: true })) : [empty(h('p', tr('No recent entry matches.')))], { count: entries.length }),
    ui.archive?.q === q
      ? section('s-arch', tr('Archive (completed more than 30 days ago)'), ui.archive.rows.length ? ui.archive.rows.map(e => entryRow(e)) : [empty(h('p', tr('Nothing in the archive.')))], { count: ui.archive.rows.length })
      : h('button.btn.ghost.more', {
        onclick: () => act(async () => { ui.archive = { q, rows: await api('GET', `/archive?q=${encodeURIComponent(q)}`) }; render(); }),
      }, tr('Search the archive too')));
}

// ---------- settings ----------
function loadInvites() {
  ui.invites = [];
  api('GET', '/admin/invites').then(r => { ui.invites = r; render(); }).catch(() => {});
}

function loadTokens() {
  ui.tokens = [];
  api('GET', '/tokens').then(r => { ui.tokens = r; render(); }).catch(() => {});
}

// Tokens for the CLI and external programs (bots, scripts): shown only once, when created.
function tokensSection() {
  if (ui.tokens == null) loadTokens();
  const create = async () => {
    const name = await askText(tr('Name of the token (e.g. "telegram bot", "backup script"):'), { title: tr('Create token'), ok: tr('Create') });
    if (!name?.trim()) return;
    act(async () => {
      const r = await api('POST', '/tokens', { name });
      loadTokens();
      showText(tr('Copy the token now: it will not be shown again.'), r.token);
    });
  };
  return card('set-tokens', tr('CLI and API tokens'), [
    h('p', tr('From the terminal: install the CLI with '), kbd('make cli'), tr(' and log in with '), kbd(`org login ${location.origin}`), '.'),
    h('p.muted', tr('For a bot or a script create a token: it gives access to everything you see, in all your workspaces. The API is described in docs/API.md.')),
    h('button.btn', { onclick: create }, icon('plus'), tr('Create token')),
    ui.tokens.map(t => h('div.invite',
      h('code', `…${t.hint}`),
      h('span', t.name),
      h('span.muted', t.last_used_at ? tr('used {when}', { when: fmtTime(t.last_used_at) }) : tr('never used')),
      h('span.grow'),
      h('button.icon-btn', {
        title: tr('Revoke'),
        onclick: async () => { if (await askConfirm(tr('Revoke the token "{name}"? Whoever uses it will no longer have access.', { name: t.name }), { ok: tr('Revoke'), danger: true })) act(async () => { await api('DELETE', `/tokens/${t.id}`); loadTokens(); }, tr('Token revoked')); },
      }, icon('x')))),
  ], { count: ui.tokens.length || '', collapsed: true });
}

// Token for the Thunderbird extension: like the other tokens, it is shown only once.
function thunderbirdToken() {
  act(async () => {
    const r = await api('POST', '/tokens', { name: 'Thunderbird' });
    loadTokens();
    showText(tr('Copy the token and paste it in the extension\'s options: it will not be shown again.'), r.token);
  });
}

const inviteLink = code => `${location.origin}${location.pathname}#/registrati?code=${code}`;

// Themes: a card with a preview of the colours for each one; applied at once (valid for this device).
function themeCard(id, name, t) {
  const on = currentTheme() === id;
  const prev = t
    ? h('span.th-prev', { style: `background:${t.bg};background-image:${t.grad || 'none'}` },
      h('span.th-panel', { style: `background:${t.panel};border-color:${t.line}` },
        h('span.th-line', { style: `background:${t.text}` }), h('span.th-line.short', { style: `background:${t.muted}` }),
        h('span.th-dots', [t.accent, t.blue, t.purple, t.orange].map(c => h('span', { style: `background:${c}` })))))
    : h('span.th-prev', { class: `base-${id}` }, h('span.th-panel', h('span.th-line'), h('span.th-line.short'), h('span.th-dots', h('span'), h('span'), h('span'), h('span'))));
  // .keep: the theme is per device, it can be changed offline too.
  return h('button.th-card.keep', { class: on ? 'on' : null, title: name, 'aria-pressed': String(on), onclick: () => { setTheme(id); applyIcon(id); render(); } }, prev, h('span.th-name', name));
}

function themeSection() {
  const all = Object.entries(THEMES);
  return card('set-theme', tr('Theme'), [
    h('div.th-grid', Object.entries(BASE_THEMES).map(([id, name]) => themeCard(id, name, null))),
    h('div.th-h', tr('Dark')),
    h('div.th-grid', all.filter(([, t]) => t.dark && !t.funky).map(([id, t]) => themeCard(id, t.name, t))),
    h('div.th-h', tr('Light')),
    h('div.th-grid', all.filter(([, t]) => !t.dark && !t.funky).map(([id, t]) => themeCard(id, t.name, t))),
    h('div.th-h', 'Funky'),
    h('div.th-grid', all.filter(([, t]) => t.funky).map(([id, t]) => themeCard(id, t.name, t))),
    h('p.muted', tr('Inspired by the colour schemes most used in Neovim and VS Code, plus some funky themes (gradient backgrounds, glowing accents, old-time terminals). The theme is per device.')),
  ], { count: '', collapsed: true });
}

// App icon: automatic (the theme's) or a chosen one, even from another theme. Applies to this device.
function iconSection() {
  const pick = currentIcon();
  const auto = themeIcon(currentTheme());
  const choice = (id, name, src) => h('button.ic-card.keep', {
    class: pick === id ? 'on' : null, title: name, 'aria-pressed': String(pick === id),
    onclick: () => { setIcon(id, currentTheme()); render(); },
  }, h('img', { src: `icons/app/${src}-192.png`, alt: '', width: 56, height: 56, loading: 'lazy' }), h('span.th-name', name));
  const group = g => APP_ICONS.filter(i => i.group === g).map(i => choice(i.id, i.name, i.id));
  return card('set-icon', tr('App icon'), [
    h('div.ic-grid', choice('auto', tr('Automatic (from the theme)'), auto), group('base'), group('minimal')),
    h('div.th-h', tr('From the themes')),
    h('div.ic-grid', group('tema')),
    h('div.th-h', 'Funky'),
    h('div.ic-grid', group('funky')),
    h('p.muted', tr('The icon changes right away in the browser tab and applies to this device. For an app already installed the system keeps the icon it had when you installed it: to see the new one, remove the app and add it again (iPhone, iPad and Mac: "Add to Home Screen" or "Add to Dock"; Android: reinstall it from the browser menu; Chrome sometimes updates it by itself after a few days).')),
  ], { count: '', collapsed: true });
}

// ---------- permissions (Settings) ----------
// Admin: for each person of the workspace (not admin) the level of each area. Changing a level adjusts the
// linked areas by themselves (see perms.js): writing mails makes contacts, documents… readable.
const needsText = deps => deps.map(a => tr(AREAS[a])).join(', ');

// What each area covers (first column of the permissions table).
const AREA_DESC = {
  voci: tr('todos, subtasks, journal notes'),
  mail: tr('mails to send and sent, conversations'),
  progetti: tr('projects and subprojects'),
  magazzino: tr('items, codes, categories'),
  documenti: tr('item files and notes on files'),
  contatti: tr('address book'),
  chat: tr('messages in the channels one belongs to'),
};
const LEVEL_FULL = { none: tr('No access'), read: tr('Read'), write: tr('Write') };
const CAP_DESC = { canali: tr('create, rename, delete channels and choose their people') };

// Table: one row per area, one column per person (not admin); in each cell the level in full.
// Changing a level adjusts the linked areas by themselves (see perms.js).
function permsSection(D) {
  const others = D.members.filter(u => !u.is_admin);
  const admins = D.members.filter(u => u.is_admin);
  const setPerms = (u, perms) => act(() => api('PATCH', `/admin/users/${u.id}`, { perms }), tr('Permissions of {name} updated', { name: u.name || u.username }));
  const permsOf = u => D.memberPerms?.[u.id] || fullAccess();
  const who = u => u.name || u.username;
  const cell = (u, key, options) => {
    const cur = permsOf(u);
    const v = cur[key] || (key in CAPS ? 'none' : 'write');
    return h('td', h('select.pm-sel', {
      class: `lvl-${v}`, value: v, 'aria-label': `${who(u)}: ${tr(AREAS[key] || CAPS[key])}`,
      onchange: ev => setPerms(u, setLevel(cur, key, ev.target.value)),
    }, options.map(([l, label]) => h('option', { value: l, selected: l === v }, label))));
  };
  return card('set-perms', tr('Permissions per area'), [
    h('p.muted', tr('For each person choose what they can do in each area. Admins can do everything, but they do not see what the others do not share (see Privacy and sharing).')),
    others.length
      ? h('div.pm-wrap', h('table.pmt',
        h('caption.sr-only', tr('Permissions per area: areas in the rows, people in the columns')),
        h('thead', h('tr',
          h('th', { scope: 'col' }, tr('Area')),
          others.map(u => h('th', { scope: 'col' },
            h('span.pm-name', who(u)), h('span.muted', `@${u.username}`),
            isRestricted(D.memberPerms?.[u.id]) || D.memberPerms?.[u.id]?.canali === 'write'
              ? h('button.btn.sm.ghost', { title: tr('Full access for {name} (without managing channels)', { name: who(u) }), onclick: () => setPerms(u, null) }, tr('reset'))
              : h('span.muted.pm-full', tr('full access')))))),
        h('tbody',
          Object.keys(AREAS).map(a => h('tr',
            h('th', { scope: 'row' }, h('b', tr(AREAS[a])), h('span.muted', AREA_DESC[a] || '')),
            others.map(u => cell(u, a, Object.entries(LEVEL_FULL))))),
          Object.keys(CAPS).map(c => h('tr.pm-cap',
            h('th', { scope: 'row' }, h('b', tr(CAPS[c])), h('span.muted', CAP_DESC[c] || '')),
            others.map(u => cell(u, c, [['none', tr('No')], ['write', tr('Yes')]])))))))
      : h('p', tr('There are no other people (not admin) in this workspace: invite them from "Workspace and people".')),
    admins.length > 0 && h('p.muted', tr('Admins, always with everything: {names}.', { names: admins.map(who).join(', ') })),
    h('div.pm-legend',
      h('span.pm-sel.lvl-none', tr('No access')), h('span', tr('the area disappears from the menu')),
      h('span.pm-sel.lvl-read', tr('Read')), h('span', tr('sees it, changes nothing')),
      h('span.pm-sel.lvl-write', tr('Write')), h('span', tr('sees and edits'))),
    h('details.pm-rules', h('summary', tr('Linked areas')),
      h('ul', Object.entries(WRITE_NEEDS).filter(([, deps]) => deps.length).map(([a, deps]) =>
        h('li', h('b', tr('Writing {area}', { area: tr(AREAS[a]) })), ' ', tr('requires reading {list}.', { list: needsText(deps) }))),
      Object.entries(READ_NEEDS).map(([a, deps]) => h('li', h('b', tr('Reading {area}', { area: tr(AREAS[a]) })), ' ', tr('requires reading {list}.', { list: needsText(deps) })))),
      h('p.muted', tr('Raising a level raises by itself the areas it needs; removing an area lowers the ones that need it.'))),
  ]);
}

// Non-admins see their own permissions, if they have restrictions.
function myPermsSection(D) {
  if (!isRestricted(D.perms) && !D.canManageChannels) return null;
  return card('set-myperms', tr('Your permissions'), [
    h('div.pm-mine',
      Object.entries(AREAS).map(([a, label]) => h('span.chip', { class: `pm-l-${D.perms?.[a] || 'write'}` }, tr(label), ': ', tr(LEVELS[D.perms?.[a] || 'write']))),
      D.canManageChannels && h('span.chip.pm-l-write', tr(CAPS.canali))),
    h('p.muted', tr('A workspace admin decides them.')),
  ]);
}

// A Settings box: title and content (nothing collapsible: each category is already a page).
function card(id, title, children, { cls } = {}) {
  return h('section.set-card', { id, class: cls || null, 'aria-labelledby': `${id}-t` }, h('h3', { id: `${id}-t` }, title), children);
}

// Categories: on the left (on a phone a list that opens one page at a time), the content on the right.
function settingsCategories(D) {
  const me = D.me;
  return [
    ['account', tr('Account'), 'user', tr('Name, password, sign out')],
    ['aspetto', tr('Appearance'), 'palette', tr('Theme and contact colours')],
    ['privacy', tr('Privacy and sharing'), 'shield', tr('Who sees what, +person and +all')],
    ['notifiche', tr('Notifications'), 'bell', D.pushDevices ? trn(D.pushDevices, 'on for 1 device', 'on for {n} devices') : tr('mentions, mails, channels')],
    ['mail', tr('Mail and Thunderbird'), 'mail', D.mailExt ? tr('Thunderbird connected') : tr('Extension for Thunderbird')],
    ['workspace', tr('Workspace and people'), 'users', `${D.workspace.name} · ${trn(D.members.length, '1 person', '{n} people')}`],
    me.is_admin && ['permessi', tr('Permissions'), 'lock', tr('What each person can do, chat channels')],
    ['token', tr('CLI and tokens'), 'key', tr('Terminal, bots and scripts')],
    ['barra', tr('Quick bar'), 'keyboard', tr('Syntax and shortcuts')],
    ['app', tr('App and help'), 'phone', `${tr('Installation, language, what\'s new, feedback')}${S.version ? ` · v${S.version}` : ''}`],
    ['backup', me.is_admin ? tr('Backup and data') : tr('Your data'), 'download', me.is_admin ? tr('Workspace backup, export and import') : tr('Export and import your data')],
    D.feedbackOpen != null && ['feedback', tr('Feedback received'), 'bug', D.feedbackOpen ? tr('{n} to look at', { n: D.feedbackOpen }) : tr('none to look at')],
  ].filter(Boolean);
}

function settingsPane(sec, D) {
  const me = D.me;
  switch (sec) {
    case 'account': return [
      card('set-me', tr('Profile'), [
        h('div.grid',
          h('label.f', h('span', tr('Username')), h('input', { value: me.username, disabled: true })),
          h('label.f', h('span', tr('Display name')), h('input', { value: me.name, 'data-fk': 'myname', onchange: ev => act(() => api('PATCH', '/me', { name: ev.target.value }), tr('Name updated')) }))),
      ]),
      card('set-pass', tr('Password'), [
        h('form.grid', {
          onsubmit: ev => {
            ev.preventDefault();
            const f = ev.target.elements;
            act(async () => { await api('PATCH', '/me', { current: f.current.value, password: f.password.value }); ev.target.reset(); }, tr('Password changed'));
          },
        },
        h('label.f', h('span', tr('Current password')), h('input', { name: 'current', type: 'password', autocomplete: 'current-password', required: true })),
        h('label.f', h('span', tr('New password (at least 8 characters)')), h('input', { name: 'password', type: 'password', autocomplete: 'new-password', minlength: 8, required: true })),
        h('div', h('button.btn', { type: 'submit' }, tr('Change password')))),
      ]),
      card('set-session', tr('Session'), [
        h('div.set-row', h('span', tr('Signed in as '), h('b', me.username)), h('span.grow'),
          h('button.btn', { onclick: () => window.dispatchEvent(new Event('org:logout')) }, icon('logout'), tr('Sign out'))),
      ]),
    ];
    case 'aspetto': return [
      themeSection(),
      iconSection(),
      card('set-contacts', tr('Contact colour'), [
        h('label.f', h('span', tr('Colour the contacts\' names')),
          selectOf(ui.contactColor, Object.entries(CONTACT_COLOR), v => { ui.contactColor = v; save('org.contactColor', v); render(); })),
        h('p.muted', tr('Contact names are coloured in mails, in the address book and in links. By company, time slot or role: the same colour for those with the same value (without that detail, no colour). Applies to this device.')),
      ]),
    ];
    case 'privacy': return [
      card('set-privacy', tr('Who sees what'), [h('p.pm-note', icon('lock'), tr(PRIVACY_NOTE))]),
      card('set-share', tr('Sharing'), [
        h('table.syntax', h('tbody', [
          ['+marco', tr('Marco sees it too')],
          ['++marco', tr('Marco sees it too, and you assign it to Marco')],
          ['+all', tr('everyone in the workspace sees it, even those who join later')],
        ].map(([k, v]) => h('tr', h('td', kbd(k)), h('td', v))))),
        h('p.muted', tr('It works in the top bar, in an entry\'s title, in the projects bar and in the text of notes on documents. Every entry, project, contact and note also has "Visible to": whoever created it chooses who to share it with, and can remove the sharing.')),
      ]),
      myPermsSection(D) || card('set-myperms', tr('Your permissions'), [h('p.muted', me.is_admin ? tr('You are an admin of this workspace: you can do everything in the areas (but you do not see what the others do not share).') : tr('No restrictions: you can do everything in the areas.'))]),
    ];
    case 'notifiche': return notificationsPane(D);
    case 'mail': return [card('set-mail', tr('Connect Thunderbird'), [
      h('p', tr('With the Organizer extension for Thunderbird, "Send" opens the mail in Thunderbird with its attachments (even if you press it on your phone: it opens on the computer). When you send it, it becomes "sent" by itself. Received and sent mails are gathered into threads (Mail page): if a reply arrives on an old conversation, Organizer gets the earlier messages from Thunderbird too.')),
      h('p.muted', tr('Already have the extension? Version 1.7 is needed for "Open in Thunderbird" and to choose the workspace of each mail account (in the extension\'s options), 1.6 for the preview of received attachments (1.5 for mail by topic: on the first connection it loads the last month from all folders, and in Thunderbird right-clicking a mail offers "Bring the thread into Organizer"). Download it again and reinstall it (token and settings stay).')),
      D.mailExt && D.mailExtVersion != null && (D.mailExtVersion || '0').localeCompare('1.9', undefined, { numeric: true }) < 0 && h('p.warn', icon('help'), tr('Thunderbird is connected with an old extension{version}: update it (it is needed for the preview of attachments, "Open in Thunderbird", the workspace of each account and the mails read here marked read in Thunderbird too).', { version: D.mailExtVersion ? ` (${D.mailExtVersion})` : '' })),
      h('p', D.mailExt ? h('span.chip.on', icon('check'), D.mailExtVersion ? tr('Thunderbird connected (extension {version})', { version: D.mailExtVersion }) : tr('Thunderbird connected')) : h('span.chip', tr('Thunderbird not connected'))),
      h('ol.steps',
        h('li', h('a.btn.sm', { href: 'api/mail/thunderbird.xpi', download: '' }, icon('download'), tr('Download the extension')), ' ', tr('already set up for this address.')),
        h('li', tr('In Thunderbird: menu ≡ → Add-ons and Themes → gear → "Install Add-on From File…", and choose the file.')),
        h('li', h('button.btn.sm', { onclick: thunderbirdToken }, icon('plus'), tr('Create token for Thunderbird')),
          ' ', tr('and paste it into the extension\'s options (Add-ons → Organizer → Options), then "Save and connect".'))),
      h('p.muted', tr('It works while Thunderbird is open. Incoming mail is yours only; with the extension\'s "replies only" option the other mails do not leave Thunderbird.')),
      h('details',
        h('summary.muted', tr('Without the extension')),
        h('p', tr('"Send" can use the old helper (installed from the project folder with '), kbd('make mail-helper'), tr(') or the default mail app, without attachments: for those there is the ".eml" button. In these cases the mail is marked as sent by hand.')),
        h('label.check-row',
          h('input', { type: 'checkbox', checked: ui.mailHelper, onchange: ev => { ui.mailHelper = ev.target.checked; save('org.mailHelper', ui.mailHelper); render(); } }),
          tr('Helper installed on this computer'))),
    ])];
    case 'workspace': return [workspaceSection(D), peopleCard(D)];
    case 'permessi': return me.is_admin ? [permsSection(D)] : null;
    case 'token': return [tokensSection()];
    case 'barra': return [card('set-syntax', tr('Quick bar syntax'), [
      h('table.syntax', h('tbody',
        [
          ['t: m: n:', tr('type: todo (default), mail, note')],
          [LANG === 'it' ? '!oggi !domani !ven !3g !2s !1m !fm !25/11 !no' : '!today !tomorrow !fri !3d !2w !1m !eom !25/11 !none', tr('due date (for notes: when it happened); !none removes it')],
          [tr('@project'), tr('project, created on the fly if it does not exist')],
          [tr('#CODE'), tr('inventory item, stays in the text as a link')],
          [tr('+person'), tr('that person sees it too (without it: only you)')],
          [tr('++person'), tr('that person sees it and you assign it to them')],
          ['+all', tr('everyone sees it')],
          [tr('>recipient'), tr('recipient of the mail')],
        ].map(([k, v]) => h('tr', h('td', kbd(k)), h('td', v))))),
      h('p.muted', tr('The same tokens work when editing an entry\'s title and in updates: write "{example}" and the due date moves, leaving a trace.', { example: LANG === 'it' ? 'slitta tutto !lun' : 'all postponed !mon' })),
      h('p.muted', tr('From the keyboard: '), kbd('n'), tr(' or '), kbd('/'), tr(' writes an entry, '), kbd('Ctrl/⌘ K'), tr(' searches, '), kbd('Esc'), tr(' leaves the field.')),
    ])];
    case 'app': return [
      card('set-lang', tr('Language'), [
        h('label.f', h('span', tr('Language of the app')), selectOf(LANG, Object.entries(LANGS), setLang)),
        h('p.muted', tr('Applies to this device. Notifications and the tour content follow the language you use most recently.')),
      ]),
      card('set-tour', tr('Organizer tour'), [
        h('p.muted', tr('A guided tour of the features, on a test workspace with fake content (Anna and Luca do not exist). You can touch everything; at the end you delete it with one click.')),
        h('div.toolbar',
          h('button.btn.primary', { onclick: () => act(startTour) }, icon('help'), tourState() ? tr('Resume the tour') : tr('Take the tour')),
          D.tourWs && h('button.btn.ghost', { onclick: async () => (await askConfirm(tr('Delete the test workspace and everything in it?'), { ok: tr('Delete'), danger: true })) && act(deleteTour) },
            icon('trash'), tr('Delete the test workspace'))),
      ]),
      card('set-help', tr('What\'s new and feedback'), [
        h('div.set-links',
          h('a.set-link', { href: '#/novita' }, icon('news'), h('span', h('b', tr('What\'s new')), h('span.muted', S.version ? tr('version {v}', { v: S.version }) : tr('what has changed')))),
          h('button.set-link', { type: 'button', onclick: openFeedback }, icon('bug'), h('span', h('b', tr('Feedback')), h('span.muted', tr('report a bug or an idea, also with screenshots')))),
          h('a.set-link', { href: '#/cestino' }, icon('trash'), h('span', h('b', tr('Trash')), h('span.muted', D.trashCount ? trn(D.trashCount, '1 item', '{n} items') : tr('empty'))))),
      ]),
      card('set-app', tr('Install the app'), [
        h('ul.install',
          h('li', h('b', 'iPhone/iPad: '), tr('open in Safari → Share → "Add to Home Screen".')),
          h('li', h('b', 'Android: '), tr('open in Chrome → menu ⋮ → "Install app" (it needs HTTPS, see docs/GUIDE.md).')),
          h('li', h('b', 'Mac: '), tr('Safari → File → "Add to Dock", or Chrome → install icon in the address bar.')),
          h('li', h('b', 'Linux: '), tr('Chrome/Chromium → install icon in the address bar.'))),
        h('p.muted', `${tr('Current address:')} ${location.origin}${isSecureContext ? '' : ` ${tr('(not HTTPS: no offline mode)')}`}`),
      ]),
    ];
    case 'backup': return [card('set-export', tr('Export and import your data'), [
      h('p.muted', tr('Export: a .zip file with all the inventory and documents of this workspace (with the files) and what you created: todos, journal, mails, projects, contacts, notes on documents, your mail. Other people\'s private things are not included.')),
      h('div.toolbar',
        h('a.btn', { href: 'api/export', download: '' }, icon('download'), tr('Export my data')),
        h('button.btn', { onclick: () => importInput.click() }, icon('upload'), tr('Import data…'))),
      h('p.muted', tr('Import: adds an export to this workspace (or one from another server) without overwriting anything. An item that already exists stays as it is and only gets the documents it lacks; projects with the same tag and contacts with the same email are merged. What you import becomes yours; the areas you cannot write to are skipped.')),
      importInput,
    ]), me.is_admin && card('set-admin', tr('Workspace backup and restore'), [
      h('p.muted', tr('The backup contains entries, projects, inventory, contacts and users. Uploaded files (documents, attachments) stay on the server: for a complete copy use '), kbd('make backup'), '.'),
      h('div.toolbar',
        h('a.btn', { href: 'api/admin/backup', download: '' }, icon('download'), tr('Download backup')),
        h('button.btn.danger', { onclick: () => restoreInput.click() }, icon('restore'), tr('Restore from backup…'))),
      h('p.muted', tr('Restoring replaces all the data with that of the chosen .db file (even from an earlier version of the app). It applies only to this workspace; first the server saves a safety copy of the current data. Accounts and members do not change.')),
      restoreInput,
    ])];
    case 'feedback': return D.feedbackOpen != null ? [card('set-fb', tr('To review'), [
      h('p', D.feedbackOpen ? trn(D.feedbackOpen, '1 feedback to look at.', '{n} feedback to look at.') : tr('No feedback to look at.')),
      h('div.toolbar', h('a.btn.primary', { href: '#/feedback' }, icon('bug'), tr('Open the feedback'))),
      h('p.muted', tr('From the terminal '), kbd('make feedback'), tr(' exports them to feedback/ with the images (ALL=1 also the resolved ones).')),
    ])] : null;
    default: return null;
  }
}

// Notifications: the system ones on this device (push), what triggers them, the muted channels.
const PUSH_STATE = {
  unsupported: tr('This browser does not receive notifications. On iPhone and iPad they arrive only from the installed app (Share → "Add to Home Screen"), then you turn them on from here.'),
  denied: tr('Notifications are blocked for this site: turn them back on from the browser settings (or System → Notifications) and come back here.'),
  on: tr('On for this device: they arrive even with the app closed.'),
  off: tr('Off on this device: you only see them in the bell while the app is open.'),
};

function notificationsPane(D) {
  if (ui.pushState === undefined) {
    ui.pushState = null;
    pushState().then(st => { ui.pushState = st; render(); }).catch(() => { ui.pushState = 'unsupported'; render(); });
  }
  const st = ui.pushState;
  const refresh = () => pushState().then(x => { ui.pushState = x; render(); });
  const channels = D.chatChannels.filter(c => c.member);
  return [
    card('set-push', tr('On this device'), [
      h('p', st ? PUSH_STATE[st] : tr('Checking…')),
      h('div.toolbar',
        st === 'off' && h('button.btn.primary', { onclick: () => act(async () => { await enablePush(); await refresh(); }, tr('Notifications turned on')) }, icon('bell'), tr('Turn on notifications')),
        st === 'on' && h('button.btn', { onclick: () => act(() => api('POST', '/push/test'), tr('Test notification sent')) }, icon('send'), tr('Send a test')),
        st === 'on' && h('button.btn.ghost', { onclick: () => act(async () => { await disablePush(); await refresh(); }, tr('Notifications turned off on this device')) }, icon('bell-off'), tr('Turn off'))),
      h('p.muted', D.pushDevices ? tr('Devices with notifications on: {n}.', { n: D.pushDevices }) : tr('No device has notifications on yet.')),
    ]),
    card('set-notif-what', tr('What arrives'), [
      h('ul.install',
        h('li', h('b', tr('Mentions: ')), tr('when someone mentions you with +person in an entry, an update, a note on a document or in chat, and when they assign you something (++person) or share something with you.')),
        h('li', h('b', tr('Mail: ')), tr('when a mail arrives in your inbox (with the Thunderbird extension) or a reply to one of your conversations.')),
        h('li', h('b', tr('Channels: ')), tr('every message of the channels you are in; in the muted ones only the messages that mention you.'))),
      h('p.muted', tr('They all stay in the bell at the top too. Opening an entry or reading a channel marks its notifications as read.')),
    ]),
    channels.length > 0 && card('set-mute', tr('Muted channels'), [
      h('p.muted', tr('A muted channel sends notifications only when someone mentions you (+person).')),
      channels.map(c => h('label.check-row',
        h('input', { type: 'checkbox', checked: !!c.muted, onchange: ev => act(() => api('POST', `/chat/channels/${c.id}/mute`, { muted: ev.target.checked })) }),
        h('span', `#${c.name}`), h('span.muted', c.muted ? ` · ${tr('mentions only')}` : ` · ${tr('every message')}`))),
    ]),
  ];
}

function peopleCard(D) {
  const me = D.me;
  return card('set-users', tr('People in "{name}"', { name: D.workspace.name }), [
    D.members.map(u => h('div.user-row',
      icon('user'),
      h('span', u.name || u.username), h('span.muted', `@${u.username}`),
      u.is_admin ? h('span.chip.on', 'admin') : null,
      h('span.grow'),
      me.is_admin && u.id !== me.id && [
        h('button.btn.sm.ghost', { onclick: () => act(() => api('PATCH', `/admin/users/${u.id}`, { is_admin: !u.is_admin })) }, u.is_admin ? tr('Remove admin') : tr('Make admin')),
        h('button.btn.sm.ghost', {
          onclick: async () => {
            if (!await askConfirm(tr('Generate a new password for {user}?', { user: u.username }), { ok: tr('Reset password') })) return;
            act(async () => { const r = await api('PATCH', `/admin/users/${u.id}`, { reset_password: true }); showText(tr('New password for {user}:', { user: u.username }), r.password); });
          },
        }, tr('Reset password')),
        h('button.btn.sm.danger', {
          onclick: async () => { if (await askConfirm(tr('Remove {user} from "{ws}"? Their entries stay; their account and their other workspaces are not touched.', { user: u.username, ws: D.workspace.name }), { ok: tr('Remove'), danger: true })) act(() => api('DELETE', `/admin/users/${u.id}`)); },
        }, tr('Remove')),
      ])),
    me.is_admin && h('div.invites',
      h('p.muted', tr('To let someone into "{ws}" create an invite and send them the link (valid 7 days, for one person). Whoever already has an account signs in with their credentials.', { ws: D.workspace.name })),
      h('button.btn', { onclick: () => act(async () => { const r = await api('POST', '/admin/invites'); ui.newInvite = r.code; loadInvites(); }) }, icon('plus'), tr('Create invite')),
      // Each invite is a link: it can be opened (here too, to see what the recipient will see), copied or shared.
      (ui.invites || []).map(i => {
        const link = inviteLink(i.code);
        return h('div.invite', { class: ui.newInvite === i.code ? 'new' : null },
          h('a.invite-link', { href: link, target: '_blank', rel: 'noopener', title: tr('Open the invite link') }, icon('link'), h('span', link)),
          h('span.muted', `${ui.newInvite === i.code ? `${tr('just created')} · ` : ''}${tr('expires {time}', { time: fmtTime(i.expires_at) })}`),
          h('span.grow'),
          h('button.btn.sm', { onclick: () => copy(link) }, icon('copy'), tr('Copy')),
          navigator.share && h('button.btn.sm', { onclick: () => share(link) }, icon('send'), tr('Share')),
          h('button.icon-btn', { title: tr('Revoke'), 'aria-label': tr('Revoke invite'), onclick: () => act(async () => { await api('DELETE', `/admin/invites/${i.code}`); loadInvites(); }) }, icon('x')));
      })),
  ]);
}

// #/impostazioni/<category>. On a computer with no category the first one opens; on a phone the list shows.
export function viewSettings(sec) {
  const D = S.data;
  if (D.me.is_admin && ui.invites == null) loadInvites();
  const cats = settingsCategories(D);
  const cur = cats.find(c => c[0] === sec) || null;
  const shown = cur || cats[0];
  return h('div.view.settings2', { class: cur ? 'has-sec' : null },
    h('nav.set-nav', { 'aria-label': tr('Settings categories') },
      cats.map(([id, label, ic, desc]) => h('a.set-cat', { href: `#/impostazioni/${id}`, class: id === shown[0] ? 'on' : null, 'aria-current': id === shown[0] ? 'page' : null },
        icon(ic), h('span.set-cat-t', h('b', label), h('span.muted', desc)), icon('back', 'set-cat-go')))),
    h('div.set-pane',
      h('div.set-pane-h',
        h('a.icon-btn.set-back', { href: '#/impostazioni', title: tr('Settings'), 'aria-label': tr('Back to settings') }, icon('back')),
        h('h2', shown[1])),
      settingsPane(shown[0], D) || h('p.muted', tr('Nothing to show.'))));
}

// Importing an export (.zip): it is added to the workspace, with a summary of what arrived.
const importInput = h('input', {
  type: 'file', accept: '.zip,application/zip', hidden: true,
  onchange: async ev => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f || !await askConfirm(tr('Import "{file}" into this workspace? The data is added to what is there, without overwriting it.', { file: f.name }), { ok: tr('Import') })) return;
    toast(tr('Importing…'));
    try {
      const r = await api('POST', '/import', f);
      const parts = [
        r.articoli && trn(r.articoli, '1 new item', '{n} new items'), r.articoliUniti && trn(r.articoliUniti, '1 item already present', '{n} items already present'),
        r.documenti && trn(r.documenti, '1 document', '{n} documents'), r.voci && trn(r.voci, '1 entry', '{n} entries'),
        r.progetti && trn(r.progetti, '1 new project', '{n} new projects'), r.progettiUniti && trn(r.progettiUniti, '1 project merged', '{n} projects merged'),
        r.contatti && trn(r.contatti, '1 new contact', '{n} new contacts'), r.contattiUniti && trn(r.contattiUniti, '1 contact merged', '{n} contacts merged'),
        r.note && trn(r.note, '1 note on documents', '{n} notes on documents'), r.conversazioni && trn(r.conversazioni, '1 mail conversation', '{n} mail conversations'),
      ].filter(Boolean);
      notice(`${tr('Import done.')}\n${parts.join('\n') || tr('Nothing new to add.')}${r.saltati.length ? `\n\n${tr('Skipped (you do not have permission to write): {list}.', { list: r.saltati.map(a => tr(AREAS[a] || a)).join(', ') })}` : ''}`);
    } catch (e) {
      toast(e.message, { err: true });
    }
  },
});

const restoreInput = h('input', {
  type: 'file', accept: '.db,application/octet-stream', hidden: true,
  onchange: async ev => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f || !await askConfirm(tr('Restore "{file}"? All the current data will be replaced (a safety copy stays on the server).', { file: f.name }), { ok: tr('Restore'), danger: true })) return;
    toast(tr('Restoring…'));
    try {
      const r = await api('POST', '/admin/restore', f);
      await notice(`${tr('Backup restored.')}${r.missing ? ` ${tr('{n} documents or attachments have no file on the server.', { n: r.missing })}` : ''}\n${tr('Safety copy: {file}', { file: r.safetyCopy })}`);
      location.reload();
    } catch (e) {
      toast(e.message, { err: true });
    }
  },
});

function workspaceSection(D) {
  const ws = D.workspace;
  const admin = ws.role === 'admin';
  return card('set-ws', tr('Your workspaces'), [
    h('div.grid',
      h('label.f', h('span', tr('Name')), h('input', {
        value: ws.name, disabled: !admin, 'data-fk': 'wsname',
        onchange: ev => act(() => api('PATCH', `/workspaces/${ws.id}`, { name: ev.target.value })),
      })),
      h('label.f', h('span', tr('Your role')), h('input', { value: admin ? 'admin' : tr('member'), disabled: true }))),
    h('div.ws-list', D.workspaces.map(w => h('div.user-row',
      icon('folder'), h('span', w.name), h('span.muted', w.role === 'admin' ? 'admin' : tr('member')),
      h('span.grow'),
      w.id === ws.id ? h('span.chip.on', tr('active')) : h('button.btn.sm', { onclick: () => switchWorkspace(w.id) }, tr('Open'))))),
    h('div.toolbar',
      h('button.btn', { onclick: newWorkspace }, icon('plus'), tr('New workspace')),
      h('span.grow'),
      h('button.btn.sm.ghost', {
        onclick: async () => {
          if (!await askConfirm(tr('Leave "{ws}"? To come back you will need a new invite.', { ws: ws.name }), { ok: tr('Leave the workspace'), danger: true })) return;
          act(async () => { await api('POST', `/workspaces/${ws.id}/leave`); location.hash = '#/agenda'; location.reload(); });
        },
      }, tr('Leave the workspace')),
      admin && h('button.btn.sm.danger', {
        onclick: async () => {
          const name = await askText(tr('Delete "{ws}" for all the members? Type the workspace name to confirm:', { ws: ws.name }), { placeholder: ws.name, title: tr('Delete workspace'), ok: tr('Delete') });
          if (name == null) return;
          act(async () => { await api('DELETE', `/workspaces/${ws.id}`, { confirm: name }); location.hash = '#/agenda'; location.reload(); });
        },
      }, icon('trash'), tr('Delete workspace'))),
  ], { count: D.workspaces.length });
}

async function share(url) {
  if (navigator.share) {
    try {
      await navigator.share({ title: tr('Organizer invite'), url });
      return;
    } catch { /* cancelled: copy */ }
  }
  copy(url);
}
