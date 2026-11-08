// Documents page: all the inventory's files in one place, meant for reviewing.
// They are filtered, grouped by the item's category (like the inventory in columns) or by document kind, and up to 3
// can be chosen to open side by side. Document kinds are added here too.
import {
  h, icon, S, ui, api, act, render, save, toast, fmtSize, fmtTime, itemAttrs, catStyle, docKinds, dkAttrs, kindLabel, newDocKind, docName, renameDoc, masonry, filterChip, aliasCodes, can, roClass,
  fold, foldBar, capFirst,
} from './core.js';
import { docMeta, docPeek } from './docview.js';
import { peekable } from './views.js';
import { tr, trn } from './i18n.js';

const MAX_REVIEW = 3;
const lc = s => String(s ?? '').toLowerCase();

const openNotes = id => (S.data.docNotesOf.get(id) || []).filter(n => !n.resolved_at).length;

function toggleSel(id) {
  if (ui.docSel.has(id)) ui.docSel.delete(id);
  else if (ui.docSel.size >= MAX_REVIEW) return toast(tr('At most {n} documents side by side', { n: MAX_REVIEW }), { err: true });
  else ui.docSel.add(id);
  render();
}

function docRow(d, { showItem }) {
  const D = S.data;
  const it = D.itemById.get(d.item_id);
  const n = openNotes(d.id);
  const sel = ui.docSel.has(d.id);
  // Picker for the side-by-side review: empty shows the columns, picked shows the position it will open in.
  const slot = [...ui.docSel].indexOf(d.id) + 1;
  return h('div.drow', { class: sel ? 'sel' : null },
    h('button.sel-btn', {
      class: sel ? 'on' : null, 'aria-pressed': sel ? 'true' : 'false',
      title: sel ? tr('In the side-by-side review (position {n}): click to remove it', { n: slot }) : tr('Add to the side-by-side review (up to {n})', { n: MAX_REVIEW }),
      onclick: () => toggleSel(d.id),
    }, sel ? String(slot) : icon('cols')),
    docMeta(d),
    peekable(h('a.drow-name', { href: `#/d/${d.id}` }, docName(d)), () => docPeek(d), 'peek-doc'),
    h('button.icon-btn.sm.drow-edit', { title: tr('Rename'), onclick: () => renameDoc(d) }, icon('edit')),
    showItem && it && h('a.code', { href: `#/i/${it.id}`, ...itemAttrs(it) }, it.code),
    h('span.grow'),
    n > 0 && h('a.doc-notes', { href: `#/d/${d.id}`, title: tr('Open notes') }, icon('log'), n),
    d.size != null && h('span.muted.drow-size', fmtSize(d.size)),
    h('span.muted.drow-date', fmtTime(d.created_at)));
}

// Columns like the inventory by category: in each one the category's items with their documents.
function byCategory(docs) {
  const D = S.data;
  const cats = new Map();
  for (const d of docs) {
    const it = D.itemById.get(d.item_id);
    if (!cats.has(it.category)) cats.set(it.category, new Map());
    const items = cats.get(it.category);
    if (!items.has(it.id)) items.set(it.id, []);
    items.get(it.id).push(d);
  }
  return [...cats].sort(([a], [b]) => (!a) - (!b) || a.localeCompare(b)).map(([cat, items]) => fold('documenti', `c:${cat}`, h('section.dgroup', { class: cat ? 'cat' : null, style: catStyle(cat) },
    h('div.dgroup-h', h('span.dgroup-cat', capFirst(cat) || tr('no category')), h('span.count', [...items.values()].flat().length)),
    [...items].map(([id]) => D.itemById.get(id)).sort((a, b) => a.code.localeCompare(b.code)).map(it => [
      h('div.dgroup-item', h('a.code', { href: `#/i/${it.id}`, ...itemAttrs(it) }, it.code), h('span.muted', it.name || '')),
      items.get(it.id).map(d => docRow(d, { showItem: false })),
    ]))));
}

