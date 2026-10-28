// Visualizzatore di documenti con note: PDF (PDF.js), immagini e testo, più una barra laterale di note.
// Le note con pagina e coordinate (0..1) sono segnaposto su un punto del file; le altre sono note generali.
//
// L'app ridisegna le viste a ogni sincronizzazione: ridisegnare un PDF ogni volta sarebbe lento, quindi
// il visualizzatore (canvas compresi) resta in memoria e viene solo riagganciato; si aggiornano i segnaposto.
// Più visualizzatori possono essere aperti insieme (revisione affiancata, #/review?d=1,2,3).
import { backlinksBox } from './views.js';
import { h, icon, S, ui, api, act, render, richText, fmtTime, fmtSize, userName, toast, trashIt, autosize, itemAttrs, save, docFileUrl, dkAttrs, kindPicker, docName, renameDoc, can, roClass, isReadOnly } from './core.js';
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

// ---------- anteprima piccola (scheda al passaggio del mouse nella pagina Documenti) ----------
// PDF: la prima pagina disegnata una volta e tenuta in memoria; immagini: il file; testo: le prime righe.
const thumbs = new Map(); // "id:sha256" → Promise di un elemento
export function docThumb(d, width = 300) {
  const kind = kindOf(d);
  const key = `${d.id}:${d.sha256 || d.url}`;
  if (kind === 'image') return Promise.resolve(h('img.peek-img', { src: docFileUrl(d, { inline: true }), alt: '' }));
  if (kind === 'pdf' && !d.url && !thumbs.has(key)) {
    thumbs.set(key, (async () => {
      const pdfjs = await loadPdfjs();
      const task = pdfjs.getDocument({ url: docFileUrl(d, { inline: true }), withCredentials: true, disableRange: true, disableStream: true, standardFontDataUrl: `${PDFJS}standard_fonts/`, wasmUrl: `${PDFJS}wasm/` });
      try {
        const page = await (await task.promise).getPage(1);
        const vp = page.getViewport({ scale: (width / page.getViewport({ scale: 1 }).width) * (window.devicePixelRatio || 1) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        await page.render({ canvas, viewport: vp }).promise;
        return canvas.toDataURL('image/png');
      } finally {
        task.destroy().catch(() => {});
      }
    })().catch(() => null));
  }
  if (kind === 'pdf' && !d.url) return thumbs.get(key).then(src => src && h('img.peek-img.pdf', { src, alt: '' }));
  if (kind === 'text' && (d.size ?? 0) < TEXT_MAX) {
    if (!thumbs.has(key)) {
      thumbs.set(key, fetch(docFileUrl(d), { credentials: 'same-origin' }).then(r => (r.ok ? r.text() : '')).catch(() => ''));
    }
    return thumbs.get(key).then(t => t && h('pre.peek-text', t.split('\n').slice(0, 14).join('\n')));
  }
  return Promise.resolve(null);
}

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
      h('span.muted.dv-hint', pinnable(v) ? 'Clicca sul documento per aggiungere una nota in quel punto, trascina un segnaposto per spostarlo' : ''),
      searchable(v) && h('button.icon-btn', { title: `Cerca nel documento (${MOD}F)`, onclick: () => openSearch(v) }, icon('search'))),
    searchBar(v),
    v.scroller);
  v.el.addEventListener('pointerdown', () => { lastActive = v; });
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
    v.rawText = await r.text();
    v.pagesEl.replaceChildren(v.textEl = h('pre.dv-text', v.rawText));
    v.status = 'ready';
  } catch (e) {
    fail(v, `Impossibile leggere il file: ${e.message}`);
  }
}

