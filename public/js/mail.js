// Mail: composer (destinatari, oggetto, testo e invio verso il client di posta) e i blocchi della colonna
// laterale che legano la posta al resto di Organizer (persone, allegati in entrambi i versi, collegamenti, chi
// la cita). Pagina Mail e topic: topics.js.
// Con l'estensione di Thunderbird collegata (server/thunderbird.js) "Manda" apre la mail lì, lo stato si
// aggiorna da solo e i messaggi ricevuti e mandati finiscono nel loro thread.
import {
  h, icon, S, ui, api, act, toast, render, patchEntry, fmtSize, fmtTime, plainRefs, richField, contactStyle, contactNames, can, itemAttrs, docName,
} from './core.js';
import { backlinksBox } from './views.js';
import { pickDoc, pickItem } from './pickers.js';
import { kindOf, previewBody } from './docview.js';

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
    if (ui.richEdit === `body-${e.id}`) {
      ui.richEdit = null;
      render();
    }
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
    toast(err.message, { err: true });
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
      // mousedown senza effetto: il testo resta in modifica e non si ridisegna (spostando il tasto) prima del clic;
      // send legge i campi così come sono.
      h('button.btn.primary', { onmousedown: ev => ev.preventDefault(), onclick: () => send(e) }, icon('send'), S.data.mailExt || ui.mailHelper ? 'Manda con Thunderbird' : 'Manda'),
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
export const lc = s => String(s || '').toLowerCase();
// "Nome <email>, …" → "email, …" (così i contatti in rubrica si riconoscono e si colorano).
export const addrs = s => String(s || '').split(',').map(a => (a.match(/<([^>]+)>/)?.[1] || a).trim()).filter(Boolean).join(', ');
// "Nome <email>" → { name, email }
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

// ---------- colonna laterale ----------
export const block = (title, ...children) => (children.flat(Infinity).some(Boolean) ? h('div.ms-b', h('div.ms-h', title), children) : null);

// Persone: quelle in rubrica con azienda e ruolo; le altre si aggiungono con un clic.
export function peopleBlock(list, title = 'Persone') {
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
        h('a', { href: `api/attachments/${a.id}/file`, title: 'Scarica' }, a.filename),
        a.size != null && h('span.muted', fmtSize(a.size)),
        doc && h('a.code', { href: `#/d/${doc.id}`, title: `Dal magazzino: ${docName(doc)}`, ...itemAttrs(it) }, it?.code || 'magazzino'),
        !e.done_at && h('button.icon-btn.sm', { title: 'Togli', onclick: () => act(() => api('DELETE', `/attachments/${a.id}`)) }, icon('x')));
    }),
    !e.done_at && h('div.ms-add',
      h('button.btn.sm', { onclick: () => fileInput.click() }, icon('clip'), 'Allega'),
      can('documenti') && h('button.btn.sm', {
        onclick: () => pickDoc({ onPick: d => act(() => api('POST', `/entries/${e.id}/attachments`, { doc_id: d.id }), `Allegato ${docName(d)}`) }),
      }, icon('box'), 'Dal magazzino…'),
      fileInput),
  ];
}

// Collegamenti in avanti: articoli (#codice) e [[…]] scritti nella mail.
export const REF_RE = /\[\[(doc|voce|contatto|progetto|mail|nota):(\d+)\]\]/g;
function linksBlock(itemIds, text) {
  const D = S.data;
  const items = [...new Set(itemIds)].map(id => D.itemById.get(id)).filter(Boolean);
  const refs = [...new Map([...String(text || '').matchAll(REF_RE)].map(m => [`${m[1]}:${m[2]}`, [m[1], +m[2]]])).values()].map(([kind, id]) => {
    if (kind === 'doc') { const d = D.docById.get(id); return d && h('a.ms-link', { href: `#/d/${id}` }, icon('file'), docName(d)); }
    if (kind === 'voce') { const x = D.entryById.get(id); return h('a.ms-link', { href: `#/v/${id}` }, icon('log'), x ? plainRefs(x.title) : `voce ${id}`); }
    if (kind === 'contatto') { const c = D.contactById.get(id); return c && h('a.ms-link', { href: `#/contatti/${id}` }, icon('user'), c.name || c.email); }
    if (kind === 'mail') { const t = D.threadById.get(id); return t && h('a.ms-link', { href: `#/t/${t.topic_id}?th=${id}` }, icon('mail'), t.subject); }
    if (kind === 'nota') { const n = D.docNoteById.get(id); return n && h('a.ms-link', { href: `#/d/${n.doc_id}?n=${id}` }, icon('log'), plainRefs(`[[nota:${id}]]`)); }
    const p = D.projectById?.get(id);
    return p && h('a.ms-link', { href: `#/p/${id}` }, '@', p.tag || p.name);
  }).filter(Boolean);
  return block('Collegamenti',
    items.length > 0 && h('div.item-chips', items.map(it => h('a.code', { href: `#/i/${it.id}`, ...itemAttrs(it), title: it.name || it.code }, it.code))),
    refs);
}

