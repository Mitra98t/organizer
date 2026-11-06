// Push notifications: the message encrypted for the device (RFC 8291) and the VAPID signature, sent to a fake local
// push service that checks them as the real one would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-push-'));
const { sendPush, vapidPublic, decryptForTest } = await import('../server/push.js');

test('push: aes128gcm encryption and VAPID signature', async () => {
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
  const status = await sendPush({ endpoint, p256dh: uaPublic.toString('base64url'), auth: auth.toString('base64url') }, { title: 'Hello', body: 'a mail arrived' });
  server.close();
  assert.equal(status, 201);
  assert.equal(got.headers['content-encoding'], 'aes128gcm');
  assert.deepEqual(JSON.parse(decryptForTest(got.body, ua.getPrivateKey(), uaPublic, auth)), { title: 'Hello', body: 'a mail arrived' });

  // VAPID: ES256 JWT signed with the key whose public part is "k", for the push service's origin.
  const [, jwt, k] = got.headers.authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, vapidPublic);
  const [h, c, sig] = jwt.split('.');
  const raw = Buffer.from(k, 'base64url');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).aud, new URL(endpoint).origin);
});
