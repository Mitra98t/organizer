// Composer delle mail: destinatari, oggetto, testo, allegati e invio verso il client di posta.
import { h, icon, S, ui, api, act, toast, patchEntry, autosize, fmtSize } from './core.js';

const subjectOf = e => e.mail_subject || e.title.replace(/(^|\s)#/g, '$1');

export function mailto(e) {
  const to = String(e.contact || '').split(',').map(s => s.trim()).filter(a => /^[^\s@]+@[^\s@]+$/.test(a)).join(',');
  const q = [`subject=${encodeURIComponent(subjectOf(e))}`];
  if (e.mail_cc) q.push(`cc=${encodeURIComponent(e.mail_cc)}`);
  if (e.notes) q.push(`body=${encodeURIComponent(e.notes)}`);
  return `mailto:${to}?${q.join('&')}`;
}

// I campi salvano su blur: prima di inviare si salva quello che c'è a schermo, anche se il focus è ancora lì.
async function saveVisible(e) {
  const val = fk => document.querySelector(`[data-fk="${fk}-${e.id}"]`)?.value;
  const now = { contact: val('to'), mail_cc: val('cc'), mail_subject: val('subj'), notes: val('body') };
  const patch = {};
  for (const [k, v] of Object.entries(now)) if (v !== undefined && v !== (e[k] || '')) patch[k] = v;
  if (Object.keys(patch).length) {
    Object.assign(e, patch);
    await api('PATCH', `/entries/${e.id}`, patch);
  }
}

async function send(e) {
  try {
    await saveVisible(e);
    const atts = S.data.attachmentsOf.get(e.id) || [];
    if (!ui.mailHelper) {
      location.href = mailto(e);
      if (atts.length) toast('Allegati non inclusi: installa l\'helper Thunderbird (Impostazioni → Mail) o usa .eml', { err: true });
      return;
    }
    const { token } = await api('POST', `/entries/${e.id}/send`);
    const server = location.href.split('#')[0].replace(/[^/]*$/, '');
    location.href = `organizer-mail://open?server=${encodeURIComponent(server)}&token=${token}`;
    toast('Mail aperta in Thunderbird', { action: { label: 'Segna inviata', fn: () => patchEntry(e, { done: true }) } });
  } catch (err) {
    toast(err.offline ? 'Sei offline' : err.message, { err: true });
  }
}

async function upload(e, files) {
  for (const f of files) {
    toast(`Allego ${f.name}…`);
    await act(() => api('POST', `/entries/${e.id}/attachments?${new URLSearchParams({ name: f.name })}`, f));
  }
}

export function mailComposer(e) {
  const D = S.data;
  const atts = D.attachmentsOf.get(e.id) || [];
  const saveField = key => ev => { if (ev.target.value !== (e[key] || '')) patchEntry(e, { [key]: ev.target.value }); };
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: ev => { const f = [...ev.target.files]; ev.target.value = ''; upload(e, f); } });
  const docs = D.docs.filter(d => !d.url && D.itemById.has(d.item_id));
  const known = String(e.contact || '').split(',').map(s => D.contactByEmail.get(s.trim().toLowerCase())).filter(Boolean);

  const box = h('div.mail',
    h('label.mf', h('span', 'A'),
      h('input', { value: e.contact || '', placeholder: 'email o nome dalla rubrica, separati da virgola', 'data-fk': `to-${e.id}`, 'data-ac': 'email', autocomplete: 'off', spellcheck: 'false', onblur: saveField('contact') })),
    known.length > 0 && h('div.mf-known', known.map(c => h('a', { href: `#/contatti/${c.id}` }, icon('user'), c.name || c.email, c.company && h('span.muted', ` · ${c.company}`)))),
    h('label.mf', h('span', 'Cc'),
      h('input', { value: e.mail_cc || '', 'data-fk': `cc-${e.id}`, 'data-ac': 'email', autocomplete: 'off', spellcheck: 'false', onblur: saveField('mail_cc') })),
    h('label.mf', h('span', 'Oggetto'),
      h('input', { value: e.mail_subject || '', placeholder: subjectOf({ ...e, mail_subject: null }), 'data-fk': `subj-${e.id}`, onblur: saveField('mail_subject') })),
    h('textarea.mail-body', { rows: 4, value: e.notes, placeholder: 'Testo della mail…', 'data-fk': `body-${e.id}`, oninput: autosize, onblur: saveField('notes') }),
    h('div.atts',
      atts.map(a => h('span.att',
        icon('clip'),
        h('a', { href: `api/attachments/${a.id}/file` }, a.filename),
        a.size != null && h('span.muted', fmtSize(a.size)),
        a.doc_id && h('span.muted', 'magazzino'),
        h('button.icon-btn.sm', { title: 'Togli', onclick: () => act(() => api('DELETE', `/attachments/${a.id}`)) }, icon('x')))),
      h('button.btn.sm', { onclick: () => fileInput.click() }, icon('clip'), 'Allega file'),
      docs.length > 0 && h('select.sm', {
        onchange: ev => { const id = +ev.target.value; ev.target.value = ''; if (id) act(() => api('POST', `/entries/${e.id}/attachments`, { doc_id: id })); },
      }, h('option', { value: '' }, '+ dal magazzino…'),
      docs.map(d => h('option', { value: d.id }, `${D.itemById.get(d.item_id).code} · ${d.label || d.filename}${d.version ? ` v${d.version}` : ''}`))),
      fileInput),
    h('div.mail-actions',
      h('button.btn.primary', { onclick: () => send(e) }, icon('send'), ui.mailHelper ? 'Manda (Thunderbird)' : 'Manda'),
      h('a.btn.sm.ghost', { href: mailto(e), title: 'Apre l\'app mail predefinita, senza allegati' }, 'App mail'),
      h('a.btn.sm.ghost', { href: `api/entries/${e.id}/eml`, download: '', title: 'File .eml con allegati' }, icon('download'), '.eml')));

  box.addEventListener('dragover', ev => { ev.preventDefault(); box.classList.add('drag'); });
  box.addEventListener('dragleave', () => box.classList.remove('drag'));
  box.addEventListener('drop', ev => {
    ev.preventDefault();
    box.classList.remove('drag');
    if (ev.dataTransfer.files.length) upload(e, [...ev.dataTransfer.files]);
  });
  return box;
}
