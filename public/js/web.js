// Web pages: the little browser for an item's link and the frame of link documents (see server/webpage.js).
// The server gives the page cleaned (no scripts); here it is shown in a frame without scripts (sandbox) of the
// same origin, so the app can measure it and catch the clicks on its links.
import { h, icon, api, act, can } from './core.js';
import { tr } from './i18n.js';

export const WEB_W = 1280; // px the pages are drawn at (the server converts vh units for a 1280×900 window)

// The page is asked first with fetch: an error (site not answering, protection against automatic downloads…)
// arrives with its reason instead of ending up inside the frame. The frame then takes it from the cache.
export async function checkPage(src) {
  const r = await fetch(src, { credentials: 'same-origin' });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || tr('Error {status}', { status: r.status }));
}

export const webFrame = (src, cls = '') => h(`iframe.web-frame${cls}`, {
  src, sandbox: 'allow-same-origin', referrerpolicy: 'no-referrer', title: tr('Web page'), tabindex: '-1',
});

// The page's address after redirects and when the copy was saved (written by the server in the page).
export function pageInfo(frame) {
  const m = frame.contentDocument?.querySelector('meta[name="organizer-page"]');
  return { url: m?.content || '', saved: m?.dataset.saved || '', title: frame.contentDocument?.title?.trim() || '' };
}

const shortUrl = u => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

// ---------- the frames of link documents, outside the view ----------
// The app rebuilds the view at every change: a frame moved in the page is loaded again (blank page, measures
// lost). So the scrolling box of a web page lives in a layer of its own above the view, placed over the space
// kept for it (slot); it follows the slot at every frame and is hidden when the slot is not on screen.
const layer = h('div.web-layer');
const placed = new Map(); // box → slot
let loop = 0;

export function placeOver(box, slot) {
  if (!layer.isConnected) document.body.append(layer);
  layer.append(box);
  placed.set(box, slot);
  if (!loop) loop = requestAnimationFrame(follow);
}

export function unplace(box) {
  placed.delete(box);
  box.remove();
}

function follow() {
  for (const [box, slot] of placed) {
    const r = slot.isConnected ? slot.getBoundingClientRect() : null;
    const show = !!r && r.width > 0 && r.height > 0 && !document.hidden;
    if (box.hidden === show) box.hidden = !show;
    if (!show) continue;
    // Read-only like the place it stands in (offline, no permission): see isReadOnly.
    const ro = !!slot.closest('.ro, .rw')?.classList.contains('ro');
    box.classList.toggle('ro', ro);
    box.classList.toggle('rw', !ro);
    const key = `${r.left},${r.top},${r.width},${r.height}`;
    if (box.dataset.at === key) continue;
    box.dataset.at = key;
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }
  loop = placed.size ? requestAnimationFrame(follow) : 0;
}

// ---------- little browser ----------
// A window over the page: back, address, open in the browser, save as a document of the item (to add notes).
export function openBrowser(url, { item } = {}) {
  const hist = [url];
  let at = 0;
  let info = { url, title: '' };
  const frame = webFrame('', '.wb-frame');
  const view = h('div.wb-view', frame);
  const msg = h('div.wb-msg.empty');
  const addr = h('span.wb-addr.mono');
  const back = h('button.icon-btn', { title: tr('Back'), onclick: () => at > 0 && go(--at) }, icon('back'));
  const open = h('a.icon-btn', { target: '_blank', rel: 'noopener noreferrer', title: tr('Open in the browser') }, icon('link'));
  const saveBtn = item && can('documenti', 'write') && h('button.btn.sm', {
    title: tr('Add the page to the documents of {code}: you can leave notes on it', { code: item.code }),
    onclick: async () => {
      const r = await act(() => api('POST', `/items/${item.id}/docs`, { url: info.url || hist[at], label: info.title.slice(0, 200) }));
      if (!r?.id) return;
      dlg.close();
      location.hash = `#/d/${r.id}`;
    },
  }, icon('file'), tr('Save as document'));
  const dlg = h('dialog.wb', { onclose: () => { ro.disconnect(); dlg.remove(); } },
    h('div.wb-bar', back, addr, h('span.grow'), saveBtn, open,
      h('button.icon-btn', { title: tr('Close'), onclick: () => dlg.close() }, icon('x'))),
    h('div.wb-body', view, msg));

  // Drawn at WEB_W px and shrunk to the window (on a phone the page is small: it is a preview).
  const fit = () => {
    const s = Math.min(1, view.clientWidth / WEB_W) || 1;
    Object.assign(frame.style, { width: `${view.clientWidth / s}px`, height: `${view.clientHeight / s}px`, transform: `scale(${s})` });
  };
  const ro = new ResizeObserver(fit);
  ro.observe(view);

  async function go(i) {
    const u = hist[i];
    info = { url: u, title: '' };
    back.disabled = i === 0;
    addr.textContent = shortUrl(u);
    addr.title = u;
    open.href = u;
    view.hidden = true;
    msg.hidden = false;
    msg.replaceChildren(tr('Loading the page…'));
    const src = `api/web?url=${encodeURIComponent(u)}`;
    try {
      await checkPage(src);
    } catch (e) {
      if (hist[at] !== u) return; // gone elsewhere meanwhile
      msg.replaceChildren(h('p', e.message), h('a.btn', { href: u, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), tr('Open the original link')));
      return;
    }
    if (hist[at] === u) frame.src = src;
  }

  frame.addEventListener('load', () => {
    const doc = frame.contentDocument;
    if (!doc || !frame.src) return;
    info = pageInfo(frame);
    if (info.url) {
      addr.textContent = shortUrl(info.url);
      addr.title = open.href = info.url;
    }
    msg.hidden = true;
    view.hidden = false;
    fit();
    // Links: the next page opens here (⌘/Ctrl+click: in the browser); anchors in the same page work by themselves.
    doc.addEventListener('click', ev => {
      const a = ev.target.closest?.('a[href]');
      if (!a) return;
      const href = a.href;
      const same = href.split('#')[0] === (info.url || hist[at]).split('#')[0] && href.includes('#');
      if (same) return;
      ev.preventDefault();
      if (!/^https?:/i.test(href)) return;
      if (ev.metaKey || ev.ctrlKey) return window.open(href, '_blank', 'noopener,noreferrer');
      hist.splice(at + 1, Infinity, href);
      go(++at);
    }, true);
  });

  document.body.append(dlg);
  dlg.showModal();
  go(0);
}
