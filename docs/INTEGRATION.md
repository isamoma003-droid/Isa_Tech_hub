# ISA Tech Hub — Integration Guide

This document explains how partner platforms integrate with ISA Tech Hub (IsaPay) to accept M‑Pesa payments via a shared till. It gives step‑by‑step code examples, security notes, testing guidance and troubleshooting. Use this file as a reference when porting a platform from a direct Daraja integration to the Hub.

Contents
- Overview
- Quick architecture
- Keys & secrets
- Integration flow (high level)
- Server-side: create a payment (Node/Express example)
- Server-side: webhook handler & verification (Node/Express)
- Idempotency and polling
- SDK (copy-and-use) — how to use sdk/node/isa-hub.cjs
- Environment variables and setup
- Testing and sandbox
- Troubleshooting
- Security best practices
- FAQ

---

Overview

ISA Tech Hub centralises one M‑Pesa till for many platforms. Each platform uses a server‑to‑server API key to ask the Hub to start payments; the Hub performs the STK push with Safaricom (Daraja), tracks payment state and delivers signed webhooks back to the platform. This simplifies platform code: you stop talking to Daraja directly and instead call the Hub API.

Quick architecture

- Platform backend (your server) — calls Hub API (server-to-server). Stores payment reference and Hub payment id.
- ISA Hub API (backend/) — validates platform, creates payment, sends STK push to Safaricom, polls Safaricom when callbacks are late, records payment state and delivers signed webhooks.
- Platform webhook endpoint — receives signed events (`payment.paid`, `payment.failed`, `payment.disputed`, `ping`) and marks orders paid/failed.
- SDK — `sdk/node/isa-hub.cjs` is a one-file Node client you copy into your server to make integration easier.

Keys & secrets

The Hub issues each platform:
- ISA_HUB_API_KEY (aka `isa_sk_...`) — server-only API key. Do NOT put this in browser/mobile apps.
- ISA_HUB_WEBHOOK_SECRET (aka `whsec_...`) — used to verify webhook signatures from the Hub.

Integration flow (high level)

1. In the ISA Hub dashboard add your platform: you will be shown `ISA_HUB_API_KEY` and `ISA_HUB_WEBHOOK_SECRET` once. Save them.
2. On your platform server, configure these two secrets as environment variables.
3. When the user wants to pay, call the Hub's `POST /v1/payments` with { phone, amount, reference, ... } using the API key.
4. Save the returned `payment.id` with your order/booking so you can poll Hub `GET /v1/payments/:id` if needed.
5. The Hub will deliver a signed webhook to your configured webhook URL with event types such as `payment.paid` or `payment.failed`. Verify with HMAC and apply the state change in your system.

Server-side: create a payment (Node/Express example)

This example uses the SDK (recommended). If you prefer plain fetch/axios, the same HTTP call applies (Authorization: Bearer ISA_HUB_API_KEY).

```js
// Copy sdk/node/isa-hub.cjs into your project and require/import it.
const express = require('express');
const { IsaHub } = require('./isa-hub.cjs');

const hub = new IsaHub({ apiKey: process.env.ISA_HUB_API_KEY, baseUrl: process.env.ISA_HUB_URL });
const app = express();
app.use(express.json());

app.post('/api/payments/start', async (req, res) => {
  try {
    const { phone, amount, reference } = req.body; // validate these

    // A stable idempotency key per attempt avoids double prompts on retry
    const idempotencyKey = `order-${reference}-attempt-1`;

    const { payment, replayed } = await hub.createPayment({
      phone,
      amount,
      reference,
      idempotencyKey,
    });

    // Save payment.id on your order so you can correlate webhooks and poll status
    await savePaymentToOrder(reference, payment.id, payment.status);

    res.status(replayed ? 200 : 201).json({ payment, replayed });
  } catch (err) {
    // The SDK throws IsaHubError for non-2xx responses
    console.error(err);
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

// Start server ...
```

Server-side: webhook handler & verification (Node/Express)

The Hub signs webhooks with an `ISA-Signature` header of the form: `t=<unix>,v1=<hex>` where `v1` is HMAC-SHA256 over `<t>.<raw body>` using your webhook secret. Use the bundled `verifyWebhook` helper to validate the signature and parse the event safely. Important: you must use the raw request body for verification.

```js
const express = require('express');
const { verifyWebhook } = require('./isa-hub.cjs');

// Use express.raw so we get the exact bytes received
app.post('/api/payments/hub-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const signatureHeader = req.get('ISA-Signature') || req.get('isa-signature') || req.get('Isa-Signature');
    const event = verifyWebhook({ secret: process.env.ISA_HUB_WEBHOOK_SECRET, rawBody: req.body, signature: signatureHeader });

    // event example: { type: 'payment.paid', data: { payment: { id, reference, receipt, status, amount, ... } } }
    switch (event.type) {
      case 'payment.paid':
        // idempotently update your order to paid
        markOrderPaid(event.data.payment.reference, event.data.payment.receipt);
        break;
      case 'payment.failed':
        markOrderFailed(event.data.payment.reference, event.data.payment.failureReason);
        break;
      case 'payment.disputed':
        flagOrderDisputed(event.data.payment.reference);
        break;
      default:
        console.log('unhandled isa event', event.type);
    }

    // Acknowledge with any 2xx. Use 204 when you don't return a body.
    res.status(204).end();
  } catch (err) {
    console.warn('Invalid webhook signature or payload:', err.message || err);
    res.status(err.status || 400).send('Invalid signature');
  }
});
```

