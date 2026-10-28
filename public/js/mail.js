// Mail: composer (destinatari, oggetto, testo e invio verso il client di posta), conversazione, posta in arrivo
// e la colonna laterale con quello che lega la mail al resto di Organizer (persone, allegati in entrambi i
// versi, articoli e collegamenti, chi la cita).
// Con l'estensione di Thunderbird collegata (server/thunderbird.js) "Manda" apre la mail lì, lo stato si
// aggiorna da solo e le risposte arrivate formano la conversazione (mailThread).
import {
  h, icon, S, ui, api, act, render, toast, patchEntry, fmtSize, fmtTime, plainRefs, richField, contactStyle, contactNames,
  can, kindPicker, itemAttrs, docName,
} from './core.js';
import { extractCodes } from './parse.js';
import { backlinksBox } from './views.js';

const subjectOf = e => plainRefs(e.mail_subject || e.title.replace(/(^|\s)#/g, '$1'));

export function mailto(e) {
  const to = String(e.contact || '').split(',').map(s => s.trim()).filter(a => /^[^\s@]+@[^\s@]+$/.test(a)).join(',');
  const q = [`subject=${encodeURIComponent(subjectOf(e))}`];
  if (e.mail_cc) q.push(`cc=${encodeURIComponent(e.mail_cc)}`);
  if (e.notes) q.push(`body=${encodeURIComponent(plainRefs(e.notes))}`);
  return `mailto:${to}?${q.join('&')}`;
}

// I campi salvano su blur: prima di inviare si salva quello che c'è a schermo, anche se il focus è ancora lì.
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
    if (S.data.mailExt) {
      await api('POST', `/entries/${e.id}/compose`);
      toast('Aperta in Thunderbird: quando la invii, qui diventa "mandata" da sola');
      return;
    }
    const atts = S.data.attachmentsOf.get(e.id) || [];
    if (!ui.mailHelper) {
      location.href = mailto(e);
      if (atts.length) toast('Allegati non inclusi: installa l\'helper Thunderbird (Impostazioni → Mail) o usa .eml', { err: true });
      return;
    }
    const { token } = await api('POST', `/entries/${e.id}/send`);
    const server = location.href.split('#')[0].replace(/[^/]*$/, '');
    location.href = `organizer-mail://open?server=${encodeURIComponent(server)}&token=${token}`;
    toast('Mail aperta in Thunderbird', { action: { label: 'Segna inviata', fn: () => patchEntry(e, { done: true }) } });
  } catch (err) {
    toast(err.offline ? 'Sei offline' : err.message, { err: true });
  }
}

async function upload(e, files) {
  for (const f of files) {
    toast(`Allego ${f.name}…`);
    await act(() => api('POST', `/entries/${e.id}/attachments?${new URLSearchParams({ name: f.name })}`, f));
  }
}

// La mail da scrivere. Gli allegati si gestiscono nella colonna laterale, ma si possono trascinare anche qui.
export function mailComposer(e) {
  const saveField = key => ev => { if (ev.target.value !== (e[key] || '')) patchEntry(e, { [key]: ev.target.value }); };
  const box = h('div.mail',
    h('label.mf', h('span', 'A'),
      h('input', { value: e.contact || '', placeholder: 'email o nome dalla rubrica, separati da virgola', 'data-fk': `to-${e.id}`, 'data-ac': 'email', autocomplete: 'off', spellcheck: 'false', onblur: saveField('contact') })),
    h('label.mf', h('span', 'Cc'),
      h('input', { value: e.mail_cc || '', 'data-fk': `cc-${e.id}`, 'data-ac': 'email', autocomplete: 'off', spellcheck: 'false', onblur: saveField('mail_cc') })),
    h('label.mf', h('span', 'Oggetto'),
      h('input', { value: e.mail_subject || '', placeholder: subjectOf({ ...e, mail_subject: null }), 'data-fk': `subj-${e.id}`, onblur: saveField('mail_subject') })),
    // #articolo suggerisce dal magazzino e scrive il codice senza # (la mail va a chi non usa l'app);
    // [[ collega documenti, voci, contatti e progetti: nella mail mandata diventano il loro nome.
    // Nel testo letto i codici senza # sono colorati come gli altri (bare).
    richField({
      fk: `body-${e.id}`, cls: 'mail-body', rows: 6, value: e.notes, bare: true,
      placeholder: 'Testo della mail… (#codice per un articolo, [[ per collegare altro)',
      attrs: { 'data-ac': 'mail', 'data-ac-only': '#', 'data-ac-bare': '', 'data-ac-entry': e.id },
      onSave: notes => patchEntry(e, { notes }),
    }),
    h('div.mail-actions',
      h('button.btn.primary', { onclick: () => send(e) }, icon('send'), S.data.mailExt || ui.mailHelper ? 'Manda con Thunderbird' : 'Manda'),
      h('a.btn.sm.ghost', { href: mailto(e), title: 'Apre l\'app mail predefinita, senza allegati' }, 'App mail'),
      h('a.btn.sm.ghost', { href: `api/entries/${e.id}/eml`, download: '', title: 'File .eml con allegati' }, icon('download'), '.eml')));

  box.addEventListener('dragover', ev => { ev.preventDefault(); box.classList.add('drag'); });
  box.addEventListener('dragleave', () => box.classList.remove('drag'));
  box.addEventListener('drop', ev => {
    ev.preventDefault();
    box.classList.remove('drag');
    if (ev.dataTransfer.files.length) upload(e, [...ev.dataTransfer.files]);
  });
  return box;
}

