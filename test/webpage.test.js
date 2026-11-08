// Web pages: the cleaning of a downloaded page and the link documents with their saved copy, against a small local
// site (the server runs with REMOTE_ALLOW_LAN=1, otherwise it would refuse 127.0.0.1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-web-test-'));
process.env.DATA_DIR = path.join(dir, 'unit');
const { cleanPage, fixCss, absCss, decodeHtml } = await import('../server/webpage.js');
const { checkUrl } = await import('../server/remote.js');

let server;
let site;
let url;
let cookie;
let version = 'v1';

const PAGE = () => `<!doctype html><html><head><title>Board X</title>
<link rel="stylesheet" href="/s.css"><script>alert(1)</script><script src="/app.js"></script>
<meta http-equiv="refresh" content="0;url=/elsewhere"><base href="https://evil.example/"></head>
<body onload="steal()"><h1 style="height:50vh">Board X</h1><a href="javascript:alert(1)">bad</a> <a href="/next">next</a>
<img data-src="/i.png" src="data:image/gif;base64,R0lGOD" loading="lazy"><iframe src="/x"></iframe><object data="/y"></object>
<p>${version}</p></body></html>`;

const freePort = () => new Promise(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const call = (method, p, body) => fetch(`${url}/api${p}`, {
  method,
  headers: { 'X-Requested-With': 'organizer', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: body && JSON.stringify(body),
});

before(async () => {
  site = http.createServer((req, res) => {
    if (req.url === '/page') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE());
    if (req.url === '/s.css') return res.writeHead(200, { 'Content-Type': 'text/css' }).end('.hero{min-height:100vh;background:url(img/bg.png)}.bar{position: fixed;top:0}');
    if (req.url === '/moved') return res.writeHead(302, { Location: '/page' }).end();
    if (req.url === '/file.zip') return res.writeHead(200, { 'Content-Type': 'application/zip' }).end('PK');
    if (req.url === '/blocked') return res.writeHead(403).end('no robots');
    res.writeHead(404).end();
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  site.url = `http://127.0.0.1:${site.address().port}`;

  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: root, stdio: 'ignore',
    env: { ...process.env, DATA_DIR: path.join(dir, 'data'), PORT: String(port), HOST: '127.0.0.1', REMOTE_ALLOW_LAN: '1' },
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${url}/healthz`).then(r => r.ok, () => false)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const r = await call('POST', '/setup', { username: 'fede', password: 'test-password' });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
});

after(() => {
  server?.kill();
  site?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleaning: no scripts, frames, handlers or redirects; CSS for a page as tall as its content', () => {
  const out = cleanPage(PAGE(), 'https://shop.example/board', { sheets: new Map([['https://shop.example/s.css', '.a{height:100vh;background:url(bg.png)}']]) });
  for (const bad of ['<script', 'alert(', 'onload', 'javascript:', '<iframe', '<object', 'http-equiv', 'evil.example']) assert.ok(!out.includes(bad), bad);
  assert.match(out, /<base href="https:\/\/shop\.example\/board">/);
  assert.match(out, /<style data-href="https:\/\/shop\.example\/s\.css">\.a\{height:900px;background:url\("https:\/\/shop\.example\/bg\.png"\)\}<\/style>/);
  assert.match(out, /style="height:450px"/);
  assert.match(out, /<img data-src="\/i\.png" src="\/i\.png">/); // lazy image loaded now, without loading="lazy"
  assert.match(out, /^<!doctype html>/i);

  assert.equal(fixCss('a{min-height:calc(100vh - 2.5svh);width:10vmin}.b{position :fixed}.c{position:-webkit-sticky}'),
    'a{min-height:calc(900px - 22.5px);width:90px}.b{position:absolute}.c{position:relative}');
  assert.equal(absCss('@import "x.css"; a{background:url(\'../i.png\')} b{background:url(data:image/png;base64,AA)}', 'https://s.example/css/m.css'),
    '@import "https://s.example/css/x.css"; a{background:url("https://s.example/i.png")} b{background:url(data:image/png;base64,AA)}');
  assert.equal(decodeHtml(Buffer.from([0x63, 0x61, 0x66, 0xe8]), 'text/html; charset=iso-8859-1'), 'cafè');
});

test('local network addresses are refused unless REMOTE_ALLOW_LAN=1', async () => {
  await assert.rejects(checkUrl('http://127.0.0.1:9/'), /local network/);
  await assert.rejects(checkUrl('http://192.168.1.10/wiki'), /local network/);
  await assert.rejects(checkUrl('file:///etc/passwd'), /Only http/);
});

test('link documents: saved copy, update, copy to another item, little browser, errors', async () => {
  const item = await (await call('POST', '/items', { code: 'WEB-1', name: 'board' })).json();
  const other = await (await call('POST', '/items', { code: 'WEB-2', name: 'other' })).json();
  const { id } = await (await call('POST', `/items/${item.id}/docs`, { url: `${site.url}/moved`, label: 'Board page' })).json();

  let r = await call('GET', `/docs/${id}/page`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /^sandbox allow-same-origin; default-src 'none'/);
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  let html = await r.text();
  assert.match(html, new RegExp(`<base href="${site.url}/page">`)); // the address after the redirect
  assert.match(html, /\.hero\{min-height:900px;background:url\("http:\/\/127\.0\.0\.1:\d+\/img\/bg\.png"\)\}\.bar\{position:absolute;top:0\}/);
  assert.match(html, /data-saved="\d{4}-/);
  assert.ok(html.includes('<p>v1</p>') && !html.includes('<script'));

  // The site changes: the saved copy stays until "Update".
  version = 'v2';
  assert.ok((await (await call('GET', `/docs/${id}/page`)).text()).includes('<p>v1</p>'));
  r = await call('POST', `/docs/${id}/page`);
  assert.match((await r.json()).saved_at, /^\d{4}-/);
  assert.ok((await (await call('GET', `/docs/${id}/page`)).text()).includes('<p>v2</p>'));

  // The copy in another item takes the saved page along.
  version = 'v3';
  const copy = await (await call('POST', `/docs/${id}/copy`, { item_id: other.id })).json();
  assert.ok((await (await call('GET', `/docs/${copy.id}/page`)).text()).includes('<p>v2</p>'));

  // The little browser: the page as it is now.
  r = await call('GET', `/web?url=${encodeURIComponent(`${site.url}/page`)}`);
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes('<p>v3</p>'));
  assert.equal((await call('GET', '/web?url=ftp%3A%2F%2Fx')).status, 400);

  // Not a page, or a site that refuses automatic downloads: the reason arrives.
  const zip = await (await call('POST', `/items/${item.id}/docs`, { url: `${site.url}/file.zip` })).json();
  r = await call('GET', `/docs/${zip.id}/page`);
  assert.equal(r.status, 415);
  assert.match((await r.json()).error, /not lead to a web page \(application\/zip\)/);
  const blocked = await (await call('POST', `/items/${item.id}/docs`, { url: `${site.url}/blocked` })).json();
  r = await call('GET', `/docs/${blocked.id}/page`);
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /does not let the server download the page \(403\)/);

  // A file document has no page.
  assert.equal((await call('GET', `/docs/${id + 1000}/page`)).status, 404);
});
