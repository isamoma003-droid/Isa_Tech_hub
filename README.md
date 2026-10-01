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

## Deploy: API on Render, dashboard on Vercel

| | Where | Folder | Address (example) |
| --- | --- | --- | --- |
| Hub API | Render, Starter plan (always on) | `backend/` | `https://isa-tech-hub-api.onrender.com` |
| Dashboard | Vercel | `frontend/` | `https://isa-tech-hub.vercel.app` |
| Database | MongoDB Atlas | | a new database, e.g. `isa-tech-hub` |

Render and Vercel build from `main` unless you pick another branch, so merge this code into `main` first.

1. **Database.** In Atlas, reuse a cluster (A-Read's is fine) with a new database name. Copy the connection string ending in `/isa-tech-hub`, and allow Render to connect under Network Access (`0.0.0.0/0`, or Render's outbound IPs).
2. **API on Render.** Go to **New → Blueprint**, pick this repo, and Render reads `render.yaml`. It generates `JWT_SECRET` and `HUB_SECRET_KEY`; copy `HUB_SECRET_KEY` somewhere safe as well. It asks for:
   - `MONGODB_URI`: the string from step 1.
   - `CLIENT_ORIGIN`: the Vercel address from step 3 (put a placeholder for now and fix it in step 4).
   - `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`: your first dashboard sign-in (10+ characters).
   - The till: `MPESA_SHORTCODE`, `MPESA_TILL_NUMBER`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_PASSKEY`. These are the same values egertickets already has: its `MPESA_SHORTCODE` (the store / head office number) and its `MPESA_STORE_NUMBER` (the till customers pay). `MPESA_ENV` is preset to `production`.

   On the first start the log says *Created dashboard admin …* and *Added production till …*. Check that `https://<service>.onrender.com/health` answers `{"ok":true}`. Safaricom's callback address is the service's own `https://…onrender.com`, so nothing needs registering with Safaricom.
3. **Dashboard on Vercel.** Go to **Add New → Project**, import this repo, and set **Root Directory** to `frontend` (`frontend/vercel.json` sets Vite, the build and the routing). Add the environment variable `VITE_API_URL` = `https://<service>.onrender.com/api`, then deploy.
   *Repo already linked to a Vercel project from the Next.js starter?* Change that project's Root Directory to `frontend` and add the same variable.
4. **Connect the two.** On Render, set `CLIENT_ORIGIN` to the exact Vercel address (no trailing slash; separate several with commas) and redeploy.
5. **Sign in** at the Vercel address. Change your password under **Account**, then delete `BOOTSTRAP_ADMIN_PASSWORD` on Render. **Tills** should show "ISA main till" with credentials set.
6. **Add the platforms and try a real KES 1 payment** (see [Connecting a platform](#connecting-a-platform)).

**Notes**
- **Changing the till later.** Edit the `MPESA_*` variables on Render and redeploy: the till's credentials update on start, and the change is logged in the audit log.
- **More than one till** (for a partner's own till): `npm run till -- add …` from your computer, with the production `MONGODB_URI` and `HUB_SECRET_KEY` in `backend/.env`, or from Render's Shell. **More dashboard users:** `npm run admin:create -- --email … --name … [--role viewer]`.
- **Custom domains.** If the API gets one (e.g. `hub-api.isatech.co.ke`), set `PUBLIC_URL` to it on Render. For the dashboard, add the domain in Vercel and to `CLIENT_ORIGIN`.
- **Why not Render's free plan?** It sleeps after 15 idle minutes. Then Safaricom's callbacks are lost, the 30-second recovery sweep stops, and a platform's first request takes about a minute while the server wakes up.
- **One server instead of two.** You can skip Vercel: set the Render build command to `npm ci && npm ci --prefix ../frontend && npm run build --prefix ../frontend`, and set `SERVE_CLIENT=true`. The API then serves the dashboard too.

## Run it locally

You need Node.js 22.13+ and MongoDB.

```bash
npm run install:all
cp backend/.env.example backend/.env   # MONGODB_URI, JWT_SECRET, HUB_SECRET_KEY, BOOTSTRAP_ADMIN_*, and a sandbox till
npm run dev:backend                    # API on http://localhost:5100
npm run dev:frontend                   # dashboard on http://localhost:5173
```

For a sandbox till, set:
- `MPESA_ENV=sandbox`
- `MPESA_SHORTCODE=174379`, with `MPESA_TILL_NUMBER` empty
- the passkey shown on the Daraja simulator
- your sandbox app's consumer key and secret

Safaricom can only post results to a public HTTPS address, so for end-to-end tests set `PUBLIC_URL` to a tunnel (e.g. `cloudflared tunnel --url http://localhost:5100`). Without one, the status sweep still settles sandbox payments.

## Connecting a platform

Yes, each platform needs a small code change, not just a key. Today egertickets and A-Read talk to Safaricom themselves. To use the Hub, the platform's **backend** stops calling Daraja and calls the Hub instead, and it gets one new route that receives the Hub's webhooks. The API key is what lets it in, and the webhook secret lets it trust what the Hub sends back.

**1. In the Hub dashboard** (you, once per platform): go to **Platforms → Add platform** and fill in:
- **Name and slug**, e.g. `EgerTickets` / `egertickets`.
- **Till**: ISA main till.
- **Account reference**: the name shown on the payer's prompt, 12 characters max.
- **Webhook URL**: the platform's backend address plus a new route, e.g. `https://<a-read-api>.onrender.com/api/payments/hub-webhook`.

On **Create**, the Hub shows the **API key** (`isa_sk_…`) and the **webhook secret** (`whsec_…`) once. If one is lost, issue a new one from the platform's page; the old key stops working at once.

**2. On the platform's backend host** (e.g. its Render service), add three environment variables. Never put them in the frontend: the API key can start payments into your till.

```
ISA_HUB_URL=https://isa-tech-hub-api.onrender.com
ISA_HUB_API_KEY=isa_sk_…
ISA_HUB_WEBHOOK_SECRET=whsec_…
```

**3. In the platform's backend code**, copy `sdk/node/isa-hub.cjs` into it and make three changes:

| Today (own Daraja code) | With the Hub |
| --- | --- |
| Sends the STK push to Safaricom | `hub.createPayment({ phone, amount, reference: <order id>, purpose, idempotencyKey })`, then save the returned `payment.id` with the order |
| Its own Safaricom callback route | A webhook route that checks the signature with `verifyWebhook(...)`, then marks the order paid or failed |
| "Check status" asks Safaricom | `hub.getPayment(<saved id>)` |

The order, ticket or book logic doesn't change: the webhook handler calls the same "mark paid" code the Safaricom callback calls today.

**4. Test it.** On the platform's page in the dashboard, press **Send test webhook**: the platform must answer 2xx. Then make a real KES 1 payment and watch it under **Payments**: you'll see the prompt, Safaricom's answer and the webhook delivery.

**5. Clean up.** Once it works, remove the Daraja variables (`MPESA_*`) from the platform's host. From then on only the Hub holds the till's credentials.

### API reference

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
app.post('/api/payments/hub-webhook', express.raw({ type: 'application/json' }), (req, res) => {
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
