// Parser della riga di inserimento rapido. Condiviso tra browser e server (nessuna dipendenza).
//
//   fix bootloader #SCH-042 @rover !ven +marco
//   m: preventivo schede >fornitore@ditta.it !domani
//   n: la SCH-042 rev B vuole il fw >= 2.3 #SCH-042
//
// Token riconosciuti (solo a inizio parola):
//   t: m: n:   prefisso tipo (todo, mail, nota)
//   !data      scadenza: oggi, domani, dopodomani, ieri, lun..dom, 3g, 2s, 1m, fm, 25/11, 2026-11-25, no
//   @tag       progetto (creato se non esiste)
//   +utente    assegnatario
//   >chi       destinatario (mail)
//   #CODICE    articolo di magazzino (resta nel testo, creato se non esiste)

const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = fromYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
export const today = () => ymd(new Date());
export const isYmd = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

const WEEKDAYS = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
const KIND_PREFIX = { t: 'todo', todo: 'todo', m: 'mail', mail: 'mail', n: 'note', nota: 'note', note: 'note' };

function validDate(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? ymd(dt) : undefined;
}

// Ritorna 'YYYY-MM-DD', null (= togli la scadenza) oppure undefined (non è una data).
// Con past=true (note del diario) giorni della settimana e date senza anno guardano indietro.
export function parseDate(tok, base = today(), { past = false } = {}) {
  const t = String(tok).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const ref = fromYmd(base);
  if (t === 'oggi') return base;
  if (t === 'domani' || t === 'dmn') return addDays(base, 1);
  if (t === 'dopodomani') return addDays(base, 2);
  if (t === 'ieri') return addDays(base, -1);
  if (t === 'no' || t === 'x') return null;
  if (t === 'fm' || t === 'finemese') return ymd(new Date(ref.getFullYear(), ref.getMonth() + 1, 0));

  const wd = t.length >= 3 ? WEEKDAYS.findIndex(w => w.startsWith(t)) : -1;
  if (wd >= 0) {
    return past
      ? addDays(base, -((ref.getDay() - wd + 7) % 7 || 7))
      : addDays(base, (wd - ref.getDay() + 7) % 7 || 7);
  }

  let m;
  if ((m = t.match(/^(\d{1,3})([gsm])$/))) {
    const n = +m[1];
    if (m[2] === 'g') return addDays(base, n);
    if (m[2] === 's') return addDays(base, n * 7);
    const d = new Date(ref.getFullYear(), ref.getMonth() + n, 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return ymd(new Date(d.getFullYear(), d.getMonth(), Math.min(ref.getDate(), last)));
  }
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
  const out = { kind, kindExplicit: false, title: '', due: undefined, project: null, assignee: null, contact: null, codes: [] };

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
      const d = parseDate(m[1], base, { past: out.kind === 'note' });
      if (d !== undefined) { out.due = d; continue; }
    } else if ((m = w.match(/^@([\p{L}\d_][\p{L}\d_-]*)[.,;:]?$/u))) {
      out.project = m[1]; continue;
    } else if ((m = w.match(/^\+(\p{L}[\p{L}\d_.-]*)$/u))) {
      out.assignee = m[1]; continue;
    } else if ((m = w.match(/^>([\p{L}\d]\S*)$/u))) {
      out.contact = m[1]; continue;
    }
    if (w) keep.push(w);
  }
  out.title = keep.join(' ');
  out.codes = extractCodes(out.title);
  return out;
}

// Barra in alto nella pagina Magazzino:  SCH-060 scheda relè /scheda @rover
// (primo termine = codice, /categoria, @progetto a cui collegarlo, il resto è la descrizione)
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

// Barra in alto nella pagina Progetti:  Firmware motori @rover  (→ sottoprogetto di @rover)
export function parseProjectLine(text) {
  const out = { name: '', parent: null };
  const rest = [];
  for (const w of String(text || '').trim().split(/\s+/).filter(Boolean)) {
    const m = w.match(/^@([\p{L}\d_][\p{L}\d_-]*)$/u);
    if (m) out.parent = m[1];
    else rest.push(w);
  }
  out.name = rest.join(' ');
  return out;
}
