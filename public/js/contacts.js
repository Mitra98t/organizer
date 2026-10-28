// Rubrica: elenco filtrabile, scheda modificabile, mail collegate a ogni contatto.
import { h, icon, S, ui, api, act, render, copy, trashIt, save, richField, contactHue, contactStyle, CONTACT_COLOR, hue, huePicker, filterChip } from './core.js';
import { backlinksBox } from './views.js';

const lc = s => String(s || '').toLowerCase();
const mailsOf = c => S.data.entries
  .filter(e => e.kind === 'mail' && c.email && lc(e.contact).split(',').map(s => s.trim()).includes(lc(c.email)))
  .sort((a, b) => !!a.done_at - !!b.done_at || b.updated_at.localeCompare(a.updated_at));

// Destinatari usati nelle mail ma non ancora in rubrica: si aggiungono con un clic.
function unknownRecipients() {
  const D = S.data;
  const seen = new Map();
  for (const e of D.entries) {
    if (e.kind !== 'mail' || !e.contact) continue;
    for (const a of e.contact.split(',').map(s => s.trim())) {
      if (/^[^\s@]+@[^\s@]+$/.test(a) && !D.contactByEmail.has(lc(a))) seen.set(lc(a), a);
    }
  }
  return [...seen.values()].sort();
}

const GROUPS = {
  company: { label: 'azienda', none: 'Senza azienda' },
  timeslot: { label: 'fascia oraria', none: 'Senza fascia oraria' },
  role: { label: 'ruolo', none: 'Senza ruolo' },
};

const newMail = c => window.dispatchEvent(new CustomEvent('org:quick', { detail: `m: >${c.email} ` }));

export function viewContacts(id) {
  if (id) return viewContact(+id);
  const D = S.data;
  const f = lc(ui.contactFilter.trim());
  const filtered = D.contacts.filter(c => !f || [c.name, c.email, c.company, c.role, c.timeslot, c.phone, c.notes].some(v => lc(v).includes(f)));
  const unknown = unknownRecipients();

  // Raggruppamento dinamico: per azienda, fascia oraria o ruolo; ogni valore usato diventa una tab.
  const field = GROUPS[ui.contactGroup] ? ui.contactGroup : null;
  const valueOf = c => (field ? (c[field] || '').trim() : '');
  const counts = new Map();
  if (field) for (const c of filtered) counts.set(valueOf(c), (counts.get(valueOf(c)) || 0) + 1);
  const values = [...counts.keys()].sort((a, b) => (!a) - (!b) || a.localeCompare(b));
  if (ui.contactTab != null && !counts.has(ui.contactTab)) ui.contactTab = null;
  const list = field && ui.contactTab != null ? filtered.filter(c => valueOf(c) === ui.contactTab) : filtered;
  const setGroup = g => { ui.contactGroup = g; ui.contactTab = null; save('org.contactGroup', g); render(); };
  const row = c => {
    const n = mailsOf(c).filter(e => !e.done_at).length;
    return h('a.item-row.contact-row', { href: `#/contatti/${c.id}` },
      h('span.cdot', { class: contactHue(c) == null ? null : 'cat', style: contactStyle(c) }),
      h('span.cname.ccol', { style: contactStyle(c) }, c.name || h('span.muted', 'senza nome')),
      c.company && field !== 'company' && h('span.muted', c.company),
      h('span.item-meta',
        c.timeslot && field !== 'timeslot' && h('span.slot', icon('cal'), c.timeslot),
        c.email && h('span.mono', c.email),
        c.phone && h('span', c.phone),
        n > 0 && h('span.badge', { title: 'mail da mandare' }, n)));
  };

  return h('div.view',
    h('div.toolbar',
      h('input.filter', {
        type: 'search', placeholder: 'Filtra per nome, email, azienda, telefono…', value: ui.contactFilter, 'data-fk': 'contactfilter',
        oninput: ev => { ui.contactFilter = ev.target.value; render(); },
      }),
      h('div.seg.group-seg',
        h('span.muted', 'Raggruppa'),
        [['none', 'no'], ...Object.entries(GROUPS).map(([k, g]) => [k, g.label])].map(([k, label]) =>
          h('button', { class: (field || 'none') === k && 'on', onclick: () => setGroup(k) }, label)))),
    field && values.length > 0 && h('div.toolbar.cats',
      filterChip({ on: ui.contactTab == null, label: 'Tutti', n: filtered.length, onclick: () => { ui.contactTab = null; render(); } }),
      values.map(v => filterChip({ on: ui.contactTab === v, label: v || GROUPS[field].none, n: counts.get(v), onclick: () => { ui.contactTab = v; render(); } }))),
    h('form.inline-add', {
      onsubmit: ev => {
        ev.preventDefault();
        const els = ev.target.elements;
        const name = els.name.value.trim();
        const email = els.email.value.trim();
        if (!name && !email) return;
        act(async () => { const r = await api('POST', '/contacts', { name, email }); location.hash = `#/contatti/${r.id}`; });
      },
    },
    h('input', { name: 'name', placeholder: 'Nome', 'data-fk': 'newcname', autocomplete: 'off' }),
    h('input', { name: 'email', type: 'email', placeholder: 'email', 'data-fk': 'newcemail', autocomplete: 'off' }),
    h('button.btn', { type: 'submit' }, icon('plus'), 'Aggiungi')),
    !D.contacts.length && h('div.empty',
      h('p', 'La rubrica è vuota.'),
      h('p', 'I contatti compaiono nei suggerimenti di ', h('code.k', '>'), ' e nel campo "A" delle mail, e ', h('code.k', '>nome'), ' diventa la sua email.')),
    D.contacts.length > 0 && !list.length && h('div.empty', h('p', 'Nessun contatto corrisponde al filtro.')),
    // "Tutti" con un raggruppamento attivo: un blocco per valore, nell'ordine delle tab.
    field && ui.contactTab == null
      ? values.map(v => h('section.cgroup',
        h('div.day-h', v || GROUPS[field].none, h('span.muted', ` · ${counts.get(v)}`)),
        h('div.items', filtered.filter(c => valueOf(c) === v).map(row))))
      : h('div.items', list.map(row)),
    unknown.length > 0 && h('div.unknown',
      h('div.day-h', 'Destinatari usati, non in rubrica'),
      h('div.item-chips', unknown.map(a => h('button.item-chip', {
        title: 'Aggiungi alla rubrica',
        onclick: () => act(() => api('POST', '/contacts', { email: a, name: '' })),
      }, icon('plus'), a)))));
}

