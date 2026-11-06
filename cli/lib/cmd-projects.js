// Projects: tree with subprojects, status, notes and inventory items linked by hand.
import { c, fail, table, heading, rich, editText } from './term.js';
import { entryProjects, descendants, projectRef, itemRef } from './data.js';
import { printTree } from './cmd-entries.js';
import { tr } from './i18n.js';

const STATUS = { open: 'open', paused: 'paused', closed: 'closed', aperto: 'open', pausa: 'paused', chiuso: 'closed' };
const STATUS_LABEL = { open: '', paused: c.yellow(tr('paused||one project')), closed: c.dim(tr('closed||one project')) };

function checkStatus(s) {
  return STATUS[String(s).toLowerCase()] || fail(tr('Status: open, paused or closed'));
}

// Hue 0-359 as in the app; "auto" goes back to the automatic colour.
function checkColor(s) {
  if (s === 'auto') return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n < 360 ? n : fail(tr('Colour: a number from 0 to 359 (hue) or "auto"'));
}

async function patchProject(ctx, ref, patch) {
  const D = await ctx.data();
  const p = projectRef(D, ref);
  await ctx.api().patch(`/projects/${p.id}`, patch);
  console.log(`${c.green('✓')} ${c.magenta(`@${patch.tag ?? p.tag}`)}`);
}

