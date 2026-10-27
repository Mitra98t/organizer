// Accesso (token), workspace e chiamate dirette alle API.
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig, saveConfig, removeConfig, CONFIG_FILE } from './config.js';
import { createClient } from './client.js';
import { c, fail, ask, askHidden, readStdin, table } from './term.js';

const API_VERSION = 1;

function normServer(s) {
  let url = String(s).trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

export default {
  login: {
    usage: 'login [URL] [-u UTENTE] [--password-stdin | --token TOKEN]',
    summary: 'accede al server: chiede utente e password e salva un token (oppure usa un token creato dall\'app)',
    options: { user: { type: 'string', short: 'u' }, token: { type: 'string' }, 'password-stdin': { type: 'boolean' } },
    async run(ctx, [url], o) {
      const old = loadConfig();
      const server = normServer(url || old.server || await ask('Indirizzo del server (es. http://localhost:8080): ') || fail('Serve l\'indirizzo del server'));
      const anon = createClient({ server });
      const info = await anon.get('/info').catch(e => {
        if (e.status === 404) fail(`${server} non risponde come un server Organizer (o è una versione senza API pubbliche: aggiornalo)`);
        throw e;
      });
      if (info.api !== API_VERSION) console.error(c.yellow(`! Il server usa le API v${info.api}, questa CLI la v${API_VERSION}: aggiorna quella più vecchia`));

      // token_id solo per i token creati qui: org logout li revoca. Un token incollato si gestisce dall'app.
      let token = o.token;
      let tokenId = null;
      if (!token) {
        if (o['password-stdin'] && !o.user) fail('Con --password-stdin serve anche -u UTENTE');
        const username = o.user || await ask('Utente: ');
        const password = o['password-stdin'] ? (await readStdin()).replace(/\r?\n$/, '') : await askHidden('Password: ');
        const r = await anon.post('/auth/token', { username, password, name: `cli ${os.hostname()}`.slice(0, 60) });
        token = r.token;
        tokenId = r.id;
      }
      const me = await createClient({ server, token }).get('/me');
      if (!me.user) fail('Token non valido');
      // Un nuovo login sullo stesso server sostituisce il token di prima: niente token dimenticati in giro.
      if (old.token_id && old.token !== token && old.server === server) {
        await createClient({ server, token: old.token }).del(`/tokens/${old.token_id}`).catch(() => {});
      }
      saveConfig({ server, token, token_id: tokenId, workspace: me.workspace?.id ?? null });
      console.log(`${c.green('✓')} ${c.bold(me.user.username)} su ${server}${me.workspace ? `, workspace "${me.workspace.name}"` : ''}`);
      if (me.workspaces.length > 1) console.log(c.dim(`  Hai ${me.workspaces.length} workspace: org ws per cambiarlo`));
      console.log(c.dim(`  Configurazione in ${CONFIG_FILE}`));
    },
  },

  logout: {
    usage: 'logout',
    summary: 'revoca il token della CLI e dimentica il server',
    async run() {
      const cfg = loadConfig();
      if (!cfg.server) return console.log(c.dim('Non eri collegato'));
      if (cfg.token_id) {
        await createClient(cfg).del(`/tokens/${cfg.token_id}`).catch(e => {
          if (![401, 404].includes(e.status)) throw e;
        });
      }
      removeConfig();
      console.log(`${c.green('✓')} Scollegato da ${cfg.server}`);
    },
  },

  whoami: {
    usage: 'whoami',
    summary: 'utente, server e workspace su cui stai lavorando',
    async run(ctx) {
      const api = ctx.api();
      const me = await api.get('/me');
      if (ctx.json) return ctx.out({ server: api.base, ...me });
      console.log(`${c.bold(me.user.username)}${me.user.name !== me.user.username ? ` (${me.user.name})` : ''} su ${api.base}`);
      console.log(me.workspace ? `workspace "${me.workspace.name}" ${c.dim(`(${me.workspace.id}, ${me.workspace.role})`)}` : c.yellow('nessun workspace'));
    },
  },

  ws: {
    usage: 'ws [NOME|ID]',
    summary: 'elenca i tuoi workspace o sceglie quello su cui lavora la CLI (l\'app non cambia)',
    async run(ctx, pos) {
      const api = ctx.api();
      const [list, me] = await Promise.all([api.get('/workspaces'), api.get('/me')]);
      const ref = pos.join(' ');
      if (!ref) {
        if (ctx.json) return ctx.out(list);
        return table(list.map(w => [w.id === me.workspace?.id ? c.green('●') : ' ', c.dim(w.id), w.name, c.dim(w.role)]), { right: [1] });
      }
      const w = list.find(x => String(x.id) === ref || x.name.toLowerCase() === ref.toLowerCase()) || fail(`Workspace "${ref}" non trovato`);
      if (process.env.ORGANIZER_WS) console.error(c.yellow('! ORGANIZER_WS è impostata e ha la precedenza'));
      saveConfig({ ...loadConfig(), workspace: w.id });
      console.log(`${c.green('✓')} workspace "${w.name}"`);
    },
  },

  api: {
    usage: 'api METODO PERCORSO [JSON|@FILE|-]',
    summary: 'chiamata diretta alle API (per script e prove), es. org api GET /sync',
    async run(ctx, [method, url, body]) {
      if (!method || !url) fail('Uso: org api GET /sync   oppure   org api PATCH /entries/12 \'{"done":true}\'');
      let json;
      if (body !== undefined) {
        const text = body === '-' ? await readStdin() : body.startsWith('@') ? fs.readFileSync(body.slice(1), 'utf8') : body;
        try {
          json = JSON.parse(text);
        } catch {
          fail('Il corpo deve essere JSON valido');
        }
      }
      const r = await ctx.api().request(method.toUpperCase(), url.replace(/^\/?(api\/)?/, '/'), { json });
      if (r == null) return;
      console.log(typeof r === 'string' ? r.trimEnd() : JSON.stringify(r, null, 2));
    },
  },
};