Idempotency and polling

- Provide an `Idempotency-Key` header (or idempotencyKey param) per user attempt. The Hub will return the same payment when the same key is used, preventing duplicate STK prompts.
- Platforms should store the Hub `payment.id` and use `GET /v1/payments/:id` to show the current state to users. The Hub will itself query Safaricom when callbacks are late; platforms only need to poll if they want to update their UI quickly.

SDK (copy-and-use)

- Path in this repo: `sdk/node/isa-hub.cjs`
- It exports: `IsaHub`, `IsaPay` (alias), `IsaHubError`, `verifyWebhook`.
- Usage: copy the file into your codebase, require/import it, instantiate IsaHub with `apiKey` and `baseUrl`.

Example instantiation:
```js
const hub = new IsaHub({ apiKey: process.env.ISA_HUB_API_KEY, baseUrl: process.env.ISA_HUB_URL });
```

Environment variables and setup

Platform server should set at least:
- ISA_HUB_URL — e.g. `https://isa-tech-hub.onrender.com` (the Hub base URL)
- ISA_HUB_API_KEY — `isa_sk_...` (server-only API key)
- ISA_HUB_WEBHOOK_SECRET — `whsec_...` (for verifying webhooks)

Additionally, keep any platform-specific secrets/DB connection strings for your app as usual.

Testing and sandbox

- Use the Hub dashboard to add a platform and request sandbox credentials if available.
- README suggests a sandbox Daraja configuration: set `MPESA_ENV=sandbox` on the Hub side; the Hub will accept sandbox callbacks and you can test real end-to-end with a tunnel to your local server (ngrok/cloudflared) because Safaricom requires a public HTTPS webhook.
- The Hub provides a "Send test webhook" button on the platform page — use it to verify your webhook endpoint responds 2xx and that signature verification passes.

cURL examples (plain HTTP)

Create payment with curl (server-to-server):

```bash
curl -X POST "${ISA_HUB_URL:-https://isa-tech-hub.onrender.com}/v1/payments" \
  -H "Authorization: Bearer ${ISA_HUB_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-123-attempt-1" \
  -d '{"phone":"0712345678","amount":100,"reference":"order-123","purpose":"donation"}'
```

Fetch payment status:

```bash
curl -H "Authorization: Bearer ${ISA_HUB_API_KEY}" "${ISA_HUB_URL}/v1/payments/<paymentId>"
```

Troubleshooting

- 401 Unauthorized from the Hub: check that `Authorization: Bearer <ISA_HUB_API_KEY>` is present and correct.
- Payment says `pending` for long: the Hub polls Safaricom when callbacks are late; if a callback is missing make sure Safaricom can reach the Hub's configured callback URL and that the Hub is not sleeping (Render free-tier may sleep).
- Webhook verification fails: ensure you use the raw request body for HMAC verification (Express must use `express.raw({ type: 'application/json' })` on the webhook route). Check clocks (signature has a timestamp) and the correct webhook secret.
- Duplicate prompts: include an Idempotency-Key and use a stable key for retries.

Security best practices

- Never embed ISA_HUB_API_KEY in any client-side code (browser/mobile). Keep it on the server.
- Keep webhook secret on the server and use timing-safe HMAC verification.
- Use HTTPS everywhere and validate TLS certificates.
- Limit access to the platform's webhook URL and ensure it resolves to a public address (the Hub explicitly refuses private-network URLs).

FAQ

Q: Can I keep my existing Daraja code? 
A: During migration, you can run the Hub side-by-side with your existing Daraja calls but you should avoid sending two STK pushes for the same order. Best practice: switch to the Hub and remove the old Daraja flow after testing.

Q: What fields should I save on my order?
A: Save the Hub `payment.id`, `payment.status`, and `payment.receipt` (when paid). Also save your `idempotencyKey` per attempt.

Q: How do I debug webhook deliveries?
A: The Hub dashboard shows webhook delivery attempts and response codes. Use the "Send test webhook" button to test quickly.

---

Where this file lives and next steps

- File path: `docs/INTEGRATION.md`.

If you want, I can:
- Commit this file into the repository (I will now add it to `docs/INTEGRATION.md`).
- Create a PR instead of committing directly.
- Expand the guide with language-specific SDK examples (PHP, Python, Go) or a Postman collection.
