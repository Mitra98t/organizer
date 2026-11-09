// Parser for the quick-entry line. Shared by the browser and the server (no dependencies).
//
//   fix bootloader #SCH-042 @rover !fri +marco
//   m: quote for boards >supplier@company.example !tomorrow
//   n: rev B of SCH-042 needs fw >= 2.3 #SCH-042
//
// Recognised tokens (only at the start of a word). Dates understand English and Italian words:
//   t: m: n:   kind prefix (todo, mail, note)
//   !date      due date: today, tomorrow, yesterday, mon..sun, 3d, 2w, 1m, eom, 25/11, 2026-11-25, no
//              (Italian: oggi, domani, dopodomani, ieri, lun..dom, 3g, 2s, fm)
//   !eventually  no date, but it will happen sooner or later (Italian: !primaopoi)
//   ^ID        waits for entry ID
//   @tag       project (created if missing)
//   +user      shared with; ++user also assigned
//   >who       recipient (mail)
//   #CODE      inventory item (stays in the text, created if missing)

const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = fromYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
export const today = () => ymd(new Date());
export const isYmd = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Weekdays from Sunday, in both languages: a prefix of at least three letters is enough (fri, ven).
const WEEKDAYS = [
  ['sunday', 'domenica'], ['monday', 'lunedi'], ['tuesday', 'martedi'], ['wednesday', 'mercoledi'],
  ['thursday', 'giovedi'], ['friday', 'venerdi'], ['saturday', 'sabato'],
];
// !eventually: not "no due date" (forgotten, to be scheduled) but "it will happen, nobody knows when".
export const EVENTUALLY = ['eventually', 'primaopoi'];
const KIND_PREFIX = { t: 'todo', todo: 'todo', m: 'mail', mail: 'mail', n: 'note', nota: 'note', note: 'note' };
const WORDS = {
  today: 0, oggi: 0,
  tomorrow: 1, tmr: 1, domani: 1, dmn: 1,
  dopodomani: 2,
  yesterday: -1, ieri: -1,
};

function validDate(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? ymd(dt) : undefined;
}

// Returns 'YYYY-MM-DD', null (= remove the due date) or undefined (not a date).
// With past=true (journal notes) weekdays and dates without a year look backwards.
export function parseDate(tok, base = today(), { past = false } = {}) {
  const t = String(tok).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const ref = fromYmd(base);
  if (t in WORDS) return addDays(base, WORDS[t]);
  if (t === 'no' || t === 'none' || t === 'x') return null;
  if (t === 'eom' || t === 'fm' || t === 'finemese') return ymd(new Date(ref.getFullYear(), ref.getMonth() + 1, 0));

  const wd = t.length >= 3 ? WEEKDAYS.findIndex(names => names.some(w => w.startsWith(t))) : -1;
  if (wd >= 0) {
    return past
      ? addDays(base, -((ref.getDay() - wd + 7) % 7 || 7))
      : addDays(base, (wd - ref.getDay() + 7) % 7 || 7);
  }

  let m;
  // 3d / 3g days, 2w / 2s weeks, 1m months.
  if ((m = t.match(/^(\d{1,3})([dgswm])$/))) {
    const n = +m[1];
    if (m[2] === 'd' || m[2] === 'g') return addDays(base, n);
    if (m[2] === 'w' || m[2] === 's') return addDays(base, n * 7);
    const d = new Date(ref.getFullYear(), ref.getMonth() + n, 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return ymd(new Date(d.getFullYear(), d.getMonth(), Math.min(ref.getDate(), last)));
  }
  // Day first: 25/11, 25.11.26, 25-11-2026.
  if ((m = t.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/))) {
    const d = +m[1], mo = +m[2];
    if (m[3]) return validDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], mo, d);
    const thisYear = validDate(ref.getFullYear(), mo, d);
    if (!thisYear) return undefined;
    if (past) return thisYear > base ? validDate(ref.getFullYear() - 1, mo, d) : thisYear;
    return thisYear < base ? validDate(ref.getFullYear() + 1, mo, d) : thisYear;
  }
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return validDate(+m[1], +m[2], +m[3]);
  return undefined;
}

