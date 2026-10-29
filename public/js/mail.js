// Mail: composer (destinatari, oggetto, testo e invio verso il client di posta), thread (schede della pagina
// Mail e pagina #/t/ID) e la colonna laterale con quello che lega la posta al resto di Organizer (persone,
// allegati in entrambi i versi, collegamenti, chi la cita).
// Con l'estensione di Thunderbird collegata (server/thunderbird.js) "Manda" apre la mail lì, lo stato si
// aggiorna da solo e i messaggi ricevuti e mandati finiscono nel loro thread.
import {
  h, icon, S, ui, api, act, render, toast, patchEntry, fmtSize, fmtTime, fmtDay, plainRefs, richField, contactStyle, contactNames,
  can, kindPicker, itemAttrs, docName, projectsOf, projHue, trashIt, popButton, popItem,
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

// ---------- thread ----------
// Un thread raccoglie i messaggi (ricevuti e mandati, anche quelli vecchi tirati dentro da Thunderbird) e le
// mail scritte in Organizer. Nei dati sincronizzati c'è l'inizio di ogni messaggio; il testo intero e gli
// allegati si leggono dal server quando si apre il thread.
const full = new Map(); // id del thread → { key, data }

function fullThread(t) {
  const D = S.data;
  const key = [...(D.msgsOfThread.get(t.id) || []).map(m => m.id), '|', ...(D.entriesOfThread.get(t.id) || []).map(e => e.id)].join(',');
  let f = full.get(t.id);
  if (!f || f.key !== key) {
    full.set(t.id, (f = { key, data: f?.data || null }));
    api('GET', `/mail/threads/${t.id}`).then(data => { if (full.get(t.id) === f) { f.data = data; render(); } }).catch(() => {});
  }
  return f.data;
}

// Il riassunto di un thread per la pagina Mail, i badge e i backlink.
export function threadInfo(t) {
  const D = S.data;
  const msgs = D.msgsOfThread.get(t.id) || [];
  const ents = D.entriesOfThread.get(t.id) || [];
  const people = [];
  for (const m of msgs) people.push(m.direction === 'in' ? m.from_addr : m.to_addr);
  for (const e of ents) people.push(e.contact || '');
  const seen = new Set();
  const who = addrList(people.join(',')).filter(a => !D.mine.has(lc(a.email)) && !seen.has(lc(a.email)) && seen.add(lc(a.email)));
  const links = D.linksOfThread.get(t.id) || [];
  const projects = new Map();
  for (const l of links) if (l.kind === 'progetto' && D.projectById.has(l.target_id)) projects.set(l.target_id, D.projectById.get(l.target_id));
  for (const e of ents) for (const p of projectsOf(e)) projects.set(p.id, p);
  return {
    t, msgs, ents, who,
    unread: msgs.filter(m => m.direction === 'in' && !m.read_at).length,
    drafts: ents.filter(e => !e.done_at),
    waiting: ents.filter(e => e.done_at && e.awaiting_reply),
    att: msgs.some(m => m.has_att) || ents.some(e => D.attachmentsOf.has(e.id)),
    items: [...new Set(links.filter(l => l.kind === 'articolo').map(l => l.target_id))].map(id => D.itemById.get(id)).filter(Boolean),
    projects: [...projects.values()],
    last: msgs.at(-1),
  };
}

// L'oggetto del thread da mostrare: i [[…]] con il nome, i #codici senza # (come nella mail mandata).
export const threadSubject = t => plainRefs(t.subject).replace(/(^|\s)#/g, '$1') || '(senza oggetto)';

const whoNames = who => who.slice(0, 3).map(a => { const c = S.data.contactByEmail.get(lc(a.email)); return c?.name || a.name || a.email; }).join(', ')
  + (who.length > 3 ? ` +${who.length - 3}` : '');

export function archiveThread(t, archived) {
  t.archived_at = archived ? new Date().toISOString() : null;
  if (archived) for (const m of S.data.msgsOfThread.get(t.id) || []) m.read_at ||= t.archived_at;
  render();
  act(() => api('PATCH', `/mail/threads/${t.id}`, { archived }));
  toast(archived ? 'Thread archiviato' : 'Thread di nuovo tra gli attivi', { action: { label: 'Annulla', fn: () => archiveThread(t, !archived) } });
}

// Rinomina (vuoto = lascia com'è) ed Elimina (nel cestino, con le mail scritte in Organizer che ne fanno parte).
export function renameThread(t) {
  const name = prompt('Nuovo nome del thread:', threadSubject(t));
  if (!name?.trim()) return;
  t.subject = name.trim();
  render();
  act(() => api('PATCH', `/mail/threads/${t.id}`, { subject: t.subject }));
}

export async function deleteThread(t) {
  const n = (S.data.entriesOfThread.get(t.id) || []).length;
  const ok = await trashIt('thread', `/mail/threads/${t.id}`, n ? 'Thread (con le sue mail)' : 'Thread');
  if (ok && location.hash === `#/t/${t.id}`) location.hash = '#/mail';
}

const threadMenu = t => popButton(`thread:${t.id}`, '⋯', close => [
  popItem([icon('edit'), 'Rinomina'], () => { close(); renameThread(t); }),
  popItem([icon('trash'), 'Elimina'], () => { close(); deleteThread(t); }),
], { class: 'tc-menu', title: 'Rinomina o elimina', 'aria-label': 'Rinomina o elimina' });

// La scheda di un thread nella pagina Mail: il tasto a sinistra lo archivia (e lo segna letto); aprirlo lo
// legge e basta, resta dov'è.
export function threadCard(x) {
  const { t } = x;
  const archived = !!t.archived_at;
  const snip = x.last ? newPart(x.last.snippet) : plainRefs(x.drafts[0]?.notes || '');
  const tag = p => h('span.tag', { style: `--h:${projHue(p)}` }, `@${p.tag}`);
  return h('div.tcard', { class: [x.unread && 'unread', archived && 'archived'].filter(Boolean).join(' ') },
    h('button.check.mail', {
      title: archived ? 'Rimetti tra gli attivi' : 'Archivia (lo segna anche letto)',
      onclick: () => archiveThread(t, !archived),
    }, icon(archived ? 'restore' : 'check')),
    h('a.tc-body', { href: `#/t/${t.id}` },
      h('div.tc-h', h('span.tc-subj', threadSubject(t)), h('span.muted.tc-date', fmtTime(t.last_at))),
      x.who.length > 0 && h('div.tc-who', icon('user'), whoNames(x.who)),
      snip && h('div.tc-snip', snip.replace(/\s+/g, ' ').slice(0, 220)),
      h('div.tc-meta',
        x.unread > 0 && h('span.tb.unread', x.unread === 1 ? 'da leggere' : `${x.unread} da leggere`),
        x.drafts.length > 0 && h('span.tb.draft', icon('edit'), x.drafts.length === 1 ? 'da mandare' : `${x.drafts.length} da mandare`),
        x.waiting.length > 0 && h('span.tb.wait', icon('wait'), 'in attesa'),
        x.msgs.length > 1 && h('span.muted', icon('mail'), x.msgs.length),
        x.att && h('span.muted', icon('clip')),
        x.projects.map(tag),
        x.items.slice(0, 4).map(it => h('span.code', itemAttrs(it), it.code)),
        x.items.length > 4 && h('span.muted', `+${x.items.length - 4}`))),
    threadMenu(t));
}

// Il testo nuovo di un messaggio, senza la citazione dei precedenti ("Il giorno … ha scritto:", righe con >).
function newPart(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const quote = /^(On|Il|Am|Le|El) .{4,300}(wrote|scritto|schrieb|écrit|escribió)\s*:\s*$|^-{2,}\s*(Original Message|Messaggio originale|Forwarded)|^>/i;
  const cut = lines.findIndex(l => quote.test(l.trim()));
  return (cut < 0 ? lines : lines.slice(0, cut)).join('\n').trim();
}

// Un messaggio del thread. Ai ricevuti si risponde (se non c'è già una bozza di risposta).
function threadMsg(m, replied) {
  const body = newPart(m.body);
  const more = m.body && body.length < m.body.trim().length;
  return h('div.tmsg', { class: m.direction, id: `msg-${m.id}` },
    h('div.tmsg-h',
      h('span.tmsg-dir', m.direction === 'in' ? '↙' : '↗'),
      h('span', { title: addrs(m.direction === 'in' ? m.from_addr : m.to_addr) },
        m.direction === 'in' ? h('b', fromName(m.from_addr)) : ['a ', contactNames(addrs(m.to_addr))]),
      m.cc && h('span.muted', 'cc ', contactNames(addrs(m.cc))),
      h('span.grow'),
      h('span.muted', fmtTime(m.date))),
    body ? h('div.tmsg-b', body) : !m.body && h('div.tmsg-b.muted', '(nessun testo)'),
    more && h('details', h('summary.muted', 'messaggio completo'), h('div.tmsg-b', m.body.trim())),
    m.attachments?.length > 0 && attList(m.attachments, 'message', m.id),
    m.direction === 'in' && !replied && replyButtons(m));
}

// Una mail mandata da Organizer senza il messaggio di Thunderbird (mandata con l'app mail o il .eml).
const sentEntryMsg = e => h('div.tmsg.out',
  h('div.tmsg-h', h('span.tmsg-dir', '↗'), h('span', 'a ', contactNames(e.contact || '')), h('span.grow'),
    h('a.muted', { href: `#/v/${e.id}` }, fmtTime(e.done_at))),
  e.notes && h('div.tmsg-b', plainRefs(e.notes)));

// Rispondi / Rispondi a tutti: la bozza nasce nel thread (si scrive qui, poi Manda la apre in Thunderbird).
const replyButtons = m => h('div.tmsg-a',
  [false, true].map(all => h('button.btn.sm', {
    onclick: () => act(async () => {
      await api('POST', `/mail/messages/${m.id}/reply`, { all });
      toast('Bozza di risposta pronta in fondo al thread');
    }),
  }, icon('send'), all ? 'Rispondi a tutti' : 'Rispondi')));

// Una bozza del thread: il composer con i suoi allegati.
function draftBox(e) {
  return h('div.tdraft', { id: `draft-${e.id}` },
    h('div.tdraft-h',
      h('span.kpill.k-mail', 'bozza'),
      h('a', { href: `#/v/${e.id}`, title: 'Apri come voce (data, progetti, condivisione…)' }, plainRefs(e.title)),
      e.due && h('span.muted', icon('cal'), fmtDay(e.due)),
      h('span.grow'),
      h('button.icon-btn.sm', { title: 'Elimina la bozza', onclick: () => trashIt('entry', `/entries/${e.id}`, 'Bozza') }, icon('trash'))),
    mailComposer(e),
    h('div.tdraft-att', outAttachments(e)));
}

// Letto il thread (aperto), i messaggi ricevuti diventano letti: il thread resta dov'è.
function markRead(x) {
  const unread = x.msgs.filter(m => m.direction === 'in' && !m.read_at);
  if (!unread.length) return;
  const at = new Date().toISOString();
  for (const m of unread) m.read_at = at;
  api('PATCH', `/mail/threads/${x.t.id}`, { read: true }).catch(() => {});
}

export function viewThread(id) {
  const D = S.data;
  const t = D.threadById.get(+id);
  if (!t) {
    return h('div.view', h('div.empty', h('p', h('b', 'Thread non trovato.')),
      h('p', 'Forse è di un altro workspace, o la posta non è tua: i thread sono personali.'), h('a', { href: '#/mail' }, 'Torna alla posta')));
  }
  const x = threadInfo(t);
  markRead(x);
  const data = fullThread(t);
  const repliedTo = new Set(x.drafts.map(e => e.reply_to).filter(Boolean));
  // Messaggi e mail mandate senza messaggio, in ordine; i più vecchi chiusi in un riassunto.
  const outIds = new Set((data?.messages || []).map(m => m.entry_id).filter(Boolean));
  const list = data ? [
    ...data.messages.map(m => ({ at: m.date, node: () => threadMsg(m, repliedTo.has(m.id)), m })),
    ...x.ents.filter(e => e.done_at && !outIds.has(e.id)).map(e => ({ at: e.done_at, node: () => sentEntryMsg(e) })),
  ].sort((a, b) => a.at.localeCompare(b.at)) : [];
  const hidden = ui.threadAll === t.id ? 0 : Math.max(0, list.length - 3);
  const received = (data?.messages || []).filter(m => m.direction === 'in');

  return h('div.view.threadpage',
    h('div.th-head',
      h('a.icon-btn', { href: '#/mail', title: 'Torna alla posta' }, icon('back')),
      h('h2.th-subj', { title: 'Rinomina', onclick: () => renameThread(t) }, threadSubject(t)),
      h('button.icon-btn', { title: 'Rinomina', 'aria-label': 'Rinomina', onclick: () => renameThread(t) }, icon('edit')),
      h('span.grow'),
      h('button.icon-btn', { title: 'Elimina (nel cestino)', 'aria-label': 'Elimina', onclick: () => deleteThread(t) }, icon('trash')),
      h('button.btn.sm', { onclick: () => archiveThread(t, !t.archived_at) },
        icon(t.archived_at ? 'restore' : 'check'), t.archived_at ? 'Rimetti tra gli attivi' : 'Archivia')),
    h('div.th-sub.muted',
      `${x.msgs.length} ${x.msgs.length === 1 ? 'messaggio' : 'messaggi'}`,
      x.who.length > 0 && [' · ', whoNames(x.who)],
      t.archived_at && ` · archiviato ${fmtTime(t.archived_at)}`),
    h('div.mail-cols',
      h('div.mail-main',
        !data && x.msgs.length > 0 && h('p.muted', 'Caricamento…'),
        hidden > 0 && h('button.tmsg-more', { onclick: () => { ui.threadAll = t.id; render(); } },
          `${hidden} ${hidden === 1 ? 'messaggio precedente' : 'messaggi precedenti'}`),
        list.slice(hidden).map(i => i.node()),
        x.drafts.map(draftBox),
        can('mail', 'write') && h('div.th-new',
          h('button.btn.sm.ghost', {
            onclick: () => act(async () => { await api('POST', `/mail/threads/${t.id}/draft`); toast('Nuova mail nel thread'); }),
          }, icon('plus'), 'Nuova mail nel thread'),
          x.unread === 0 && received.length > 0 && h('button.btn.sm.ghost', {
            onclick: () => { for (const m of x.msgs) if (m.direction === 'in') m.read_at = null; act(() => api('PATCH', `/mail/threads/${t.id}`, { read: false })); location.hash = '#/mail'; },
          }, icon('mail'), 'Segna da leggere'))),
      h('aside.mail-side',
        threadLinksBlock(t),
        peopleBlock([...x.msgs.flatMap(m => [m.from_addr, m.to_addr, m.cc]), ...x.ents.flatMap(e => [e.contact, e.mail_cc])].filter(Boolean)),
        // Riepilogo per i thread lunghi (con un messaggio solo gli allegati sono già lì sotto).
        list.length > 1 && block('Allegati ricevuti', received.filter(m => m.attachments.length).map(m => attList(m.attachments, 'message', m.id))))));
}

// Collegamenti del thread: scelti qui (si tolgono), trovati nei messaggi (codici) o citati nelle mail scritte.
const LINK_ICON = { articolo: 'box', doc: 'file', progetto: 'folder', contatto: 'user', voce: 'log' };
function linkTarget(kind, id) {
  const D = S.data;
  if (kind === 'articolo') { const it = D.itemById.get(id); return it && { href: `#/i/${id}`, label: it.code, sub: it.name, it }; }
  if (kind === 'doc') { const d = D.docById.get(id); return d && { href: `#/d/${id}`, label: docName(d), sub: D.itemById.get(d.item_id)?.code }; }
  if (kind === 'progetto') { const p = D.projectById.get(id); return p && { href: `#/p/${id}`, label: `@${p.tag}`, sub: p.name !== p.tag ? p.name : '' }; }
  if (kind === 'contatto') { const c = D.contactById.get(id); return c && { href: `#/contatti/${id}`, label: c.name || c.email, sub: c.company }; }
  const e = D.entryById.get(id);
  return e && { href: `#/v/${id}`, label: plainRefs(e.title), sub: e.kind };
}

async function addLinks(t, text) {
  const D = S.data;
  const want = [];
  for (const c of extractCodes(text)) { const it = D.itemByCode.get(c.toUpperCase()); if (it) want.push(['articolo', it.id]); }
  for (const m of text.matchAll(/(?:^|\s)@([\p{L}\d_.-]+)/gu)) { const p = D.projectByTag.get(m[1].toLowerCase()); if (p) want.push(['progetto', p.id]); }
  for (const m of text.matchAll(REF_RE)) want.push([m[1], +m[2]]);
  if (!want.length) return toast('Scrivi #codice, @progetto o [[ per scegliere cosa collegare', { err: true });
  for (const [kind, id] of want) await api('POST', `/mail/threads/${t.id}/links`, { kind, id });
}

function threadLinksBlock(t) {
  const links = S.data.linksOfThread.get(t.id) || [];
  const seen = new Map(); // un elemento una volta sola: se è anche scelto a mano, si può togliere
  for (const l of links) {
    const k = `${l.kind}:${l.target_id}`;
    if (!seen.has(k) || l.manual && !l.auto) seen.set(k, l);
  }
  const rows = [...seen.values()].map(l => ({ l, x: linkTarget(l.kind, l.target_id) })).filter(r => r.x)
    .sort((a, b) => Object.keys(LINK_ICON).indexOf(a.l.kind) - Object.keys(LINK_ICON).indexOf(b.l.kind));
  return h('div.ms-b',
    h('div.ms-h', 'Collegato a'),
    rows.map(({ l, x }) => h('div.tl-row',
      icon(LINK_ICON[l.kind]),
      h('a', { href: x.href, ...(x.it ? itemAttrs(x.it) : {}), class: x.it ? 'code' : null }, x.label),
      x.sub && h('span.muted', x.sub),
      h('span.grow'),
      l.manual && !l.auto
        ? h('button.icon-btn.sm', { title: 'Scollega', onclick: () => act(() => api('DELETE', `/mail/threads/${t.id}/links/${l.kind}/${l.target_id}`)) }, icon('x'))
        : h('span.muted.tl-auto', { title: l.manual ? 'Trovato nei messaggi' : 'Citato in una mail scritta qui' }, 'auto'))),
    !rows.length && h('p.muted', 'Collega il thread ad articoli, progetti, documenti, contatti o voci: lo ritrovi anche lì.'),
    h('input.sub-in', {
      placeholder: '+ #codice, @progetto, [[ altro', 'data-fk': `tlink-${t.id}`, 'data-ac': 'mail', 'data-ac-only': '#@', autocomplete: 'off', spellcheck: 'false',
      onkeydown: ev => {
        if (ev.key !== 'Enter' || ev.isComposing || document.querySelector('.ac:not([hidden])')) return;
        ev.preventDefault();
        const text = ev.target.value;
        if (!text.trim()) return;
        ev.target.value = '';
        act(() => addLinks(t, text));
      },
    }));
}

// Nell'editor di una mail scritta in Organizer: il thread di cui fa parte.
export function threadLink(e) {
  const t = e.thread_id && S.data.threadById.get(e.thread_id);
  if (!t) return null;
  const n = (S.data.msgsOfThread.get(t.id) || []).length;
  return h('a.thread-link', { href: `#/t/${t.id}` }, icon('mail'), h('b', 'Thread'), h('span', threadSubject(t)),
    h('span.muted', n ? `${n} ${n === 1 ? 'messaggio' : 'messaggi'}` : ''), h('span.grow'), '→');
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
  const msgs = S.data.msgsOfThread.get(e.thread_id) || [];
  return [
    peopleBlock([e.contact, e.mail_cc, ...msgs.filter(m => m.direction === 'in').map(m => m.from_addr)]),
    (!e.done_at || S.data.attachmentsOf.has(e.id)) && block('Allegati', outAttachments(e)),
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
