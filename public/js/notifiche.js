// In-app notifications: the bell with the latest ones (mentions, incoming mail, channel messages), opening a
// notification (also of another workspace) and system notifications (push) on this device.
// The server creates them (server/notify.js); the service worker (sw.js) shows them with the app closed too.
import { h, icon, S, api, act, render, toast, fmtTime, switchWorkspace, popButton, popItem, popSep } from './core.js';
import { tr } from './i18n.js';

const KIND_ICON = { mention: 'user', mail: 'mail', chat: 'chat', security: 'shield' };

// Opens where the notification leads: if it is from another workspace, switch there first (reloading the app).
export async function openNotification(n) {
  if (!n.read_at) {
    n.read_at = new Date().toISOString();
    api('POST', '/notifications/read', { ids: [n.id] }).catch(() => {});
  }
  if (n.workspace_id && n.workspace_id !== S.data.workspace.id) return switchWorkspace(n.workspace_id, n.url);
  location.hash = n.url || '#/agenda';
  render();
}

// #/n/ID: from a system notification (the service worker opens this address).
export function viewNotification(id) {
  api('GET', `/notifications/${id}`)
    .then(n => openNotification({ ...n, read_at: 'letta' }))
    .catch(e => { toast(e.message, { err: true }); location.hash = '#/agenda'; });
  return h('div.view', h('div.empty', h('p', tr('Opening the notification…'))));
}

// The bell at the top: the list opens like a menu.
export const bell = popButton('notifiche', [icon('bell'), h('span.nbadge.bell-n')], close => {
  const D = S.data;
  const list = D?.notifications || [];
  const wsName = id => D.workspaces?.find(w => w.id === id)?.name;
  return [
    h('div.pop-head', h('b', tr('Notifications')), h('span.grow'),
      D?.notifUnread > 0 && h('button.btn.sm.ghost', { type: 'button', onclick: () => act(() => api('POST', '/notifications/read', { all: true })) }, tr('Mark all read'))),
    !list.length && h('p.muted.pop-note', tr('No notifications. They arrive when someone mentions you (+person), assigns or shares something with you, when a mail arrives and for channel messages.')),
    list.map(n => popItem(h('span.nt', { class: n.read_at ? null : 'unread' },
      icon(KIND_ICON[n.kind] || 'bell'),
      h('span.nt-t', h('b', n.title), n.body && h('span.muted', n.body),
        h('span.muted.nt-w', fmtTime(n.created_at), n.workspace_id && n.workspace_id !== D.workspace.id && wsName(n.workspace_id) ? ` · ${wsName(n.workspace_id)}` : ''))),
    () => { close(); openNotification(n); })),
    popSep(),
    popItem(h('span', icon('settings'), ' ', tr('Notification settings')), () => { close(); location.hash = '#/impostazioni/notifiche'; }),
  ];
}, { class: 'bell', title: tr('Notifications'), 'aria-label': tr('Notifications') });

export function updateBell() {
  const n = S.data?.notifUnread || 0;
  bell.querySelector('.bell-n').textContent = n > 99 ? '99+' : n || '';
  bell.title = n ? tr('Notifications: {n} unread', { n }) : tr('Notifications');
}

// New notifications while the app is open: a toast at the bottom (the others stay in the bell). Those about the
// open page are marked read.
export function notifyNew(prev, data) {
  const here = location.hash;
  const unreadHere = (data.notifications || []).filter(n => !n.read_at && n.url === here && (!n.workspace_id || n.workspace_id === data.workspace.id));
  if (unreadHere.length) api('POST', '/notifications/read', { ids: unreadHere.map(n => n.id) }).catch(() => {});
  if (!prev?.notifications) return;
  const seen = new Set(prev.notifications.map(n => n.id));
  const fresh = data.notifications.filter(n => !seen.has(n.id) && !n.read_at && n.url !== here);
  if (!fresh.length) return;
  const n = fresh[0];
  toast(fresh.length > 1 ? tr('{title} (and {n} more)', { title: n.title, n: fresh.length - 1 }) : `${n.title}${n.body ? `: ${n.body.slice(0, 80)}` : ''}`,
    { action: { label: tr('Open'), fn: () => openNotification(n) } });
}

// ---------- system notifications (push) on this device ----------
const b64uToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));

// 'unsupported' (browser without push, or iPhone without the installed app), 'denied', 'on', 'off'.
export async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

export async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(tr('Permission denied: it is changed from the browser or system settings'));
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api('GET', '/push/key');
  let sub = await reg.pushManager.getSubscription();
  // The server's key changed (e.g. data restored from another server): subscribe again.
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