function viewContact(id) {
  const D = S.data;
  const c = D.contactById.get(id);
  if (!c) return h('div.empty', h('p', 'Contatto non trovato.'), h('a', { href: '#/contatti' }, 'Torna ai contatti'));
  const patch = f => act(() => api('PATCH', `/contacts/${c.id}`, f));
  const field = (key, label, attrs = {}) => h('label.f', h('span', label),
    h('input', { value: c[key], 'data-fk': `c-${key}-${c.id}`, ...attrs, onchange: ev => patch({ [key]: ev.target.value }) }));

  return h('div.view',
    h('div.head',
      h('a.icon-btn', { href: '#/contatti', title: 'Contatti' }, icon('back')),
      // Colore del contatto (nome colorato nelle mail) dietro al pallino, come per progetti e categorie.
      ui.contactColor === 'contact' || !(ui.contactColor in CONTACT_COLOR)
        ? h('button.cdot.big.pick.cat', {
          style: contactStyle(c), title: 'Colore del contatto',
          onclick: () => { ui.contactPicker = ui.contactPicker === c.id ? null : c.id; render(); },
        })
        // Colore per azienda / fascia oraria / ruolo: viene dal dato, il pallino non si cambia qui.
        : h('span.cdot.big', {
          class: contactHue(c) == null ? null : 'cat', style: contactStyle(c),
          title: `Colore ${CONTACT_COLOR[ui.contactColor].toLowerCase()}: si cambia il modo in Impostazioni → Contatti`,
        }),
      h('input.h-title', { value: c.name, placeholder: 'Nome', 'data-fk': `cname-${c.id}`, onchange: ev => patch({ name: ev.target.value }) })),
    ui.contactPicker === c.id && h('div.cat-pick', h('span.muted', `Colore di ${c.name || c.email} (il suo nome nelle mail): `),
      huePicker(c.hue ?? null, hue(String(c.email || c.name).toLowerCase()), x => { ui.contactPicker = null; patch({ hue: x }); })),
    h('div.grid',
      field('email', 'Email', { type: 'email', class: 'mono' }),
      field('phone', 'Telefono', { type: 'tel' }),
      field('company', 'Azienda', { 'data-ac': 'cfield', 'data-ac-field': 'company', autocomplete: 'off' }),
      field('role', 'Ruolo', { 'data-ac': 'cfield', 'data-ac-field': 'role', autocomplete: 'off' }),
      field('timeslot', 'Fascia oraria', { 'data-ac': 'cfield', 'data-ac-field': 'timeslot', autocomplete: 'off', placeholder: 'es. mattina, 14-18, Shenzhen (UTC+8)' }),
    ),
    richField({
      fk: `cnotes-${c.id}`, cls: 'proj-notes', value: c.notes, placeholder: 'Note: orari, come preferisce essere contattato, riferimenti…',
      attrs: { 'data-ac': 'text', 'data-ac-only': '#' }, onSave: notes => patch({ notes }),
    }),
    h('div.toolbar',
      c.email && h('button.btn', { onclick: () => newMail(c) }, icon('mail'), 'Nuova mail'),
      c.email && h('button.btn.ghost', { onclick: () => copy(c.email) }, icon('copy'), 'Copia email'),
      c.phone && h('a.btn.ghost', { href: `tel:${c.phone.replace(/[^\d+]/g, '')}` }, 'Chiama')),
    // Mail al suo indirizzo e voci che lo collegano con [[, anche archiviate; mail da mandare e mandate separate.
    backlinksBox('contatto', c.id, { title: 'Mail e collegamenti' })
      || h('p.muted', c.email ? 'Nessuna mail a questo contatto.' : 'Aggiungi l\'email per scrivergli dalla barra rapida.'),
    h('div.danger-zone',
      h('span.muted', `Aggiunto il ${new Date(c.created_at).toLocaleDateString('it-IT')}`),
      h('button.btn.sm.danger', {
        onclick: () => trashIt('contact', `/contacts/${c.id}`, c.name || c.email).then(ok => { if (ok) location.hash = '#/contatti'; }),
      }, icon('trash'), 'Elimina')));
}
