// Passwords, session cookie and validation. Sessions live in accounts.js.
import crypto from 'node:crypto';
import { isHttps } from './util.js';

const SESSION_MAX_AGE = 400 * 24 * 3600; // the browsers' maximum: nobody wants to log in again on the phone

const scrypt = (pw, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k))));

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const key = await scrypt(pw, Buffer.from(salt, 'hex'));
  const expected = Buffer.from(hash, 'hex');
  return expected.length === key.length && crypto.timingSafeEqual(key, expected);
}

export function sessionCookie(req, token) {
  const maxAge = token ? SESSION_MAX_AGE : 0;
  return `sid=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

// "all" and "tutti" are not names: +all shares with everyone.
export const validUsername = u => /^[a-z0-9_.-]{2,32}$/i.test(String(u || '')) && !/^(all|tutti)$/i.test(String(u));
export const validPassword = p => typeof p === 'string' && p.length >= 8 && p.length <= 200;

export function randomCode(len = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(len), b => alphabet[b % alphabet.length]).join('');
}
