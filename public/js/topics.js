// Mail by topic (see server/maildata.js). Everything is personal: nobody else sees a person's mail.
//  - Mail page: topics as cards in several columns, each with its conversations (active or archived). A
//    conversation is dragged onto another topic to merge it, or onto "topic of its own" to split it;
//  - topic page (#/t/ID?th=thread): on the left the tree (conversations and their mails, like a forum), in the
//    middle the chosen mail (or the draft to write), on the right the conversation's links, people and attachments.
// Topics and conversations have a star and a colour (automatic until one is chosen).
import {
  h, icon, S, ui, api, act, render, toast, save, fmtTime, fmtDay, plainRefs, contactNames, can, itemAttrs, docName, projectsOf, projHue,
  trashIt, popButton, popItem, popSep, huePicker, masonry, filterChip, fold, foldBar,
} from './core.js';
import { draggable } from './dnd.js';
import { extractCodes } from './parse.js';
import { mailComposer, peopleBlock, outAttachments, attList, block, fromName, addrs, addrList, lc, REF_RE } from './mail.js';
import { backlinksBox } from './views.js';
import { tr, trn } from './i18n.js';

// ---------- data ----------
export const threadSubject = t => plainRefs(t.subject).replace(/(^|\s)#/g, '$1') || tr('(no subject)');
export const topicTitle = t => plainRefs(t.title).replace(/(^|\s)#/g, '$1') || tr('(no subject)');
// Automatic colour: spread with the golden angle, so nearby topics and conversations do not look alike.
const autoHue = (id, shift = 0) => Math.round((id * 137.508 + shift) % 360);
export const topicHue = t => t.hue ?? autoHue(t.id);
export const threadHue = t => t.hue ?? autoHue(t.id, 70);
const parseRefs = m => { try { return JSON.parse(m.refs || '[]'); } catch { return []; } };

// A conversation's summary: for cards, badges and backlinks.
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
  // Projects of the conversation, of its topic and of the mails written here.
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

// A message's new text, without the quote of the previous ones ("On … wrote:", lines with >).
function newPart(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const quote = /^(On|Il|Am|Le|El) .{4,300}(wrote|scritto|schrieb|écrit|escribió)\s*:\s*$|^-{2,}\s*(Original Message|Messaggio originale|Forwarded)|^>|^(From|Da):\s.+/i;
  const cut = lines.findIndex(l => quote.test(l.trim()));
  return (cut < 0 ? lines : lines.slice(0, cut)).join('\n').trim();
}

// ---------- actions ----------
const patchThread = (t, f) => { Object.assign(t, f); render(); return act(() => api('PATCH', `/mail/threads/${t.id}`, f)); };
const patchTopic = (t, f) => { Object.assign(t, f); render(); return act(() => api('PATCH', `/mail/topics/${t.id}`, f)); };

export function archiveThread(t, archived) {
  const at = new Date().toISOString();
  t.archived_at = archived ? at : null;
  if (archived) for (const m of S.data.msgsOfThread.get(t.id) || []) m.read_at ||= at;
  render();
  act(() => api('PATCH', `/mail/threads/${t.id}`, { archived }));
  toast(archived ? tr('Conversation archived') : tr('Conversation active again'), { action: { label: tr('Undo'), fn: () => archiveThread(t, !archived) } });
}

function rename(label, current, fn) {
  const name = prompt(label, current);
  if (name?.trim()) fn(name.trim());
}

async function deleteThread(t) {
  const n = (S.data.entriesOfThread.get(t.id) || []).length;
  const alone = (S.data.threadsOfTopic.get(t.topic_id) || []).length === 1;
  const ok = await trashIt('thread', `/mail/threads/${t.id}`, n ? tr('Conversation (with its mails)') : tr('Conversation'));
  if (ok && alone && location.hash.startsWith(`#/t/${t.topic_id}`)) location.hash = '#/mail';
}

async function deleteTopic(topic) {
  const n = (S.data.threadsOfTopic.get(topic.id) || []).length;
  if (n > 1 && !confirm(tr('Move the topic and its {n} conversations to the trash?', { n }))) return;
  if (await act(() => api('DELETE', `/mail/topics/${topic.id}`).then(() => true))) {
    toast(tr('Topic moved to the trash: the conversations are restored from the Trash'));
    if (location.hash.startsWith(`#/t/${topic.id}`)) location.hash = '#/mail';
  }
}

// Moving a conversation: to another topic (id) or to one of its own ("new").
async function moveThread(t, to) {
  const D = S.data;
  const from = D.topicById.get(t.topic_id);
  const r = await act(() => api('PATCH', `/mail/threads/${t.id}`, { topic: to }));
  if (!r) return;
  const dest = to === 'new' ? tr('a topic of its own') : `"${topicTitle(D.topicById.get(to) || { title: '' })}"`;
  toast(tr('Moved to {dest}', { dest }));
  if (location.hash.startsWith(`#/t/${from?.id}`) && !(D.threadsOfTopic.get(from.id) || []).some(x => x.id !== t.id)) location.hash = `#/t/${r.topic}?th=${t.id}`;
}

// Badge of the unread mails (top right of conversations and topics, as in the menu).
const unreadBadge = n => n > 0 && h('span.unread-n', { title: trn(n, '1 unread mail', '{n} unread mails') }, n > 99 ? '99+' : n);

const star = (on, onclick, what) => h('button.star-btn', { class: on ? 'on' : null, title: on ? tr('Remove the star ({what})', { what }) : tr('Star it ({what})', { what }), 'aria-pressed': on ? 'true' : 'false', onclick }, on ? '★' : '☆');

const huePop = (key, x, auto, onPick) => popButton(key, h('span.hue-dot', { style: `--h:${x.hue ?? auto}` }), close => [
  h('div.pop-sep', tr('Colour')), huePicker(x.hue ?? null, auto, v => { close(); onPick(v); }),
], { class: 'hue-b', title: tr('Colour') });

function threadMenu(t) {
  const D = S.data;
  const others = D.mailTopics.filter(x => x.id !== t.topic_id).map(x => ({ x, last: Math.max(...(D.threadsOfTopic.get(x.id) || []).map(y => Date.parse(y.last_at) || 0)) }))
    .sort((a, b) => b.last - a.last).slice(0, 10).map(o => o.x);
  const alone = (D.threadsOfTopic.get(t.topic_id) || []).length === 1;
  return popButton(`thread:${t.id}`, '⋯', close => [
    popItem([icon('edit'), tr('Rename')], () => { close(); rename(tr('Name of the conversation:'), threadSubject(t), subject => patchThread(t, { subject })); }),
    !alone && popItem([icon('folder'), tr('Split into a topic of its own')], () => { close(); moveThread(t, 'new'); }),
    others.length > 0 && popSep(tr('Move to the topic')),
    others.map(x => popItem(topicTitle(x), () => { close(); moveThread(t, x.id); })),
    popSep(),
    popItem([icon('trash'), tr('Delete')], () => { close(); deleteThread(t); }),
  ], { class: 'tc-menu', title: tr('Rename, move, delete'), 'aria-label': tr('Rename, move, delete') });
}

const topicMenu = topic => {
  const D = S.data;
  const spaces = D.workspaces.filter(w => w.id !== D.workspace?.id && !w.tour);
  return popButton(`topic:${topic.id}`, '⋯', close => [
    popItem([icon('edit'), tr('Rename')], () => { close(); rename(tr('Name of the topic:'), topicTitle(topic), title => patchTopic(topic, { title })); }),
    spaces.length > 0 && popSep(tr('Move to the workspace')),
    spaces.map(w => popItem(w.name, () => { close(); moveTopicTo(topic, w); })),
    popSep(),
    popItem([icon('trash'), tr('Delete the topic')], () => { close(); deleteTopic(topic); }),
  ], { class: 'tc-menu', title: tr('Rename, move, delete'), 'aria-label': tr('Rename, move, delete') });
};

// The whole topic into another workspace (with conversations and mails written here): the links from here are lost.
function moveTopicTo(topic, w) {
  if (!confirm(tr('Move "{topic}" to the workspace {ws}?\n\nLinks to items, projects and contacts of this workspace are lost; the automatic ones are made again with the inventory of {ws}.', { topic: topicTitle(topic), ws: w.name }))) return;
  act(async () => {
    await api('POST', `/mail/topics/${topic.id}/move`, { ws: w.id });
    location.hash = '#/mail';
  }, tr('Topic moved to {ws}', { ws: w.name }));
}

// ---------- Mail page ----------
const MAIL_STATES = [['star', tr('★ Starred')], ['unread', tr('Unread')], ['draft', tr('To send')], ['wait', tr('Awaiting reply')]];
const STATE = {
  star: x => !!x.t.starred || !!S.data.topicById.get(x.t.topic_id)?.starred,
  unread: x => x.unread > 0,
  draft: x => x.drafts.length > 0,
  wait: x => x.waiting.length > 0,
};

// same: the subject is already the topic's title (the card has a single conversation): it is not repeated.
function threadRow(x, same = false) {
  const { t } = x;
  const archived = !!t.archived_at;
  const snip = x.last ? newPart(x.last.snippet) : plainRefs(x.drafts[0]?.notes || '');
  return h('div.trow', { class: [x.unread && 'unread', archived && 'archived'].filter(Boolean).join(' '), 'data-th': t.id, style: `--h:${threadHue(t)}` },
    h('button.check.mail', { title: archived ? tr('Active again') : tr('Archive (also marks it read)'), onclick: () => archiveThread(t, !archived) },
      icon(archived ? 'restore' : 'check')),
    h('a.trow-body', { href: `#/t/${t.topic_id}?th=${t.id}` },
      h('div.trow-h', t.starred ? h('span.star-on', '★') : null,
        same ? h('span.trow-who', whoNames(x.who)) : h('span.trow-subj', threadSubject(t)), h('span.muted.trow-date', fmtTime(t.last_at)), unreadBadge(x.unread)),
      !same && x.who.length > 0 && h('div.trow-who', whoNames(x.who)),
      snip && h('div.trow-snip', snip.replace(/\s+/g, ' ').slice(0, 160)),
      h('div.tc-meta',
        x.drafts.length > 0 && h('span.tb.draft', icon('edit'), x.drafts.length === 1 ? tr('to send') : tr('{n} to send', { n: x.drafts.length })),
        x.waiting.length > 0 && h('span.tb.wait', icon('wait'), tr('awaiting')),
        x.msgs.length > 1 && h('span.muted', icon('mail'), x.msgs.length),
        x.att && h('span.muted', icon('clip')),
        x.projects.map(p => h('span.tag', { style: `--h:${projHue(p)}` }, `@${p.tag}`)),
        x.items.slice(0, 3).map(it => h('span.code', itemAttrs(it), it.code)),
        x.items.length > 3 && h('span.muted', `+${x.items.length - 3}`))),
    threadMenu(t));
}

// Projects linked to the whole topic.
const topicProjects = topic => (S.data.linksOfTopic.get(topic.id) || []).filter(l => l.kind === 'progetto')
  .map(l => S.data.projectById.get(l.target_id)).filter(Boolean);

function topicCard(topic, rows, total) {
  return fold('mail', topic.id, h('section.topic-card', { 'data-topic': topic.id, style: `--h:${topicHue(topic)}` },
    h('div.tp-h',
      star(!!topic.starred, () => patchTopic(topic, { starred: topic.starred ? 0 : 1 }), tr('topic')),
      h('a.tp-title', { href: `#/t/${topic.id}` }, topicTitle(topic)),
      topicProjects(topic).length > 0 && h('span.tp-tags', topicProjects(topic).map(p => h('span.tag', { style: `--h:${projHue(p)}` }, `@${p.tag}`))),
      unreadBadge((S.data.threadsOfTopic.get(topic.id) || []).reduce((n, t) => n + (S.data.msgsOfThread.get(t.id) || []).filter(m => m.direction === 'in' && !m.read_at).length, 0)),
      // The number of conversations; with only one it shows only on a phone (useful with the card closed).
      h(`span.muted.tp-n${total > 1 ? '' : '.only-mobile'}`, { title: trn(total, '1 conversation in this topic', '{n} conversations in this topic') }, tr('{n} conv.', { n: total })),
      // The colour is chosen on the topic page: here the card only shows it (top border).
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
  // By topic: starred first, then the most recent.
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
  // Mails shared by others: threads are personal, I do not have the conversation of these.
  const shared = D.entries.filter(e => e.kind === 'mail' && e.created_by !== D.me.id && !D.threadById.has(e.thread_id)
    && (view === 'archive') === !!(e.done_at && !e.awaiting_reply) && (!f || [e.title, e.contact, e.notes].some(v => lc(v).includes(f))));
  const nTopics = v => new Set(inView(v).map(x => x.t.topic_id)).size;

  return h('div.view.mailpage',
    h('div.toolbar',
      h('input.filter', {
        type: 'search', placeholder: tr('Filter by subject, person, address, text…'), value: ui.mailFilter, 'data-fk': 'mailfilter',
        oninput: ev => { ui.mailFilter = ev.target.value; render(); },
      }),
      h('div.seg',
        h('button', { class: view === 'active' && 'on', onclick: () => setView('active'), title: tr('Topics with ongoing conversations') }, tr('Active'), h('span.n', nTopics('active'))),
        h('button', { class: view === 'archive' && 'on', onclick: () => setView('archive'), title: tr('Archived conversations: they become active again if a message arrives or leaves') }, tr('Archived'), h('span.n', nTopics('archive'))))),
    h('div.toolbar.cats',
      MAIL_STATES.map(([k, label]) => filterChip({
        on: ui.mailType === k, label, n: inView(view).filter(STATE[k]).length, cls: k === 'unread' ? 'tint k-mail' : null,
        onclick: () => { ui.mailType = ui.mailType === k ? null : k; render(); },
      })),
      h('span.tsep'),
      filterChip({ on: ui.mailAtt, label: [icon('clip'), tr('with attachments')], onclick: () => { ui.mailAtt = !ui.mailAtt; render(); } }),
      projects.length > 0 && h('select.sm', {
        value: proj ? String(proj.id) : '', title: tr('Only the conversations of a project'),
        onchange: ev => { ui.mailProj = +ev.target.value || null; render(); },
      }, h('option', { value: '' }, tr('all projects')), projects.map(p => h('option', { value: p.id }, `@${p.tag}`)))),
    h('div.topic-new', tr('Drop here to make it a topic of its own')),
    topics.length > 0 && foldBar('mail'),
    topics.length > 0 && masonry('topic-cols', topics.map(o => topicCard(o.topic, o.list, (D.threadsOfTopic.get(o.topic.id) || []).length))),
    topics.length > 1 && view === 'active' && h('p.muted.fhint', tr('Drag a conversation onto another topic to merge them.')),
    shared.length > 0 && h('section.sec', h('div.sec-h', h('span.sec-t', tr('Shared with you')), h('span.count', shared.length)),
      h('div.sec-b', shared.map(e => h('a.trow.shared', { href: `#/v/${e.id}` }, h('span.trow-subj', plainRefs(e.title)), h('span.muted', contactNames(e.contact || '')))))),
    !topics.length && !shared.length && h('div.empty', filtered
      ? h('p', tr('No conversation matches the filters.'))
      : view === 'active'
        ? [h('p', tr('No active conversation.')),
          !D.mailExt && h('p', tr('Connect Thunderbird (Settings → Mail and Thunderbird): the first time it loads the mails of the last month here.')),
          h('p', tr('New mail from the bar at the top, for example: '), h('code.k', tr('offer for 50 boards >purchasing@company.example !fri')))]
        : h('p', tr('No archived conversation.'))));
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

// ---------- topic page ----------
const full = new Map(); // topic id → { key, data }: the full messages, read from the server when they change
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

// A conversation's tree: each message under the one it replies to (In-Reply-To, then References); the mails written
// here under the message they reply to. Without references (clients that do not send them) a message is a root: a
// conversation may have more than one.
function treeOf(x) {
  const D = S.data;
  const byMid = new Map(x.msgs.map(m => [m.message_id, m]));
  const nodes = new Map(); // "m12" / "e5" → node
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
  // On a phone the tree sits above the mail: scroll down to read it.
  if (innerWidth <= 800) document.querySelector('.tp-mail')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// Opening a received mail reads it (it stays where it is).
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
      h('button.check.mail', { title: archived ? tr('Active again') : tr('Archive the conversation'), onclick: () => archiveThread(t, !archived) }, icon(archived ? 'restore' : 'check')),
      star(!!t.starred, () => patchThread(t, { starred: t.starred ? 0 : 1 }), tr('conversation')),
      h('span.tt-subj', { title: threadSubject(t) }, threadSubject(t)),
      archived && h('span.muted.tt-arch', 'archiviata'),
      unreadBadge(x.unread),
      huePop(`hue-th:${t.id}`, t, autoHue(t.id, 70), v => patchThread(t, { hue: v })),
      threadMenu(t)),
    nodes.length ? nodes.map(([n, d]) => nodeRow(topic, n, d, sel)) : h('p.muted.tn-empty', tr('No messages.')));
}

// The chosen mail, in full.
function mailView(topic, sel, data, x) {
  const D = S.data;
  if (sel.type === 'entry') {
    const e = D.entryById.get(sel.id);
    if (!e) return h('p.muted', tr('Mail not found.'));
    if (!e.done_at) {
      return h('div.tm-draft',
        h('div.tm-dh', h('span.kpill.k-mail', tr('draft')), h('a', { href: `#/v/${e.id}`, title: tr('Open as an entry (date, projects, sharing…)') }, plainRefs(e.title)),
          e.due && h('span.muted', icon('cal'), fmtDay(e.due)), h('span.grow'),
          h('button.icon-btn.sm', { title: tr('Delete the draft'), onclick: () => trashIt('entry', `/entries/${e.id}`, tr('Draft')) }, icon('trash'))),
        mailComposer(e),
        h('div.tm-att', h('div.ms-h', tr('Attachments')), outAttachments(e)));
    }
    return h('article.tm',
      h('h2.tm-subj', plainRefs(e.mail_subject || e.title)),
      h('div.tm-head', h('div', h('span.muted', `${tr('To')} `), contactNames(e.contact || '')), e.mail_cc && h('div', h('span.muted', 'Cc '), contactNames(e.mail_cc)),
        h('div.muted', tr('sent {when}', { when: fmtTime(e.done_at) }))),
      h('div.tm-body', plainRefs(e.notes || '')),
      (D.attachmentsOf.get(e.id) || []).length > 0 && h('div.tm-att', outAttachments(e)));
  }
  const brief = x.msgs.find(m => m.id === sel.id);
  const m = data?.threads.flatMap(t => t.messages).find(y => y.id === sel.id);
  if (!brief) return h('p.muted', tr('Mail not found.'));
  const body = m ? newPart(m.body) : newPart(brief.snippet);
  const more = m && m.body && body.length < m.body.trim().length;
  const replied = x.drafts.some(e => e.reply_to === brief.id);
  return h('article.tm',
    h('h2.tm-subj', brief.subject || tr('(no subject)')),
    h('div.tm-head',
      h('div', h('span.muted', `${tr('From')} `), h('b', fromName(brief.from_addr)), h('span.muted.mono', ` ${addrs(brief.from_addr)}`)),
      h('div', h('span.muted', `${tr('To')} `), contactNames(addrs(brief.to_addr))),
      brief.cc && h('div', h('span.muted', 'Cc '), contactNames(addrs(brief.cc))),
      h('div.muted', fmtTime(brief.date))),
    h('div.tm-body', body || (m ? tr('(no text)') : tr('Loading…'))),
    more && h('details', h('summary.muted', tr('full message')), h('div.tm-body', m.body.trim())),
    m?.attachments?.length > 0 && h('div.tm-att', h('div.ms-h', tr('Attachments')), attList(m.attachments, m.id)),
    h('div.tm-actions',
      can('mail', 'write') && replied && h('span.muted', tr('There is already a draft reply: ')),
      can('mail', 'write') && [false, true].map(all => h('button.btn.sm', {
        onclick: () => act(async () => {
          const r = await api('POST', `/mail/messages/${brief.id}/reply`, { all });
          ui.mailSelNext = { topic: topic.id, type: 'entry', id: r.id };
        }),
      }, icon('send'), all ? tr('Reply all') : tr('Reply'))),
      S.data.mailExt && h('button.btn.sm.ghost', {
        title: tr('Opens this message in Thunderbird, in a tab'),
        onclick: () => act(() => api('POST', `/mail/messages/${brief.id}/open`), tr('Opened in Thunderbird')),
      }, icon('mail'), tr('Open in Thunderbird'))));
}

// The conversation's links: picked here, found in the messages (codes and projects) or mentioned in mails written
// here. All of them can be removed (automatic ones do not come back).
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
  for (const m of text.matchAll(REF_RE)) if (m[1] !== 'nota') want.push([m[1], +m[2]]); // notes on documents are not linked to mails
  if (!want.length) return toast(tr('Write #code, @project or [[ to choose what to link'), { err: true });
  for (const [kind, id] of want) await api('POST', `${base}/links`, { kind, id });
}

// Links of a conversation (base /mail/threads/ID) or of the whole topic (/mail/topics/ID, by hand only).
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
      l.auto ? h('span.muted.tl-auto', { title: l.manual ? tr('Found in the messages') : tr('Mentioned in a mail written here') }, 'auto') : null,
      h('button.icon-btn.sm', {
        title: l.auto ? tr('Remove (it no longer comes back by itself)') : tr('Unlink'),
        onclick: () => act(() => api('DELETE', `${base}/links/${l.kind}/${l.target_id}`)),
      }, icon('x')))),
    !rows.length && h('p.muted', empty),
    h('input.sub-in', {
      placeholder: tr('+ #code, @project, [[ other'), 'data-fk': fk, 'data-ac': 'mail', 'data-ac-only': '#@', autocomplete: 'off', spellcheck: 'false',
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
    title: tr('Topic linked to'), fk: `toplink-${topic.id}`,
    empty: tr('Link the whole topic to a project (or something else): it applies to all its conversations.'),
  });
}

