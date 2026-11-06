// Entries: todos, mails and journal notes. They are written with the same syntax as the app's quick bar.
import { c, fail, ask, readStdin, table, heading, fmtDue, fmtTime, fmtSize, rich, today, editText } from './term.js';
import { entryProjects, descendants, projectRef, itemRef, userRef, userName, isMine, numRef, linkRefs } from './data.js';
import { tr } from './i18n.js';

const MARK = { todo: '•', mail: '✉', note: '✎' };

// One row per entry: number, due date, title with recipient, projects and assignee.
export function entryRow(D, e, indent = '') {
  const done = Boolean(e.done_at);
  const projects = (e.projects || entryProjects(D, e)).map(p => c.magenta(`@${p.tag}`));
  const who = e.assignee_id && e.assignee_id !== D.me.id ? c.blue(`+${userName(D, e.assignee_id)}`) : null;
  const to = e.kind === 'mail' && e.contact ? c.dim(`→ ${e.contact}`) : null;
  const title = done ? c.dim(linkRefs(D, e.title)) : linkRefs(D, rich(e.title), c.blue);
  return [c.dim(e.id), fmtDue(e.due, { done }), `${indent}${done ? c.green('✓') : MARK[e.kind]} ${[title, to, ...projects, who].filter(Boolean).join(' ')}`];
}

// Reads the entry again from the server and prints it on one row (after a change: the real result shows).
export async function printEntry(ctx, id) {
  const e = await ctx.api().get(`/entries/${id}`);
  if (ctx.json) return ctx.out(e);
  table([entryRow(await ctx.data(), e)]);
}

// The entries that link something: mails to send, sent mails (to know whether it already went out), todos and notes.
export function printBacklinks(D, list, title, { mailsOnly = false } = {}) {
  const groups = [
    [tr('Mails to send'), list.filter(e => e.kind === 'mail' && !e.done_at)],
    [tr('Sent mails'), list.filter(e => e.kind === 'mail' && e.done_at)],
    [tr('Todos and notes'), mailsOnly ? [] : list.filter(e => e.kind !== 'mail')],
  ].filter(([, rows]) => rows.length);
  if (!groups.length) return;
  heading(title);
  for (const [label, rows] of groups) {
    console.log(c.dim(`  ${label}`));
    table(rows.map(e => [c.dim(e.id), e.done_at ? c.dim(fmtTime(e.done_at)) : fmtDue(e.due), `${MARK[e.kind]} ${linkRefs(D, e.title)}${e.kind === 'mail' && e.contact ? c.dim(` → ${e.contact}`) : ''}`]));
  }
}

const sortEntries = (list, desc = false) => list.sort((a, b) =>
  (a.due && b.due ? a.due.localeCompare(b.due) * (desc ? -1 : 1) : a.due ? -1 : b.due ? 1 : 0) || a.id - b.id);

// Entries with their subtasks indented below (if they are in the list too).
export function printTree(D, list, { desc = false } = {}) {
  const shown = new Set(list.map(e => e.id));
  const rows = [];
  for (const e of sortEntries(list.filter(x => !x.parent_id || !shown.has(x.parent_id)), desc)) {
    rows.push(entryRow(D, e));
    for (const s of sortEntries(list.filter(x => x.parent_id === e.id))) rows.push(entryRow(D, s, '  '));
  }
  table(rows);
}

// Several numbers at once: org done 12 13 14
async function eachId(ctx, refs, fn) {
  if (!refs.length) fail(tr('The entry number is missing'));
  for (const id of refs.map(r => numRef(r))) {
    await fn(id);
    await printEntry(ctx, id);
  }
}

const KIND = { mail: 'mail', note: 'note', todo: 'todo' };

