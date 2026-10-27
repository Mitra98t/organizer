// Genera le icone PNG dell'app (nessuna dipendenza: rasterizzazione e codifica PNG a mano).
//   node tools/make-icons.js
import fs from 'node:fs';
import zlib from 'node:zlib';

const OUT = new URL('../public/icons/', import.meta.url);
const BG = [0x0e, 0x10, 0x14];
const BOX = [0x3a, 0x41, 0x50];
const CHECK = [0x2f, 0xd2, 0xa2];

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

const clamp = v => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function roundBoxDist(px, py, cx, cy, half, r) {
  const qx = Math.abs(px - cx) - (half - r), qy = Math.abs(py - cy) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Stessa geometria di icon.svg (coordinate 0..1 invece di 0..100).
function pixel(x, y, px) {
  let c = BG;
  const box = Math.abs(roundBoxDist(x, y, 0.5, 0.5, 0.22, 0.1));
  c = mix(c, BOX, clamp((0.0225 - box) / px + 0.5));
  const check = Math.min(segDist(x, y, 0.37, 0.51, 0.46, 0.6), segDist(x, y, 0.46, 0.6, 0.66, 0.38));
  return mix(c, CHECK, clamp((0.0375 - check) / px + 0.5));
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(new URL(name, OUT), png(size, pixel));
  console.log('scritto', name);
}
fs.writeFileSync(new URL('icon.svg', OUT), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#0e1014"/>
  <rect x="28" y="28" width="44" height="44" rx="10" fill="none" stroke="#3a4150" stroke-width="4.5"/>
  <path d="M37 51 46 60 66 38" fill="none" stroke="#2fd2a2" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`);
console.log('scritto icon.svg');
