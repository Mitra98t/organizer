// Documenti del magazzino: caricare file (anche più di uno), link esterni, scaricare, aprire, rinominare.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { c, fail, table, fmtSize, fmtTime, openExternal } from './term.js';
import { itemRef, numRef } from './data.js';

export const DOC_KINDS = ['firmware', 'datasheet', 'schema', 'footprint', 'manuale', 'foto', 'altro'];

const MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/csv', '.zip': 'application/zip', '.json': 'application/json',
};
export const mimeOf = file => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

// Senza --kind si deduce dall'estensione quando è ovvio; altrimenti "altro" (si cambia con org doc set).
const KIND_BY_EXT = {
  firmware: ['.bin', '.hex', '.elf', '.uf2', '.img', '.fw', '.srec', '.s19', '.dfu'],
  footprint: ['.kicad_mod', '.lbr', '.fp'],
  schema: ['.kicad_sch', '.sch', '.kicad_pcb', '.brd'],
  foto: ['.jpg', '.jpeg', '.png', '.heic', '.webp'],
};
const guessKind = file => Object.keys(KIND_BY_EXT).find(k => KIND_BY_EXT[k].includes(path.extname(file).toLowerCase())) || 'altro';

function checkKind(k) {
  if (k === undefined) return undefined;
  return DOC_KINDS.includes(k.toLowerCase()) ? k.toLowerCase() : fail(`Tipo: ${DOC_KINDS.join(', ')}`);
}

const docName = d => d.label || d.filename || d.url;

export async function docRef(ctx, ref) {
  const D = await ctx.data();
  return D.docById.get(numRef(ref, 'del documento')) || fail(`Documento ${ref} non trovato (org doc per l'elenco)`);
}

// Nome dal Content-Disposition del server, ripulito: niente percorsi né file nascosti.
function safeName(cd, fallback) {
  const m = cd?.match(/filename\*=UTF-8''([^;]+)/i);
  let name = m ? decodeURIComponent(m[1]) : cd?.match(/filename="([^"]+)"/)?.[1] || fallback;
  name = path.basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '').replace(/^\.+/, '');
  return name || fallback;
}

// Scarica un documento in dest (file o cartella; predefinito: cartella corrente). Restituisce il percorso.
export async function download(ctx, d, dest, { force = false } = {}) {
  const res = await ctx.api().request('GET', `/docs/${d.id}/file`, { raw: true });
  const name = safeName(res.headers.get('content-disposition'), `documento-${d.id}`);
  let out = path.resolve(dest || '.');
  if (!dest || (fs.existsSync(out) && fs.statSync(out).isDirectory())) out = path.join(out, name);
  if (fs.existsSync(out) && !force) fail(`${out} esiste già (--force per sovrascriverlo)`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(out));
  return out;
}

