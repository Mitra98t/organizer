// Modals to pick from the inventory, with a search like the Documents page's:
//  - pickDoc: a document (file) to attach to a mail; searched by name, code (also alternative), item name, kind and
//    version, and filtered by kind; the documents are grouped under their item;
//  - pickItem: the item (and the document kind) to save a received attachment into; with actions and without the
//    kind it also moves or copies a document to another item.
// The content redraws itself while typing: the rest of the app is not touched.
import { h, icon, S, api, act, docName, docKinds, dkAttrs, kindLabel, itemAttrs, fmtSize, filterChip, aliasCodes } from './core.js';
import { fuzzy } from './autocomplete.js';
import { tr } from './i18n.js';

const lc = s => String(s ?? '').toLowerCase();
const LIMIT = 60;
// Document kind chip, with its colour.
const kindChip = (k, on, onclick) => { const a = dkAttrs(k); return filterChip({ on, label: kindLabel(k), cls: `tint ${a.class}`, style: a.style, onclick }); };

function modal(title, cls) {
  const body = h('div.pk-body');
  const dialog = h(`dialog.fb.pk.${cls}`, { 'aria-label': title, onclose: () => dialog.remove() },
    h('div.pk-h', h('h2', title), h('button.icon-btn', { type: 'button', title: tr('Close'), 'aria-label': tr('Close'), onclick: () => dialog.close() }, icon('x'))),
    body);
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body, close: () => dialog.close() };
}

// Score against the search (lower = better, null = unrelated): every word must be in at least one field ("sch42
// 2.3" = code and version); for each word the best field counts (plus its weight).
function score(q, fields) {
  if (!q) return 0;
  let total = 0;
  for (const word of q.split(/\s+/)) {
    let best = null;
    for (const [v, w = 0] of fields) {
      const r = v ? fuzzy(lc(v), word) : null;
      if (r != null && (best == null || r + w < best)) best = r + w;
    }
    if (best == null) return null;
    total += best;
  }
  return total;
}

export function pickDoc({ title = tr('Attach from the inventory'), onPick }) {
  const D = S.data;
  const m = modal(title, 'pk-docs');
  const state = { q: '', kind: null };
  const input = h('input.filter', { type: 'search', placeholder: tr('Search by name, code, item, kind, version…'), autofocus: true, oninput: ev => { state.q = ev.target.value; draw(); } });
  const list = h('div.pk-list');
  const chips = h('div.toolbar.cats');
  m.body.append(input, chips, list);
  const docs = D.docs.filter(d => !d.url && D.itemById.has(d.item_id));

  function draw() {
    const q = lc(state.q.trim());
    const kinds = [...new Set(docs.map(d => d.kind))];
    chips.replaceChildren(...kinds.map(k => kindChip(k, state.kind === k, () => { state.kind = state.kind === k ? null : k; draw(); })));
    const found = docs.filter(d => !state.kind || d.kind === state.kind).map(d => {
      const it = D.itemById.get(d.item_id);
      return { d, it, r: score(q, [[docName(d)], [d.filename, 0.3], [it.code, 0.1], ...aliasCodes(it).map(a => [a, 0.2]), [it.name, 0.5], [d.kind, 1], [d.version, 1]]) };
    }).filter(x => x.r != null).sort((a, b) => a.r - b.r || b.d.created_at.localeCompare(a.d.created_at)).slice(0, LIMIT);
    // Under their item, in the order of the first one found.
    const groups = new Map();
    for (const x of found) {
      if (!groups.has(x.it.id)) groups.set(x.it.id, []);
      groups.get(x.it.id).push(x.d);
    }
    list.replaceChildren(...(!found.length ? [h('p.muted.pk-empty', docs.length ? tr('No document found.') : tr('There are no files in the inventory yet.'))] : []),
      ...[...groups].map(([id, ds]) => {
        const it = D.itemById.get(id);
        return h('div.pk-group',
          h('div.pk-item', h('span.code', itemAttrs(it), it.code), h('span.muted', it.name || '')),
          ds.map(d => h('button.pk-row', { type: 'button', onclick: () => { m.close(); onPick(d); } },
            h('span.dk', dkAttrs(d.kind), kindLabel(d.kind)), h('span.pk-name', docName(d)), d.version && h('span.muted.mono', `v${d.version}`),
            h('span.grow'), d.size != null && h('span.muted', fmtSize(d.size)))));
      }));
  }
  draw();
  input.focus();
}