export default {
  add: {
    usage: tr('add TEXT… [-d WHEN] [-p PROJECT] [--parent ID] [--mail|--note] [--private]'),
    summary: tr('new entry with the quick bar syntax; without text it asks for it (or reads one entry per line from stdin)'),
    options: {
      due: { type: 'string', short: 'd' }, project: { type: 'string', short: 'p', multiple: true }, parent: { type: 'string' },
      mail: { type: 'boolean' }, note: { type: 'boolean' }, todo: { type: 'boolean' }, private: { type: 'boolean' },
    },
    async run(ctx, pos, o) {
      let lines;
      if (pos.length) lines = [pos.join(' ')];
      else if (process.stdin.isTTY) lines = [await ask(`${c.dim('›')} `)];
      else lines = (await readStdin()).split('\n');
      lines = lines.map(l => l.trim()).filter(Boolean);
      if (!lines.length) fail(tr('Write something'));
      const kind = Object.keys(KIND).find(k => o[k]);
      const ids = [];
      for (let text of lines) {
        for (const p of o.project ?? []) text += ` @${p.replace(/^@/, '')}`;
        if (o.due) text += ` !${o.due.replace(/^!/, '')}`;
        const { id } = await ctx.api().post('/entries', {
          text, today: today(), kind, private: o.private, parent_id: o.parent ? numRef(o.parent) : undefined,
        });
        ids.push(id);
        if (!ctx.json) await printEntry(ctx, id);
      }
      if (ctx.json) ctx.out(ids);
    },
  },

  ls: {
    usage: tr('ls [FILTER] [--mail|--todo|--note] [-p PROJECT] [-i CODE] [-u USER|--mine] [--late] [--done|--all]'),
    summary: tr('open entries (default: todos and mails), sorted by due date'),
    options: {
      mail: { type: 'boolean' }, todo: { type: 'boolean' }, note: { type: 'boolean' },
      project: { type: 'string', short: 'p' }, item: { type: 'string', short: 'i' }, user: { type: 'string', short: 'u' },
      mine: { type: 'boolean', short: 'm' }, late: { type: 'boolean', short: 'l' }, done: { type: 'boolean' }, all: { type: 'boolean', short: 'a' },
    },
    async run(ctx, pos, o) {
      const D = await ctx.data();
      let kinds = Object.keys(KIND).filter(k => o[k]);
      if (!kinds.length) kinds = ['todo', 'mail'];
      const inProject = o.project && descendants(D, projectRef(D, o.project).id);
      const item = o.item && itemRef(D, o.item);
      const user = o.user && userRef(D, o.user);
      const q = pos.join(' ').toLowerCase();
      const t = today();
      const list = D.entries.filter(e => kinds.includes(e.kind)
        && (o.all || (o.done ? e.done_at : !e.done_at))
        && (!inProject || entryProjects(D, e).some(p => inProject.has(p.id)))
        && (!item || (D.itemsOfEntry.get(e.id) || []).includes(item.id))
        && (!user || e.assignee_id === user.id)
        && (!o.mine || isMine(D, e))
        && (!o.late || (e.due && e.due <= t))
        && (!q || `${e.title} ${e.notes} ${e.contact || ''}`.toLowerCase().includes(q)));
      if (ctx.json) return ctx.out(list);
      if (!list.length) return console.log(c.dim(tr('No entries')));
      // The journal is read from the most recent.
      printTree(D, list, { desc: kinds.length === 1 && kinds[0] === 'note' });
    },
  },

  show: {
    usage: 'show ID',
    summary: tr('an entry in full: notes, history, subtasks, items, attachments'),
    async run(ctx, [ref]) {
      const e = await ctx.api().get(`/entries/${numRef(ref)}`);
      if (ctx.json) return ctx.out(e);
      const D = await ctx.data();
      const kind = { todo: 'todo', mail: 'mail', note: tr('note') }[e.kind];
      const state = e.done_at ? c.green(tr('done on {when}', { when: fmtTime(e.done_at) })) : e.kind === 'note' ? '' : tr('open');
      const sep = ` ${c.dim('·')} `;
      console.log(`${c.bold(`${e.id}`)}${sep}${kind}${state ? `${sep}${state}` : ''}${e.due ? `${sep}${e.kind === 'note' ? '' : `${tr('due')} `}${fmtDue(e.due, { done: !!e.done_at })}` : ''}${e.private ? c.dim(` · ${tr('private')}`) : ''}`);
      console.log(c.bold(linkRefs(D, rich(e.title), c.blue)));
      const meta = [
        e.projects.length && [tr('projects'), e.projects.map(p => c.magenta(`@${p.tag}`)).join(' ')],
        e.assignee_id && [tr('assigned to'), userName(D, e.assignee_id)],
        e.items.length && [tr('items'), e.items.map(i => c.cyan(i.code)).join(' ')],
        e.kind === 'mail' && [tr('to||mail recipient'), e.contact || c.dim('—')],
        e.mail_cc && ['cc', e.mail_cc],
        e.kind === 'mail' && [tr('subject'), e.mail_subject || c.dim(e.title.replace(/(^|\s)#/g, '$1'))],
        [tr('written by'), tr('{user} on {when}', { user: userName(D, e.created_by), when: fmtTime(e.created_at) })],
      ].filter(Boolean);
      table(meta.map(([k, v]) => [c.dim(k), v]), { right: [] });
      if (e.notes) {
        heading(e.kind === 'mail' ? tr('Text') : tr('Notes'));
        console.log(linkRefs(D, rich(e.notes), c.blue));
      }
      if (e.attachments.length) {
        heading(tr('Attachments'));
        table(e.attachments.map(a => [c.dim(a.id), a.filename, c.dim(fmtSize(a.size)), a.doc_id ? c.dim(tr('document {id}', { id: a.doc_id })) : '']));
      }
      if (e.subtasks.length) {
        heading(tr('Subtasks'));
        table(e.subtasks.map(s => entryRow(D, { ...s, projects: [] })));
      }
      if (e.logs.length) {
        heading(tr('History'));
        table(e.logs.map(l => [c.dim(fmtTime(l.created_at)), c.dim(userName(D, l.user_id)), l.system ? c.dim(l.text) : linkRefs(D, rich(l.text), c.blue)]), { right: [] });
      }
      printBacklinks(D, await ctx.api().get(`/backlinks/voce/${e.id}`), tr('Mentioned in'));
    },
  },

  done: {
    usage: 'done ID…',
    summary: tr('marks as done'),
    run: (ctx, pos) => eachId(ctx, pos, id => ctx.api().patch(`/entries/${id}`, { done: true })),
  },

  reopen: {
    usage: 'reopen ID…',
    summary: tr('reopens done entries'),
    run: (ctx, pos) => eachId(ctx, pos, id => ctx.api().patch(`/entries/${id}`, { done: false })),
  },

  log: {
    usage: tr('log ID TEXT…'),
    summary: tr('update (what you found out); accepts !date and +user as in the app'),
    async run(ctx, [ref, ...words]) {
      const id = numRef(ref);
      const text = words.join(' ') || await ask(`${c.dim(`${tr('update')} ›`)} `);
      await ctx.api().post(`/entries/${id}/log`, { text, today: today() });
      await printEntry(ctx, id);
    },
  },

  due: {
    usage: tr('due ID… WHEN'),
    summary: tr('due date: today, tomorrow, mon…sun, 3d, 2w, 1m, eom, 25/11, 2026-11-25; "none" removes it'),
    run: (ctx, pos) => {
      const when = pos.length > 1 ? pos.pop() : fail(tr('Usage: org due ID… WHEN'));
      return eachId(ctx, pos, id => ctx.api().patch(`/entries/${id}`, { due: when, today: today() }));
    },
  },

  assign: {
    usage: tr('assign ID… USER|-'),
    summary: tr('assigns to a person of the workspace ("-" removes the assignment)'),
    async run(ctx, pos) {
      const who = pos.length > 1 ? pos.pop() : fail(tr('Usage: org assign ID… USER'));
      const D = await ctx.data();
      const assignee = who === '-' ? null : userRef(D, who).id;
      await eachId(ctx, pos, id => ctx.api().patch(`/entries/${id}`, { assignee_id: assignee }));
    },
  },

  edit: {
    usage: tr('edit ID [--title TEXT] [--notes TEXT]'),
    summary: tr('title and notes; without options it opens $EDITOR (first line: title, then the notes)'),
    options: { title: { type: 'string', short: 't' }, notes: { type: 'string', short: 'n' } },
    async run(ctx, [ref], o) {
      const id = numRef(ref);
      let patch = Object.fromEntries(['title', 'notes'].filter(k => o[k] !== undefined).map(k => [k, o[k]]));
      if (!Object.keys(patch).length) {
        const e = await ctx.api().get(`/entries/${id}`);
        const [title, ...rest] = editText(`${e.title}\n\n${e.notes || ''}`).replace(/\r/g, '').split('\n');
        patch = { title: title.trim(), notes: rest.join('\n').replace(/^\n+/, '').trimEnd() };
        if (patch.title === e.title && patch.notes === (e.notes || '')) return console.log(c.dim(tr('No changes')));
      }
      await ctx.api().patch(`/entries/${id}`, { ...patch, today: today() });
      await printEntry(ctx, id);
    },
  },

  mv: {
    usage: tr('mv ID… PROJECT|-   or   mv ID… --add PROJECT --rm PROJECT'),
    summary: tr('moves entries into a project ("-" = none); --add/--rm add or remove an extra project'),
    options: { add: { type: 'string', multiple: true }, rm: { type: 'string', multiple: true } },
    async run(ctx, pos, o) {
      const D = await ctx.data();
      const api = ctx.api();
      const extra = o.add || o.rm;
      const target = extra ? undefined : pos.length > 1 ? pos.pop() : fail(tr('Usage: org mv ID… PROJECT'));
      const pid = target === undefined || target === '-' ? null : projectRef(D, target).id;
      await eachId(ctx, pos, async id => {
        if (target !== undefined) {
          // All the other projects removed, the chosen one stays (or becomes) the main one.
          const current = (await api.get(`/entries/${id}`)).projects.map(p => p.id);
          for (const x of current) if (x !== pid) await api.del(`/entries/${id}/projects/${x}`);
          if (pid && !current.includes(pid)) await api.post(`/entries/${id}/projects`, { project_id: pid });
        }
        for (const t of o.add ?? []) await api.post(`/entries/${id}/projects`, { project_id: projectRef(D, t).id });
        for (const t of o.rm ?? []) await api.del(`/entries/${id}/projects/${projectRef(D, t).id}`);
      });
    },
  },

  rm: {
    usage: 'rm ID…',
    summary: tr('moves to the trash (with the subtasks); it comes back with org restore'),
    async run(ctx, pos) {
      if (!pos.length) fail(tr('The entry number is missing'));
      for (const id of pos.map(r => numRef(r))) {
        await ctx.api().del(`/entries/${id}`);
        console.log(`${c.dim(`${tr('trash')} ←`)} ${id}`);
      }
    },
  },

  search: {
    usage: tr('search TEXT…'),
    summary: tr('searches entries (archived ones too), projects, inventory and documents'),
    async run(ctx, pos) {
      const q = pos.join(' ').toLowerCase() || fail(tr('What should I look for?'));
      const D = await ctx.data();
      const has = (...v) => v.some(s => String(s ?? '').toLowerCase().includes(q));
      const recent = D.entries.filter(e => has(e.title, e.notes, e.contact));
      const archived = (await ctx.api().get(`/archive?q=${encodeURIComponent(q)}`)).filter(e => !D.entryById.has(e.id));
      const projects = D.projects.filter(p => has(p.name, p.tag, p.notes));
      const items = D.items.filter(i => has(i.code, i.name, i.category, i.location, i.notes, i.firmware));
      const docs = D.docs.filter(d => has(d.label, d.filename, d.url, d.version));
      if (ctx.json) return ctx.out({ entries: [...recent, ...archived], projects, items, docs });
      if (recent.length || archived.length) {
        heading(tr('Entries'));
        printTree(D, [...recent, ...archived]);
      }
      if (projects.length) {
        heading(tr('Projects'));
        table(projects.map(p => [c.magenta(`@${p.tag}`), p.name]), { right: [] });
      }
      if (items.length) {
        heading(tr('Inventory'));
        table(items.map(i => [c.cyan(i.code), i.name, c.dim(i.category)]), { right: [] });
      }
      if (docs.length) {
        heading(tr('Documents'));
        table(docs.map(d => [c.dim(d.id), d.kind, d.label || d.filename || d.url, c.cyan(D.itemById.get(d.item_id)?.code ?? '')]));
      }
      if (!recent.length && !archived.length && !projects.length && !items.length && !docs.length) console.log(c.dim(tr('Nothing')));
    },
  },

  trash: {
    usage: 'trash',
    summary: tr('what is in the trash (it empties by itself after a few weeks)'),
    async run(ctx) {
      const t = await ctx.api().get('/trash');
      if (ctx.json) return ctx.out(t);
      const rows = [
        ...t.entries.map(e => ['entry', e.id, e.title, e.deleted_at]),
        ...t.projects.map(p => ['project', p.id, `@${p.tag} ${p.name}`, p.deleted_at]),
        ...t.items.map(i => ['item', i.id, `${i.code} ${i.name}`, i.deleted_at]),
        ...t.docs.map(d => ['doc', d.id, `${d.label || d.filename || d.url} (${d.item_code})`, d.deleted_at]),
        ...t.contacts.map(x => ['contact', x.id, x.name || x.email, x.deleted_at]),
      ].sort((a, b) => b[3].localeCompare(a[3]));
      if (!rows.length) return console.log(c.dim(tr('The trash is empty')));
      table(rows.map(([type, id, label, at]) => [c.dim(type), c.dim(id), label, c.dim(fmtTime(at))]), { right: [1] });
      console.log(c.dim(`\n${tr('Restore: org restore TYPE ID  (deleted more than {days} days ago they disappear)', { days: t.days })}`));
    },
  },

  restore: {
    usage: tr('restore TYPE ID'),
    summary: tr('restores from the trash (TYPE: entry, project, item, doc, contact)'),
    async run(ctx, [type, ref]) {
      if (!['entry', 'project', 'item', 'doc', 'contact'].includes(type)) fail(tr('Usage: org restore entry|project|item|doc|contact ID'));
      await ctx.api().post(`/trash/${type}/${numRef(ref, tr('The element number is missing'))}/restore`);
      console.log(`${c.green('✓')} ${tr('restored')}`);
    },
  },
};
