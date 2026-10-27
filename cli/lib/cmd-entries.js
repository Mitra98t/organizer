// Voci: todo, mail e note del diario. Si scrivono con la stessa sintassi della barra rapida dell'app.
import { c, fail, ask, readStdin, table, heading, fmtDue, fmtTime, fmtSize, rich, today, editText } from './term.js';
import { entryProjects, descendants, projectRef, itemRef, userRef, userName, isMine, numRef, linkRefs } from './data.js';

const MARK = { todo: '•', mail: '✉', note: '✎' };

// Una riga per voce: numero, scadenza, titolo con destinatario, progetti e assegnatario.
export function entryRow(D, e, indent = '') {
  const done = Boolean(e.done_at);
  const projects = (e.projects || entryProjects(D, e)).map(p => c.magenta(`@${p.tag}`));
  const who = e.assignee_id && e.assignee_id !== D.me.id ? c.blue(`+${userName(D, e.assignee_id)}`) : null;
  const to = e.kind === 'mail' && e.contact ? c.dim(`→ ${e.contact}`) : null;
  const title = done ? c.dim(linkRefs(D, e.title)) : linkRefs(D, rich(e.title), c.blue);
  return [c.dim(e.id), fmtDue(e.due, { done }), `${indent}${done ? c.green('✓') : MARK[e.kind]} ${[title, to, ...projects, who].filter(Boolean).join(' ')}`];
}

// Rilegge la voce dal server e la stampa su una riga (dopo una modifica: si vede il risultato vero).
export async function printEntry(ctx, id) {
  const e = await ctx.api().get(`/entries/${id}`);
  if (ctx.json) return ctx.out(e);
  table([entryRow(await ctx.data(), e)]);
}

