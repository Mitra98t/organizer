// Pagina Documenti: tutti i file del magazzino in un posto solo, pensata per la revisione.
// Si filtrano, si raggruppano per categoria dell'articolo (come il magazzino a colonne) o per tipo di documento,
// e se ne scelgono fino a 3 da aprire affiancati. Qui si aggiungono anche i tipi di documento.
import {
  h, icon, S, ui, api, act, render, save, toast, fmtSize, fmtTime, itemAttrs, catStyle, docKinds, dkAttrs, newDocKind, docName, renameDoc, masonry, filterChip, aliasCodes,
} from './core.js';
import { docMeta, docPeek } from './docview.js';
import { peekable } from './views.js';

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
  // Selettore per la revisione affiancata: vuoto mostra le colonne, scelto mostra in quale posizione si aprirà.
  const slot = [...ui.docSel].indexOf(d.id) + 1;
  return h('div.drow', { class: sel ? 'sel' : null },
    h('button.sel-btn', {
      class: sel ? 'on' : null, 'aria-pressed': sel ? 'true' : 'false',
      title: sel ? `Nella revisione affiancata (posizione ${slot}): clicca per toglierlo` : `Aggiungi alla revisione affiancata (fino a ${MAX_REVIEW})`,
      onclick: () => toggleSel(d.id),
    }, sel ? String(slot) : icon('cols')),
    docMeta(d),
    peekable(h('a.drow-name', { href: `#/d/${d.id}` }, docName(d)), () => docPeek(d), 'peek-doc'),
    h('button.icon-btn.sm.drow-edit', { title: 'Rinomina', onclick: () => renameDoc(d) }, icon('edit')),
    showItem && it && h('a.code', { href: `#/i/${it.id}`, ...itemAttrs(it) }, it.code),
    h('span.grow'),
    n > 0 && h('a.doc-notes', { href: `#/d/${d.id}`, title: 'Note aperte' }, icon('log'), n),
    d.size != null && h('span.muted.drow-size', fmtSize(d.size)),
    h('span.muted.drow-date', fmtTime(d.created_at)));
}

// Colonne come il magazzino per categoria: in ognuna gli articoli della categoria con i loro documenti.
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
  return [...cats].sort(([a], [b]) => (!a) - (!b) || a.localeCompare(b)).map(([cat, items]) => h('section.dgroup', { class: cat ? 'cat' : null, style: catStyle(cat) },
    h('div.dgroup-h', h('span.dgroup-cat', cat || 'senza categoria'), h('span.count', [...items.values()].flat().length)),
    [...items].map(([id]) => D.itemById.get(id)).sort((a, b) => a.code.localeCompare(b.code)).map(it => [
      h('div.dgroup-item', h('a.code', { href: `#/i/${it.id}`, ...itemAttrs(it) }, it.code), h('span.muted', it.name || '')),
      items.get(it.id).map(d => docRow(d, { showItem: false })),
    ])));
}

// Colonne per tipo di documento. Senza filtri si vedono anche i tipi aggiunti ancora vuoti (e si eliminano).
function byKind(docs, filtered) {
  const D = S.data;
  const groups = new Map(docKinds().map(k => [k, []]));
  for (const d of docs) (groups.get(d.kind) || groups.get('altro')).push(d);
  const custom = new Set(D.customDocKinds);
  const remove = (k, n) => {
    if (confirm(`Eliminare il tipo "${k}"?${n ? ` I suoi ${n} documenti diventano "altro".` : ''}`)) act(() => api('DELETE', `/doc-kinds/${encodeURIComponent(k)}`));
  };
  return [...groups].filter(([k, list]) => list.length || (custom.has(k) && !filtered)).map(([k, list]) => h('section.dgroup',
    h('div.dgroup-h', h('span.dk', dkAttrs(k), k), h('span.count', list.length),
      custom.has(k) && h('button.icon-btn.sm', { title: 'Elimina questo tipo', onclick: () => remove(k, list.length) }, icon('x'))),
    list.length ? list.map(d => docRow(d, { showItem: true })) : h('p.muted.dgroup-empty', 'Nessun documento di questo tipo.')));
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
  const byCat = ui.docGroup === 'item'; // valore salvato delle versioni precedenti ("per articolo")
  const filtered = !!(f || ui.docKindF || ui.docOnlyNotes);
  const setGroup = g => { ui.docGroup = g; save('org.docGroup', g); render(); };
  const sel = [...ui.docSel];

  return h('div.view.documents',
    h('div.toolbar',
      h('input.filter', {
        type: 'search', placeholder: 'Filtra per nome, versione, articolo, testo delle note…', value: ui.docFilter, 'data-fk': 'docfilter',
        oninput: ev => { ui.docFilter = ev.target.value; render(); },
      }),
      h('div.seg',
        // Come nel magazzino: il pulsante a pannelli è la vista per categoria (con gli articoli), l'altro per tipo.
        h('button', { class: !byCat && 'on', onclick: () => setGroup('kind'), title: 'Per tipo di documento' }, icon('file')),
        h('button', { class: byCat && 'on', onclick: () => setGroup('item'), title: 'Per categoria del magazzino, con gli articoli' }, icon('cols'))),
      h('a.btn.ghost', { href: '#/magazzino', title: 'Torna al magazzino' }, icon('box'), h('span.only-wide', 'Magazzino'))),
    h('div.toolbar.cats',
      kinds.filter(k => counts.get(k)).map(k => filterChip({
        on: ui.docKindF === k, label: k, n: counts.get(k), cls: `tint ${dkAttrs(k).class}`, style: dkAttrs(k).style,
        onclick: () => { ui.docKindF = ui.docKindF === k ? null : k; render(); },
      })),
      filterChip({ on: ui.docOnlyNotes, label: [icon('log'), 'con note aperte'], onclick: () => { ui.docOnlyNotes = !ui.docOnlyNotes; render(); } }),
      h('button.chip', { title: 'Aggiunge un tipo di documento (oltre a firmware, datasheet…)', onclick: newDocKind }, icon('plus'), 'nuovo tipo')),
    !all.length && h('div.empty',
      h('p', 'Nessun documento.'),
      h('p', 'I documenti si caricano dalla scheda di un articolo di magazzino (firmware, datasheet, schemi…).')),
    all.length > 0 && !docs.length && h('div.empty', h('p', 'Nessun documento corrisponde ai filtri.')),
    all.length > 0 && h('p.muted.dnd-hint', `Scegli fino a ${MAX_REVIEW} documenti con il pulsante a sinistra per rivederli affiancati, con le loro note.`),
    masonry('doc-groups', byCat ? byCategory(docs) : byKind(docs, filtered)),
    sel.length > 0 && h('div.rv-bar',
      h('span', `${sel.length} ${sel.length === 1 ? 'documento selezionato' : 'documenti selezionati'}`),
      h('span.grow'),
      h('button.btn.ghost', { onclick: () => { ui.docSel.clear(); render(); } }, 'Deseleziona'),
      h('a.btn.primary', { href: `#/review?d=${sel.join(',')}` }, icon('cols'), sel.length === 1 ? 'Apri' : 'Rivedi affiancati')));
}
