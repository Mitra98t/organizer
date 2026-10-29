// Notifiche nell'app: la campanella con le ultime (citazioni, mail arrivate, messaggi nei canali), l'apertura
// di una notifica (anche di un altro workspace) e le notifiche di sistema (push) su questo dispositivo.
// Le crea il server (server/notify.js); il service worker (sw.js) le mostra anche ad app chiusa.
import { h, icon, S, api, act, render, toast, fmtTime, switchWorkspace, popButton, popItem, popSep } from './core.js';

const KIND_ICON = { mention: 'user', mail: 'mail', chat: 'chat' };

// Apre dove porta la notifica: se è di un altro workspace prima si passa lì (ricaricando l'app).
export async function openNotification(n) {
  if (!n.read_at) {
    n.read_at = new Date().toISOString();
    api('POST', '/notifications/read', { ids: [n.id] }).catch(() => {});
  }
  if (n.workspace_id && n.workspace_id !== S.data.workspace.id) return switchWorkspace(n.workspace_id, n.url);
  location.hash = n.url || '#/agenda';
  render();
}

// #/n/ID: da una notifica di sistema (il service worker apre questo indirizzo).
export function viewNotification(id) {
  api('GET', `/notifications/${id}`)
    .then(n => openNotification({ ...n, read_at: 'letta' }))
    .catch(e => { toast(e.message, { err: true }); location.hash = '#/agenda'; });
  return h('div.view', h('div.empty', h('p', 'Apro la notifica…')));
}

// La campanella in alto: l'elenco si apre come un menu.
export const bell = popButton('notifiche', [icon('bell'), h('span.nbadge.bell-n')], close => {
  const D = S.data;
  const list = D?.notifications || [];
  const wsName = id => D.workspaces?.find(w => w.id === id)?.name;
  return [
    h('div.pop-head', h('b', 'Notifiche'), h('span.grow'),
      D?.notifUnread > 0 && h('button.btn.sm.ghost', { type: 'button', onclick: () => act(() => api('POST', '/notifications/read', { all: true })) }, 'Segna tutte lette')),
    !list.length && h('p.muted.pop-note', 'Nessuna notifica. Arrivano quando qualcuno ti cita (+persona), ti assegna o condivide qualcosa, quando arriva una mail e per i messaggi nei canali.'),
    list.map(n => popItem(h('span.nt', { class: n.read_at ? null : 'unread' },
      icon(KIND_ICON[n.kind] || 'bell'),
      h('span.nt-t', h('b', n.title), n.body && h('span.muted', n.body),
        h('span.muted.nt-w', fmtTime(n.created_at), n.workspace_id && n.workspace_id !== D.workspace.id && wsName(n.workspace_id) ? ` · ${wsName(n.workspace_id)}` : ''))),
    () => { close(); openNotification(n); })),
    popSep(),
    popItem(h('span', icon('settings'), ' Impostazioni notifiche'), () => { close(); location.hash = '#/impostazioni/notifiche'; }),
  ];
}, { class: 'bell', title: 'Notifiche', 'aria-label': 'Notifiche' });

export function updateBell() {
  const n = S.data?.notifUnread || 0;
  bell.querySelector('.bell-n').textContent = n > 99 ? '99+' : n || '';
  bell.title = n ? `Notifiche: ${n} da leggere` : 'Notifiche';
}

// Nuove notifiche mentre l'app è aperta: un avviso in basso (le altre restano nella campanella). Quelle che
// riguardano la pagina aperta si segnano lette.
export function notifyNew(prev, data) {
  const here = location.hash;
  const unreadHere = (data.notifications || []).filter(n => !n.read_at && n.url === here && (!n.workspace_id || n.workspace_id === data.workspace.id));
  if (unreadHere.length) api('POST', '/notifications/read', { ids: unreadHere.map(n => n.id) }).catch(() => {});
  if (!prev?.notifications) return;
  const seen = new Set(prev.notifications.map(n => n.id));
  const fresh = data.notifications.filter(n => !seen.has(n.id) && !n.read_at && n.url !== here);
  if (!fresh.length) return;
  const n = fresh[0];
  toast(fresh.length > 1 ? `${n.title} (e altre ${fresh.length - 1})` : `${n.title}${n.body ? `: ${n.body.slice(0, 80)}` : ''}`,
    { action: { label: 'Apri', fn: () => openNotification(n) } });
}

// ---------- notifiche di sistema (push) su questo dispositivo ----------
const b64uToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));

// 'unsupported' (browser senza push, o iPhone senza l'app installata), 'denied', 'on', 'off'.
export async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

export async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permesso negato: si cambia dalle impostazioni del browser o del sistema');
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api('GET', '/push/key');
  let sub = await reg.pushManager.getSubscription();
  // Chiave del server cambiata (es. dati ripristinati da un altro server): si rifà l'iscrizione.
  if (sub && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey || []))).replace(/=+$/, '') !== btoa(String.fromCharCode(...b64uToBytes(key))).replace(/=+$/, '')) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
  await api('POST', '/push/subscribe', sub.toJSON());
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}
