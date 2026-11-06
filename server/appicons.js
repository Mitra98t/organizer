// App icons drawn on the fly (the descriptions are in public/js/appicons.js): SVG for the browser tab and PNG
// (180 for iPhone/iPad, 192 and 512 for installation, 512 "maskable" for Android, which crops it to its own shape).
// No dependencies: the PNGs are rasterised here from distances to the shapes (soft edges) and encoded by hand.
// Once drawn they stay in memory.
//   GET /icons/app/ID.svg · /icons/app/ID-180.png · -192.png · -512.png · -512-maskable.png
//   GET /manifest.webmanifest?icon=ID  → the manifest with those icons
import fs from 'node:fs';
import zlib from 'node:zlib';
import { iconById } from '../public/js/appicons.js';

// ---------- PNG ----------
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel((x + 0.5) / size, (y + 0.5) / size, 1 / size);
      raw.set([r, g, b, 255], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- shapes (coordinates 0..1) ----------
const rgb = c => c.replace('#', '').match(/../g).map(x => parseInt(x, 16));
const clamp = v => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function roundBoxDist(px, py, cx, cy, half, r) {
  const qx = Math.abs(px - cx) - (half - r), qy = Math.abs(py - cy) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const polyDist = (x, y, pts) => Math.min(...pts.slice(1).map((p, i) => segDist(x, y, pts[i][0], pts[i][1], p[0], p[1])));

// The same shapes as the SVG (which uses 0..100).
const CHECK = [[0.37, 0.51], [0.46, 0.6], [0.66, 0.38]];
const BIG_CHECK = [[0.3, 0.52], [0.44, 0.66], [0.71, 0.36]];

function pixelOf(icon, maskable) {
  const bg = rgb(icon.bg);
  const bg2 = icon.bg2 ? rgb(icon.bg2) : null;
  const mark = rgb(icon.mark);
  const box = icon.box ? rgb(icon.box) : null;
  // Android "maskable" icons crop the edges: the drawing shrinks towards the centre (safe zone).
  const k = maskable ? 0.78 : 1;
  return (x0, y0, px0) => {
    let c = bg2 ? mix(bg, bg2, y0) : bg;
    const x = 0.5 + (x0 - 0.5) / k, y = 0.5 + (y0 - 0.5) / k, px = px0 / k;
    const paint = (col, d) => { c = mix(c, col, clamp(-d / px + 0.5)); };
    switch (icon.glyph) {
      case 'check': paint(mark, polyDist(x, y, BIG_CHECK) - 0.045); break;
      case 'dot': paint(mark, Math.hypot(x - 0.5, y - 0.5) - 0.17); break;
      case 'ring': paint(mark, Math.abs(Math.hypot(x - 0.5, y - 0.5) - 0.25) - 0.03); break;
      case 'tile':
        paint(mark, roundBoxDist(x, y, 0.5, 0.5, 0.24, 0.08));
        paint(bg, polyDist(x, y, CHECK) - 0.0375);
        break;
      default:
        paint(box, Math.abs(roundBoxDist(x, y, 0.5, 0.5, 0.22, 0.1)) - 0.0225);
        paint(mark, polyDist(x, y, CHECK) - 0.0375);
    }
    return c.map(Math.round);
  };
}

export function iconSvg(icon) {
  const fill = icon.bg2 ? 'url(#g)' : icon.bg;
  const grad = icon.bg2 ? `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${icon.bg}"/><stop offset="1" stop-color="${icon.bg2}"/></linearGradient></defs>` : '';
  const line = (pts, w, color) => `<path d="M${pts.map(([x, y]) => `${x * 100} ${y * 100}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const glyph = {
    check: () => line(BIG_CHECK, 9, icon.mark),
    dot: () => `<circle cx="50" cy="50" r="17" fill="${icon.mark}"/>`,
    ring: () => `<circle cx="50" cy="50" r="25" fill="none" stroke="${icon.mark}" stroke-width="6"/>`,
    tile: () => `<rect x="26" y="26" width="48" height="48" rx="8" fill="${icon.mark}"/>${line(CHECK, 7.5, icon.bg)}`,
  }[icon.glyph] || (() => `<rect x="28" y="28" width="44" height="44" rx="10" fill="none" stroke="${icon.box}" stroke-width="4.5"/>${line(CHECK, 7.5, icon.mark)}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${grad}<rect width="100" height="100" rx="22" fill="${fill}"/>${glyph()}</svg>\n`;
}

export const iconPng = (icon, size, maskable = false) => png(size, pixelOf(icon, maskable));

// ---------- HTTP ----------
const cache = new Map();
const SIZES = new Set([180, 192, 512]);
const ICON_RE = /^\/icons\/app\/([a-z0-9-]+?)(?:-(\d+)(-maskable)?)?\.(svg|png)$/;

// Answers if the path is an icon or the manifest with a chosen icon; otherwise false.
export function serveAppIcon(res, url, publicDir) {
  if (url.pathname === '/manifest.webmanifest' && url.searchParams.has('icon')) {
    const icon = iconById(url.searchParams.get('icon'));
    if (!icon) return false;
    const m = JSON.parse(fs.readFileSync(`${publicDir}/manifest.webmanifest`, 'utf8'));
    m.icons = [
      { src: `icons/app/${icon.id}-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `icons/app/${icon.id}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `icons/app/${icon.id}-512-maskable.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: `icons/app/${icon.id}.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ];
    m.background_color = icon.bg;
    send(res, 'application/manifest+json', Buffer.from(JSON.stringify(m, null, 2)), 'no-cache');
    return true;
  }
  const hit = url.pathname.match(ICON_RE);
  if (!hit) return false;
  const [, id, size, maskable, ext] = hit;
  const icon = iconById(id);
  if (!icon || (ext === 'png' && !SIZES.has(+size)) || (ext === 'svg' && size)) return false;
  const key = url.pathname;
  if (!cache.has(key)) cache.set(key, ext === 'svg' ? Buffer.from(iconSvg(icon)) : iconPng(icon, +size, !!maskable));
  send(res, ext === 'svg' ? 'image/svg+xml' : 'image/png', cache.get(key), 'public, max-age=604800');
  return true;
}

function send(res, type, body, cacheControl) {
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
