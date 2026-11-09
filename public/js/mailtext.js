// Text of a received mail, read the way a mail program shows it: quotes (> lines) indented, also nested, so that
// replies written between the quoted lines ("inline") stay readable; the quote at the bottom (the whole previous
// message, "On … wrote:" or "-----Original Message-----") folded; the history Outlook appends (From: / Sent: / To: /
// Subject: …) split into its messages, each with a compact header; forwarded messages visible; the signature in
// grey; links clickable; the noise of mails converted from HTML ([cid:…] images, <mailto:…>) removed.
// parseMail() is plain data (tested without a browser), mailBody() draws it.

// "On Mon, 3 Nov 2026 Mirko <…> wrote:" in a few languages (it may be split on two lines by the mail program).
const ATTR = /^((On|Il|Am|Le|El|Op)\s.{4,300}(wrote|scritto|schrieb|écrit|escribió|schreef)\s*:|Am\s.{4,200}\sschrieb\s.{1,150}:)\s*$/i;
const ATTR_START = /^(On|Il|Am|Le|El|Op)\s.{4,200}$/i;
const ATTR_END = /(wrote|scritto|schrieb|écrit|escribió|schreef)\s*:\s*$/i;
// Outlook and similar quote without ">": from here on it is the previous message.
const ORIGINAL = /^-{2,}\s*(Original Message|Messaggio originale|Ursprüngliche Nachricht|Message d'origine)\s*-*$/i;
const HEADER = /^\*?(From|Da|Von|De)\s*:\*?\s.+/i;
const HEADER_NEXT = /^\*?(Sent|Inviato|Gesendet|Envoyé|Date|Data|To|A|An|Subject|Oggetto)\s*:/i;
const FORWARD = /^(-{2,}\s*(Forwarded message|Messaggio inoltrato|Weitergeleitete Nachricht|Message transféré)\s*-*|Begin forwarded message:|Inizio messaggio inoltrato:)$/i;
const SIG = /^--\s?$/;
// The header fields of a quoted message, in a few languages.
const FIELDS = [
  ['from', /^(from|da|von|de)$/i], ['date', /^(sent|inviato|gesendet|envoyé|date|data|datum|enviado)$/i],
  ['to', /^(to|a|an|à|para)$/i], ['cc', /^(cc|ccn|bcc)$/i], ['subject', /^(subject|oggetto|betreff|objet|asunto)$/i],
];

const depthOf = line => line.match(/^(\s*>)+/)?.[0].replace(/[^>]/g, '').length || 0;
const unquote = line => line.replace(/^\s*>\s?/, '');
const isHeaderStart = (lines, i) => HEADER.test(lines[i].trim()) && lines.slice(i + 1, i + 5).some(l => HEADER_NEXT.test(l.trim()));

// Noise of mails converted from HTML: inline images, addresses and links written twice.
export function clean(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\[cid:[^\]\n]*\]/gi, '')
    .replace(/([\w.+-]+@[\w-]+(?:\.[\w-]+)+)\s*<mailto:\1>/gi, '$1')
    .replace(/<mailto:[^>\s]+>/gi, '')
    .replace(/(https?:\/\/[^\s<>]+)\s*<\1>/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, ' $1')
    .replace(/[ \t]+$/gm, '');
}

// Blocks: { type: 'text' | 'sig', text } | { type: 'attr', text, who, when } | { type: 'quote', blocks }
//   | { type: 'original', messages: [{ headers: {from, date, to, cc, subject}, blocks }] } | { type: 'forward', head, text }.
// The last quote (or original message) with nothing written after it has tail: true.
export function parseMail(raw) {
  const lines = clean(raw).replace(/\n+$/, '').split('\n');
  const blocks = parseLines(lines);
  markTail(blocks);
  return blocks;
}