function newPage(v, num, w, h0, extra) {
  const pins = h('div.dv-pins');
  const hits = h('div.dv-hits');
  const wrap = h('div.dv-page', { 'data-page': num, onclick: ev => clickPage(v, num, wrap, ev) });
  if (extra.img) wrap.append(extra.img);
  else wrap.append(extra.canvas = h('canvas'));
  wrap.append(hits, pins);
  v.pages.push({ num, w, h: h0, wrap, pins, hits, ...extra });
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

// ---------- ricerca nel documento (⌘F / Ctrl+F) ----------
// I PDF sono disegnati su canvas: la ricerca del browser non li vede. Il testo di ogni pagina si legge con
// PDF.js (una volta sola), i risultati sono riquadri sopra la pagina in percentuale (seguono lo zoom).
// Nei file di testo le occorrenze si evidenziano direttamente. Maiuscole e minuscole non contano.
const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl+';
const searchable = v => v.kind === 'pdf' || v.kind === 'text';
let lastActive = null; // nella revisione affiancata: il documento toccato per ultimo

function searchBar(v) {
  if (!searchable(v)) return null;
  const go = dir => { if (v.matches?.length) showMatch(v, (v.matchIndex + dir + v.matches.length) % v.matches.length); };
  v.searchInput = h('input.dv-search-in', {
    type: 'search', placeholder: 'Cerca nel documento…', autocomplete: 'off', spellcheck: 'false',
    oninput: () => { clearTimeout(v.searchTimer); v.searchTimer = setTimeout(() => runSearch(v), 180); },
    onkeydown: ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); go(ev.shiftKey ? -1 : 1); }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeSearch(v); }
    },
  });
  v.searchCount = h('span.muted.dv-search-n');
  v.searchBox = h('div.dv-search', { hidden: true },
    icon('search'), v.searchInput, v.searchCount,
    h('button.icon-btn.sm', { title: 'Precedente (Maiusc+Invio)', onclick: () => go(-1) }, '↑'),
    h('button.icon-btn.sm', { title: 'Successivo (Invio)', onclick: () => go(1) }, '↓'),
    h('button.icon-btn.sm', { title: 'Chiudi (Esc)', onclick: () => closeSearch(v) }, icon('x')));
  return v.searchBox;
}

function openSearch(v) {
  v.searchBox.hidden = false;
  v.searchInput.focus();
  v.searchInput.select();
}

function closeSearch(v) {
  v.searchBox.hidden = true;
  v.searchInput.value = '';
  v.matches = null;
  drawMatches(v);
  v.searchCount.textContent = '';
}

// Scorciatoia dalla tastiera: true se c'è un documento in cui cercare (altrimenti resta la ricerca del browser).
export function docSearchKey() {
  const open = wantedDocs().map(id => viewers.get(id)).filter(v => v && searchable(v));
  const v = open.includes(lastActive) ? lastActive : open[0];
  if (!v) return false;
  openSearch(v);
  return true;
}

// Testo di una pagina PDF con la posizione di ogni pezzo (coordinate della pagina a zoom 1).
async function pageText(p) {
  if (p.text) return p.text;
  const { Util } = await loadPdfjs();
  const vt = p.page.getViewport({ scale: 1 }).transform;
  const tc = await p.page.getTextContent();
  let str = '';
  const spans = [];
  for (const it of tc.items) {
    if (it.str) {
      const [, , c, d, e, f] = Util.transform(vt, it.transform);
      const size = Math.hypot(c, d) || it.height || 10;
      spans.push({ start: str.length, end: str.length + it.str.length, x: e, y: f - size * 0.95, w: it.width, h: size * 1.2 });
      str += it.str;
    }
    if (it.hasEOL) str += ' ';
  }
  p.text = { lower: str.toLowerCase(), spans };
  return p.text;
}

// Riquadri di un'occorrenza [from, to): uno per ogni pezzo di testo che tocca (anche su più righe).
function rectsOf(text, from, to) {
  return text.spans.filter(s => s.end > from && s.start < to).map(s => {
    const len = Math.max(1, s.end - s.start);
    const a = Math.max(from, s.start) - s.start;
    const b = Math.min(to, s.end) - s.start;
    return { x: s.x + (s.w * a) / len, y: s.y, w: (s.w * (b - a)) / len, h: s.h };
  });
}