function sideColumn(topic, x, data) {
  if (!x) return h('aside.mail-side', topicLinks(topic));
  const { t } = x;
  const received = (data?.threads.find(y => y.id === t.id)?.messages || []).filter(m => m.direction === 'in' && m.attachments.length);
  return h('aside.mail-side',
    topicLinks(topic),
    h('div.ms-b.tside-h', { style: `--h:${threadHue(t)}` },
      h('div.ms-h', tr('Conversation')),
      h('div.tside-subj', threadSubject(t)),
      h('div.ms-add',
        h('button.btn.sm', { onclick: () => archiveThread(t, !t.archived_at) }, icon(t.archived_at ? 'restore' : 'check'), t.archived_at ? tr('Active again') : tr('Archive')),
        can('mail', 'write') && h('button.btn.sm.ghost', {
          onclick: () => act(async () => {
            const r = await api('POST', `/mail/threads/${t.id}/draft`);
            ui.mailSelNext = { topic: topic.id, type: 'entry', id: r.id };
          }),
        }, icon('plus'), tr('New mail')))),
    linksBlock(`/mail/threads/${t.id}`, S.data.linksOfThread.get(t.id) || [], {
      title: tr('Conversation linked to'), fk: `tlink-${t.id}`,
      empty: tr('Items and projects written in the mails link by themselves; here you add or remove what you like.'),
    }),
    peopleBlock([...x.msgs.flatMap(m => [m.from_addr, m.to_addr, m.cc]), ...x.ents.flatMap(e => [e.contact, e.mail_cc])].filter(Boolean)),
    block(tr('Attachments received'), received.map(m => attList(m.attachments, m.id))),
    backlinksBox('mail', t.id, { title: tr('Mentioned in'), compact: true }));
}

