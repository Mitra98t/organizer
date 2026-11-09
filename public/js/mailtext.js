// Text of a received mail, read the way a mail program shows it: quotes (> lines) indented, also nested, so that
// replies written between the quoted lines ("inline") stay readable; the quote at the bottom (the whole previous
// message, "On … wrote:" or "-----Original Message-----") folded; forwarded messages visible; the signature in grey;
// links clickable. parseMail() is plain data (tested without a browser), mailBody() draws it.

// "On Mon, 3 Nov 2026 Mirko <…> wrote:" in a few languages (it may be split on two lines by the mail program).
const ATTR = /^(On|Il|Am|Le|El|Op)\s.{4,300}(wrote|scritto|schrieb|écrit|escribió|schreef)\s*:\s*$/i;
const ATTR_START = /^(On|Il|Am|Le|El|Op)\s.{4,200}$/i;
const ATTR_END = /(wrote|scritto|schrieb|écrit|escribió|schreef)\s*:\s*$/i;
// Outlook and similar quote without ">": from here on it is the previous message.
const ORIGINAL = /^-{2,}\s*(Original Message|Messaggio originale|Ursprüngliche Nachricht|Message d'origine)\s*-*$/i;
const HEADER = /^\*?(From|Da|Von|De)\s*:\*?\s.+/i;
const HEADER_NEXT = /^\*?(Sent|Inviato|Gesendet|Envoyé|Date|Data|To|A|An|Subject|Oggetto)\s*:/i;
const FORWARD = /^(-{2,}\s*(Forwarded message|Messaggio inoltrato|Weitergeleitete Nachricht|Message transféré)\s*-*|Begin forwarded message:|Inizio messaggio inoltrato:)$/i;
const SIG = /^--\s?$/;

const depthOf = line => line.match(/^(\s*>)+/)?.[0].replace(/[^>]/g, '').length || 0;
const unquote = line => line.replace(/^\s*>\s?/, '');

// Blocks: { type: 'text' | 'attr' | 'sig', text } | { type: 'quote', blocks } | { type: 'original' | 'forward', head, text }.
// The last quote (or original message) with nothing written after it has tail: true.
export function parseMail(raw) {
  const lines = String(raw || '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
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
      out.push({ type: 'forward', head: t.replace(/^-+\s*|\s*-+$/g, ''), text: lines.slice(i + 1).join('\n').trim() });
      break;
    }
    if (!nested && (ORIGINAL.test(t) || (HEADER.test(t) && lines.slice(i + 1, i + 5).some(l => HEADER_NEXT.test(l.trim()))))) {
      out.push({ type: 'original', head: ORIGINAL.test(t) ? '' : t, text: lines.slice(ORIGINAL.test(t) ? i + 1 : i).join('\n').trim() });
      break;
    }
    if (ATTR.test(t)) { push('attr', t); i++; continue; }
    // Attribution split on two lines: "On Mon … Mirko" / "<mirko@…> wrote:".
    if (ATTR_START.test(t) && ATTR_END.test((lines[i + 1] || '').trim()) && depthOf(lines[i + 2] || '')) {
      push('attr', `${t} ${lines[i + 1].trim()}`);
      i += 2;
      continue;
    }
    if (SIG.test(line)) {
      // Signature: until the next quote (in "top posting" the quote comes after it).
      const sig = [];
      i++;
      while (i < lines.length && !depthOf(lines[i]) && !ATTR.test(lines[i].trim()) && !ORIGINAL.test(lines[i].trim()) && !FORWARD.test(lines[i].trim())) sig.push(lines[i++]);
      if (sig.join('').trim()) out.push({ type: 'sig', text: sig.join('\n').trim() });
      continue;
    }
    push('text', line);
    i++;
  }
  // No empty blocks of text (blank lines between a reply and a quote).
  return out.filter(b => b.type !== 'text' || b.text.trim()).map(b => (b.type === 'text' ? { ...b, text: b.text.replace(/^\n+|\s+$/g, '') } : b));
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

const countLines = blocks => blocks.reduce((n, b) => n + (b.blocks ? countLines(b.blocks) : String(b.text || '').split('\n').length), 0);

// h: the app's element maker; t: tr (passed in so this module stays without imports).
export function mailBody(raw, { h, t }) {
  const blocks = parseMail(raw);
  if (!blocks.length) return h('div.mb', h('p.muted', t('(no text)')));
  const draw = list => list.map(b => {
    if (b.type === 'text') return h('div.mb-text', linked(h, b.text));
    if (b.type === 'attr') return h('div.mb-attr', b.text);
    if (b.type === 'sig') return h('div.mb-sig', linked(h, b.text));
    if (b.type === 'quote') return h('blockquote.mb-q', draw(b.blocks));
    if (b.type === 'forward') return h('div.mb-fwd', h('div.mb-attr', b.head), h('div.mb-text', linked(h, b.text)));
    return h('div.mb-orig', b.head && h('div.mb-attr', b.head), h('div.mb-text', linked(h, b.text)));
  });
  // The quote at the bottom folded, with how long it is.
  const open = blocks.filter(b => !b.tail);
  const tail = blocks.filter(b => b.tail);
  return h('div.mb', draw(open),
    tail.length > 0 && h('details.mb-tail',
      h('summary', t('quoted text ({n} lines)', { n: countLines(tail.filter(b => b.type !== 'attr')) })),
      draw(tail)));
}
