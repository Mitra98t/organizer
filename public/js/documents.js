// Pagina Documenti: tutti i file del magazzino in un posto solo, pensata per la revisione.
// Si filtrano, si raggruppano per articolo o per tipo, e se ne scelgono fino a 3 da aprire affiancati.
import { h, icon, S, ui, render, save, toast, fmtSize, fmtTime, itemAttrs, DOC_KINDS } from './core.js';
import { docMeta } from './docview.js';

const MAX_REVIEW = 3;
const lc = s => String(s ?? '').toLowerCase();

const openNotes = id => (S.data.docNotesOf.get(id) || []).filter(n => !n.resolved_at).length;

function toggleSel(id) {
  if (ui.docSel.has(id)) ui.docSel.delete(id);
  else if (ui.docSel.size >= MAX_REVIEW) return toast(`Al massimo ${MAX_REVIEW} documenti affiancati`, { err: true });
  else ui.docSel.add(id);
  render();
}

function docRow(d, { showItem }) {
  const D = S.data;
  const it = D.itemById.get(d.item_id);
  const n = openNotes(d.id);
  const sel = ui.docSel.has(d.id);
  return h('div.drow', { class: sel ? 'sel' : null },
    h('input', { type: 'checkbox', checked: sel, title: 'Seleziona per la revisione affiancata', onchange: () => toggleSel(d.id) }),
    docMeta(d),
    h('a.drow-name', { href: `#/d/${d.id}`, title: 'Apri con le note' }, d.label || d.filename || d.url),
    showItem && it && h('a.code', { href: `#/i/${it.id}`, ...itemAttrs(it) }, it.code),
    h('span.grow'),
    n > 0 && h('a.doc-notes', { href: `#/d/${d.id}`, title: 'Note aperte' }, icon('log'), n),
    d.size != null && h('span.muted.drow-size', fmtSize(d.size)),
    h('span.muted.drow-date', fmtTime(d.created_at)));
}

export function viewDocuments() {
  const D = S.data;
  const all = D.docs.filter(d => D.itemById.has(d.item_id));
  for (const id of [...ui.docSel]) if (!D.docById.has(id)) ui.docSel.delete(id);
  const f = lc(ui.docFilter.trim());
  const counts = new Map(DOC_KINDS.map(k => [k, all.filter(d => d.kind === k).length]));
  const docs = all
    .filter(d => !ui.docKindF || d.kind === ui.docKindF)
    .filter(d => !ui.docOnlyNotes || openNotes(d.id) > 0)
    .filter(d => {
      if (!f) return true;
      const it = D.itemById.get(d.item_id);
      const notes = (D.docNotesOf.get(d.id) || []).map(n => n.text).join(' ');
      return lc([d.label, d.filename, d.url, d.version, d.kind, it.code, it.name, notes].join(' ')).includes(f);
    });
  const byItem = ui.docGroup === 'item';
  const groups = new Map();
  for (const d of docs) {
    const key = byItem ? d.item_id : d.kind;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const ordered = [...groups].sort(([a], [b]) => (byItem
    ? D.itemById.get(a).code.localeCompare(D.itemById.get(b).code)
    : DOC_KINDS.indexOf(a) - DOC_KINDS.indexOf(b)));
  const setGroup = g => { ui.docGroup = g; save('org.docGroup', g); render(); };
  const sel = [...ui.docSel];

  return h('div.view.documents',
    h('div.toolbar',
      h('input.filter', {
        type: 'search', placeholder: 'Filtra per nome, versione, articolo, testo delle note…', value: ui.docFilter, 'data-fk': 'docfilter',
        oninput: ev => { ui.docFilter = ev.target.value; render(); },
      }),
      h('div.seg',
        h('button', { class: byItem && 'on', onclick: () => setGroup('item'), title: 'Per articolo' }, icon('box')),
        h('button', { class: !byItem && 'on', onclick: () => setGroup('kind'), title: 'Per tipo' }, icon('cols'))),
      h('a.btn.ghost', { href: '#/magazzino', title: 'Torna al magazzino' }, icon('box'), h('span.only-wide', 'Magazzino'))),
    h('div.toolbar.cats',
      DOC_KINDS.filter(k => counts.get(k)).map(k =>
        h('button.chip', { class: ui.docKindF === k && 'on', onclick: () => { ui.docKindF = ui.docKindF === k ? null : k; render(); } },
          h('span.dk', { class: `k-${k}` }, k), h('span.n', counts.get(k)))),
      h('button.chip', { class: ui.docOnlyNotes && 'on', onclick: () => { ui.docOnlyNotes = !ui.docOnlyNotes; render(); } },
        icon('log'), 'con note aperte')),
    !all.length && h('div.empty',
      h('p', 'Nessun documento.'),
      h('p', 'I documenti si caricano dalla scheda di un articolo di magazzino (firmware, datasheet, schemi…).')),
    all.length > 0 && !docs.length && h('div.empty', h('p', 'Nessun documento corrisponde ai filtri.')),
    all.length > 0 && h('p.muted.dnd-hint', `Spunta fino a ${MAX_REVIEW} documenti per rivederli affiancati, con le loro note.`),
    h('div.doc-groups', ordered.map(([key, list]) => {
      const it = byItem && D.itemById.get(key);
      return h('section.dgroup',
        h('div.dgroup-h',
          byItem
            ? [h('a.code', { href: `#/i/${it.id}`, ...itemAttrs(it) }, it.code), h('span', it.name || '')]
            : h('span.dk', { class: `k-${key}` }, key),
          h('span.count', list.length)),
        list.map(d => docRow(d, { showItem: !byItem })));
    })),
    sel.length > 0 && h('div.rv-bar',
      h('span', `${sel.length} ${sel.length === 1 ? 'documento selezionato' : 'documenti selezionati'}`),
      h('span.grow'),
      h('button.btn.ghost', { onclick: () => { ui.docSel.clear(); render(); } }, 'Deseleziona'),
      h('a.btn.primary', { href: `#/review?d=${sel.join(',')}` }, icon('cols'), sel.length === 1 ? 'Apri' : 'Rivedi affiancati')));
}
