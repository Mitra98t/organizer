// Magazzino: articoli per codice, categorie, composizione (cosa contiene cosa), stato.
import { c, fail, table, heading, rich, fmtSize, fmtTime } from './term.js';
import { itemRef, projectRef, entryProjects } from './data.js';
import { printTree, printBacklinks } from './cmd-entries.js';

const STATUS_IN = { ok: '', '': '', outdated: 'outdated', superato: 'outdated', discarded: 'discarded', scartato: 'discarded' };
const STATUS_LABEL = { outdated: c.yellow('outdated'), discarded: c.red('scartato') };

// Opzioni comuni a "add" e "set" → campi dell'API.
const FIELD_OPTS = {
  name: { type: 'string', short: 'n' }, cat: { type: 'string', short: 'c' }, fw: { type: 'string' }, loc: { type: 'string', short: 'l' },
  qty: { type: 'string', short: 'q' }, url: { type: 'string' }, notes: { type: 'string' }, status: { type: 'string', short: 's' },
};

function fields(o) {
  const f = {};
  for (const [opt, key] of [['name', 'name'], ['cat', 'category'], ['fw', 'firmware'], ['loc', 'location'], ['url', 'url'], ['notes', 'notes']]) {
    if (o[opt] !== undefined) f[key] = o[opt];
  }
  if (o.qty !== undefined) f.qty = o.qty === '' || o.qty === '-' ? null : Number.isInteger(+o.qty) ? +o.qty : fail('Quantità: un numero intero ("-" la toglie)');
  if (o.status !== undefined) {
    f.status = STATUS_IN[o.status.toLowerCase()];
    if (f.status === undefined) fail('Stato: ok, outdated o scartato');
  }
  return f;
}

const itemRow = i => [c.cyan(i.code), i.name, c.dim(i.firmware ? `fw ${i.firmware}` : ''), c.dim(i.location), i.qty == null ? '' : `×${i.qty}`, STATUS_LABEL[i.status] || ''];

const done = (code, what) => console.log(`${c.green('✓')} ${c.cyan(code)}${what ? ` ${what}` : ''}`);

