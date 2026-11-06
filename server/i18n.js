// Server texts in the language of whoever asks. The code is written in English; locales/it.js maps each English
// text to Italian. Placeholders in braces: trIn('it', 'Item {code} not found', { code }). A placeholder whose name
// starts with _ is itself translated: trIn('it', 'the {_area} area', { _area: 'Inventory' }).
//  - errors (fail) are translated when the response is sent, in the request's language;
//  - texts generated during a request (default subjects, log lines…) use tr(), the request's language;
//  - notifications and other texts for someone else use that person's language (users.lang, see notify.js).
import { AsyncLocalStorage } from 'node:async_hooks';
import it from './locales/it.js';

export const LANGS = ['en', 'it'];
const CATALOGS = { it };
const als = new AsyncLocalStorage();

const fill = (lang, s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k[0] === '_' ? trIn(lang, vars[k]) : vars[k]) ?? m) : s);
// After "||" a context that tells apart equal English texts ("Open||project status"): English shows the part before it.
const plain = s => { const i = s.indexOf('||'); return i < 0 ? s : s.slice(0, i); };
export const trIn = (lang, s, vars) => fill(lang, CATALOGS[lang]?.[s] ?? plain(s), vars);

// The language of a request: the app and the CLI send X-Lang; otherwise the browser's Accept-Language.
export function langOf(req) {
  const x = String(req.headers['x-lang'] || '').toLowerCase();
  if (LANGS.includes(x)) return x;
  return /^it\b/i.test(String(req.headers['accept-language'] || '')) ? 'it' : 'en';
}

// The language of the terminal (server/cli.js and the make commands): LANG / LC_ALL.
export const sysLang = () => (/^it/i.test(process.env.ORG_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '') ? 'it' : 'en');

export const withLang = (lang, fn) => als.run(lang, fn);
export const currentLang = () => als.getStore() || 'en';
export const tr = (s, vars) => trIn(currentLang(), s, vars);
