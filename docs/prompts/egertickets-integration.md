# Prompt: connect egertickets to ISA Tech Hub

Paste everything below the line into a Claude Code session that has the
`supportegertickets-dev/EGERTICKETS` repository attached (with push access).

---

You are working in the egertickets repository (`ticket-booking-system/backend` is an Express 4 + Mongoose app in CommonJS, tested with Jest). Your job: make egertickets take its **M-Pesa STK payments through ISA Tech Hub** instead of calling Safaricom Daraja itself, behind an on/off switch, without changing anything else about how bookings, tickets, Paystack card payments or organizer payouts work.

Work on a new branch, keep the change as small as the job allows, follow the repo's existing style (CommonJS, long explanatory comments on *why*, `[PAYMENT][source]` log labels, phone numbers masked in logs), run the whole Jest suite, and open a pull request. Do not merge it.

## Background: what ISA Tech Hub is

ISA Tech Hub is a separate service that owns the ISA Buy Goods till's Daraja credentials and takes payments for several platforms (egertickets, A-Read, partners). A platform's **backend** calls it with an API key. The Hub then:
- sends the STK push;
- confirms every success with Safaricom's status query before trusting it;
- recovers lost callbacks with a sweep every 30 s, and gives up after 10 minutes with no answer;
- holds amount mismatches as `disputed`, and never counts an M-Pesa receipt twice;
- tells the platform the outcome by a signed webhook, retried for about two days.

The platform never talks to Safaricom for these payments.

### The Hub's API (all calls server-to-server, `Authorization: Bearer <ISA_HUB_API_KEY>`)

| Method & path | Purpose |
| --- | --- |
| `GET /v1/config` | `{ platform, till: { kind, payNumber, accountNumber, environment, active }, limits: { minAmount, maxAmount, currency } }` |
| `POST /v1/payments` | Start a payment. Body `{ phone, amount, reference, purpose?, description?, metadata? }`, header `Idempotency-Key` |
| `GET /v1/payments/:id` | Current state. While pending and overdue, the Hub asks Safaricom before answering |
| `GET /v1/payments?reference=&status=&limit=` | This platform's payments |

Field rules:
- `phone`: any Kenyan format; the Hub normalises it to `2547…`.
- `amount`: a whole number of KES, within the Hub's limits (default 1–150,000).
- `reference`: 1–64 characters. Use the booking id.
- `purpose`: letters, digits, `.`, `-` and `_` only.
- `description`: up to 100 characters.
- `metadata`: at most 20 keys made of letters, digits, `-` and `_`. Values are strings, numbers, booleans or null, at most 2,000 characters of JSON in total.

A Hub payment object:

```json
{ "id": "6abe…", "object": "payment", "platform": "egertickets", "reference": "<booking id>",
  "purpose": "ticket", "description": "…", "amount": 1500, "paidAmount": 1500, "currency": "KES",
  "phone": "254712345678", "status": "paid", "receipt": "TJ1ABC2DEF", "resultCode": 0,
  "message": "Payment received", "metadata": { "paymentId": "…" },
  "createdAt": "…", "paidAt": "…", "failedAt": null }
```

`status` is one of these:
- `pending`
- `paid`
- `failed`, with `resultCode` (e.g. 1032 cancelled, 1037 no answer) and a plain-language `message`
- `disputed`: M-Pesa reported a different amount (`paidAmount`), held for review

A `failed` payment can later become `paid` if a late success arrives. That money really moved, so it must be honoured.

`POST /v1/payments` answers:
- `201 { payment }` when the prompt was sent;
- `200 { payment, replayed: true }` for the same `Idempotency-Key`, with no second prompt;
- `400 { error, details }` for invalid input;
- `401` / `403` for a bad API key or a disabled platform;
- `409 { error }` when this phone already has a prompt waiting (for any platform);
- `502 { error, payment }` when Safaricom refused the request (the payment is already `failed`);
- `503` when the till is unavailable.

### Webhooks from the Hub

The Hub POSTs JSON to the URL registered for egertickets in the Hub dashboard, with these headers:
- `ISA-Event`: `payment.paid` | `payment.failed` | `payment.disputed` | `ping`
- `ISA-Delivery`
- `ISA-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with ISA_HUB_WEBHOOK_SECRET>`

The body is `{ "id": "evt_…", "type": "payment.paid", "createdAt": "…", "data": { "payment": { …payment object… } } }`. `ping` has `data: { platform, message }`. Any 2xx counts as delivered. Anything else is retried (1, 5, 15 min, 1, 3, 6, 12, 24 h), so return 5xx on a transient error you want retried, and 2xx once the event is handled or safely ignorable. Events can repeat: handling must be idempotent.

Use the client below rather than hand-rolling HTTP or HMAC. Create it **verbatim** as `ticket-booking-system/backend/src/services/isa-hub.cjs` and require it from CommonJS (`require('./isa-hub.cjs')`). `verifyWebhook` needs the **raw** request bytes.