export function viewTopic(id, q = {}) {
  const D = S.data;
  let topic = D.topicById.get(+id);
  // Links from before topics (#/t/thread): go to the conversation's topic.
  if (!topic && D.threadById.has(+id)) {
    const t = D.threadById.get(+id);
    location.replace(`#/t/${t.topic_id}?th=${t.id}`);
    return h('div.view');
  }
  if (!topic) {
    return h('div.view', h('div.empty', h('p', h('b', tr('Topic not found.'))),
      h('p', tr('Maybe it is in the trash or in another workspace: mail is personal.')), h('a', { href: '#/mail' }, tr('Back to the mail'))));
  }
  const threads = (D.threadsOfTopic.get(topic.id) || []).map(threadInfo)
    .sort((a, b) => !!a.t.archived_at - !!b.t.archived_at || a.t.created_at.localeCompare(b.t.created_at));
  const data = fullTopic(topic);
  // The chosen mail: the one just requested (Reply), the previous one, the first unread (of the given conversation,
  // if any), otherwise the last.
  const trees = new Map(threads.map(x => [x.t.id, flatten(treeOf(x)).map(([n]) => n)]));
  const allNodes = [...trees.values()].flat();
  const find = s => s && allNodes.find(n => sameSel(n, s));
  if (ui.mailSelNext?.topic === topic.id && find(ui.mailSelNext)) {
    // The draft just requested (Reply): it stays chosen even with ?th= in the address.
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
      h('a.icon-btn', { href: '#/mail', title: tr('Back to the mail') }, icon('back')),
      star(!!topic.starred, () => patchTopic(topic, { starred: topic.starred ? 0 : 1 }), tr('topic')),
      h('h2.th-subj', { title: tr('Rename'), onclick: () => rename(tr('Name of the topic:'), topicTitle(topic), title => patchTopic(topic, { title })) }, topicTitle(topic)),
      huePop(`thue:${topic.id}`, topic, autoHue(topic.id), v => patchTopic(topic, { hue: v })),
      h('span.grow'),
      h('span.muted.th-count', threads.length === 1 ? tr('1 conversation') : `${tr('{n} conversations', { n: threads.length })}${active < threads.length ? `, ${tr('{n} archived', { n: threads.length - active })}` : ''}`),
      topicMenu(topic)),
    h('div.tp-cols',
      h('nav.tp-tree', { 'aria-label': tr('Conversations and mails') }, threads.map(x => threadTree(topic, x, sel)),
        // A new conversation in this topic, with the draft already open on the right.
        can('mail', 'write') && h('button.btn.ghost.tp-new', {
          onclick: () => act(async () => {
            const r = await api('POST', `/mail/topics/${topic.id}/draft`);
            ui.mailSelNext = { topic: topic.id, type: 'entry', id: r.id };
          }),
        }, icon('plus'), tr('New mail'))),
      h('div.tp-mail', node ? mailView(topic, sel, data, cur) : h('p.muted', tr('No mail.'))),
      sideColumn(topic, cur, data)));
}

// In the editor of a mail written in Organizer: the conversation it belongs to.
export function threadLink(e) {
  const t = e.thread_id && S.data.threadById.get(e.thread_id);
  if (!t) return null;
  const n = (S.data.msgsOfThread.get(t.id) || []).length;
  return h('a.thread-link', { href: `#/t/${t.topic_id}?th=${t.id}` }, icon('mail'), h('b', tr('Conversation')), h('span', threadSubject(t)),
    h('span.muted', n ? trn(n, '1 message', '{n} messages') : ''), h('span.grow'), '→');
}
