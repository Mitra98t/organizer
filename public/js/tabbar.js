// Bottom bar (phone): one button per group (Projects, Agenda, Inventory, Mail, Settings). A tap opens the button's
// page; a long press opens a radial menu around the finger with the group's pages (Agenda and Journal; Inventory
// and Documents; Mail, Contacts and Chat; Settings, Trash, What's new, Feedback): slide the finger onto one and
// release. The chosen page takes the button's place (remembered on this device).
import { h, icon, load, save } from './core.js';
import { tr } from './i18n.js';

const GROUPS = [
  { key: 'progetti', items: [['progetti', tr('Projects'), 'folder']] },
  { key: 'agenda', items: [['agenda', tr('Agenda'), 'agenda'], ['diario', tr('Journal'), 'diary']] },
  { key: 'magazzino', items: [['magazzino', tr('Inventory'), 'box'], ['documenti', tr('Documents'), 'file']] },
  { key: 'mail', items: [['mail', tr('Mail'), 'mail'], ['contatti', tr('Contacts'), 'contacts'], ['chat', tr('Chat'), 'chat']] },
  { key: 'impostazioni', items: [['impostazioni', tr('Settings'), 'settings'], ['cestino', tr('Trash'), 'trash'], ['novita', tr('What\'s new'), 'news'], ['feedback', tr('Feedback'), 'bug', true]] },
];
const HOLD_MS = 280;
const RADIUS = 124; // far from the finger, which would otherwise cover the buttons
const MARGIN = 44; // from the screen's edges

const picks = load('org.tabPick', {}); // group → page chosen from the radial menu
let opts = null; // { allowed(key), action(key) }
const slots = [];
let state = { nav: null, badges: {} };

const members = g => g.items.filter(([k, , , act]) => act || opts.allowed(k));
// The page the button shows: the open one, if it belongs to the group; otherwise the one chosen last time.
function shown(g) {
  const list = members(g).filter(([, , , act]) => !act);
  return list.find(([k]) => k === state.nav) || list.find(([k]) => k === picks[g.key]) || list[0];
}

export function tabbar(o) {
  opts = o;
  slots.length = 0;
  const nav = h('nav.tabs', GROUPS.map(slot));
  // Its real height (with the bottom safe area) in --tabs-h: fixed bars lean on it (e.g. the chat).
  new ResizeObserver(() => document.documentElement.style.setProperty('--tabs-h', `${nav.offsetHeight}px`)).observe(nav);
  return nav;
}

function slot(g) {
  const ic = h('span.tab-ic');
  const label = h('span.nl');
  const badge = h('span.nbadge');
  const a = h('a.tab', {
    'data-group': g.key,
    oncontextmenu: ev => ev.preventDefault(), // the long press opens the radial menu, not the link's one
    onclick: ev => { if (press?.used) { ev.preventDefault(); press = null; } },
  }, ic, label, badge);
  a.addEventListener('pointerdown', ev => startPress(ev, s));
  const s = { g, a, ic, label, badge };
  slots.push(s);
  return a;
}

// After every render of the app: the open page (app.js nav) and the badge counts per page.
export function updateTabbar(nav, badges) {
  state = { nav, badges };
  let visible = 0;
  for (const s of slots) {
    const cur = shown(s.g);
    s.a.hidden = !cur;
    if (!cur) continue;
    visible++;
    const [key, label, ic] = cur;
    s.a.href = `#/${key}`;
    s.ic.replaceChildren(icon(ic));
    s.label.textContent = label;
    s.a.classList.toggle('on', s.g.items.some(([k]) => k === nav));
    s.a.classList.toggle('more', members(s.g).length > 1);
    // The badge of the page shown; if only another page of the group has one, a dot.
    const own = badges[key];
    const other = members(s.g).some(([k]) => k !== key && badges[k]);
    s.badge.textContent = own || (other ? '•' : '');
    s.badge.classList.toggle('dot', !own && other);
  }
  slots[0]?.a.parentElement?.style.setProperty('grid-template-columns', `repeat(${visible}, 1fr)`);
}

// ---------- radial menu ----------
let press = null; // { s, x, y, timer, open, used, pick }
const radial = h('div.radial', { hidden: true });

