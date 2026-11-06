// Interface language. The code is written in English; a translation maps each English text to its version in
// that language (locales/it.js). The choice is per device (Settings → App), otherwise the browser's language.
//   tr('Saved')                                → "Saved" / "Salvato"
//   tr('Moved to {code}', { code })            → placeholders in braces
//   trn(n, '{n} note', '{n} notes')            → singular or plural
//   tr('Open||project status')                  → after "||" a context that tells apart equal English texts
//                                                (the English text is the part before it)
import it from './locales/it.js';

export const LANGS = { en: 'English', it: 'Italiano' };
const CATALOGS = { it };

function pick() {
  if (typeof document === 'undefined') return 'en'; // imported by the server (appicons.js): English
  try {
    const saved = localStorage.getItem('org.lang');
    if (saved in LANGS) return saved;
  } catch { /* private mode: fall back to the browser */ }
  return /^it\b/i.test(navigator.language || '') ? 'it' : 'en';
}

export const LANG = pick();
const dict = CATALOGS[LANG] || {};
if (typeof document !== 'undefined') document.documentElement.lang = LANG;

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) : s);
const plain = s => { const i = s.indexOf('||'); return i < 0 ? s : s.slice(0, i); };
export const tr = (s, vars) => fill(dict[s] ?? plain(s), vars);
export const trn = (n, one, many, vars) => tr(n === 1 ? one : many, { n, ...vars });

// Locale for dates and numbers (toLocaleString).
export const LOCALE = LANG === 'it' ? 'it-IT' : 'en-GB';

export function setLang(lang) {
  try { localStorage.setItem('org.lang', lang); } catch { /* private mode: only until the page reloads */ }
  location.reload();
}
