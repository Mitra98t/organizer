// Esporta i feedback in una cartella, uno per sottocartella (feedback.md + le immagini), per rivederli dal
// terminale o farli leggere a chi corregge l'app. Si usa con `make feedback` (ALL=1 anche quelli risolti).
//   node server/feedback-export.js CARTELLA [--all]
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';
import { acc } from './accounts.js';

const FEEDBACK_DIR = path.join(DATA_DIR, 'feedback'); // come in feedback.js

const [out = 'feedback-export', flag] = process.argv.slice(2);
const all = flag === '--all';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const list = acc.prepare(`SELECT f.*, u.username, u.name AS user_name, w.name AS ws FROM feedback f
  LEFT JOIN users u ON u.id = f.user_id LEFT JOIN workspaces w ON w.id = f.workspace_id
  ${all ? '' : "WHERE f.status = 'open'"} ORDER BY f.created_at`).all();
for (const f of list) {
  const dir = path.join(out, `${String(f.id).padStart(4, '0')}-${f.created_at.slice(0, 10)}`);
  fs.mkdirSync(dir);
  const files = acc.prepare('SELECT * FROM feedback_files WHERE feedback_id = ? ORDER BY id').all(f.id);
  const names = files.map((x, i) => {
    const name = `${i + 1}-${x.name.replace(/[^\w.\-]+/g, '_')}`;
    const src = path.join(FEEDBACK_DIR, x.stored);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
    return name;
  });
  fs.writeFileSync(path.join(dir, 'feedback.md'), [
    `# Feedback ${f.id}${f.status === 'done' ? ' (risolto)' : ''}`,
    '',
    `- Da: ${f.user_name || f.username || 'utente eliminato'}${f.username ? ` (@${f.username})` : ''}`,
    `- Quando: ${f.created_at}`,
    `- Versione: ${f.version || '?'} · pagina: ${f.page || '?'} · workspace: ${f.ws || '?'}`,
    `- Browser: ${f.client || '?'}`,
    '',
    f.text,
    '',
    ...names.map(n => `![${n}](${n})`),
    '',
  ].join('\n'));
}
console.log(`${list.length} feedback ${all ? '' : 'aperti '}esportati in ${out}`);
