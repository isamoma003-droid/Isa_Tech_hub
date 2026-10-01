# ISA Tech Hub

**One M-Pesa till, many platforms.** The Hub is the only thing that talks to Safaricom. egertickets.com, A-Read and any future or partner platform ask the Hub for payments. The Hub sends the M-Pesa PIN prompt, works out how each one ended, records the money in one place, and tells the platform. An admin dashboard shows all of it and is where new platforms are onboarded.

```
 egertickets ──┐   POST /v1/payments (API key)          ┌──────────────────┐
 A-Read ───────┼──────────────────────────────────────►  │  ISA Tech Hub    │──► Daraja STK push ──► payer's phone
 partner ──────┘◄── signed webhook payment.paid/failed ──│  API + dashboard │◄── Safaricom callback (secret URL)
                                                        │  MongoDB         │──► status query: before trusting a
                                                        └──────────────────┘    callback, and every 30 s for
                                                                                 payments whose callback is late
```

Each platform keeps its own data (bookings, books, organizer payouts). The Hub holds only what is shared: tills, platforms, payments, webhook deliveries, dashboard accounts and the audit log.

## What it does

- **Payments API for platforms**: `POST /v1/payments` sends the PIN prompt to a Kenyan number for a Buy Goods till (`CustomerBuyGoodsOnline`) or a Paybill. Idempotency keys stop a retried request from prompting the payer twice. A phone gets one prompt at a time.
- **Payments are settled safely**:
  - Safaricom posts results to a per-till secret URL. A "paid" result counts only after the Hub confirms it with Safaricom's status query, so a forged callback can't release anything.
  - Every state change is a single conditional update, so each platform hears about each outcome once.
  - A payment where M-Pesa reports a different amount is held as **disputed**.
  - The same M-Pesa receipt can never count twice.
  - A late success after a cancel still wins, because the money really moved.
- **Lost callbacks are recovered**: every 30 s the Hub asks Safaricom about pending payments older than 45 s. It also asks when a platform polls a payment that is more than 20 s old. A payment with no answer after 10 minutes is marked failed.
- **Signed webhooks** to each platform (`payment.paid`, `payment.failed`, `payment.disputed`, plus `ping` for testing), retried 9 times over about two days.
- **Dashboard**:
  - Money today, this week and this month, with a per-day chart and a per-platform split.
  - A payments search with filters (date, platform, status, receipt, phone, reference) and CSV export.
  - A per-payment timeline showing what was sent, what Safaricom answered, and every webhook attempt, with "Check with Safaricom" and "Resend webhook" buttons.
  - Platform onboarding: API key and webhook secret shown once, rotate either, send a test webhook, disable a platform.
  - Tills (read-only) and an audit log.
- **Roles**: *admin* can change things; *viewer* is read-only, and phone numbers are masked for viewers.
- **Tills are managed from the server command line only.** A stolen dashboard password cannot send customers' money to a different till. Till credentials are stored encrypted (AES-256-GCM).

## Repository layout

| Part | Stack |
| --- | --- |
| `backend/` | Node.js 22, Express 5, MongoDB (Mongoose), zod. Tests with `node:test` |
| `frontend/` | The dashboard: React 19, Vite, React Router, TanStack Query, lucide icons |
| `sdk/node/isa-hub.cjs` | A one-file, no-dependency client for platforms (CommonJS and ESM) |

```
backend/src/
  routes/v1.js          platform API (API key)
  routes/mpesa.js       Safaricom callbacks
  routes/admin.js       dashboard API (sign-in, stats, payments, platforms, tills, audit)
  services/daraja.js    STK push, status query, callback parsing
  services/payments.js  every payment state change, the background sweep
  services/webhooks.js  signed delivery to platforms, retries
  models/               Till, Platform, Payment, WebhookDelivery, AdminUser, AuditLog
backend/scripts/        admin.js (dashboard accounts), till.js (tills and Daraja credentials)
```

## Run it locally

