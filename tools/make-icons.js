// Regenerates the app's base icons in public/icons (those of the static manifest and of the first opening), with the
// same drawing as the icons chosen in Settings (server/appicons.js, public/js/appicons.js).
//   node tools/make-icons.js
import fs from 'node:fs';
import { iconSvg, iconPng } from '../server/appicons.js';
import { iconById } from '../public/js/appicons.js';

const OUT = new URL('../public/icons/', import.meta.url);
const icon = iconById('organizer');
fs.mkdirSync(OUT, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(new URL(name, OUT), iconPng(icon, size));
  console.log('written', name);
}
fs.writeFileSync(new URL('icon.svg', OUT), iconSvg(icon));
console.log('written icon.svg');
