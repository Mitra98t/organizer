// Language of the CLI: English, or Italian with ORG_LANG=it or an Italian system locale (LC_ALL, LC_MESSAGES, LANG,
// e.g. LANG=it_IT.UTF-8). The code is written in English; locales/it.js maps each English text to Italian.
// The server gets the same language (X-Lang header), so its errors arrive translated too.
//   tr('Saved')                         → "Saved" / "Salvato"
//   tr('Moved to {code}', { code })     → placeholders in braces
//   trn(n, '{n} note', '{n} notes')     → singular or plural
//   tr('to||mail recipient')            → after "||" a context that tells apart equal English texts
import it from './locales/it.js';

const env = process.env;
export const LANG = /^it\b|^it_/i.test(env.ORG_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || '') ? 'it' : 'en';
const dict = LANG === 'it' ? it : {};

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) : s);
const plain = s => { const i = s.indexOf('||'); return i < 0 ? s : s.slice(0, i); };
export const tr = (s, vars) => fill(dict[s] ?? plain(s), vars);
export const trn = (n, one, many, vars) => tr(n === 1 ? one : many, { n, ...vars });
