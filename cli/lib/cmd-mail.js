// Mails to send: prepared here (recipients, subject, text, attachments) and opened in Thunderbird with the app's
// helper (make mail-helper), or saved as .eml.
import fs from 'node:fs';
import path from 'node:path';
import { c, fail, table, heading, fmtSize, today, editText, openExternal } from './term.js';
import { numRef } from './data.js';
import entries, { printTree, printEntry } from './cmd-entries.js';
import { mimeOf, docRef } from './cmd-docs.js';
import { tr } from './i18n.js';

// Template for $EDITOR: headers as in a mail, an empty line, then the text. English and Italian header names work.
const HEADERS = { to: 'contact', a: 'contact', cc: 'mail_cc', subject: 'mail_subject', oggetto: 'mail_subject' };
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
  // Subject left equal to the automatic one: it stays automatic (it follows the title).
  if (patch.mail_subject === defaultSubject(e)) patch.mail_subject = '';
  return patch;
}

export default {
  ls: {
    usage: 'mail [--all]',
    summary: tr('mails to send and threads awaiting reply (--all also the ones sent in the last 30 days)'),
    options: { all: { type: 'boolean', short: 'a' } },
    async run(ctx, _pos, o) {
      const D = await ctx.data();
      const mails = D.entries.filter(e => e.kind === 'mail');
      const open = mails.filter(e => !e.done_at);
      const waiting = mails.filter(e => e.done_at && e.awaiting_reply).sort((a, b) => a.done_at.localeCompare(b.done_at));
      const sent = o.all ? mails.filter(e => e.done_at && !e.awaiting_reply) : [];
      if (ctx.json) return ctx.out({ open, waiting, sent });
      if (!open.length && !waiting.length && !sent.length) return console.log(c.dim(tr('No mails to send or awaiting reply')));
      if (open.length) {
        heading(tr('To send'));
        printTree(D, open);
      }
      if (waiting.length) {
        heading(tr('Awaiting reply'));
        const days = e => Math.floor((Date.now() - Date.parse(e.done_at)) / 864e5);
        table(waiting.map(e => [c.dim(e.id), c.yellow(days(e) ? tr('for {n}d', { n: days(e) }) : tr('since today')), `✉ ${e.title}${e.contact ? c.dim(` → ${e.contact}`) : ''}`]));
        console.log(c.dim(`  ${tr('When the reply arrives: org mail replied ID')}`));
      }
      if (sent.length) {
        heading(tr('Sent'));
        printTree(D, sent);
      }
    },
  },

  replied: {
    usage: 'mail replied ID…',
    summary: tr('the reply arrived: the thread leaves "awaiting reply" (--undo puts it back)'),
    options: { undo: { type: 'boolean' } },
    async run(ctx, refs, o) {
      if (!refs.length) fail(tr('The mail number is missing'));
      for (const id of refs.map(r => numRef(r))) {
        await ctx.api().patch(`/entries/${id}`, { awaiting: !!o.undo });
        await printEntry(ctx, id);
      }
    },
  },

  new: {
    usage: tr('mail new TEXT… [-d WHEN] [-p PROJECT]'),
    summary: tr('new mail, e.g. org mail new \'quote for boards >supplier@company.example @rover\''),
    options: entries.add.options,
    run: (ctx, pos, o) => entries.add.run(ctx, pos, { ...o, mail: true }),
  },

  edit: {
    usage: tr('mail edit ID [--to TO] [--cc CC] [--subject SUBJECT] [--body TEXT | --body-file FILE]'),
    summary: tr('recipients, subject and text; without options it opens $EDITOR'),
    options: { to: { type: 'string' }, cc: { type: 'string' }, subject: { type: 'string', short: 's' }, body: { type: 'string', short: 'b' }, 'body-file': { type: 'string' } },
    async run(ctx, [ref], o) {
      const id = numRef(ref);
      const e = await ctx.api().get(`/entries/${id}`);
      if (e.kind !== 'mail') fail(tr('Entry {id} is not a mail (org edit for the others)', { id }));
      let patch = {};
      if (o.to !== undefined) patch.contact = o.to;
      if (o.cc !== undefined) patch.mail_cc = o.cc;
      if (o.subject !== undefined) patch.mail_subject = o.subject;
      if (o.body !== undefined) patch.notes = o.body;
      if (o['body-file'] !== undefined) patch.notes = fs.readFileSync(o['body-file'] === '-' ? 0 : o['body-file'], 'utf8');
      if (!Object.keys(patch).length) {
        const draft = `${tr('To||mail header')}: ${e.contact || ''}\nCc: ${e.mail_cc || ''}\n${tr('Subject||mail header')}: ${e.mail_subject || defaultSubject(e)}\n\n${e.notes || ''}`;
        const text = editText(draft, `mail-${id}.eml`);
        if (text === draft) return console.log(c.dim(tr('No changes')));
        patch = parseMail(text, e);
      }
      await ctx.api().patch(`/entries/${id}`, patch);
      await printEntry(ctx, id);
    },
  },

  attach: {
    usage: 'mail attach ID [FILE…] [--doc DOC_ID…]',
    summary: tr('attaches files from the computer or inventory documents'),
    options: { doc: { type: 'string', multiple: true } },
    async run(ctx, [ref, ...files], o) {
      const id = numRef(ref);
      if (!files.length && !o.doc) fail(tr('What should I attach? Files or --doc NUMBER'));
      for (const f of files) if (!fs.existsSync(f) || !fs.statSync(f).isFile()) fail(tr('{file}: no such file', { file: f }));
      for (const file of files) {
        const blob = await fs.openAsBlob(file, { type: mimeOf(file) });
        await ctx.api().request('POST', `/entries/${id}/attachments?name=${encodeURIComponent(path.basename(file))}`, { body: blob, type: blob.type });
        console.log(`${c.green('📎')} ${path.basename(file)} ${c.dim(fmtSize(blob.size))}`);
      }
      for (const ref2 of o.doc ?? []) {
        const d = await docRef(ctx, ref2);
        await ctx.api().post(`/entries/${id}/attachments`, { doc_id: d.id });
        console.log(`${c.green('📎')} ${d.label || d.filename} ${c.dim(tr('document {id}', { id: d.id }))}`);
      }
    },
  },

  detach: {
    usage: tr('mail detach ATTACHMENT…'),
    summary: tr('removes attachments (the number shows with org show ID)'),
    async run(ctx, refs) {
      if (!refs.length) fail(tr('The attachment number is missing'));
      for (const ref of refs) await ctx.api().del(`/attachments/${numRef(ref, tr('The attachment number is missing'))}`);
      console.log(`${c.green('✓')} ${tr('removed')}`);
    },
  },

  send: {
    usage: 'mail send ID [--done]',
    summary: tr('opens the filled-in mail in Thunderbird with the attachments (needs make mail-helper); --done marks it sent'),
    options: { done: { type: 'boolean' } },
    async run(ctx, [ref], o) {
      const id = numRef(ref);
      const api = ctx.api();
      const { token } = await api.post(`/entries/${id}/send`);
      openExternal(`organizer-mail://open?server=${encodeURIComponent(`${api.base}/`)}&token=${token}`);
      console.log(`${c.green('✉')} ${tr('Opening mail {id} in Thunderbird', { id })} ${c.dim(tr('(if it does not open: make mail-helper, or org mail eml)'))}`);
      if (o.done) await api.patch(`/entries/${id}`, { done: true, today: today() });
    },
  },

  eml: {
    usage: 'mail eml ID [-o FILE]',
    summary: tr('saves the mail as .eml (it opens with any mail client)'),
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

// Address book, to know whom to write to (>name in the quick bar).
export const contacts = {
  usage: tr('contacts [FILTER]'),
  summary: tr('address book: name, email, company, role'),
  async run(ctx, pos) {
    const D = await ctx.data();
    const q = pos.join(' ').toLowerCase();
    const list = D.contacts.filter(x => !q || `${x.name} ${x.email} ${x.company} ${x.role} ${x.phone}`.toLowerCase().includes(q));
    if (ctx.json) return ctx.out(list);
    if (!list.length) return console.log(c.dim(tr('No contacts')));
    const companies = [...new Set(list.map(x => x.company))].sort((a, b) => (!a) - (!b) || a.localeCompare(b));
    for (const company of companies) {
      heading(company || tr('no company'));
      table(list.filter(x => x.company === company).map(x => [x.name, c.cyan(x.email), c.dim(x.role), c.dim(x.phone)]), { right: [] });
    }
  },
};