```js
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
```

## What to build

### 1. Configuration

Add these environment variables to `backend/.env.example`:
- `MPESA_VIA_HUB` (`true` to switch on; anything else means off)
- `ISA_HUB_URL` (e.g. `https://isa-tech-hub-api.onrender.com`)
- `ISA_HUB_API_KEY` (`isa_sk_…`)
- `ISA_HUB_WEBHOOK_SECRET` (`whsec_…`)

Add a small `src/services/isaHub.js` that exposes:
- `hubEnabled()`: `MPESA_VIA_HUB === 'true'` and all three `ISA_HUB_*` set;
- a lazily created `IsaHub` client;
- `applyHubPayment(payment, hubPayment, source)`: the single place a Hub payment's state is applied to an egertickets `Payment` (see 4).

When `MPESA_VIA_HUB` is off, egertickets must behave **exactly** as today.

### 2. Starting a payment: `src/controllers/mpesaController.js`, `initiateStkPushInternal`

Every STK prompt goes through this one function: the checkout page via `POST /api/payments/mpesa/initiate`, `paymentController.initiatePayment`, the WhatsApp bot (`botPaymentController`), and group payments (`requestShare` in `services/splitPaymentService.js`). Keep these as they are:
- the kill switch `platformSettings.assertEnabled('mpesaPayments')`;
- booking lookup and validation;
- the 254XXXXXXXXX phone check;
- the "supersede earlier pending attempts" logic, including the `shareId` rule.

When `hubEnabled()`:
- Create the `Payment` **before** calling the Hub (status `pending`, `paymentMethod: 'mpesa'`, `paymentGateway: 'IsaHub'`, `metadata.shareId` as today), so its `_id` can be the idempotency key.
- Call `hub.createPayment()` with:
  - `phone`;
  - `amount: Math.round(amount)`;
  - `reference: String(bookingId)`;
  - `purpose: options.shareId ? 'group-share' : 'ticket'`;
  - `description: options.transactionDesc` (trimmed to 100 characters);
  - `idempotencyKey: String(payment._id)`;
  - `metadata: { paymentId: String(payment._id), bookingId: String(bookingId), shareId: options.shareId ? String(options.shareId) : null }`.
- Save the Hub's payment id as `payment.reference`, and also in `payment.metadata.hubPaymentId`. `reference` is what `verifyPaymentStatus` and the bot already look payments up by.
- **Return the same shape as today**, so callers don't change: `{ resp: { MerchantRequestID: <hub id>, CheckoutRequestID: <hub id>, ResponseCode: '0', ResponseDescription: 'Success. Request accepted for processing', CustomerMessage: 'Success. Request accepted for processing' }, payment }`. The web checkout, `botPaymentController` (`resp.CheckoutRequestID`) and `bot/handlers/paymentHandler.js` read `CheckoutRequestID`.
- On `IsaHubError`:
  - mark the new Payment `failed` and keep the Hub's error in `metadata`;
  - throw with a `statusCode` the existing route handler understands: `409` with the Hub's message, `400` with the Hub's message, or `502` for everything else (including network errors);
  - the customer-facing wording should match today's "Mpesa initiation failed" handling.
- Never log the API key. Mask phones with the existing `maskMsisdn`.

### 3. Receiving the Hub's webhooks (new public route)

Add `POST /api/payments/isa-hub/webhook` to `routes/paymentRoutes.js`. Like the existing M-Pesa callback and Paystack webhook:
- no auth middleware;
- add the path to `RAW_BODY_PATHS` in `server.js`, so `req.rawBody` is kept;
- exempt it from the general `/api/` rate limiter by adding it to `PROVIDER_CALLBACK_PATHS` in `server.js`, next to `/api/payments/mpesa/callback`, because a throttled webhook looks like a payment that never happened.

