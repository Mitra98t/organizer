// Inventory: items by code, categories, composition (what contains what), status.
import { c, fail, table, heading, rich, fmtSize, fmtTime } from './term.js';
import { itemRef, projectRef, entryProjects } from './data.js';
import { printTree, printBacklinks } from './cmd-entries.js';
import { tr } from './i18n.js';

// English and Italian words both work.
const STATUS_IN = { ok: '', '': '', evaluation: 'evaluation', valutazione: 'evaluation', outdated: 'outdated', superato: 'outdated', discarded: 'discarded', scartato: 'discarded' };
const STATUS_LABEL = { evaluation: c.blue(tr('being evaluated')), outdated: c.yellow(tr('outdated')), discarded: c.red(tr('discarded')) };

// Options shared by "add" and "set" → API fields.
const FIELD_OPTS = {
  name: { type: 'string', short: 'n' }, cat: { type: 'string', short: 'c' }, fw: { type: 'string' }, loc: { type: 'string', short: 'l' },
  qty: { type: 'string', short: 'q' }, url: { type: 'string' }, notes: { type: 'string' }, status: { type: 'string', short: 's' },
};

function fields(o) {
  const f = {};
  for (const [opt, key] of [['name', 'name'], ['cat', 'category'], ['fw', 'firmware'], ['loc', 'location'], ['url', 'url'], ['notes', 'notes']]) {
    if (o[opt] !== undefined) f[key] = o[opt];
  }
  if (o.qty !== undefined) f.qty = o.qty === '' || o.qty === '-' ? null : Number.isInteger(+o.qty) ? +o.qty : fail(tr('Quantity: a whole number ("-" removes it)'));
  if (o.status !== undefined) {
    f.status = STATUS_IN[o.status.toLowerCase()];
    if (f.status === undefined) fail(tr('Status: ok, evaluation, outdated or discarded'));
  }
  return f;
}

const itemRow = i => [c.cyan(i.code), i.name, c.dim(i.firmware ? `fw ${i.firmware}` : ''), c.dim(i.location), i.qty == null ? '' : `×${i.qty}`, STATUS_LABEL[i.status] || ''];

const done = (code, what) => console.log(`${c.green('✓')} ${c.cyan(code)}${what ? ` ${what}` : ''}`);