You need Node.js 22.13+ and MongoDB (local, or a free Atlas cluster).

```bash
npm run install:all
cp backend/.env.example backend/.env      # set MONGODB_URI, JWT_SECRET, HUB_SECRET_KEY
```

Generate `JWT_SECRET` and `HUB_SECRET_KEY` with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. **Keep a copy of `HUB_SECRET_KEY` somewhere safe.** It decrypts the till credentials. If you lose it, re-enter them.

```bash
cd backend
npm run admin:create -- --email you@example.com --name "Your Name"     # prints a temporary password

# A sandbox till (Safaricom's test shortcode 174379). Use the key and secret of a sandbox app
# from developer.safaricom.co.ke → My Apps:
MPESA_CONSUMER_KEY=… MPESA_CONSUMER_SECRET=… npm run till -- add --sandbox --name "Sandbox"
cd ..

npm run dev:backend      # API on http://localhost:5100
npm run dev:frontend     # dashboard on http://localhost:5173
```

Sign in, open **Platforms → Add platform**, choose the till, and copy the API key and webhook secret. Safaricom can only post results to a public HTTPS address, so for end-to-end tests set `PUBLIC_URL` to a tunnel (for example `cloudflared tunnel --url http://localhost:5100`). Without one, the status sweep still settles sandbox payments.

## Going live on the ISA till

1. **Daraja go-live for the Buy Goods till.** On developer.safaricom.co.ke, take the production app live for Lipa na M-Pesa Online on your till. Three things matter:
   - **Store (head office) number.** It signs requests. It is often *not* the till number. egertickets calls it `MPESA_SHORTCODE`.
   - **Till number.** Customers pay into it. egertickets calls it `MPESA_STORE_NUMBER`.
   - **Passkey.** Safaricom emails it at go-live.

   egertickets already uses these, so reuse them.