export function mailSide(e) {
  const msgs = S.data.msgsOfThread.get(e.thread_id) || [];
  return [
    peopleBlock([e.contact, e.mail_cc, ...msgs.filter(m => m.direction === 'in').map(m => m.from_addr)]),
    (!e.done_at || S.data.attachmentsOf.has(e.id)) && block('Allegati', outAttachments(e)),
    linksBlock((S.data.itemsOfEntry.get(e.id) || []).map(x => x.item_id), `${e.title} ${e.notes || ''}`),
    backlinksBox('voce', e.id, { title: 'Citata in', compact: true }),
  ];
}

// ---------- allegati ricevuti: anteprima e magazzino ----------
// Con Thunderbird collegato, ogni allegato di una mail ricevuta si può vedere senza salvarlo (Anteprima, per i
// tipi che il visualizzatore dei documenti sa mostrare) e può diventare un documento di un articolo: si sceglie
// articolo e tipo in un modale e il file arriva dall'anteprima appena vista o da Thunderbird.
const canPreview = a => !!a.part && !['none', 'link'].includes(kindOf({ filename: a.name, mime: a.type }));
const previewHash = (msgId, n) => `#/allegato/${msgId}?n=${n}`;

function saveToItem(a, msgId, n) {
  pickItem({
    file: a,
    onPick: (it, kind) => act(async () => {
      const r = await api('POST', '/mail/attachments/save', { id: msgId, n, item_id: it.id, kind });
      toast(r.saved ? `${a.name} salvato tra i documenti di ${it.code}` : `Chiesto a Thunderbird: ${a.name} comparirà tra i documenti di ${it.code}`);
    }),
  });
}

export function attList(list, msgId) {
  if (!list?.length) return null;
  const canSave = S.data.mailExt && can('documenti', 'write');
  return h('div.att-in', list.map((a, n) => {
    const preview = canPreview(a);
    // Dall'anteprima "indietro" torna qui, alla mail da cui si è aperta.
    const open = { href: previewHash(msgId, n), onclick: () => { ui.attFrom = location.hash; } };
    return h('div.ms-att', icon('clip'),
      preview ? h('a', { ...open, title: 'Anteprima' }, a.name ?? a) : h('span', a.name ?? a),
      a.size && h('span.muted', fmtSize(a.size)),
      preview && h('a.chip', { ...open, title: 'Guarda il file senza salvarlo' }, icon('file'), 'anteprima'),
      canSave && a.part && h('button.chip', { title: 'Salva come documento di un articolo del magazzino', onclick: () => saveToItem(a, msgId, n) },
        icon('box'), '→ magazzino'));
  }));
}

// La pagina dell'anteprima (#/allegato/messaggio?n=indice). Il file si scarica una volta (il server lo chiede a
// Thunderbird, che può metterci qualche secondo) e resta in memoria finché la pagina è aperta.
const attFiles = new Map(); // "att:messaggio:n" → { status, meta, att, url, error }

async function loadAttachment(key, msgId, n) {
  const st = { status: 'loading' };
  attFiles.set(key, st);
  try {
    st.meta = await api('GET', `/mail/messages/${msgId}`);
    st.att = st.meta.attachments[n];
    if (!st.att) throw new Error('Allegato inesistente');
    render();
    const r = await fetch(`api/mail/messages/${msgId}/attachments/${n}`, { credentials: 'same-origin' })
      .catch(() => { throw new Error('Connessione interrotta: riprova'); });
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || `Errore ${r.status}`);
    const blob = await r.blob();
    if (attFiles.get(key) !== st) return; // pagina già chiusa
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

// Indietro: alla mail da cui si è aperta l'anteprima (o alla sua conversazione, se si è arrivati da un link).
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
      h('button.icon-btn', { title: 'Torna alla mail (Esc)', onclick: attachmentBack }, icon('back')),
      h('h2.dv-title', att?.name || 'Allegato'),
      meta && h('span.muted.att-from', `da ${fromName(meta.from_addr)} · ${meta.subject || '(senza oggetto)'} · ${fmtTime(meta.date)}`),
      h('span.grow'),
      d && h('span.muted', fmtSize(d.size)),
      canSave && h('button.btn.sm', { title: 'Salva come documento di un articolo del magazzino', onclick: () => saveToItem(att, +id, n) }, icon('box'), '→ magazzino'),
      d && h('a.icon-btn', { href: d.src, download: att.name || 'allegato', title: 'Scarica' }, icon('download'))),
    st.status === 'loading' ? h('div.empty', icon('wait'), h('p', 'Chiedo il file a Thunderbird…'))
      : st.status === 'error' ? h('div.empty', h('p', st.error),
        h('button.btn', { onclick: () => { attFiles.delete(key); render(); } }, 'Riprova'))
        : kindOf(d) === 'none' ? h('div.empty', h('p', 'Anteprima non disponibile per questo tipo di file.'),
          h('a.btn', { href: d.src, download: att.name || 'allegato' }, icon('download'), `Scarica ${att.name}`))
          : previewBody(d));
}
