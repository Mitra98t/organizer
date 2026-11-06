// Push notifications (Web Push) without dependencies: message encryption (RFC 8291, aes128gcm) and VAPID signature
// (RFC 8292). The VAPID keys are created the first time and stay in DATA_DIR/vapid.json: if they change, devices
// already subscribed stop receiving and must be turned on again.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './db.js';

const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url');
// Sender in the VAPID signature: PUSH_SUBJECT if set, otherwise the HTTPS address the device subscribed from.
const SUBJECT = process.env.PUSH_SUBJECT || '';

function vapidKeys() {
  const file = path.join(DATA_DIR, 'vapid.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' });
    fs.writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 });
    return jwk;
  }
}
const VAPID = vapidKeys();
const vapidPrivate = crypto.createPrivateKey({ key: VAPID, format: 'jwk' });
// "Raw" public key (0x04 || x || y): the one the app passes to pushManager.subscribe.
export const vapidPublic = b64u(Buffer.concat([Buffer.from([4]), unb64u(VAPID.x), unb64u(VAPID.y)]));

function vapidHeader(endpoint, origin) {
  const aud = new URL(endpoint).origin;
  const sub = SUBJECT || (/^https:\/\//.test(origin || '') ? origin : 'mailto:organizer@example.com');
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: vapidPrivate, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapidPublic}`;
}

// The message encrypted for that device (a single block, as aes128gcm wants for short messages).
function encrypt(sub, payload) {
  const uaPublic = unb64u(sub.p256dh);
  const authSecret = unb64u(sub.auth);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// Sends; returns the HTTP status (201 = delivered to the push service; 404/410 = expired subscription).
export async function sendPush(sub, data, { ttl = 86400, urgency = 'normal' } = {}) {
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(sub.endpoint, sub.origin),
      TTL: String(ttl),
      Urgency: urgency,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
    },
    body: encrypt(sub, JSON.stringify(data)),
    signal: AbortSignal.timeout(10000),
  });
  return r.status;
}

// For tests: decrypts with the "device" private key (the same scheme, in reverse).
export function decryptForTest(body, uaPrivate, uaPublic, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const shared = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = body.subarray(21 + idlen);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString();
}
