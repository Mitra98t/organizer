// Workspace chat with channels: messages between members, with links to projects, items, documents, entries and
// contacts (autocomplete with @ # + and "[["). Each channel has its own people (or belongs to everyone); whoever
// manages channels (admin or "channels" permission) creates them, renames them, picks who reads and who writes.
// The last 100 messages of each channel arrive with /api/sync, earlier ones on request.
import { h, icon, S, ui, api, act, render, userName, chatText, fmtTime, fmtLongDay, localDay, can, save, load } from './core.js';
import { tr, trn } from './i18n.js';

const GROUP_MS = 5 * 60e3; // close messages from the same person: a single header
const older = new Map();   // channel → messages loaded with "Earlier messages" (not in the synced data)
const olderDone = new Set();
let stick = true;          // the list stays at the bottom until it is scrolled up
let scrollTop = 0;
let fromBottom = null;     // after loading earlier ones: stays on the message being read
ui.chatChannel ??= load('org.chatChannel', null);

const myChannels = D => D.chatChannels.filter(c => c.member);
// The open channel: the chosen one, if one is still in it, otherwise the first.
export function currentChannel(D) {
  const mine = myChannels(D);
  return mine.find(c => c.id === ui.chatChannel) || mine[0] || null;
}

function openChannel(id) {
  ui.chatChannel = id;
  ui.chanEdit = null;
  save('org.chatChannel', id);
  stick = true;
  render();
}

// Everything visible is read (if the window is in the foreground).
function markRead(D, c, msgs) {
  const last = msgs.at(-1)?.id || 0;
  if (document.visibilityState !== 'visible' || last <= c.read_id) return;
  D.chatUnread = Math.max(0, D.chatUnread - c.unread);
  c.read_id = last;
  c.unread = 0;
  api('POST', '/chat/read', { id: last, channel: c.id }).catch(() => {});
  queueMicrotask(render); // updates the number on the badges
}

async function send(ta, c) {
  const text = ta.value.trim();
  if (!text) return;
  ta.value = '';
  ui.chatDraft = '';
  stick = true;
  const ok = await act(() => api('POST', '/chat', { text, channel: c.id }).then(() => true));
  if (!ok) {
    ta.value = text;
    ui.chatDraft = text;
  }
}

async function loadOlder(c, first) {
  const list = await act(() => api('GET', `/chat?channel=${c.id}&before=${first}&limit=100`));
  if (!list) return;
  if (list.length < 100) olderDone.add(c.id);
  older.set(c.id, [...list, ...(older.get(c.id) || [])]);
  const el = document.querySelector('.chat-list');
  if (el) fromBottom = el.scrollHeight - el.scrollTop;
  stick = false;
  render();
}

function editBox(m) {
  const done = ev => {
    const text = ev.target.value.trim();
    ui.chatEdit = null;
    if (text && text !== m.text) act(() => api('PATCH', `/chat/${m.id}`, { text }));
    else render();
  };
  return h('textarea.chat-edit', {
    value: m.text, rows: 1, 'data-fk': `chat-edit-${m.id}`, 'data-ac': 'chat', 'data-ac-only': '@#+', 'aria-label': tr('Edit the message'),
    onkeydown: ev => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); ev.target.blur(); }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); ui.chatEdit = null; render(); }
    },
    onblur: done,
  });
}

function message(m, D, head, canWrite) {
  const mine = m.user_id === D.me.id;
  const editing = ui.chatEdit === m.id;
  const canDelete = mine || D.me.is_admin || D.canManageChannels;
  return h('div.msg', { class: [mine && 'mine', head && 'first'].filter(Boolean).join(' ') || null, 'data-id': m.id },
    head && h('div.msg-h', h('b', userName(m.user_id)), h('span.muted', fmtTime(m.created_at).split(' ').pop())),
    editing ? editBox(m) : h('div.msg-t', chatText(m.text), m.edited_at && h('span.muted.msg-ed', { title: tr('edited {when}', { when: fmtTime(m.edited_at) }) }, ` (${tr('edited')})`)),
    !editing && canDelete && canWrite && h('div.msg-a',
      mine && h('button.icon-btn.sm', { title: tr('Edit'), 'aria-label': tr('Edit'), onclick: () => { ui.chatEdit = m.id; render(); } }, icon('edit')),
      h('button.icon-btn.sm', {
        title: tr('Delete'), 'aria-label': tr('Delete'),
        onclick: () => { if (confirm(tr('Delete the message?'))) act(() => api('DELETE', `/chat/${m.id}`)); },
      }, icon('trash'))));
}

// Who is in the channel, briefly.
function whoText(c, D) {
  if (c.everyone) return tr('all the workspace members');
  const ro = c.members.filter(m => !m.can_write).length;
  return `${trn(c.members.length, '1 person', '{n} people')}${ro ? `, ${tr('{n} read-only', { n: ro })}` : ''}`
    + (c.members.length <= 4 ? `: ${c.members.map(m => userName(m.user_id)).join(', ')}` : '');
}