function startPress(ev, s) {
  if (ev.button > 0 || members(s.g).length < 2) return;
  press = { s, x: ev.clientX, y: ev.clientY, id: ev.pointerId, open: false, used: false, pick: null };
  press.timer = setTimeout(() => openRadial(), HOLD_MS);
  try { s.a.setPointerCapture(ev.pointerId); } catch { /* the finger has already left */ }
}

function openRadial() {
  const { s } = press;
  const list = members(s.g);
  press.open = true;
  press.used = true;
  navigator.vibrate?.(12);
  // The items on an arc around the finger, open towards the centre of the screen (from the left button they open
  // to the right, from the right one to the left); if they would leave the screen they all move.
  const cx = press.x;
  const cy = press.y;
  const n = list.length;
  const span = n === 1 ? 0 : Math.min(150, 40 * (n - 1) + 30);
  const toward = (Math.atan2(innerHeight * 0.45 - cy, innerWidth / 2 - cx) * 180) / Math.PI;
  const pos = list.map((_, i) => {
    const deg = toward - span / 2 + (n === 1 ? 0 : (span * i) / (n - 1));
    return [Math.cos((deg * Math.PI) / 180) * RADIUS, Math.sin((deg * Math.PI) / 180) * RADIUS];
  });
  const shift = (lo, hi, vals, c) => Math.max(lo - (c + Math.min(...vals)), 0) - Math.max(c + Math.max(...vals) - hi, 0);
  const dx = shift(MARGIN, innerWidth - MARGIN, pos.map(p => p[0]), cx);
  const dy = shift(MARGIN + 20, innerHeight - MARGIN - 40, pos.map(p => p[1]), cy);
  press.items = list.map(([key, label, ic, act], i) => {
    const x = pos[i][0] + dx;
    const y = pos[i][1] + dy;
    const el = h('div.rad-i', { style: `--x:${x.toFixed(1)}px;--y:${y.toFixed(1)}px;--i:${i}`, class: [shown(s.g)?.[0] === key && 'cur', act && 'act'].filter(Boolean).join(' ') },
      h('span.rad-c', icon(ic), state.badges[key] ? h('span.nbadge', state.badges[key]) : null), h('span.rad-l', label));
    return { key, act, el, x: cx + x, y: cy + y };
  });
  radial.replaceChildren(h('div.rad-center', { style: `left:${cx}px;top:${cy}px` }, press.items.map(it => it.el)));
  if (!radial.isConnected) document.body.append(radial);
  radial.hidden = false;
  document.body.classList.add('radial-open');
}

function pickAt(x, y) {
  let best = null;
  for (const it of press.items) {
    const d = Math.hypot(it.x - x, it.y - y);
    if (d < 46 && (!best || d < best.d)) best = { it, d };
  }
  return best?.it || null;
}

document.addEventListener('pointermove', ev => {
  if (!press || ev.pointerId !== press.id) return;
  if (!press.open) {
    if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 12) cancel(); // it was scrolling, not a long press
    return;
  }
  ev.preventDefault();
  const it = pickAt(ev.clientX, ev.clientY);
  if (it !== press.pick) {
    press.pick?.el.classList.remove('hot');
    it?.el.classList.add('hot');
    if (it) navigator.vibrate?.(6);
    press.pick = it;
  }
}, { passive: false });

document.addEventListener('pointerup', ev => {
  if (!press || ev.pointerId !== press.id) return;
  clearTimeout(press.timer);
  if (!press.open) { press = press.used ? press : null; return; }
  const { s, pick } = press;
  closeRadial();
  if (!pick) return;
  if (pick.act) return opts.action(pick.key);
  picks[s.g.key] = pick.key;
  save('org.tabPick', picks);
  location.hash = `#/${pick.key}`;
});

document.addEventListener('pointercancel', () => cancel());

function cancel() {
  if (!press) return;
  clearTimeout(press.timer);
  if (press.open) closeRadial();
  press = null;
}

function closeRadial() {
  radial.hidden = true;
  radial.replaceChildren();
  document.body.classList.remove('radial-open');
  // The click after the release must not open the button's page (onclick absorbs it, then press resets).
  setTimeout(() => { press = null; }, 400);
}