// ---------- indirizzi ----------
const lc = s => String(s || '').toLowerCase();
// "Nome <email>, …" → "email, …" (così i contatti in rubrica si riconoscono e si colorano).
const addrs = s => String(s || '').split(',').map(a => (a.match(/<([^>]+)>/)?.[1] || a).trim()).filter(Boolean).join(', ');
// "Nome <email>" → { name, email }
export const parseAddr = a => {
  const email = (String(a).match(/<([^>]+)>/)?.[1] || String(a)).trim();
  return { email, name: String(a).replace(/<[^>]*>/, '').replace(/["']/g, '').trim().replace(email, '').trim() };
};
export const addrList = s => String(s || '').split(',').map(parseAddr).filter(a => a.email.includes('@'));

function fromName(addr) {
  const email = addrs(addr);
  if (S.data.contactByEmail.get(lc(email))) return contactNames(email);
  return parseAddr(addr).name || email;
}

// ---------- conversazione ----------
// I messaggi della conversazione (mandati e risposte arrivate) si leggono dal server quando cambiano: nei dati
// sincronizzati c'è solo l'elenco, senza il testo.
const threads = new Map(); // prima mail della conversazione → { key, list }

// Il testo nuovo di un messaggio, senza la citazione dei precedenti ("Il giorno … ha scritto:", righe con >).
function newPart(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const quote = /^(On|Il|Am|Le|El) .{4,300}(wrote|scritto|schrieb|écrit|escribió)\s*:\s*$|^-{2,}\s*(Original Message|Messaggio originale|Forwarded)|^>/i;
  const cut = lines.findIndex(l => quote.test(l.trim()));
  return (cut < 0 ? lines : lines.slice(0, cut)).join('\n').trim();
}

// e: la mail aperta; nella bozza di una risposta il messaggio a cui risponde non ripropone "Rispondi".
function threadMsg(m, e) {
  const body = newPart(m.body);
  const more = m.body && body.length < m.body.trim().length;
  return h('div.tmsg', { class: m.direction },
    h('div.tmsg-h',
      h('span.tmsg-dir', m.direction === 'in' ? '↙ ricevuta' : '↗ mandata'),
      h('span', m.direction === 'in' ? fromName(m.from_addr) : ['a ', contactNames(addrs(m.to_addr))]),
      h('span.grow'),
      h('span.muted', fmtTime(m.date))),
    body && h('div.tmsg-b', body),
    more && h('details', h('summary.muted', 'messaggio completo'), h('div.tmsg-b', m.body.trim())),
    m.attachments.length > 0 && h('div.muted', icon('clip'), ` ${m.attachments.map(a => a.name ?? a).join(', ')}`),
    m.direction === 'in' && !(m.id === e.reply_to && !e.done_at) && replyButtons(() => `/mail/messages/${m.id}/reply`));
}

// Rispondi / Rispondi a tutti: la risposta nasce in Organizer (si scrive lì, poi Manda la apre in Thunderbird).
const replyButtons = path => h('div.tmsg-a',
  [false, true].map(all => h('button.btn.sm', {
    onclick: () => act(async () => {
      const r = await api('POST', path(all), { all });
      location.hash = `#/v/${r.id}`;
    }),
  }, icon('send'), all ? 'Rispondi a tutti' : 'Rispondi')));

function threadOf(e) {
  const D = S.data;
  const root = e.mail_thread ?? e.id;
  const msgs = D.mailMsgs.filter(m => { const x = D.entryById.get(m.entry_id); return x && (x.id === root || x.mail_thread === root); });
  if (!msgs.length) return null;
  const key = msgs.map(m => m.id).join(',');
  let t = threads.get(root);
  if (!t || t.key !== key) {
    threads.set(root, (t = { key, list: null, msgs }));
    api('GET', `/entries/${e.id}/thread`).then(list => { t.list = list; render(); }).catch(() => {});
  }
  return t;
}

export function mailThread(e) {
  const t = threadOf(e);
  if (!t) return null;
  const replies = t.msgs.filter(m => m.direction === 'in').length;
  return h('div.thread',
    h('div.thread-h', icon('mail'), h('b', 'Conversazione'),
      h('span.muted', `${t.msgs.length} ${t.msgs.length === 1 ? 'messaggio' : 'messaggi'}${replies ? `, ${replies} ${replies === 1 ? 'ricevuto' : 'ricevuti'}` : ''}`)),
    t.list ? t.list.map(m => threadMsg(m, e)) : h('p.muted', 'Caricamento…'));
}

// ---------- colonna laterale ----------
const block = (title, ...children) => (children.flat(Infinity).some(Boolean) ? h('div.ms-b', h('div.ms-h', title), children) : null);

// Persone: quelle in rubrica con azienda e ruolo; le altre si aggiungono con un clic.
function peopleBlock(list, title = 'Persone') {
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
        title: 'Aggiungi alla rubrica',
        onclick: () => act(() => api('POST', '/contacts', { email: a.email, name: a.name }), 'Aggiunto ai contatti'),
      }, icon('plus'), 'rubrica'));
  });
  return block(title, rows);
}

