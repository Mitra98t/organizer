// Modali per scegliere dal magazzino, con una ricerca come nella pagina Documenti:
//  - pickDoc: un documento (file) da allegare a una mail; si cerca per nome, codice (anche alternativo), nome
//    dell'articolo, tipo e versione, e si filtra per tipo; i documenti stanno raggruppati sotto il loro articolo;
//  - pickItem: l'articolo (e il tipo di documento) in cui salvare un allegato ricevuto; con actions e senza tipo
//    serve anche a spostare o copiare un documento in un altro articolo.
// Il contenuto si ridisegna da solo mentre si scrive: il resto dell'app non si tocca.
import { h, icon, S, api, act, docName, docKinds, dkAttrs, itemAttrs, fmtSize, filterChip, aliasCodes } from './core.js';
import { fuzzy } from './autocomplete.js';

const lc = s => String(s ?? '').toLowerCase();
const LIMIT = 60;
// Chip del tipo di documento, con il suo colore.
const kindChip = (k, on, onclick) => { const a = dkAttrs(k); return filterChip({ on, label: k, cls: `tint ${a.class}`, style: a.style, onclick }); };

function modal(title, cls) {
  const body = h('div.pk-body');
  const dialog = h(`dialog.fb.pk.${cls}`, { 'aria-label': title, onclose: () => dialog.remove() },
    h('div.pk-h', h('h2', title), h('button.icon-btn', { type: 'button', title: 'Chiudi', 'aria-label': 'Chiudi', onclick: () => dialog.close() }, icon('x'))),
    body);
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body, close: () => dialog.close() };
}

// Punteggio rispetto alla ricerca (più basso = meglio, null = non c'entra): ogni parola deve trovarsi in almeno
// un campo ("sch42 2.3" = codice e versione); per ogni parola conta il campo migliore (più il suo peso).
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

export function pickDoc({ title = 'Allega dal magazzino', onPick }) {
  const D = S.data;
  const m = modal(title, 'pk-docs');
  const state = { q: '', kind: null };
  const input = h('input.filter', { type: 'search', placeholder: 'Cerca per nome, codice, articolo, tipo, versione…', autofocus: true, oninput: ev => { state.q = ev.target.value; draw(); } });
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
    // Sotto il loro articolo, nell'ordine del primo trovato.
    const groups = new Map();
    for (const x of found) {
      if (!groups.has(x.it.id)) groups.set(x.it.id, []);
      groups.get(x.it.id).push(x.d);
    }
    list.replaceChildren(...(!found.length ? [h('p.muted.pk-empty', docs.length ? 'Nessun documento trovato.' : 'Nel magazzino non ci sono ancora file.')] : []),
      ...[...groups].map(([id, ds]) => {
        const it = D.itemById.get(id);
        return h('div.pk-group',
          h('div.pk-item', h('span.code', itemAttrs(it), it.code), h('span.muted', it.name || '')),
          ds.map(d => h('button.pk-row', { type: 'button', onclick: () => { m.close(); onPick(d); } },
            h('span.dk', dkAttrs(d.kind), d.kind), h('span.pk-name', docName(d)), d.version && h('span.muted.mono', `v${d.version}`),
            h('span.grow'), d.size != null && h('span.muted', fmtSize(d.size)))));
      }));
  }
  draw();
  input.focus();
}

// Tipo proposto per un file, dall'estensione.
function guessKind(name) {
  const ext = lc(name).split('.').pop();
  if (['bin', 'hex', 'elf', 'uf2', 'img', 'zip'].includes(ext)) return 'firmware';
  if (ext === 'pdf') return 'datasheet';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext)) return 'foto';
  if (['sch', 'kicad_sch', 'brd', 'kicad_pcb'].includes(ext)) return 'schema';
  return 'altro';
}

// actions: i pulsanti in fondo, { label(articolo), icon, fn(articolo, tipo) }; il primo vale anche col doppio clic.
// kinds false: senza la scelta del tipo. exclude: un articolo da non proporre (quello dove il documento sta già).
export function pickItem({ file, onPick, title, kinds: withKinds = true, exclude = null,
  actions = [{ label: it => `Salva in ${it.code}`, icon: 'box', fn: onPick }] }) {
  const D = S.data;
  const m = modal(title || `Salva "${file.name}" nel magazzino`, 'pk-items');
  const state = { q: '', item: null, kind: docKinds().includes(guessKind(file.name)) ? guessKind(file.name) : 'altro' };
  const input = h('input.filter', { type: 'search', placeholder: 'Articolo: codice (anche alternativo), nome, categoria…', oninput: ev => { state.q = ev.target.value; draw(); } });
  const list = h('div.pk-list');
  const kinds = h('div.toolbar.cats');
  const pick = a => { if (state.item) { m.close(); a.fn(state.item, state.kind); } };
  const buttons = actions.map((a, i) => h(`button.btn${i ? '' : '.primary'}`, { type: 'button', onclick: () => pick(a) }));
  m.body.append(input, list, ...(withKinds ? [h('div.pk-sub', 'Tipo di documento'), kinds] : []),
    h('div.toolbar.pk-foot', buttons, h('button.btn.ghost', { type: 'button', onclick: m.close }, 'Annulla')));

  function draw() {
    const q = lc(state.q.trim());
    const found = D.items.filter(it => it.id !== exclude).map(it => ({ it, r: score(q, [[it.code], ...aliasCodes(it).map(a => [a, 0.1]), [it.name, 0.5], [it.category, 1]]) }))
      .filter(x => x.r != null).sort((a, b) => a.r - b.r || a.it.code.localeCompare(b.it.code)).slice(0, LIMIT);
    list.replaceChildren(...(!found.length ? [h('p.muted.pk-empty', 'Nessun articolo trovato.')] : []),
      ...found.map(({ it }) => h('button.pk-row', {
        type: 'button', class: state.item?.id === it.id ? 'on' : null,
        onclick: () => { state.item = it; draw(); }, ondblclick: () => { state.item = it; pick(actions[0]); },
      }, h('span.code', itemAttrs(it), it.code), h('span.pk-name', it.name || ''), h('span.grow'), it.category && h('span.muted', it.category))));
    kinds.replaceChildren(...docKinds().map(k => kindChip(k, state.kind === k, () => { state.kind = k; draw(); })));
    actions.forEach((a, i) => {
      buttons[i].replaceChildren(icon(a.icon), state.item ? a.label(state.item) : i ? '' : 'Scegli un articolo');
      buttons[i].disabled = !state.item;
      buttons[i].hidden = i > 0 && !state.item;
    });
  }
  draw();
  input.focus();
}

// Sposta (con le note) o copia (un file suo, senza note) un documento in un altro articolo.
export function moveDoc(d) {
  const name = docName(d);
  pickItem({
    file: { name }, title: `Sposta o copia "${name}"`, kinds: false, exclude: d.item_id,
    actions: [
      { label: it => `Sposta in ${it.code}`, icon: 'box', fn: it => act(() => api('PATCH', `/docs/${d.id}`, { item_id: it.id }), `${name} spostato in ${it.code}`) },
      { label: it => `Copia in ${it.code}`, icon: 'copy', fn: it => act(() => api('POST', `/docs/${d.id}/copy`, { item_id: it.id }), `${name} copiato in ${it.code}`) },
    ],
  });
}
