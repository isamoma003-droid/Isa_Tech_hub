/**
 * "Sign in with Google". The dashboard shows Google's button, Google hands it a signed ID token
 * (a JWT), and the dashboard posts it here. The token counts only when it is signed by one of
 * Google's current keys (RS256), was issued by Google, is meant for our client ID and hasn't
 * expired, and Google says the email address is verified.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { HttpError, unauthorized } from '../utils/httpError.js';

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

// Google rotates its keys every few days and says how long to keep them (Cache-Control max-age).
let cache = { keys: new Map(), until: 0, fetchedAt: 0 };

async function fetchCerts() {
  const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Google keys answered HTTP ${res.status}`);
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1]) || 3600;
  return { json: await res.json(), maxAge };
}

let certsFetcher = fetchCerts;

/** Tests: answer with these keys instead of asking Google. null restores the real fetch. */
export function setGoogleCertsFetcher(fn) {
  certsFetcher = fn || fetchCerts;
  cache = { keys: new Map(), until: 0, fetchedAt: 0 };
}

async function publicKey(kid) {
  const fresh = Date.now() < cache.until;
  if (fresh && cache.keys.has(kid)) return cache.keys.get(kid);
  // Unknown key id: Google may just have rotated, so fetch again, but at most once a minute so
  // made-up key ids can't make us hammer Google.
  if (fresh && Date.now() - cache.fetchedAt < 60_000) return null;
  const { json, maxAge } = await certsFetcher();
  const keys = new Map();
  for (const jwk of json?.keys || []) {
    if (jwk.kty === 'RSA' && jwk.kid) keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
  }
  cache = { keys, until: Date.now() + maxAge * 1000, fetchedAt: Date.now() };
  return keys.get(kid) || null;
}

export const googleEnabled = () => env.googleClientIds.length > 0;

/**
 * Checks a Google ID token and returns who it is.
 * `authoritative` is true when Google is the authority for the address (a Gmail address, or a
 * Google Workspace domain, which Google marks with `hd`): only then may the token sign in to an
 * existing account that has the same email but was never linked to Google.
 * @returns {Promise<{ googleId, email, name, picture, authoritative }>}
 */
export async function verifyGoogleIdToken(credential, { clientIds = env.googleClientIds } = {}) {
  if (!clientIds.length) throw new HttpError(503, 'Google sign-in is not set up on this server (GOOGLE_CLIENT_ID)');
  const decoded = typeof credential === 'string' ? jwt.decode(credential, { complete: true }) : null;
  if (!decoded?.header?.kid || decoded.header.alg !== 'RS256') throw unauthorized('That Google sign-in is not valid');

  let key;
  try {
    key = await publicKey(decoded.header.kid);
  } catch (err) {
    console.error('Could not load Google sign-in keys:', err.message);
    throw new HttpError(503, "We couldn't reach Google to check the sign-in. Please try again.");
  }
  if (!key) throw unauthorized('That Google sign-in is not valid');

  let payload;
  try {
    payload = jwt.verify(credential, key, { algorithms: ['RS256'], audience: clientIds, issuer: ISSUERS, clockTolerance: 60 });
  } catch {
    throw unauthorized('That Google sign-in is not valid or has expired. Please try again.');
  }
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  if (!payload.sub || !payload.email || !verified) throw unauthorized('Your Google account has no verified email address');

  const email = String(payload.email).toLowerCase();
  return {
    googleId: String(payload.sub),
    email,
    name: payload.name || email.split('@')[0],
    picture: typeof payload.picture === 'string' ? payload.picture : null,
    authoritative: email.endsWith('@gmail.com') || Boolean(payload.hd),
  };
}
