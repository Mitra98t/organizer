// Barra in basso (telefono): un tasto per gruppo (Progetti, Agenda, Magazzino, Mail, Impostazioni). Un tocco apre
// la pagina del tasto; tenendo premuto si apre attorno al dito un menu radiale con le pagine del gruppo (Agenda e
// Diario; Magazzino e Documenti; Mail, Contatti e Chat; Impostazioni, Cestino, Novità, Feedback): si scorre col
// dito su una e la si lascia. La pagina scelta prende il posto del tasto (si ricorda su questo dispositivo).
import { h, icon, load, save } from './core.js';

const GROUPS = [
  { key: 'progetti', items: [['progetti', 'Progetti', 'folder']] },
  { key: 'agenda', items: [['agenda', 'Agenda', 'agenda'], ['diario', 'Diario', 'diary']] },
  { key: 'magazzino', items: [['magazzino', 'Magazzino', 'box'], ['documenti', 'Documenti', 'file']] },
  { key: 'mail', items: [['mail', 'Mail', 'mail'], ['contatti', 'Contatti', 'contacts'], ['chat', 'Chat', 'chat']] },
  { key: 'impostazioni', items: [['impostazioni', 'Impostazioni', 'settings'], ['cestino', 'Cestino', 'trash'], ['novita', 'Novità', 'news'], ['feedback', 'Feedback', 'bug', true]] },
];
const HOLD_MS = 280;
const RADIUS = 124; // lontano dal dito, che altrimenti copre i tasti
const MARGIN = 44; // dai bordi dello schermo

const picks = load('org.tabPick', {}); // gruppo → pagina scelta dal menu radiale
let opts = null; // { allowed(key), action(key) }
const slots = [];
let state = { nav: null, badges: {} };

const members = g => g.items.filter(([k, , , act]) => act || opts.allowed(k));
// La pagina mostrata dal tasto: quella aperta, se è del gruppo; altrimenti quella scelta l'ultima volta.
function shown(g) {
  const list = members(g).filter(([, , , act]) => !act);
  return list.find(([k]) => k === state.nav) || list.find(([k]) => k === picks[g.key]) || list[0];
}

export function tabbar(o) {
  opts = o;
  slots.length = 0;
  const nav = h('nav.tabs', GROUPS.map(slot));
  // La sua altezza vera (con la zona sicura in basso) in --tabs-h: ci si appoggiano le barre fisse (es. la chat).
  new ResizeObserver(() => document.documentElement.style.setProperty('--tabs-h', `${nav.offsetHeight}px`)).observe(nav);
  return nav;
}

function slot(g) {
  const ic = h('span.tab-ic');
  const label = h('span.nl');
  const badge = h('span.nbadge');
  const a = h('a.tab', {
    'data-group': g.key,
    oncontextmenu: ev => ev.preventDefault(), // la pressione lunga apre il menu radiale, non quello del link
    onclick: ev => { if (press?.used) { ev.preventDefault(); press = null; } },
  }, ic, label, badge);
  a.addEventListener('pointerdown', ev => startPress(ev, s));
  const s = { g, a, ic, label, badge };
  slots.push(s);
  return a;
}

// Dopo ogni disegno dell'app: pagina aperta (nav di app.js) e numeri dei segnalini per pagina.
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
    // Il segnalino della pagina mostrata; se ce l'ha solo un'altra pagina del gruppo, un pallino.
    const own = badges[key];
    const other = members(s.g).some(([k]) => k !== key && badges[k]);
    s.badge.textContent = own || (other ? '•' : '');
    s.badge.classList.toggle('dot', !own && other);
  }
  slots[0]?.a.parentElement?.style.setProperty('grid-template-columns', `repeat(${visible}, 1fr)`);
}

// ---------- menu radiale ----------
let press = null; // { s, x, y, timer, open, used, pick }
const radial = h('div.radial', { hidden: true });

function startPress(ev, s) {
  if (ev.button > 0 || members(s.g).length < 2) return;
  press = { s, x: ev.clientX, y: ev.clientY, id: ev.pointerId, open: false, used: false, pick: null };
  press.timer = setTimeout(() => openRadial(), HOLD_MS);
  try { s.a.setPointerCapture(ev.pointerId); } catch { /* il dito è già andato via */ }
}

function openRadial() {
  const { s } = press;
  const list = members(s.g);
  press.open = true;
  press.used = true;
  navigator.vibrate?.(12);
  // Gli elementi su un arco attorno al dito, aperto verso il centro dello schermo (dal tasto a sinistra
  // si aprono verso destra, da quello a destra verso sinistra); se uscirebbero dallo schermo si spostano tutti.
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
    if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 12) cancel(); // si stava scorrendo, non tenendo premuto
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
  // Il clic che segue il rilascio non deve aprire la pagina del tasto (lo assorbe onclick, poi press si azzera).
  setTimeout(() => { press = null; }, 400);
}
