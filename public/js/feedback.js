// Feedback sull'app: una finestra per segnalare un errore o un'idea, con testo e screenshot (scelti, trascinati
// o incollati con ⌘V). Pagina, versione, browser e schermo si aggiungono da soli. Chi gestisce l'istanza li
// rivede nella pagina Feedback (o con `make feedback`), vedi server/feedback.js.
import { h, icon, S, ui, api, act, render, toast, fmtTime, fmtSize } from './core.js';

const MAX_FILES = 6;
let dialog = null;
let files = []; // File scelti, con l'anteprima (object URL)

function client() {
  return `${navigator.userAgent} · schermo ${screen.width}×${screen.height} · finestra ${innerWidth}×${innerHeight} · ${matchMedia('(display-mode: standalone)').matches ? 'app installata' : 'browser'}`;
}

function addFiles(list) {
  for (const f of list) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { toast(`${f.name || 'File'}: solo immagini`, { err: true }); continue; }
    if (files.length >= MAX_FILES) { toast(`Al massimo ${MAX_FILES} immagini`, { err: true }); break; }
    files.push({ file: f, url: URL.createObjectURL(f) });
  }
  drawFiles();
}

function drawFiles() {
  const box = dialog?.querySelector('.fb-files');
  if (!box) return;
  box.replaceChildren(...files.map((x, i) => h('figure.fb-thumb',
    h('img', { src: x.url, alt: x.file.name || `immagine ${i + 1}` }),
    h('figcaption', h('span', x.file.name || 'incollata'), h('span.muted', fmtSize(x.file.size))),
    h('button.icon-btn.sm', {
      type: 'button', title: 'Togli', 'aria-label': `Togli ${x.file.name || 'immagine'}`,
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
      const name = x.file.name || `incollata-${i + 1}.${x.file.type.split('/')[1]}`;
      await api('POST', `/feedback/${id}/files?${new URLSearchParams({ name })}`, x.file);
    }
    return true;
  });
  btn.disabled = false;
  if (!ok) return;
  dialog.querySelector('textarea').value = '';
  close();
  toast('Grazie! Feedback inviato');
}

export function openFeedback() {
  if (!dialog) {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true,
      onchange: ev => { addFiles([...ev.target.files]); ev.target.value = ''; } });
    dialog = h('dialog.fb', { 'aria-labelledby': 'fb-title', onclose: () => { for (const x of files) URL.revokeObjectURL(x.url); files = []; } },
      h('form', { onsubmit: submit },
        h('div.fb-h', h('h2#fb-title', icon('bug'), 'Segnala un problema o un\'idea'),
          h('button.icon-btn', { type: 'button', title: 'Chiudi', 'aria-label': 'Chiudi', onclick: close }, icon('x'))),
        h('label.f', h('span', 'Cosa è successo? Cosa ti aspettavi?'),
          h('textarea', { rows: 6, required: true, placeholder: 'Es. in Mail, premendo "Manda" non si apre niente…' })),
        h('div.fb-drop', {
          ondragover: ev => { ev.preventDefault(); ev.currentTarget.classList.add('drag'); },
          ondragleave: ev => ev.currentTarget.classList.remove('drag'),
          ondrop: ev => { ev.preventDefault(); ev.currentTarget.classList.remove('drag'); addFiles([...ev.dataTransfer.files]); },
        },
        icon('clip'), h('span', 'Screenshot: trascinali qui, incollali (⌘V) o '),
        h('button.btn.sm', { type: 'button', onclick: () => input.click() }, 'scegli…'), input),
        h('div.fb-files'),
        h('p.muted.fb-info', 'Insieme al testo arrivano da soli la pagina in cui sei, la versione dell\'app, il browser e la dimensione dello schermo.'),
        h('div.toolbar',
          h('button.btn.primary', { type: 'submit' }, icon('send'), 'Invia'),
          h('button.btn.ghost', { type: 'button', onclick: close }, 'Annulla'))));
    // Immagini incollate (es. ⌘⇧⌃4 sul Mac copia una parte dello schermo).
    dialog.addEventListener('paste', ev => {
      const imgs = [...ev.clipboardData.files].filter(f => f.type.startsWith('image/'));
      if (imgs.length) { ev.preventDefault(); addFiles(imgs); }
    });
    document.body.append(dialog);
  }
  dialog.showModal();
  dialog.querySelector('textarea').focus();
}

// ---------- pagina per chi gestisce l'istanza ----------
let list = null;
let loadedFor = null; // "stato:aperti": si rilegge quando cambia il filtro o il numero di quelli aperti

export function viewFeedback() {
  const D = S.data;
  if (D.feedbackOpen == null) return h('div.view', h('div.empty', h('p', 'Solo chi gestisce l\'istanza vede i feedback.')));
  const status = ui.fbStatus || 'open';
  const key = `${status}:${D.feedbackOpen}`;
  if (loadedFor !== key) {
    loadedFor = key;
    list = null;
    api('GET', `/feedback?status=${status}`).then(r => { list = r; render(); }).catch(e => { list = []; toast(e.message, { err: true }); });
  }
  const setStatus = s => { ui.fbStatus = s; loadedFor = null; render(); };
  const mark = (f, st) => act(async () => { await api('PATCH', `/feedback/${f.id}`, { status: st }); loadedFor = null; }, st === 'done' ? 'Segnato come risolto' : 'Riaperto');
  return h('div.view.fb-page',
    h('div.toolbar',
      h('div.seg',
        h('button', { class: status === 'open' && 'on', onclick: () => setStatus('open') }, 'Aperti', h('span.n', D.feedbackOpen)),
        h('button', { class: status === 'all' && 'on', onclick: () => setStatus('all') }, 'Tutti')),
      h('span.grow'),
      h('button.btn.ghost', { onclick: openFeedback }, icon('bug'), 'Nuovo feedback')),
    h('p.muted.fhint', 'Errori e idee mandati con "Feedback". Dal terminale: ', h('code.k', 'make feedback'), ' li esporta in feedback/ con le immagini.'),
    list == null ? h('p.muted', 'Caricamento…')
      : !list.length ? h('div.empty', h('p', status === 'open' ? 'Nessun feedback aperto.' : 'Nessun feedback.'))
        : list.map(f => h('article.fb-item', { class: f.status === 'done' ? 'done' : null },
          h('div.fb-meta',
            h('b', f.user_name || f.username || 'utente eliminato'), h('span.muted', fmtTime(f.created_at)),
            f.page && h('a.chip', { href: f.page, title: 'Apri la pagina da cui è partito' }, f.page),
            f.version && h('span.chip', `v${f.version}`),
            f.status === 'done' && h('span.chip.on', icon('check'), 'risolto'),
            h('span.grow'),
            h('button.btn.sm', { onclick: () => mark(f, f.status === 'done' ? 'open' : 'done') },
              icon(f.status === 'done' ? 'restore' : 'check'), f.status === 'done' ? 'Riapri' : 'Risolto')),
          h('div.fb-text', f.text),
          f.files.length > 0 && h('div.fb-files', f.files.map(x => h('a.fb-thumb', { href: `api/feedback/files/${x.id}`, target: '_blank', rel: 'noopener', title: x.name },
            h('img', { src: `api/feedback/files/${x.id}`, alt: x.name, loading: 'lazy' }),
            h('span.muted', x.name)))),
          h('details', h('summary.muted', 'Dettagli tecnici'), h('p.muted.mono', f.client || '—')))));
}
