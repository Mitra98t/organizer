// Rubrica: elenco filtrabile, scheda modificabile, mail collegate a ogni contatto.
import { h, icon, S, ui, api, act, render, copy, trashIt, save, richField, contactHue, contactStyle, CONTACT_COLOR, hue, huePicker, filterChip, can, roClass } from './core.js';
import { backlinksBox } from './views.js';
import { addrList } from './mail.js';

const lc = s => String(s || '').toLowerCase();
const mailsOf = c => S.data.entries
  .filter(e => e.kind === 'mail' && c.email && lc(e.contact).split(',').map(s => s.trim()).includes(lc(c.email)))
  .sort((a, b) => !!a.done_at - !!b.done_at || b.updated_at.localeCompare(a.updated_at));

// Indirizzi delle mail (ricevute, mandate, conversazioni) che non sono in rubrica: chi scrive, a chi si scrive,
// chi è in copia. Esclusi i miei indirizzi e quelli ignorati. Il nome viene da "Nome <email>" quando c'è.
function unknownAddresses() {
  const D = S.data;
  const seen = new Map();
  const add = (list, date, role) => {
    for (const a of addrList(list)) {
      const k = lc(a.email);
      if (D.contactByEmail.has(k) || D.mine.has(k) || ui.ignoredAddrs.has(k)) continue;
      const x = seen.get(k) || { email: a.email, name: '', n: 0, last: '', roles: new Set() };
      x.name ||= a.name;
      x.n++;
      if (date > x.last) x.last = date;
      x.roles.add(role);
      seen.set(k, x);
    }
  };
  for (const m of D.inbox) {
    add(m.from_addr, m.date, 'ti ha scritto');
    add(`${m.to_addr},${m.cc}`, m.date, 'in copia');
  }
  for (const e of D.entries) if (e.kind === 'mail') add(`${e.contact || ''},${e.mail_cc || ''}`, e.done_at || e.updated_at, 'gli hai scritto');
  for (const m of D.mailMsgs) if (m.direction === 'in') add(m.from_addr, m.date, 'ti ha scritto');
  return [...seen.values()].sort((a, b) => b.last.localeCompare(a.last));
}

function ignoreAddr(email) {
  ui.ignoredAddrs.add(lc(email));
  save('org.ignoredAddrs', [...ui.ignoredAddrs]);
  render();
}

// Pannello "Da salvare": uno per riga, con il nome modificabile prima di salvare.
function unknownPanel(list) {
  return h('div.unknown-panel',
    h('div.up-h', h('b', 'Indirizzi delle mail non in rubrica'), h('span.muted', `${list.length}`), h('span.grow'),
      h('button.icon-btn.sm', { title: 'Chiudi', onclick: () => { ui.contactsUnknown = false; render(); } }, icon('x'))),
    !list.length && h('p.muted', 'Nessuno: tutte le persone delle tue mail sono già in rubrica.'),
    list.map(a => h('form.up-row', {
      onsubmit: ev => {
        ev.preventDefault();
        const name = ev.target.elements.name.value.trim();
        act(() => api('POST', '/contacts', { email: a.email, name }), `${name || a.email} aggiunto ai contatti`);
      },
    },
    h('input', { name: 'name', value: a.name, placeholder: 'Nome', 'data-fk': `up-${a.email}`, autocomplete: 'off' }),
    h('span.mono.up-mail', a.email),
    h('span.muted.up-info', `${[...a.roles].join(', ')} · ${a.n} ${a.n === 1 ? 'mail' : 'mail'}${a.last ? ` · ${new Date(a.last).toLocaleDateString('it-IT')}` : ''}`),
    h('span.grow'),
    h('button.btn.sm.primary', { type: 'submit' }, icon('plus'), 'Salva'),
    h('button.btn.sm.ghost', { type: 'button', title: 'Non proporlo più (su questo dispositivo)', onclick: () => ignoreAddr(a.email) }, 'Ignora'))));
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
  const unknown = can('contatti', 'write') ? unknownAddresses() : [];

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

  return h('div.view', { class: roClass(can('contatti', 'write')) },
    h('div.toolbar',
      h('input.filter', {
        type: 'search', placeholder: 'Filtra per nome, email, azienda, telefono…', value: ui.contactFilter, 'data-fk': 'contactfilter',
        oninput: ev => { ui.contactFilter = ev.target.value; render(); },
      }),
      h('div.seg.group-seg',
        h('span.muted', 'Raggruppa'),
        [['none', 'no'], ...Object.entries(GROUPS).map(([k, g]) => [k, g.label])].map(([k, label]) =>
          h('button', { class: (field || 'none') === k && 'on', onclick: () => setGroup(k) }, label))),
      can('contatti', 'write') && h('button.btn.ghost', {
        class: ui.contactsUnknown && 'on', title: 'Persone delle tue mail che non sono in rubrica',
        onclick: () => { ui.contactsUnknown = !ui.contactsUnknown; render(); },
      }, icon('plus'), 'Da salvare', unknown.length > 0 && h('span.badge', unknown.length))),
    ui.contactsUnknown && unknownPanel(unknown),
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
      : h('div.items', list.map(row)));
}

function viewContact(id) {
  const D = S.data;
  const c = D.contactById.get(id);
  if (!c) return h('div.empty', h('p', 'Contatto non trovato.'), h('a', { href: '#/contatti' }, 'Torna ai contatti'));
  const patch = f => act(() => api('PATCH', `/contacts/${c.id}`, f));
  const field = (key, label, attrs = {}) => h('label.f', h('span', label),
    h('input', { value: c[key], 'data-fk': `c-${key}-${c.id}`, ...attrs, onchange: ev => patch({ [key]: ev.target.value }) }));

  return h('div.view', { class: roClass(can('contatti', 'write')) },
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
