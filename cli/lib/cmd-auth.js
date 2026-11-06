// Access (token), workspace and direct API calls.
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig, saveConfig, removeConfig, CONFIG_FILE } from './config.js';
import { createClient } from './client.js';
import { c, fail, ask, askHidden, readStdin, table } from './term.js';
import { tr } from './i18n.js';

const API_VERSION = 1;

function normServer(s) {
  let url = String(s).trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

export default {
  login: {
    usage: tr('login [URL] [-u USER] [--password-stdin | --token TOKEN]'),
    summary: tr('signs in to the server: asks for user and password and saves a token (or uses a token created in the app)'),
    options: { user: { type: 'string', short: 'u' }, token: { type: 'string' }, 'password-stdin': { type: 'boolean' } },
    async run(ctx, [url], o) {
      const old = loadConfig();
      const server = normServer(url || old.server || await ask(tr('Server address (e.g. http://localhost:8080): ')) || fail(tr('The server address is needed')));
      const anon = createClient({ server });
      const info = await anon.get('/info').catch(e => {
        if (e.status === 404) fail(tr('{server} does not answer like an Organizer server (or it is a version without the public API: update it)', { server }));
        throw e;
      });
      if (info.api !== API_VERSION) console.error(c.yellow(`! ${tr('The server uses API v{server}, this CLI v{cli}: update the older one', { server: info.api, cli: API_VERSION })}`));

      // token_id only for the tokens created here: org logout revokes them. A pasted token is managed from the app.
      let token = o.token;
      let tokenId = null;
      if (!token) {
        if (o['password-stdin'] && !o.user) fail(tr('With --password-stdin -u USER is needed too'));
        const username = o.user || await ask(tr('User: '));
        const password = o['password-stdin'] ? (await readStdin()).replace(/\r?\n$/, '') : await askHidden(tr('Password: '));
        const r = await anon.post('/auth/token', { username, password, name: `cli ${os.hostname()}`.slice(0, 60) });
        token = r.token;
        tokenId = r.id;
      }
      const me = await createClient({ server, token }).get('/me');
      if (!me.user) fail(tr('Invalid token'));
      // A new login on the same server replaces the previous token: no forgotten tokens around.
      if (old.token_id && old.token !== token && old.server === server) {
        await createClient({ server, token: old.token }).del(`/tokens/${old.token_id}`).catch(() => {});
      }
      saveConfig({ server, token, token_id: tokenId, workspace: me.workspace?.id ?? null });
      console.log(`${c.green('✓')} ${tr('{user} on {server}', { user: c.bold(me.user.username), server })}${me.workspace ? `, workspace "${me.workspace.name}"` : ''}`);
      if (me.workspaces.length > 1) console.log(c.dim(`  ${tr('You have {n} workspaces: org ws to change it', { n: me.workspaces.length })}`));
      console.log(c.dim(`  ${tr('Configuration in {file}', { file: CONFIG_FILE })}`));
    },
  },

  logout: {
    usage: 'logout',
    summary: tr('revokes the CLI token and forgets the server'),
    async run() {
      const cfg = loadConfig();
      if (!cfg.server) return console.log(c.dim(tr('You were not signed in')));
      if (cfg.token_id) {
        await createClient(cfg).del(`/tokens/${cfg.token_id}`).catch(e => {
          if (![401, 404].includes(e.status)) throw e;
        });
      }
      removeConfig();
      console.log(`${c.green('✓')} ${tr('Signed out of {server}', { server: cfg.server })}`);
    },
  },

  whoami: {
    usage: 'whoami',
    summary: tr('user, server and workspace you are working on'),
    async run(ctx) {
      const api = ctx.api();
      const me = await api.get('/me');
      if (ctx.json) return ctx.out({ server: api.base, ...me });
      console.log(tr('{user} on {server}', { user: `${c.bold(me.user.username)}${me.user.name !== me.user.username ? ` (${me.user.name})` : ''}`, server: api.base }));
      console.log(me.workspace ? `workspace "${me.workspace.name}" ${c.dim(`(${me.workspace.id}, ${me.workspace.role})`)}` : c.yellow(tr('no workspace')));
    },
  },

  ws: {
    usage: tr('ws [NAME|ID]'),
    summary: tr('lists your workspaces or picks the one the CLI works on (the app does not change)'),
    async run(ctx, pos) {
      const api = ctx.api();
      const [list, me] = await Promise.all([api.get('/workspaces'), api.get('/me')]);
      const ref = pos.join(' ');
      if (!ref) {
        if (ctx.json) return ctx.out(list);
        return table(list.map(w => [w.id === me.workspace?.id ? c.green('●') : ' ', c.dim(w.id), w.name, c.dim(w.role)]), { right: [1] });
      }
      const w = list.find(x => String(x.id) === ref || x.name.toLowerCase() === ref.toLowerCase()) || fail(tr('Workspace "{name}" not found', { name: ref }));
      if (process.env.ORGANIZER_WS) console.error(c.yellow(`! ${tr('ORGANIZER_WS is set and takes precedence')}`));
      saveConfig({ ...loadConfig(), workspace: w.id });
      console.log(`${c.green('✓')} workspace "${w.name}"`);
    },
  },

  api: {
    usage: tr('api METHOD PATH [JSON|@FILE|-]'),
    summary: tr('direct API call (for scripts and tests), e.g. org api GET /sync'),
    async run(ctx, [method, url, body]) {
      if (!method || !url) fail(tr('Usage: org api GET /sync   or   org api PATCH /entries/12 \'{"done":true}\''));
      let json;
      if (body !== undefined) {
        const text = body === '-' ? await readStdin() : body.startsWith('@') ? fs.readFileSync(body.slice(1), 'utf8') : body;
        try {
          json = JSON.parse(text);
        } catch {
          fail(tr('The body must be valid JSON'));
        }
      }
      const r = await ctx.api().request(method.toUpperCase(), url.replace(/^\/?(api\/)?/, '/'), { json });
      if (r == null) return;
      console.log(typeof r === 'string' ? r.trimEnd() : JSON.stringify(r, null, 2));
    },
  },
};
