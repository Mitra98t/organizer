// Inventory documents: upload files (more than one too), external links, download, open, rename,
// move or copy to another item.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { c, fail, table, heading, rich, fmtSize, fmtTime, openExternal } from './term.js';
import { itemRef, numRef, userName, linkRefs } from './data.js';
import { tr, trn } from './i18n.js';

export const DOC_KINDS = ['firmware', 'datasheet', 'schema', 'footprint', 'manuale', 'foto', 'altro'];

// The built-in kinds are stored with their Italian names (schema, manuale, foto, altro): they are shown translated
// and the English names work too.
const KIND_ALIAS = { schematic: 'schema', manual: 'manuale', photo: 'foto', other: 'altro' };
const KIND_LABEL = { schema: tr('schematic'), manuale: tr('manual'), foto: tr('photo'), altro: tr('other') };
export const kindLabel = k => KIND_LABEL[k] || k;

const MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/csv', '.zip': 'application/zip', '.json': 'application/json',
};
export const mimeOf = file => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

// Without --kind it is guessed from the extension when obvious; otherwise "other" (changed with org doc set).
const KIND_BY_EXT = {
  firmware: ['.bin', '.hex', '.elf', '.uf2', '.img', '.fw', '.srec', '.s19', '.dfu'],
  footprint: ['.kicad_mod', '.lbr', '.fp'],
  schema: ['.kicad_sch', '.sch', '.kicad_pcb', '.brd'],
  foto: ['.jpg', '.jpeg', '.png', '.heic', '.webp'],
};
const guessKind = file => Object.keys(KIND_BY_EXT).find(k => KIND_BY_EXT[k].includes(path.extname(file).toLowerCase())) || 'altro';

// The workspace's kinds (the built-in ones plus those added in the app or with org doc kinds --add).
async function checkKind(ctx, k) {
  if (k === undefined) return undefined;
  const kinds = (await ctx.data()).docKinds || DOC_KINDS;
  const key = KIND_ALIAS[k.toLowerCase()] || k.toLowerCase();
  return kinds.includes(key) ? key : fail(tr('Kind: {list} (new kinds: org doc kinds --add NAME)', { list: kinds.map(kindLabel).join(', ') }));
}

const docName = d => d.label || d.filename || d.url;

export async function docRef(ctx, ref) {
  const D = await ctx.data();
  return D.docById.get(numRef(ref, tr('The document number is missing'))) || fail(tr('Document {id} not found (org doc for the list)', { id: ref }));
}

// Name from the server's Content-Disposition, cleaned up: no paths and no hidden files.
function safeName(cd, fallback) {
  const m = cd?.match(/filename\*=UTF-8''([^;]+)/i);
  let name = m ? decodeURIComponent(m[1]) : cd?.match(/filename="([^"]+)"/)?.[1] || fallback;
  name = path.basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '').replace(/^\.+/, '');
  return name || fallback;
}

// Downloads a document into dest (file or folder; default: current folder). Returns the path.
export async function download(ctx, d, dest, { force = false } = {}) {
  const res = await ctx.api().request('GET', `/docs/${d.id}/file`, { raw: true });
  const name = safeName(res.headers.get('content-disposition'), `document-${d.id}`);
  let out = path.resolve(dest || '.');
  if (!dest || (fs.existsSync(out) && fs.statSync(out).isDirectory())) out = path.join(out, name);
  if (fs.existsSync(out) && !force) fail(tr('{file} already exists (--force to overwrite it)', { file: out }));
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(out));
  return out;
}

