// Address book: filterable list, editable card, mails linked to each contact.
import { h, icon, S, ui, api, act, render, copy, trashIt, save, richField, contactHue, contactStyle, CONTACT_COLOR, hue, huePicker, filterChip, can, roClass, shareBox } from './core.js';
import { backlinksBox } from './views.js';
import { addrList } from './mail.js';
import { tr, trn, LOCALE } from './i18n.js';

const lc = s => String(s || '').toLowerCase();
const mailsOf = c => S.data.entries
  .filter(e => e.kind === 'mail' && c.email && lc(e.contact).split(',').map(s => s.trim()).includes(lc(c.email)))
  .sort((a, b) => !!a.done_at - !!b.done_at || b.updated_at.localeCompare(a.updated_at));

// Addresses of mails (received, sent, conversations) not in the address book: who writes, who is written to, who is
// in copy. My addresses and the ignored ones are excluded: a rule (saved in the account, valid on every device) is a
// whole address or part of an address or name ("noreply", "@shop.example", "newsletter").
const ignoreRules = () => S.data.mailIgnore || [];
const ignored = a => ignoreRules().some(r => lc(a.email).includes(r) || (a.name && lc(a.name).includes(r)));

function unknownAddresses() {
  const D = S.data;
  const seen = new Map();
  const add = (list, date, role) => {
    for (const a of addrList(list)) {
      const k = lc(a.email);
      if (D.contactByEmail.has(k) || D.mine.has(k) || ignored(a)) continue;
      const x = seen.get(k) || { email: a.email, name: '', n: 0, last: '', roles: new Set() };
      x.name ||= a.name;
      x.n++;
      if (date > x.last) x.last = date;
      x.roles.add(role);
      seen.set(k, x);
    }
  };
  for (const m of D.mailMsgs) if (m.direction === 'in') add(`${m.to_addr},${m.cc}`, m.date, tr('in copy'));
  for (const e of D.entries) if (e.kind === 'mail') add(`${e.contact || ''},${e.mail_cc || ''}`, e.done_at || e.updated_at, tr('you wrote to them'));
  for (const m of D.mailMsgs) if (m.direction === 'in') add(m.from_addr, m.date, tr('wrote to you'));
  return [...seen.values()].sort((a, b) => b.last.localeCompare(a.last));
}

function setRules(list) {
  S.data.mailIgnore = list;
  render();
  return act(() => api('PATCH', '/me', { mailIgnore: list }));
}
const addRule = r => { const x = lc(r).trim(); if (x && !ignoreRules().includes(x)) setRules([...ignoreRules(), x]); };
const dropRule = r => setRules(ignoreRules().filter(x => x !== r));

// Addresses ignored earlier, on this device: they move into the account only once.
function moveLocalIgnores() {
  if (!ui.ignoredAddrs.size) return;
  const list = [...new Set([...ignoreRules(), ...ui.ignoredAddrs])];
  ui.ignoredAddrs.clear();
  save('org.ignoredAddrs', []);
  queueMicrotask(() => setRules(list)); // not while drawing the page
}

// "To save" panel: one per line, with the name editable before saving.
function unknownPanel(list) {
  return h('div.unknown-panel',
    h('div.up-h', h('b', tr('Mail addresses not in the address book')), h('span.muted', `${list.length}`), h('span.grow'),
      h('button.icon-btn.sm', { title: tr('Close'), onclick: () => { ui.contactsUnknown = false; render(); } }, icon('x'))),
    h('form.up-rule', {
      onsubmit: ev => { ev.preventDefault(); const v = ev.target.elements.rule.value; ev.target.reset(); addRule(v); },
    },
    h('input', { name: 'rule', placeholder: tr('Ignore all those containing… (e.g. noreply, @shop.example, newsletter)'), 'data-fk': 'up-rule', autocomplete: 'off' }),
    h('button.btn.sm', { type: 'submit' }, tr('Ignore'))),
    ignoreRules().length > 0 && h('details.up-rules',
      h('summary.muted', trn(ignoreRules().length, '1 rule to stop suggesting addresses', '{n} rules to stop suggesting addresses')),
      h('div.up-chips', ignoreRules().map(r => h('span.chip', h('span.mono', r),
        h('button.icon-btn.sm', { type: 'button', title: tr('Remove the rule'), onclick: () => dropRule(r) }, icon('x')))))),
    !list.length && h('p.muted', tr('Nobody: everyone in your mails is already in the address book (or you ignored them).')),
    list.map(a => h('form.up-row', {
      onsubmit: ev => {
        ev.preventDefault();
        const name = ev.target.elements.name.value.trim();
        act(() => api('POST', '/contacts', { email: a.email, name }), tr('{name} added to the contacts', { name: name || a.email }));
      },
    },
    h('input', { name: 'name', value: a.name, placeholder: tr('Name'), 'data-fk': `up-${a.email}`, autocomplete: 'off' }),
    h('span.mono.up-mail', a.email),
    h('span.muted.up-info', `${[...a.roles].join(', ')} · ${trn(a.n, '1 mail', '{n} mails')}${a.last ? ` · ${new Date(a.last).toLocaleDateString(LOCALE)}` : ''}`),
    h('span.grow'),
    h('button.btn.sm.primary', { type: 'submit' }, icon('plus'), tr('Save')),
    h('button.btn.sm.ghost', { type: 'button', title: tr('Do not suggest it again'), onclick: () => addRule(a.email) }, tr('Ignore')))));
}

