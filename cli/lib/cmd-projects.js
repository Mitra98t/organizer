// Progetti: albero con sottoprogetti, stato, appunti e articoli di magazzino collegati a mano.
import { c, fail, table, heading, rich, editText } from './term.js';
import { entryProjects, descendants, projectRef, itemRef } from './data.js';
import { printTree } from './cmd-entries.js';

const STATUS = { open: 'open', paused: 'paused', closed: 'closed', aperto: 'open', pausa: 'paused', chiuso: 'closed' };
const STATUS_LABEL = { open: '', paused: c.yellow('in pausa'), closed: c.dim('chiuso') };

function checkStatus(s) {
  return STATUS[String(s).toLowerCase()] || fail('Stato: open (aperto), paused (pausa) o closed (chiuso)');
}

// Tinta 0-359 come nell'app; "auto" torna al colore automatico.
function checkColor(s) {
  if (s === 'auto') return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n < 360 ? n : fail('Colore: un numero da 0 a 359 (tinta) oppure "auto"');
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
    summary: 'albero dei progetti con il numero di voci aperte (--all anche i chiusi)',
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
      if (!list.length) return console.log(c.dim('Nessun progetto'));
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
    usage: 'proj show PROGETTO [--all]',
    summary: 'appunti, sottoprogetti, articoli e voci aperte del progetto (e dei sottoprogetti)',
    options: { all: { type: 'boolean', short: 'a' } },
    async run(ctx, [ref], o) {
      const D = await ctx.data();
      const p = projectRef(D, ref ?? fail('Quale progetto?'));
      const tree = descendants(D, p.id);
      const entries = D.entries.filter(e => (o.all || !e.done_at) && entryProjects(D, e).some(x => tree.has(x.id)));
      const items = (D.itemsOfProject.get(p.id) || []).map(id => D.itemById.get(id)).filter(Boolean);
      if (ctx.json) return ctx.out({ ...p, entries, items });
      const parent = p.parent_id && D.projectById.get(p.parent_id);
      console.log(`${c.bold(p.name)} ${c.magenta(`@${p.tag}`)}${p.status !== 'open' ? ` ${STATUS_LABEL[p.status]}` : ''}${parent ? c.dim(` dentro @${parent.tag}`) : ''}${p.private ? c.dim(' · privato') : ''}`);
      console.log(c.dim(`${ctx.api().base}/#/p/${p.id}`));
      if (p.notes) {
        heading('Appunti');
        console.log(rich(p.notes));
      }
      const subs = D.projects.filter(x => x.parent_id === p.id);
      if (subs.length) {
        heading('Sottoprogetti');
        table(subs.map(x => [c.magenta(`@${x.tag}`), x.name, STATUS_LABEL[x.status]]), { right: [] });
      }
      if (items.length) {
        heading('Magazzino');
        table(items.map(i => [c.cyan(i.code), i.name]), { right: [] });
      }
      heading('Voci');
      if (entries.length) printTree(D, entries);
      else console.log(c.dim('Nessuna voce aperta'));
    },
  },

  add: {
    usage: 'proj add NOME… [--tag TAG] [--in PADRE] [--private]',
    summary: 'nuovo progetto (--in: sottoprogetto di un altro)',
    options: { tag: { type: 'string', short: 't' }, in: { type: 'string' }, private: { type: 'boolean' } },
    async run(ctx, pos, o) {
      const name = pos.join(' ') || fail('Come si chiama il progetto?');
      const parent = o.in && projectRef(await ctx.data(), o.in);
      const r = await ctx.api().post('/projects', { name, tag: o.tag, parent_id: parent?.id, private: o.private });
      if (ctx.json) return ctx.out(r);
      console.log(`${c.green('+')} ${c.magenta(`@${r.tag}`)} ${name}`);
    },
  },

  mv: {
    usage: 'proj mv PROGETTO PADRE|-',
    summary: 'sposta dentro un altro progetto ("-" = torna al primo livello)',
    async run(ctx, [ref, parent]) {
      if (!parent) fail('Uso: org proj mv PROGETTO PADRE|-');
      const target = parent === '-' ? null : projectRef(await ctx.data(), parent).id;
      await patchProject(ctx, ref, { parent_id: target });
    },
  },

  set: {
    usage: 'proj set PROGETTO [--name NOME] [--tag TAG] [--status open|paused|closed] [--notes TESTO] [--color 0-359|auto]',
    summary: 'cambia nome, tag, stato, appunti o colore',
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
      if (!Object.keys(patch).length) fail('Niente da cambiare: org proj set --help');
      await patchProject(ctx, ref ?? fail('Quale progetto?'), patch);
    },
  },

  close: {
    usage: 'proj close PROGETTO',
    summary: 'chiude il progetto (org proj set PROGETTO -s open per riaprirlo)',
    run: (ctx, [ref]) => patchProject(ctx, ref ?? fail('Quale progetto?'), { status: 'closed' }),
  },

  edit: {
    usage: 'proj edit PROGETTO',
    summary: 'appunti del progetto in $EDITOR',
    async run(ctx, [ref]) {
      const p = projectRef(await ctx.data(), ref ?? fail('Quale progetto?'));
      const notes = editText(p.notes || '', `${p.tag}.md`).trimEnd();
      if (notes === (p.notes || '')) return console.log(c.dim('Nessuna modifica'));
      await patchProject(ctx, p.tag, { notes });
    },
  },

  link: {
    usage: 'proj link PROGETTO CODICE…',
    summary: 'collega articoli di magazzino al progetto (creati se non esistono)',
    async run(ctx, [ref, ...codes]) {
      const p = projectRef(await ctx.data(), ref ?? fail('Quale progetto?'));
      if (!codes.length) fail('Quali articoli?');
      for (const code of codes) await ctx.api().post(`/projects/${p.id}/items`, { code });
      console.log(`${c.green('✓')} ${c.magenta(`@${p.tag}`)} ↔ ${codes.map(x => c.cyan(x.replace(/^#/, ''))).join(' ')}`);
    },
  },

  unlink: {
    usage: 'proj unlink PROGETTO CODICE…',
    summary: 'scollega articoli dal progetto',
    async run(ctx, [ref, ...codes]) {
      const D = await ctx.data();
      const p = projectRef(D, ref ?? fail('Quale progetto?'));
      for (const code of codes) await ctx.api().del(`/projects/${p.id}/items/${itemRef(D, code).id}`);
      console.log(`${c.green('✓')} scollegati`);
    },
  },

  rm: {
    usage: 'proj rm PROGETTO',
    summary: 'sposta il progetto nel cestino (le voci restano)',
    async run(ctx, [ref]) {
      const p = projectRef(await ctx.data(), ref ?? fail('Quale progetto?'));
      await ctx.api().del(`/projects/${p.id}`);
      console.log(`${c.dim('cestino ←')} @${p.tag}  ${c.dim(`(org restore project ${p.id})`)}`);
    },
  },
};