// Kind suggested for a file, from its extension.
function guessKind(name) {
  const ext = lc(name).split('.').pop();
  if (['bin', 'hex', 'elf', 'uf2', 'img', 'zip'].includes(ext)) return 'firmware';
  if (ext === 'pdf') return 'datasheet';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext)) return 'foto';
  if (['sch', 'kicad_sch', 'brd', 'kicad_pcb'].includes(ext)) return 'schema';
  return 'altro';
}

// actions: the buttons at the bottom, { label(item), icon, fn(item, kind) }; the first one also works with a double
// click. kinds false: without choosing the kind. exclude: an item not to offer (the one the document is already in).
export function pickItem({ file, onPick, title, kinds: withKinds = true, exclude = null,
  actions = [{ label: it => tr('Save in {code}', { code: it.code }), icon: 'box', fn: onPick }] }) {
  const D = S.data;
  const m = modal(title || tr('Save "{name}" in the inventory', { name: file.name }), 'pk-items');
  const state = { q: '', item: null, kind: docKinds().includes(guessKind(file.name)) ? guessKind(file.name) : 'altro' };
  const input = h('input.filter', { type: 'search', placeholder: tr('Item: code (also alternative), name, category…'), oninput: ev => { state.q = ev.target.value; draw(); } });
  const list = h('div.pk-list');
  const kinds = h('div.toolbar.cats');
  const pick = a => { if (state.item) { m.close(); a.fn(state.item, state.kind); } };
  const buttons = actions.map((a, i) => h(`button.btn${i ? '' : '.primary'}`, { type: 'button', onclick: () => pick(a) }));
  m.body.append(input, list, ...(withKinds ? [h('div.pk-sub', tr('Document kind')), kinds] : []),
    h('div.toolbar.pk-foot', buttons, h('button.btn.ghost', { type: 'button', onclick: m.close }, tr('Cancel'))));

  function draw() {
    const q = lc(state.q.trim());
    const found = D.items.filter(it => it.id !== exclude).map(it => ({ it, r: score(q, [[it.code], ...aliasCodes(it).map(a => [a, 0.1]), [it.name, 0.5], [it.category, 1]]) }))
      .filter(x => x.r != null).sort((a, b) => a.r - b.r || a.it.code.localeCompare(b.it.code)).slice(0, LIMIT);
    list.replaceChildren(...(!found.length ? [h('p.muted.pk-empty', tr('No item found.'))] : []),
      ...found.map(({ it }) => h('button.pk-row', {
        type: 'button', class: state.item?.id === it.id ? 'on' : null,
        onclick: () => { state.item = it; draw(); }, ondblclick: () => { state.item = it; pick(actions[0]); },
      }, h('span.code', itemAttrs(it), it.code), h('span.pk-name', it.name || ''), h('span.grow'), it.category && h('span.muted', it.category))));
    kinds.replaceChildren(...docKinds().map(k => kindChip(k, state.kind === k, () => { state.kind = k; draw(); })));
    actions.forEach((a, i) => {
      buttons[i].replaceChildren(icon(a.icon), state.item ? a.label(state.item) : i ? '' : tr('Pick an item'));
      buttons[i].disabled = !state.item;
      buttons[i].hidden = i > 0 && !state.item;
    });
  }
  draw();
  input.focus();
}

// Moves (with its notes) or copies (a file of its own, without notes) a document to another item.
export function moveDoc(d) {
  const name = docName(d);
  pickItem({
    file: { name }, title: tr('Move or copy "{name}"', { name }), kinds: false, exclude: d.item_id,
    actions: [
      { label: it => tr('Move to {code}', { code: it.code }), icon: 'box', fn: it => act(() => api('PATCH', `/docs/${d.id}`, { item_id: it.id }), tr('{name} moved to {code}', { name, code: it.code })) },
      { label: it => tr('Copy to {code}', { code: it.code }), icon: 'copy', fn: it => act(() => api('POST', `/docs/${d.id}/copy`, { item_id: it.id }), tr('{name} copied to {code}', { name, code: it.code })) },
    ],
  });
}
