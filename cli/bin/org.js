#!/usr/bin/env node
// org: Organizer dal terminale. Usa le API pubbliche del server (docs/API.md) con un token personale.
import { parseArgs } from 'node:util';
import { settings } from '../lib/config.js';
import { createClient, ApiError, VERSION } from '../lib/client.js';
import { loadData } from '../lib/data.js';
import { c, fail, UserError } from '../lib/term.js';
import auth from '../lib/cmd-auth.js';
import entries from '../lib/cmd-entries.js';
import projects from '../lib/cmd-projects.js';
import items from '../lib/cmd-items.js';
import docs from '../lib/cmd-docs.js';
import mail, { contacts } from '../lib/cmd-mail.js';
import chat from '../lib/cmd-chat.js';

// Comandi semplici e gruppi (org proj …, org item …): senza sottocomando un gruppo esegue "ls".
const COMMANDS = {
  ...entries, proj: { group: projects }, item: { group: items }, doc: { group: docs }, mail: { group: mail }, contacts, chat: { group: chat }, ...auth,
};

const SECTIONS = [
  ['Voci (todo, mail, note)', ['add', 'ls', 'show', 'done', 'reopen', 'log', 'due', 'assign', 'edit', 'mv', 'rm', 'search']],
  ['Progetti', ['proj']],
  ['Magazzino', ['item']],
  ['Documenti', ['doc']],
  ['Mail', ['mail', 'contacts']],
  ['Chat del workspace', ['chat']],
  ['Cestino', ['trash', 'restore']],
  ['Accesso e altro', ['login', 'logout', 'whoami', 'ws', 'api']],
];

// Nell'elenco generale solo comando e argomenti principali, senza le opzioni: i dettagli con --help.
const short = u => {
  const words = [];
  for (const w of u.split(' ')) {
    if (!w || w === 'oppure' || /^\[?-/.test(w)) break;
    words.push(w);
  }
  return words.join(' ');
};
const pad = (s, n) => s + ' '.repeat(Math.max(1, n - s.length));

function help() {
  const lines = [`${c.bold('org')} ${c.dim(`v${VERSION}`)}: Organizer dal terminale\n`];
  for (const [title, names] of SECTIONS) {
    lines.push(c.bold(title));
    for (const name of names) {
      const cmds = COMMANDS[name].group ? Object.values(COMMANDS[name].group) : [COMMANDS[name]];
      for (const cmd of cmds) lines.push(`  ${pad(`org ${short(cmd.usage)}`, 34)} ${c.dim(cmd.summary.split(/;| \(/)[0])}`);
    }
    lines.push('');
  }
  lines.push(
    c.bold('Opzioni per tutti i comandi'),
    `  --json        uscita in JSON (per script e jq)`,
    `  -w, --ws ID   lavora su un altro workspace solo per questo comando`,
    `  -h, --help    aiuto del comando, es. org ls --help`,
    '',
    c.dim('Il testo delle voci usa la sintassi dell\'app: @progetto #CODICE !scadenza +utente >destinatario.'),
    c.dim('Nella shell mettilo tra apici singoli: org add \'flash fw #SCH-042 @rover !ven\''),
  );
  console.log(lines.join('\n'));
}

function usage(cmd) {
  console.log(`${c.bold(`org ${cmd.usage}`)}\n\n${cmd.summary}`);
}

// --json, --ws e --help valgono ovunque: si tolgono prima di passare il resto al comando.
function takeGlobals(argv) {
  const out = { args: [], json: false, help: false, ws: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.args.push(...argv.slice(i)); break; }
    if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-w' || a === '--ws') out.ws = argv[++i] ?? fail(`${a} vuole un workspace`);
    else if (a.startsWith('--ws=')) out.ws = a.slice(5);
    else out.args.push(a);
  }
  return out;
}

async function main() {
  const g = takeGlobals(process.argv.slice(2));
  let [name, ...rest] = g.args;
  if (name === '--version' || name === 'version') return console.log(VERSION);
  if (!name || name === 'help') return help();
  let cmd = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : fail(`Comando sconosciuto "${name}" (org help per l'elenco)`);
  if (cmd.group) cmd = cmd.group[Object.hasOwn(cmd.group, rest[0] ?? '') ? rest.shift() : 'ls'];
  if (g.help) return usage(cmd);

  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: cmd.options ?? {}, allowPositionals: true, strict: true });
  } catch (e) {
    fail(`${e.message.replace(/\. To specify.*$/s, '')}\nUso: org ${cmd.usage}`);
  }

  const cfg = settings();
  if (g.ws) cfg.workspace = g.ws;
  let api;
  let data;
  const ctx = {
    json: g.json,
    api() {
      if (!cfg.server || !cfg.token) fail('Non sei collegato: org login URL-DEL-SERVER');
      return (api ??= createClient(cfg));
    },
    data: () => (data ??= loadData(ctx.api())),
    out: v => console.log(JSON.stringify(v, null, 2)),
  };
  await cmd.run(ctx, parsed.positionals, parsed.values);
}

main().catch(e => {
  if (e instanceof UserError) console.error(c.red('✗'), e.message);
  else if (e instanceof ApiError) console.error(c.red('✗'), e.message + (e.status === 401 && !/Credenziali/.test(e.message) ? ' (org login per accedere di nuovo)' : ''));
  else console.error(e);
  process.exitCode = 1;
});
