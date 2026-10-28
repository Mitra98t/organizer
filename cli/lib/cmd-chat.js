// Chat del workspace dal terminale: leggere, scrivere, seguire in tempo reale (org chat -f), per canale (-c).
// Senza -c vale il primo canale in cui si è (di solito #generale).
import { c, fail, ask, readStdin, rich, ymd } from './term.js';
import { userName, linkRefs } from './data.js';

// Collegamenti con il nome attuale; @progetto e +persona colorati come nell'app.
function render(D, text) {
  return linkRefs(D, rich(text), c.blue)
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
const chanQuery = ch => (ch ? `&channel=${encodeURIComponent(String(ch).replace(/^#/, ''))}` : '');

// Segue la chat: a ogni notifica del server (/api/events) legge i messaggi nuovi. Ctrl-C per uscire.
async function follow(ctx, D, lastId, lastDay, ch) {
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
        const fresh = await ctx.api().get(`/chat?after=${lastId}&limit=500${chanQuery(ch)}`);
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
    usage: 'chat [-c CANALE] [-n N] [-f]',
    summary: 'ultimi messaggi di un canale (di base il primo, es. #generale); -f resta in ascolto e mostra i nuovi',
    options: { channel: { type: 'string', short: 'c' }, n: { type: 'string', short: 'n' }, follow: { type: 'boolean', short: 'f' } },
    async run(ctx, _pos, o) {
      const n = o.n ? Math.min(Math.max(parseInt(o.n, 10) || 20, 1), 500) : 20;
      const [D, list] = await Promise.all([ctx.data(), ctx.api().get(`/chat?limit=${n}${chanQuery(o.channel)}`)]);
      if (ctx.json) return ctx.out(list);
      if (!list.length && !o.follow) return console.log(c.dim('Nessun messaggio. Scrivi con: org chat send TESTO'));
      const lastDay = print(D, list);
      await markRead(ctx, list);
      if (o.follow) await follow(ctx, D, list.at(-1)?.id ?? 0, lastDay, o.channel);
    },
  },

  send: {
    usage: 'chat send [-c CANALE] TESTO…',
    summary: 'scrive in un canale (@progetto #CODICE +persona, [[doc:ID]] [[voce:ID]] [[contatto:ID]]); senza testo lo chiede o lo legge da stdin',
    options: { channel: { type: 'string', short: 'c' } },
    async run(ctx, pos, o) {
      const text = pos.length ? pos.join(' ') : process.stdin.isTTY ? await ask(`${c.dim('›')} `) : (await readStdin()).trim();
      if (!text) fail('Scrivi qualcosa');
      const { id } = await ctx.api().post('/chat', { text, ...(o.channel ? { channel: String(o.channel).replace(/^#/, '') } : {}) });
      if (ctx.json) return ctx.out({ id });
      const D = await ctx.data();
      print(D, [{ id, user_id: D.me.id, text, created_at: new Date().toISOString() }]);
    },
  },

  canali: {
    usage: 'chat canali',
    summary: 'i canali in cui sei, con i messaggi non letti (e chi può solo leggere)',
    async run(ctx) {
      const D = await ctx.data();
      const list = (D.chatChannels || []).filter(x => x.member);
      if (ctx.json) return ctx.out(list);
      if (!list.length) return console.log(c.dim('Non sei in nessun canale'));
      for (const ch of list) {
        console.log(`${c.bold(`#${ch.name}`)}${ch.unread ? c.yellow(` ${ch.unread} da leggere`) : ''}${ch.can_write ? '' : c.dim(' (solo lettura)')}${ch.everyone ? c.dim(' · tutti') : ''}`);
      }
    },
  },
};