function parseLines(lines, nested = false) {
  const out = [];
  let i = 0;
  const push = (type, text) => {
    const last = out.at(-1);
    if (last && last.type === type && (type === 'text' || type === 'sig')) last.text += `\n${text}`;
    else out.push({ type, text });
  };
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (depthOf(line)) {
      // A run of quoted lines: one level less, read again (inside there may be replies and quotes too).
      const run = [];
      while (i < lines.length && (depthOf(lines[i]) || (!lines[i].trim() && depthOf(lines[i + 1] || '')))) run.push(unquote(lines[i++]));
      out.push({ type: 'quote', blocks: parseLines(run, true) });
      continue;
    }
    if (!nested && FORWARD.test(t)) {
      out.push({ type: 'forward', head: t.replace(/^-+\s*|\s*-+$/g, ''), text: tidy(lines.slice(i + 1).join('\n')) });
      break;
    }
    if (ORIGINAL.test(t) || isHeaderStart(lines, i)) {
      out.push({ type: 'original', messages: parseOriginal(lines.slice(i)) });
      break;
    }
    if (ATTR.test(t)) { out.push(attribution(t)); i++; continue; }
    // Attribution split on two lines: "On Mon … Mirko" / "<mirko@…> wrote:".
    if (ATTR_START.test(t) && ATTR_END.test((lines[i + 1] || '').trim()) && depthOf(lines[i + 2] || '')) {
      out.push(attribution(`${t} ${lines[i + 1].trim()}`));
      i += 2;
      continue;
    }
    if (SIG.test(line)) {
      // Signature: until the next quote (in "top posting" the quote comes after it).
      const sig = [];
      i++;
      while (i < lines.length && !depthOf(lines[i]) && !ATTR.test(lines[i].trim()) && !ORIGINAL.test(lines[i].trim())
        && !FORWARD.test(lines[i].trim()) && !isHeaderStart(lines, i)) sig.push(lines[i++]);
      if (sig.join('').trim()) out.push({ type: 'sig', text: tidy(sig.join('\n')) });
      continue;
    }
    push('text', line);
    i++;
  }
  // No empty blocks of text (blank lines between a reply and a quote), no runs of blank lines.
  return out.filter(b => b.type !== 'text' || b.text.trim()).map(b => (b.type === 'text' ? { ...b, text: tidy(b.text) } : b));
}

const tidy = s => s.replace(/^\n+|\s+$/g, '').replace(/\n{3,}/g, '\n\n');

