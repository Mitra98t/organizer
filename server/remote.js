// PDFs from external links (e.g. datasheets on a distributor's site): the browser cannot read them directly from
// another domain, so the server downloads them and passes them to the viewer.
// Protections: only http/https to public addresses (the server must not become a way to reach machines on the local
// network), redirects re-checked one by one, limited time and size, PDFs only.
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
      || (a === 100 && b >= 64 && b <= 127) // CGNAT (Tailscale too)
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
    fail(400, 'Invalid link');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(400, 'Only http/https links are allowed');
  const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!addrs.length) fail(502, 'Address {host} not reachable', { host: url.hostname });
  if (addrs.some(a => isPrivate(a.address))) fail(403, 'Links to the local network are not loaded by the server');
  return url;
}

route('GET', '/api/docs/:id/remote', async ({ res, params }) => {
  const d = db.prepare('SELECT url FROM documents WHERE id = ? AND deleted_at IS NULL AND url IS NOT NULL').get(+params.id)
    || fail(404, 'Document not found');
  let url = await checkUrl(d.url);
  let r;
  for (let i = 0; ; i++) {
    try {
      r = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'Mozilla/5.0 (Organizer; document preview)', Accept: 'application/pdf,*/*;q=0.8' },
      });
    } catch (e) {
      fail(502, 'The site does not answer ({why})', { why: e.name === 'TimeoutError' ? 'timed out' : e.message });
    }
    const loc = r.status >= 300 && r.status < 400 && r.headers.get('location');
    if (!loc) break;
    if (i >= MAX_REDIRECTS) fail(502, 'Too many redirects');
    url = await checkUrl(new URL(loc, url).href);
  }
  if (!r.ok) fail(502, 'The site answered {status}', { status: r.status });
  if (+r.headers.get('content-length') > MAX_BYTES) fail(413, 'PDF too large (max {mb} MB)', { mb: MAX_BYTES >> 20 });
  const chunks = [];
  let size = 0;
  for await (const c of r.body) {
    size += c.length;
    if (size > MAX_BYTES) fail(413, 'PDF too large (max {mb} MB)', { mb: MAX_BYTES >> 20 });
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks);
  // Many sites answer with a page (login, anti-bot protection) instead of the file.
  if (buf.subarray(0, 1024).indexOf('%PDF-') === -1) fail(415, 'The link does not return a PDF (the site may show a page or an anti-bot protection)');
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': buf.length,
    'Cache-Control': 'private, max-age=600',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
}, { area: 'documenti' });