// Allegati della mail che si manda: file caricati o documenti presi dal magazzino.
function outAttachments(e) {
  const D = S.data;
  const atts = D.attachmentsOf.get(e.id) || [];
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: ev => { const f = [...ev.target.files]; ev.target.value = ''; upload(e, f); } });
  const docs = D.docs.filter(d => !d.url && D.itemById.has(d.item_id));
  return [
    atts.map(a => {
      const doc = a.doc_id && D.docById.get(a.doc_id);
      const it = doc && D.itemById.get(doc.item_id);
      return h('div.ms-att',
        icon('clip'),
        h('a', { href: `api/attachments/${a.id}/file`, title: 'Scarica' }, a.filename),
        a.size != null && h('span.muted', fmtSize(a.size)),
        doc && h('a.code', { href: `#/d/${doc.id}`, title: `Dal magazzino: ${docName(doc)}`, ...itemAttrs(it) }, it?.code || 'magazzino'),
        !e.done_at && h('button.icon-btn.sm', { title: 'Togli', onclick: () => act(() => api('DELETE', `/attachments/${a.id}`)) }, icon('x')));
    }),
    !e.done_at && h('div.ms-add',
      h('button.btn.sm', { onclick: () => fileInput.click() }, icon('clip'), 'Allega'),
      docs.length > 0 && h('select.sm', {
        onchange: ev => { const id = +ev.target.value; ev.target.value = ''; if (id) act(() => api('POST', `/entries/${e.id}/attachments`, { doc_id: id })); },
      }, h('option', { value: '' }, '+ dal magazzino…'),
      docs.map(d => h('option', { value: d.id }, `${D.itemById.get(d.item_id).code} · ${d.label || d.filename}${d.version ? ` v${d.version}` : ''}`))),
      fileInput),
  ];
}

// Collegamenti in avanti: articoli (#codice) e [[…]] scritti nella mail.
const REF_RE = /\[\[(doc|voce|contatto|progetto):(\d+)\]\]/g;
function linksBlock(itemIds, text) {
  const D = S.data;
  const items = [...new Set(itemIds)].map(id => D.itemById.get(id)).filter(Boolean);
  const refs = [...new Map([...String(text || '').matchAll(REF_RE)].map(m => [`${m[1]}:${m[2]}`, [m[1], +m[2]]])).values()].map(([kind, id]) => {
    if (kind === 'doc') { const d = D.docById.get(id); return d && h('a.ms-link', { href: `#/d/${id}` }, icon('file'), docName(d)); }
    if (kind === 'voce') { const x = D.entryById.get(id); return h('a.ms-link', { href: `#/v/${id}` }, icon('log'), x ? plainRefs(x.title) : `voce ${id}`); }
    if (kind === 'contatto') { const c = D.contactById.get(id); return c && h('a.ms-link', { href: `#/contatti/${id}` }, icon('user'), c.name || c.email); }
    const p = D.projectById?.get(id);
    return p && h('a.ms-link', { href: `#/p/${id}` }, '@', p.tag || p.name);
  }).filter(Boolean);
  return block('Collegamenti',
    items.length > 0 && h('div.item-chips', items.map(it => h('a.code', { href: `#/i/${it.id}`, ...itemAttrs(it), title: it.name || it.code }, it.code))),
    refs);
}

