// Chat del workspace a canali: messaggi tra i membri, con collegamenti a progetti, articoli, documenti, voci e
// contatti (autocompletamento con @ # + e "[["). Ogni canale ha le sue persone (o è di tutti); chi gestisce i
// canali (admin o permesso "canali") li crea, li rinomina, ne sceglie chi legge e chi scrive.
// Gli ultimi 100 messaggi di ogni canale arrivano con /api/sync, i precedenti a richiesta.
import { h, icon, S, ui, api, act, render, userName, chatText, fmtTime, fmtLongDay, localDay, toast, plainRefs, can, save, load } from './core.js';

const GROUP_MS = 5 * 60e3; // messaggi ravvicinati della stessa persona: un'intestazione sola
const older = new Map();   // canale → messaggi caricati con "Messaggi precedenti" (non stanno nei dati sincronizzati)
const olderDone = new Set();
let stick = true;          // la lista resta in fondo finché non si scorre verso l'alto
let scrollTop = 0;
let fromBottom = null;     // dopo aver caricato i precedenti: resta fermo sul messaggio che si stava leggendo
ui.chatChannel ??= load('org.chatChannel', null);

const myChannels = D => D.chatChannels.filter(c => c.member);
// Il canale aperto: quello scelto, se ci si è ancora dentro, altrimenti il primo.
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

// Tutto ciò che si vede è letto (se la finestra è in primo piano).
function markRead(D, c, msgs) {
  const last = msgs.at(-1)?.id || 0;
  if (document.visibilityState !== 'visible' || last <= c.read_id) return;
  D.chatUnread = Math.max(0, D.chatUnread - c.unread);
  c.read_id = last;
  c.unread = 0;
  api('POST', '/chat/read', { id: last, channel: c.id }).catch(() => {});
  queueMicrotask(render); // aggiorna il numero sui badge
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
    value: m.text, rows: 1, 'data-fk': `chat-edit-${m.id}`, 'data-ac': 'chat', 'data-ac-only': '@#+', 'aria-label': 'Modifica il messaggio',
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
    editing ? editBox(m) : h('div.msg-t', chatText(m.text), m.edited_at && h('span.muted.msg-ed', { title: `modificato ${fmtTime(m.edited_at)}` }, ' (modificato)')),
    !editing && canDelete && canWrite && h('div.msg-a',
      mine && h('button.icon-btn.sm', { title: 'Modifica', 'aria-label': 'Modifica', onclick: () => { ui.chatEdit = m.id; render(); } }, icon('edit')),
      h('button.icon-btn.sm', {
        title: 'Elimina', 'aria-label': 'Elimina',
        onclick: () => { if (confirm('Eliminare il messaggio?')) act(() => api('DELETE', `/chat/${m.id}`)); },
      }, icon('trash'))));
}

// Chi sta nel canale, in breve.
function whoText(c, D) {
  if (c.everyone) return 'tutti i membri del workspace';
  const ro = c.members.filter(m => !m.can_write).length;
  return `${c.members.length} ${c.members.length === 1 ? 'persona' : 'persone'}${ro ? `, ${ro} solo in lettura` : ''}`
    + (c.members.length <= 4 ? `: ${c.members.map(m => userName(m.user_id)).join(', ')}` : '');
}

// ---------- gestione di un canale ----------
// Nome, "tutti i membri" oppure persona per persona: fuori, legge, scrive.
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
    }, isNew ? `#${body.name} creato` : 'Canale aggiornato');
  };
  return h('form.chan-ed', { onsubmit: ev => { ev.preventDefault(); saveIt(); }, 'aria-label': isNew ? 'Nuovo canale' : `Gestisci #${c.name}` },
    h('div.chan-ed-h', h('b', isNew ? 'Nuovo canale' : `Gestisci #${c.name}`), h('span.grow'),
      h('button.icon-btn.sm', { type: 'button', title: 'Chiudi', 'aria-label': 'Chiudi', onclick: close }, icon('x'))),
    h('label.f', h('span', 'Nome'), h('input', { value: draft.name, required: true, placeholder: 'es. officina, fornitori', 'data-fk': 'chan-name', oninput: ev => { draft.name = ev.target.value; } })),
    h('label.check-row', h('input', { type: 'checkbox', checked: draft.everyone, onchange: ev => set('everyone', ev.target.checked) }),
      h('b', 'Tutti i membri del workspace'), h('span.muted', ' leggono e scrivono, anche chi entrerà dopo')),
    !draft.everyone && h('table.chan-who',
      h('thead', h('tr', h('th', 'Persona'), h('th', 'Fuori'), h('th', 'Legge'), h('th', 'Scrive'))),
      h('tbody', D.members.map(u => h('tr',
        h('th', u.name || u.username, u.id === D.me.id && h('span.muted', ' (tu)')),
        ['none', 'read', 'write'].map(l => h('td', h('input', {
          type: 'radio', name: `who-${u.id}`, 'aria-label': `${u.name || u.username}: ${{ none: 'fuori', read: 'legge', write: 'scrive' }[l]}`,
          checked: (draft.members[u.id] || 'none') === l, onchange: () => { draft.members[u.id] = l; },
        }))))))),
    h('div.toolbar',
      h('button.btn.primary', { type: 'submit' }, isNew ? 'Crea canale' : 'Salva'),
      h('button.btn.ghost', { type: 'button', onclick: close }, 'Annulla'),
      h('span.grow'),
      !isNew && h('button.btn.sm.danger', {
        type: 'button',
        onclick: () => {
          if (!confirm(`Eliminare #${c.name}? I messaggi non si vedranno più.`)) return;
          act(async () => { await api('DELETE', `/chat/channels/${c.id}`); close(); }, `#${c.name} eliminato`);
        },
      }, icon('trash'), 'Elimina')));
}