const GROUPS = {
  company: { label: tr('company'), none: tr('No company') },
  timeslot: { label: tr('time slot'), none: tr('No time slot') },
  role: { label: tr('role'), none: tr('No role') },
};

const newMail = c => window.dispatchEvent(new CustomEvent('org:quick', { detail: `m: >${c.email} ` }));

export function viewContacts(id) {
  if (id) return viewContact(+id);
  const D = S.data;
  const f = lc(ui.contactFilter.trim());
  const filtered = D.contacts.filter(c => !f || [c.name, c.email, c.company, c.role, c.timeslot, c.phone, c.notes].some(v => lc(v).includes(f)));
  moveLocalIgnores();
  const unknown = can('contatti', 'write') ? unknownAddresses() : [];

  // Dynamic grouping: by company, time slot or role; every value in use becomes a tab.
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
      h('span.cname.ccol', { style: contactStyle(c) }, c.name || h('span.muted', tr('no name'))),
      c.company && field !== 'company' && h('span.muted', c.company),
      h('span.item-meta',
        c.timeslot && field !== 'timeslot' && h('span.slot', icon('cal'), c.timeslot),
        c.email && h('span.mono', c.email),
        c.phone && h('span', c.phone),
        n > 0 && h('span.badge', { title: tr('mails to send') }, n)));
  };

  return h('div.view', { class: roClass(can('contatti', 'write')) },
    h('div.toolbar',
      h('input.filter', {
        type: 'search', placeholder: tr('Filter by name, email, company, phone…'), value: ui.contactFilter, 'data-fk': 'contactfilter',
        oninput: ev => { ui.contactFilter = ev.target.value; render(); },
      }),
      h('div.seg.group-seg',
        h('span.muted', tr('Group')),
        [['none', tr('no')], ...Object.entries(GROUPS).map(([k, g]) => [k, g.label])].map(([k, label]) =>
          h('button', { class: (field || 'none') === k && 'on', onclick: () => setGroup(k) }, label))),
      can('contatti', 'write') && h('button.btn.ghost', {
        class: ui.contactsUnknown && 'on', title: tr('People in your mails who are not in the address book'),
        onclick: () => { ui.contactsUnknown = !ui.contactsUnknown; render(); },
      }, icon('plus'), tr('To save'), unknown.length > 0 && h('span.badge', unknown.length))),
    ui.contactsUnknown && unknownPanel(unknown),
    field && values.length > 0 && h('div.toolbar.cats',
      filterChip({ on: ui.contactTab == null, label: tr('All'), n: filtered.length, onclick: () => { ui.contactTab = null; render(); } }),
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
    h('input', { name: 'name', placeholder: tr('Name'), 'data-fk': 'newcname', autocomplete: 'off' }),
    h('input', { name: 'email', type: 'email', placeholder: 'email', 'data-fk': 'newcemail', autocomplete: 'off' }),
    h('button.btn', { type: 'submit' }, icon('plus'), tr('Add'))),
    !D.contacts.length && h('div.empty',
      h('p', tr('The address book is empty.')),
      h('p', tr('Contacts show up in the suggestions of '), h('code.k', '>'), tr(' and in the "To" field of mails, and '), h('code.k', '>name'), tr(' becomes their email.'))),
    D.contacts.length > 0 && !list.length && h('div.empty', h('p', tr('No contact matches the filter.'))),
    // "All" with a grouping on: a block per value, in the order of the tabs.
    field && ui.contactTab == null
      ? values.map(v => h('section.cgroup',
        h('div.day-h', v || GROUPS[field].none, h('span.muted', ` · ${counts.get(v)}`)),
        h('div.items', filtered.filter(c => valueOf(c) === v).map(row))))
      : h('div.items', list.map(row)));
}

