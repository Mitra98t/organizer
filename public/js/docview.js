// Document viewer with notes: PDF (PDF.js), images, DXF drawings (cad.js, as images), text, tables, 3D models
// (model3d.js) and web pages of links (web.js), plus a side bar of notes.
// Notes with a page and coordinates (0..1) are pins on a point of the file (in 3D models also z, page = 1); the
// others are general notes.
//
// The app redraws the views at every sync: redrawing a PDF every time would be slow, so the viewer (canvases
// included) stays in memory and is only re-attached; the pins are updated.
// Several viewers can be open together (side-by-side review, #/review?d=1,2,3).
import { backlinksBox } from './views.js';
import { h, icon, S, ui, api, act, render, richText, mdText, fmtTime, fmtSize, userName, toast, trashIt, autosize, itemAttrs, save, docFileUrl, dkAttrs, kindLabel, kindPicker, docName, renameDoc, can, roClass, isReadOnly, shareBox, askConfirm} from './core.js';
import { moveDoc } from './pickers.js';
import { today } from './parse.js';
import { tr, trn } from './i18n.js';
import { WEB_W, checkPage, webFrame, pageInfo, placeOver, unplace } from './web.js';

const PDFJS = new URL('../vendor/pdfjs/', import.meta.url).href;
// PDF.js resources: standard fonts, character maps (cMaps: without them, text in Asian fonts, frequent in
// datasheets, cannot be read), colour profiles and image decoders.
const PDF_RES = { standardFontDataUrl: `${PDFJS}standard_fonts/`, cMapUrl: `${PDFJS}cmaps/`, cMapPacked: true, iccUrl: `${PDFJS}iccs/`, wasmUrl: `${PDFJS}wasm/` };
const TEXT_MAX = 512 * 1024;
const TABLE_MAX = 8 * 1024 * 1024;
const TABLE_ROWS = 5000; // beyond that, the rest is read by downloading the file
const TABLE_EXT = /\.(csv|tsv|scsv)$/i;
let pdfjsLib = null;
const viewers = new Map(); // document id → open viewer