// Columns by document kind. Without filters the added kinds that are still empty show too (and can be deleted).
function byKind(docs, filtered) {
  const D = S.data;
  const groups = new Map(docKinds().map(k => [k, []]));
  for (const d of docs) (groups.get(d.kind) || groups.get('altro')).push(d);
  const custom = new Set(D.customDocKinds);
  const remove = (k, n) => {
    if (confirm(n ? tr('Delete the kind "{kind}"? Its {n} documents become "other".', { kind: k, n }) : tr('Delete the kind "{kind}"?', { kind: k }))) act(() => api('DELETE', `/doc-kinds/${encodeURIComponent(k)}`));
  };
  return [...groups].filter(([k, list]) => list.length || (custom.has(k) && !filtered)).map(([k, list]) => fold('documenti', `k:${k}`, h('section.dgroup',
    h('div.dgroup-h', h('span.dk', dkAttrs(k), kindLabel(k)), h('span.count', list.length),
      custom.has(k) && h('button.icon-btn.sm', { title: tr('Delete this kind'), onclick: () => remove(k, list.length) }, icon('x'))),
    list.length ? list.map(d => docRow(d, { showItem: true })) : h('p.muted.dgroup-empty', tr('No documents of this kind.')))));
}

export function viewDocuments() {
  const D = S.data;
  const all = D.docs.filter(d => D.itemById.has(d.item_id));
  for (const id of [...ui.docSel]) if (!D.docById.has(id)) ui.docSel.delete(id);
  const f = lc(ui.docFilter.trim());
  const kinds = docKinds();
  const counts = new Map(kinds.map(k => [k, all.filter(d => d.kind === k).length]));
  const docs = all
    .filter(d => !ui.docKindF || d.kind === ui.docKindF)
    .filter(d => !ui.docOnlyNotes || openNotes(d.id) > 0)
    .filter(d => {
      if (!f) return true;
      const it = D.itemById.get(d.item_id);
      const notes = (D.docNotesOf.get(d.id) || []).map(n => n.text).join(' ');
      return lc([d.label, d.filename, d.url, d.version, d.kind, it.code, ...aliasCodes(it), it.name, notes].join(' ')).includes(f);
    });
  const byCat = ui.docGroup === 'item'; // value saved by older versions ("by item")
  const filtered = !!(f || ui.docKindF || ui.docOnlyNotes);
  const setGroup = g => { ui.docGroup = g; save('org.docGroup', g); render(); };
  const sel = [...ui.docSel];

  return h('div.view.documents', { class: roClass(can('documenti', 'write')) },
    h('div.toolbar',
      h('input.filter', {
        type: 'search', placeholder: tr('Filter by name, version, item, note text…'), value: ui.docFilter, 'data-fk': 'docfilter',
        oninput: ev => { ui.docFilter = ev.target.value; render(); },
      }),
      h('div.seg',
        // As in the inventory: the panel button is the view by category (with the items), the other one by kind.
        h('button', { class: !byCat && 'on', onclick: () => setGroup('kind'), title: tr('By document kind') }, icon('file')),
        h('button', { class: byCat && 'on', onclick: () => setGroup('item'), title: tr('By inventory category, with the items') }, icon('cols')))),
    h('div.toolbar.cats',
      kinds.filter(k => counts.get(k)).map(k => filterChip({
        on: ui.docKindF === k, label: kindLabel(k), n: counts.get(k), cls: `tint ${dkAttrs(k).class}`, style: dkAttrs(k).style,
        onclick: () => { ui.docKindF = ui.docKindF === k ? null : k; render(); },
      })),
      filterChip({ on: ui.docOnlyNotes, label: [icon('log'), tr('with open notes')], onclick: () => { ui.docOnlyNotes = !ui.docOnlyNotes; render(); } }),
      can('documenti', 'write') && h('button.chip', { title: tr('Adds a document kind (besides firmware, datasheet…)'), onclick: newDocKind }, icon('plus'), tr('new kind'))),
    !all.length && h('div.empty',
      h('p', tr('No documents.')),
      h('p', tr('Documents are uploaded from an inventory item\'s page (firmware, datasheets, schematics…).'))),
    all.length > 0 && !docs.length && h('div.empty', h('p', tr('No document matches the filters.'))),
    all.length > 0 && h('p.muted.dnd-hint', tr('Pick up to {n} documents with the button on the left to review them side by side, with their notes.', { n: MAX_REVIEW })),
    docs.length > 0 && foldBar('documenti'),
    masonry('doc-groups', byCat ? byCategory(docs) : byKind(docs, filtered)),
    sel.length > 0 && h('div.rv-bar',
      h('span', trn(sel.length, '1 document selected', '{n} documents selected')),
      h('span.grow'),
      h('button.btn.ghost.keep', { onclick: () => { ui.docSel.clear(); render(); } }, tr('Deselect')),
      h('a.btn.primary', { href: `#/review?d=${sel.join(',')}` }, icon('cols'), sel.length === 1 ? tr('Open') : tr('Review side by side'))));
}