export const CODE_RE = /(^|[\s(\[,;:])#([A-Za-z0-9](?:[\w.\-/]*[A-Za-z0-9_])?)/g;

export function extractCodes(text) {
  const out = new Map();
  for (const m of String(text || '').matchAll(CODE_RE)) out.set(m[2].toUpperCase(), m[2]);
  return [...out.values()];
}

export function parseQuick(text, { today: base = today(), kind = 'todo' } = {}) {
  let s = String(text || '').trim();
  // shares: +person (they see it too); shareAll: +all (everyone sees it); assignee: ++person (they see it and
  // it is assigned to them). Without any of the three the entry is private to whoever writes it.
  // after: ^12 = the entry waits for entry 12 (it comes after it).
  // eventually: true with !eventually, false with any other date (the last date written wins).
  const out = { kind, kindExplicit: false, title: '', due: undefined, eventually: undefined, project: null, projects: [], assignee: null, shares: [], shareAll: false, contact: null, codes: [], after: [] };

  const pm = s.match(/^([a-z]+)\s*:\s*/i);
  if (pm && KIND_PREFIX[pm[1].toLowerCase()]) {
    out.kind = KIND_PREFIX[pm[1].toLowerCase()];
    out.kindExplicit = true;
    s = s.slice(pm[0].length);
  }

  const keep = [];
  for (const w of s.split(/\s+/)) {
    let m;
    if ((m = w.match(/^!(\S+)$/))) {
      if (out.kind !== 'note' && EVENTUALLY.includes(m[1].toLowerCase())) { out.due = null; out.eventually = true; continue; }
      const d = parseDate(m[1], base, { past: out.kind === 'note' });
      if (d !== undefined) { out.due = d; out.eventually = false; continue; }
    } else if ((m = w.match(/^@([\p{L}\d_][\p{L}\d_-]*)[.,;:]?$/u))) {
      // Several @projects: the first is the main one (out.project), all of them are in out.projects.
      if (!out.projects.some(t => t.toLowerCase() === m[1].toLowerCase())) out.projects.push(m[1]);
      out.project ||= m[1];
      continue;
    } else if ((m = w.match(/^(\+\+?)(\p{L}[\p{L}\d_.-]*)$/u))) {
      const share = shareToken(m[2]);
      if (share === ALL) out.shareAll = true;
      else {
        if (m[1] === '++') out.assignee = share;
        if (!out.shares.some(n => n.toLowerCase() === share.toLowerCase())) out.shares.push(share);
      }
      continue;
    } else if ((m = w.match(/^>([\p{L}\d]\S*)$/u))) {
      out.contact = m[1]; continue;
    } else if ((m = w.match(/^\^(\d+)[.,;:]?$/))) {
      if (!out.after.includes(+m[1])) out.after.push(+m[1]);
      continue;
    }
    if (w) keep.push(w);
  }
  out.title = keep.join(' ');
  out.codes = extractCodes(out.title);
  return out;
}

// Top bar on the Inventory page:  SCH-060 relay board /board @rover
// (first word = code, /category, @project to link it to, the rest is the description)
export const CODE_OK = /^[A-Za-z0-9](?:[\w.\-/]*[A-Za-z0-9_])?$/;

export function parseItemLine(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const out = { code: (words.shift() || '').replace(/^#/, ''), name: '', category: null, project: null };
  const rest = [];
  for (const w of words) {
    let m;
    if ((m = w.match(/^\/(\S+)$/))) out.category = m[1].replace(/_/g, ' ');
    else if ((m = w.match(/^@([\p{L}\d_][\p{L}\d_-]*)$/u))) out.project = m[1];
    else rest.push(w);
  }
  out.name = rest.join(' ');
  out.valid = CODE_OK.test(out.code);
  return out;
}

// Top bar on the Projects page:  Motor firmware @rover +marco  (→ subproject of @rover, shared)
export function parseProjectLine(text) {
  const out = { name: '', parent: null, share: [] };
  const rest = [];
  for (const w of String(text || '').trim().split(/\s+/).filter(Boolean)) {
    const m = w.match(/^@([\p{L}\d_][\p{L}\d_-]*)$/u);
    const s = w.match(/^\+\+?(\p{L}[\p{L}\d_.-]*)$/u);
    if (m) out.parent = m[1];
    else if (s) out.share.push(shareToken(s[1]));
    else rest.push(w);
  }
  out.name = rest.join(' ');
  return out;
}

// +all (or +tutti) means "everyone": that is why "all" cannot be a username.
export const ALL = 'all';
export const shareToken = name => (/^(all|tutti)$/i.test(name) ? ALL : name);

// +person and +all in free text (notes on documents): the names, and the text without them.
export function parseShares(text) {
  const out = { text: '', names: [], all: false };
  const keep = [];
  for (const w of String(text || '').split(/(\s+)/)) {
    const m = w.match(/^\+\+?(\p{L}[\p{L}\d_.-]*)$/u);
    if (!m) { keep.push(w); continue; }
    const s = shareToken(m[1]);
    if (s === ALL) out.all = true;
    else out.names.push(s);
  }
  out.text = keep.join('').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  return out;
}