export function mailSide(e) {
  const t = threadOf(e);
  const received = (t?.list || []).filter(m => m.direction === 'in' && m.attachments.length);
  return [
    peopleBlock([e.contact, e.mail_cc, ...(t?.list || []).filter(m => m.direction === 'in').map(m => m.from_addr)]),
    block('Allegati',
      (!e.done_at || S.data.attachmentsOf.has(e.id)) && [h('div.ms-sub', e.done_at ? 'Mandati' : 'Da mandare'), outAttachments(e)],
      received.length > 0 && [h('div.ms-sub', 'Ricevuti'), received.map(m => attList(m.attachments, 'message', m.id))]),
    linksBlock((S.data.itemsOfEntry.get(e.id) || []).map(x => x.item_id), `${e.title} ${e.notes || ''}`),
    backlinksBox('voce', e.id, { title: 'Citata in', compact: true }),
  ];
}

// ---------- allegati ricevuti → magazzino ----------
// Con Thunderbird collegato, un allegato di una mail ricevuta diventa un documento di un articolo: si sceglie
// codice e tipo, l'estensione prende il file da Thunderbird e lo carica (compare tra i documenti dell'articolo).
function attList(list, source, id) {
  if (!list?.length) return null;
  const canSave = S.data.mailExt && can('documenti', 'write');
  return h('div.att-in', list.map((a, n) => {
    const key = `${source}:${id}:${n}`;
    return h('div.ms-att', icon('clip'), h('span', a.name ?? a), a.size && h('span.muted', fmtSize(a.size)),
      canSave && a.part && (ui.attSave === key
        ? attForm(a, { source, id, n })
        : h('button.chip', { title: 'Salva come documento di un articolo del magazzino', onclick: () => { ui.attSave = key; ui.attKind = 'altro'; render(); } }, '→ magazzino')));
  }));
}

function attForm(a, ref) {
  const close = () => { ui.attSave = null; render(); };
  const save = raw => {
    const code = raw.trim().replace(/^#/, '');
    const it = S.data.itemByCode.get(code.toUpperCase());
    if (!it) return toast(code ? `L'articolo ${code} non esiste` : 'Scrivi il codice dell\'articolo', { err: true });
    ui.attSave = null;
    render();
    act(async () => {
      await api('POST', '/mail/attachments/save', { ...ref, item_id: it.id, kind: ui.attKind });
      toast(`Chiesto a Thunderbird: ${a.name} comparirà tra i documenti di ${it.code}`);
    });
  };
  return h('span.att-save',
    h('input.sub-in.mono', {
      placeholder: 'codice articolo', size: 12, 'data-ac': 'code', 'data-fk': `att-${ref.source}-${ref.id}-${ref.n}`, autocomplete: 'off', autocapitalize: 'characters',
      onkeydown: ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); save(ev.target.value); }
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
      },
    }),
    kindPicker(ui.attKind, k => { ui.attKind = k; render(); }),
    h('button.btn.sm.primary', { onclick: ev => save(ev.target.closest('.att-save').querySelector('input').value) }, 'Salva'),
    h('button.icon-btn.sm', { title: 'Annulla', onclick: close }, icon('x')));
}

// ---------- posta in arrivo ----------
// Le mail ricevute che l'estensione di Thunderbird passa a Organizer (solo di chi è collegato). Nei dati
// sincronizzati c'è l'inizio del testo; quello intero si legge quando si apre la mail. Aprirla la segna letta:
// resta tra le cose da fare finché non si lascia la pagina, poi passa in archivio.
const inboxFull = new Map(); // id → mail completa

window.addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#/mail')) ui.inboxKeep.clear();
});