function channelList(D, cur) {
  const mine = myChannels(D);
  const others = D.canManageChannels ? D.chatChannels.filter(c => !c.member) : [];
  const item = c => h('button.chan', {
    class: c.id === cur?.id && 'on', 'aria-current': c.id === cur?.id ? 'true' : null,
    onclick: () => openChannel(c.id), title: whoText(c, D),
  }, icon('hash'), h('span.chan-n', c.name), !c.can_write && h('span.muted', { title: 'Solo lettura' }, icon('lock')), c.unread > 0 && h('span.badge', c.unread));
  return h('nav.chans', { 'aria-label': 'Canali' },
    h('div.chans-h', h('span', 'Canali'),
      D.canManageChannels && h('button.icon-btn.sm', { title: 'Nuovo canale', 'aria-label': 'Nuovo canale', onclick: () => { ui.chanEdit = 'new'; ui.chanDraft = null; render(); } }, icon('plus'))),
    mine.map(item),
    others.length > 0 && [h('div.chans-h.sub', 'Non ci sei'), others.map(c => h('button.chan.out', {
      onclick: () => { ui.chanEdit = c.id; ui.chanDraft = null; render(); }, title: 'Gestisci',
    }, icon('hash'), h('span.chan-n', c.name)))]);
}

export function viewChat() {
  const D = S.data;
  const cur = currentChannel(D);
  const editing = ui.chanEdit === 'new' ? channelEditor(D, null)
    : ui.chanEdit ? channelEditor(D, D.chatChannels.find(c => c.id === ui.chanEdit)) : null;
  if (!cur) {
    return h('div.view.chat',
      h('div.chat-cols', channelList(D, null),
        h('div.chat-main', editing || h('div.empty', h('p', 'Non sei in nessun canale.'),
          h('p', D.canManageChannels ? 'Crea un canale con +.' : 'Chiedi a chi gestisce i canali di aggiungerti.')))));
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
    role: 'log', 'aria-label': `Messaggi di #${cur.name}`,
    onscroll: ev => {
      const el = ev.target;
      scrollTop = el.scrollTop;
      stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    },
  },
  synced.length >= 100 && !olderDone.has(cur.id) && h('button.btn.sm.ghost.chat-older', { onclick: () => loadOlder(cur, msgs[0].id) }, 'Messaggi precedenti'),
  msgs.length ? rows : h('div.empty',
    h('p', `Nessun messaggio in #${cur.name}.`),
    h('p', 'Nel messaggio ', h('code.k', '@progetto'), ' ', h('code.k', '#CODICE'), ' ', h('code.k', '+persona'),
      ' e ', h('code.k', '[['), ' per collegare un documento, una voce o un contatto: diventano link.')));

  const input = h('textarea.chat-in', {
    rows: 1, value: ui.chatDraft, placeholder: `Messaggio in #${cur.name}… (@ # + e [[ per collegare)`, 'aria-label': `Messaggio in #${cur.name}`,
    'data-fk': 'chat-in', 'data-ac': 'chat', 'data-ac-only': '@#+', enterkeyhint: 'send',
    oninput: ev => { ui.chatDraft = ev.target.value; },
    onkeydown: ev => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        send(ev.target, cur);
      }
    },
  });

  // Dopo che la vista è nella pagina: posizione di lettura e messaggi letti.
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
          D.canManageChannels && h('button.btn.sm.ghost', { onclick: () => { ui.chanEdit = cur.id; ui.chanDraft = null; render(); } }, icon('settings'), 'Gestisci')),
        editing,
        list,
        // Chi può solo leggere il canale non ha la barra per scrivere.
        canWrite
          ? h('div.chat-bar', input,
            h('button.btn.primary', { title: 'Invia (Invio; Maiusc+Invio per andare a capo)', 'aria-label': 'Invia', onclick: () => send(input, cur) }, icon('send')))
          : h('p.muted.chat-ro', icon('lock'), ` In #${cur.name} puoi solo leggere.`))));
}

// Notifica dei messaggi arrivati mentre si è altrove nell'app (o in un altro canale).
export function notifyNew(prevData, data, onChatPage) {
  if (!prevData?.chat) return;
  const lastSeen = prevData.chat.at(-1)?.id ?? 0;
  const cur = onChatPage ? currentChannel(data) : null;
  const fresh = data.chat.filter(m => m.id > lastSeen && m.user_id !== data.me.id && m.channel_id !== cur?.id);
  if (!fresh.length) return;
  const m = fresh.at(-1);
  const c = data.chatChannels.find(x => x.id === m.channel_id);
  const text = plainRefs(m.text).slice(0, 80);
  toast(`#${c?.name || 'chat'} · ${userName(m.user_id)}: ${text}`, { action: { label: 'Apri', fn: () => { ui.chatChannel = m.channel_id; location.hash = '#/chat'; render(); } } });
}
