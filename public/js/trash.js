// Trash: deleted items, restorable for a few weeks before they are deleted for good.
import { h, icon, S, ui, api, act, render, fmtTime, userName, richText } from './core.js';
import { tr, trn } from './i18n.js';

const KINDS = { todo: 'todo', mail: 'mail', note: 'nota' };

function load() {
  const rev = S.data.rev;
  ui.trash = { rev, loading: true };
  api('GET', '/trash').then(r => { ui.trash = { ...r, rev }; render(); }).catch(() => { ui.trash = null; });
}

function expiry(deletedAt, days) {
  const d = new Date(Date.parse(deletedAt) + days * 864e5);
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
}

export function viewTrash() {
  // Reloaded at every data change (also by other users).
  if (!ui.trash || ui.trash.rev !== S.data.rev) load();
  const T = ui.trash;
  if (T.loading && !T.entries) return h('div.empty', tr('Loading…'));
  const me = S.data.me;
  const canPurge = el => me.is_admin || el.created_by === me.id || el.deleted_by === me.id;

  const row = (type, el, label, sub) => h('div.trash-row',
    h('div.trash-main',
      h('div.title', label),
      h('div.meta',
        sub,
        h('span', el.deleted_by ? tr('deleted {when} by {name}', { when: fmtTime(el.deleted_at), name: userName(el.deleted_by) }) : tr('deleted {when}', { when: fmtTime(el.deleted_at) })),
        h('span.muted', tr('gone on {date}', { date: expiry(el.deleted_at, T.days) })))),
    h('button.btn.sm', { onclick: () => act(() => api('POST', `/trash/${type}/${el.id}/restore`), tr('Restored')) }, icon('restore'), tr('Restore')),
    canPurge(el) && h('button.icon-btn', {
      title: tr('Delete for good'),
      onclick: () => { if (confirm(tr('Delete for good? It can no longer be recovered.'))) act(() => api('DELETE', `/trash/${type}/${el.id}`)); },
    }, icon('trash')));

  const block = (title, rows) => rows.length > 0 && h('section.sec',
    h('div.sec-h', h('span.sec-t', title), h('span.count', rows.length)),
    h('div.sec-b', rows));

  T.docNotes ||= [];
  T.threads ||= [];
  const total = T.threads.length + T.entries.length + T.projects.length + T.items.length + T.docs.length + T.contacts.length + T.docNotes.length;

  return h('div.view',
    h('p.muted.trash-info', tr('Deleted items stay here for {days} days, then they are deleted for good.', { days: T.days })),
    !total && h('div.empty', h('p', tr('The trash is empty.'))),
    block(tr('Entries'), T.entries.map(e => row('entry', e,
      [h('span.kpill', { class: `k-${e.kind}` }, KINDS[e.kind]), richText(e.title)],
      e.parent_id && h('span', tr('subtask'))))),
    block(tr('Mail threads'), T.threads.map(t => row('thread', t, t.subject,
      h('span', trn(t.messages, '1 message', '{n} messages'))))),
    block(tr('Projects'), T.projects.map(p => row('project', p, [p.name, ' ', h('span.muted.mono', `@${p.tag}`)]))),
    block(tr('Inventory'), T.items.map(i => row('item', i, [h('span.code-t', i.code), ' ', i.name]))),
    block(tr('Documents'), T.docs.map(d => row('doc', d, d.label || d.filename || d.url, h('span.mono', d.item_code)))),
    block(tr('Notes on documents'), T.docNotes.map(n => row('docnote', n, n.text, h('span', `${n.label || n.filename || n.url}${n.page ? ` · ${tr('p. {n}', { n: n.page })}` : ''}`)))),
    block(tr('Contacts'), T.contacts.map(c => row('contact', c, c.name || c.email, c.name && h('span.mono', c.email)))),
    total > 0 && me.is_admin && h('div.danger-zone',
      h('span.muted', trn(total, '1 item', '{n} items')),
      h('button.btn.sm.danger', {
        onclick: () => { if (confirm(tr('Empty the trash? {n} items will be deleted for good.', { n: total }))) act(() => api('DELETE', '/trash'), tr('Trash emptied')); },
      }, icon('trash'), tr('Empty the trash'))));
}
