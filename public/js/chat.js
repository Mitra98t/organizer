// Chat del workspace: messaggi tra i membri, con collegamenti a progetti, articoli, documenti, voci e contatti
// (autocompletamento con @ # + e "[["). Gli ultimi 100 messaggi arrivano con /api/sync, i precedenti a richiesta.
import { h, icon, S, ui, api, act, render, userName, chatText, fmtTime, fmtLongDay, localDay, toast, plainRefs } from './core.js';

const GROUP_MS = 5 * 60e3; // messaggi ravvicinati della stessa persona: un'intestazione sola
let older = [];            // caricati con "Messaggi precedenti" (non stanno nei dati sincronizzati)
let olderDone = false;
let stick = true;          // la lista resta in fondo finché non si scorre verso l'alto
let scrollTop = 0;
let fromBottom = null;     // dopo aver caricato i precedenti: resta fermo sul messaggio che si stava leggendo

// Tutto ciò che si vede è letto (se la finestra è in primo piano).
function markRead(D) {
  const last = D.chat.at(-1)?.id || 0;
  if (document.visibilityState !== 'visible' || last <= D.chatReadId) return;
  D.chatReadId = last;
  D.chatUnread = 0;
  api('POST', '/chat/read', { id: last }).catch(() => {});
  queueMicrotask(render); // aggiorna il numero sui badge
}

async function send(ta) {
  const text = ta.value.trim();
  if (!text) return;
  ta.value = '';
  ui.chatDraft = '';
  stick = true;
  const ok = await act(() => api('POST', '/chat', { text }).then(() => true));
  if (!ok) {
    ta.value = text;
    ui.chatDraft = text;
  }
}

async function loadOlder(first) {
  const list = await act(() => api('GET', `/chat?before=${first}&limit=100`));
  if (!list) return;
  if (list.length < 100) olderDone = true;
  older = [...list, ...older];
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
    value: m.text, rows: 1, 'data-fk': `chat-edit-${m.id}`, 'data-ac': 'chat', 'data-ac-only': '@#+',
    onkeydown: ev => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); ev.target.blur(); }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); ui.chatEdit = null; render(); }
    },
    onblur: done,
  });
}

function message(m, D, head) {
  const mine = m.user_id === D.me.id;
  const editing = ui.chatEdit === m.id;
  return h('div.msg', { class: [mine && 'mine', head && 'first'].filter(Boolean).join(' ') || null, 'data-id': m.id },
    head && h('div.msg-h', h('b', userName(m.user_id)), h('span.muted', fmtTime(m.created_at).split(' ').pop())),
    editing ? editBox(m) : h('div.msg-t', chatText(m.text), m.edited_at && h('span.muted.msg-ed', { title: `modificato ${fmtTime(m.edited_at)}` }, ' (modificato)')),
    !editing && (mine || D.me.is_admin) && h('div.msg-a',
      mine && h('button.icon-btn.sm', { title: 'Modifica', onclick: () => { ui.chatEdit = m.id; render(); } }, icon('edit')),
      h('button.icon-btn.sm', {
        title: 'Elimina',
        onclick: () => { if (confirm('Eliminare il messaggio?')) act(() => api('DELETE', `/chat/${m.id}`)); },
      }, icon('trash'))));
}

export function viewChat() {
  const D = S.data;
  const ids = new Set(D.chat.map(m => m.id));
  const msgs = [...older.filter(m => !ids.has(m.id) && m.id < (D.chat[0]?.id ?? Infinity)), ...D.chat];

  const rows = [];
  let prev = null;
  for (const m of msgs) {
    const day = localDay(m.created_at);
    if (!prev || localDay(prev.created_at) !== day) rows.push(h('div.chat-day', h('span', fmtLongDay(day))));
    const head = !prev || prev.user_id !== m.user_id || localDay(prev.created_at) !== day
      || Date.parse(m.created_at) - Date.parse(prev.created_at) > GROUP_MS;
    rows.push(message(m, D, head));
    prev = m;
  }

  const list = h('div.chat-list', {
    onscroll: ev => {
      const el = ev.target;
      scrollTop = el.scrollTop;
      stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    },
  },
  D.chat.length >= 100 && !olderDone && h('button.btn.sm.ghost.chat-older', { onclick: () => loadOlder(msgs[0].id) }, 'Messaggi precedenti'),
  msgs.length ? rows : h('div.empty',
    h('p', 'Nessun messaggio. Scrivi qualcosa ai membri del workspace.'),
    h('p', 'Nel messaggio ', h('code.k', '@progetto'), ' ', h('code.k', '#CODICE'), ' ', h('code.k', '+persona'),
      ' e ', h('code.k', '[['), ' per collegare un documento, una voce o un contatto: diventano link.')));

  const input = h('textarea.chat-in', {
    rows: 1, value: ui.chatDraft, placeholder: 'Messaggio… (@ # + e [[ per collegare)',
    'data-fk': 'chat-in', 'data-ac': 'chat', 'data-ac-only': '@#+', enterkeyhint: 'send',
    oninput: ev => { ui.chatDraft = ev.target.value; },
    onkeydown: ev => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        send(ev.target);
      }
    },
  });

  // Dopo che la vista è nella pagina: posizione di lettura e messaggi letti.
  queueMicrotask(() => {
    if (!list.isConnected) return;
    if (fromBottom != null) list.scrollTop = list.scrollHeight - fromBottom;
    else list.scrollTop = stick ? list.scrollHeight : scrollTop;
    fromBottom = null;
    if (stick) markRead(D);
  });

  return h('div.view.chat',
    list,
    h('div.chat-bar', input,
      h('button.btn.primary', { title: 'Invia (Invio; Maiusc+Invio per andare a capo)', onclick: () => send(input) }, icon('send'))));
}

// Notifica dei messaggi arrivati mentre si è altrove nell'app.
export function notifyNew(prevData, data, onChatPage) {
  if (!prevData?.chat || onChatPage) return;
  const lastSeen = prevData.chat?.at(-1)?.id ?? 0;
  const fresh = data.chat.filter(m => m.id > lastSeen && m.user_id !== data.me.id);
  if (!fresh.length) return;
  const m = fresh.at(-1);
  const text = plainRefs(m.text).slice(0, 80);
  toast(`${userName(m.user_id)}: ${text}`, { action: { label: 'Apri chat', fn: () => { location.hash = '#/chat'; } } });
}
