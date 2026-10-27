import crypto from 'node:crypto';
import { db } from './db.js';
import { now, isHttps } from './util.js';

const SESSION_MAX_AGE = 400 * 24 * 3600; // limite massimo dei browser: sul telefono non si vuole rifare il login

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

const sha = t => crypto.createHash('sha256').update(t).digest('hex');

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)')
    .run(sha(token), userId, now(), now());
  return token;
}

export function userFromToken(token) {
  if (!token) return null;
  return db.prepare(`SELECT u.id, u.username, u.name, u.is_admin FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha(token)) || null;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

export function sessionCookie(req, token) {
  const maxAge = token ? SESSION_MAX_AGE : 0;
  return `sid=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

export const validUsername = u => /^[a-z0-9_.-]{2,32}$/i.test(String(u || ''));
export const validPassword = p => typeof p === 'string' && p.length >= 8 && p.length <= 200;

export function randomCode(len = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(len), b => alphabet[b % alphabet.length]).join('');
}
