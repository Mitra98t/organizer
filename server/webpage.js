// Web pages in the app: the little browser for an item's link and link documents, shown like a PDF with notes.
// The server downloads the page (only public addresses, see remote.js), takes the scripts away, puts the style
// sheets inside it and gives it to the app, which shows it in a frame without scripts (sandbox).
// Link documents keep a saved copy (doc_pages): notes stay where they were put even if the site changes, and the
// page is still there if the site removes it. "Update" downloads it again.
//
// The page is drawn at a fixed width (WIDTH in docview.js) and as tall as its content, without its own scroll:
// units tied to the window's height (vh) and fixed or sticky elements would grow or repeat with it, so they become
// pixels of a VIEW_H window and normal elements.
import { db } from './db.js';
import { route } from './api.js';
import { fetchPublic } from './remote.js';
import { fail, now, str } from './util.js';

const PAGE_MAX = 6 * 1048576;
const CSS_MAX = 2 * 1048576;
const CSS_FILES = 30;
const VIEW_H = 900; // px of the window the page is drawn for (1vh = 9px)
const VIEW_W = 1280;

// ---------- cleaning ----------
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(2).find(x => x !== undefined);
const decodeEnt = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const abs = (u, base) => { try { return new URL(u, base).href; } catch { return null; } };

function setAttr(tag, name, value) {
  const re = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
  const v = ` ${name}="${escAttr(value)}"`;
  return re.test(tag) ? tag.replace(re, v) : tag.replace(/\s*\/?>$/, m => `${v}${m}`);
}
const dropAttr = (tag, name) => tag.replace(new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'gi'), '');