// ---------- managing a channel ----------
// Name, "all members" or person by person: out, reads, writes.
function channelEditor(D, c) {
  const isNew = !c;
  const draft = ui.chanDraft ??= {
    name: c?.name || '', everyone: c ? !!c.everyone : false,
    members: Object.fromEntries((c?.members || []).map(m => [m.user_id, m.can_write ? 'write' : 'read'])),
  };
  const set = (k, v) => { draft[k] = v; render(); };
  const close = () => { ui.chanEdit = null; ui.chanDraft = null; render(); };
  const saveIt = () => {
    const body = {
      name: draft.name.trim(), everyone: draft.everyone,
      members: Object.entries(draft.members).filter(([, l]) => l !== 'none').map(([id, l]) => ({ user_id: +id, can_write: l === 'write' })),
    };
    act(async () => {
      const r = await api(isNew ? 'POST' : 'PATCH', isNew ? '/chat/channels' : `/chat/channels/${c.id}`, body);
      ui.chanEdit = null;
      ui.chanDraft = null;
      if (isNew) openChannel(r.id);
    }, isNew ? tr('#{name} created', { name: body.name }) : tr('Channel updated'));
  };
  return h('form.chan-ed', { onsubmit: ev => { ev.preventDefault(); saveIt(); }, 'aria-label': isNew ? tr('New channel') : tr('Manage #{name}', { name: c.name }) },
    h('div.chan-ed-h', h('b', isNew ? tr('New channel') : tr('Manage #{name}', { name: c.name })), h('span.grow'),
      h('button.icon-btn.sm', { type: 'button', title: tr('Close'), 'aria-label': tr('Close'), onclick: close }, icon('x'))),
    h('label.f', h('span', tr('Name')), h('input', { value: draft.name, required: true, placeholder: tr('e.g. workshop, suppliers'), 'data-fk': 'chan-name', oninput: ev => { draft.name = ev.target.value; } })),
    h('label.check-row', h('input', { type: 'checkbox', checked: draft.everyone, onchange: ev => set('everyone', ev.target.checked) }),
      h('b', tr('All the workspace members')), h('span.muted', tr(' read and write, also whoever joins later'))),
    !draft.everyone && h('table.chan-who',
      h('thead', h('tr', h('th', tr('Person')), h('th', tr('Out')), h('th', tr('Reads')), h('th', tr('Writes')))),
      h('tbody', D.members.map(u => h('tr',
        h('th', u.name || u.username, u.id === D.me.id && h('span.muted', ` (${tr('you')})`)),
        ['none', 'read', 'write'].map(l => h('td', h('input', {
          type: 'radio', name: `who-${u.id}`, 'aria-label': `${u.name || u.username}: ${{ none: tr('out'), read: tr('reads'), write: tr('writes') }[l]}`,
          checked: (draft.members[u.id] || 'none') === l, onchange: () => { draft.members[u.id] = l; },
        }))))))),
    h('div.toolbar',
      h('button.btn.primary', { type: 'submit' }, isNew ? tr('Create channel') : tr('Save')),
      h('button.btn.ghost', { type: 'button', onclick: close }, tr('Cancel')),
      h('span.grow'),
      !isNew && h('button.btn.sm.danger', {
        type: 'button',
        onclick: () => {
          if (!confirm(tr('Delete #{name}? Its messages will no longer be visible.', { name: c.name }))) return;
          act(async () => { await api('DELETE', `/chat/channels/${c.id}`); close(); }, tr('#{name} deleted', { name: c.name }));
        },
      }, icon('trash'), tr('Delete'))));
}

function channelList(D, cur) {
  const mine = myChannels(D);
  const others = D.canManageChannels ? D.chatChannels.filter(c => !c.member) : [];
  const item = c => h('button.chan', {
    class: c.id === cur?.id && 'on', 'aria-current': c.id === cur?.id ? 'true' : null,
    onclick: () => openChannel(c.id), title: whoText(c, D),
  }, icon('hash'), h('span.chan-n', c.name), !c.can_write && h('span.muted', { title: tr('Read-only') }, icon('lock')),
  c.muted ? h('span.muted', { title: tr('Muted: notifications only when you are mentioned') }, icon('bell-off')) : null, c.unread > 0 && h('span.badge', c.unread));
  return h('nav.chans', { 'aria-label': tr('Channels') },
    h('div.chans-h', h('span', tr('Channels')),
      D.canManageChannels && h('button.icon-btn.sm', { title: tr('New channel'), 'aria-label': tr('New channel'), onclick: () => { ui.chanEdit = 'new'; ui.chanDraft = null; render(); } }, icon('plus'))),
    mine.map(item),
    others.length > 0 && [h('div.chans-h.sub', tr('Not in')), others.map(c => h('button.chan.out', {
      onclick: () => { ui.chanEdit = c.id; ui.chanDraft = null; render(); }, title: tr('Manage'),
    }, icon('hash'), h('span.chan-n', c.name)))]);
}