export default {
  ls: {
    usage: 'item [FILTRO] [-c CATEGORIA]',
    summary: 'magazzino diviso per categoria; il filtro cerca in codice, nome, posizione e note',
    options: { cat: { type: 'string', short: 'c' } },
    async run(ctx, pos, o) {
      const D = await ctx.data();
      const q = pos.join(' ').toLowerCase();
      const list = D.items.filter(i => (!o.cat || i.category.toLowerCase() === o.cat.toLowerCase())
        && (!q || `${i.code} ${(D.aliasesOf.get(i.id) || []).join(' ')} ${i.name} ${i.category} ${i.location} ${i.notes} ${i.firmware}`.toLowerCase().includes(q)));
      if (ctx.json) return ctx.out(list);
      if (!list.length) return console.log(c.dim('Nessun articolo'));
      const cats = [...new Set(list.map(i => i.category))].sort((a, b) => (!a) - (!b) || a.localeCompare(b));
      for (const cat of cats) {
        heading(cat || 'senza categoria');
        table(list.filter(i => i.category === cat).map(itemRow), { right: [] });
      }
    },
  },

  show: {
    usage: 'item show CODICE',
    summary: 'scheda dell\'articolo: dettagli, composizione, documenti, progetti e voci collegate',
    async run(ctx, [ref]) {
      const D = await ctx.data();
      const it = itemRef(D, ref ?? fail('Quale articolo?'));
      const docs = D.docs.filter(d => d.item_id === it.id);
      const children = (D.childrenOf.get(it.id) || []).map(id => D.itemById.get(id)).filter(Boolean);
      const parents = (D.parentsOf.get(it.id) || []).map(id => D.itemById.get(id)).filter(Boolean);
      const entries = D.entries.filter(e => e.kind !== 'mail' && !e.done_at && (D.itemsOfEntry.get(e.id) || []).includes(it.id));
      const mails = await ctx.api().get(`/backlinks/articolo/${it.id}`);
      const projects = new Map(D.projectItems.filter(x => x.item_id === it.id).map(x => [x.project_id, D.projectById.get(x.project_id)]));
      for (const e of entries) for (const p of entryProjects(D, e)) projects.set(p.id, p);
      if (ctx.json) return ctx.out({ ...it, aliases: D.aliasesOf.get(it.id) || [], docs, children, parents, entries, mails, projects: [...projects.values()].filter(Boolean) });
      console.log(`${c.bold(c.cyan(it.code))} ${it.name}${it.status ? ` ${STATUS_LABEL[it.status]}` : ''}`);
      const alts = D.aliasesOf.get(it.id) || [];
      if (alts.length) console.log(c.dim(`anche: ${alts.join(' · ')}`));
      console.log(c.dim(`${ctx.api().base}/#/i/${it.id}`));
      table([
        it.category && ['categoria', it.category],
        it.firmware && ['firmware', it.firmware],
        it.location && ['posizione', it.location],
        it.qty != null && ['quantità', String(it.qty)],
        it.url && ['link', it.url],
        projects.size && ['progetti', [...projects.values()].filter(Boolean).map(p => c.magenta(`@${p.tag}`)).join(' ')],
        parents.length && ['fa parte di', parents.map(p => c.cyan(p.code)).join(' ')],
      ].filter(Boolean).map(([k, v]) => [c.dim(k), v]), { right: [] });
      if (it.notes) {
        heading('Note');
        console.log(rich(it.notes));
      }
      if (children.length) {
        heading('Contiene');
        table(children.map(itemRow), { right: [] });
      }
      if (docs.length) {
        heading('Documenti');
        table(docs.map(d => [c.dim(d.id), d.kind, d.version ? `v${d.version}` : '', d.label || d.filename || d.url, c.dim(d.url ? 'link' : fmtSize(d.size)), c.dim(fmtTime(d.created_at))]));
      }
      if (entries.length) {
        heading('Voci aperte');
        printTree(D, entries);
      }
      printBacklinks(D, mails, 'Nelle mail', { mailsOnly: true });
    },
  },

  add: {
    usage: 'item add CODICE [NOME…] [-c CATEGORIA] [--fw VER] [-l POSIZIONE] [-q N] [--url URL] [-p PROGETTO]',
    summary: 'nuovo articolo (con -p lo collega anche a un progetto)',
    options: { ...FIELD_OPTS, project: { type: 'string', short: 'p' } },
    async run(ctx, [code, ...name], o) {
      if (!code) fail('Manca il codice');
      const f = fields(o);
      if (name.length) f.name = name.join(' ');
      const project = o.project && projectRef(await ctx.data(), o.project);
      const r = await ctx.api().post('/items', { code: code.replace(/^#/, ''), ...f, project_id: project?.id });
      if (ctx.json) return ctx.out(r);
      console.log(`${c.green('+')} ${c.cyan(code.replace(/^#/, ''))} ${f.name || ''}`);
    },
  },

  set: {
    usage: 'item set CODICE [--code NUOVO] [-n NOME] [-c CATEGORIA] [--fw VER] [-l POSIZIONE] [-q N] [--url URL] [--notes TESTO] [-s ok|outdated|scartato]',
    summary: 'modifica un articolo (cambiando il codice si aggiornano anche i #riferimenti nelle voci)',
    options: { ...FIELD_OPTS, code: { type: 'string' } },
    async run(ctx, [ref], o) {
      const it = itemRef(await ctx.data(), ref ?? fail('Quale articolo?'));
      const f = fields(o);
      if (o.code !== undefined) f.code = o.code.replace(/^#/, '');
      if (!Object.keys(f).length) fail('Niente da cambiare: org item set --help');
      await ctx.api().patch(`/items/${it.id}`, f);
      done(f.code ?? it.code);
    },
  },

  mv: {
    usage: 'item mv CODICE… CATEGORIA',
    summary: 'sposta articoli in un\'altra categoria ("-" = senza categoria)',
    async run(ctx, pos) {
      const cat = pos.length > 1 ? pos.pop() : fail('Uso: org item mv CODICE… CATEGORIA');
      const D = await ctx.data();
      for (const ref of pos) {
        const it = itemRef(D, ref);
        await ctx.api().patch(`/items/${it.id}`, { category: cat === '-' ? '' : cat });
        done(it.code, `→ ${cat === '-' ? 'senza categoria' : cat}`);
      }
    },
  },

  alias: {
    usage: 'item alias CODICE [ALTERNATIVO…] [--rm ALTERNATIVO]',
    summary: 'codici alternativi di un articolo: senza altro li elenca, poi li aggiunge; --rm ne toglie uno',
    options: { rm: { type: 'string', multiple: true } },
    async run(ctx, [ref, ...alts], o) {
      const D = await ctx.data();
      const it = itemRef(D, ref ?? fail('Quale articolo?'));
      for (const a of alts) await ctx.api().post(`/items/${it.id}/aliases`, { code: a });
      for (const a of o.rm ?? []) await ctx.api().del(`/items/${it.id}/aliases/${encodeURIComponent(a.replace(/^#/, ''))}`);
      if (!alts.length && !o.rm) {
        const list = D.aliasesOf.get(it.id) || [];
        if (ctx.json) return ctx.out(list);
        return console.log(list.length ? list.join('\n') : c.dim(`${it.code} non ha codici alternativi`));
      }
      done(it.code, 'aggiornato');
    },
  },

  link: {
    usage: 'item link CODICE FIGLIO…',
    summary: 'composizione: CODICE contiene i FIGLI (creati se non esistono)',
    async run(ctx, [ref, ...kids]) {
      const it = itemRef(await ctx.data(), ref ?? fail('Quale articolo?'));
      if (!kids.length) fail('Cosa contiene?');
      for (const code of kids) await ctx.api().post(`/items/${it.id}/children`, { code });
      done(it.code, `contiene ${kids.map(k => c.cyan(k.replace(/^#/, ''))).join(' ')}`);
    },
  },

  unlink: {
    usage: 'item unlink CODICE FIGLIO…',
    summary: 'toglie articoli dalla composizione',
    async run(ctx, [ref, ...kids]) {
      const D = await ctx.data();
      const it = itemRef(D, ref ?? fail('Quale articolo?'));
      for (const k of kids) await ctx.api().del(`/items/${it.id}/children/${itemRef(D, k).id}`);
      done(it.code, 'aggiornato');
    },
  },

  rm: {
    usage: 'item rm CODICE…',
    summary: 'sposta nel cestino (con i suoi documenti)',
    async run(ctx, pos) {
      const D = await ctx.data();
      if (!pos.length) fail('Quale articolo?');
      for (const ref of pos) {
        const it = itemRef(D, ref);
        await ctx.api().del(`/items/${it.id}`);
        console.log(`${c.dim('cestino ←')} ${it.code}  ${c.dim(`(org restore item ${it.id})`)}`);
      }
    },
  },
};
