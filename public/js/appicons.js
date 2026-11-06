// App icons: one per theme (with its colours) and some minimal ones, chosen in Settings → Appearance independently
// of the theme ("automatic" follows the theme). Only the descriptions are here; the server draws them
// (server/appicons.js) as SVG and PNG. The choice is per device (localStorage "org.icon"): it changes at once the
// browser tab's icon and the one the system takes when the app is installed.
//
// glyph: classic (box with the tick, the usual one) · check (only the tick) · dot (a dot) · ring (a circle) ·
// tile (full box with the tick). bg/bg2: background (bg2 = gradient towards the bottom) · box: the box · mark: the
// tick, the dot or the circle.
import { THEMES } from './themes.js';
import { tr } from './i18n.js';

const hex = c => c.replace('#', '').match(/../g).map(x => parseInt(x, 16));
const mixHex = (a, b, t) => `#${hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;

// Gradients of the funky themes (top → bottom).
const GRAD = {
  synthwave: ['#4a2370', '#1a1626'], vaporwave: ['#ff71ce', '#2f1a5c'], halloween: ['#3a1d12', '#120c12'],
  bubblegum: ['#ffc2e2', '#fff6fb'], sorbetto: ['#ffe0f0', '#dff7ee'], limonata: ['#fff27a', '#fbffe0'],
};

export const APP_ICONS = [
  { id: 'organizer', name: 'Organizer', group: 'base', glyph: 'classic', bg: '#0e1014', box: '#3a4150', mark: '#2fd2a2' },
  { id: 'organizer-light', name: tr('Organizer light'), group: 'base', glyph: 'classic', bg: '#f5f6f8', box: '#c9ced8', mark: '#0d9b74' },
  { id: 'min-dark', name: tr('Black tick'), group: 'minimal', glyph: 'check', bg: '#000000', mark: '#ffffff' },
  { id: 'min-light', name: tr('White tick'), group: 'minimal', glyph: 'check', bg: '#ffffff', mark: '#111111' },
  { id: 'min-green', name: tr('Green tick'), group: 'minimal', glyph: 'check', bg: '#2fd2a2', mark: '#052419' },
  { id: 'min-dot', name: tr('Dot'), group: 'minimal', glyph: 'dot', bg: '#0e1014', mark: '#2fd2a2' },
  { id: 'min-ring', name: tr('Circle'), group: 'minimal', glyph: 'ring', bg: '#f2f0eb', mark: '#1a1a1a' },
  { id: 'min-tile', name: tr('Box'), group: 'minimal', glyph: 'tile', bg: '#15181e', mark: '#e5e8ee' },
  ...Object.entries(THEMES).map(([id, t]) => ({
    id: `t-${id}`, name: t.name, group: t.funky ? 'funky' : 'tema', glyph: 'classic',
    bg: GRAD[id]?.[0] || t.bg, bg2: GRAD[id]?.[1] || null, box: mixHex(t.line, t.muted, 0.35), mark: t.accent,
  })),
];

export const iconById = id => APP_ICONS.find(i => i.id === id);

// The "automatic" icon: the chosen theme's (Organizer themes: dark, or light for the light theme).
export const themeIcon = themeId => (THEMES[themeId] ? `t-${themeId}` : themeId === 'light' ? 'organizer-light' : 'organizer');

export const currentIcon = () => {
  try { return localStorage.getItem('org.icon') || 'auto'; } catch { return 'auto'; }
};

// The icon to use now and the page links pointing to it (browser tab, iPhone/iPad, installation), plus the logo at
// the top left (img.app-logo).
let active = 'organizer';
export const logoSrc = () => `icons/app/${active}.svg`;

export function applyIcon(themeId) {
  const pick = currentIcon();
  const id = pick !== 'auto' && iconById(pick) ? pick : themeIcon(themeId);
  active = id;
  document.querySelectorAll('img.app-logo').forEach(i => { i.src = logoSrc(); });
  const set = (sel, href) => document.querySelectorAll(sel).forEach(l => l.setAttribute('href', href));
  set('link[rel="icon"]', `icons/app/${id}.svg`);
  set('link[rel="apple-touch-icon"]', `icons/app/${id}-180.png`);
  set('link[rel="manifest"]', `manifest.webmanifest?icon=${encodeURIComponent(id)}`);
  return id;
}

export function setIcon(id, themeId) {
  try { localStorage.setItem('org.icon', id); } catch { /* private mode: only until the app is closed */ }
  return applyIcon(themeId);
}