// Le voci che collegano qualcosa: mail da mandare, mail mandate (per sapere se è già partito), todo e note.
export function printBacklinks(D, list, title, { mailsOnly = false } = {}) {
  const groups = [
    ['Mail da mandare', list.filter(e => e.kind === 'mail' && !e.done_at)],
    ['Mail mandate', list.filter(e => e.kind === 'mail' && e.done_at)],
    ['Todo e note', mailsOnly ? [] : list.filter(e => e.kind !== 'mail')],
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

// Voci con le loro sotto-attività rientrate sotto (se anche loro sono nell'elenco).
export function printTree(D, list, { desc = false } = {}) {
  const shown = new Set(list.map(e => e.id));
  const rows = [];
  for (const e of sortEntries(list.filter(x => !x.parent_id || !shown.has(x.parent_id)), desc)) {
    rows.push(entryRow(D, e));
    for (const s of sortEntries(list.filter(x => x.parent_id === e.id))) rows.push(entryRow(D, s, '  '));
  }
  table(rows);
}

// Più numeri in una volta: org done 12 13 14
async function eachId(ctx, refs, fn) {
  if (!refs.length) fail('Manca il numero della voce');
  for (const id of refs.map(r => numRef(r))) {
    await fn(id);
    await printEntry(ctx, id);
  }
}

const KIND = { mail: 'mail', note: 'note', todo: 'todo' };

export default {
  add: {
    usage: 'add TESTO… [-d QUANDO] [-p PROGETTO] [--parent ID] [--mail|--note] [--private]',
    summary: 'nuova voce con la sintassi della barra rapida; senza testo lo chiede (o legge una voce per riga da stdin)',
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
      if (!lines.length) fail('Scrivi qualcosa');
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
    usage: 'ls [FILTRO] [--mail|--todo|--note] [-p PROGETTO] [-i CODICE] [-u UTENTE|--mine] [--late] [--done|--all]',
    summary: 'voci aperte (predefinito: todo e mail), ordinate per scadenza',
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
      if (!list.length) return console.log(c.dim('Nessuna voce'));
      // Il diario si legge dal più recente.
      printTree(D, list, { desc: kinds.length === 1 && kinds[0] === 'note' });
    },
  },

  show: {
    usage: 'show ID',
    summary: 'una voce per intero: note, storico, sotto-attività, articoli, allegati',
    async run(ctx, [ref]) {
      const e = await ctx.api().get(`/entries/${numRef(ref)}`);
      if (ctx.json) return ctx.out(e);
      const D = await ctx.data();
      const kind = { todo: 'todo', mail: 'mail', note: 'nota' }[e.kind];
      const state = e.done_at ? c.green(`fatta il ${fmtTime(e.done_at)}`) : e.kind === 'note' ? '' : 'aperta';
      console.log(`${c.bold(`${e.id}`)} ${c.dim('·')} ${kind}${state ? ` ${c.dim('·')} ${state}` : ''}${e.due ? ` ${c.dim('·')} ${e.kind === 'note' ? '' : 'scade '}${fmtDue(e.due, { done: !!e.done_at })}` : ''}${e.private ? c.dim(' · privata') : ''}`);
      console.log(c.bold(linkRefs(D, rich(e.title), c.blue)));
      const meta = [
        e.projects.length && ['progetti', e.projects.map(p => c.magenta(`@${p.tag}`)).join(' ')],
        e.assignee_id && ['assegnata a', userName(D, e.assignee_id)],
        e.items.length && ['articoli', e.items.map(i => c.cyan(i.code)).join(' ')],
        e.kind === 'mail' && ['a', e.contact || c.dim('—')],
        e.mail_cc && ['cc', e.mail_cc],
        e.kind === 'mail' && ['oggetto', e.mail_subject || c.dim(e.title.replace(/(^|\s)#/g, '$1'))],
        ['scritta da', `${userName(D, e.created_by)} il ${fmtTime(e.created_at)}`],
      ].filter(Boolean);
      table(meta.map(([k, v]) => [c.dim(k), v]), { right: [] });
      if (e.notes) {
        heading(e.kind === 'mail' ? 'Testo' : 'Note');
        console.log(linkRefs(D, rich(e.notes), c.blue));
      }
      if (e.attachments.length) {
        heading('Allegati');
        table(e.attachments.map(a => [c.dim(a.id), a.filename, c.dim(fmtSize(a.size)), a.doc_id ? c.dim(`documento ${a.doc_id}`) : '']));
      }
      if (e.subtasks.length) {
        heading('Sotto-attività');
        table(e.subtasks.map(s => entryRow(D, { ...s, projects: [] })));
      }
      if (e.logs.length) {
        heading('Storico');
        table(e.logs.map(l => [c.dim(fmtTime(l.created_at)), c.dim(userName(D, l.user_id)), l.system ? c.dim(l.text) : linkRefs(D, rich(l.text), c.blue)]), { right: [] });
      }
      printBacklinks(D, await ctx.api().get(`/backlinks/voce/${e.id}`), 'Citata in');
    },
  },

  done: {
    usage: 'done ID…',
    summary: 'segna come fatte',
    run: (ctx, pos) => eachId(ctx, pos, id => ctx.api().patch(`/entries/${id}`, { done: true })),
  },

  reopen: {
    usage: 'reopen ID…',
    summary: 'riapre voci fatte',
    run: (ctx, pos) => eachId(ctx, pos, id => ctx.api().patch(`/entries/${id}`, { done: false })),
  },

  log: {
    usage: 'log ID TESTO…',
    summary: 'aggiornamento (cosa hai scoperto); accetta !data e +utente come nell\'app',
    async run(ctx, [ref, ...words]) {
      const id = numRef(ref);
      const text = words.join(' ') || await ask(`${c.dim('aggiornamento ›')} `);
      await ctx.api().post(`/entries/${id}/log`, { text, today: today() });
      await printEntry(ctx, id);
    },
  },

  due: {
    usage: 'due ID… QUANDO',
    summary: 'scadenza: oggi, domani, lun…dom, 3g, 2s, 1m, fm, 25/11, 2026-11-25; "no" la toglie',
    run: (ctx, pos) => {
      const when = pos.length > 1 ? pos.pop() : fail('Uso: org due ID… QUANDO');
      return eachId(ctx, pos, id => ctx.api().patch(`/entries/${id}`, { due: when, today: today() }));
    },
  },

  assign: {
    usage: 'assign ID… UTENTE|-',
    summary: 'assegna a una persona del workspace ("-" toglie l\'assegnazione)',
    async run(ctx, pos) {
      const who = pos.length > 1 ? pos.pop() : fail('Uso: org assign ID… UTENTE');
      const D = await ctx.data();
      const assignee = who === '-' ? null : userRef(D, who).id;
      await eachId(ctx, pos, id => ctx.api().patch(`/entries/${id}`, { assignee_id: assignee }));
    },
  },

  edit: {
    usage: 'edit ID [--title TESTO] [--notes TESTO]',
    summary: 'titolo e note; senza opzioni apre $EDITOR (prima riga: titolo, poi le note)',
    options: { title: { type: 'string', short: 't' }, notes: { type: 'string', short: 'n' } },
    async run(ctx, [ref], o) {
      const id = numRef(ref);
      let patch = Object.fromEntries(['title', 'notes'].filter(k => o[k] !== undefined).map(k => [k, o[k]]));
      if (!Object.keys(patch).length) {
        const e = await ctx.api().get(`/entries/${id}`);
        const [title, ...rest] = editText(`${e.title}\n\n${e.notes || ''}`).replace(/\r/g, '').split('\n');
        patch = { title: title.trim(), notes: rest.join('\n').replace(/^\n+/, '').trimEnd() };
        if (patch.title === e.title && patch.notes === (e.notes || '')) return console.log(c.dim('Nessuna modifica'));
      }
      await ctx.api().patch(`/entries/${id}`, { ...patch, today: today() });
      await printEntry(ctx, id);
    },
  },

  mv: {
    usage: 'mv ID… PROGETTO|-   oppure   mv ID… --add PROGETTO --rm PROGETTO',
    summary: 'sposta voci in un progetto ("-" = nessuno); --add/--rm aggiungono o tolgono un progetto in più',
    options: { add: { type: 'string', multiple: true }, rm: { type: 'string', multiple: true } },
    async run(ctx, pos, o) {
      const D = await ctx.data();
      const api = ctx.api();
      const extra = o.add || o.rm;
      const target = extra ? undefined : pos.length > 1 ? pos.pop() : fail('Uso: org mv ID… PROGETTO');
      const pid = target === undefined || target === '-' ? null : projectRef(D, target).id;
      await eachId(ctx, pos, async id => {
        if (target !== undefined) {
          // Tolti tutti gli altri progetti, quello scelto resta (o diventa) il principale.
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
    summary: 'sposta nel cestino (con le sotto-attività); si recupera con org restore',
    async run(ctx, pos) {
      if (!pos.length) fail('Manca il numero della voce');
      for (const id of pos.map(r => numRef(r))) {
        await ctx.api().del(`/entries/${id}`);
        console.log(`${c.dim('cestino ←')} ${id}`);
      }
    },
  },

  search: {
    usage: 'search TESTO…',
    summary: 'cerca in voci (anche archiviate), progetti, magazzino e documenti',
    async run(ctx, pos) {
      const q = pos.join(' ').toLowerCase() || fail('Cosa cerco?');
      const D = await ctx.data();
      const has = (...v) => v.some(s => String(s ?? '').toLowerCase().includes(q));
      const recent = D.entries.filter(e => has(e.title, e.notes, e.contact));
      const archived = (await ctx.api().get(`/archive?q=${encodeURIComponent(q)}`)).filter(e => !D.entryById.has(e.id));
      const projects = D.projects.filter(p => has(p.name, p.tag, p.notes));
      const items = D.items.filter(i => has(i.code, i.name, i.category, i.location, i.notes, i.firmware));
      const docs = D.docs.filter(d => has(d.label, d.filename, d.url, d.version));
      if (ctx.json) return ctx.out({ entries: [...recent, ...archived], projects, items, docs });
      if (recent.length || archived.length) {
        heading('Voci');
        printTree(D, [...recent, ...archived]);
      }
      if (projects.length) {
        heading('Progetti');
        table(projects.map(p => [c.magenta(`@${p.tag}`), p.name]), { right: [] });
      }
      if (items.length) {
        heading('Magazzino');
        table(items.map(i => [c.cyan(i.code), i.name, c.dim(i.category)]), { right: [] });
      }
      if (docs.length) {
        heading('Documenti');
        table(docs.map(d => [c.dim(d.id), d.kind, d.label || d.filename || d.url, c.cyan(D.itemById.get(d.item_id)?.code ?? '')]));
      }
      if (!recent.length && !archived.length && !projects.length && !items.length && !docs.length) console.log(c.dim('Niente'));
    },
  },

  trash: {
    usage: 'trash',
    summary: 'cosa c\'è nel cestino (si svuota da solo dopo qualche settimana)',
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
      if (!rows.length) return console.log(c.dim('Il cestino è vuoto'));
      table(rows.map(([type, id, label, at]) => [c.dim(type), c.dim(id), label, c.dim(fmtTime(at))]), { right: [1] });
      console.log(c.dim(`\nRipristino: org restore TIPO ID  (eliminati da più di ${t.days} giorni spariscono)`));
    },
  },

  restore: {
    usage: 'restore TIPO ID',
    summary: 'ripristina dal cestino (TIPO: entry, project, item, doc, contact)',
    async run(ctx, [type, ref]) {
      if (!['entry', 'project', 'item', 'doc', 'contact'].includes(type)) fail('Uso: org restore entry|project|item|doc|contact ID');
      await ctx.api().post(`/trash/${type}/${numRef(ref, 'dell\'elemento')}/restore`);
      console.log(`${c.green('✓')} ripristinato`);
    },
  },
};