async function runSearch(v) {
  const q = v.searchInput.value.trim().toLowerCase();
  const seq = (v.searchSeq = (v.searchSeq || 0) + 1);
  v.matches = [];
  if (!q) {
    drawMatches(v);
    v.searchCount.textContent = '';
    return;
  }
  if (v.kind === 'text') {
    const lower = (v.rawText || '').toLowerCase();
    for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) v.matches.push({ from: i, to: i + q.length });
  } else {
    v.searchCount.textContent = 'cerco…';
    for (const p of v.pages) {
      const text = await pageText(p);
      if (seq !== v.searchSeq) return; // nel frattempo si è scritto altro
      for (let i = text.lower.indexOf(q); i >= 0; i = text.lower.indexOf(q, i + q.length)) {
        v.matches.push({ page: p.num, rects: rectsOf(text, i, i + q.length) });
      }
    }
  }
  if (!v.matches.length) {
    drawMatches(v);
    v.searchCount.textContent = 'nessun risultato';
    return;
  }
  // Si parte dal primo risultato dalla pagina che si sta guardando in poi.
  const here = v.kind === 'pdf' ? currentPage(v) : 1;
  const first = v.matches.findIndex(m => (m.page ?? 1) >= here);
  showMatch(v, Math.max(0, first));
}

function currentPage(v) {
  const mid = v.scroller.scrollTop + v.scroller.clientHeight / 2;
  return (v.pages.find(x => x.wrap.offsetTop + x.wrap.offsetHeight > mid) || v.pages.at(-1))?.num ?? 1;
}

function showMatch(v, i) {
  v.matchIndex = i;
  v.searchCount.textContent = `${i + 1} / ${v.matches.length}`;
  drawMatches(v);
  const m = v.matches[i];
  if (v.kind === 'text') {
    v.textEl.querySelector('mark.on')?.scrollIntoView({ block: 'center' });
    return;
  }
  const p = v.pages[m.page - 1];
  const r = m.rects[0];
  if (!r) return;
  const y = p.wrap.offsetTop + (r.y / p.h) * p.wrap.offsetHeight;
  const x = p.wrap.offsetLeft + (r.x / p.w) * p.wrap.offsetWidth;
  v.scroller.scrollTop = y - v.scroller.clientHeight * 0.35;
  if (x < v.scroller.scrollLeft || x > v.scroller.scrollLeft + v.scroller.clientWidth - 40) v.scroller.scrollLeft = x - 40;
}

function drawMatches(v) {
  if (v.kind === 'text') {
    if (!v.textEl) return;
    const parts = [];
    let last = 0;
    (v.matches || []).forEach((m, i) => {
      parts.push(v.rawText.slice(last, m.from), h('mark', { class: i === v.matchIndex ? 'on' : null }, v.rawText.slice(m.from, m.to)));
      last = m.to;
    });
    parts.push(v.rawText.slice(last));
    v.textEl.replaceChildren(...parts);
    return;
  }
  for (const p of v.pages) p.hits.replaceChildren();
  (v.matches || []).forEach((m, i) => {
    const p = v.pages[m.page - 1];
    for (const r of m.rects) {
      p.hits.append(h('div.dv-hit', {
        class: i === v.matchIndex ? 'on' : null,
        style: `left:${(r.x / p.w) * 100}%;top:${(r.y / p.h) * 100}%;width:${(r.w / p.w) * 100}%;height:${(r.h / p.h) * 100}%`,
      }));
    }
  });
}

