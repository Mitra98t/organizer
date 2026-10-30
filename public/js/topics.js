// Posta a topic (vedi server/maildata.js). Tutto è personale: nessun altro vede la posta di una persona.
//  - pagina Mail: i topic come schede su più colonne, ognuna con le sue conversazioni (attive o archiviate).
//    Una conversazione si trascina su un altro topic per unirla, o su "topic a sé" per separarla;
//  - pagina del topic (#/t/ID?th=thread): a sinistra l'albero (conversazioni e loro mail, come un forum), al
//    centro la mail scelta (o la bozza da scrivere), a destra collegamenti, persone e allegati della conversazione.
// Topic e conversazioni hanno stella e colore (automatico finché non se ne sceglie uno).
import {
  h, icon, S, ui, api, act, render, toast, save, fmtTime, fmtDay, plainRefs, contactNames, can, itemAttrs, docName, projectsOf, projHue,
  trashIt, popButton, popItem, popSep, huePicker, masonry, filterChip, fold, foldBar,
} from './core.js';
import { draggable } from './dnd.js';
import { extractCodes } from './parse.js';
import { mailComposer, peopleBlock, outAttachments, attList, block, fromName, addrs, addrList, lc, REF_RE } from './mail.js';
import { backlinksBox } from './views.js';

