// Notifiche push: il messaggio cifrato per il dispositivo (RFC 8291) e la firma VAPID, verso un finto servizio
// push locale che li controlla come farebbe quello vero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-push-'));
const { sendPush, vapidPublic, decryptForTest } = await import('../server/push.js');

test('push: cifratura aes128gcm e firma VAPID', async () => {
  const ua = crypto.createECDH('prime256v1');
  const uaPublic = ua.generateKeys();
  const auth = crypto.randomBytes(16);
  let got;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { got = { headers: req.headers, body: Buffer.concat(chunks) }; res.writeHead(201); res.end(); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}/push/abc`;
  const status = await sendPush({ endpoint, p256dh: uaPublic.toString('base64url'), auth: auth.toString('base64url') }, { title: 'Ciao', body: 'è arrivata una mail' });
  server.close();
  assert.equal(status, 201);
  assert.equal(got.headers['content-encoding'], 'aes128gcm');
  assert.deepEqual(JSON.parse(decryptForTest(got.body, ua.getPrivateKey(), uaPublic, auth)), { title: 'Ciao', body: 'è arrivata una mail' });

  // VAPID: JWT ES256 firmato con la chiave di cui "k" è la parte pubblica, per l'origine del servizio push.
  const [, jwt, k] = got.headers.authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, vapidPublic);
  const [h, c, sig] = jwt.split('.');
  const raw = Buffer.from(k, 'base64url');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).aud, new URL(endpoint).origin);
});