export default {
  ls: {
    usage: tr('doc [CODE] [-k KIND] [FILTER]'),
    summary: tr('documents (of an item or of the whole inventory)'),
    options: { kind: { type: 'string', short: 'k' } },
    async run(ctx, pos, o) {
      const D = await ctx.data();
      // The first argument is an item if that code exists, otherwise it is a text filter.
      const item = pos.length && D.itemByCode.get(pos[0].replace(/^#/, '').toLowerCase()) ? itemRef(D, pos.shift()) : null;
      const kind = await checkKind(ctx, o.kind);
      const q = pos.join(' ').toLowerCase();
      const list = D.docs.filter(d => (!item || d.item_id === item.id) && (!kind || d.kind === kind)
        && (!q || `${d.label} ${d.filename} ${d.url} ${d.version}`.toLowerCase().includes(q)));
      if (ctx.json) return ctx.out(list);
      if (!list.length) return console.log(c.dim(tr('No documents')));
      const openNotes = id => D.docNotes.filter(n => n.doc_id === id && !n.resolved_at).length;
      table(list.map(d => [
        c.dim(d.id), kindLabel(d.kind), d.version ? `v${d.version}` : '', docName(d), openNotes(d.id) ? c.yellow(`✎${openNotes(d.id)}`) : '',
        item ? '' : c.cyan(D.itemById.get(d.item_id)?.code ?? ''), c.dim(d.url ? 'link' : fmtSize(d.size)), c.dim(fmtTime(d.created_at)),
      ]));
    },
  },

  up: {
    usage: tr('doc up CODE FILE… [-k KIND] [-V VERSION] [--label NAME]'),
    summary: tr('uploads files to an item; kind with -k (org doc kinds for the list), without -k it is guessed from the extension'),
    options: { kind: { type: 'string', short: 'k' }, version: { type: 'string', short: 'V' }, label: { type: 'string' } },
    async run(ctx, [ref, ...files], o) {
      const it = itemRef(await ctx.data(), ref ?? fail(tr('On which item?')));
      if (!files.length) fail(tr('Which files?'));
      for (const f of files) if (!fs.existsSync(f) || !fs.statSync(f).isFile()) fail(tr('{file}: no such file', { file: f }));
      const ids = [];
      for (const file of files) {
        const kind = (await checkKind(ctx, o.kind)) ?? guessKind(file);
        const q = new URLSearchParams({ kind, name: path.basename(file) });
        if (o.version) q.set('version', o.version);
        if (o.label && files.length === 1) q.set('label', o.label);
        const blob = await fs.openAsBlob(file, { type: mimeOf(file) });
        if (!ctx.json) process.stderr.write(c.dim(`↑ ${path.basename(file)} (${fmtSize(blob.size)})… `));
        const { id } = await ctx.api().request('POST', `/items/${it.id}/docs?${q}`, { body: blob, type: blob.type });
        ids.push(id);
        if (!ctx.json) {
          process.stderr.write('\n');
          console.log(`${c.green('+')} ${c.dim(id)} ${kindLabel(kind)}${o.version ? ` v${o.version}` : ''} ${path.basename(file)} → ${c.cyan(it.code)}`);
        }
      }
      if (ctx.json) ctx.out(ids);
    },
  },

  link: {
    usage: tr('doc link CODE URL [-k KIND] [-V VERSION] [--label NAME]'),
    summary: tr('links an external link (repo, wiki, online PDF) to an item'),
    options: { kind: { type: 'string', short: 'k' }, version: { type: 'string', short: 'V' }, label: { type: 'string' } },
    async run(ctx, [ref, url], o) {
      const it = itemRef(await ctx.data(), ref ?? fail(tr('On which item?')));
      if (!url) fail(tr('The link is missing'));
      const { id } = await ctx.api().post(`/items/${it.id}/docs`, { url, kind: (await checkKind(ctx, o.kind)) ?? 'altro', label: o.label, version: o.version });
      if (ctx.json) return ctx.out({ id });
      console.log(`${c.green('+')} ${c.dim(id)} ${o.label || url} → ${c.cyan(it.code)}`);
    },
  },

  get: {
    usage: tr('doc get ID… [-o FILE|FOLDER] [--force]'),
    summary: tr('downloads documents (with the name given in the app)'),
    options: { out: { type: 'string', short: 'o' }, force: { type: 'boolean', short: 'f' } },
    async run(ctx, refs, o) {
      if (!refs.length) fail(tr('The document number is missing'));
      if (refs.length > 1 && o.out && !(fs.existsSync(o.out) && fs.statSync(o.out).isDirectory())) fail(tr('With several documents -o must be a folder'));
      for (const ref of refs) {
        const d = await docRef(ctx, ref);
        if (d.url) {
          console.log(`${c.dim(d.id)} ${tr('is a link:')} ${d.url}`);
          continue;
        }
        console.log(`${c.green('↓')} ${await download(ctx, d, o.out, o)}`);
      }
    },
  },

  open: {
    usage: 'doc open ID',
    summary: tr('opens the document with the default program (links in the browser)'),
    async run(ctx, [ref]) {
      const d = await docRef(ctx, ref);
      if (d.url) return openExternal(d.url);
      const dir = path.join(os.tmpdir(), 'organizer-cli', String(d.id));
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
      openExternal(await download(ctx, d, dir));
    },
  },

  notes: {
    usage: 'doc notes ID [--all]',
    summary: tr('notes written on the document: first the general ones, then page by page with the pin number as in the app; --all also the resolved ones'),
    options: { all: { type: 'boolean', short: 'a' } },
    async run(ctx, [ref], o) {
      const D = await ctx.data();
      const d = await docRef(ctx, ref);
      const mine = D.docNotes.filter(n => n.doc_id === d.id);
      const shown = mine.filter(n => o.all || !n.resolved_at);
      const general = shown.filter(n => n.page == null).sort((a, b) => a.created_at.localeCompare(b.created_at));
      // Pin numbers as in the app: per page, top to bottom.
      const pinned = shown.filter(n => n.page != null).sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
        .map((n, i) => ({ ...n, num: i + 1 }));
      if (ctx.json) return ctx.out({ doc: d, general, pinned });

      const it = D.itemById.get(d.item_id);
      console.log(`${c.bold(docName(d))} ${c.dim(`${kindLabel(d.kind)}${d.version ? ` v${d.version}` : ''}`)}${it ? ` ${c.cyan(it.code)}` : ''}`);
      console.log(c.dim(`${ctx.api().base}/#/d/${d.id}`));
      const hidden = mine.length - shown.length;
      if (!shown.length) return console.log(c.dim(`\n${hidden ? tr('No open notes ({n} resolved: --all)', { n: hidden }) : tr('No notes')}`));

      const print = n => {
        const done = n.resolved_at ? c.green(` ✓ ${tr('resolved')}`) : '';
        console.log(`${n.num ? c.yellow(`[${n.num}]`) : c.dim('•')} ${c.bold(userName(D, n.created_by))} ${c.dim(fmtTime(n.updated_at || n.created_at))}${done}`);
        if (n.quote) console.log(c.dim(`    «${n.quote}»`)); // note on a piece of the PDF's text
        const text = linkRefs(D, rich(n.text), c.blue).split('\n').map(l => `    ${l}`).join('\n');
        console.log(n.resolved_at ? c.dim(text) : text);
      };
      if (general.length) {
        heading(tr('General'));
        general.forEach(print);
      }
      for (const page of [...new Set(pinned.map(n => n.page))]) {
        heading(pinned.some(n => n.z != null) ? tr('On the model') : tr('Page {n}', { n: page })); // 3D models: the points are all at page = 1
        pinned.filter(n => n.page === page).forEach(print);
      }
      if (hidden) console.log(c.dim(`\n${trn(hidden, '1 resolved note hidden (--all to see it)', '{n} resolved notes hidden (--all to see them)')}`));
    },
  },

  set: {
    usage: tr('doc set ID [--label NAME] [-k KIND] [-V VERSION]'),
    summary: tr('renames or changes kind and version (a firmware with a version updates the item\'s one)'),
    options: { label: { type: 'string', short: 'n' }, kind: { type: 'string', short: 'k' }, version: { type: 'string', short: 'V' } },
    async run(ctx, [ref], o) {
      const d = await docRef(ctx, ref);
      const patch = {};
      if (o.label !== undefined) patch.label = o.label;
      if (o.kind !== undefined) patch.kind = await checkKind(ctx, o.kind);
      if (o.version !== undefined) patch.version = o.version;
      if (!Object.keys(patch).length) fail(tr('Nothing to change: org doc set --help'));
      await ctx.api().patch(`/docs/${d.id}`, patch);
      console.log(`${c.green('✓')} ${c.dim(d.id)} ${patch.label ?? docName(d)}`);
    },
  },

  rename: {
    usage: tr('doc rename ID NAME…'),
    summary: tr('new name (when downloaded, the file takes this name)'),
    async run(ctx, [ref, ...name]) {
      const d = await docRef(ctx, ref);
      const label = name.join(' ') || fail(tr('Which name?'));
      await ctx.api().patch(`/docs/${d.id}`, { label });
      console.log(`${c.green('✓')} ${c.dim(d.id)} ${docName(d)} → ${label}`);
    },
  },

  mv: {
    usage: tr('doc mv ID… CODE'),
    summary: tr('moves documents to another item (with their notes)'),
    async run(ctx, refs) {
      if (refs.length < 2) fail(tr('Usage: org doc mv ID… CODE'));
      const it = itemRef(await ctx.data(), refs.pop());
      for (const ref of refs) {
        const d = await docRef(ctx, ref);
        await ctx.api().patch(`/docs/${d.id}`, { item_id: it.id });
        console.log(`${c.green('→')} ${c.dim(d.id)} ${docName(d)} ${c.dim(tr('into'))} ${it.code}`);
      }
    },
  },

  cp: {
    usage: tr('doc cp ID… CODE'),
    summary: tr('copies documents to another item (new file, without the notes)'),
    async run(ctx, refs) {
      if (refs.length < 2) fail(tr('Usage: org doc cp ID… CODE'));
      const it = itemRef(await ctx.data(), refs.pop());
      for (const ref of refs) {
        const d = await docRef(ctx, ref);
        const { id } = await ctx.api().post(`/docs/${d.id}/copy`, { item_id: it.id });
        console.log(`${c.green('+')} ${c.dim(id)} ${docName(d)} ${c.dim(tr('into {code} (copy of {id})', { code: it.code, id: d.id }))}`);
      }
    },
  },

  kinds: {
    usage: tr('doc kinds [--add NAME] [--rm NAME]'),
    summary: tr('document kinds with how many documents each one has; --add adds one, --rm deletes it (its documents become "other")'),
    options: { add: { type: 'string' }, rm: { type: 'string' } },
    async run(ctx, _pos, o) {
      if (o.add) {
        const { name } = await ctx.api().post('/doc-kinds', { name: o.add });
        return console.log(`${c.green('+')} ${tr('kind {name}', { name })}`);
      }
      if (o.rm) {
        const k = KIND_ALIAS[o.rm.toLowerCase()] || o.rm;
        await ctx.api().del(`/doc-kinds/${encodeURIComponent(k)}`);
        return console.log(`${c.green('✓')} ${tr('kind {name} deleted', { name: o.rm })}`);
      }
      const D = await ctx.data();
      const kinds = D.docKinds || DOC_KINDS;
      if (ctx.json) return ctx.out(kinds.map(k => ({ name: k, custom: (D.customDocKinds || []).includes(k), docs: D.docs.filter(d => d.kind === k).length })));
      table(kinds.map(k => [kindLabel(k), String(D.docs.filter(d => d.kind === k).length), (D.customDocKinds || []).includes(k) ? c.dim(tr('added')) : '']), { right: [1] });
    },
  },

  rm: {
    usage: 'doc rm ID…',
    summary: tr('moves documents to the trash'),
    async run(ctx, refs) {
      if (!refs.length) fail(tr('The document number is missing'));
      for (const ref of refs) {
        const d = await docRef(ctx, ref);
        await ctx.api().del(`/docs/${d.id}`);
        console.log(`${c.dim(`${tr('trash')} ←`)} ${d.id} ${docName(d)}  ${c.dim(`(org restore doc ${d.id})`)}`);
      }
    },
  },
};
