// PDF da link esterni (es. datasheet su mouser.com): il browser non può leggerli direttamente da un altro
// dominio, quindi li scarica il server e li passa al visualizzatore.
// Protezioni: solo http/https verso indirizzi pubblici (il server non deve diventare un modo per raggiungere
// macchine della rete locale), redirect ricontrollati uno per uno, tempo e dimensione limitati, solo PDF.
import dns from 'node:dns/promises';
import net from 'node:net';
import { db } from './db.js';
import { route } from './api.js';
import { fail } from './util.js';

const MAX_BYTES = (+process.env.REMOTE_MAX_MB || 60) * 1048576;
const TIMEOUT_MS = 25000;
const MAX_REDIRECTS = 4;

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) // CGNAT (anche Tailscale)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivate(v6.slice(7));
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

async function checkUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(400, 'Link non valido');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(400, 'Sono ammessi solo link http/https');
  const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!addrs.length) fail(502, `Indirizzo ${url.hostname} non raggiungibile`);
  if (addrs.some(a => isPrivate(a.address))) fail(403, 'I link verso la rete locale non si caricano dal server');
  return url;
}

route('GET', '/api/docs/:id/remote', async ({ res, params }) => {
  const d = db.prepare('SELECT url FROM documents WHERE id = ? AND deleted_at IS NULL AND url IS NOT NULL').get(+params.id)
    || fail(404, 'Documento non trovato');
  let url = await checkUrl(d.url);
  let r;
  for (let i = 0; ; i++) {
    try {
      r = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'Mozilla/5.0 (Organizer; anteprima documenti)', Accept: 'application/pdf,*/*;q=0.8' },
      });
    } catch (e) {
      fail(502, `Il sito non risponde (${e.name === 'TimeoutError' ? 'tempo scaduto' : e.message})`);
    }
    const loc = r.status >= 300 && r.status < 400 && r.headers.get('location');
    if (!loc) break;
    if (i >= MAX_REDIRECTS) fail(502, 'Troppi redirect');
    url = await checkUrl(new URL(loc, url).href);
  }
  if (!r.ok) fail(502, `Il sito ha risposto ${r.status}`);
  if (+r.headers.get('content-length') > MAX_BYTES) fail(413, `PDF troppo grande (max ${MAX_BYTES >> 20} MB)`);
  const chunks = [];
  let size = 0;
  for await (const c of r.body) {
    size += c.length;
    if (size > MAX_BYTES) fail(413, `PDF troppo grande (max ${MAX_BYTES >> 20} MB)`);
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks);
  // Molti siti rispondono con una pagina (login, protezione anti-bot) invece del file.
  if (buf.subarray(0, 1024).indexOf('%PDF-') === -1) fail(415, 'Il link non restituisce un PDF (il sito potrebbe mostrare una pagina o una protezione anti-bot)');
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': buf.length,
    'Cache-Control': 'private, max-age=600',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
});
