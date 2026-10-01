import crypto from 'node:crypto';
import { env } from '../config/env.js';

// Till credentials (Daraja consumer key/secret, passkey) and platform webhook secrets must be
// readable by the Hub, so they're encrypted rather than hashed: AES-256-GCM with a key derived
// from HUB_SECRET_KEY. Anyone with a copy of the database but not that key gets nothing usable.

const VERSION = 'v1';
const key = () => crypto.createHash('sha256').update(env.secretKey).digest();

export function encryptSecret(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptSecret(blob) {
  if (!blob) return '';
  const [version, iv, tag, data] = String(blob).split(':');
  if (version !== VERSION || !iv || !tag || !data) throw new Error('Unreadable encrypted secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Webhook signatures: `ISA-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
// The timestamp is signed too, so a captured request can't be replayed later.
export function signWebhook(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

export function verifyWebhookSignature(secret, body, header, { toleranceSeconds = 300, now = Date.now() } = {}) {
  const parts = Object.fromEntries(
    String(header || '')
      .split(',')
      .map((part) => part.trim().split('='))
      .filter((pair) => pair.length === 2),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || !parts.v1) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return safeEqual(expected, parts.v1);
}
