// Feedback about the app: a window to report a bug or an idea, with text and screenshots (picked, dragged or pasted
// with ⌘V). Page, version, browser and screen are added automatically. Whoever runs the instance reviews them on
// the Feedback page (or with `make feedback`), see server/feedback.js.
import { h, icon, S, ui, api, act, render, toast, fmtTime, fmtSize } from './core.js';
import { tr } from './i18n.js';

const MAX_FILES = 6;
let dialog = null;
let files = []; // chosen files, with their preview (object URL)

function client() {
  return `${navigator.userAgent} · screen ${screen.width}×${screen.height} · window ${innerWidth}×${innerHeight} · ${matchMedia('(display-mode: standalone)').matches ? 'installed app' : 'browser'}`;
}

function addFiles(list) {
  for (const f of list) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { toast(tr('{name}: images only', { name: f.name || 'File' }), { err: true }); continue; }
    if (files.length >= MAX_FILES) { toast(tr('At most {n} images', { n: MAX_FILES }), { err: true }); break; }
    files.push({ file: f, url: URL.createObjectURL(f) });
  }
  drawFiles();
}

function drawFiles() {
  const box = dialog?.querySelector('.fb-files');
  if (!box) return;
  box.replaceChildren(...files.map((x, i) => h('figure.fb-thumb',
    h('img', { src: x.url, alt: x.file.name || tr('image {n}', { n: i + 1 }) }),
    h('figcaption', h('span', x.file.name || 'incollata'), h('span.muted', fmtSize(x.file.size))),
    h('button.icon-btn.sm', {
      type: 'button', title: tr('Remove'), 'aria-label': tr('Remove {name}', { name: x.file.name || tr('image') }),
      onclick: () => { URL.revokeObjectURL(x.url); files.splice(i, 1); drawFiles(); },
    }, icon('x')))));
}

function close() {
  for (const x of files) URL.revokeObjectURL(x.url);
  files = [];
  dialog?.close();
}

async function submit(ev) {
  ev.preventDefault();
  const text = dialog.querySelector('textarea').value.trim();
  if (!text) return dialog.querySelector('textarea').focus();
  const btn = dialog.querySelector('button[type=submit]');
  btn.disabled = true;
  const ok = await act(async () => {
    const { id } = await api('POST', '/feedback', { text, page: location.hash || '#/', version: S.version || '', client: client() });
    for (const [i, x] of files.entries()) {
      const name = x.file.name || `pasted-${i + 1}.${x.file.type.split('/')[1]}`;
      await api('POST', `/feedback/${id}/files?${new URLSearchParams({ name })}`, x.file);
    }
    return true;
  });
  btn.disabled = false;
  if (!ok) return;
  dialog.querySelector('textarea').value = '';
  close();
  toast(tr('Thanks! Feedback sent'));
}

export function openFeedback() {
  if (!dialog) {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true,
      onchange: ev => { addFiles([...ev.target.files]); ev.target.value = ''; } });
    dialog = h('dialog.fb', { 'aria-labelledby': 'fb-title', onclose: () => { for (const x of files) URL.revokeObjectURL(x.url); files = []; } },
      h('form', { onsubmit: submit },
        h('div.fb-h', h('h2#fb-title', icon('bug'), tr('Report a problem or an idea')),
          h('button.icon-btn', { type: 'button', title: tr('Close'), 'aria-label': tr('Close'), onclick: close }, icon('x'))),
        h('label.f', h('span', tr('What happened? What did you expect?')),
          h('textarea', { rows: 6, required: true, placeholder: tr('E.g. in Mail, pressing "Send" opens nothing…') })),
        h('div.fb-drop', {
          ondragover: ev => { ev.preventDefault(); ev.currentTarget.classList.add('drag'); },
          ondragleave: ev => ev.currentTarget.classList.remove('drag'),
          ondrop: ev => { ev.preventDefault(); ev.currentTarget.classList.remove('drag'); addFiles([...ev.dataTransfer.files]); },
        },
        icon('clip'), h('span', tr('Screenshots: drag them here, paste them (⌘V) or ')),
        h('button.btn.sm', { type: 'button', onclick: () => input.click() }, 'scegli…'), input),
        h('div.fb-files'),
        h('p.muted.fb-info', tr('Along with the text, the page you are on, the app version, the browser and the screen size are sent automatically.')),
        h('div.toolbar',
          h('button.btn.primary', { type: 'submit' }, icon('send'), tr('Send')),
          h('button.btn.ghost', { type: 'button', onclick: close }, tr('Cancel')))));
    // Pasted images (e.g. ⌘⇧⌃4 on the Mac copies a part of the screen).
    dialog.addEventListener('paste', ev => {
      const imgs = [...ev.clipboardData.files].filter(f => f.type.startsWith('image/'));
      if (imgs.length) { ev.preventDefault(); addFiles(imgs); }
    });
    document.body.append(dialog);
  }
  dialog.showModal();
  dialog.querySelector('textarea').focus();
}