export default {
  ls: {
    usage: tr('item [FILTER] [-c CATEGORY]'),
    summary: tr('inventory split by category; the filter searches code, name, location and notes'),
    options: { cat: { type: 'string', short: 'c' } },
    async run(ctx, pos, o) {
      const D = await ctx.data();
      const q = pos.join(' ').toLowerCase();
      const list = D.items.filter(i => (!o.cat || i.category.toLowerCase() === o.cat.toLowerCase())
        && (!q || `${i.code} ${(D.aliasesOf.get(i.id) || []).join(' ')} ${i.name} ${i.category} ${i.location} ${i.notes} ${i.firmware}`.toLowerCase().includes(q)));
      if (ctx.json) return ctx.out(list);
      if (!list.length) return console.log(c.dim(tr('No items')));
      const cats = [...new Set(list.map(i => i.category))].sort((a, b) => (!a) - (!b) || a.localeCompare(b));
      for (const cat of cats) {
        heading(cat || tr('no category'));
        table(list.filter(i => i.category === cat).map(itemRow), { right: [] });
      }
    },
  },

  show: {
    usage: tr('item show CODE'),
    summary: tr('the item\'s page: details, composition, documents, projects and linked entries'),
    async run(ctx, [ref]) {
      const D = await ctx.data();
      const it = itemRef(D, ref ?? fail(tr('Which item?')));
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
      if (alts.length) console.log(c.dim(tr('also: {codes}', { codes: alts.join(' · ') })));
      console.log(c.dim(`${ctx.api().base}/#/i/${it.id}`));
      table([
        it.category && [tr('category'), it.category],
        it.firmware && ['firmware', it.firmware],
        it.location && [tr('location'), it.location],
        it.qty != null && [tr('quantity'), String(it.qty)],
        it.url && ['link', it.url],
        projects.size && [tr('projects'), [...projects.values()].filter(Boolean).map(p => c.magenta(`@${p.tag}`)).join(' ')],
        parents.length && [tr('part of'), parents.map(p => c.cyan(p.code)).join(' ')],
      ].filter(Boolean).map(([k, v]) => [c.dim(k), v]), { right: [] });
      if (it.notes) {
        heading(tr('Notes'));
        console.log(rich(it.notes));
      }
      if (children.length) {
        heading(tr('Contains'));
        table(children.map(itemRow), { right: [] });
      }
      if (docs.length) {
        heading(tr('Documents'));
        table(docs.map(d => [c.dim(d.id), d.kind, d.version ? `v${d.version}` : '', d.label || d.filename || d.url, c.dim(d.url ? 'link' : fmtSize(d.size)), c.dim(fmtTime(d.created_at))]));
      }
      if (entries.length) {
        heading(tr('Open entries'));
        printTree(D, entries);
      }
      printBacklinks(D, mails, tr('In the mails'), { mailsOnly: true });
    },
  },

  add: {
    usage: tr('item add CODE [NAME…] [-c CATEGORY] [--fw VER] [-l LOCATION] [-q N] [--url URL] [-p PROJECT]'),
    summary: tr('new item (with -p it links it to a project too)'),
    options: { ...FIELD_OPTS, project: { type: 'string', short: 'p' } },
    async run(ctx, [code, ...name], o) {
      if (!code) fail(tr('The code is missing'));
      const f = fields(o);
      if (name.length) f.name = name.join(' ');
      const project = o.project && projectRef(await ctx.data(), o.project);
      const r = await ctx.api().post('/items', { code: code.replace(/^#/, ''), ...f, project_id: project?.id });
      if (ctx.json) return ctx.out(r);
      console.log(`${c.green('+')} ${c.cyan(code.replace(/^#/, ''))} ${f.name || ''}`);
    },
  },

  set: {
    usage: tr('item set CODE [--code NEW] [-n NAME] [-c CATEGORY] [--fw VER] [-l LOCATION] [-q N] [--url URL] [--notes TEXT] [-s ok|evaluation|outdated|discarded]'),
    summary: tr('edits an item (changing the code also updates the #references in the entries)'),
    options: { ...FIELD_OPTS, code: { type: 'string' } },
    async run(ctx, [ref], o) {
      const it = itemRef(await ctx.data(), ref ?? fail(tr('Which item?')));
      const f = fields(o);
      if (o.code !== undefined) f.code = o.code.replace(/^#/, '');
      if (!Object.keys(f).length) fail(tr('Nothing to change: org item set --help'));
      await ctx.api().patch(`/items/${it.id}`, f);
      done(f.code ?? it.code);
    },
  },

  mv: {
    usage: tr('item mv CODE… CATEGORY'),
    summary: tr('moves items to another category ("-" = no category)'),
    async run(ctx, pos) {
      const cat = pos.length > 1 ? pos.pop() : fail(tr('Usage: org item mv CODE… CATEGORY'));
      const D = await ctx.data();
      for (const ref of pos) {
        const it = itemRef(D, ref);
        await ctx.api().patch(`/items/${it.id}`, { category: cat === '-' ? '' : cat });
        done(it.code, `→ ${cat === '-' ? tr('no category') : cat}`);
      }
    },
  },

  alias: {
    usage: tr('item alias CODE [ALTERNATIVE…] [--rm ALTERNATIVE]'),
    summary: tr('alternative codes of an item: alone it lists them, with codes it adds them; --rm removes one'),
    options: { rm: { type: 'string', multiple: true } },
    async run(ctx, [ref, ...alts], o) {
      const D = await ctx.data();
      const it = itemRef(D, ref ?? fail(tr('Which item?')));
      for (const a of alts) await ctx.api().post(`/items/${it.id}/aliases`, { code: a });
      for (const a of o.rm ?? []) await ctx.api().del(`/items/${it.id}/aliases/${encodeURIComponent(a.replace(/^#/, ''))}`);
      if (!alts.length && !o.rm) {
        const list = D.aliasesOf.get(it.id) || [];
        if (ctx.json) return ctx.out(list);
        return console.log(list.length ? list.join('\n') : c.dim(tr('{code} has no alternative codes', { code: it.code })));
      }
      done(it.code, tr('updated'));
    },
  },

  link: {
    usage: tr('item link CODE CHILD…'),
    summary: tr('composition: CODE contains the CHILDren (created if they do not exist)'),
    async run(ctx, [ref, ...kids]) {
      const it = itemRef(await ctx.data(), ref ?? fail(tr('Which item?')));
      if (!kids.length) fail(tr('What does it contain?'));
      for (const code of kids) await ctx.api().post(`/items/${it.id}/children`, { code });
      done(it.code, tr('contains {codes}', { codes: kids.map(k => c.cyan(k.replace(/^#/, ''))).join(' ') }));
    },
  },

  unlink: {
    usage: tr('item unlink CODE CHILD…'),
    summary: tr('removes items from the composition'),
    async run(ctx, [ref, ...kids]) {
      const D = await ctx.data();
      const it = itemRef(D, ref ?? fail(tr('Which item?')));
      for (const k of kids) await ctx.api().del(`/items/${it.id}/children/${itemRef(D, k).id}`);
      done(it.code, tr('updated'));
    },
  },

  rm: {
    usage: tr('item rm CODE…'),
    summary: tr('moves to the trash (with its documents)'),
    async run(ctx, pos) {
      const D = await ctx.data();
      if (!pos.length) fail(tr('Which item?'));
      for (const ref of pos) {
        const it = itemRef(D, ref);
        await ctx.api().del(`/items/${it.id}`);
        console.log(`${c.dim(`${tr('trash')} ←`)} ${it.code}  ${c.dim(`(org restore item ${it.id})`)}`);
      }
    },
  },
};