function clickPage(v, num, wrap, ev) {
  if (isReadOnly(wrap)) return; // in sola lettura non si aggiungono note
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
  if (!pinnable(v) || v.status !== 'ready' || v.dragging) return; // durante un trascinamento non si ridisegna
  const list = numbered(v.id);
  for (const p of v.pages) {
    const pins = list.filter(x => x.n.page === p.num).map(({ n, num }) => pinDrag(v, n, h('button.dv-pin', {
      class: [ui.docNote === n.id && 'on', n.resolved_at && 'resolved'].filter(Boolean).join(' ') || null,
      style: `left:${n.x * 100}%;top:${n.y * 100}%`,
      title: `${n.text}\n(trascina per spostare)`,
      onclick: ev => {
        ev.stopPropagation();
        if (ev.currentTarget.dragged) return; // fine di un trascinamento, non un clic
        openNotes(v);
        selectNote(n.id, false);
      },
    }, num)));
    if (v.draft?.page === p.num) pins.push(h('span.dv-pin.draft', { style: `left:${v.draft.x * 100}%;top:${v.draft.y * 100}%` }, '+'));
    p.pins.replaceChildren(...pins);
  }
}

// Segnaposto trascinabili: si spostano nel punto giusto, anche su un'altra pagina; vicino ai bordi il
// documento scorre. Al rilascio si salva la nuova posizione; un clic senza movimento seleziona la nota.
function pinDrag(v, n, pin) {
  pin.addEventListener('pointerdown', ev => {
    if (ev.button !== 0 || isReadOnly(pin)) return; // in sola lettura un clic seleziona e basta
    ev.stopPropagation();
    ev.preventDefault();
    pin.dragged = false;
    const r0 = pin.closest('.dv-page').getBoundingClientRect();
    // Distanza tra il puntatore e la punta del segnaposto (il punto salvato), mantenuta durante il trascinamento.
    const off = { x: ev.clientX - (r0.left + n.x * r0.width), y: ev.clientY - (r0.top + n.y * r0.height) };
    const start = { x: ev.clientX, y: ev.clientY };
    let target = null;
    pin.setPointerCapture(ev.pointerId);
    const move = e => {
      if (!pin.dragged && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
      pin.dragged = true;
      v.dragging = true;
      pin.classList.add('dragging');
      const sr = v.scroller.getBoundingClientRect();
      if (e.clientY < sr.top + 40) v.scroller.scrollTop -= 14;
      else if (e.clientY > sr.bottom - 40) v.scroller.scrollTop += 14;
      const ax = e.clientX - off.x;
      const ay = e.clientY - off.y;
      // La pagina sotto la punta (o la più vicina, negli spazi tra le pagine).
      const dist = p => { const r = p.wrap.getBoundingClientRect(); return ay < r.top ? r.top - ay : ay > r.bottom ? ay - r.bottom : 0; };
      const p = v.pages.reduce((a, b) => (dist(b) < dist(a) ? b : a));
      const r = p.wrap.getBoundingClientRect();
      const clamp = x => Math.min(1, Math.max(0, x));
      target = { page: p.num, x: clamp((ax - r.left) / r.width), y: clamp((ay - r.top) / r.height) };
      if (pin.parentElement !== p.pins) p.pins.append(pin);
      pin.style.left = `${target.x * 100}%`;
      pin.style.top = `${target.y * 100}%`;
    };
    const end = () => {
      pin.removeEventListener('pointermove', move);
      pin.removeEventListener('pointerup', end);
      pin.removeEventListener('pointercancel', end);
      pin.classList.remove('dragging');
      v.dragging = false;
      if (!pin.dragged || !target) return;
      Object.assign(n, target); // subito al suo posto, il server conferma con la sincronizzazione
      act(() => api('PATCH', `/doc-notes/${n.id}`, target));
      setTimeout(() => { pin.dragged = false; }, 0); // il click che segue il rilascio va ignorato
    };
    pin.addEventListener('pointermove', move);
    pin.addEventListener('pointerup', end);
    pin.addEventListener('pointercancel', end);
  });
  return pin;
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
    ? h('textarea.dnote-edit', { 'data-ac': 'text', 'data-ac-only': '#',
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
      h('textarea.dnote-edit', { 'data-ac': 'text', 'data-ac-only': '#',
        rows: 3, placeholder: 'Cosa c\'è da ricordare qui? (Invio salva, Esc annulla)', 'data-fk': `draft-${d.id}`,
        oninput: autosize, onkeydown: enterSave(saveDraft, cancelDraft),
      }),
      h('div.dnote-a',
        h('button.btn.sm.primary', { onclick: ev => { const t = ev.target.closest('.dnote').querySelector('textarea').value.trim(); if (t) saveDraft(t); } }, 'Salva'),
        h('button.btn.sm.ghost', { onclick: cancelDraft }, 'Annulla'))),
    h('textarea.dv-general', { 'data-ac': 'text', 'data-ac-only': '#',
      rows: 1, placeholder: 'Nota generale sul file… (Invio salva)', 'data-fk': `gnote-${d.id}`, oninput: autosize,
      onkeydown: enterSave((text, el) => { el.value = ''; act(() => api('POST', `/docs/${d.id}/notes`, { text })); }),
    }),
    general.map(n => noteCard(d, n)),
    pins.length > 0 && h('div.dv-sub', pinnable(v) ? 'Sul documento' : 'Posizionate'),
    pins.map(({ n, num }) => noteCard(d, n, num)),
    !all.length && !v.draft && h('p.muted.dv-empty', pinnable(v)
      ? 'Nessuna nota. Clicca su un punto del documento per lasciarne una lì, oppure scrivi una nota generale qui sopra.'
      : 'Nessuna nota. Scrivi qui sopra una nota sul file.'),
    // Mail (da mandare e mandate) che lo allegano o lo collegano, e le altre voci che lo citano.
    backlinksBox('doc', d.id, { title: 'Collegato in', compact: true }));
}

// Scheda al passaggio del mouse: tipo, nome, articolo, versione e un'anteprima piccola del file.
export function docPeek(d) {
  const D = S.data;
  const it = D.itemById.get(d.item_id);
  const n = notesOf(d.id).filter(x => !x.resolved_at).length;
  const thumb = h('div.peek-thumb', h('span.muted', d.url ? '' : 'Anteprima…'));
  docThumb(d).then(el => thumb.replaceChildren(el || h('span.muted', d.url ? d.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60) : 'Nessuna anteprima per questo file')));
  return [
    h('div.peek-h', h('span.dk', dkAttrs(d.kind), d.kind), it && h('span.code', itemAttrs(it), it.code)),
    h('div.peek-name', docName(d)),
    h('div.peek-grid',
      d.version && h('div.peek-r', h('span.muted', 'Versione'), h('span.mono', d.version)),
      d.filename && d.label && h('div.peek-r', h('span.muted', 'File'), h('span', d.filename)),
      d.size != null && h('div.peek-r', h('span.muted', 'Dimensione'), h('span', fmtSize(d.size))),
      h('div.peek-r', h('span.muted', 'Caricato'), h('span', fmtTime(d.created_at))),
      n > 0 && h('div.peek-r', h('span.muted', 'Note aperte'), h('span', String(n)))),
    thumb,
  ];
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
  return h('div.view.docview', { class: roClass(can('documenti', 'write')) },
    h('div.head',
      h('a.icon-btn', { href: it ? `#/i/${it.id}` : '#/magazzino', title: 'Torna all\'articolo (Esc)' }, icon('back')),
      it && h('a.code', { href: `#/i/${it.id}`, ...itemAttrs(it) }, it.code),
      // Il titolo si modifica direttamente: diventa il nome del documento nell'app (il file resta com'è).
      h('input.h-title.dv-title-in', {
        value: docName(d), title: d.filename ? `File: ${d.filename}` : d.url, 'data-fk': `dname-${d.id}`,
        onchange: ev => act(() => api('PATCH', `/docs/${d.id}`, { label: ev.target.value.trim() })),
        onkeydown: ev => { if (ev.key === 'Enter') ev.target.blur(); },
      }),
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
    kindPicker(d.kind, kind => patch({ kind })),
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

  return h('div.view.review', { class: roClass(can('documenti', 'write')) },
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
          h('a.rv-title', { href: `#/d/${d.id}`, title: 'Apri da solo' }, docName(d)),
          h('button.icon-btn.sm', { title: 'Rinomina', onclick: () => renameDoc(d) }, icon('edit')),
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
