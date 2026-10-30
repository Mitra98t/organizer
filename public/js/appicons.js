// Icone dell'app: una per tema (con i suoi colori) e alcune minimal, scelte in Impostazioni → Aspetto
// indipendentemente dal tema ("automatica" segue il tema). Qui ci sono solo le descrizioni; le disegna il server
// (server/appicons.js) in SVG e in PNG. La scelta vale per il dispositivo (localStorage "org.icon"): cambia
// subito l'icona della scheda del browser e quella che il sistema prende quando si installa l'app.
//
// glyph: classic (casella con la spunta, quella di sempre) · check (solo la spunta) · dot (un punto) ·
// ring (un cerchio) · tile (casella piena con la spunta). bg/bg2: sfondo (bg2 = sfumato verso il basso) ·
// box: la casella · mark: la spunta, il punto o il cerchio.
import { THEMES } from './themes.js';

const hex = c => c.replace('#', '').match(/../g).map(x => parseInt(x, 16));
const mixHex = (a, b, t) => `#${hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;

// Sfumature dei temi funky (in alto → in basso).
const GRAD = {
  synthwave: ['#4a2370', '#1a1626'], vaporwave: ['#ff71ce', '#2f1a5c'], halloween: ['#3a1d12', '#120c12'],
  bubblegum: ['#ffc2e2', '#fff6fb'], sorbetto: ['#ffe0f0', '#dff7ee'], limonata: ['#fff27a', '#fbffe0'],
};

export const APP_ICONS = [
  { id: 'organizer', name: 'Organizer', group: 'base', glyph: 'classic', bg: '#0e1014', box: '#3a4150', mark: '#2fd2a2' },
  { id: 'organizer-light', name: 'Organizer chiaro', group: 'base', glyph: 'classic', bg: '#f5f6f8', box: '#c9ced8', mark: '#0d9b74' },
  { id: 'min-dark', name: 'Spunta nera', group: 'minimal', glyph: 'check', bg: '#000000', mark: '#ffffff' },
  { id: 'min-light', name: 'Spunta bianca', group: 'minimal', glyph: 'check', bg: '#ffffff', mark: '#111111' },
  { id: 'min-green', name: 'Spunta verde', group: 'minimal', glyph: 'check', bg: '#2fd2a2', mark: '#052419' },
  { id: 'min-dot', name: 'Punto', group: 'minimal', glyph: 'dot', bg: '#0e1014', mark: '#2fd2a2' },
  { id: 'min-ring', name: 'Cerchio', group: 'minimal', glyph: 'ring', bg: '#f2f0eb', mark: '#1a1a1a' },
  { id: 'min-tile', name: 'Casella', group: 'minimal', glyph: 'tile', bg: '#15181e', mark: '#e5e8ee' },
  ...Object.entries(THEMES).map(([id, t]) => ({
    id: `t-${id}`, name: t.name, group: t.funky ? 'funky' : 'tema', glyph: 'classic',
    bg: GRAD[id]?.[0] || t.bg, bg2: GRAD[id]?.[1] || null, box: mixHex(t.line, t.muted, 0.35), mark: t.accent,
  })),
];

export const iconById = id => APP_ICONS.find(i => i.id === id);

// L'icona "automatica": quella del tema scelto (i temi di Organizer: scura, o chiara per il tema chiaro).
export const themeIcon = themeId => (THEMES[themeId] ? `t-${themeId}` : themeId === 'light' ? 'organizer-light' : 'organizer');

export const currentIcon = () => {
  try { return localStorage.getItem('org.icon') || 'auto'; } catch { return 'auto'; }
};

// L'icona da usare adesso e i link della pagina che la indicano (scheda del browser, iPhone/iPad, installazione),
// più il logo in alto a sinistra (img.app-logo).
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
  try { localStorage.setItem('org.icon', id); } catch { /* modalità privata: vale fino alla chiusura */ }
  return applyIcon(themeId);
}