export default {
  ls: {
    usage: 'proj [--all]',
    summary: tr('project tree with the number of open entries (--all also the closed ones)'),
    options: { all: { type: 'boolean', short: 'a' } },
    async run(ctx, _pos, o) {
      const D = await ctx.data();
      const open = new Map();
      for (const e of D.entries) {
        if (e.done_at || e.kind === 'note') continue;
        for (const p of entryProjects(D, e)) open.set(p.id, (open.get(p.id) || 0) + 1);
      }
      const list = D.projects.filter(p => o.all || p.status !== 'closed');
      if (ctx.json) return ctx.out(list.map(p => ({ ...p, open: open.get(p.id) || 0 })));
      if (!list.length) return console.log(c.dim(tr('No projects')));
      const shown = new Set(list.map(p => p.id));
      const rows = [];
      const walk = (p, depth) => {
        rows.push([`${'  '.repeat(depth)}${c.magenta(`@${p.tag}`)}`, p.name === p.tag ? '' : p.name, open.get(p.id) ? String(open.get(p.id)) : c.dim('0'), STATUS_LABEL[p.status]]);
        for (const k of list.filter(x => x.parent_id === p.id)) walk(k, depth + 1);
      };
      for (const p of list.filter(x => !x.parent_id || !shown.has(x.parent_id))) walk(p, 0);
      table(rows, { right: [2] });
    },
  },

  show: {
    usage: tr('proj show PROJECT [--all]'),
    summary: tr('notes, subprojects, items and open entries of the project (and of the subprojects)'),
    options: { all: { type: 'boolean', short: 'a' } },
    async run(ctx, [ref], o) {
      const D = await ctx.data();
      const p = projectRef(D, ref ?? fail(tr('Which project?')));
      const tree = descendants(D, p.id);
      const entries = D.entries.filter(e => (o.all || !e.done_at) && entryProjects(D, e).some(x => tree.has(x.id)));
      const items = (D.itemsOfProject.get(p.id) || []).map(id => D.itemById.get(id)).filter(Boolean);
      if (ctx.json) return ctx.out({ ...p, entries, items });
      const parent = p.parent_id && D.projectById.get(p.parent_id);
      console.log(`${c.bold(p.name)} ${c.magenta(`@${p.tag}`)}${p.status !== 'open' ? ` ${STATUS_LABEL[p.status]}` : ''}${parent ? c.dim(` ${tr('inside @{tag}', { tag: parent.tag })}`) : ''}${p.private ? c.dim(` · ${tr('private||project')}`) : ''}`);
      console.log(c.dim(`${ctx.api().base}/#/p/${p.id}`));
      if (p.notes) {
        heading(tr('Notes'));
        console.log(rich(p.notes));
      }
      const subs = D.projects.filter(x => x.parent_id === p.id);
      if (subs.length) {
        heading(tr('Subprojects'));
        table(subs.map(x => [c.magenta(`@${x.tag}`), x.name, STATUS_LABEL[x.status]]), { right: [] });
      }
      if (items.length) {
        heading(tr('Inventory'));
        table(items.map(i => [c.cyan(i.code), i.name]), { right: [] });
      }
      heading(tr('Entries'));
      if (entries.length) printTree(D, entries);
      else console.log(c.dim(tr('No open entries')));
    },
  },

  add: {
    usage: tr('proj add NAME… [--tag TAG] [--in PARENT] [--private]'),
    summary: tr('new project (--in: subproject of another one)'),
    options: { tag: { type: 'string', short: 't' }, in: { type: 'string' }, private: { type: 'boolean' } },
    async run(ctx, pos, o) {
      const name = pos.join(' ') || fail(tr('What is the project called?'));
      const parent = o.in && projectRef(await ctx.data(), o.in);
      const r = await ctx.api().post('/projects', { name, tag: o.tag, parent_id: parent?.id, private: o.private });
      if (ctx.json) return ctx.out(r);
      console.log(`${c.green('+')} ${c.magenta(`@${r.tag}`)} ${name}`);
    },
  },

  mv: {
    usage: tr('proj mv PROJECT PARENT|-'),
    summary: tr('moves inside another project ("-" = back to the top level)'),
    async run(ctx, [ref, parent]) {
      if (!parent) fail(tr('Usage: org proj mv PROJECT PARENT|-'));
      const target = parent === '-' ? null : projectRef(await ctx.data(), parent).id;
      await patchProject(ctx, ref, { parent_id: target });
    },
  },

  set: {
    usage: tr('proj set PROJECT [--name NAME] [--tag TAG] [--status open|paused|closed] [--notes TEXT] [--color 0-359|auto]'),
    summary: tr('changes name, tag, status, notes or colour'),
    options: {
      name: { type: 'string' }, tag: { type: 'string' }, status: { type: 'string', short: 's' },
      notes: { type: 'string' }, color: { type: 'string' },
    },
    async run(ctx, [ref], o) {
      const patch = {};
      if (o.name !== undefined) patch.name = o.name;
      if (o.tag !== undefined) patch.tag = o.tag.replace(/^@/, '');
      if (o.status !== undefined) patch.status = checkStatus(o.status);
      if (o.notes !== undefined) patch.notes = o.notes;
      if (o.color !== undefined) patch.hue = checkColor(o.color);
      if (!Object.keys(patch).length) fail(tr('Nothing to change: org proj set --help'));
      await patchProject(ctx, ref ?? fail(tr('Which project?')), patch);
    },
  },

  close: {
    usage: tr('proj close PROJECT'),
    summary: tr('closes the project (org proj set PROJECT -s open to reopen it)'),
    run: (ctx, [ref]) => patchProject(ctx, ref ?? fail(tr('Which project?')), { status: 'closed' }),
  },

  edit: {
    usage: tr('proj edit PROJECT'),
    summary: tr('project notes in $EDITOR'),
    async run(ctx, [ref]) {
      const p = projectRef(await ctx.data(), ref ?? fail(tr('Which project?')));
      const notes = editText(p.notes || '', `${p.tag}.md`).trimEnd();
      if (notes === (p.notes || '')) return console.log(c.dim(tr('No changes')));
      await patchProject(ctx, p.tag, { notes });
    },
  },

  link: {
    usage: tr('proj link PROJECT CODE…'),
    summary: tr('links inventory items to the project (created if they do not exist)'),
    async run(ctx, [ref, ...codes]) {
      const p = projectRef(await ctx.data(), ref ?? fail(tr('Which project?')));
      if (!codes.length) fail(tr('Which items?'));
      for (const code of codes) await ctx.api().post(`/projects/${p.id}/items`, { code });
      console.log(`${c.green('✓')} ${c.magenta(`@${p.tag}`)} ↔ ${codes.map(x => c.cyan(x.replace(/^#/, ''))).join(' ')}`);
    },
  },

  unlink: {
    usage: tr('proj unlink PROJECT CODE…'),
    summary: tr('unlinks items from the project'),
    async run(ctx, [ref, ...codes]) {
      const D = await ctx.data();
      const p = projectRef(D, ref ?? fail(tr('Which project?')));
      for (const code of codes) await ctx.api().del(`/projects/${p.id}/items/${itemRef(D, code).id}`);
      console.log(`${c.green('✓')} ${tr('unlinked')}`);
    },
  },

  rm: {
    usage: tr('proj rm PROJECT'),
    summary: tr('moves the project to the trash (the entries stay)'),
    async run(ctx, [ref]) {
      const p = projectRef(await ctx.data(), ref ?? fail(tr('Which project?')));
      await ctx.api().del(`/projects/${p.id}`);
      console.log(`${c.dim(`${tr('trash')} ←`)} @${p.tag}  ${c.dim(`(org restore project ${p.id})`)}`);
    },
  },
};
