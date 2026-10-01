'use strict';
// ISA Tech Hub client for a platform's Node.js server (Node 18+, no dependencies).
// Copy this one file into your project. It works from CommonJS and from ES modules:
//
//   const { IsaHub, verifyWebhook } = require('./isa-hub.cjs');   // CommonJS (egertickets)
//   import { IsaHub, verifyWebhook } from './isa-hub.cjs';         // ES modules (A-Read)
//
//   const hub = new IsaHub({ apiKey: process.env.ISA_HUB_API_KEY, baseUrl: process.env.ISA_HUB_URL });
//   const { payment } = await hub.createPayment({ phone: '0712345678', amount: 100, reference: 'order-123' });
//
// Never use the API key in a browser or a mobile app: it can start payments into your till.

const crypto = require('node:crypto');

class IsaHubError extends Error {
  constructor(message, { status, details, payment } = {}) {
    super(message);
    this.name = 'IsaHubError';
    this.status = status; // HTTP status, or 0 if the Hub couldn't be reached
    this.details = details; // field-level validation problems, when there are any
    this.payment = payment; // set when the payment was recorded but M-Pesa refused it (502)
  }
}

class IsaHub {
  constructor({ apiKey, baseUrl, timeoutMs = 30_000 } = {}) {
    if (!apiKey) throw new Error('IsaHub: apiKey is required');
    if (!baseUrl) throw new Error('IsaHub: baseUrl is required, e.g. https://hub.example.com');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, { body, headers = {} } = {}) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new IsaHubError(`Could not reach ISA Tech Hub: ${err.message}`, { status: 0 });
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      // empty or non-JSON body
    }
    if (!res.ok) {
      throw new IsaHubError(data?.error || `ISA Tech Hub answered HTTP ${res.status}`, {
        status: res.status,
        details: data?.details,
        payment: data?.payment,
      });
    }
    return data;
  }

  // The till customers pay into and the amount limits, for "pay from the M-Pesa menu" text.
  config() {
    return this.request('GET', '/v1/config');
  }

  /**
   * Sends the M-Pesa PIN prompt to `phone`. Resolves to { payment, replayed }.
   * Pass a stable idempotencyKey per attempt (e.g. `${orderId}-${attempt}`): retrying the call
   * with the same key returns the same payment instead of prompting the payer again.
   */
  createPayment({ phone, amount, reference, purpose, description, metadata, idempotencyKey }) {
    return this.request('POST', '/v1/payments', {
      body: { phone, amount, reference, purpose, description, metadata },
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    });
  }

  // Current state of a payment. While it's pending, the Hub also asks Safaricom when needed.
  getPayment(id) {
    return this.request('GET', `/v1/payments/${encodeURIComponent(id)}`);
  }

  listPayments({ reference, status, limit } = {}) {
    const query = new URLSearchParams(Object.entries({ reference, status, limit }).filter(([, v]) => v !== undefined && v !== ''));
    const qs = query.toString();
    return this.request('GET', `/v1/payments${qs ? `?${qs}` : ''}`);
  }
}

/**
 * Checks a webhook from the Hub and returns the parsed event.
 * `rawBody` must be the exact bytes received (string or Buffer), not re-serialised JSON:
 * in Express, use express.raw({ type: 'application/json' }) on the webhook route.
 * Throws if the signature is wrong or older than `toleranceSeconds` (stops replays).
 */
function verifyWebhook({ secret, rawBody, signature, toleranceSeconds = 300 }) {
  if (!secret) throw new Error('verifyWebhook: secret is required');
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
  const parts = Object.fromEntries(
    String(signature || '')
      .split(',')
      .map((part) => part.trim().split('='))
      .filter((pair) => pair.length === 2),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || !parts.v1) throw new IsaHubError('Missing or malformed ISA-Signature header', { status: 400 });
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) throw new IsaHubError('Webhook signature is too old', { status: 400 });

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const given = Buffer.from(parts.v1);
  if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(expected), given)) {
    throw new IsaHubError('Webhook signature does not match', { status: 400 });
  }
  return JSON.parse(body);
}

module.exports = { IsaHub, IsaHubError, verifyWebhook };