function loadPdfjs() {
  pdfjsLib ||= import('../vendor/pdfjs/pdf.min.mjs').then(m => {
    m.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.mjs`;
    return m;
  });
  return pdfjsLib;
}

// Links pointing to a PDF: loaded live through the server (see server/remote.js).
// A document's file; for the preview of an attachment (d.blob) it is already here (and the CSP does not allow reading blob:).
const fileOf = d => (d.blob ? Promise.resolve(new Response(d.blob)) : fetch(docFileUrl(d), { credentials: 'same-origin' }));
const isPdfLink = d => d.url && /\.pdf$/i.test((() => { try { return new URL(d.url).pathname; } catch { return ''; } })());

const MODEL_EXT = /\.(stl|3mf|stp|step)$/i;
const CAD_MAX = 40 * 1024 * 1024;

export function kindOf(d) {
  if (isPdfLink(d)) return 'pdf';
  if (d.url) return 'web';
  if (MODEL_EXT.test(d.filename || '')) return 'model';
  if (/\.dxf$/i.test(d.filename || '')) return 'cad';
  if (d.mime === 'application/pdf' || /\.pdf$/i.test(d.filename || '')) return 'pdf';
  if (/^image\/(png|jpeg|gif|webp)$/.test(d.mime || '')) return 'image';
  if (TABLE_EXT.test(d.filename || '') || d.mime === 'text/csv' || d.mime === 'text/tab-separated-values') return 'table';
  if (/^text\//.test(d.mime || '') || /\.(txt|log|md|ini|cfg|json|ya?ml|h|c|cpp|py|sh)$/i.test(d.filename || '')) return 'text';
  return 'none';
}

const pinnable = v => v.kind === 'pdf' || v.kind === 'image' || v.kind === 'cad' || v.kind === 'model' || v.kind === 'web';

// ---------- small preview (card on hover in the Documents page) ----------
// PDF: the first page drawn once and kept in memory; images: the file; text: the first lines.
const thumbs = new Map(); // "id:sha256" → Promise of an element
export function docThumb(d, width = 300) {
  const kind = kindOf(d);
  const key = `${d.id}:${d.sha256 || d.url}`;
  if (kind === 'image') return Promise.resolve(h('img.peek-img', { src: docFileUrl(d, { inline: true }), alt: '' }));
  if (kind === 'cad' && (d.size ?? 0) < CAD_MAX) {
    if (!thumbs.has(key)) thumbs.set(key, cadImage(d).then(x => x.url).catch(() => null));
    return thumbs.get(key).then(src => src && h('img.peek-img.cad', { src, alt: '' }));
  }
  if (kind === 'pdf' && !d.url && !thumbs.has(key)) {
    thumbs.set(key, (async () => {
      const pdfjs = await loadPdfjs();
      const task = pdfjs.getDocument({ url: docFileUrl(d, { inline: true }), withCredentials: true, disableRange: true, disableStream: true, ...PDF_RES });
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
      thumbs.set(key, fileOf(d).then(r => (r.ok ? r.text() : '')).catch(() => ''));
    }
    return thumbs.get(key).then(t => t && h('pre.peek-text', t.split('\n').slice(0, 14).join('\n')));
  }
  if (kind === 'table' && (d.size ?? 0) < TABLE_MAX) {
    if (!thumbs.has(key)) thumbs.set(key, fetchText(d).catch(() => ''));
    return thumbs.get(key).then(t => {
      const rows = t && parseCsv(t, d.filename, 12);
      return rows?.length ? h('div.peek-table', csvTable(rows.map(r => r.slice(0, 6))).table) : null;
    });
  }
  return Promise.resolve(null);
}

// ---------- viewer (persistent) ----------
function getViewer(d) {
  if (viewers.has(d.id)) return viewers.get(d.id);
  const v = { id: d.id, kind: kindOf(d), preview: !!d.src, zoom: 1, scroll: 0, pages: [], draft: null, status: 'loading' };
  v.scroller = h(`div.dv-scroll${v.kind === 'model' || v.kind === 'table' || v.kind === 'web' ? `.${v.kind}` : ''}`, { onscroll: () => { v.scroll = v.scroller.scrollTop; updatePageLabel(v); } });
  v.pagesEl = h('div.dv-pages');
  v.scroller.append(v.pagesEl);
  v.pageLabel = h('span.dv-pl');
  v.el = h('div.dv-main',
    h('div.dv-toolbar',
      v.kind === 'model' && h('button.btn.sm.ghost', { onclick: () => v.stage?.reset() }, tr('Initial view')),
      v.kind !== 'model' && pinnable(v) && [
        h('button.icon-btn', { title: tr('Zoom out'), onclick: () => setZoom(v, v.zoom / 1.25) }, '−'),
        v.zoomLabel = h('span.dv-zoom', '100%'),
        h('button.icon-btn', { title: tr('Zoom in'), onclick: () => setZoom(v, v.zoom * 1.25) }, '+'),
        h('button.btn.sm.ghost', { onclick: () => setZoom(v, 1) }, tr('Fit')),
        v.pageLabel,
      ],
      v.kind === 'web' && [
        v.savedLabel = h('span.muted.dv-saved'),
        h('button.btn.sm.ghost', { title: tr('Download the page again from the site'), onclick: () => refreshWeb(v) }, icon('restore'), tr('Update')),
      ],
      h('span.grow'),
      h('span.muted.dv-hint', v.preview ? '' : v.kind === 'model'
        ? tr('Drag to rotate, right button to pan, wheel to zoom. Click on the model for a note at that point')
        : v.kind === 'pdf' ? tr('Click for a note at that point or select some text for a note on that text; drag a pin to move it')
          : pinnable(v) ? tr('Click on the document to add a note at that point, drag a pin to move it') : ''),
      searchable(v) && h('button.icon-btn', { title: tr('Search in the document ({key}F)', { key: MOD }), onclick: () => openSearch(v) }, icon('search'))),
    searchBar(v),
    // Web page: the scrolling box stays out of the view (see web.js), here only its space.
    v.kind === 'web' ? (v.slot = h('div.dv-scroll.web-slot')) : v.scroller,
    v.kind === 'pdf' && (v.selBtn = h('button.btn.sm.primary.dv-selbtn', {
      hidden: true,
      onpointerdown: ev => ev.preventDefault(), // the selection must stay
      onclick: () => { const sel = selectionIn(v); if (sel) textDraft(v, sel); },
    }, icon('log'), tr('Note on the text'))));
  for (const el of [v.el, v.scroller]) el.addEventListener('pointerdown', ev => { lastActive = v; v.pointer = ev.pointerType; });
  if (v.kind === 'web') placeOver(v.scroller, v.slot);
  if (v.kind === 'pdf') v.pagesEl.addEventListener('pointerup', ev => textPointerUp(v, ev));
  if (v.kind !== 'model' && pinnable(v)) pinchZoom(v);
  v.resize = new ResizeObserver(() => { clearTimeout(v.rt); v.rt = setTimeout(() => layout(v), 120); });
  v.resize.observe(v.scroller);
  viewers.set(d.id, v);
  if (v.kind === 'pdf') openPdf(v, d);
  else if (v.kind === 'image') openImage(v, d);
  else if (v.kind === 'cad') openCad(v, d);
  else if (v.kind === 'text') openText(v, d);
  else if (v.kind === 'table') openTable(v, d);
  else if (v.kind === 'model') openModel(v, d);
  else if (v.kind === 'web') openWeb(v, d);
  else v.status = 'ready';
  return v;
}

// In PDF.js 6 the document is closed from the "loading task" (the document proxy no longer has destroy()).
const closePdf = v => v.task?.destroy().catch(() => {});

function destroyViewer(v) {
  v.resize.disconnect();
  v.io?.disconnect();
  v.stage?.dispose();
  if (v.blobUrl) URL.revokeObjectURL(v.blobUrl);
  closePdf(v);
  v.webObs?.disconnect();
  if (v.kind === 'web') unplace(v.scroller);
  viewers.delete(v.id);
}

// Documents requested by the current page: those no longer shown are closed.
function wantedDocs() {
  const att = location.hash.match(/^#\/allegato\/(\d+)\?n=(\d+)/);
  if (att) return [`att:${att[1]}:${att[2]}`];
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
    d?.url && h('a.btn', { href: d.url, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), tr('Open the original link'))));
}

async function openPdf(v, d) {
  v.pagesEl.replaceChildren(h('div.empty', tr('Loading the PDF…')));
  try {
    const pdfjs = v.pdfjs = await loadPdfjs();
    // PDF from a link: the server downloads it; the answer is read first to show the reason of an error.
    let data;
    if (d.blob) data = new Uint8Array(await d.blob.arrayBuffer()); // attachment preview: PDF.js does not read blob:
    else if (d.url) {
      v.pagesEl.replaceChildren(h('div.empty', tr('Downloading the PDF from the link…')));
      const r = await fetch(`api/docs/${d.id}/remote`, { credentials: 'same-origin' });
      if (!r.ok) return fail(v, (await r.json().catch(() => null))?.error || tr('Error {status}', { status: r.status }));
      data = new Uint8Array(await r.arrayBuffer());
    }
    v.task = pdfjs.getDocument({
      ...(data ? { data } : { url: docFileUrl(d, { inline: true }) }),
      withCredentials: true,
      ...PDF_RES,
      disableRange: true,
      disableStream: true,
    });
    v.pdf = await v.task.promise;
    if (viewers.get(v.id) !== v) return closePdf(v); // the document was closed meanwhile
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
    fail(v, tr('Cannot open the PDF: {error}', { error: e.message }));
  }
}

function openImage(v, d) {
  const img = h('img.dv-img', { src: docFileUrl(d, { inline: true }), alt: d.filename || '', draggable: 'false' });
  img.onload = () => {
    const wrap = newPage(v, 1, img.naturalWidth, img.naturalHeight, { img });
    v.pagesEl.replaceChildren(wrap);
    ready(v);
  };
  img.onerror = () => fail(v, tr('Cannot load the image'));
}

// Web page (link document): the saved copy of the page, drawn WEB_W px wide and as tall as its content, then shrunk
// to the space like a PDF page. The frame does not take the clicks (they make notes); its height is measured again
// while the images arrive.
const WEB_MAX_H = 60000;
async function openWeb(v, d) {
  v.pagesEl.replaceChildren(h('div.empty', tr('Loading the page…')));
  v.src = `api/docs/${d.id}/page`;
  try {
    await checkPage(v.src);
  } catch (e) {
    return viewers.get(v.id) === v && fail(v, tr('Cannot show the page: {error}', { error: e.message }));
  }
  if (viewers.get(v.id) !== v) return;
  const frame = webFrame(v.src);
  const wrap = newPage(v, 1, WEB_W, 900, { frame });
  wrap.classList.add('web');
  frame.addEventListener('load', () => webLoaded(v, frame));
  v.pagesEl.replaceChildren(wrap);
}

function webLoaded(v, frame) {
  const doc = frame.contentDocument;
  if (!doc?.documentElement) return fail(v, tr('Cannot show the page'));
  doc.head?.append(Object.assign(doc.createElement('style'), { textContent: 'html{scrollbar-width:none}html::-webkit-scrollbar{display:none}' }));
  const info = pageInfo(frame);
  if (v.savedLabel) {
    v.savedLabel.textContent = info.saved ? tr('copy of {date}', { date: fmtTime(info.saved) }) : '';
    v.savedLabel.title = info.url;
  }
  const p = v.pages[0];
  const measure = () => {
    const H = Math.min(WEB_MAX_H, Math.max(200, doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0));
    if (Math.abs(H - p.h) < 2 && frame.style.height) return;
    p.h = H;
    frame.style.height = `${H}px`;
    layout(v);
  };
  frame.style.height = '900px'; // the window the page is drawn for, then as tall as the content
  measure();
  v.webObs?.disconnect();
  v.webObs = new ResizeObserver(() => measure());
  v.webObs.observe(doc.documentElement);
  setTimeout(() => v.webObs?.disconnect(), 20000); // then the page stays still (the notes are fractions of its height)
  if (v.status !== 'ready') ready(v);
  else updatePins(v);
}

async function refreshWeb(v) {
  if (!await askConfirm(tr('Download the page again from the site? The notes stay at the same point of the page, which may have changed.'), { ok: tr('Update') })) return;
  const frame = v.pages[0]?.frame;
  const r = await act(() => api('POST', `/docs/${v.id}/page`));
  if (!r) return;
  if (frame) frame.src = `${v.src}?t=${Date.now()}`;
  else openWeb(v, S.data.docById.get(v.id));
}

// DXF: the drawing becomes an SVG image (cad.js) and from then on it is an image like the others.
async function cadImage(d) {
  const [cad, text] = await Promise.all([
    import('./cad.js'),
    fileOf(d).then(r => {
      if (!r.ok) throw new Error(tr('error {status}', { status: r.status }));
      return r.text();
    }),
  ]);
  return cad.dxfImage(text);
}

async function openCad(v, d) {
  if (d.size > CAD_MAX) return fail(v, tr('Drawing too large for the preview ({size}): download it.', { size: fmtSize(d.size) }));
  v.pagesEl.replaceChildren(h('div.empty', tr('Drawing the DXF…')));
  try {
    const { url, width, height } = await cadImage(d);
    if (viewers.get(v.id) !== v) return URL.revokeObjectURL(url);
    v.blobUrl = url;
    const img = h('img.dv-img.dv-cad', { src: url, alt: d.filename || '', draggable: 'false' });
    v.pagesEl.replaceChildren(newPage(v, 1, width, height, { img }));
    ready(v);
  } catch (e) {
    console.warn(e);
    fail(v, tr('Cannot read the DXF: {error}', { error: e.message }));
  }
}

async function openText(v, d) {
  if (d.size > TEXT_MAX) return fail(v, tr('Text file too large for the preview ({size}): download it.', { size: fmtSize(d.size) }));
  try {
    const r = await fileOf(d);
    if (!r.ok) throw new Error(tr('error {status}', { status: r.status }));
    v.rawText = await r.text();
    v.pagesEl.replaceChildren(v.textEl = h('pre.dv-text', v.rawText));
    v.status = 'ready';
  } catch (e) {
    fail(v, tr('Cannot read the file: {error}', { error: e.message }));
  }
}

// ---------- tables (CSV, TSV) ----------
// The file as text: UTF-8, or Windows-1252 if it is not (CSVs saved by Excel).
async function fetchText(d) {
  const r = await fileOf(d);
  if (!r.ok) throw new Error(tr('error {status}', { status: r.status }));
  const buf = await r.arrayBuffer();
  let t;
  try { t = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { t = new TextDecoder('windows-1252').decode(buf); }
  return t.replace(/^\uFEFF/, '');
}

// Separator: tab for .tsv, ";" for .scsv, otherwise the one appearing most in the first line (outside quotes) among
// , ; tab and |. Quotes follow RFC 4180: "" inside a field is a quote.
function parseCsv(text, filename = '', limit = Infinity) {
  let sep = /\.tsv$/i.test(filename) ? '\t' : /\.scsv$/i.test(filename) ? ';' : null;
  if (!sep) {
    const first = text.slice(0, text.search(/\r?\n|$/)).replace(/"[^"]*"/g, '');
    sep = [',', ';', '\t', '|'].map(c => [c, first.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  }
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length && rows.length < limit; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if ((cell || row.length) && rows.length < limit) { row.push(cell); rows.push(row); }
  return rows;
}

// First row as the header (it stays in view while scrolling), zebra rows, row number on the left. The table is as
// wide as its columns: with many columns it scrolls sideways and the row number stays in view.
function csvTable(rows) {
  const cols = Math.max(...rows.map(r => r.length));
  const pad = r => [...r, ...Array(cols - r.length).fill('')];
  const cells = [];
  const tr = (r, i, tag) => {
    // The text sits in a div: it is the one with the maximum width (on table cells it is not reliable).
    const divs = pad(r).map(x => h('div.c', x));
    cells.push(divs);
    return h('tr', h(`${tag}.n`, i || ''), ...divs.map(d => h(tag, d)));
  };
  const [head, ...body] = rows;
  const table = h('table.dv-table', h('thead', tr(head, 0, 'th')), h('tbody', body.map((r, i) => tr(r, i + 1, 'td'))));
  return { table, cells };
}

async function openTable(v, d) {
  if (d.size > TABLE_MAX) return fail(v, tr('Table too large for the preview ({size}): download it.', { size: fmtSize(d.size) }));
  try {
    const text = await fetchText(d);
    const all = parseCsv(text, d.filename, TABLE_ROWS + 2);
    if (!all.length) return fail(v, tr('The file is empty.'));
    v.rows = all.slice(0, TABLE_ROWS + 1);
    const { table, cells } = csvTable(v.rows);
    v.cells = cells;
    v.textEl = table;
    v.pagesEl.replaceChildren(h('div.dv-table-wrap', table,
      all.length > v.rows.length && h('p.muted.dv-table-more', tr('Showing the first {n} rows: download the file to see them all.', { n: TABLE_ROWS }))));
    v.status = 'ready';
  } catch (e) {
    fail(v, tr('Cannot read the file: {error}', { error: e.message }));
  }
}

// ---------- 3D models ----------
// A click (without dragging: dragging rotates the view) on a point of the model prepares a note there.
async function openModel(v, d) {
  const status = msg => v.pagesEl.replaceChildren(h('div.empty', msg));
  status(tr('Loading the model…'));
  try {
    const [m3, buf] = await Promise.all([
      import('./model3d.js'),
      fileOf(d).then(r => {
        if (!r.ok) throw new Error(tr('error {status}', { status: r.status }));
        return r.arrayBuffer();
      }),
    ]);
    const obj = await m3.parseModel(buf, d.filename, status);
    if (viewers.get(v.id) !== v) return; // the document was closed meanwhile
    v.pins3d = h('div.dv-pins');
    v.stageEl = h('div.dv-model', { onpointerdown: ev => { v.down = { x: ev.clientX, y: ev.clientY, b: ev.button }; } });
    v.stageEl.addEventListener('pointerup', ev => clickModel(v, ev));
    v.pagesEl.replaceChildren(v.stageEl);
    v.stage = m3.createStage(v.stageEl, settled => updatePins3d(v, settled));
    v.stageEl.append(v.pins3d);
    v.stage.setModel(obj);
    ready(v);
  } catch (e) {
    console.warn(e);
    fail(v, tr('Cannot open the model: {error}', { error: e.message }));
  }
}

function clickModel(v, ev) {
  const down = v.down;
  v.down = null;
  if (!down || down.b !== 0 || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 4) return;
  if (isReadOnly(v.stageEl) || ev.target.closest('.dv-pin')) return;
  const p = v.stage.pick(ev.clientX, ev.clientY);
  if (!p) return; // click outside the model
  for (const o of viewers.values()) o.draft = null;
  v.draft = { page: 1, ...p, fresh: true };
  openNotes(v);
  ui.docNote = null;
  render();
}

// Pins projected on the screen at every movement of the view; those hidden by the model (computed with the view at
// rest, it is the slowest calculation) stay visible but faded.
function updatePins3d(v, settled) {
  if (!v.stage || v.dragging) return;
  const list = numbered(v.id);
  if (settled || !v.hiddenPins) v.hiddenPins = new Set(list.filter(({ n }) => v.stage.hidden(n)).map(({ n }) => n.id));
  const place = (el, p) => {
    const s = v.stage.toScreen(p);
    el.style.left = `${s.left}px`;
    el.style.top = `${s.top}px`;
    el.hidden = s.behind;
    return el;
  };
  const pins = list.map(({ n, num }) => place(pinDrag3d(v, n, h('button.dv-pin', {
    class: [ui.docNote === n.id && 'on', n.resolved_at && 'resolved', v.hiddenPins.has(n.id) && 'back'].filter(Boolean).join(' ') || null,
    title: `${n.text}\n${tr('(drag to move)')}`,
    onclick: ev => {
      ev.stopPropagation();
      if (ev.currentTarget.dragged) return;
      openNotes(v);
      selectNote(n.id, false);
    },
  }, num)), n));
  if (v.draft) pins.push(place(h('span.dv-pin.draft', '+'), v.draft));
  v.pins3d.replaceChildren(...pins);
}

// Like pinDrag, but the pin slides on the model's surface (outside the model it stays where it was).
function pinDrag3d(v, n, pin) {
  pin.addEventListener('pointerdown', ev => {
    if (ev.button !== 0 || isReadOnly(pin)) return;
    ev.stopPropagation();
    ev.preventDefault();
    pin.dragged = false;
    const tip = v.stage.toScreen(n);
    const r0 = v.stageEl.getBoundingClientRect();
    const off = { x: ev.clientX - (r0.left + tip.left), y: ev.clientY - (r0.top + tip.top) };
    const start = { x: ev.clientX, y: ev.clientY };
    let target = null;
    pin.setPointerCapture(ev.pointerId);
    const move = e => {
      if (!pin.dragged && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
      pin.dragged = true;
      v.dragging = true;
      pin.classList.add('dragging');
      pin.classList.remove('back');
      const p = v.stage.pick(e.clientX - off.x, e.clientY - off.y);
      if (!p) return;
      target = { page: 1, ...p };
      const s = v.stage.toScreen(target);
      pin.style.left = `${s.left}px`;
      pin.style.top = `${s.top}px`;
    };
    const end = () => {
      pin.removeEventListener('pointermove', move);
      pin.removeEventListener('pointerup', end);
      pin.removeEventListener('pointercancel', end);
      pin.classList.remove('dragging');
      v.dragging = false;
      if (!pin.dragged || !target) return;
      Object.assign(n, target);
      v.hiddenPins = null;
      act(() => api('PATCH', `/doc-notes/${n.id}`, target));
      setTimeout(() => { pin.dragged = false; }, 0);
    };
    pin.addEventListener('pointermove', move);
    pin.addEventListener('pointerup', end);
    pin.addEventListener('pointercancel', end);
  });
  return pin;
}

function newPage(v, num, w, h0, extra) {
  const pins = h('div.dv-pins');
  const hits = h('div.dv-hits');
  const marks = h('div.dv-marks');
  const wrap = h('div.dv-page', { 'data-page': num, onclick: ev => clickPage(v, num, wrap, ev) });
  if (extra.img) wrap.append(extra.img);
  else if (extra.frame) wrap.append(extra.frame);
  else wrap.append(extra.canvas = h('canvas'));
  wrap.append(hits, marks);
  // PDF: above the drawing, the page's real text (transparent) to select it.
  if (extra.page) wrap.append(extra.textEl = h('div.textLayer'));
  wrap.append(pins);
  v.pages.push({ num, w, h: h0, wrap, pins, hits, marks, ...extra });
  return wrap;
}

function ready(v) {
  v.status = 'ready';
  layout(v);
  updatePins(v);
  applyPendingScroll(v);
}

// Width = available space × zoom; the height follows the page's proportions.
function layout(v) {
  if (v.stage) {
    v.stage.resize();
    return;
  }
  if (!v.pages.length || !v.scroller.isConnected) return;
  const avail = Math.max(200, v.scroller.clientWidth - 16); // 8 px of margin per side
  for (const p of v.pages) {
    p.cssW = Math.round(avail * v.zoom);
    p.wrap.style.setProperty('--total-scale-factor', p.cssW / p.w); // size of the selectable text
    p.wrap.style.width = `${p.cssW}px`;
    p.wrap.style.height = `${Math.round(p.cssW * p.h / p.w)}px`;
    if (p.frame) p.frame.style.transform = `scale(${p.cssW / p.w})`;
    if (p.visible && !v.quickZoom) renderPage(v, p);
  }
  if (v.zoomLabel) v.zoomLabel.textContent = `${Math.round(v.zoom * 100)}%`;
  updatePageLabel(v);
}

function renderPage(v, p) {
  if (!p.page || !p.cssW) return;
  const dpr = window.devicePixelRatio || 1;
  const scale = (p.cssW / p.w) * dpr;
  if (p.renderedScale === scale) return;
  renderText(v, p);
  p.task?.cancel();
  const viewport = p.page.getViewport({ scale });
  // Drawn on a new canvas and swapped at the end of the render: no white page while zooming.
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

// PDF.js text layer: built the first time the page is seen, then adapted to the zoom.
function renderText(v, p) {
  const viewport = p.page.getViewport({ scale: p.cssW / p.w });
  if (p.textLayer) return p.textLayer.update({ viewport });
  p.textLayer = new v.pdfjs.TextLayer({ textContentSource: p.page.streamTextContent(), container: p.textEl, viewport });
  p.textLayer.render().then(() => p.textEl.append(h('div.endOfContent'))).catch(e => { if (e?.name !== 'AbortException') console.warn(e); });
}

const clampZoom = (v, z) => Math.min(v.kind === 'cad' ? 12 : 4, Math.max(0.4, z)); // drawings go into the details

function setZoom(v, z) {
  const ratio = v.scroller.scrollTop / Math.max(1, v.scroller.scrollHeight);
  v.zoom = clampZoom(v, z);
  layout(v);
  v.scroller.scrollTop = ratio * v.scroller.scrollHeight;
}

// Zoom with pinch (trackpad or fingers) and ctrl/⌘ + wheel, around the point under the pointer. During the gesture the
// pages only widen (the drawing stretches); they are redrawn sharp when you stop.
function zoomAround(v, z, cx, cy) {
  const s = v.scroller;
  const r = s.getBoundingClientRect();
  const x = cx - r.left;
  const y = cy - r.top;
  const fx = (s.scrollLeft + x) / Math.max(1, s.scrollWidth);
  const fy = (s.scrollTop + y) / Math.max(1, s.scrollHeight);
  v.zoom = clampZoom(v, z);
  v.quickZoom = true;
  layout(v);
  v.quickZoom = false;
  s.scrollLeft = fx * s.scrollWidth - x;
  s.scrollTop = fy * s.scrollHeight - y;
  clearTimeout(v.zoomTimer);
  v.zoomTimer = setTimeout(() => layout(v), 150);
}

// Safari sends the pinch as gesture*, the other browsers as a wheel with ctrl: one of the two is used at a time.
function pinchZoom(v) {
  const s = v.scroller;
  s.addEventListener('wheel', ev => {
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    if (v.gesture) return;
    const dy = Math.max(-50, Math.min(50, ev.deltaY * (ev.deltaMode === 1 ? 16 : 1)));
    zoomAround(v, v.zoom * Math.exp(-dy * 0.006), ev.clientX, ev.clientY);
  }, { passive: false });
  s.addEventListener('gesturestart', ev => { ev.preventDefault(); v.gesture = v.zoom; });
  s.addEventListener('gesturechange', ev => { ev.preventDefault(); zoomAround(v, v.gesture * ev.scale, ev.clientX, ev.clientY); });
  s.addEventListener('gestureend', ev => { ev.preventDefault(); v.gesture = null; });
}

function updatePageLabel(v) {
  if (!v.pageLabel || v.pages.length < 2) return;
  const mid = v.scroller.scrollTop + v.scroller.clientHeight / 2;
  const p = v.pages.find(x => x.wrap.offsetTop + x.wrap.offsetHeight > mid) || v.pages.at(-1);
  v.pageLabel.textContent = tr('p. {n} / {total}', { n: p.num, total: v.pages.length });
}

// ---------- search in the document (⌘F / Ctrl+F) ----------
// PDFs are drawn on canvas: the browser's search does not see them. The text of each page is read with PDF.js (only
// once), the results are boxes over the page in percent (they follow the zoom). In text files the occurrences are
// highlighted directly. Upper and lower case do not matter.
const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl+';
const searchable = v => v.kind === 'pdf' || v.kind === 'text' || v.kind === 'table';
let lastActive = null; // in the side-by-side review: the document touched last

function searchBar(v) {
  if (!searchable(v)) return null;
  const go = dir => { if (v.matches?.length) showMatch(v, (v.matchIndex + dir + v.matches.length) % v.matches.length); };
  v.searchInput = h('input.dv-search-in', {
    type: 'search', placeholder: tr('Search in the document…'), autocomplete: 'off', spellcheck: 'false',
    oninput: () => { clearTimeout(v.searchTimer); v.searchTimer = setTimeout(() => runSearch(v), 180); },
    onkeydown: ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); go(ev.shiftKey ? -1 : 1); }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeSearch(v); }
    },
  });
  v.searchCount = h('span.muted.dv-search-n');
  v.searchBox = h('div.dv-search', { hidden: true },
    icon('search'), v.searchInput, v.searchCount,
    h('button.icon-btn.sm', { title: tr('Previous (Shift+Enter)'), onclick: () => go(-1) }, '↑'),
    h('button.icon-btn.sm', { title: tr('Next (Enter)'), onclick: () => go(1) }, '↓'),
    h('button.icon-btn.sm', { title: tr('Close (Esc)'), onclick: () => closeSearch(v) }, icon('x')));
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

// Keyboard shortcut: true if there is a document to search in (otherwise the browser's search stays).
export function docSearchKey() {
  const open = wantedDocs().map(id => viewers.get(id)).filter(v => v && searchable(v));
  const v = open.includes(lastActive) ? lastActive : open[0];
  if (!v) return false;
  openSearch(v);
  return true;
}

// Text of a PDF page with the position of each piece (page coordinates at zoom 1).
async function pageText(p) {
  if (p.text) return p.text;
  const { Util } = await loadPdfjs();
  const vt = p.page.getViewport({ scale: 1 }).transform;
  // Not getTextContent(): it reads the stream with "for await", which Safari (and the app installed from the Dock)
  // lacks on streams ("undefined is not a function"). The stream's reader works everywhere.
  const items = [];
  const reader = p.page.streamTextContent().getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) items.push(...r.value.items);
  let str = '';
  const spans = [];
  for (const it of items) {
    if (it.str) {
      const [, , c, d, e, f] = Util.transform(vt, it.transform);
      const size = Math.hypot(c, d) || it.height || 10;
      spans.push({ start: str.length, end: str.length + it.str.length, x: e, y: f - size * 0.95, w: it.width, h: size * 1.2 });
      str += it.str;
    }
    if (it.hasEOL) str += ' ';
  }
  const { norm, at } = normalize(str);
  p.text = { lower: norm, at, spans, empty: !str.trim() };
  return p.text;
}

// Text to compare: lower case, without accents, typographic dashes as "-", spaces of every kind (also the
// non-breaking ones, frequent in PDFs) as a single space. at[i] = position in the original text.
function normalize(str) {
  let norm = '';
  const at = [];
  for (let i = 0; i < str.length; i++) {
    let c = str[i].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/[\u2010-\u2015\u2212\u00ad]/.test(c)) c = '-';
    else if (/[\s\u00a0\u2000-\u200b\u202f\u205f\u3000]/.test(c)) c = norm.endsWith(' ') ? '' : ' ';
    for (const ch of c) { norm += ch; at.push(i); }
  }
  at.push(str.length);
  return { norm, at };
}

// Boxes of an occurrence [from, to): one for each piece of text it touches (also over several lines).
function rectsOf(text, from, to) {
  return text.spans.filter(s => s.end > from && s.start < to).map(s => {
    const len = Math.max(1, s.end - s.start);
    const a = Math.max(from, s.start) - s.start;
    const b = Math.min(to, s.end) - s.start;
    return { x: s.x + (s.w * a) / len, y: s.y, w: (s.w * (b - a)) / len, h: s.h };
  });
}

async function runSearch(v) {
  const q = normalize(v.searchInput.value.trim()).norm;
  const seq = (v.searchSeq = (v.searchSeq || 0) + 1);
  v.matches = [];
  if (!q) {
    drawMatches(v);
    v.searchCount.textContent = '';
    return;
  }
  if (v.kind === 'text') {
    const { norm, at } = normalize(v.rawText || '');
    for (let i = norm.indexOf(q); i >= 0; i = norm.indexOf(q, i + q.length)) v.matches.push({ from: at[i], to: at[i + q.length] });
  } else if (v.kind === 'table') {
    v.rows.forEach((r, ri) => r.forEach((x, ci) => {
      const { norm, at } = normalize(x);
      for (let i = norm.indexOf(q); i >= 0; i = norm.indexOf(q, i + q.length)) v.matches.push({ cell: [ri, ci], from: at[i], to: at[i + q.length] });
    }));
  } else {
    v.searchCount.textContent = 'cerco…';
    let empty = true;
    let failed = 0;
    let why = '';
    for (const p of v.pages) {
      let text;
      try {
        text = await pageText(p);
      } catch (e) {
        console.warn(`Text of page ${p.num} unreadable`, e);
        failed++;
        why ||= String(e?.message || e).slice(0, 160);
        continue;
      }
      if (seq !== v.searchSeq) return; // something else was typed meanwhile
      empty &&= text.empty;
      for (let i = text.lower.indexOf(q); i >= 0; i = text.lower.indexOf(q, i + q.length)) {
        v.matches.push({ page: p.num, rects: rectsOf(text, text.at[i], text.at[i + q.length]) });
      }
    }
    // Without results, say why if the reason is the PDF: no text (a scan) or unreadable.
    v.noText = failed === v.pages.length ? tr('cannot read the text of this PDF ({why})', { why })
      : empty && !failed ? tr('this PDF has no text to search (is it a scan?)')
        : failed ? tr('no results; {pages} ({why})', { pages: trn(failed, '1 unreadable page', '{n} unreadable pages'), why }) : '';
  }
  if (!v.matches.length) {
    drawMatches(v);
    v.searchCount.textContent = v.noText || tr('no results');
    v.searchCount.title = v.searchCount.textContent; // the reason may be long
    return;
  }
  // Start from the first result from the page being looked at onwards.
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
  if (v.kind === 'text' || v.kind === 'table') {
    v.textEl.querySelector('mark.on')?.scrollIntoView({ block: 'center', inline: 'nearest' });
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
  if (v.kind === 'table') {
    if (!v.cells) return;
    for (const [ri, ci] of v.marked || []) v.cells[ri][ci].textContent = v.rows[ri][ci];
    const byCell = new Map();
    (v.matches || []).forEach((m, i) => {
      const k = m.cell.join(':');
      if (!byCell.has(k)) byCell.set(k, []);
      byCell.get(k).push([m, i]);
    });
    v.marked = [];
    for (const list of byCell.values()) {
      const [ri, ci] = list[0][0].cell;
      const x = v.rows[ri][ci];
      const parts = [];
      let last = 0;
      for (const [m, i] of list) {
        parts.push(x.slice(last, m.from), h('mark', { class: i === v.matchIndex ? 'on' : null }, x.slice(m.from, m.to)));
        last = m.to;
      }
      parts.push(x.slice(last));
      v.cells[ri][ci].replaceChildren(...parts);
      v.marked.push([ri, ci]);
    }
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
  if (isReadOnly(wrap)) return; // read-only: no notes are added
  if (ev.target.closest('.dv-pin') || v.textJust) return; // the release has just prepared a note on the text
  if (selectionIn(v)) return; // text selected (on a phone): the note is made from the button
  const r = wrap.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
  // Click on highlighted text: its note opens.
  const hit = numbered(v.id).find(({ n }) => marksOf(n).some(([pg, mx, my, mw, mh]) => pg === num && x >= mx && x <= mx + mw && y >= my && y <= my + mh));
  if (hit) {
    openNotes(v);
    return selectNote(hit.n.id, false);
  }
  for (const o of viewers.values()) o.draft = null; // one note being prepared at a time
  v.draft = { page: num, x, y, fresh: true };
  openNotes(v);
  ui.docNote = null;
  render();
}

// ---------- notes on a piece of text (PDF) ----------
// The selected text (dragging with the mouse; on a phone with a long press and then "Note on the text") becomes a
// note being prepared with that text highlighted: boxes in 0..1 per page, like the pins, and the pin at the end of
// the first line.
function selectionIn(v) {
  const sel = window.getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!v.pagesEl.contains(range.commonAncestorContainer)) return null;
  const quote = sel.toString().replace(/\s+/g, ' ').trim();
  const marks = quote ? rangeMarks(v, range) : [];
  return marks.length ? { quote: quote.slice(0, 2000), marks } : null;
}

// Boxes of the selection, piece by piece of text (the whole range's rectangles would include whole pages too),
// merged by line.
function rangeMarks(v, range) {
  const out = [];
  for (const p of v.pages) {
    if (!p.textEl || !range.intersectsNode(p.textEl)) continue;
    const r = p.wrap.getBoundingClientRect();
    const boxes = [];
    const walk = document.createTreeWalker(p.textEl, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      if (!range.intersectsNode(t)) continue;
      const sub = document.createRange();
      sub.selectNodeContents(t);
      if (t === range.startContainer) sub.setStart(t, range.startOffset);
      if (t === range.endContainer) sub.setEnd(t, range.endOffset);
      for (const c of sub.getClientRects()) if (c.width >= 1 && c.height >= 1) boxes.push({ l: c.left, t: c.top, r: c.right, b: c.bottom });
    }
    const lines = [];
    for (const c of boxes.sort((a, b) => a.t - b.t || a.l - b.l)) {
      const hgt = c.b - c.t;
      const m = lines.find(x => Math.min(x.b, c.b) - Math.max(x.t, c.t) > 0.5 * Math.min(x.b - x.t, hgt) && c.l - x.r < hgt && x.l - c.r < hgt);
      if (m) Object.assign(m, { l: Math.min(m.l, c.l), t: Math.min(m.t, c.t), r: Math.max(m.r, c.r), b: Math.max(m.b, c.b) });
      else lines.push({ ...c });
    }
    for (const c of lines) out.push([p.num, (c.l - r.left) / r.width, (c.t - r.top) / r.height, (c.r - c.l) / r.width, (c.b - c.t) / r.height]);
  }
  return out.slice(0, 300);
}

const parsedMarks = new Map(); // saved JSON → boxes
function marksOf(n) {
  if (!n.marks) return [];
  if (Array.isArray(n.marks)) return n.marks; // note being prepared
  if (!parsedMarks.has(n.marks)) parsedMarks.set(n.marks, (() => { try { return JSON.parse(n.marks); } catch { return []; } })());
  return parsedMarks.get(n.marks);
}

// Mouse release after a selection (also double or triple click on a word or a line).
function textPointerUp(v, ev) {
  if (ev.pointerType === 'touch' || ev.button !== 0 || isReadOnly(v.pagesEl) || ev.target.closest('.dv-pin')) return;
  const sel = selectionIn(v);
  if (sel) textDraft(v, sel);
}

function textDraft(v, sel) {
  // Pin at the end of the first highlighted line: so it does not cover the selected text.
  const [page, x, y, w, hh] = sel.marks[0];
  for (const o of viewers.values()) o.draft = null;
  v.draft = { page, x: Math.min(1, x + w), y: Math.min(1, y + hh), quote: sel.quote, marks: sel.marks, fresh: true };
  v.textJust = true; // the click following the release must not also prepare a note at a point
  setTimeout(() => { v.textJust = false; }, 0);
  window.getSelection().removeAllRanges();
  if (v.selBtn) v.selBtn.hidden = true;
  openNotes(v);
  ui.docNote = null;
  render();
}

// Dragging past the end of a line, the pointer ends up in the void between the pieces of text and the selection
// would jump to the end of the page: as in PDF.js's viewer, during the selection the "end of content" box covers the
// page and follows the point where the selection ends.
let selecting = null; // text layer where the selection started
document.addEventListener('pointerdown', ev => {
  const layer = ev.button === 0 && ev.target.closest?.('.textLayer');
  if (!layer) return;
  selecting = layer;
  layer.classList.add('selecting');
});
document.addEventListener('pointerup', () => {
  if (!selecting) return;
  selecting.classList.remove('selecting');
  const end = selecting.querySelector('.endOfContent');
  if (end) selecting.append(end); // back to the bottom
  selecting = null;
});

function followSelection() {
  const sel = window.getSelection();
  if (!selecting || !sel?.rangeCount || sel.isCollapsed) return;
  let anchor = sel.focusNode;
  if (anchor?.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
  const layer = anchor?.closest?.('.textLayer');
  const end = layer?.querySelector('.endOfContent');
  if (!end || anchor === end || anchor === layer) return;
  const back = sel.anchorNode.compareDocumentPosition(sel.focusNode) & Node.DOCUMENT_POSITION_PRECEDING
    || (sel.anchorNode === sel.focusNode && sel.focusOffset < sel.anchorOffset);
  anchor.parentNode.insertBefore(end, back ? anchor : anchor.nextSibling);
}

// On a phone the selection is made with a long press: the button to make it a note appears.
let selTimer = null;
document.addEventListener('selectionchange', () => {
  followSelection();
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    for (const v of viewers.values()) {
      if (v.selBtn) v.selBtn.hidden = v.pointer === 'mouse' || isReadOnly(v.pagesEl) || !selectionIn(v);
    }
  }, 200);
});

// ---------- room for the document ----------
// Hideable notes bar and "expand" mode that removes the rest of the app.
// Single page: preference remembered (ui.docNotesHidden). Review: each pane has its own (v.paneNotes).
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

// The document's room changes: re-layout at once, without waiting for the ResizeObserver.
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

// ---------- notes ----------
const notesOf = id => S.data.docNotesOf.get(id) || [];
const visible = n => ui.docShowResolved || !n.resolved_at;

// Pin numbering: per page, top to bottom.
function numbered(docId) {
  return notesOf(docId).filter(n => n.page != null && visible(n))
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
    .map((n, i) => ({ n, num: i + 1 }));
}

function updatePins(v) {
  if (!pinnable(v) || v.status !== 'ready' || v.dragging) return; // no redrawing while dragging
  if (v.kind === 'model') {
    // Notes added or moved: recompute which ones are hidden (not at every sync: it is costly).
    const key = numbered(v.id).map(({ n }) => `${n.id}:${n.x},${n.y},${n.z}`).join();
    if (key !== v.pinKey) [v.pinKey, v.hiddenPins] = [key, null];
    return updatePins3d(v, false);
  }
  const list = numbered(v.id);
  const pct = ([, x, y, w, hh]) => `left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${hh * 100}%`;
  for (const p of v.pages) {
    const pins = list.filter(x => x.n.page === p.num).map(({ n, num }) => {
      const pin = h('button.dv-pin', {
        class: [ui.docNote === n.id && 'on', n.resolved_at && 'resolved'].filter(Boolean).join(' ') || null,
        style: `left:${n.x * 100}%;top:${n.y * 100}%`,
        // Notes on a text stay attached to the text: the pin does not move.
        title: n.marks ? `«${n.quote || ''}»\n${n.text}` : `${n.text}\n${tr('(drag to move)')}`,
        onclick: ev => {
          ev.stopPropagation();
          if (ev.currentTarget.dragged) return; // end of a drag, not a click
          openNotes(v);
          selectNote(n.id, false);
        },
      }, num);
      return n.marks ? pin : pinDrag(v, n, pin);
    });
    if (v.draft?.page === p.num) pins.push(h('span.dv-pin.draft', { style: `left:${v.draft.x * 100}%;top:${v.draft.y * 100}%` }, '+'));
    p.pins.replaceChildren(...pins);
    // Highlighted texts (also over several pages).
    p.marks.replaceChildren(
      ...list.flatMap(({ n }) => marksOf(n).filter(m => m[0] === p.num).map(m => h('div.dv-mark', {
        class: [ui.docNote === n.id && 'on', n.resolved_at && 'resolved'].filter(Boolean).join(' ') || null, style: pct(m),
      }))),
      ...marksOf(v.draft || {}).filter(m => m[0] === p.num).map(m => h('div.dv-mark.draft', { style: pct(m) })));
  }
}

// Draggable pins: they move to the right point, also on another page; near the edges the document scrolls. On
// release the new position is saved; a click without movement selects the note.
function pinDrag(v, n, pin) {
  pin.addEventListener('pointerdown', ev => {
    if (ev.button !== 0 || isReadOnly(pin)) return; // read-only: a click only selects
    ev.stopPropagation();
    ev.preventDefault();
    pin.dragged = false;
    const r0 = pin.closest('.dv-page').getBoundingClientRect();
    // Distance between the pointer and the pin's tip (the saved point), kept during the drag.
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
      // The page under the tip (or the closest one, in the gaps between pages).
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
      Object.assign(n, target); // at its place at once, the server confirms with the sync
      act(() => api('PATCH', `/doc-notes/${n.id}`, target));
      setTimeout(() => { pin.dragged = false; }, 0); // the click following the release must be ignored
    };
    pin.addEventListener('pointermove', move);
    pin.addEventListener('pointerup', end);
    pin.addEventListener('pointercancel', end);
  });
  return pin;
}

// Scrolling to a note is applied after the viewer has been re-attached to the page (during the render the scroll
// would be interrupted): here it is only booked.
function scrollToNote(v, id) {
  v.pendingNote = id;
}

function applyPendingScroll(v) {
  const id = v.pendingNote;
  if (!id || v.status !== 'ready' || !v.scroller.isConnected) return;
  const n = notesOf(v.id).find(x => x.id === id);
  const p = n?.page != null && v.pages[n.page - 1];
  v.pendingNote = null;
  if (v.stage && n?.z != null) return v.stage.focus(n); // 3D model: the view turns towards the point
  if (!p) return;
  v.scroll = Math.max(0, p.wrap.offsetTop + n.y * p.wrap.offsetHeight - v.scroller.clientHeight / 2);
  v.scroller.scrollTop = v.scroll; // immediate: the animated scroll stops if the tab is not in the foreground
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
    // In the updates (not in the details) because there the links are clickable.
    const quote = n.quote ? `, ${tr('on «{quote}»', { quote: n.quote.length > 80 ? `${n.quote.slice(0, 80)}…` : n.quote })}` : '';
    await api('POST', `/entries/${e.id}/log`, { text: `${tr('From {doc}', { doc: d.label || d.filename })}${n.page && kindOf(d) === 'pdf' ? `, ${tr('p. {n}', { n: n.page })}` : ''}${quote}: ${link}` });
    return e;
  });
  if (r) toast(tr('Todo created from the note'), { action: { label: tr('Agenda'), fn: () => { location.hash = '#/agenda'; } } });
}

function enterSave(save, cancel) {
  return ev => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      const text = ev.target.value.trim();
      if (text) save(text, ev.target);
    } else if (ev.key === 'Escape' && cancel) {
      ev.preventDefault(); // the global Esc must not also go back
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
    num ? h('span.dv-pin.mini', num) : h('span.dnote-gen', icon('log'), tr('general')),
    n.page != null && kindOf(d) === 'pdf' && h('span.muted', tr('p. {n}', { n: n.page })),
    h('span.grow'),
    h('span.muted', `${userName(n.created_by)} · ${fmtTime(n.created_at)}`)),
  n.quote && h('div.dnote-q', n.quote),
  editing
    ? h('textarea.dnote-edit', { 'data-ac': 'text', 'data-ac-only': '#+',
      value: n.text, rows: 2, 'data-fk': `dnedit-${n.id}`, oninput: autosize,
      onkeydown: enterSave(save, () => { ui.docEdit = null; render(); }),
      onblur: ev => save(ev.target.value.trim() || n.text),
    })
    : h('div.dnote-t.md', { ondblclick: () => { ui.docEdit = n.id; render(); } }, mdText(n.text)),
  h('div.dnote-a',
    h('button.chip', { onclick: () => act(() => api('PATCH', `/doc-notes/${n.id}`, { resolved: !n.resolved_at })) },
      icon('check'), n.resolved_at ? tr('reopen') : tr('resolved')),
    h('button.chip', { onclick: () => { ui.docEdit = n.id; render(); } }, tr('edit')),
    h('button.chip', { onclick: () => noteToTodo(d, n) }, '→ todo'),
    (n.created_by === me.id || me.is_admin) && h('button.icon-btn.sm', { title: tr('Delete'), onclick: () => trashIt('docnote', `/doc-notes/${n.id}`, tr('Note')) }, icon('trash'))),
  // Notes are private to whoever writes them: here one sees (and the author chooses) who it is shared with.
  shareBox('docnote', n),
  // Selected note: the entries that mention it with [[nota:…]].
  ui.docNote === n.id && backlinksBox('nota', n.id, { title: tr('Mentioned in'), compact: true }));
}

function notesPanel(d, v) {
  const all = notesOf(d.id);
  const general = all.filter(n => n.page == null && visible(n)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const pins = numbered(d.id);
  const resolved = all.filter(n => n.resolved_at).length;
  const saveDraft = text => {
    const { page, x, y, z, quote, marks } = v.draft;
    v.draft = null;
    act(async () => { const r = await api('POST', `/docs/${d.id}/notes`, { text, page, x, y, z, quote, marks }); ui.docNote = r.id; });
  };
  const cancelDraft = () => { v.draft = null; render(); };

  return h('aside.dv-notes',
    h('div.dv-nh',
      h('b', tr('Notes')), h('span.muted', String(all.length - (ui.docShowResolved ? 0 : resolved))),
      h('span.grow'),
      resolved > 0 && h('button.chip', { class: ui.docShowResolved && 'on', onclick: () => { ui.docShowResolved = !ui.docShowResolved; render(); } },
        tr('resolved {n}', { n: resolved }))),
    v.draft && h('div.dnote.draft',
      h('div.dnote-h', h('span.dv-pin.mini.draft', '+'), h('span', v.draft.quote ? tr('New note on the text, p. {n}', { n: v.draft.page })
        : v.kind === 'pdf' ? tr('New note on p. {n}', { n: v.draft.page }) : tr('New note at this point'))),
      v.draft.quote && h('div.dnote-q', v.draft.quote),
      h('textarea.dnote-edit', { 'data-ac': 'text', 'data-ac-only': '#+',
        rows: 3, placeholder: tr('What should be remembered here? (+person to share it; Enter saves, Esc cancels)'), 'data-fk': `draft-${d.id}`,
        oninput: autosize, onkeydown: enterSave(saveDraft, cancelDraft),
      }),
      h('div.dnote-a',
        h('button.btn.sm.primary', { onclick: ev => { const t = ev.target.closest('.dnote').querySelector('textarea').value.trim(); if (t) saveDraft(t); } }, tr('Save')),
        h('button.btn.sm.ghost', { onclick: cancelDraft }, tr('Cancel')))),
    h('textarea.dv-general', { 'data-ac': 'text', 'data-ac-only': '#+',
      rows: 1, placeholder: tr('General note on the file… (+person to share it; Enter saves)'), 'data-fk': `gnote-${d.id}`, oninput: autosize,
      onkeydown: enterSave((text, el) => { el.value = ''; act(() => api('POST', `/docs/${d.id}/notes`, { text })); }),
    }),
    general.map(n => noteCard(d, n)),
    pins.length > 0 && h('div.dv-sub', v.kind === 'model' ? tr('On the model') : pinnable(v) ? tr('On the document') : tr('Positioned')),
    pins.map(({ n, num }) => noteCard(d, n, num)),
    !all.length && !v.draft && h('p.muted.dv-empty', pinnable(v)
      ? (v.kind === 'model' ? tr('No notes. Click on a point of the model to leave one there, or write a general note above.') : v.kind === 'pdf' ? tr('No notes. Click on a point of the document to leave one there or select some text for a note on that text, or write a general note above.') : tr('No notes. Click on a point of the document to leave one there, or write a general note above.'))
      : tr('No notes. Write a note on the file above.')),
    // Mails (to send and sent) that attach or link it, and the other entries mentioning it.
    backlinksBox('doc', d.id, { title: tr('Linked in'), compact: true }));
}

// Hover card: kind, name, item, version and a small preview of the file.
export function docPeek(d) {
  const D = S.data;
  const it = D.itemById.get(d.item_id);
  const n = notesOf(d.id).filter(x => !x.resolved_at).length;
  const thumb = h('div.peek-thumb', h('span.muted', d.url ? '' : tr('Preview…')));
  docThumb(d).then(el => thumb.replaceChildren(el || h('span.muted', d.url ? d.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60) : tr('No preview for this file'))));
  return [
    h('div.peek-h', h('span.dk', dkAttrs(d.kind), kindLabel(d.kind)), it && h('span.code', itemAttrs(it), it.code)),
    h('div.peek-name', docName(d)),
    h('div.peek-grid',
      d.version && h('div.peek-r', h('span.muted', tr('Version')), h('span.mono', d.version)),
      d.filename && d.label && h('div.peek-r', h('span.muted', 'File'), h('span', d.filename)),
      d.size != null && h('div.peek-r', h('span.muted', tr('Size')), h('span', fmtSize(d.size))),
      h('div.peek-r', h('span.muted', tr('Uploaded')), h('span', fmtTime(d.created_at))),
      n > 0 && h('div.peek-r', h('span.muted', tr('Open notes')), h('span', String(n)))),
    thumb,
  ];
}

// ---------- view ----------
export function viewDoc(id, query = {}) {
  const D = S.data;
  const d = D.docById.get(+id);
  if (!d) return h('div.empty', h('p', tr('Document not found (maybe it is in the trash).')), h('a', { href: '#/magazzino' }, tr('Back to the inventory')));
  const it = D.itemById.get(d.item_id);
  const v = getViewer(d);
  // Link to a note (?n=ID): it is selected and scrolled to only once, as soon as the note is in the data.
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
      h('a.icon-btn', { href: it ? `#/i/${it.id}` : '#/magazzino', title: tr('Back to the item (Esc)') }, icon('back')),
      it && h('a.code', { href: `#/i/${it.id}`, ...itemAttrs(it) }, it.code),
      // The title is edited directly: it becomes the document's name in the app (the file stays as it is).
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

// ---------- pieces shared by the single page and the review ----------
// Kind and version can be changed after the upload too (here, in the item page and in Documents).
export function docMeta(d) {
  const patch = f => act(() => api('PATCH', `/docs/${d.id}`, f));
  return h('span.docmeta',
    kindPicker(d.kind, kind => patch({ kind })),
    h('input.ver-in', {
      value: d.version || '', placeholder: tr('version'), size: 7, title: tr('Version'), 'data-fk': `dver-${d.id}`,
      onchange: ev => patch({ version: ev.target.value.trim() }),
      onkeydown: ev => { if (ev.key === 'Enter') ev.target.blur(); },
    }));
}

const fileButtons = d => [h('button.icon-btn', { title: tr('Move or copy to another item'), onclick: () => moveDoc(d) }, icon('copy')), d.url
  ? h('a.icon-btn', { href: d.url, target: '_blank', rel: 'noopener noreferrer', title: tr('Open the original link: {url}', { url: d.url }) }, icon('link'))
  : [
  h('a.icon-btn', { href: docFileUrl(d, { inline: true }), target: '_blank', rel: 'noopener', title: tr('Open the original file') }, icon('link')),
  h('a.icon-btn', { href: docFileUrl(d), download: '', title: tr('Download') }, icon('download')),
]];

const notesChip = (d, v) => h('button.chip', { class: notesShown(v) && 'on', onclick: () => toggleNotes(v), title: tr('Show or hide the notes') },
  icon('log'), tr('notes {n}', { n: notesOf(d.id).filter(visible).length }));

const focusChip = focus => h('button.chip.only-desktop', {
  class: focus && 'on', onclick: () => setDocFocus(!focus), title: focus ? tr('Back to the normal view (Esc)') : tr('Use the whole window'),
}, icon('cols'), focus ? tr('shrink') : tr('expand'));

// Body: preview (or message for files without a preview) + notes, and restoring the scroll after re-attaching.
function docBody(d, v) {
  updatePins(v);
  const preview = v.kind === 'none'
      ? h('div.dv-main', h('div.empty',
        h('p', tr('No preview for this kind of file.')),
        h('a.btn', { href: docFileUrl(d), download: '' }, icon('download'), tr('Download {name}', { name: d.filename }))))
      : v.el;
  // The viewer is detached and re-attached: the scroll must be restored after the insertion.
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

// Preview of a file that is not a document (received attachment, see mail.js): only to look at, without notes.
// d.id is the preview's key (as in wantedDocs), d.src the file already downloaded.
export function previewBody(d) {
  const v = getViewer(d);
  queueMicrotask(() => { if (v.scroller.isConnected && Math.abs(v.scroller.scrollTop - v.scroll) > 1) v.scroller.scrollTop = v.scroll; });
  return h('div.dv.no-notes.ro', v.el);
}

// ---------- side-by-side review ----------
const reviewHash = ids => (ids.length ? `#/review?d=${ids.join(',')}` : '#/documenti');

export function viewReview(_id, query = {}) {
  const D = S.data;
  const ids = [...new Set(String(query.d || '').split(',').map(Number))].filter(id => D.docById.has(id)).slice(0, 3);
  if (!ids.length) return h('div.empty', h('p', tr('No document to review.')), h('a', { href: '#/documenti' }, tr('Pick the documents')));
  const focus = document.body.classList.contains('doc-focus');
  const addable = D.docs.filter(d => !ids.includes(d.id) && D.itemById.has(d.item_id));

  return h('div.view.review', { class: roClass(can('documenti', 'write')) },
    h('div.head',
      h('a.icon-btn', { href: '#/documenti', title: tr('Documents (Esc)') }, icon('back')),
      h('h2.dv-title', tr('Review')),
      h('span.muted', tr('{n} documents side by side', { n: ids.length })),
      h('span.grow'),
      ids.length < 3 && addable.length > 0 && h('select.sm', {
        onchange: ev => { if (ev.target.value) location.hash = reviewHash([...ids, +ev.target.value]); },
      }, h('option', { value: '' }, tr('+ put a document side by side…')),
      addable.map(d => h('option', { value: d.id }, `${D.itemById.get(d.item_id).code} · ${d.label || d.filename || d.url}`))),
      focusChip(focus)),
    h('div.rv', { style: `--n:${ids.length}` }, ids.map(id => {
      const d = D.docById.get(id);
      const it = D.itemById.get(d.item_id);
      const v = getViewer(d);
      return h('section.rv-pane',
        h('div.rv-h',
          it && h('a.code', { href: `#/i/${it.id}`, ...itemAttrs(it) }, it.code),
          h('a.rv-title', { href: `#/d/${d.id}`, title: tr('Open on its own') }, docName(d)),
          h('button.icon-btn.sm', { title: tr('Rename'), onclick: () => renameDoc(d) }, icon('edit')),
          docMeta(d),
          h('span.grow'),
          notesChip(d, v),
          h('button.icon-btn.sm', { title: tr('Remove from the review'), onclick: () => { location.hash = reviewHash(ids.filter(x => x !== id)); } }, icon('x'))),
        docBody(d, v));
    })));
}

// Esc from the viewer: first it closes the note being prepared.
export function docCancelDraft() {
  const v = [...viewers.values()].find(x => x.draft);
  if (!v) return false;
  v.draft = null;
  render();
  return true;
}
