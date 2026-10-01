// Safaricom Daraja: Lipa na M-Pesa Online (STK Push) and its status query, per till.
// Docs: https://developer.safaricom.co.ke/APIs/MpesaExpressSimulate
//
// Merged from egertickets (status-query semantics, never trusting a callback on its own) and
// A-Read (fetch transport that tests can swap, Kenya-time timestamps, field length limits).
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { darajaTimestamp } from '../utils/time.js';

const BASE_URLS = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
};

export class DarajaError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function fetchTransport(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Daraja sometimes answers errors with HTML.
  }
  return { status: res.status, json };
}

let transport = fetchTransport;
// Access tokens per till and credential set: { value, expiresAt }.
const tokens = new Map();

// Tests swap the HTTP layer with a fake.
export function setDarajaTransport(fake) {
  transport = fake || fetchTransport;
  tokens.clear();
}

const describe = (json) => json?.errorMessage || json?.ResponseDescription || json?.resultDesc || 'no details';

// `till` must be loaded with +consumerKey +consumerSecret +passkey +callbackSecret.
function context(till) {
  const { consumerKey, consumerSecret, passkey } = till.credentials();
  if (!consumerKey || !consumerSecret || !passkey) {
    throw new DarajaError(`Till "${till.name}" has no Daraja credentials yet`);
  }
  return { base: BASE_URLS[till.environment], consumerKey, consumerSecret, passkey };
}

async function accessToken(till, ctx) {
  const cacheKey = `${till.id}:${crypto.createHash('sha256').update(ctx.consumerKey + ctx.consumerSecret).digest('hex')}`;
  const cached = tokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const basic = Buffer.from(`${ctx.consumerKey}:${ctx.consumerSecret}`).toString('base64');
  const { status, json } = await transport(`${ctx.base}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { authorization: `Basic ${basic}` },
  });
  if (status !== 200 || !json?.access_token) {
    throw new DarajaError(`M-Pesa sign-in failed for till "${till.name}" (${status}): check its consumer key and secret`, { status });
  }
  // Tokens last an hour; renew a minute early.
  tokens.set(cacheKey, { value: json.access_token, expiresAt: Date.now() + (Number(json.expires_in || 3599) - 60) * 1000 });
  return json.access_token;
}

async function call(till, path, body) {
  const ctx = context(till);
  const token = await accessToken(till, ctx);
  const { status, json } = await transport(`${ctx.base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body,
  });
  if (status === 401) tokens.clear();
  return { status, json };
}

function signature(till, ctx) {
  const timestamp = darajaTimestamp();
  return {
    BusinessShortCode: till.shortcode,
    Password: Buffer.from(`${till.shortcode}${ctx.passkey}${timestamp}`).toString('base64'),
    Timestamp: timestamp,
  };
}

export const callbackUrl = (till) => `${env.publicUrl}/mpesa/callback/${till.id}/${till.callbackSecret}`;

// Sends the "enter your M-Pesa PIN" prompt to the payer's phone.
export async function stkPush(till, { phone, amount, accountReference, description }) {
  const ctx = context(till);
  const { status, json } = await call(till, '/mpesa/stkpush/v1/processrequest', {
    ...signature(till, ctx),
    TransactionType: till.kind === 'till' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
    Amount: Math.round(amount),
    PartyA: phone,
    PartyB: till.kind === 'till' ? till.tillNumber : till.shortcode,
    PhoneNumber: phone,
    CallBackURL: callbackUrl(till),
    AccountReference: String(accountReference || 'Payment').slice(0, 12),
    TransactionDesc: String(description || 'Payment').slice(0, 13),
  });
  if (status !== 200 || String(json?.ResponseCode) !== '0') {
    throw new DarajaError(`M-Pesa refused the request: ${describe(json)}`, { code: json?.errorCode, status });
  }
  return {
    checkoutRequestId: json.CheckoutRequestID,
    merchantRequestId: json.MerchantRequestID,
    customerMessage: json.CustomerMessage,
  };
}

/**
 * Asks Safaricom how an STK push ended.
 *
 * Daraja answers "the payer hasn't finished yet" with an HTTP 500 carrying errorCode
 * 500.001.1001 (or ResultCode 4999), so that is reported as 'pending', never as a failure:
 * treating it as an error would fail payments that are still in progress.
 *
 * @returns {Promise<{ state: 'success'|'failed'|'pending'|'unknown', resultCode: number|null, resultDesc: string|null }>}
 * Throws DarajaError only when Safaricom couldn't be reached or signed in to.
 */
export async function stkQuery(till, checkoutRequestId) {
  const ctx = context(till);
  const { status, json } = await call(till, '/mpesa/stkpushquery/v1/query', {
    ...signature(till, ctx),
    CheckoutRequestID: checkoutRequestId,
  });

  if (!json) throw new DarajaError(`M-Pesa status check returned no data (${status})`, { status });

  if (String(json.errorCode || '').startsWith('500.001.1001')) {
    return { state: 'pending', resultCode: null, resultDesc: json.errorMessage || 'Still processing' };
  }
  if (json.ResultCode === undefined || json.ResultCode === null || json.ResultCode === '') {
    return { state: 'unknown', resultCode: null, resultDesc: describe(json) };
  }

  const resultCode = Number(json.ResultCode);
  const resultDesc = json.ResultDesc || null;
  if (resultCode === 0) return { state: 'success', resultCode, resultDesc };
  if (resultCode === 4999) return { state: 'pending', resultCode: null, resultDesc };
  // 1032 cancelled, 1037 no answer, 1 insufficient funds, 2001 wrong PIN, …
  return { state: 'failed', resultCode, resultDesc };
}

// Pulls the useful fields out of an STK callback body. Returns null if it isn't one.
export function parseCallback(body) {
  const cb = body?.Body?.stkCallback;
  if (!cb?.CheckoutRequestID) return null;
  const items = Object.fromEntries(
    (Array.isArray(cb.CallbackMetadata?.Item) ? cb.CallbackMetadata.Item : [])
      .filter((item) => item?.Name && item.Value !== undefined && item.Value !== null)
      .map((item) => [item.Name, item.Value]),
  );
  return {
    checkoutRequestId: String(cb.CheckoutRequestID),
    merchantRequestId: cb.MerchantRequestID ? String(cb.MerchantRequestID) : undefined,
    resultCode: Number(cb.ResultCode),
    resultDesc: cb.ResultDesc,
    amount: items.Amount !== undefined ? Number(items.Amount) : undefined,
    receipt: items.MpesaReceiptNumber !== undefined ? String(items.MpesaReceiptNumber) : undefined,
    phone: items.PhoneNumber !== undefined ? String(items.PhoneNumber) : undefined,
    transactionDate: items.TransactionDate !== undefined ? String(items.TransactionDate) : undefined,
  };
}