The handler:
- Return `404` if `!hubEnabled()`.
- `verifyWebhook({ secret, rawBody: req.rawBody, signature: req.get('isa-signature') })`. Answer `400` if it throws.
- `ping`: `204`.
- Payment events:
  - find the `Payment` by `{ reference: data.payment.id }`, or else by `_id === data.payment.metadata.paymentId`;
  - call `applyHubPayment`, then answer `204`;
  - unknown payment: log it at error level with the ids, and answer `204` (retrying won't help);
  - unexpected errors (database down): answer `500` so the Hub retries.

### 4. `applyHubPayment` (mapping the Hub's status onto egertickets)

Reuse `services/paymentStatusService.js`. Don't duplicate its logic.

- **`paid`:** call `markPaymentCompleted({ payment, transactionId: hub.receipt || hub.id, paidAmount: hub.paidAmount ?? hub.amount, payerPhone: hub.phone, providerMeta: { hubPaymentId: hub.id, receipt: hub.receipt }, source })`. It is already idempotent: it confirms the booking, records group shares and delivers tickets once. It also works after a failure, which covers a late success.
- **`failed`:** call `markPaymentFailed({ payment, resultCode: hub.resultCode, resultDesc: hub.message, source })`.
- **`disputed`:** if the Payment isn't `completed`, set `status: 'disputed'` and `metadata.amountMismatch = { expected: hub.amount, received: hub.paidAmount, at }`, as `markPaymentCompleted` does for its own mismatch check. Log it loudly. Don't confirm the booking.
- **`pending`:** do nothing.

### 5. Status checks and the reconciliation sweep

- `resolvePendingMpesaPayment` in `services/paymentStatusService.js`: when `payment.paymentGateway === 'IsaHub'`, call `hub.getPayment(payment.reference)` and `applyHubPayment` instead of `mpesaClient.queryStkPushStatus`. Keep the return shape (`{ state: 'success'|'failed'|'pending'|'unknown', resultCode, resultDesc, … }`). This automatically covers `POST /api/payments/verify-status` and the reconciliation cron.
- `services/paymentReconciliationService.js` currently skips the whole sweep when `!mpesaClient.isConfigured()`. Change it so the sweep runs when **either** Daraja is configured **or** `hubEnabled()`, and so a Hub payment never needs Daraja credentials. Otherwise removing egertickets' own Daraja keys would silently stop recovery of Hub payments.
- Keep the legacy Safaricom callback route working for direct payments already in flight when the switch flips.

### 6. Things that must not change

- Paystack (cards), its webhook, and its verify redirect.
- Organizer payouts (Paystack transfers and M-Pesa B2C in `mpesaB2cService.js`). B2C still uses egertickets' own `MPESA_CONSUMER_KEY/SECRET` and `MPESA_B2C_*`, so document that those must stay set while B2C is used.
- The admin-only Daraja tools in `paymentRoutes.js` (reversal, balance and so on).
- Booking holds, expiry and inventory.
- With `MPESA_VIA_HUB` off: everything, byte for byte.

### 7. Nice to have, if small

On the superadmin console's **System health** page, add an "ISA Tech Hub" check that calls `GET /v1/config`. Show reachable or not, the till's pay number, and whether `MPESA_VIA_HUB` is on. Never show the key.

### 8. Tests (Jest; follow `test/mpesaCallback.test.js` for mocking style)

- **Initiate via the Hub:** the payload sent to `createPayment` (reference, idempotency key = Payment id, rounded amount, metadata). The returned `resp.CheckoutRequestID` is the Hub id, and `Payment.reference` is the Hub id. Each Hub error maps to its status code (409, 400, 502 and network), with the Payment marked failed.
- **Switch off:** the Daraja path is still used, unchanged.
- **Webhook:**
  - a bad signature gets 400; `ping` gets 204;
  - `payment.paid` calls `markPaymentCompleted` with the receipt and is idempotent on redelivery;
  - `payment.failed` calls `markPaymentFailed`; `paid` after `failed` completes;
  - `payment.disputed` sets disputed; an unknown payment gets 204;
  - a database error gets 500;
  - the route is reachable without auth and isn't rate-limited.
- **Status and sweep:** `resolvePendingMpesaPayment` uses the Hub for `IsaHub` payments, and the sweep runs with the Hub on and no Daraja credentials.
- Run the full suite (`cd ticket-booking-system/backend && npm test`). Every existing test must still pass.

### 9. Docs

- Update `src/docs/PAYMENTS_AND_PAYOUTS.md` (M-Pesa flow) and the env example with the switch, the new route and the rollout below.
- Put the rollout steps in the PR description.

## Rollout (include in the PR description)

1. In the ISA Tech Hub dashboard, go to **Platforms → Add platform**:
   - Name: EgerTickets; slug: `egertickets`.
   - Till: ISA main till.
   - Account reference: `EgerTickets`.
   - Webhook URL: `https://<egertickets API host>/api/payments/isa-hub/webhook`.

   Copy the API key and webhook secret.
2. On egertickets' backend host, set `ISA_HUB_URL`, `ISA_HUB_API_KEY` and `ISA_HUB_WEBHOOK_SECRET`, with `MPESA_VIA_HUB=false`. Deploy.
3. Flip `MPESA_VIA_HUB=true`.
4. In the Hub, press **Send test webhook**. Expect HTTP 204 from egertickets.
5. Buy a KES 1 ticket (or a test event). It should appear in egertickets as paid, with the ticket delivered, and in the Hub's **Payments** with the webhook delivered.
6. **Rollback** is `MPESA_VIA_HUB=false`. Payments already started through the Hub still settle, because the webhook route and the status checks keep working while the `ISA_HUB_*` variables are set.
7. After a quiet day, egertickets' own Daraja STK settings (`MPESA_PASSKEY`, `MPESA_STORE_NUMBER`, `MPESA_CALLBACK_URL`) can be removed. Keep `MPESA_CONSUMER_KEY/SECRET` and `MPESA_SHORTCODE` while M-Pesa B2C payouts use them.
