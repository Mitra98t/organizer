// The workspace chat from the terminal: read, write, follow in real time (org chat -f), per channel (-c).
// Without -c it is the first channel one is in (usually #general).
import { c, fail, ask, readStdin, rich, ymd } from './term.js';
import { userName, linkRefs } from './data.js';
import { tr, LANG } from './i18n.js';

const LOCALE = LANG === 'it' ? 'it-IT' : 'en-GB';

// Links with the current name; @project and +person coloured as in the app.
function render(D, text) {
  return linkRefs(D, rich(text), c.blue)
    .replace(/(^|[\s(,;:])@([\p{L}\d_][\p{L}\d_-]*)/gu, (m, pre, tag) => (D.projectByTag.has(tag.toLowerCase()) ? pre + c.magenta(`@${tag}`) : m))
    .replace(/(^|[\s(,;:])\+([\p{L}\d_.-]*[\p{L}\d_])/gu, (m, pre, u) => (D.users.some(x => x.username.toLowerCase() === u.toLowerCase()) ? pre + c.bold(c.blue(`+${u}`)) : m));
}

// Prints the messages with the day when it changes; returns the last day printed.
function print(D, list, lastDay = null) {
  for (const m of list) {
    const d = new Date(m.created_at);
    const day = ymd(d);
    if (day !== lastDay) console.log(c.dim(`── ${d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' })} ──`));
    lastDay = day;
    const time = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
    const who = m.user_id === D.me.id ? c.green(userName(D, m.user_id)) : c.bold(userName(D, m.user_id));
    console.log(`${c.dim(time)} ${who}  ${render(D, m.text)}${m.edited_at ? c.dim(` (${tr('edited')})`) : ''}`);
  }
  return lastDay;
}

const markRead = (ctx, list) => list.length && ctx.api().post('/chat/read', { id: list.at(-1).id }).catch(() => {});
const chanQuery = ch => (ch ? `&channel=${encodeURIComponent(String(ch).replace(/^#/, ''))}` : '');

// Follows the chat: at each server notification (/api/events) it reads the new messages. Ctrl-C to quit.
async function follow(ctx, D, lastId, lastDay, ch) {
  console.log(c.dim(tr('Listening… (Ctrl-C to quit)')));
  for (;;) {
    try {
      const res = await ctx.api().request('GET', '/events', { raw: true });
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop(); // the last piece may be an event not complete yet
        if (!events.some(ev => ev.includes('event: change'))) continue; // only ": ping"
        const fresh = await ctx.api().get(`/chat?after=${lastId}&limit=500${chanQuery(ch)}`);
        if (!fresh.length) continue;
        lastDay = print(D, fresh, lastDay);
        lastId = fresh.at(-1).id;
        await markRead(ctx, fresh);
      }
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
    }
    await new Promise(r => setTimeout(r, 3000)); // connection dropped: try again
  }
}

const chat = {
  ls: {
    usage: tr('chat [-c CHANNEL] [-n N] [-f]'),
    summary: tr('latest messages of a channel (by default the first one, e.g. #general); -f keeps listening and shows the new ones'),
    options: { channel: { type: 'string', short: 'c' }, n: { type: 'string', short: 'n' }, follow: { type: 'boolean', short: 'f' } },
    async run(ctx, _pos, o) {
      const n = o.n ? Math.min(Math.max(parseInt(o.n, 10) || 20, 1), 500) : 20;
      const [D, list] = await Promise.all([ctx.data(), ctx.api().get(`/chat?limit=${n}${chanQuery(o.channel)}`)]);
      if (ctx.json) return ctx.out(list);
      if (!list.length && !o.follow) return console.log(c.dim(tr('No messages. Write with: org chat send TEXT')));
      const lastDay = print(D, list);
      await markRead(ctx, list);
      if (o.follow) await follow(ctx, D, list.at(-1)?.id ?? 0, lastDay, o.channel);
    },
  },

  send: {
    usage: tr('chat send [-c CHANNEL] TEXT…'),
    summary: tr('writes in a channel (@project #CODE +person, [[doc:ID]] [[voce:ID]] [[contatto:ID]]); without text it asks for it or reads it from stdin'),
    options: { channel: { type: 'string', short: 'c' } },
    async run(ctx, pos, o) {
      const text = pos.length ? pos.join(' ') : process.stdin.isTTY ? await ask(`${c.dim('›')} `) : (await readStdin()).trim();
      if (!text) fail(tr('Write something'));
      const { id } = await ctx.api().post('/chat', { text, ...(o.channel ? { channel: String(o.channel).replace(/^#/, '') } : {}) });
      if (ctx.json) return ctx.out({ id });
      const D = await ctx.data();
      print(D, [{ id, user_id: D.me.id, text, created_at: new Date().toISOString() }]);
    },
  },

  channels: {
    usage: 'chat channels',
    summary: tr('the channels you are in, with the unread messages (and who can only read)'),
    async run(ctx) {
      const D = await ctx.data();
      const list = (D.chatChannels || []).filter(x => x.member);
      if (ctx.json) return ctx.out(list);
      if (!list.length) return console.log(c.dim(tr('You are not in any channel')));
      for (const ch of list) {
        console.log(`${c.bold(`#${ch.name}`)}${ch.unread ? c.yellow(` ${tr('{n} to read', { n: ch.unread })}`) : ''}${ch.can_write ? '' : c.dim(` (${tr('read only')})`)}${ch.everyone ? c.dim(` · ${tr('everyone')}`) : ''}`);
      }
    },
  },
};
// The old Italian name of the subcommand still works (not listed in the help).
Object.defineProperty(chat, 'canali', { value: chat.channels, enumerable: false });

export default chat;