function viewContact(id) {
  const D = S.data;
  const c = D.contactById.get(id);
  if (!c) return h('div.empty', h('p', tr('Contact not found.')), h('a', { href: '#/contatti' }, tr('Back to the contacts')));
  const patch = f => act(() => api('PATCH', `/contacts/${c.id}`, f));
  const field = (key, label, attrs = {}) => h('label.f', h('span', label),
    h('input', { value: c[key], 'data-fk': `c-${key}-${c.id}`, ...attrs, onchange: ev => patch({ [key]: ev.target.value }) }));

  return h('div.view', { class: roClass(can('contatti', 'write')) },
    h('div.head',
      h('a.icon-btn', { href: '#/contatti', title: tr('Contacts') }, icon('back')),
      // The contact's colour (coloured name in mails) behind the dot, as for projects and categories.
      ui.contactColor === 'contact' || !(ui.contactColor in CONTACT_COLOR)
        ? h('button.cdot.big.pick.cat', {
          style: contactStyle(c), title: tr('Contact colour'),
          onclick: () => { ui.contactPicker = ui.contactPicker === c.id ? null : c.id; render(); },
        })
        // Colour by company / time slot / role: it comes from the field, the dot is not changed here.
        : h('span.cdot.big', {
          class: contactHue(c) == null ? null : 'cat', style: contactStyle(c),
          title: tr('Colour {how}: the mode is changed in Settings → Contacts', { how: CONTACT_COLOR[ui.contactColor].toLowerCase() }),
        }),
      h('input.h-title', { value: c.name, placeholder: tr('Name'), 'data-fk': `cname-${c.id}`, onchange: ev => patch({ name: ev.target.value }) })),
    ui.contactPicker === c.id && h('div.cat-pick', h('span.muted', tr('Colour of {name} (their name in mails): ', { name: c.name || c.email })),
      huePicker(c.hue ?? null, hue(String(c.email || c.name).toLowerCase()), x => { ui.contactPicker = null; patch({ hue: x }); })),
    shareBox('contact', c),
    h('div.grid',
      field('email', tr('Email'), { type: 'email', class: 'mono' }),
      field('phone', tr('Phone'), { type: 'tel' }),
      field('company', tr('Company'), { 'data-ac': 'cfield', 'data-ac-field': 'company', autocomplete: 'off' }),
      field('role', tr('Role'), { 'data-ac': 'cfield', 'data-ac-field': 'role', autocomplete: 'off' }),
      field('timeslot', tr('Time slot'), { 'data-ac': 'cfield', 'data-ac-field': 'timeslot', autocomplete: 'off', placeholder: tr('e.g. morning, 2-6pm, Shenzhen (UTC+8)') }),
    ),
    richField({
      fk: `cnotes-${c.id}`, cls: 'proj-notes', value: c.notes, placeholder: tr('Notes: hours, how they prefer to be contacted, references… (Markdown: # heading, **bold**, - list)'),
      attrs: { 'data-ac': 'text', 'data-ac-only': '#' }, onSave: notes => patch({ notes }), md: true,
    }),
    h('div.toolbar',
      c.email && h('button.btn', { onclick: () => newMail(c) }, icon('mail'), tr('New mail')),
      c.email && h('button.btn.ghost', { onclick: () => copy(c.email) }, icon('copy'), tr('Copy email')),
      c.phone && h('a.btn.ghost', { href: `tel:${c.phone.replace(/[^\d+]/g, '')}` }, tr('Call'))),
    // Mails to their address and entries linking them with [[, archived ones too; mails to send and sent ones apart.
    backlinksBox('contatto', c.id, { title: tr('Mails and links') })
      || h('p.muted', c.email ? tr('No mail to this contact.') : tr('Add the email to write to them from the quick bar.')),
    h('div.danger-zone',
      h('span.muted', tr('Added on {date}', { date: new Date(c.created_at).toLocaleDateString(LOCALE) })),
      h('button.btn.sm.danger', {
        onclick: () => trashIt('contact', `/contacts/${c.id}`, c.name || c.email).then(ok => { if (ok) location.hash = '#/contatti'; }),
      }, icon('trash'), tr('Delete'))));
}
