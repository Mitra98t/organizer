// Tutto ciò che riguarda il terminale: colori, tabelle, date, domande, editor, apertura di file e link.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';

// Errore "previsto" (input sbagliato, elemento inesistente): si stampa il messaggio, senza stack.
export class UserError extends Error {}
export const fail = msg => { throw new UserError(msg); };

// ---------- colori ----------
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const sgr = (on, off) => s => (COLOR ? `\x1b[${on}m${s}\x1b[${off}m` : String(s));
export const c = {
  bold: sgr(1, 22), dim: sgr(2, 22), red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39),
  blue: sgr(34, 39), magenta: sgr(35, 39), cyan: sgr(36, 39),
};

// #CODICI in evidenza, come i link nell'app.
export const rich = s => String(s ?? '').replace(/(^|[\s(\[,;:])(#[A-Za-z0-9](?:[\w.\-/]*[A-Za-z0-9_])?)/g, (_, pre, code) => pre + c.cyan(code));

// ---------- tabelle ----------
const ANSI = /\x1b\[[0-9;]*m/g;
const width = s => [...String(s).replace(ANSI, '')].length;
const pad = (s, n, right = false) => {
  const fill = ' '.repeat(Math.max(0, n - width(s)));
  return right ? fill + s : s + fill;
};

// Colonne allineate; l'ultima resta libera (titoli lunghi vanno a capo). right: indici delle colonne a destra.
export function table(rows, { right = [0] } = {}) {
  if (!rows.length) return;
  const n = Math.max(...rows.map(r => r.length));
  const w = Array.from({ length: n }, (_, i) => Math.max(...rows.map(r => width(r[i] ?? ''))));
  for (const r of rows) {
    const cells = r.map((cell, i) => (i < r.length - 1 ? pad(cell ?? '', w[i], right.includes(i)) : cell ?? ''));
    console.log(cells.join('  ').trimEnd());
  }
}

export const heading = s => console.log(`\n${c.bold(s)}`);

// ---------- date e dimensioni ----------
const pad2 = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const today = () => ymd(new Date());
const fromYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const DAYS = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];

// Scadenza come nell'agenda: oggi/domani/ieri, altrimenti "ven 31/10"; rosso se passata, giallo se vicina.
export function fmtDue(due, { done = false } = {}) {
  if (!due) return '';
  const d = fromYmd(due);
  const diff = Math.round((d - fromYmd(today())) / 864e5);
  const text = diff === 0 ? 'oggi' : diff === 1 ? 'domani' : diff === -1 ? 'ieri'
    : `${DAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}${d.getFullYear() !== new Date().getFullYear() ? `/${d.getFullYear() % 100}` : ''}`;
  if (done) return c.dim(text);
  return diff < 0 ? c.red(text) : diff <= 1 ? c.yellow(text) : text;
}

export const fmtTime = iso => {
  const d = new Date(iso);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

export const fmtSize = n => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// ---------- input ----------
export async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

// Password senza eco.
export function askHidden(question) {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) fail('Per la password serve un terminale (oppure usa --password-stdin)');
  return new Promise((resolve, reject) => {
    let pw = '';
    const end = err => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stderr.write('\n');
      if (err) reject(err);
      else resolve(pw);
    };
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return end();
        if (ch === '\u0003' || ch === '\u0004') return end(new UserError('Annullato'));
        if (ch === '\u007f' || ch === '\b') pw = pw.slice(0, -1);
        else if (ch >= ' ') pw += ch;
      }
    };
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Apre $VISUAL/$EDITOR su un file temporaneo con il testo dato e restituisce il testo salvato.
export function editText(initial, name = 'organizer.txt') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-'));
  const file = path.join(dir, name);
  try {
    fs.writeFileSync(file, initial);
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    const r = spawnSync(`${editor} "${file}"`, { stdio: 'inherit', shell: true });
    if (r.status !== 0) fail(`L'editor (${editor}) è uscito con un errore: nessuna modifica salvata`);
    return fs.readFileSync(file, 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// File o link con l'applicazione predefinita del sistema.
export function openExternal(target) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [target]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]]
      : ['xdg-open', [target]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.error(c.red('✗'), `Non riesco ad aprire ${target} (manca ${cmd}?)`));
  child.unref();
}
