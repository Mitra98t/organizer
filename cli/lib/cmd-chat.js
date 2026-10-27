// Chat del workspace dal terminale: leggere, scrivere, seguire in tempo reale (org chat -f).
import { c, fail, ask, readStdin, rich, ymd } from './term.js';
import { userName } from './data.js';

// [[doc:12]] [[voce:34]] [[contatto:5]] con il nome attuale; @progetto e +persona colorati come nell'app.
function render(D, text) {
  const name = (kind, id) => {
    if (kind === 'doc') {
      const d = D.docById.get(id);
      return d ? `${d.label || d.filename || d.url} (${D.itemById.get(d.item_id)?.code ?? '?'})` : 'documento eliminato';
    }
    if (kind === 'voce') return D.entryById.get(id)?.title.replace(/(^|\s)#/g, '$1') ?? `voce ${id}`;
    const ct = D.contacts.find(x => x.id === id);
    return ct ? ct.name || ct.email : 'contatto eliminato';
  };
  return rich(text)
    .replace(/\[\[(doc|voce|contatto):(\d+)\]\]/g, (_, kind, id) => c.blue(`«${name(kind, +id)}»`))
    .replace(/(^|[\s(,;:])@([\p{L}\d_][\p{L}\d_-]*)/gu, (m, pre, tag) => (D.projectByTag.has(tag.toLowerCase()) ? pre + c.magenta(`@${tag}`) : m))
    .replace(/(^|[\s(,;:])\+([\p{L}\d_.-]*[\p{L}\d_])/gu, (m, pre, u) => (D.users.some(x => x.username.toLowerCase() === u.toLowerCase()) ? pre + c.bold(c.blue(`+${u}`)) : m));
}

// Stampa i messaggi con il giorno quando cambia; restituisce l'ultimo giorno stampato.
function print(D, list, lastDay = null) {
  for (const m of list) {
    const d = new Date(m.created_at);
    const day = ymd(d);
    if (day !== lastDay) console.log(c.dim(`── ${d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })} ──`));
    lastDay = day;
    const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const who = m.user_id === D.me.id ? c.green(userName(D, m.user_id)) : c.bold(userName(D, m.user_id));
    console.log(`${c.dim(time)} ${who}  ${render(D, m.text)}${m.edited_at ? c.dim(' (modificato)') : ''}`);
  }
  return lastDay;
}

const markRead = (ctx, list) => list.length && ctx.api().post('/chat/read', { id: list.at(-1).id }).catch(() => {});

// Segue la chat: a ogni notifica del server (/api/events) legge i messaggi nuovi. Ctrl-C per uscire.
async function follow(ctx, D, lastId, lastDay) {
  console.log(c.dim('In ascolto… (Ctrl-C per uscire)'));
  for (;;) {
    try {
      const res = await ctx.api().request('GET', '/events', { raw: true });
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop(); // l'ultimo pezzo può essere un evento non ancora completo
        if (!events.some(ev => ev.includes('event: change'))) continue; // solo ": ping"
        const fresh = await ctx.api().get(`/chat?after=${lastId}&limit=500`);
        if (!fresh.length) continue;
        lastDay = print(D, fresh, lastDay);
        lastId = fresh.at(-1).id;
        await markRead(ctx, fresh);
      }
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
    }
    await new Promise(r => setTimeout(r, 3000)); // connessione caduta: si riprova
  }
}

export default {
  ls: {
    usage: 'chat [-n N] [-f]',
    summary: 'ultimi messaggi della chat del workspace; -f resta in ascolto e mostra i nuovi',
    options: { n: { type: 'string', short: 'n' }, follow: { type: 'boolean', short: 'f' } },
    async run(ctx, _pos, o) {
      const n = o.n ? Math.min(Math.max(parseInt(o.n, 10) || 20, 1), 500) : 20;
      const [D, list] = await Promise.all([ctx.data(), ctx.api().get(`/chat?limit=${n}`)]);
      if (ctx.json) return ctx.out(list);
      if (!list.length && !o.follow) return console.log(c.dim('Nessun messaggio. Scrivi con: org chat send TESTO'));
      const lastDay = print(D, list);
      await markRead(ctx, list);
      if (o.follow) await follow(ctx, D, list.at(-1)?.id ?? 0, lastDay);
    },
  },

  send: {
    usage: 'chat send TESTO…',
    summary: 'scrive nella chat (@progetto #CODICE +persona, [[doc:ID]] [[voce:ID]] [[contatto:ID]]); senza testo lo chiede o lo legge da stdin',
    async run(ctx, pos) {
      const text = pos.length ? pos.join(' ') : process.stdin.isTTY ? await ask(`${c.dim('›')} `) : (await readStdin()).trim();
      if (!text) fail('Scrivi qualcosa');
      const { id } = await ctx.api().post('/chat', { text });
      if (ctx.json) return ctx.out({ id });
      const D = await ctx.data();
      print(D, [{ id, user_id: D.me.id, text, created_at: new Date().toISOString() }]);
    },
  },
};
