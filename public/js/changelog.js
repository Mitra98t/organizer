// Pagina Novità: il CHANGELOG.md del progetto, letto dal server e mostrato come pagina (una scheda per versione).
// Il Markdown del changelog è semplice: titoli, paragrafi, elenchi puntati, **grassetto**, `codice` e [link](url).
import { h, icon, S, render, save, load } from './core.js';

const REPO = 'https://github.com/Mitra98t/organizer/blob/main/';
let text = null; // null = da caricare, false = errore
const norm = v => String(v).trim().replace(/^v/, '').replace(/(\.0)+$/, ''); // "0.8.0" = "0.8"

function loadChangelog() {
  text = '';
  fetch('api/changelog', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.text() : Promise.reject()))
    .then(t => { text = t; render(); }, () => { text = false; render(); });
}

// Versione dell'app (per il pulsante nella barra e per sapere se ci sono novità non ancora lette).
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
      // I link relativi del changelog puntano a file del progetto: si aprono su GitHub.
      const href = /^https?:\/\//.test(m[4]) ? m[4] : REPO + m[4];
      out.push(h('a.ext', { href, target: '_blank', rel: 'noopener noreferrer' }, m[3]));
    }
    last = m.index + m[0].length;
  }
  out.push(s.slice(last));
  return out;
}

// Blocchi: righe "- " consecutive diventano un elenco, le altre righe consecutive un paragrafo.
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
      list.lastChild.append(' ', ...inline(line.trim())); // riga che continua il punto precedente
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
    queueMicrotask(render); // toglie il "nuovo" dal pulsante
  }
  if (text === false) return h('div.view', h('div.empty', h('p', 'Changelog non disponibile.')));
  if (!text) return h('div.view', h('div.empty', h('p', 'Caricamento…')));

  // Il testo prima della prima versione è l'introduzione; poi una scheda per ogni "## versione — data".
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
          inUse && h('span.chip.on', icon('check'), 'in uso')),
        blocks(rest));
    }));
}
