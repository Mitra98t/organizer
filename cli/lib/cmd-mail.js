// Mail da mandare: si preparano qui (destinatari, oggetto, testo, allegati) e si aprono in Thunderbird
// con l'helper dell'app (make mail-helper), oppure si salvano come .eml.
import fs from 'node:fs';
import path from 'node:path';
import { c, fail, table, heading, fmtSize, today, editText, openExternal } from './term.js';
import { numRef } from './data.js';
import entries, { printTree, printEntry } from './cmd-entries.js';
import { mimeOf, docRef } from './cmd-docs.js';

// Modello per $EDITOR: intestazioni come in una mail, una riga vuota, poi il testo.
const HEADERS = { a: 'contact', to: 'contact', cc: 'mail_cc', oggetto: 'mail_subject', subject: 'mail_subject' };
const defaultSubject = e => e.title.replace(/(^|\s)#/g, '$1');

function parseMail(text, e) {
  const lines = text.replace(/\r/g, '').split('\n');
  const patch = {};
  while (lines.length && lines[0].trim() !== '') {
    const m = lines.shift().match(/^([\w]+)\s*:\s*(.*)$/);
    const key = m && HEADERS[m[1].toLowerCase()];
    if (key) patch[key] = m[2].trim();
  }
  patch.notes = lines.join('\n').replace(/^\n+/, '').trimEnd();
  // Oggetto lasciato uguale a quello automatico: resta automatico (segue il titolo).
  if (patch.mail_subject === defaultSubject(e)) patch.mail_subject = '';
  return patch;
}

export default {
  ls: {
    usage: 'mail [--all]',
    summary: 'mail da mandare e thread in attesa di risposta (--all anche le mandate degli ultimi 30 giorni)',
    options: { all: { type: 'boolean', short: 'a' } },
    async run(ctx, _pos, o) {
      const D = await ctx.data();
      const mails = D.entries.filter(e => e.kind === 'mail');
      const open = mails.filter(e => !e.done_at);
      const waiting = mails.filter(e => e.done_at && e.awaiting_reply).sort((a, b) => a.done_at.localeCompare(b.done_at));
      const sent = o.all ? mails.filter(e => e.done_at && !e.awaiting_reply) : [];
      if (ctx.json) return ctx.out({ open, waiting, sent });
      if (!open.length && !waiting.length && !sent.length) return console.log(c.dim('Nessuna mail da mandare né in attesa di risposta'));
      if (open.length) {
        heading('Da mandare');
        printTree(D, open);
      }
      if (waiting.length) {
        heading('In attesa di risposta');
        const days = e => Math.floor((Date.now() - Date.parse(e.done_at)) / 864e5);
        table(waiting.map(e => [c.dim(e.id), c.yellow(days(e) ? `da ${days(e)}g` : 'da oggi'), `✉ ${e.title}${e.contact ? c.dim(` → ${e.contact}`) : ''}`]));
        console.log(c.dim('  Quando arriva la risposta: org mail replied ID'));
      }
      if (sent.length) {
        heading('Mandate');
        printTree(D, sent);
      }
    },
  },

  replied: {
    usage: 'mail replied ID…',
    summary: 'la risposta è arrivata: il thread esce da "in attesa di risposta" (--undo lo rimette)',
    options: { undo: { type: 'boolean' } },
    async run(ctx, refs, o) {
      if (!refs.length) fail('Manca il numero della mail');
      for (const id of refs.map(r => numRef(r))) {
        await ctx.api().patch(`/entries/${id}`, { awaiting: !!o.undo });
        await printEntry(ctx, id);
      }
    },
  },

  new: {
    usage: 'mail new TESTO… [-d QUANDO] [-p PROGETTO]',
    summary: 'nuova mail, es. org mail new \'preventivo schede >fornitore@ditta.it @rover\'',
    options: entries.add.options,
    run: (ctx, pos, o) => entries.add.run(ctx, pos, { ...o, mail: true }),
  },

  edit: {
    usage: 'mail edit ID [--to A] [--cc A] [--subject OGGETTO] [--body TESTO | --body-file FILE]',
    summary: 'destinatari, oggetto e testo; senza opzioni apre $EDITOR',
    options: { to: { type: 'string' }, cc: { type: 'string' }, subject: { type: 'string', short: 's' }, body: { type: 'string', short: 'b' }, 'body-file': { type: 'string' } },
    async run(ctx, [ref], o) {
      const id = numRef(ref);
      const e = await ctx.api().get(`/entries/${id}`);
      if (e.kind !== 'mail') fail(`La voce ${id} non è una mail (org edit per le altre)`);
      let patch = {};
      if (o.to !== undefined) patch.contact = o.to;
      if (o.cc !== undefined) patch.mail_cc = o.cc;
      if (o.subject !== undefined) patch.mail_subject = o.subject;
      if (o.body !== undefined) patch.notes = o.body;
      if (o['body-file'] !== undefined) patch.notes = fs.readFileSync(o['body-file'] === '-' ? 0 : o['body-file'], 'utf8');
      if (!Object.keys(patch).length) {
        const draft = `A: ${e.contact || ''}\nCc: ${e.mail_cc || ''}\nOggetto: ${e.mail_subject || defaultSubject(e)}\n\n${e.notes || ''}`;
        const text = editText(draft, `mail-${id}.eml`);
        if (text === draft) return console.log(c.dim('Nessuna modifica'));
        patch = parseMail(text, e);
      }
      await ctx.api().patch(`/entries/${id}`, patch);
      await printEntry(ctx, id);
    },
  },

  attach: {
    usage: 'mail attach ID [FILE…] [--doc DOC_ID…]',
    summary: 'allega file dal computer o documenti del magazzino',
    options: { doc: { type: 'string', multiple: true } },
    async run(ctx, [ref, ...files], o) {
      const id = numRef(ref);
      if (!files.length && !o.doc) fail('Cosa allego? File o --doc NUMERO');
      for (const f of files) if (!fs.existsSync(f) || !fs.statSync(f).isFile()) fail(`${f}: file inesistente`);
      for (const file of files) {
        const blob = await fs.openAsBlob(file, { type: mimeOf(file) });
        await ctx.api().request('POST', `/entries/${id}/attachments?name=${encodeURIComponent(path.basename(file))}`, { body: blob, type: blob.type });
        console.log(`${c.green('📎')} ${path.basename(file)} ${c.dim(fmtSize(blob.size))}`);
      }
      for (const ref2 of o.doc ?? []) {
        const d = await docRef(ctx, ref2);
        await ctx.api().post(`/entries/${id}/attachments`, { doc_id: d.id });
        console.log(`${c.green('📎')} ${d.label || d.filename} ${c.dim(`documento ${d.id}`)}`);
      }
    },
  },

  detach: {
    usage: 'mail detach ALLEGATO…',
    summary: 'toglie allegati (il numero si vede con org show ID)',
    async run(ctx, refs) {
      if (!refs.length) fail('Manca il numero dell\'allegato');
      for (const ref of refs) await ctx.api().del(`/attachments/${numRef(ref, 'dell\'allegato')}`);
      console.log(`${c.green('✓')} tolti`);
    },
  },

  send: {
    usage: 'mail send ID [--done]',
    summary: 'apre la mail compilata in Thunderbird con gli allegati (serve make mail-helper); --done la segna mandata',
    options: { done: { type: 'boolean' } },
    async run(ctx, [ref], o) {
      const id = numRef(ref);
      const api = ctx.api();
      const { token } = await api.post(`/entries/${id}/send`);
      openExternal(`organizer-mail://open?server=${encodeURIComponent(`${api.base}/`)}&token=${token}`);
      console.log(`${c.green('✉')} Apro la mail ${id} in Thunderbird ${c.dim('(se non si apre: make mail-helper, oppure org mail eml)')}`);
      if (o.done) await api.patch(`/entries/${id}`, { done: true, today: today() });
    },
  },

  eml: {
    usage: 'mail eml ID [-o FILE]',
    summary: 'salva la mail come .eml (si apre con qualunque client di posta)',
    options: { out: { type: 'string', short: 'o' } },
    async run(ctx, [ref], o) {
      const id = numRef(ref);
      const res = await ctx.api().request('GET', `/entries/${id}/eml`, { raw: true });
      const out = path.resolve(o.out || `mail-${id}.eml`);
      fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      console.log(`${c.green('↓')} ${out}`);
    },
  },
};

// Rubrica, per sapere a chi scrivere (>nome nella barra rapida).
export const contacts = {
  usage: 'contacts [FILTRO]',
  summary: 'rubrica: nome, mail, azienda, ruolo',
  async run(ctx, pos) {
    const D = await ctx.data();
    const q = pos.join(' ').toLowerCase();
    const list = D.contacts.filter(x => !q || `${x.name} ${x.email} ${x.company} ${x.role} ${x.phone}`.toLowerCase().includes(q));
    if (ctx.json) return ctx.out(list);
    if (!list.length) return console.log(c.dim('Nessun contatto'));
    const companies = [...new Set(list.map(x => x.company))].sort((a, b) => (!a) - (!b) || a.localeCompare(b));
    for (const company of companies) {
      heading(company || 'senza azienda');
      table(list.filter(x => x.company === company).map(x => [x.name, c.cyan(x.email), c.dim(x.role), c.dim(x.phone)]), { right: [] });
    }
  },
};
