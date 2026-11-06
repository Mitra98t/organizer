// What's new page: the project's CHANGELOG.md, read from the server and shown as a page (a card per version).
// The changelog's Markdown is simple: headings, paragraphs, bullet lists, **bold**, `code` and [links](url).
import { h, icon, S, render, save, load } from './core.js';
import { tr } from './i18n.js';

const REPO = 'https://github.com/Mitra98t/organizer/blob/main/';
let text = null; // null = to load, false = error
const norm = v => String(v).trim().replace(/^v/, '').replace(/(\.0)+$/, ''); // "0.8.0" = "0.8"

function loadChangelog() {
  text = '';
  fetch('api/changelog', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.text() : Promise.reject()))
    .then(t => { text = t; render(); }, () => { text = false; render(); });
}

// The app's version (for the button in the bar and to know whether there is unread news).
export const appVersion = () => S.version || '';
export const hasNews = () => !!S.version && load('org.seenVersion', '') !== S.version;

function inline(s) {
  const out = [];
  let last = 0;
  for (const m of s.matchAll(/`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    out.push(s.slice(last, m.index));
    if (m[1] != null) out.push(h('code.k', m[1]));
    else if (m[2] != null) out.push(h('b', inline(m[2])));
    else {
      // The changelog's relative links point to project files: they open on GitHub.
      const href = /^https?:\/\//.test(m[4]) ? m[4] : REPO + m[4];
      out.push(h('a.ext', { href, target: '_blank', rel: 'noopener noreferrer' }, m[3]));
    }
    last = m.index + m[0].length;
  }
  out.push(s.slice(last));
  return out;
}

// Blocks: consecutive "- " lines become a list, the other consecutive lines a paragraph.
function blocks(lines) {
  const out = [];
  let list = null;
  let para = null;
  const flush = () => { list = null; para = null; };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    const li = line.match(/^\s*[-*] (.*)$/);
    if (li) {
      para = null;
      if (!list) out.push(list = h('ul.cl-list'));
      list.append(h('li', inline(li[1])));
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.lastChild.append(' ', ...inline(line.trim())); // line continuing the previous bullet
    } else {
      list = null;
      if (!para) out.push(para = h('p'));
      else para.append(' ');
      para.append(...inline(line.trim()));
    }
  }
  return out;
}

export function viewChangelog() {
  if (text === null) loadChangelog();
  if (S.version && load('org.seenVersion', '') !== S.version) {
    save('org.seenVersion', S.version);
    queueMicrotask(render); // removes the "new" from the button
  }
  if (text === false) return h('div.view', h('div.empty', h('p', tr('Changelog not available.'))));
  if (!text) return h('div.view', h('div.empty', h('p', tr('Loading…'))));

  // The text before the first version is the introduction; then a card for every "## version — date".
  const parts = text.split(/^## /m);
  const intro = parts.shift().replace(/^# .*$/m, '');
  return h('div.view.changelog',
    h('div.cl-intro', blocks(intro.split('\n'))),
    parts.map((p, i) => {
      const [title, ...rest] = p.split('\n');
      const [ver, date] = title.split(/\s+—\s+/);
      const inUse = S.version && norm(ver) === norm(S.version);
      return h('section.cl-ver', { class: i === 0 ? 'latest' : null },
        h('div.cl-h', h('span.cl-v', /^\d/.test(ver.trim()) ? `v${ver.trim()}` : ver.trim()), date && h('span.muted', date),
          inUse && h('span.chip.on', icon('check'), tr('in use'))),
        blocks(rest));
    }));
}
