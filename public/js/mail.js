// Mail: composer (recipients, subject, text and sending to the mail client) and the side-column blocks that tie mail
// to the rest of Organizer (people, attachments both ways, links, who mentions it). Mail and topic pages: topics.js.
// With the Thunderbird extension connected (server/thunderbird.js) "Send" opens the mail there, the status updates
// by itself and the received and sent messages end up in their thread.
import {
  h, icon, S, ui, api, act, toast, render, patchEntry, fmtSize, fmtTime, plainRefs, richField, contactStyle, contactNames, can, itemAttrs, docName,
} from './core.js';
import { backlinksBox } from './views.js';
import { pickDoc, pickItem } from './pickers.js';
import { kindOf, previewBody } from './docview.js';
import { tr } from './i18n.js';

const subjectOf = e => plainRefs(e.mail_subject || e.title.replace(/(^|\s)#/g, '$1'));

export function mailto(e) {
  const to = String(e.contact || '').split(',').map(s => s.trim()).filter(a => /^[^\s@]+@[^\s@]+$/.test(a)).join(',');
  const q = [`subject=${encodeURIComponent(subjectOf(e))}`];
  if (e.mail_cc) q.push(`cc=${encodeURIComponent(e.mail_cc)}`);
  if (e.notes) q.push(`body=${encodeURIComponent(plainRefs(e.notes))}`);
  return `mailto:${to}?${q.join('&')}`;
}

// Fields save on blur: before sending, what is on screen is saved, even if the focus is still there.
async function saveVisible(e) {
  const val = fk => document.querySelector(`[data-fk="${fk}-${e.id}"]`)?.value;
  const now = { contact: val('to'), mail_cc: val('cc'), mail_subject: val('subj'), notes: val('body') };
  const patch = {};
  for (const [k, v] of Object.entries(now)) if (v !== undefined && v !== (e[k] || '')) patch[k] = v;
  if (Object.keys(patch).length) {
    Object.assign(e, patch);
    await api('PATCH', `/entries/${e.id}`, patch);
  }
}

async function send(e) {
  try {
    await saveVisible(e);
    if (ui.richEdit === `body-${e.id}`) {
      ui.richEdit = null;
      render();
    }
    if (S.data.mailExt) {
      await api('POST', `/entries/${e.id}/compose`);
      toast(tr('Opened in Thunderbird: when you send it, it becomes "sent" here by itself'));
      return;
    }
    const atts = S.data.attachmentsOf.get(e.id) || [];
    if (!ui.mailHelper) {
      location.href = mailto(e);
      if (atts.length) toast(tr('Attachments not included: install the Thunderbird helper (Settings → Mail) or use .eml'), { err: true });
      return;
    }
    const { token } = await api('POST', `/entries/${e.id}/send`);
    const server = location.href.split('#')[0].replace(/[^/]*$/, '');
    location.href = `organizer-mail://open?server=${encodeURIComponent(server)}&token=${token}`;
    toast(tr('Mail opened in Thunderbird'), { action: { label: tr('Mark as sent'), fn: () => patchEntry(e, { done: true }) } });
  } catch (err) {
    toast(err.message, { err: true });
  }
}

async function upload(e, files) {
  for (const f of files) {
    toast(tr('Attaching {name}…', { name: f.name }));
    await act(() => api('POST', `/entries/${e.id}/attachments?${new URLSearchParams({ name: f.name })}`, f));
  }
}

// The mail to write. Attachments are managed in the side column, but they can be dropped here too.
export function mailComposer(e) {
  const saveField = key => ev => { if (ev.target.value !== (e[key] || '')) patchEntry(e, { [key]: ev.target.value }); };
  const box = h('div.mail',
    h('label.mf', h('span', tr('To')),
      h('input', { value: e.contact || '', placeholder: tr('email or name from the address book, separated by commas'), 'data-fk': `to-${e.id}`, 'data-ac': 'email', autocomplete: 'off', spellcheck: 'false', onblur: saveField('contact') })),
    h('label.mf', h('span', 'Cc'),
      h('input', { value: e.mail_cc || '', 'data-fk': `cc-${e.id}`, 'data-ac': 'email', autocomplete: 'off', spellcheck: 'false', onblur: saveField('mail_cc') })),
    h('label.mf', h('span', tr('Subject')),
      h('input', { value: e.mail_subject || '', placeholder: subjectOf({ ...e, mail_subject: null }), 'data-fk': `subj-${e.id}`, onblur: saveField('mail_subject') })),
    // #item suggests from the inventory and writes the code without # (the mail goes to people who do not use the app);
    // [[ links documents, entries, contacts and projects: in the sent mail they become their name.
    // In the text being read, codes without # are coloured like the others (bare).
    richField({
      fk: `body-${e.id}`, cls: 'mail-body', rows: 6, value: e.notes, bare: true,
      placeholder: tr('Mail text… (#code for an item, [[ to link something else)'),
      attrs: { 'data-ac': 'mail', 'data-ac-only': '#', 'data-ac-bare': '', 'data-ac-entry': e.id },
      onSave: notes => patchEntry(e, { notes }),
    }),
    h('div.mail-actions',
      // mousedown without effect: the text stays in edit mode and is not redrawn (moving the button) before the click;
      // send reads the fields as they are.
      h('button.btn.primary', { onmousedown: ev => ev.preventDefault(), onclick: () => send(e) }, icon('send'), S.data.mailExt || ui.mailHelper ? tr('Send with Thunderbird') : tr('Send mail')),
      h('a.btn.sm.ghost', { href: mailto(e), title: tr('Opens the default mail app, without attachments') }, tr('Mail app')),
      h('a.btn.sm.ghost', { href: `api/entries/${e.id}/eml`, download: '', title: tr('.eml file with attachments') }, icon('download'), '.eml')));

  box.addEventListener('dragover', ev => { ev.preventDefault(); box.classList.add('drag'); });
  box.addEventListener('dragleave', () => box.classList.remove('drag'));
  box.addEventListener('drop', ev => {
    ev.preventDefault();
    box.classList.remove('drag');
    if (ev.dataTransfer.files.length) upload(e, [...ev.dataTransfer.files]);
  });
  return box;
}

// ---------- addresses ----------
export const lc = s => String(s || '').toLowerCase();
// "Name <email>, …" → "email, …" (so contacts in the address book are recognised and coloured).
export const addrs = s => String(s || '').split(',').map(a => (a.match(/<([^>]+)>/)?.[1] || a).trim()).filter(Boolean).join(', ');
// "Name <email>" → { name, email }
export const parseAddr = a => {
  const email = (String(a).match(/<([^>]+)>/)?.[1] || String(a)).trim();
  return { email, name: String(a).replace(/<[^>]*>/, '').replace(/["']/g, '').trim().replace(email, '').trim() };
};
export const addrList = s => String(s || '').split(',').map(parseAddr).filter(a => a.email.includes('@'));

export function fromName(addr) {
  const email = addrs(addr);
  if (S.data.contactByEmail.get(lc(email))) return contactNames(email);
  return parseAddr(addr).name || email;
}

// ---------- side column ----------
export const block = (title, ...children) => (children.flat(Infinity).some(Boolean) ? h('div.ms-b', h('div.ms-h', title), children) : null);

// People: those in the address book with company and role; the others are added with a click.
export function peopleBlock(list, title = tr('People')) {
  const D = S.data;
  const seen = new Set();
  const rows = addrList(list.join(',')).filter(a => !D.mine.has(lc(a.email)) && !seen.has(lc(a.email)) && seen.add(lc(a.email))).map(a => {
    const c = D.contactByEmail.get(lc(a.email));
    if (c) {
      return h('a.ms-person', { href: `#/contatti/${c.id}`, title: a.email },
        icon('user'), h('span.ccol', { style: contactStyle(c) }, c.name || c.email),
        h('span.muted', [c.company, c.role].filter(Boolean).join(' · ')));
    }
    return h('div.ms-person.unknown', { title: a.email },
      icon('user'), h('span', a.name || a.email), a.name && h('span.muted.mono', a.email),
      can('contatti', 'write') && h('button.chip', {
        title: tr('Add to the address book'),
        onclick: () => act(() => api('POST', '/contacts', { email: a.email, name: a.name }), tr('Added to the contacts')),
      }, icon('plus'), 'rubrica'));
  });
  return block(title, rows);
}

// Attachments of the mail being sent: uploaded files or documents taken from the inventory.
export function outAttachments(e) {
  const D = S.data;
  const atts = D.attachmentsOf.get(e.id) || [];
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: ev => { const f = [...ev.target.files]; ev.target.value = ''; upload(e, f); } });
  return [
    atts.map(a => {
      const doc = a.doc_id && D.docById.get(a.doc_id);
      const it = doc && D.itemById.get(doc.item_id);
      return h('div.ms-att',
        icon('clip'),
        h('a', { href: `api/attachments/${a.id}/file`, title: tr('Download') }, a.filename),
        a.size != null && h('span.muted', fmtSize(a.size)),
        doc && h('a.code', { href: `#/d/${doc.id}`, title: tr('From the inventory: {name}', { name: docName(doc) }), ...itemAttrs(it) }, it?.code || tr('inventory')),
        !e.done_at && h('button.icon-btn.sm', { title: tr('Remove'), onclick: () => act(() => api('DELETE', `/attachments/${a.id}`)) }, icon('x')));
    }),
    !e.done_at && h('div.ms-add',
      h('button.btn.sm', { onclick: () => fileInput.click() }, icon('clip'), tr('Attach')),
      can('documenti') && h('button.btn.sm', {
        onclick: () => pickDoc({ onPick: d => act(() => api('POST', `/entries/${e.id}/attachments`, { doc_id: d.id }), tr('{name} attached', { name: docName(d) })) }),
      }, icon('box'), tr('From the inventory…')),
      fileInput),
  ];
}

// Forward links: items (#code) and [[…]] written in the mail.
export const REF_RE = /\[\[(doc|voce|contatto|progetto|mail|nota):(\d+)\]\]/g;
function linksBlock(itemIds, text) {
  const D = S.data;
  const items = [...new Set(itemIds)].map(id => D.itemById.get(id)).filter(Boolean);
  const refs = [...new Map([...String(text || '').matchAll(REF_RE)].map(m => [`${m[1]}:${m[2]}`, [m[1], +m[2]]])).values()].map(([kind, id]) => {
    if (kind === 'doc') { const d = D.docById.get(id); return d && h('a.ms-link', { href: `#/d/${id}` }, icon('file'), docName(d)); }
    if (kind === 'voce') { const x = D.entryById.get(id); return h('a.ms-link', { href: `#/v/${id}` }, icon('log'), x ? plainRefs(x.title) : tr('entry {id}', { id })); }
    if (kind === 'contatto') { const c = D.contactById.get(id); return c && h('a.ms-link', { href: `#/contatti/${id}` }, icon('user'), c.name || c.email); }
    if (kind === 'mail') { const t = D.threadById.get(id); return t && h('a.ms-link', { href: `#/t/${t.topic_id}?th=${id}` }, icon('mail'), t.subject); }
    if (kind === 'nota') { const n = D.docNoteById.get(id); return n && h('a.ms-link', { href: `#/d/${n.doc_id}?n=${id}` }, icon('log'), plainRefs(`[[nota:${id}]]`)); }
    const p = D.projectById?.get(id);
    return p && h('a.ms-link', { href: `#/p/${id}` }, '@', p.tag || p.name);
  }).filter(Boolean);
  return block(tr('Links'),
    items.length > 0 && h('div.item-chips', items.map(it => h('a.code', { href: `#/i/${it.id}`, ...itemAttrs(it), title: it.name || it.code }, it.code))),
    refs);
}

export function mailSide(e) {
  const msgs = S.data.msgsOfThread.get(e.thread_id) || [];
  return [
    peopleBlock([e.contact, e.mail_cc, ...msgs.filter(m => m.direction === 'in').map(m => m.from_addr)]),
    (!e.done_at || S.data.attachmentsOf.has(e.id)) && block(tr('Attachments'), outAttachments(e)),
    linksBlock((S.data.itemsOfEntry.get(e.id) || []).map(x => x.item_id), `${e.title} ${e.notes || ''}`),
    backlinksBox('voce', e.id, { title: tr('Mentioned in'), compact: true }),
  ];
}

// ---------- received attachments: preview and inventory ----------
// With Thunderbird connected, every attachment of a received mail can be viewed without saving it (Preview, for the
// kinds the document viewer can show) and can become an item's document: item and kind are chosen in a modal and
// the file comes from the preview just seen or from Thunderbird.
const canPreview = a => !!a.part && !['none', 'link'].includes(kindOf({ filename: a.name, mime: a.type }));
const previewHash = (msgId, n) => `#/allegato/${msgId}?n=${n}`;

function saveToItem(a, msgId, n) {
  pickItem({
    file: a,
    onPick: (it, kind) => act(async () => {
      const r = await api('POST', '/mail/attachments/save', { id: msgId, n, item_id: it.id, kind });
      toast(r.saved ? tr('{name} saved among the documents of {code}', { name: a.name, code: it.code }) : tr('Asked Thunderbird: {name} will appear among the documents of {code}', { name: a.name, code: it.code }));
    }),
  });
}

export function attList(list, msgId) {
  if (!list?.length) return null;
  const canSave = S.data.mailExt && can('documenti', 'write');
  return h('div.att-in', list.map((a, n) => {
    const preview = canPreview(a);
    // From the preview "back" returns here, to the mail it was opened from.
    const open = { href: previewHash(msgId, n), onclick: () => { ui.attFrom = location.hash; } };
    return h('div.ms-att', icon('clip'),
      preview ? h('a', { ...open, title: tr('Preview') }, a.name ?? a) : h('span', a.name ?? a),
      a.size && h('span.muted', fmtSize(a.size)),
      preview && h('a.chip', { ...open, title: tr('Look at the file without saving it') }, icon('file'), tr('preview')),
      canSave && a.part && h('button.chip', { title: tr('Save as a document of an inventory item'), onclick: () => saveToItem(a, msgId, n) },
        icon('box'), tr('→ inventory')));
  }));
}

// The preview page (#/allegato/message?n=index). The file is downloaded once (the server asks Thunderbird for it,
// which may take a few seconds) and stays in memory while the page is open.
const attFiles = new Map(); // "att:message:n" → { status, meta, att, url, error }

async function loadAttachment(key, msgId, n) {
  const st = { status: 'loading' };
  attFiles.set(key, st);
  try {
    st.meta = await api('GET', `/mail/messages/${msgId}`);
    st.att = st.meta.attachments[n];
    if (!st.att) throw new Error(tr('No such attachment'));
    render();
    const r = await fetch(`api/mail/messages/${msgId}/attachments/${n}`, { credentials: 'same-origin' })
      .catch(() => { throw new Error(tr('Connection interrupted: try again')); });
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || tr('Error {status}', { status: r.status }));
    const blob = await r.blob();
    if (attFiles.get(key) !== st) return; // page already closed
    Object.assign(st, { status: 'ready', blob, url: URL.createObjectURL(blob) });
  } catch (e) {
    Object.assign(st, { status: 'error', error: e.message });
  }
  render();
}

window.addEventListener('hashchange', () => {
  for (const [key, st] of attFiles) {
    const [, msgId, n] = key.split(':');
    if (location.hash === previewHash(msgId, n)) continue;
    if (st.url) URL.revokeObjectURL(st.url);
    attFiles.delete(key);
  }
});

// Back: to the mail the preview was opened from (or to its conversation, if we came from a link).
export function attachmentBack() {
  const st = [...attFiles.values()][0];
  if (ui.attFrom) {
    ui.attFrom = null;
    history.back();
  } else location.hash = st?.meta ? `#/t/${st.meta.topic_id}?th=${st.meta.thread_id}` : '#/mail';
}

export function viewAttachment(id, query = {}) {
  const n = +query.n || 0;
  const key = `att:${+id}:${n}`;
  if (!attFiles.has(key)) loadAttachment(key, +id, n);
  const st = attFiles.get(key);
  const { meta, att } = st;
  const d = st.status === 'ready' && { id: key, filename: att.name, mime: att.type || st.blob.type, size: st.blob.size, src: st.url, blob: st.blob };
  const canSave = S.data.mailExt && can('documenti', 'write') && att?.part;
  return h('div.view.docview.attview',
    h('div.head',
      h('button.icon-btn', { title: tr('Back to the mail (Esc)'), onclick: attachmentBack }, icon('back')),
      h('h2.dv-title', att?.name || tr('Attachment')),
      meta && h('span.muted.att-from', `${tr('from {name}', { name: fromName(meta.from_addr) })} · ${meta.subject || tr('(no subject)')} · ${fmtTime(meta.date)}`),
      h('span.grow'),
      d && h('span.muted', fmtSize(d.size)),
      canSave && h('button.btn.sm', { title: tr('Save as a document of an inventory item'), onclick: () => saveToItem(att, +id, n) }, icon('box'), tr('→ inventory')),
      d && h('a.icon-btn', { href: d.src, download: att.name || 'attachment', title: tr('Download') }, icon('download'))),
    st.status === 'loading' ? h('div.empty', icon('wait'), h('p', tr('Asking Thunderbird for the file…')))
      : st.status === 'error' ? h('div.empty', h('p', st.error),
        h('button.btn', { onclick: () => { attFiles.delete(key); render(); } }, tr('Try again')))
        : kindOf(d) === 'none' ? h('div.empty', h('p', tr('No preview for this kind of file.')),
          h('a.btn', { href: d.src, download: att.name || 'attachment' }, icon('download'), tr('Download {name}', { name: att.name })))
          : previewBody(d));
}
