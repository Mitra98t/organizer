// Visualizzatore di documenti con note: PDF (PDF.js), immagini e testo, più una barra laterale di note.
// Le note con pagina e coordinate (0..1) sono segnaposto su un punto del file; le altre sono note generali.
//
// L'app ridisegna le viste a ogni sincronizzazione: ridisegnare un PDF ogni volta sarebbe lento, quindi
// il visualizzatore (canvas compresi) resta in memoria e viene solo riagganciato; si aggiornano i segnaposto.
// Più visualizzatori possono essere aperti insieme (revisione affiancata, #/review?d=1,2,3).
import { h, icon, S, ui, api, act, render, richText, fmtTime, fmtSize, userName, toast, trashIt, autosize, itemAttrs, save, docFileUrl, DOC_KINDS } from './core.js';
import { today } from './parse.js';

const PDFJS = new URL('../vendor/pdfjs/', import.meta.url).href;
const TEXT_MAX = 512 * 1024;
let pdfjsLib = null;
const viewers = new Map(); // id documento → visualizzatore aperto

function loadPdfjs() {
  pdfjsLib ||= import('../vendor/pdfjs/pdf.min.mjs').then(m => {
    m.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.mjs`;
    return m;
  });
  return pdfjsLib;
}

// Link che puntano a un PDF: si caricano dal vivo attraverso il server (vedi server/remote.js).
const isPdfLink = d => d.url && /\.pdf$/i.test((() => { try { return new URL(d.url).pathname; } catch { return ''; } })());

function kindOf(d) {
  if (isPdfLink(d)) return 'pdf';
  if (d.url) return 'link';
  if (d.mime === 'application/pdf' || /\.pdf$/i.test(d.filename || '')) return 'pdf';
  if (/^image\/(png|jpeg|gif|webp)$/.test(d.mime || '')) return 'image';
  if (/^text\//.test(d.mime || '') || /\.(txt|log|md|csv|ini|cfg|json|ya?ml|h|c|cpp|py|sh)$/i.test(d.filename || '')) return 'text';
  return 'none';
}

const pinnable = v => v.kind === 'pdf' || v.kind === 'image';

// ---------- visualizzatore (persistente) ----------
function getViewer(d) {
  if (viewers.has(d.id)) return viewers.get(d.id);
  const v = { id: d.id, kind: kindOf(d), zoom: 1, scroll: 0, pages: [], draft: null, status: 'loading' };
  v.scroller = h('div.dv-scroll', { onscroll: () => { v.scroll = v.scroller.scrollTop; updatePageLabel(v); } });
  v.pagesEl = h('div.dv-pages');
  v.scroller.append(v.pagesEl);
  v.pageLabel = h('span.dv-pl');
  v.el = h('div.dv-main',
    h('div.dv-toolbar',
      pinnable(v) && [
        h('button.icon-btn', { title: 'Riduci', onclick: () => setZoom(v, v.zoom / 1.25) }, '−'),
        v.zoomLabel = h('span.dv-zoom', '100%'),
        h('button.icon-btn', { title: 'Ingrandisci', onclick: () => setZoom(v, v.zoom * 1.25) }, '+'),
        h('button.btn.sm.ghost', { onclick: () => setZoom(v, 1) }, 'Adatta'),
        v.pageLabel,
      ],
      h('span.grow'),
      h('span.muted.dv-hint', pinnable(v) ? 'Clicca sul documento per aggiungere una nota in quel punto' : '')),
    v.scroller);
  v.resize = new ResizeObserver(() => { clearTimeout(v.rt); v.rt = setTimeout(() => layout(v), 120); });
  v.resize.observe(v.scroller);
  viewers.set(d.id, v);
  if (v.kind === 'pdf') openPdf(v, d);
  else if (v.kind === 'image') openImage(v, d);
  else if (v.kind === 'text') openText(v, d);
  else v.status = 'ready';
  return v;
}

// In PDF.js 6 il documento si chiude dal "loading task" (il proxy del documento non ha più destroy()).
const closePdf = v => v.task?.destroy().catch(() => {});

function destroyViewer(v) {
  v.resize.disconnect();
  v.io?.disconnect();
  closePdf(v);
  viewers.delete(v.id);
}

// Documenti richiesti dalla pagina attuale: quelli non più mostrati si chiudono.
function wantedDocs() {
  const single = location.hash.match(/^#\/d\/(\d+)/);
  if (single) return [+single[1]];
  const review = location.hash.match(/^#\/review\?d=([\d,]+)/);
  return review ? review[1].split(',').map(Number) : [];
}

window.addEventListener('hashchange', () => {
  const want = wantedDocs();
  for (const v of [...viewers.values()]) if (!want.includes(v.id)) destroyViewer(v);
  if (!want.length) document.body.classList.remove('doc-focus');
});

function fail(v, msg) {
  v.status = 'error';
  const d = S.data.docById.get(v.id);
  v.pagesEl.replaceChildren(h('div.empty', h('p', msg),
    d?.url && h('a.btn', { href: d.url, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), 'Apri il link originale')));
}

async function openPdf(v, d) {
  v.pagesEl.replaceChildren(h('div.empty', 'Caricamento del PDF…'));
  try {
    const pdfjs = await loadPdfjs();
    // PDF da link: lo scarica il server; si legge prima la risposta per mostrare il motivo di un errore.
    let data;
    if (d.url) {
      v.pagesEl.replaceChildren(h('div.empty', 'Scarico il PDF dal link…'));
      const r = await fetch(`api/docs/${d.id}/remote`, { credentials: 'same-origin' });
      if (!r.ok) return fail(v, (await r.json().catch(() => null))?.error || `Errore ${r.status}`);
      data = new Uint8Array(await r.arrayBuffer());
    }
    v.task = pdfjs.getDocument({
      ...(data ? { data } : { url: docFileUrl(d, { inline: true }) }),
      withCredentials: true,
      standardFontDataUrl: `${PDFJS}standard_fonts/`,
      wasmUrl: `${PDFJS}wasm/`,
      disableRange: true,
      disableStream: true,
    });
    v.pdf = await v.task.promise;
    if (viewers.get(v.id) !== v) return closePdf(v); // nel frattempo il documento è stato chiuso
    const wraps = [];
    for (let n = 1; n <= v.pdf.numPages; n++) {
      const page = await v.pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      wraps.push(newPage(v, n, vp.width, vp.height, { page }));
    }
    v.pagesEl.replaceChildren(...wraps);
    v.io = new IntersectionObserver(entries => {
      for (const e of entries) {
        const p = v.pages[+e.target.dataset.page - 1];
        p.visible = e.isIntersecting;
        if (p.visible) renderPage(v, p);
      }
    }, { root: v.scroller, rootMargin: '400px 0px' });
    for (const p of v.pages) v.io.observe(p.wrap);
    ready(v);
  } catch (e) {
    console.warn(e);
    fail(v, `Impossibile aprire il PDF: ${e.message}`);
  }
}

function openImage(v, d) {
  const img = h('img.dv-img', { src: docFileUrl(d, { inline: true }), alt: d.filename || '', draggable: 'false' });
  img.onload = () => {
    const wrap = newPage(v, 1, img.naturalWidth, img.naturalHeight, { img });
    v.pagesEl.replaceChildren(wrap);
    ready(v);
  };
  img.onerror = () => fail(v, 'Impossibile caricare l\'immagine');
}

async function openText(v, d) {
  if (d.size > TEXT_MAX) return fail(v, `File di testo troppo grande per l'anteprima (${fmtSize(d.size)}): scaricalo.`);
  try {
    const r = await fetch(docFileUrl(d), { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`errore ${r.status}`);
    v.pagesEl.replaceChildren(h('pre.dv-text', await r.text()));
    v.status = 'ready';
  } catch (e) {
    fail(v, `Impossibile leggere il file: ${e.message}`);
  }
}

function newPage(v, num, w, h0, extra) {
  const pins = h('div.dv-pins');
  const wrap = h('div.dv-page', { 'data-page': num, onclick: ev => clickPage(v, num, wrap, ev) });
  if (extra.img) wrap.append(extra.img);
  else wrap.append(extra.canvas = h('canvas'));
  wrap.append(pins);
  v.pages.push({ num, w, h: h0, wrap, pins, ...extra });
  return wrap;
}

function ready(v) {
  v.status = 'ready';
  layout(v);
  updatePins(v);
  applyPendingScroll(v);
}

// Larghezza = spazio disponibile × zoom; l'altezza segue le proporzioni della pagina.
function layout(v) {
  if (!v.pages.length || !v.scroller.isConnected) return;
  const avail = Math.max(200, v.scroller.clientWidth - 16); // 8 px di margine per lato
  for (const p of v.pages) {
    p.cssW = Math.round(avail * v.zoom);
    p.wrap.style.width = `${p.cssW}px`;
    p.wrap.style.height = `${Math.round(p.cssW * p.h / p.w)}px`;
    if (p.visible) renderPage(v, p);
  }
  if (v.zoomLabel) v.zoomLabel.textContent = `${Math.round(v.zoom * 100)}%`;
  updatePageLabel(v);
}

function renderPage(v, p) {
  if (!p.page || !p.cssW) return;
  const dpr = window.devicePixelRatio || 1;
  const scale = (p.cssW / p.w) * dpr;
  if (p.renderedScale === scale) return;
  p.task?.cancel();
  const viewport = p.page.getViewport({ scale });
  // Si disegna su un canvas nuovo e si sostituisce a fine render: niente pagina bianca durante lo zoom.
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  p.task = p.page.render({ canvas, viewport });
  p.task.promise.then(() => {
    p.canvas.replaceWith(canvas);
    p.canvas = canvas;
    p.renderedScale = scale;
  }).catch(e => { if (e?.name !== 'RenderingCancelledException') console.warn(e); });
}

function setZoom(v, z) {
  const ratio = v.scroller.scrollTop / Math.max(1, v.scroller.scrollHeight);
  v.zoom = Math.min(4, Math.max(0.4, z));
  layout(v);
  v.scroller.scrollTop = ratio * v.scroller.scrollHeight;
}

function updatePageLabel(v) {
  if (!v.pageLabel || v.pages.length < 2) return;
  const mid = v.scroller.scrollTop + v.scroller.clientHeight / 2;
  const p = v.pages.find(x => x.wrap.offsetTop + x.wrap.offsetHeight > mid) || v.pages.at(-1);
  v.pageLabel.textContent = `pag. ${p.num} / ${v.pages.length}`;
}

function clickPage(v, num, wrap, ev) {
  if (ev.target.closest('.dv-pin')) return;
  const r = wrap.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
  for (const o of viewers.values()) o.draft = null; // una nota in preparazione alla volta
  v.draft = { page: num, x, y, fresh: true };
  openNotes(v);
  ui.docNote = null;
  render();
}

// ---------- spazio per il documento ----------
// Barra delle note nascondibile e modalità "espandi" che toglie il resto dell'app.
// Pagina singola: preferenza ricordata (ui.docNotesHidden). Revisione: ogni pannello ha la sua (v.paneNotes).
const inReview = () => location.hash.startsWith('#/review');
const notesShown = v => (inReview() ? !!v.paneNotes : !ui.docNotesHidden);

function openNotes(v) {
  if (notesShown(v)) return;
  if (inReview()) v.paneNotes = true;
  else {
    ui.docNotesHidden = false;
    save('org.docNotesHidden', false);
  }
  relayoutSoon();
}

// Lo spazio del documento cambia: si reimpagina subito, senza aspettare il ResizeObserver.
function relayoutSoon() {
  setTimeout(() => { for (const v of viewers.values()) layout(v); }, 0);
}

function toggleNotes(v) {
  if (inReview()) v.paneNotes = !v.paneNotes;
  else {
    ui.docNotesHidden = !ui.docNotesHidden;
    save('org.docNotesHidden', ui.docNotesHidden);
  }
  render();
  relayoutSoon();
}

export function setDocFocus(on) {
  document.body.classList.toggle('doc-focus', on);
  render();
  relayoutSoon();
}

// ---------- note ----------
const notesOf = id => S.data.docNotesOf.get(id) || [];
const visible = n => ui.docShowResolved || !n.resolved_at;

// Numerazione dei segnaposto: per pagina, dall'alto in basso.
function numbered(docId) {
  return notesOf(docId).filter(n => n.page != null && visible(n))
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
    .map((n, i) => ({ n, num: i + 1 }));
}

function updatePins(v) {
  if (!pinnable(v) || v.status !== 'ready') return;
  const list = numbered(v.id);
  for (const p of v.pages) {
    const pins = list.filter(x => x.n.page === p.num).map(({ n, num }) => h('button.dv-pin', {
      class: [ui.docNote === n.id && 'on', n.resolved_at && 'resolved'].filter(Boolean).join(' ') || null,
      style: `left:${n.x * 100}%;top:${n.y * 100}%`,
      title: n.text,
      onclick: ev => { ev.stopPropagation(); openNotes(v); selectNote(n.id, false); },
    }, num));
    if (v.draft?.page === p.num) pins.push(h('span.dv-pin.draft', { style: `left:${v.draft.x * 100}%;top:${v.draft.y * 100}%` }, '+'));
    p.pins.replaceChildren(...pins);
  }
}

// Lo scorrimento verso una nota si applica dopo che il visualizzatore è stato riagganciato alla pagina
// (durante il ridisegno lo scorrimento verrebbe interrotto): qui si prenota soltanto.
function scrollToNote(v, id) {
  v.pendingNote = id;
}

function applyPendingScroll(v) {
  const id = v.pendingNote;
  if (!id || v.status !== 'ready' || !v.scroller.isConnected) return;
  const n = notesOf(v.id).find(x => x.id === id);
  const p = n?.page != null && v.pages[n.page - 1];
  v.pendingNote = null;
  if (!p) return;
  v.scroll = Math.max(0, p.wrap.offsetTop + n.y * p.wrap.offsetHeight - v.scroller.clientHeight / 2);
  v.scroller.scrollTop = v.scroll; // immediato: lo scorrimento animato si ferma se la scheda non è in primo piano
  updatePageLabel(v);
}

function selectNote(id, scrollDoc = true) {
  ui.docNote = id;
  const docId = S.data.docNotes.find(n => n.id === id)?.doc_id;
  for (const v of viewers.values()) v.draft = null;
  const v = viewers.get(docId);
  if (v && scrollDoc) scrollToNote(v, id);
  render();
  document.querySelector(`.dnote[data-note="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function noteToTodo(d, n) {
  const it = S.data.itemById.get(d.item_id);
  const first = n.text.split('\n')[0].slice(0, 200);
  const text = it && !first.toUpperCase().includes(`#${it.code.toUpperCase()}`) ? `${first} #${it.code}` : first;
  const link = `${location.origin}${location.pathname}#/d/${d.id}?n=${n.id}`;
  const r = await act(async () => {
    const e = await api('POST', '/entries', { text, today: today() });
    // Negli aggiornamenti (non nei dettagli) perché lì i link sono cliccabili.
    await api('POST', `/entries/${e.id}/log`, { text: `Da ${d.label || d.filename}${n.page && kindOf(d) === 'pdf' ? `, pag. ${n.page}` : ''}: ${link}` });
    return e;
  });
  if (r) toast('Todo creata dalla nota', { action: { label: 'Agenda', fn: () => { location.hash = '#/agenda'; } } });
}

function enterSave(save, cancel) {
  return ev => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      const text = ev.target.value.trim();
      if (text) save(text, ev.target);
    } else if (ev.key === 'Escape' && cancel) {
      ev.preventDefault(); // l'Esc globale non deve anche tornare indietro
      cancel();
    }
  };
}

function noteCard(d, n, num) {
  const me = S.data.me;
  const editing = ui.docEdit === n.id;
  const save = text => {
    ui.docEdit = null;
    if (text !== n.text) act(() => api('PATCH', `/doc-notes/${n.id}`, { text }));
    else render();
  };
  return h('div.dnote', {
    'data-note': n.id,
    class: [ui.docNote === n.id && 'on', n.resolved_at && 'resolved'].filter(Boolean).join(' ') || null,
    onclick: ev => { if (!ev.target.closest('button, a, textarea')) selectNote(n.id); },
  },
  h('div.dnote-h',
    num ? h('span.dv-pin.mini', num) : h('span.dnote-gen', icon('log'), 'generale'),
    n.page != null && kindOf(d) === 'pdf' && h('span.muted', `pag. ${n.page}`),
    h('span.grow'),
    h('span.muted', `${userName(n.created_by)} · ${fmtTime(n.created_at)}`)),
  editing
    ? h('textarea.dnote-edit', {
      value: n.text, rows: 2, 'data-fk': `dnedit-${n.id}`, oninput: autosize,
      onkeydown: enterSave(save, () => { ui.docEdit = null; render(); }),
      onblur: ev => save(ev.target.value.trim() || n.text),
    })
    : h('div.dnote-t', { ondblclick: () => { ui.docEdit = n.id; render(); } }, richText(n.text)),
  h('div.dnote-a',
    h('button.chip', { onclick: () => act(() => api('PATCH', `/doc-notes/${n.id}`, { resolved: !n.resolved_at })) },
      icon('check'), n.resolved_at ? 'riapri' : 'risolta'),
    h('button.chip', { onclick: () => { ui.docEdit = n.id; render(); } }, 'modifica'),
    h('button.chip', { onclick: () => noteToTodo(d, n) }, '→ todo'),
    (n.created_by === me.id || me.is_admin) && h('button.icon-btn.sm', { title: 'Elimina', onclick: () => trashIt('docnote', `/doc-notes/${n.id}`, 'Nota') }, icon('trash'))));
}

function notesPanel(d, v) {
  const all = notesOf(d.id);
  const general = all.filter(n => n.page == null && visible(n)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const pins = numbered(d.id);
  const resolved = all.filter(n => n.resolved_at).length;
  const saveDraft = text => {
    const { page, x, y } = v.draft;
    v.draft = null;
    act(async () => { const r = await api('POST', `/docs/${d.id}/notes`, { text, page, x, y }); ui.docNote = r.id; });
  };
  const cancelDraft = () => { v.draft = null; render(); };

  return h('aside.dv-notes',
    h('div.dv-nh',
      h('b', 'Note'), h('span.muted', String(all.length - (ui.docShowResolved ? 0 : resolved))),
      h('span.grow'),
      resolved > 0 && h('button.chip', { class: ui.docShowResolved && 'on', onclick: () => { ui.docShowResolved = !ui.docShowResolved; render(); } },
        `risolte ${resolved}`)),
    v.draft && h('div.dnote.draft',
      h('div.dnote-h', h('span.dv-pin.mini.draft', '+'), h('span', v.kind === 'pdf' ? `Nuova nota a pag. ${v.draft.page}` : 'Nuova nota in questo punto')),
      h('textarea.dnote-edit', {
        rows: 3, placeholder: 'Cosa c\'è da ricordare qui? (Invio salva, Esc annulla)', 'data-fk': `draft-${d.id}`,
        oninput: autosize, onkeydown: enterSave(saveDraft, cancelDraft),
      }),
      h('div.dnote-a',
        h('button.btn.sm.primary', { onclick: ev => { const t = ev.target.closest('.dnote').querySelector('textarea').value.trim(); if (t) saveDraft(t); } }, 'Salva'),
        h('button.btn.sm.ghost', { onclick: cancelDraft }, 'Annulla'))),
    h('textarea.dv-general', {
      rows: 1, placeholder: 'Nota generale sul file… (Invio salva)', 'data-fk': `gnote-${d.id}`, oninput: autosize,
      onkeydown: enterSave((text, el) => { el.value = ''; act(() => api('POST', `/docs/${d.id}/notes`, { text })); }),
    }),
    general.map(n => noteCard(d, n)),
    pins.length > 0 && h('div.dv-sub', pinnable(v) ? 'Sul documento' : 'Posizionate'),
    pins.map(({ n, num }) => noteCard(d, n, num)),
    !all.length && !v.draft && h('p.muted.dv-empty', pinnable(v)
      ? 'Nessuna nota. Clicca su un punto del documento per lasciarne una lì, oppure scrivi una nota generale qui sopra.'
      : 'Nessuna nota. Scrivi qui sopra una nota sul file.'));
}

// ---------- vista ----------
export function viewDoc(id, query = {}) {
  const D = S.data;
  const d = D.docById.get(+id);
  if (!d) return h('div.empty', h('p', 'Documento non trovato (forse è nel cestino).'), h('a', { href: '#/magazzino' }, 'Torna al magazzino'));
  const it = D.itemById.get(d.item_id);
  const v = getViewer(d);
  // Link a una nota (?n=ID): la si seleziona e ci si scorre una volta sola, appena la nota è nei dati.
  const fromLink = query.n && +query.n;
  if (!fromLink) v.linkedNote = null;
  if (fromLink && v.linkedNote !== fromLink && notesOf(d.id).some(n => n.id === fromLink)) {
    v.linkedNote = fromLink;
    ui.docNote = fromLink;
    scrollToNote(v, fromLink);
  }
  const focus = document.body.classList.contains('doc-focus');
  return h('div.view.docview',
    h('div.head',
      h('a.icon-btn', { href: it ? `#/i/${it.id}` : '#/magazzino', title: 'Torna all\'articolo (Esc)' }, icon('back')),
      it && h('a.code', { href: `#/i/${it.id}`, ...itemAttrs(it) }, it.code),
      h('h2.dv-title', d.label || d.filename || d.url),
      docMeta(d),
      h('span.grow'),
      fileButtons(d),
      notesChip(d, v),
      focusChip(focus)),
    docBody(d, v));
}

// ---------- pezzi comuni a pagina singola e revisione ----------
// Tipo e versione modificabili anche dopo il caricamento (qui, nella scheda articolo e in Documenti).
export function docMeta(d) {
  const patch = f => act(() => api('PATCH', `/docs/${d.id}`, f));
  return h('span.docmeta',
    h('select.dk-sel', { class: `k-${d.kind}`, value: d.kind, title: 'Tipo di documento', onchange: ev => patch({ kind: ev.target.value }) },
      DOC_KINDS.map(k => h('option', { value: k }, k))),
    h('input.ver-in', {
      value: d.version || '', placeholder: 'versione', size: 7, title: 'Versione', 'data-fk': `dver-${d.id}`,
      onchange: ev => patch({ version: ev.target.value.trim() }),
      onkeydown: ev => { if (ev.key === 'Enter') ev.target.blur(); },
    }));
}

const fileButtons = d => (d.url
  ? h('a.icon-btn', { href: d.url, target: '_blank', rel: 'noopener noreferrer', title: `Apri il link originale: ${d.url}` }, icon('link'))
  : [
  h('a.icon-btn', { href: docFileUrl(d, { inline: true }), target: '_blank', rel: 'noopener', title: 'Apri il file originale' }, icon('link')),
  h('a.icon-btn', { href: docFileUrl(d), download: '', title: 'Scarica' }, icon('download')),
]);

const notesChip = (d, v) => h('button.chip', { class: notesShown(v) && 'on', onclick: () => toggleNotes(v), title: 'Mostra o nascondi le note' },
  icon('log'), `note ${notesOf(d.id).filter(visible).length}`);

const focusChip = focus => h('button.chip.only-desktop', {
  class: focus && 'on', onclick: () => setDocFocus(!focus), title: focus ? 'Torna alla vista normale (Esc)' : 'Usa tutta la finestra',
}, icon('cols'), focus ? 'riduci' : 'espandi');

// Corpo: anteprima (o messaggio per file senza anteprima) + note, e ripristino dello scorrimento dopo il riaggancio.
function docBody(d, v) {
  updatePins(v);
  const preview = v.kind === 'link'
    ? h('div.dv-main', h('div.empty', h('p', 'Documento esterno'), h('a.btn', { href: d.url, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), d.url)))
    : v.kind === 'none'
      ? h('div.dv-main', h('div.empty',
        h('p', 'Anteprima non disponibile per questo tipo di file.'),
        h('a.btn', { href: docFileUrl(d), download: '' }, icon('download'), `Scarica ${d.filename}`)))
      : v.el;
  // Il visualizzatore viene staccato e riattaccato: lo scorrimento va ripristinato dopo l'inserimento.
  queueMicrotask(() => {
    if (v.scroller.isConnected && Math.abs(v.scroller.scrollTop - v.scroll) > 1) {
      v.scroller.scrollTop = v.scroll;
      updatePageLabel(v);
    }
    applyPendingScroll(v);
    if (v.draft?.fresh) {
      v.draft.fresh = false;
      document.querySelector(`[data-fk="draft-${d.id}"]`)?.focus();
    }
  });
  const shown = notesShown(v);
  return h('div.dv', { class: shown ? null : 'no-notes' }, preview, shown && notesPanel(d, v));
}

// ---------- revisione affiancata ----------
const reviewHash = ids => (ids.length ? `#/review?d=${ids.join(',')}` : '#/documenti');

export function viewReview(_id, query = {}) {
  const D = S.data;
  const ids = [...new Set(String(query.d || '').split(',').map(Number))].filter(id => D.docById.has(id)).slice(0, 3);
  if (!ids.length) return h('div.empty', h('p', 'Nessun documento da rivedere.'), h('a', { href: '#/documenti' }, 'Scegli i documenti'));
  const focus = document.body.classList.contains('doc-focus');
  const addable = D.docs.filter(d => !ids.includes(d.id) && D.itemById.has(d.item_id));

  return h('div.view.review',
    h('div.head',
      h('a.icon-btn', { href: '#/documenti', title: 'Documenti (Esc)' }, icon('back')),
      h('h2.dv-title', 'Revisione'),
      h('span.muted', `${ids.length} documenti affiancati`),
      h('span.grow'),
      ids.length < 3 && addable.length > 0 && h('select.sm', {
        onchange: ev => { if (ev.target.value) location.hash = reviewHash([...ids, +ev.target.value]); },
      }, h('option', { value: '' }, '+ affianca un documento…'),
      addable.map(d => h('option', { value: d.id }, `${D.itemById.get(d.item_id).code} · ${d.label || d.filename || d.url}`))),
      focusChip(focus)),
    h('div.rv', { style: `--n:${ids.length}` }, ids.map(id => {
      const d = D.docById.get(id);
      const it = D.itemById.get(d.item_id);
      const v = getViewer(d);
      return h('section.rv-pane',
        h('div.rv-h',
          it && h('a.code', { href: `#/i/${it.id}`, ...itemAttrs(it) }, it.code),
          h('a.rv-title', { href: `#/d/${d.id}`, title: 'Apri da solo' }, d.label || d.filename || d.url),
          docMeta(d),
          h('span.grow'),
          notesChip(d, v),
          h('button.icon-btn.sm', { title: 'Togli dalla revisione', onclick: () => { location.hash = reviewHash(ids.filter(x => x !== id)); } }, icon('x'))),
        docBody(d, v));
    })));
}

// Esc dal visualizzatore: prima chiude la nota in preparazione.
export function docCancelDraft() {
  const v = [...viewers.values()].find(x => x.draft);
  if (!v) return false;
  v.draft = null;
  render();
  return true;
}
