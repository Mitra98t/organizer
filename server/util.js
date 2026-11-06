// An error for the client: status, an English message (translated when sent, see i18n.js) and its placeholders.
export class HttpError extends Error {
  constructor(status, message, vars = null) {
    super(message);
    this.status = status;
    this.vars = vars;
  }
}

export const fail = (status, message, vars) => { throw new HttpError(status, message, vars); };
export const now = () => new Date().toISOString();
export const bool = v => (v ? 1 : 0);
export const str = (v, max = 2000) => (v == null ? '' : String(v).trim().slice(0, max));

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-cache',
    ...headers,
  });
  res.end(body);
}

export async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) fail(413, 'Request too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    fail(400, 'Invalid JSON');
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// The client's address. Behind Cloudflare Tunnel every request comes from the tunnel container: the real address
// is in the header named by CLIENT_IP_HEADER (cf-connecting-ip), when present.
const IP_HEADER = (process.env.CLIENT_IP_HEADER || '').toLowerCase();
export const clientIp = req => (IP_HEADER && String(req.headers[IP_HEADER] || '').split(',')[0].trim()) || req.socket.remoteAddress;

export const isHttps = req => Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';