// ---------- dati ----------
export const threadSubject = t => plainRefs(t.subject).replace(/(^|\s)#/g, '$1') || '(senza oggetto)';
export const topicTitle = t => plainRefs(t.title).replace(/(^|\s)#/g, '$1') || '(senza oggetto)';
// Colore automatico: sparso con l'angolo aureo, così topic e conversazioni vicini non si somigliano.
const autoHue = (id, shift = 0) => Math.round((id * 137.508 + shift) % 360);
export const topicHue = t => t.hue ?? autoHue(t.id);
export const threadHue = t => t.hue ?? autoHue(t.id, 70);
const parseRefs = m => { try { return JSON.parse(m.refs || '[]'); } catch { return []; } };

// Il riassunto di una conversazione: per le schede, i badge e i backlink.
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
  // Progetti della conversazione, del suo topic e delle mail scritte qui.
  for (const l of [...links, ...(D.linksOfTopic.get(t.topic_id) || [])]) if (l.kind === 'progetto' && D.projectById.has(l.target_id)) projects.set(l.target_id, D.projectById.get(l.target_id));
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

const whoNames = who => who.slice(0, 3).map(a => S.data.contactByEmail.get(lc(a.email))?.name || a.name || a.email).join(', ')
  + (who.length > 3 ? ` +${who.length - 3}` : '');

// Il testo nuovo di un messaggio, senza la citazione dei precedenti ("Il giorno … ha scritto:", righe con >).
function newPart(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const quote = /^(On|Il|Am|Le|El) .{4,300}(wrote|scritto|schrieb|écrit|escribió)\s*:\s*$|^-{2,}\s*(Original Message|Messaggio originale|Forwarded)|^>|^(From|Da):\s.+/i;
  const cut = lines.findIndex(l => quote.test(l.trim()));
  return (cut < 0 ? lines : lines.slice(0, cut)).join('\n').trim();
}

// ---------- azioni ----------
const patchThread = (t, f) => { Object.assign(t, f); render(); return act(() => api('PATCH', `/mail/threads/${t.id}`, f)); };
const patchTopic = (t, f) => { Object.assign(t, f); render(); return act(() => api('PATCH', `/mail/topics/${t.id}`, f)); };

export function archiveThread(t, archived) {
  const at = new Date().toISOString();
  t.archived_at = archived ? at : null;
  if (archived) for (const m of S.data.msgsOfThread.get(t.id) || []) m.read_at ||= at;
  render();
  act(() => api('PATCH', `/mail/threads/${t.id}`, { archived }));
  toast(archived ? 'Conversazione archiviata' : 'Conversazione di nuovo attiva', { action: { label: 'Annulla', fn: () => archiveThread(t, !archived) } });
}

function rename(label, current, fn) {
  const name = prompt(label, current);
  if (name?.trim()) fn(name.trim());
}

async function deleteThread(t) {
  const n = (S.data.entriesOfThread.get(t.id) || []).length;
  const alone = (S.data.threadsOfTopic.get(t.topic_id) || []).length === 1;
  const ok = await trashIt('thread', `/mail/threads/${t.id}`, n ? 'Conversazione (con le sue mail)' : 'Conversazione');
  if (ok && alone && location.hash.startsWith(`#/t/${t.topic_id}`)) location.hash = '#/mail';
}

async function deleteTopic(topic) {
  const n = (S.data.threadsOfTopic.get(topic.id) || []).length;
  if (n > 1 && !confirm(`Mettere nel cestino il topic e le sue ${n} conversazioni?`)) return;
  if (await act(() => api('DELETE', `/mail/topics/${topic.id}`).then(() => true))) {
    toast('Topic nel cestino: le conversazioni si ripristinano dal Cestino');
    if (location.hash.startsWith(`#/t/${topic.id}`)) location.hash = '#/mail';
  }
}

// Spostare una conversazione: in un altro topic (id) o in uno tutto suo ("new").
async function moveThread(t, to) {
  const D = S.data;
  const from = D.topicById.get(t.topic_id);
  const r = await act(() => api('PATCH', `/mail/threads/${t.id}`, { topic: to }));
  if (!r) return;
  const dest = to === 'new' ? 'un topic a sé' : `"${topicTitle(D.topicById.get(to) || { title: '' })}"`;
  toast(`Spostata in ${dest}`);
  if (location.hash.startsWith(`#/t/${from?.id}`) && !(D.threadsOfTopic.get(from.id) || []).some(x => x.id !== t.id)) location.hash = `#/t/${r.topic}?th=${t.id}`;
}

// Segnalino delle mail da leggere (in alto a destra di conversazioni e topic, come nel menu).
const unreadBadge = n => n > 0 && h('span.unread-n', { title: n === 1 ? '1 mail da leggere' : `${n} mail da leggere` }, n > 99 ? '99+' : n);

const star = (on, onclick, what) => h('button.star-btn', { class: on ? 'on' : null, title: on ? `Togli la stella (${what})` : `Metti la stella (${what})`, 'aria-pressed': on ? 'true' : 'false', onclick }, on ? '★' : '☆');

const huePop = (key, x, auto, onPick) => popButton(key, h('span.hue-dot', { style: `--h:${x.hue ?? auto}` }), close => [
  h('div.pop-sep', 'Colore'), huePicker(x.hue ?? null, auto, v => { close(); onPick(v); }),
], { class: 'hue-b', title: 'Colore' });

function threadMenu(t) {
  const D = S.data;
  const others = D.mailTopics.filter(x => x.id !== t.topic_id).map(x => ({ x, last: Math.max(...(D.threadsOfTopic.get(x.id) || []).map(y => Date.parse(y.last_at) || 0)) }))
    .sort((a, b) => b.last - a.last).slice(0, 10).map(o => o.x);
  const alone = (D.threadsOfTopic.get(t.topic_id) || []).length === 1;
  return popButton(`thread:${t.id}`, '⋯', close => [
    popItem([icon('edit'), 'Rinomina'], () => { close(); rename('Nome della conversazione:', threadSubject(t), subject => patchThread(t, { subject })); }),
    !alone && popItem([icon('folder'), 'Separa in un topic a sé'], () => { close(); moveThread(t, 'new'); }),
    others.length > 0 && popSep('Sposta nel topic'),
    others.map(x => popItem(topicTitle(x), () => { close(); moveThread(t, x.id); })),
    popSep(),
    popItem([icon('trash'), 'Elimina'], () => { close(); deleteThread(t); }),
  ], { class: 'tc-menu', title: 'Rinomina, sposta, elimina', 'aria-label': 'Rinomina, sposta, elimina' });
}

const topicMenu = topic => popButton(`topic:${topic.id}`, '⋯', close => [
  popItem([icon('edit'), 'Rinomina'], () => { close(); rename('Nome del topic:', topicTitle(topic), title => patchTopic(topic, { title })); }),
  popSep(),
  popItem([icon('trash'), 'Elimina il topic'], () => { close(); deleteTopic(topic); }),
], { class: 'tc-menu', title: 'Rinomina, elimina', 'aria-label': 'Rinomina, elimina' });

// ---------- pagina Mail ----------
const MAIL_STATES = [['star', '★ Con stella'], ['unread', 'Da leggere'], ['draft', 'Da mandare'], ['wait', 'In attesa di risposta']];
const STATE = {
  star: x => !!x.t.starred || !!S.data.topicById.get(x.t.topic_id)?.starred,
  unread: x => x.unread > 0,
  draft: x => x.drafts.length > 0,
  wait: x => x.waiting.length > 0,
};

// same: l'oggetto è già il titolo del topic (la scheda ha una conversazione sola): non si ripete.
function threadRow(x, same = false) {
  const { t } = x;
  const archived = !!t.archived_at;
  const snip = x.last ? newPart(x.last.snippet) : plainRefs(x.drafts[0]?.notes || '');
  return h('div.trow', { class: [x.unread && 'unread', archived && 'archived'].filter(Boolean).join(' '), 'data-th': t.id, style: `--h:${threadHue(t)}` },
    h('button.check.mail', { title: archived ? 'Di nuovo attiva' : 'Archivia (la segna anche letta)', onclick: () => archiveThread(t, !archived) },
      icon(archived ? 'restore' : 'check')),
    h('a.trow-body', { href: `#/t/${t.topic_id}?th=${t.id}` },
      h('div.trow-h', t.starred ? h('span.star-on', '★') : null,
        same ? h('span.trow-who', whoNames(x.who)) : h('span.trow-subj', threadSubject(t)), h('span.muted.trow-date', fmtTime(t.last_at)), unreadBadge(x.unread)),
      !same && x.who.length > 0 && h('div.trow-who', whoNames(x.who)),
      snip && h('div.trow-snip', snip.replace(/\s+/g, ' ').slice(0, 160)),
      h('div.tc-meta',
        x.drafts.length > 0 && h('span.tb.draft', icon('edit'), x.drafts.length === 1 ? 'da mandare' : `${x.drafts.length} da mandare`),
        x.waiting.length > 0 && h('span.tb.wait', icon('wait'), 'in attesa'),
        x.msgs.length > 1 && h('span.muted', icon('mail'), x.msgs.length),
        x.att && h('span.muted', icon('clip')),
        x.projects.map(p => h('span.tag', { style: `--h:${projHue(p)}` }, `@${p.tag}`)),
        x.items.slice(0, 3).map(it => h('span.code', itemAttrs(it), it.code)),
        x.items.length > 3 && h('span.muted', `+${x.items.length - 3}`))),
    threadMenu(t));
}

// Progetti collegati al topic intero.
const topicProjects = topic => (S.data.linksOfTopic.get(topic.id) || []).filter(l => l.kind === 'progetto')
  .map(l => S.data.projectById.get(l.target_id)).filter(Boolean);

function topicCard(topic, rows, total) {
  return fold('mail', topic.id, h('section.topic-card', { 'data-topic': topic.id, style: `--h:${topicHue(topic)}` },
    h('div.tp-h',
      star(!!topic.starred, () => patchTopic(topic, { starred: topic.starred ? 0 : 1 }), 'topic'),
      h('a.tp-title', { href: `#/t/${topic.id}` }, topicTitle(topic)),
      topicProjects(topic).length > 0 && h('span.tp-tags', topicProjects(topic).map(p => h('span.tag', { style: `--h:${projHue(p)}` }, `@${p.tag}`))),
      unreadBadge((S.data.threadsOfTopic.get(topic.id) || []).reduce((n, t) => n + (S.data.msgsOfThread.get(t.id) || []).filter(m => m.direction === 'in' && !m.read_at).length, 0)),
      // Il numero di conversazioni; con una sola si vede solo su telefono (serve a scheda chiusa).
      h(`span.muted.tp-n${total > 1 ? '' : '.only-mobile'}`, { title: `${total} ${total === 1 ? 'conversazione' : 'conversazioni'} in questo topic` }, `${total} conv.`),
      huePop(`thue:${topic.id}`, topic, autoHue(topic.id), v => patchTopic(topic, { hue: v })),
      topicMenu(topic)),
    rows.map(x => threadRow(x, total === 1 && threadSubject(x.t) === topicTitle(topic)))));
}

export function viewMail() {
  const D = S.data;
  const f = lc(ui.mailFilter.trim());
  const proj = ui.mailProj && D.projectById.get(ui.mailProj);
  const all = D.mailThreads.map(threadInfo);
  const has = x => !f || [x.t.subject, topicTitle(D.topicById.get(x.t.topic_id) || { title: '' }), ...x.msgs.flatMap(m => [m.from_addr, m.to_addr, m.cc, m.snippet]),
    ...x.ents.flatMap(e => [e.title, e.contact, e.mail_cc, e.notes]), ...x.who.map(a => D.contactByEmail.get(lc(a.email))?.name)].some(v => lc(v).includes(f));
  const view = ui.mailView === 'archive' ? 'archive' : 'active';
  const shown = all.filter(x => has(x) && (!ui.mailAtt || x.att) && (!proj || x.projects.some(p => p.id === proj.id)));
  const inView = v => shown.filter(x => !!x.t.archived_at === (v === 'archive'));
  const rows = inView(view).filter(x => !ui.mailType || STATE[ui.mailType](x));
  // Per topic: con stella prima, poi il più recente.
  const byTopic = new Map();
  for (const x of rows) {
    if (!byTopic.has(x.t.topic_id)) byTopic.set(x.t.topic_id, []);
    byTopic.get(x.t.topic_id).push(x);
  }
  const topics = [...byTopic].map(([id, list]) => ({ topic: D.topicById.get(id), list })).filter(o => o.topic)
    .map(o => ({ ...o, list: o.list.sort((a, b) => b.t.starred - a.t.starred || b.t.last_at.localeCompare(a.t.last_at)) }))
    .sort((a, b) => b.topic.starred - a.topic.starred || b.list[0].t.last_at.localeCompare(a.list[0].t.last_at));
  const setView = v => { ui.mailView = v; ui.mailType = null; save('org.mailView', v); render(); };
  const projects = [...new Map(all.flatMap(x => x.projects).map(p => [p.id, p])).values()].sort((a, b) => a.tag.localeCompare(b.tag));
  const filtered = !!(f || ui.mailAtt || proj || ui.mailType);
  // Mail condivise da altri: i thread sono personali, di queste non ho la conversazione.
  const shared = D.entries.filter(e => e.kind === 'mail' && e.created_by !== D.me.id && !D.threadById.has(e.thread_id)
    && (view === 'archive') === !!(e.done_at && !e.awaiting_reply) && (!f || [e.title, e.contact, e.notes].some(v => lc(v).includes(f))));
  const nTopics = v => new Set(inView(v).map(x => x.t.topic_id)).size;

  return h('div.view.mailpage',
    h('div.toolbar',
      h('input.filter', {
        type: 'search', placeholder: 'Filtra per oggetto, persona, indirizzo, testo…', value: ui.mailFilter, 'data-fk': 'mailfilter',
        oninput: ev => { ui.mailFilter = ev.target.value; render(); },
      }),
      h('div.seg',
        h('button', { class: view === 'active' && 'on', onclick: () => setView('active'), title: 'Topic con conversazioni in corso' }, 'Attivi', h('span.n', nTopics('active'))),
        h('button', { class: view === 'archive' && 'on', onclick: () => setView('archive'), title: 'Conversazioni archiviate: tornano attive se arriva o parte un messaggio' }, 'Archiviati', h('span.n', nTopics('archive'))))),
    h('div.toolbar.cats',
      MAIL_STATES.map(([k, label]) => filterChip({
        on: ui.mailType === k, label, n: inView(view).filter(STATE[k]).length, cls: k === 'unread' ? 'tint k-mail' : null,
        onclick: () => { ui.mailType = ui.mailType === k ? null : k; render(); },
      })),
      h('span.tsep'),
      filterChip({ on: ui.mailAtt, label: [icon('clip'), 'con allegati'], onclick: () => { ui.mailAtt = !ui.mailAtt; render(); } }),
      projects.length > 0 && h('select.sm', {
        value: proj ? String(proj.id) : '', title: 'Solo le conversazioni di un progetto',
        onchange: ev => { ui.mailProj = +ev.target.value || null; render(); },
      }, h('option', { value: '' }, 'tutti i progetti'), projects.map(p => h('option', { value: p.id }, `@${p.tag}`)))),
    h('div.topic-new', 'Rilascia qui per farne un topic a sé'),
    topics.length > 0 && foldBar('mail'),
    topics.length > 0 && masonry('topic-cols', topics.map(o => topicCard(o.topic, o.list, (D.threadsOfTopic.get(o.topic.id) || []).length))),
    topics.length > 1 && view === 'active' && h('p.muted.fhint', 'Trascina una conversazione su un altro topic per unirle.'),
    shared.length > 0 && h('section.sec', h('div.sec-h', h('span.sec-t', 'Condivise con te'), h('span.count', shared.length)),
      h('div.sec-b', shared.map(e => h('a.trow.shared', { href: `#/v/${e.id}` }, h('span.trow-subj', plainRefs(e.title)), h('span.muted', contactNames(e.contact || '')))))),
    !topics.length && !shared.length && h('div.empty', filtered
      ? h('p', 'Nessuna conversazione corrisponde ai filtri.')
      : view === 'active'
        ? [h('p', 'Nessuna conversazione attiva.'),
          !D.mailExt && h('p', 'Collega Thunderbird (Impostazioni → Mail e Thunderbird): al primo collegamento carica qui le mail dell\'ultimo mese.'),
          h('p', 'Nuova mail dalla barra in alto, ad esempio: ', h('code.k', 'offerta 50 schede >acquisti@ditta.it !ven'))]
        : h('p', 'Nessuna conversazione archiviata.')));
}

draggable({
  handle: '.topic-cols .trow[data-th]',
  bodyClass: 'tdnd',
  data: el => +el.dataset.th,
  ghost: id => [h('span', threadSubject(S.data.threadById.get(id)))],
  target: (el, id) => {
    const t = S.data.threadById.get(id);
    const card = el.closest('.topic-card[data-topic]');
    if (card) {
      const to = +card.dataset.topic;
      return { el: card, value: to, ok: to !== t.topic_id };
    }
    const zone = el.closest('.topic-new');
    return zone ? { el: zone, value: 'new', ok: (S.data.threadsOfTopic.get(t.topic_id) || []).length > 1 } : null;
  },
  drop: (id, target) => moveThread(S.data.threadById.get(id), target.value),
});

// ---------- pagina del topic ----------
const full = new Map(); // id del topic → { key, data }: i messaggi interi, letti dal server quando cambiano
function fullTopic(topic) {
  const D = S.data;
  const threads = D.threadsOfTopic.get(topic.id) || [];
  const key = threads.map(t => `${t.id}:${(D.msgsOfThread.get(t.id) || []).map(m => m.id)}:${(D.entriesOfThread.get(t.id) || []).map(e => e.id)}`).join('|');
  let f = full.get(topic.id);
  if (!f || f.key !== key) {
    full.set(topic.id, (f = { key, data: f?.data || null }));
    api('GET', `/mail/topics/${topic.id}`).then(data => { if (full.get(topic.id) === f) { f.data = data; render(); } }).catch(() => {});
  }
  return f.data;
}

// L'albero di una conversazione: ogni messaggio sotto quello a cui risponde (In-Reply-To, poi References); le
// mail scritte qui sotto il messaggio a cui rispondono. Senza riferimenti (client che non li mandano) un
// messaggio è una radice: una conversazione può averne più d'una.
function treeOf(x) {
  const D = S.data;
  const byMid = new Map(x.msgs.map(m => [m.message_id, m]));
  const nodes = new Map(); // "m12" / "e5" → nodo
  const add = (key, n) => { nodes.set(key, { ...n, kids: [] }); };
  for (const m of x.msgs) add(`m${m.id}`, { type: 'msg', id: m.id, m, date: m.date });
  const withMsg = new Set(x.msgs.map(m => m.entry_id).filter(Boolean));
  for (const e of x.ents) if (!withMsg.has(e.id)) add(`e${e.id}`, { type: 'entry', id: e.id, e, date: e.done_at || e.created_at });
  const parentKey = n => {
    if (n.type === 'msg') {
      const m = n.m;
      const p = (m.in_reply_to && byMid.get(m.in_reply_to)) || parseRefs(m).reverse().map(r => byMid.get(r)).find(Boolean);
      if (p && p.id !== m.id) return `m${p.id}`;
      const e = m.entry_id && D.entryById.get(m.entry_id);
      return e?.reply_to ? `m${e.reply_to}` : null;
    }
    return n.e.reply_to ? `m${n.e.reply_to}` : null;
  };
  const roots = [];
  for (const [key, n] of nodes) {
    const pk = parentKey(n);
    const p = pk && pk !== key && nodes.get(pk);
    (p ? p.kids : roots).push(n);
  }
  const sort = list => { list.sort((a, b) => a.date.localeCompare(b.date)); for (const n of list) sort(n.kids); return list; };
  return sort(roots);
}

const sameSel = (a, b) => a && b && a.type === b.type && a.id === b.id;

function selectNode(topic, n) {
  const th = new URLSearchParams(location.hash.split('?')[1] || '').get('th') || undefined;
  ui.mailSel = { topic: topic.id, type: n.type, id: n.id, from: th };
  render();
  // Su telefono l'albero sta sopra la mail: si scende a leggerla.
  if (innerWidth <= 800) document.querySelector('.tp-mail')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// Aprire una mail ricevuta la legge (resta dov'è).
function markRead(m) {
  if (!m || m.direction !== 'in' || m.read_at) return;
  m.read_at = new Date().toISOString();
  api('PATCH', `/mail/messages/${m.id}`, { read: true }).catch(() => {});
}

function nodeRow(topic, n, depth, sel) {
  const D = S.data;
  const on = sameSel(sel, n);
  if (n.type === 'msg') {
    const m = n.m;
    const unread = m.direction === 'in' && !m.read_at;
    return h('button.tnode', {
      type: 'button', class: [on && 'sel', unread && 'unread', m.direction].filter(Boolean).join(' '), style: `--d:${Math.min(depth, 8)}`,
      onclick: () => selectNode(topic, n),
    },
    h('span.tn-dir', m.direction === 'in' ? '↙' : '↗'),
    h('span.tn-who', m.direction === 'in' ? fromName(m.from_addr) : ['a ', contactNames(addrs(m.to_addr))]),
    m.has_att ? h('span.tn-att', icon('clip')) : null,
    h('span.tn-date', fmtTime(m.date)),
    h('span.tn-snip', newPart(m.snippet).replace(/\s+/g, ' ') || m.subject));
  }
  const e = n.e;
  const draft = !e.done_at;
  return h('button.tnode.entry', {
    type: 'button', class: [on && 'sel', draft ? 'draft' : 'out'].filter(Boolean).join(' '), style: `--d:${Math.min(depth, 8)}`,
    onclick: () => selectNode(topic, n),
  },
  h('span.tn-dir', draft ? '✎' : '↗'),
  h('span.tn-who', draft ? 'bozza' : ['a ', contactNames(e.contact || '')]),
  D.attachmentsOf.has(e.id) ? h('span.tn-att', icon('clip')) : null,
  h('span.tn-date', draft ? (e.due ? fmtDay(e.due) : '') : fmtTime(e.done_at)),
  h('span.tn-snip', plainRefs(e.notes || e.title).replace(/\s+/g, ' ')));
}

function flatten(list, depth = 0, out = []) {
  for (const n of list) {
    out.push([n, depth]);
    flatten(n.kids, depth + 1, out);
  }
  return out;
}

function threadTree(topic, x, sel) {
  const { t } = x;
  const archived = !!t.archived_at;
  const nodes = flatten(treeOf(x));
  return h('div.tthread', { class: [archived && 'archived', sel?.thread === t.id && 'cur'].filter(Boolean).join(' '), style: `--h:${threadHue(t)}`, 'data-th': t.id },
    h('div.tt-h',
      h('button.check.mail', { title: archived ? 'Di nuovo attiva' : 'Archivia la conversazione', onclick: () => archiveThread(t, !archived) }, icon(archived ? 'restore' : 'check')),
      star(!!t.starred, () => patchThread(t, { starred: t.starred ? 0 : 1 }), 'conversazione'),
      h('span.tt-subj', { title: threadSubject(t) }, threadSubject(t)),
      archived && h('span.muted.tt-arch', 'archiviata'),
      unreadBadge(x.unread),
      huePop(`hue-th:${t.id}`, t, autoHue(t.id, 70), v => patchThread(t, { hue: v })),
      threadMenu(t)),
    nodes.length ? nodes.map(([n, d]) => nodeRow(topic, n, d, sel)) : h('p.muted.tn-empty', 'Nessun messaggio.'));
}

// La mail scelta, intera.
function mailView(topic, sel, data, x) {
  const D = S.data;
  if (sel.type === 'entry') {
    const e = D.entryById.get(sel.id);
    if (!e) return h('p.muted', 'Mail non trovata.');
    if (!e.done_at) {
      return h('div.tm-draft',
        h('div.tm-dh', h('span.kpill.k-mail', 'bozza'), h('a', { href: `#/v/${e.id}`, title: 'Apri come voce (data, progetti, condivisione…)' }, plainRefs(e.title)),
          e.due && h('span.muted', icon('cal'), fmtDay(e.due)), h('span.grow'),
          h('button.icon-btn.sm', { title: 'Elimina la bozza', onclick: () => trashIt('entry', `/entries/${e.id}`, 'Bozza') }, icon('trash'))),
        mailComposer(e),
        h('div.tm-att', h('div.ms-h', 'Allegati'), outAttachments(e)));
    }
    return h('article.tm',
      h('h2.tm-subj', plainRefs(e.mail_subject || e.title)),
      h('div.tm-head', h('div', h('span.muted', 'A '), contactNames(e.contact || '')), e.mail_cc && h('div', h('span.muted', 'Cc '), contactNames(e.mail_cc)),
        h('div.muted', `mandata ${fmtTime(e.done_at)}`)),
      h('div.tm-body', plainRefs(e.notes || '')),
      (D.attachmentsOf.get(e.id) || []).length > 0 && h('div.tm-att', outAttachments(e)));
  }
  const brief = x.msgs.find(m => m.id === sel.id);
  const m = data?.threads.flatMap(t => t.messages).find(y => y.id === sel.id);
  if (!brief) return h('p.muted', 'Mail non trovata.');
  const body = m ? newPart(m.body) : newPart(brief.snippet);
  const more = m && m.body && body.length < m.body.trim().length;
  const replied = x.drafts.some(e => e.reply_to === brief.id);
  return h('article.tm',
    h('h2.tm-subj', brief.subject || '(senza oggetto)'),
    h('div.tm-head',
      h('div', h('span.muted', 'Da '), h('b', fromName(brief.from_addr)), h('span.muted.mono', ` ${addrs(brief.from_addr)}`)),
      h('div', h('span.muted', 'A '), contactNames(addrs(brief.to_addr))),
      brief.cc && h('div', h('span.muted', 'Cc '), contactNames(addrs(brief.cc))),
      h('div.muted', fmtTime(brief.date))),
    h('div.tm-body', body || (m ? '(nessun testo)' : 'Caricamento…')),
    more && h('details', h('summary.muted', 'messaggio completo'), h('div.tm-body', m.body.trim())),
    m?.attachments?.length > 0 && h('div.tm-att', h('div.ms-h', 'Allegati'), attList(m.attachments, m.id)),
    can('mail', 'write') && h('div.tm-actions',
      replied && h('span.muted', 'C\'è già una bozza di risposta: '),
      [false, true].map(all => h('button.btn.sm', {
        onclick: () => act(async () => {
          const r = await api('POST', `/mail/messages/${brief.id}/reply`, { all });
          ui.mailSelNext = { topic: topic.id, type: 'entry', id: r.id };
        }),
      }, icon('send'), all ? 'Rispondi a tutti' : 'Rispondi'))));
}

// Collegamenti della conversazione: scelti qui, trovati nei messaggi (codici e progetti) o citati nelle mail
// scritte qui. Tutti si possono togliere (quelli automatici non tornano).
const LINK_ICON = { articolo: 'box', doc: 'file', progetto: 'folder', contatto: 'user', voce: 'log', mail: 'mail' };
function linkTarget(kind, id) {
  const D = S.data;
  if (kind === 'articolo') { const it = D.itemById.get(id); return it && { href: `#/i/${id}`, label: it.code, sub: it.name, it }; }
  if (kind === 'doc') { const d = D.docById.get(id); return d && { href: `#/d/${id}`, label: docName(d), sub: D.itemById.get(d.item_id)?.code }; }
  if (kind === 'progetto') { const p = D.projectById.get(id); return p && { href: `#/p/${id}`, label: `@${p.tag}`, sub: p.name !== p.tag ? p.name : '' }; }
  if (kind === 'contatto') { const c = D.contactById.get(id); return c && { href: `#/contatti/${id}`, label: c.name || c.email, sub: c.company }; }
  if (kind === 'mail') { const t = D.threadById.get(id); return t && { href: `#/t/${t.topic_id}?th=${id}`, label: threadSubject(t), sub: 'conversazione' }; }
  const e = D.entryById.get(id);
  return e && { href: `#/v/${id}`, label: plainRefs(e.title), sub: e.kind };
}

async function addLinks(base, text) {
  const D = S.data;
  const want = [];
  for (const c of extractCodes(text)) { const it = D.itemByCode.get(c.toUpperCase()); if (it) want.push(['articolo', it.id]); }
  for (const m of text.matchAll(/(?:^|\s)@([\p{L}\d_.-]+)/gu)) { const p = D.projectByTag.get(m[1].toLowerCase()); if (p) want.push(['progetto', p.id]); }
  for (const m of text.matchAll(REF_RE)) want.push([m[1], +m[2]]);
  if (!want.length) return toast('Scrivi #codice, @progetto o [[ per scegliere cosa collegare', { err: true });
  for (const [kind, id] of want) await api('POST', `${base}/links`, { kind, id });
}

// Collegamenti di una conversazione (base /mail/threads/ID) o del topic intero (/mail/topics/ID, solo a mano).
function linksBlock(base, links, { title, empty, fk }) {
  const seen = new Map();
  for (const l of links) {
    const k = `${l.kind}:${l.target_id}`;
    if (!seen.has(k) || (l.manual && !l.auto)) seen.set(k, l);
  }
  const order = Object.keys(LINK_ICON);
  const rows = [...seen.values()].map(l => ({ l, x: linkTarget(l.kind, l.target_id) })).filter(r => r.x)
    .sort((a, b) => order.indexOf(a.l.kind) - order.indexOf(b.l.kind));
  return h('div.ms-b',
    h('div.ms-h', title),
    rows.map(({ l, x }) => h('div.tl-row',
      icon(LINK_ICON[l.kind]),
      h('a', { href: x.href, ...(x.it ? itemAttrs(x.it) : {}), class: x.it ? 'code' : null }, x.label),
      x.sub && h('span.muted', x.sub),
      h('span.grow'),
      l.auto ? h('span.muted.tl-auto', { title: l.manual ? 'Trovato nei messaggi' : 'Citato in una mail scritta qui' }, 'auto') : null,
      h('button.icon-btn.sm', {
        title: l.auto ? 'Togli (non torna più da solo)' : 'Scollega',
        onclick: () => act(() => api('DELETE', `${base}/links/${l.kind}/${l.target_id}`)),
      }, icon('x')))),
    !rows.length && h('p.muted', empty),
    h('input.sub-in', {
      placeholder: '+ #codice, @progetto, [[ altro', 'data-fk': fk, 'data-ac': 'mail', 'data-ac-only': '#@', autocomplete: 'off', spellcheck: 'false',
      onkeydown: ev => {
        if (ev.key !== 'Enter' || ev.isComposing || document.querySelector('.ac:not([hidden])')) return;
        ev.preventDefault();
        const text = ev.target.value;
        if (!text.trim()) return;
        ev.target.value = '';
        act(() => addLinks(base, text));
      },
    }));
}

function topicLinks(topic) {
  return linksBlock(`/mail/topics/${topic.id}`, S.data.linksOfTopic.get(topic.id) || [], {
    title: 'Topic collegato a', fk: `toplink-${topic.id}`,
    empty: 'Collega il topic intero a un progetto (o altro): vale per tutte le sue conversazioni.',
  });
}

function sideColumn(topic, x, data) {
  if (!x) return h('aside.mail-side', topicLinks(topic));
  const { t } = x;
  const received = (data?.threads.find(y => y.id === t.id)?.messages || []).filter(m => m.direction === 'in' && m.attachments.length);
  return h('aside.mail-side',
    topicLinks(topic),
    h('div.ms-b.tside-h', { style: `--h:${threadHue(t)}` },
      h('div.ms-h', 'Conversazione'),
      h('div.tside-subj', threadSubject(t)),
      h('div.ms-add',
        h('button.btn.sm', { onclick: () => archiveThread(t, !t.archived_at) }, icon(t.archived_at ? 'restore' : 'check'), t.archived_at ? 'Di nuovo attiva' : 'Archivia'),
        can('mail', 'write') && h('button.btn.sm.ghost', {
          onclick: () => act(async () => {
            const r = await api('POST', `/mail/threads/${t.id}/draft`);
            ui.mailSelNext = { topic: topic.id, type: 'entry', id: r.id };
          }),
        }, icon('plus'), 'Nuova mail'))),
    linksBlock(`/mail/threads/${t.id}`, S.data.linksOfThread.get(t.id) || [], {
      title: 'Conversazione collegata a', fk: `tlink-${t.id}`,
      empty: 'Articoli e progetti scritti nelle mail si collegano da soli; qui aggiungi o togli quello che vuoi.',
    }),
    peopleBlock([...x.msgs.flatMap(m => [m.from_addr, m.to_addr, m.cc]), ...x.ents.flatMap(e => [e.contact, e.mail_cc])].filter(Boolean)),
    block('Allegati ricevuti', received.map(m => attList(m.attachments, m.id))),
    backlinksBox('mail', t.id, { title: 'Citata in', compact: true }));
}

export function viewTopic(id, q = {}) {
  const D = S.data;
  let topic = D.topicById.get(+id);
  // Link di prima dei topic (#/t/thread): si va al topic della conversazione.
  if (!topic && D.threadById.has(+id)) {
    const t = D.threadById.get(+id);
    location.replace(`#/t/${t.topic_id}?th=${t.id}`);
    return h('div.view');
  }
  if (!topic) {
    return h('div.view', h('div.empty', h('p', h('b', 'Topic non trovato.')),
      h('p', 'Forse è nel cestino o in un altro workspace: la posta è personale.'), h('a', { href: '#/mail' }, 'Torna alla posta')));
  }
  const threads = (D.threadsOfTopic.get(topic.id) || []).map(threadInfo)
    .sort((a, b) => !!a.t.archived_at - !!b.t.archived_at || a.t.created_at.localeCompare(b.t.created_at));
  const data = fullTopic(topic);
  // La mail scelta: quella appena chiesta (Rispondi), quella di prima, la prima da leggere (della conversazione
  // indicata, se c'è), altrimenti l'ultima.
  const trees = new Map(threads.map(x => [x.t.id, flatten(treeOf(x)).map(([n]) => n)]));
  const allNodes = [...trees.values()].flat();
  const find = s => s && allNodes.find(n => sameSel(n, s));
  if (ui.mailSelNext?.topic === topic.id && find(ui.mailSelNext)) {
    // La bozza appena chiesta (Rispondi): resta scelta anche con ?th= nell'indirizzo.
    ui.mailSel = { ...ui.mailSelNext, from: q.th };
    ui.mailSelNext = null;
  }
  if (ui.mailSel?.topic !== topic.id || !find(ui.mailSel) || (q.th && ui.mailSel.from !== q.th)) {
    const pool = q.th && trees.has(+q.th) ? trees.get(+q.th) : allNodes;
    const pick = pool.find(n => n.type === 'msg' && n.m.direction === 'in' && !n.m.read_at)
      || [...pool].filter(n => n.type === 'msg').sort((a, b) => b.date.localeCompare(a.date))[0] || pool[0];
    ui.mailSel = pick ? { topic: topic.id, type: pick.type, id: pick.id, from: q.th } : null;
  }
  const node = find(ui.mailSel);
  const cur = node && threads.find(x => (node.type === 'msg' ? x.msgs.some(m => m.id === node.id) : x.ents.some(e => e.id === node.id)));
  if (node?.type === 'msg') markRead(node.m);
  const sel = node && { ...ui.mailSel, thread: cur?.t.id };
  const active = threads.filter(x => !x.t.archived_at).length;

  return h('div.view.topicpage', { style: `--h:${topicHue(topic)}` },
    h('div.th-head',
      h('a.icon-btn', { href: '#/mail', title: 'Torna alla posta' }, icon('back')),
      star(!!topic.starred, () => patchTopic(topic, { starred: topic.starred ? 0 : 1 }), 'topic'),
      h('h2.th-subj', { title: 'Rinomina', onclick: () => rename('Nome del topic:', topicTitle(topic), title => patchTopic(topic, { title })) }, topicTitle(topic)),
      huePop(`thue:${topic.id}`, topic, autoHue(topic.id), v => patchTopic(topic, { hue: v })),
      h('span.grow'),
      h('span.muted.th-count', threads.length === 1 ? '1 conversazione' : `${threads.length} conversazioni${active < threads.length ? `, ${threads.length - active} archiviate` : ''}`),
      topicMenu(topic)),
    h('div.tp-cols',
      h('nav.tp-tree', { 'aria-label': 'Conversazioni e mail' }, threads.map(x => threadTree(topic, x, sel))),
      h('div.tp-mail', node ? mailView(topic, sel, data, cur) : h('p.muted', 'Nessuna mail.')),
      sideColumn(topic, cur, data)));
}

// Nell'editor di una mail scritta in Organizer: la conversazione di cui fa parte.
export function threadLink(e) {
  const t = e.thread_id && S.data.threadById.get(e.thread_id);
  if (!t) return null;
  const n = (S.data.msgsOfThread.get(t.id) || []).length;
  return h('a.thread-link', { href: `#/t/${t.topic_id}?th=${t.id}` }, icon('mail'), h('b', 'Conversazione'), h('span', threadSubject(t)),
    h('span.muted', n ? `${n} ${n === 1 ? 'messaggio' : 'messaggi'}` : ''), h('span.grow'), '→');
}
