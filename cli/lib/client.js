// Client HTTP delle API di Organizer (docs/API.md): token nell'header Authorization,
// workspace nell'header X-Workspace, errori del server trasformati in ApiError con il messaggio leggibile.
import fs from 'node:fs';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createClient({ server, token, workspace }) {
  const base = String(server).replace(/\/+$/, '');

  // json: corpo JSON; body + type: corpo grezzo (file); raw: restituisce la Response (download).
  async function request(method, url, { json, body, type, raw = false } = {}) {
    const headers = { 'X-Requested-With': 'organizer', 'User-Agent': `organizer-cli/${VERSION}` };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (workspace) headers['X-Workspace'] = String(workspace);
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (type) {
      headers['Content-Type'] = type;
    }
    let res;
    try {
      res = await fetch(`${base}/api${url}`, { method, headers, body });
    } catch (e) {
      throw new ApiError(0, `Server non raggiungibile (${base}): ${e.cause?.code || e.cause?.message || e.message}`);
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new ApiError(res.status, data?.error || `${res.status} ${res.statusText}`);
    }
    if (raw) return res;
    if (res.status === 204) return null;
    return (res.headers.get('content-type') || '').includes('json') ? res.json() : res.text();
  }

  return {
    base,
    request,
    get: (url, opts) => request('GET', url, opts),
    post: (url, json, opts) => request('POST', url, { json, ...opts }),
    patch: (url, json) => request('PATCH', url, { json }),
    put: (url, json) => request('PUT', url, { json }),
    del: url => request('DELETE', url),
  };
}