function openInbox(m) {
  ui.inboxOpen = ui.inboxOpen === m.id ? null : m.id;
  if (ui.inboxOpen && !inboxFull.has(m.id)) {
    inboxFull.set(m.id, null);
    api('GET', `/mail/inbox/${m.id}`).then(full => { inboxFull.set(m.id, full); render(); }).catch(() => inboxFull.delete(m.id));
  }
  if (ui.inboxOpen && !m.read_at) {
    ui.inboxKeep.add(m.id);
    m.read_at = new Date().toISOString();
    act(() => api('PATCH', `/mail/inbox/${m.id}`, { read: true }));
  }
  render();
}

function setRead(m, read) {
  ui.inboxKeep.delete(m.id);
  if (ui.inboxOpen === m.id) ui.inboxOpen = null;
  m.read_at = read ? new Date().toISOString() : null;
  act(() => api('PATCH', `/mail/inbox/${m.id}`, { read }));
  toast(read ? 'Letta: in archivio' : 'Di nuovo da leggere');
}

function inboxDetail(m, thread) {
  const D = S.data;
  const full = inboxFull.get(m.id);
  const body = full ? newPart(full.body) : newPart(m.snippet);
  const more = full && full.body && body.length < full.body.trim().length;
  const codes = extractCodes(`${m.subject} ${full?.body || m.snippet}`).map(c => D.itemByCode.get(c.toUpperCase())).filter(Boolean);
  return h('div.mail-cols',
    h('div.mail-main',
      h('div.in-h',
        h('div', h('span.muted', 'Da '), fromName(m.from_addr), h('span.muted.mono', ` ${addrs(m.from_addr)}`)),
        h('div', h('span.muted', 'A '), contactNames(addrs(m.to_addr)), m.cc && [h('span.muted', ' · Cc '), contactNames(addrs(m.cc))]),
        h('div.muted', fmtTime(m.date))),
      h('div.tmsg-b.in-body', body || (full ? '(nessun testo)' : 'Caricamento…')),
      more && h('details', h('summary.muted', 'messaggio completo'), h('div.tmsg-b', full.body.trim())),
      h('div.inbox-a', replyButtons(() => `/mail/inbox/${m.id}/reply`))),
    h('aside.mail-side',
      peopleBlock([m.from_addr, m.to_addr, m.cc]),
      block('Allegati', full ? attList(full.attachments, 'inbox', m.id) : m.has_att && h('p.muted', 'Caricamento…')),
      linksBlock(codes.map(it => it.id), ''),
      block('Organizer',
        thread && h('a.ms-link', { href: `#/v/${thread.id}` }, icon('mail'), 'Conversazione: ', plainRefs(thread.title)),
        h('div.ms-add',
          h('button.btn.sm.ghost', { onclick: () => setRead(m, !m.read_at) }, icon(m.read_at ? 'mail' : 'check'), m.read_at ? 'Segna da leggere' : 'Segna letta'),
          h('button.btn.sm.ghost', {
            title: 'Toglie la mail da Organizer (in Thunderbird resta)',
            onclick: () => act(() => api('PATCH', `/mail/inbox/${m.id}`, { archived: true }), 'Tolta da Organizer'),
          }, icon('trash'), 'Togli')))));
}

// Una mail ricevuta, con la stessa grafica delle mail di Organizer: il tasto a sinistra la segna letta (archivio).
export function inboxRow(m) {
  const D = S.data;
  const open = ui.inboxOpen === m.id;
  const unread = !m.read_at;
  const thread = m.thread_ws === D.workspace.id && D.entryById.get(m.thread_entry);
  const meta = [
    h('span.contact', { title: addrs(m.from_addr) }, '← ', fromName(m.from_addr)),
    h('span.muted', `ricevuta ${fmtTime(m.date)}`),
    m.has_att ? h('span.atts-n', icon('clip')) : null,
    thread && h('span.replies', { title: 'Fa parte di una conversazione di Organizer' }, '↩'),
    !open && m.snippet && h('span.in-snip', newPart(m.snippet).replace(/\s+/g, ' ')),
  ];
  return h('div.entry.k-mail.inmail', { class: [unread && 'unread', open && 'open'].filter(Boolean).join(' ') },
    h('div.row',
      h('button.check.mail', { title: unread ? 'Segna come letta: va in archivio' : 'Segna come da leggere', onclick: () => setRead(m, unread) },
        icon(unread ? 'mail' : 'check')),
      h('div.body', { onclick: () => openInbox(m) },
        h('div.title', h('span.kpill.k-mail', 'ricevuta'), m.subject || '(senza oggetto)'),
        h('div.meta', meta))),
    open && h('div.editor.mail-ed', inboxDetail(m, thread)));
}