// ---------- page for whoever runs the instance ----------
let list = null;
let loadedFor = null; // "status:open": read again when the filter or the number of open ones changes

export function viewFeedback() {
  const D = S.data;
  if (D.feedbackOpen == null) return h('div.view', h('div.empty', h('p', tr('Only whoever runs the instance sees feedback.'))));
  const status = ui.fbStatus || 'open';
  const key = `${status}:${D.feedbackOpen}`;
  if (loadedFor !== key) {
    loadedFor = key;
    list = null;
    api('GET', `/feedback?status=${status}`).then(r => { list = r; render(); }).catch(e => { list = []; toast(e.message, { err: true }); });
  }
  const setStatus = s => { ui.fbStatus = s; loadedFor = null; render(); };
  const mark = (f, st) => act(async () => { await api('PATCH', `/feedback/${f.id}`, { status: st }); loadedFor = null; }, st === 'done' ? tr('Marked as resolved') : tr('Reopened'));
  return h('div.view.fb-page',
    h('div.toolbar',
      h('div.seg',
        h('button', { class: status === 'open' && 'on', onclick: () => setStatus('open') }, tr('Unresolved'), h('span.n', D.feedbackOpen)),
        h('button', { class: status === 'all' && 'on', onclick: () => setStatus('all') }, tr('All'))),
      h('span.grow'),
      h('button.btn.ghost', { onclick: openFeedback }, icon('bug'), tr('New feedback'))),
    h('p.muted.fhint', tr('Bugs and ideas sent with "Feedback". From the terminal: '), h('code.k', 'make feedback'), tr(' exports them to feedback/ with the images.')),
    list == null ? h('p.muted', tr('Loading…'))
      : !list.length ? h('div.empty', h('p', status === 'open' ? tr('No open feedback.') : tr('No feedback.')))
        : list.map(f => h('article.fb-item', { class: f.status === 'done' ? 'done' : null },
          h('div.fb-meta',
            h('b', f.user_name || f.username || tr('deleted user')), h('span.muted', fmtTime(f.created_at)),
            f.page && h('a.chip', { href: f.page, title: tr('Open the page it was sent from') }, f.page),
            f.version && h('span.chip', `v${f.version}`),
            f.status === 'done' && h('span.chip.on', icon('check'), 'risolto'),
            h('span.grow'),
            h('button.btn.sm', { onclick: () => mark(f, f.status === 'done' ? 'open' : 'done') },
              icon(f.status === 'done' ? 'restore' : 'check'), f.status === 'done' ? tr('Reopen') : tr('Resolved'))),
          h('div.fb-text', f.text),
          f.files.length > 0 && h('div.fb-files', f.files.map(x => h('a.fb-thumb', { href: `api/feedback/files/${x.id}`, target: '_blank', rel: 'noopener', title: x.name },
            h('img', { src: `api/feedback/files/${x.id}`, alt: x.name, loading: 'lazy' }),
            h('span.muted', x.name)))),
          h('details', h('summary.muted', tr('Technical details')), h('p.muted.mono', f.client || '—')))));
}