2. **Host the API somewhere always on.** Safaricom's callbacks to a sleeping server get lost, so don't use a free plan that sleeps. Render Starter, Railway, Fly.io or a VPS all work. The simplest setup is one service that also serves the dashboard:
   ```bash
   npm run install:all && npm run build
   SERVE_CLIENT=true NODE_ENV=production npm start
   ```
   Set `MONGODB_URI` (a database just for the Hub), `JWT_SECRET`, `HUB_SECRET_KEY` and `PUBLIC_URL` (this service's https address). Health check: `/health`.
   To host the dashboard separately (for example on Vercel), build `frontend/` with `VITE_API_URL=https://<api>/api` and set `CLIENT_ORIGIN` on the API to the dashboard's address.
3. **Add the production till** from a machine with the production `.env`:
   ```bash
   cd backend
   MPESA_CONSUMER_KEY=… MPESA_CONSUMER_SECRET=… MPESA_PASSKEY=… \
     npm run till -- add --name "ISA main till" --kind till --env production --shortcode <store number> --till <till number>
   npm run till -- list
   ```
   Nothing needs registering with Safaricom: the callback URL is sent with every prompt.
4. **Create the platforms** in the dashboard (EgerTickets, A-Read), choose the till, and give each platform's server its API key and webhook secret.
5. **Try a real KES 1 payment** before switching a platform over.

Other till commands: `set-credentials`, `deactivate` / `activate`, `rotate-callback-secret` (`npm run till -- <command> --id <till id>`). Dashboard accounts: `node scripts/admin.js list | reset-password | deactivate | activate --email …`. Every command is written to the audit log.

## Connecting a platform

All calls are server-to-server with `Authorization: Bearer isa_sk_…`. **Never put the key in a browser or app.**

| Method & path | Purpose |
| --- | --- |
| `GET /v1/config` | The till to show for "pay from the M-Pesa menu" (`kind`, `payNumber`), and the amount limits |
| `POST /v1/payments` | Start a payment: `{ phone, amount, reference, purpose?, description?, metadata? }`, plus an `Idempotency-Key` header |
| `GET /v1/payments/:id` | Current state (also asks Safaricom when a payment is pending and the callback is late) |
| `GET /v1/payments?reference=&status=&limit=` | The platform's own payments |

A payment looks like this:
```json
{ "id": "…", "platform": "a-read", "reference": "donation-42", "purpose": "donation",
  "amount": 100, "paidAmount": 100, "currency": "KES", "phone": "254712345678",
  "status": "paid", "receipt": "TJ1ABC2DEF", "message": "Payment received",
  "metadata": {}, "createdAt": "…", "paidAt": "…" }
```

`status` is one of `pending`, `paid`, `failed` or `disputed`. `POST /v1/payments` answers `201` (sent) or `200` with `"replayed": true` (same idempotency key). It answers `502` with the failed `payment` when M-Pesa refuses the request, `409` when that phone already has a prompt waiting, and `400` with `details` for invalid input.

**Webhooks** are POSTed as JSON to the platform's webhook URL with these headers:
- `ISA-Event`
- `ISA-Delivery`
- `ISA-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`

Answer with any 2xx. The same payment can move from `failed` to `paid` if a late success arrives, so handle `payment.paid` even after a failure. Process events idempotently by payment id.

With the client in `sdk/node/isa-hub.cjs` (copy it into the platform):

```js
import express from 'express';
import { IsaHub, verifyWebhook } from './isa-hub.cjs';

const hub = new IsaHub({ apiKey: process.env.ISA_HUB_API_KEY, baseUrl: process.env.ISA_HUB_URL });

// Start: send the prompt, then poll hub.getPayment(id) from your "check your phone" page.
const { payment } = await hub.createPayment({
  phone: '0712345678',
  amount: 100,
  reference: 'donation-42',
  purpose: 'donation',
  idempotencyKey: 'donation-42-attempt-1',
});

// Settle: the raw body is needed to check the signature.
app.post('/api/hub/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = verifyWebhook({ secret: process.env.ISA_HUB_WEBHOOK_SECRET, rawBody: req.body, signature: req.get('isa-signature') });
  } catch {
    return res.status(400).end();
  }
  if (event.type === 'payment.paid') markOrderPaid(event.data.payment.reference, event.data.payment.receipt);
  res.status(204).end();
});
```

## Tests

```bash
npm test                                                          # unit tests
MONGODB_URI_TEST=mongodb://127.0.0.1:27017/isa-hub-test npm test  # plus end-to-end API tests
npm run lint
```

The API tests run the real app against a real MongoDB, with Safaricom faked and a local HTTP server standing in for a platform. They cover:
- the exact STK payload for a Buy Goods till, and idempotency;
- callbacks: forged, duplicate, wrong-secret, amount mismatch, and a late success after a cancel;
- the background sweep and the 10-minute give-up;
- polling, signed webhooks and their retries;
- key rotation, disabling a platform and viewer permissions;
- CSV export, the audit log, and the `sdk/` client.

**Use a throwaway database: the tests drop it.**

## Next steps

1. **A-Read → Hub.** A-Read's `/support` page and admin Payments tab already exist with their own Daraja code. Switch `routes/payments.js` to `hub.createPayment` / `hub.getPayment` plus a webhook route, and keep `Payment.hasPaid` reading A-Read's own copy.
2. **egertickets → Hub behind a switch.** Make its STK push go through the Hub when `MPESA_VIA_HUB=true`. On `payment.paid`, call its existing `markPaymentCompleted`, and keep its own callback route up for prompts already in flight. Paystack and organizer payouts stay in egertickets.
3. **Authenticator codes (TOTP) for dashboard sign-in**, as egertickets' superadmin console has.
4. **Payments made from the M-Pesa menu.** Register the till's C2B confirmation URL with the Hub, add an "unmatched payments" queue, and let payers claim a payment by M-Pesa code.
5. **Statement matching**: upload the M-Pesa org-portal statement and flag differences.
6. **Partner reports**: logins limited to one platform, and revenue-share statements.
