// Rigenera le icone di base dell'app in public/icons (quelle del manifest statico e della prima apertura), con lo
// stesso disegno delle icone scelte in Impostazioni (server/appicons.js, public/js/appicons.js).
//   node tools/make-icons.js
import fs from 'node:fs';
import { iconSvg, iconPng } from '../server/appicons.js';
import { iconById } from '../public/js/appicons.js';

const OUT = new URL('../public/icons/', import.meta.url);
const icon = iconById('organizer');
fs.mkdirSync(OUT, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(new URL(name, OUT), iconPng(icon, size));
  console.log('scritto', name);
}
fs.writeFileSync(new URL('icon.svg', OUT), iconSvg(icon));
console.log('scritto icon.svg');