// CSS made fit for a page drawn as tall as its content (see above).
export function fixCss(css) {
  return css
    .replace(/(-?\d*\.?\d+)(?:s|d|l)?vh\b/gi, (_, n) => `${+(n * VIEW_H / 100).toFixed(2)}px`)
    .replace(/(-?\d*\.?\d+)vmin\b/gi, (_, n) => `${+(n * Math.min(VIEW_W, VIEW_H) / 100).toFixed(2)}px`)
    .replace(/(-?\d*\.?\d+)vmax\b/gi, (_, n) => `${+(n * Math.max(VIEW_W, VIEW_H) / 100).toFixed(2)}px`)
    .replace(/position\s*:\s*fixed/gi, 'position:absolute')
    .replace(/position\s*:\s*(?:-webkit-)?sticky/gi, 'position:relative')
    .replace(/expression\s*\(/gi, 'x(');
}

// Addresses in a style sheet downloaded on its own: they become absolute (the page's base is the page's address).
export function absCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => (/^(data:|#)/i.test(u.trim()) ? m : `url("${abs(u.trim(), base) || ''}")`))
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => `@import "${abs(u, base) || ''}"`);
}

function charsetOf(buf, type) {
  const fromType = type.match(/charset=["']?([\w-]+)/i)?.[1];
  if (fromType) return fromType;
  const head = buf.subarray(0, 4096).toString('latin1');
  return head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || 'utf-8';
}

export function decodeHtml(buf, type = '') {
  try {
    return new TextDecoder(charsetOf(buf, type)).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

// The page without scripts, frames, plugins and automatic redirects, with the addresses made absolute where needed.
// `sheets`: address → text of the style sheets already downloaded (put inside the page instead of the <link>).
export function cleanPage(html, base, { sheets = new Map(), savedAt = null } = {}) {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '')
    .replace(/<(iframe|frame|frameset|object|applet|portal|noembed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(iframe|frame|frameset|object|embed|applet|portal|base)\b[^>]*>/gi, '');

  s = s.replace(/<meta\b[^>]*>/gi, tag => {
    const eq = (attr(tag, 'http-equiv') || '').toLowerCase();
    if (eq || attr(tag, 'charset') !== undefined || /^referrer$/i.test(attr(tag, 'name') || '')) return '';
    return tag;
  });

  s = s.replace(/<link\b[^>]*>/gi, tag => {
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    const href = attr(tag, 'href');
    if (!/\bstylesheet\b/.test(rel) || /\balternate\b/.test(rel)) return /\bicon\b/.test(rel) ? tag : '';
    const url = href && abs(decodeEnt(href), base);
    if (!url) return '';
    const media = attr(tag, 'media');
    if (sheets.has(url)) return `<style${media ? ` media="${escAttr(media)}"` : ''} data-href="${escAttr(url)}">${fixCss(absCss(sheets.get(url), url)).replace(/<\/style/gi, '<\\/style')}</style>`;
    return setAttr(tag, 'href', url);
  });

  s = s.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (m, a, css, b) => (/data-href=/.test(a) ? m : a + fixCss(css) + b));

  // Every opening tag: no on…= handlers, no javascript: addresses, styles fixed, images loaded "later" (by a script
  // that no longer runs) loaded now.
  s = s.replace(/<([a-z][\w-]*)\b([^>]*)>/gi, (tag, name) => {
    let t = tag.replace(/\s(on[a-z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    t = t.replace(/\s(href|src|action|formaction|xlink:href|poster|data)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, ' $1="#"');
    const style = attr(t, 'style');
    if (style && /vh|vmin|vmax|fixed|sticky|expression/i.test(style)) t = setAttr(t, 'style', fixCss(decodeEnt(style)));
    if (/^(img|source)$/i.test(name)) {
      const lazy = attr(t, 'data-src') || attr(t, 'data-lazy-src') || attr(t, 'data-original');
      const lazySet = attr(t, 'data-srcset') || attr(t, 'data-lazy-srcset');
      const src = attr(t, 'src');
      if (lazy && (!src || /^data:|blank|placeholder|spacer|lazy/i.test(src))) t = setAttr(t, 'src', decodeEnt(lazy));
      if (lazySet) t = setAttr(t, 'srcset', decodeEnt(lazySet));
      t = dropAttr(t, 'loading');
    }
    return t;
  });

  const head = `<meta charset="utf-8"><base href="${escAttr(base)}"><meta name="referrer" content="no-referrer">`
    + `<meta name="organizer-page" content="${escAttr(base)}"${savedAt ? ` data-saved="${escAttr(savedAt)}"` : ''}>`;
  if (/<head\b[^>]*>/i.test(s)) s = s.replace(/<head\b[^>]*>/i, m => m + head);
  else if (/<html\b[^>]*>/i.test(s)) s = s.replace(/<html\b[^>]*>/i, m => `${m}<head>${head}</head>`);
  else s = `<head>${head}</head>${s}`;
  if (!/^\s*<!doctype/i.test(s)) s = `<!DOCTYPE html>${s}`;
  return s;
}

// Downloads the page and its style sheets (in parallel, those that do not answer stay links).
export async function loadPage(raw) {
  const page = await fetchPublic(raw, { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', maxBytes: PAGE_MAX, timeout: 15000, tooLarge: 'Page too large (max {mb} MB)' });
  if (page.type && !/html|xml/i.test(page.type)) fail(415, 'The link does not lead to a web page ({type})', { type: page.type.split(';')[0] });
  const html = decodeHtml(page.buf, page.type);
  const hrefs = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => m[0])
    .filter(t => /\bstylesheet\b/i.test(attr(t, 'rel') || '') && !/\balternate\b/i.test(attr(t, 'rel') || ''))
    .map(t => attr(t, 'href') && abs(decodeEnt(attr(t, 'href')), page.url)).filter(Boolean);
  const sheets = new Map();
  await Promise.all([...new Set(hrefs)].slice(0, CSS_FILES).map(async u => {
    try {
      const r = await fetchPublic(u, { accept: 'text/css,*/*;q=0.1', maxBytes: CSS_MAX, timeout: 10000 });
      sheets.set(u, decodeHtml(r.buf, r.type));
    } catch { /* stays a link */ }
  }));
  return { url: page.url, html, sheets };
}

// ---------- routes ----------
const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // No scripts, no forms, no frames; the page's images, styles and fonts come from its site. Same origin (so the app
  // can measure it and place the notes), but without scripts: also opened on its own it cannot do anything.
  'Content-Security-Policy': "sandbox allow-same-origin; default-src 'none'; img-src * data: blob:; style-src * 'unsafe-inline'; font-src * data:; media-src *; form-action 'none'; frame-ancestors 'self'; base-uri http: https:",
};

function send(res, html, cache) {
  const body = Buffer.from(html);
  res.writeHead(200, { ...HEADERS, 'Content-Length': body.length, 'Cache-Control': cache });
  res.end(body);
}

// The little browser: the page as it is now (kept 10 minutes, the app redraws often).
const live = new Map(); // address → { html, at }
const LIVE_MS = 10 * 60e3;
route('GET', '/api/web', async ({ res, query }) => {
  const url = str(query.url, 2000);
  if (!/^https?:\/\//i.test(url)) fail(400, 'The link must start with http:// or https://');
  let hit = live.get(url);
  if (!hit || Date.now() - hit.at > LIVE_MS) {
    const p = await loadPage(url);
    hit = { html: cleanPage(p.html, p.url, { sheets: p.sheets }), at: Date.now() };
    live.delete(url);
    live.set(url, hit);
    while (live.size > 40) live.delete(live.keys().next().value);
  }
  send(res, hit.html, 'private, max-age=600');
}, { area: 'magazzino' });

const linkDoc = id => db.prepare('SELECT id, url FROM documents WHERE id = ? AND deleted_at IS NULL AND url IS NOT NULL').get(+id)
  || fail(404, 'Document not found');

async function savePage(d) {
  const p = await loadPage(d.url);
  const at = now();
  const html = cleanPage(p.html, p.url, { sheets: p.sheets, savedAt: at });
  db.prepare(`INSERT INTO doc_pages (doc_id, url, html, saved_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (doc_id) DO UPDATE SET url = excluded.url, html = excluded.html, saved_at = excluded.saved_at`).run(d.id, p.url, html, at);
  return { html, saved_at: at };
}

// Link document: its saved copy (made the first time it is opened).
route('GET', '/api/docs/:id/page', async ({ res, params }) => {
  const d = linkDoc(params.id);
  const saved = db.prepare('SELECT html FROM doc_pages WHERE doc_id = ?').get(d.id) || await savePage(d);
  send(res, saved.html, 'no-cache');
}, { area: 'documenti' });

// Update: downloads the page again (the notes stay at the same point of the page).
route('POST', '/api/docs/:id/page', async ({ params }) => {
  const { saved_at } = await savePage(linkDoc(params.id));
  return { saved_at };
}, { area: 'documenti' });
