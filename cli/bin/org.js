#!/usr/bin/env node
// org: Organizer from the terminal. It uses the server's public API (docs/API.md) with a personal token.
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
import { tr } from '../lib/i18n.js';

// Plain commands and groups (org proj …, org item …): without a subcommand a group runs "ls".
const COMMANDS = {
  ...entries, proj: { group: projects }, item: { group: items }, doc: { group: docs }, mail: { group: mail }, contacts, chat: { group: chat }, ...auth,
};

const SECTIONS = [
  [tr('Entries (todos, mails, notes)'), ['add', 'ls', 'show', 'done', 'reopen', 'log', 'due', 'assign', 'edit', 'mv', 'rm', 'search']],
  [tr('Projects'), ['proj']],
  [tr('Inventory'), ['item']],
  [tr('Documents'), ['doc']],
  ['Mail', ['mail', 'contacts']],
  [tr('Workspace chat'), ['chat']],
  [tr('Trash'), ['trash', 'restore']],
  [tr('Access and more'), ['login', 'logout', 'whoami', 'ws', 'api']],
];

// In the general list only the command and the main arguments, without the options: the details with --help.
const short = u => {
  const words = [];
  for (const w of u.split(' ')) {
    if (!w || w === tr('or') || /^\[?-/.test(w)) break;
    words.push(w);
  }
  return words.join(' ');
};
const pad = (s, n) => s + ' '.repeat(Math.max(1, n - s.length));

function help() {
  const lines = [`${c.bold('org')} ${c.dim(`v${VERSION}`)}: ${tr('Organizer from the terminal')}\n`];
  for (const [title, names] of SECTIONS) {
    lines.push(c.bold(title));
    for (const name of names) {
      const cmds = COMMANDS[name].group ? Object.values(COMMANDS[name].group) : [COMMANDS[name]];
      for (const cmd of cmds) lines.push(`  ${pad(`org ${short(cmd.usage)}`, 34)} ${c.dim(cmd.summary.split(/;| \(/)[0])}`);
    }
    lines.push('');
  }
  lines.push(
    c.bold(tr('Options for all commands')),
    `  --json        ${tr('output in JSON (for scripts and jq)')}`,
    `  -w, --ws ID   ${tr('work on another workspace for this command only')}`,
    `  -h, --help    ${tr('help on the command, e.g. org ls --help')}`,
    '',
    c.dim(tr('The text of entries uses the app\'s syntax: @project #CODE !due +user >recipient.')),
    c.dim(tr('In the shell put it in single quotes: org add \'flash fw #SCH-042 @rover !fri\'')),
    c.dim(tr('Language: English, or Italian with ORG_LANG=it (or an Italian LANG).')),
  );
  console.log(lines.join('\n'));
}

function usage(cmd) {
  console.log(`${c.bold(`org ${cmd.usage}`)}\n\n${cmd.summary}`);
}

// --json, --ws and --help work everywhere: they are taken out before passing the rest to the command.
function takeGlobals(argv) {
  const out = { args: [], json: false, help: false, ws: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.args.push(...argv.slice(i)); break; }
    if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-w' || a === '--ws') out.ws = argv[++i] ?? fail(tr('{opt} needs a workspace', { opt: a }));
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
  let cmd = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : fail(tr('Unknown command "{name}" (org help for the list)', { name }));
  if (cmd.group) cmd = cmd.group[Object.hasOwn(cmd.group, rest[0] ?? '') ? rest.shift() : 'ls'];
  if (g.help) return usage(cmd);

  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: cmd.options ?? {}, allowPositionals: true, strict: true });
  } catch (e) {
    fail(`${e.message.replace(/\. To specify.*$/s, '')}\n${tr('Usage:')} org ${cmd.usage}`);
  }

  const cfg = settings();
  if (g.ws) cfg.workspace = g.ws;
  let api;
  let data;
  const ctx = {
    json: g.json,
    api() {
      if (!cfg.server || !cfg.token) fail(tr('You are not signed in: org login SERVER-URL'));
      return (api ??= createClient(cfg));
    },
    data: () => (data ??= loadData(ctx.api())),
    out: v => console.log(JSON.stringify(v, null, 2)),
  };
  await cmd.run(ctx, parsed.positionals, parsed.values);
}

main().catch(e => {
  if (e instanceof UserError) console.error(c.red('✗'), e.message);
  else if (e instanceof ApiError) console.error(c.red('✗'), e.message + (e.status === 401 && e.message !== tr('Wrong credentials') ? ` ${tr('(org login to sign in again)')}` : ''));
  else console.error(e);
  process.exitCode = 1;
});
