// Everything about the terminal: colours, tables, dates, questions, editor, opening files and links.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tr, LANG } from './i18n.js';

// "Expected" error (wrong input, missing element): the message is printed, without a stack.
export class UserError extends Error {}
export const fail = msg => { throw new UserError(msg); };

// ---------- colours ----------
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const sgr = (on, off) => s => (COLOR ? `\x1b[${on}m${s}\x1b[${off}m` : String(s));
export const c = {
  bold: sgr(1, 22), dim: sgr(2, 22), red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39),
  blue: sgr(34, 39), magenta: sgr(35, 39), cyan: sgr(36, 39),
};

// #CODES highlighted, like the links in the app.
export const rich = s => String(s ?? '').replace(/(^|[\s(\[,;:])(#[A-Za-z0-9](?:[\w.\-/]*[A-Za-z0-9_])?)/g, (_, pre, code) => pre + c.cyan(code));

// ---------- tables ----------
const ANSI = /\x1b\[[0-9;]*m/g;
const width = s => [...String(s).replace(ANSI, '')].length;
const pad = (s, n, right = false) => {
  const fill = ' '.repeat(Math.max(0, n - width(s)));
  return right ? fill + s : s + fill;
};

// Aligned columns; the last one stays free (long titles wrap). right: indexes of the right-aligned columns.
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

// ---------- dates and sizes ----------
const pad2 = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const today = () => ymd(new Date());
const fromYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const DAYS = LANG === 'it' ? ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'] : ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Due date as in the agenda: today/tomorrow/yesterday, otherwise "fri 31/10"; red if past, yellow if close.
export function fmtDue(due, { done = false } = {}) {
  if (!due) return '';
  const d = fromYmd(due);
  const diff = Math.round((d - fromYmd(today())) / 864e5);
  const text = diff === 0 ? tr('today') : diff === 1 ? tr('tomorrow') : diff === -1 ? tr('yesterday')
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

// Password without echo.
export function askHidden(question) {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) fail(tr('The password needs a terminal (or use --password-stdin)'));
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
        if (ch === '\u0003' || ch === '\u0004') return end(new UserError(tr('Cancelled')));
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

// Opens $VISUAL/$EDITOR on a temporary file with the given text and returns the saved text.
export function editText(initial, name = 'organizer.txt') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-'));
  const file = path.join(dir, name);
  try {
    fs.writeFileSync(file, initial);
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    const r = spawnSync(`${editor} "${file}"`, { stdio: 'inherit', shell: true });
    if (r.status !== 0) fail(tr('The editor ({editor}) exited with an error: no change saved', { editor }));
    return fs.readFileSync(file, 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// File or link with the system's default application.
export function openExternal(target) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [target]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]]
      : ['xdg-open', [target]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.error(c.red('✗'), tr('Cannot open {target} ({cmd} missing?)', { target, cmd })));
  child.unref();
}