// "On Mon, 3 Nov 2026 at 10:12, Fede <fede@…> wrote:" → who: Fede, when: Mon, 3 Nov 2026 at 10:12.
function attribution(text) {
  const out = { type: 'attr', text };
  // The date (with the time, if there is one) ends with the year or the time; then the name, maybe <address>.
  const m = text.match(/^(?:On|Il(?: giorno)?|Am|Le|El|Op)\s+(.*?\d{4}(?:,?\s+(?:at|alle(?: ore)?|um|à|a las)?,?\s*\d{1,2}[:.]\d{2}(?:\s?[AaPp]\.?[Mm]\.?)?)?),?\s+(.+?)\s*(?:<[^>]*>|\([^)]*@[^)]*\))?\s*(?:ha\s+)?(?:wrote|scritto|schrieb|a écrit|écrit|escribió|schreef)\s*:\s*$/i);
  // German puts the name after the verb: "Am 03.11.2026 um 10:12 schrieb Max Muster <max@…>:".
  const de = text.match(/^Am\s+(.+?)\s+schrieb\s+(.+?)\s*(?:<[^>]*>)?\s*:\s*$/i);
  if (de) return { ...out, who: de[2].replace(/^["']|["']$/g, '').trim(), when: de[1].trim() };
  if (m && m[2].length <= 80) {
    out.who = m[2].replace(/^["']|["']$/g, '').trim();
    out.when = m[1].trim();
  }
  return out;
}

// The history after "-----Original Message-----" or "From: … Sent: …": one message per header block.
function parseOriginal(lines) {
  const msgs = [];
  let cur = null;
  for (let i = 0; i < lines.length;) {
    const t = lines[i].trim();
    if (ORIGINAL.test(t)) { i++; continue; }
    if (isHeaderStart(lines, i)) {
      const headers = {};
      let key = null;
      while (i < lines.length && lines[i].trim()) {
        const m = lines[i].trim().match(/^\*?([\p{L} ]{1,20}?)\s*:\*?\s?(.*)$/u);
        const field = m && FIELDS.find(([, re]) => re.test(m[1]))?.[0];
        if (field) { headers[field] = m[2].trim(); key = field; } else if (key && /^\s/.test(lines[i])) headers[key] += ` ${lines[i].trim()}`; else break;
        i++;
      }
      cur = { headers, lines: [] };
      msgs.push(cur);
      continue;
    }
    if (!cur) msgs.push(cur = { headers: {}, lines: [] });
    cur.lines.push(lines[i]);
    i++;
  }
  return msgs.map(m => ({ headers: m.headers, blocks: parseLines(m.lines, true) }));
}

// The quote at the bottom: the last quote/original (with its attribution) after which nothing was written except a
// signature. Inline quotes, followed by replies, stay open.
function markTail(blocks) {
  let i = blocks.length - 1;
  while (i >= 0 && blocks[i].type === 'sig') i--;
  if (i < 0 || !['quote', 'original'].includes(blocks[i].type)) return;
  // Nothing new in the whole mail but the quote (a forward without comment, an empty reply): leave it open.
  if (!blocks.slice(0, i).some(b => b.type === 'text' || b.type === 'forward')) return;
  blocks[i].tail = true;
  if (blocks[i - 1]?.type === 'attr') blocks[i - 1].tail = true;
}

// What was written in this mail (for previews in lists): the text outside the quotes, without signature.
export function newText(raw) {
  return parseMail(raw).filter(b => b.type === 'text' || b.type === 'forward').map(b => b.text).join('\n').trim();
}

// ---------- drawing ----------
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;

function linked(h, text) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
    at = m.index + m[0].length;
  }
  out.push(text.slice(at));
  return out;
}

const countLines = blocks => blocks.reduce((n, b) => n + (b.blocks ? countLines(b.blocks)
  : b.messages ? b.messages.reduce((k, m) => k + 1 + countLines(m.blocks), 0)
    : String(b.text || '').split('\n').length), 0);

// "Mirko Rossi <mirko@lab.example>" → name in bold, the address on hover.
function person(h, raw) {
  const s = String(raw || '').trim();
  const email = s.match(/<([^>]+)>/)?.[1] || (s.includes('@') && !s.includes(' ') ? s : '');
  const name = s.replace(/<[^>]*>/, '').replace(/^["']|["']$/g, '').trim() || email;
  return h('b', { title: email || null }, name);
}

// h: the app's element maker; t: tr (passed in so this module stays without imports).
export function mailBody(raw, { h, t }) {
  const blocks = parseMail(raw);
  if (!blocks.length) return h('div.mb', h('p.muted', t('(no text)')));
  // Each level of quoting gets its own muted color (four, then they repeat).
  const lv = d => `.mb-l${(d - 1) % 4 + 1}`;
  const draw = (list, d = 0) => list.map(b => {
    if (b.type === 'text') return h('div.mb-text', linked(h, b.text));
    if (b.type === 'attr') return b.who ? h('div.mb-attr', h('b', b.who), b.when && ` · ${b.when}`) : h('div.mb-attr', b.text);
    if (b.type === 'sig') return h('div.mb-sig', linked(h, b.text));
    if (b.type === 'quote') return h(`blockquote.mb-q${lv(d + 1)}`, draw(b.blocks, d + 1));
    if (b.type === 'forward') return h(`div.mb-fwd${lv(d + 1)}`, h('div.mb-attr', b.head), h('div.mb-text', linked(h, b.text)));
    // The history of the previous messages, one under the other, each with its header.
    return h('div.mb-hist', b.messages.map(m => h(`div.mb-msg${lv(d + 1)}`,
      (m.headers.from || m.headers.date) && h('div.mb-mh',
        m.headers.from && person(h, m.headers.from), m.headers.date && h('span', ` · ${m.headers.date}`),
        m.headers.subject && h('div.mb-ms', m.headers.subject)),
      draw(m.blocks, d + 1))));
  });
  // The quote at the bottom folded, with how long it is.
  const open = blocks.filter(b => !b.tail);
  const tail = blocks.filter(b => b.tail);
  return h('div.mb', draw(open),
    tail.length > 0 && h('details.mb-tail',
      h('summary', t('quoted text ({n} lines)', { n: countLines(tail.filter(b => b.type !== 'attr')) })),
      draw(tail)));
}
