// Cestino: elementi eliminati, ripristinabili per qualche settimana prima della cancellazione definitiva.
import { h, icon, S, ui, api, act, render, fmtTime, userName, richText } from './core.js';

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
  // Si ricarica a ogni cambiamento dei dati (anche da altri utenti).
  if (!ui.trash || ui.trash.rev !== S.data.rev) load();
  const T = ui.trash;
  if (T.loading && !T.entries) return h('div.empty', 'Caricamento…');
  const me = S.data.me;
  const canPurge = el => me.is_admin || el.created_by === me.id || el.deleted_by === me.id;

  const row = (type, el, label, sub) => h('div.trash-row',
    h('div.trash-main',
      h('div.title', label),
      h('div.meta',
        sub,
        h('span', `eliminato ${fmtTime(el.deleted_at)}${el.deleted_by ? ` da ${userName(el.deleted_by)}` : ''}`),
        h('span.muted', `sparisce il ${expiry(el.deleted_at, T.days)}`))),
    h('button.btn.sm', { onclick: () => act(() => api('POST', `/trash/${type}/${el.id}/restore`), 'Ripristinato') }, icon('restore'), 'Ripristina'),
    canPurge(el) && h('button.icon-btn', {
      title: 'Elimina definitivamente',
      onclick: () => { if (confirm('Eliminare definitivamente? Non si potrà più recuperare.')) act(() => api('DELETE', `/trash/${type}/${el.id}`)); },
    }, icon('trash')));

  const block = (title, rows) => rows.length > 0 && h('section.sec',
    h('div.sec-h', h('span.sec-t', title), h('span.count', rows.length)),
    h('div.sec-b', rows));

  const total = T.entries.length + T.projects.length + T.items.length + T.docs.length + T.contacts.length;

  return h('div.view',
    h('p.muted.trash-info', `Gli elementi eliminati restano qui ${T.days} giorni, poi vengono cancellati definitivamente.`),
    !total && h('div.empty', h('p', 'Il cestino è vuoto.')),
    block('Voci', T.entries.map(e => row('entry', e,
      [h('span.kpill', { class: `k-${e.kind}` }, KINDS[e.kind]), richText(e.title)],
      e.parent_id && h('span', 'sotto-attività')))),
    block('Progetti', T.projects.map(p => row('project', p, [p.name, ' ', h('span.muted.mono', `@${p.tag}`)]))),
    block('Magazzino', T.items.map(i => row('item', i, [h('span.code-t', i.code), ' ', i.name]))),
    block('Documenti', T.docs.map(d => row('doc', d, d.label || d.filename || d.url, h('span.mono', d.item_code)))),
    block('Contatti', T.contacts.map(c => row('contact', c, c.name || c.email, c.name && h('span.mono', c.email)))),
    total > 0 && me.is_admin && h('div.danger-zone',
      h('span.muted', total === 1 ? '1 elemento' : `${total} elementi`),
      h('button.btn.sm.danger', {
        onclick: () => { if (confirm(`Svuotare il cestino? ${total} elementi verranno eliminati definitivamente.`)) act(() => api('DELETE', '/trash'), 'Cestino svuotato'); },
      }, icon('trash'), 'Svuota cestino')));
}