export function viewChat(_id, query = {}) {
  const D = S.data;
  // #/chat?c=ID (from notifications): opens that channel.
  if (query.c && +query.c !== ui.chatChannel && D.chatChannels.some(c => c.id === +query.c && c.member)) {
    ui.chatChannel = +query.c;
    save('org.chatChannel', ui.chatChannel);
    stick = true;
  }
  const cur = currentChannel(D);
  const editing = ui.chanEdit === 'new' ? channelEditor(D, null)
    : ui.chanEdit ? channelEditor(D, D.chatChannels.find(c => c.id === ui.chanEdit)) : null;
  if (!cur) {
    return h('div.view.chat',
      h('div.chat-cols', channelList(D, null),
        h('div.chat-main', editing || h('div.empty', h('p', tr('You are not in any channel.')),
          h('p', D.canManageChannels ? tr('Create a channel with +.') : tr('Ask whoever manages the channels to add you.'))))));
  }
  const synced = D.chat.filter(m => m.channel_id === cur.id);
  const ids = new Set(synced.map(m => m.id));
  const msgs = [...(older.get(cur.id) || []).filter(m => !ids.has(m.id) && m.id < (synced[0]?.id ?? Infinity)), ...synced];
  const canWrite = !!cur.can_write && can('chat', 'write');

  const rows = [];
  let prev = null;
  for (const m of msgs) {
    const day = localDay(m.created_at);
    if (!prev || localDay(prev.created_at) !== day) rows.push(h('div.chat-day', h('span', fmtLongDay(day))));
    const head = !prev || prev.user_id !== m.user_id || localDay(prev.created_at) !== day
      || Date.parse(m.created_at) - Date.parse(prev.created_at) > GROUP_MS;
    rows.push(message(m, D, head, canWrite));
    prev = m;
  }

  const list = h('div.chat-list', {
    role: 'log', 'aria-label': tr('Messages of #{name}', { name: cur.name }),
    onscroll: ev => {
      const el = ev.target;
      scrollTop = el.scrollTop;
      stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    },
  },
  synced.length >= 100 && !olderDone.has(cur.id) && h('button.btn.sm.ghost.chat-older', { onclick: () => loadOlder(cur, msgs[0].id) }, tr('Earlier messages')),
  msgs.length ? rows : h('div.empty',
    h('p', tr('No messages in #{name}.', { name: cur.name })),
    h('p', tr('In a message '), h('code.k', '@project'), ' ', h('code.k', '#CODE'), ' ', h('code.k', '+person'),
      tr(' and '), h('code.k', '[['), tr(' to link a document, an entry or a contact: they become links.'))));

  const input = h('textarea.chat-in', {
    rows: 1, value: ui.chatDraft, placeholder: tr('Message in #{name}… (@ # + and [[ to link)', { name: cur.name }), 'aria-label': tr('Message in #{name}', { name: cur.name }),
    'data-fk': 'chat-in', 'data-ac': 'chat', 'data-ac-only': '@#+', enterkeyhint: 'send',
    oninput: ev => { ui.chatDraft = ev.target.value; },
    onkeydown: ev => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        send(ev.target, cur);
      }
    },
  });

  // Once the view is in the page: reading position and read messages.
  queueMicrotask(() => {
    if (!list.isConnected) return;
    if (fromBottom != null) list.scrollTop = list.scrollHeight - fromBottom;
    else list.scrollTop = stick ? list.scrollHeight : scrollTop;
    fromBottom = null;
    if (stick) markRead(D, cur, msgs);
  });

  return h('div.view.chat',
    h('div.chat-cols',
      channelList(D, cur),
      h('div.chat-main',
        h('div.chat-h', h('b', `#${cur.name}`), h('span.muted', whoText(cur, D)), h('span.grow'),
          // Muted: no notification for every message, only when you are mentioned (+person).
          h('button.btn.sm.ghost', {
            class: cur.muted ? 'on' : null, 'aria-pressed': String(!!cur.muted),
            title: cur.muted ? tr('Turn notifications for every message back on') : tr('Notifications only when you are mentioned'),
            onclick: () => act(() => api('POST', `/chat/channels/${cur.id}/mute`, { muted: !cur.muted }), cur.muted ? tr('#{name}: notifications for every message', { name: cur.name }) : tr('#{name} muted: notifications only when you are mentioned', { name: cur.name })),
          }, icon(cur.muted ? 'bell-off' : 'bell'), cur.muted ? tr('Muted') : tr('Mute')),
          D.canManageChannels && h('button.btn.sm.ghost', { onclick: () => { ui.chanEdit = cur.id; ui.chanDraft = null; render(); } }, icon('settings'), tr('Manage'))),
        editing,
        list,
        // Whoever can only read the channel has no bar to write.
        canWrite
          ? h('div.chat-bar', input,
            h('button.btn.primary', { title: tr('Send (Enter; Shift+Enter for a new line)'), 'aria-label': tr('Send'), onclick: () => send(input, cur) }, icon('send')))
          : h('p.muted.chat-ro', icon('lock'), ' ', tr('In #{name} you can only read.', { name: cur.name })))));
}