export default {
  ls: {
    usage: 'doc [CODICE] [-k TIPO] [FILTRO]',
    summary: 'documenti (di un articolo o di tutto il magazzino)',
    options: { kind: { type: 'string', short: 'k' } },
    async run(ctx, pos, o) {
      const D = await ctx.data();
      // Il primo argomento è un articolo se esiste quel codice, altrimenti è un filtro sul testo.
      const item = pos.length && D.itemByCode.get(pos[0].replace(/^#/, '').toLowerCase()) ? itemRef(D, pos.shift()) : null;
      const kind = checkKind(o.kind);
      const q = pos.join(' ').toLowerCase();
      const list = D.docs.filter(d => (!item || d.item_id === item.id) && (!kind || d.kind === kind)
        && (!q || `${d.label} ${d.filename} ${d.url} ${d.version}`.toLowerCase().includes(q)));
      if (ctx.json) return ctx.out(list);
      if (!list.length) return console.log(c.dim('Nessun documento'));
      table(list.map(d => [
        c.dim(d.id), d.kind, d.version ? `v${d.version}` : '', docName(d),
        item ? '' : c.cyan(D.itemById.get(d.item_id)?.code ?? ''), c.dim(d.url ? 'link' : fmtSize(d.size)), c.dim(fmtTime(d.created_at)),
      ]));
    },
  },

  up: {
    usage: 'doc up CODICE FILE… [-k TIPO] [-V VERSIONE] [--label NOME]',
    summary: `carica file su un articolo; tipi: ${DOC_KINDS.join(', ')} (senza -k si deduce dall'estensione)`,
    options: { kind: { type: 'string', short: 'k' }, version: { type: 'string', short: 'V' }, label: { type: 'string' } },
    async run(ctx, [ref, ...files], o) {
      const it = itemRef(await ctx.data(), ref ?? fail('Su quale articolo?'));
      if (!files.length) fail('Quali file?');
      for (const f of files) if (!fs.existsSync(f) || !fs.statSync(f).isFile()) fail(`${f}: file inesistente`);
      const ids = [];
      for (const file of files) {
        const kind = checkKind(o.kind) ?? guessKind(file);
        const q = new URLSearchParams({ kind, name: path.basename(file) });
        if (o.version) q.set('version', o.version);
        if (o.label && files.length === 1) q.set('label', o.label);
        const blob = await fs.openAsBlob(file, { type: mimeOf(file) });
        if (!ctx.json) process.stderr.write(c.dim(`↑ ${path.basename(file)} (${fmtSize(blob.size)})… `));
        const { id } = await ctx.api().request('POST', `/items/${it.id}/docs?${q}`, { body: blob, type: blob.type });
        ids.push(id);
        if (!ctx.json) {
          process.stderr.write('\n');
          console.log(`${c.green('+')} ${c.dim(id)} ${kind}${o.version ? ` v${o.version}` : ''} ${path.basename(file)} → ${c.cyan(it.code)}`);
        }
      }
      if (ctx.json) ctx.out(ids);
    },
  },

  link: {
    usage: 'doc link CODICE URL [-k TIPO] [-V VERSIONE] [--label NOME]',
    summary: 'collega un link esterno (repo, wiki, PDF online) a un articolo',
    options: { kind: { type: 'string', short: 'k' }, version: { type: 'string', short: 'V' }, label: { type: 'string' } },
    async run(ctx, [ref, url], o) {
      const it = itemRef(await ctx.data(), ref ?? fail('Su quale articolo?'));
      if (!url) fail('Manca il link');
      const { id } = await ctx.api().post(`/items/${it.id}/docs`, { url, kind: checkKind(o.kind) ?? 'altro', label: o.label, version: o.version });
      if (ctx.json) return ctx.out({ id });
      console.log(`${c.green('+')} ${c.dim(id)} ${o.label || url} → ${c.cyan(it.code)}`);
    },
  },

  get: {
    usage: 'doc get ID… [-o FILE|CARTELLA] [--force]',
    summary: 'scarica documenti (con il nome dato nell\'app)',
    options: { out: { type: 'string', short: 'o' }, force: { type: 'boolean', short: 'f' } },
    async run(ctx, refs, o) {
      if (!refs.length) fail('Manca il numero del documento');
      if (refs.length > 1 && o.out && !(fs.existsSync(o.out) && fs.statSync(o.out).isDirectory())) fail('Con più documenti -o deve essere una cartella');
      for (const ref of refs) {
        const d = await docRef(ctx, ref);
        if (d.url) {
          console.log(`${c.dim(d.id)} è un link: ${d.url}`);
          continue;
        }
        console.log(`${c.green('↓')} ${await download(ctx, d, o.out, o)}`);
      }
    },
  },

  open: {
    usage: 'doc open ID',
    summary: 'apre il documento con il programma predefinito (i link nel browser)',
    async run(ctx, [ref]) {
      const d = await docRef(ctx, ref);
      if (d.url) return openExternal(d.url);
      const dir = path.join(os.tmpdir(), 'organizer-cli', String(d.id));
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
      openExternal(await download(ctx, d, dir));
    },
  },

  set: {
    usage: 'doc set ID [--label NOME] [-k TIPO] [-V VERSIONE]',
    summary: 'rinomina o cambia tipo e versione (un firmware con versione aggiorna quella dell\'articolo)',
    options: { label: { type: 'string', short: 'n' }, kind: { type: 'string', short: 'k' }, version: { type: 'string', short: 'V' } },
    async run(ctx, [ref], o) {
      const d = await docRef(ctx, ref);
      const patch = {};
      if (o.label !== undefined) patch.label = o.label;
      if (o.kind !== undefined) patch.kind = checkKind(o.kind);
      if (o.version !== undefined) patch.version = o.version;
      if (!Object.keys(patch).length) fail('Niente da cambiare: org doc set --help');
      await ctx.api().patch(`/docs/${d.id}`, patch);
      console.log(`${c.green('✓')} ${c.dim(d.id)} ${patch.label ?? docName(d)}`);
    },
  },

  rename: {
    usage: 'doc rename ID NOME…',
    summary: 'nuovo nome (scaricando, il file prende questo nome)',
    async run(ctx, [ref, ...name]) {
      const d = await docRef(ctx, ref);
      const label = name.join(' ') || fail('Quale nome?');
      await ctx.api().patch(`/docs/${d.id}`, { label });
      console.log(`${c.green('✓')} ${c.dim(d.id)} ${docName(d)} → ${label}`);
    },
  },

  rm: {
    usage: 'doc rm ID…',
    summary: 'sposta documenti nel cestino',
    async run(ctx, refs) {
      if (!refs.length) fail('Manca il numero del documento');
      for (const ref of refs) {
        const d = await docRef(ctx, ref);
        await ctx.api().del(`/docs/${d.id}`);
        console.log(`${c.dim('cestino ←')} ${d.id} ${docName(d)}  ${c.dim(`(org restore doc ${d.id})`)}`);
      }
    },
  },
};
