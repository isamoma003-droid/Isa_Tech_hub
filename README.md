# IsaPay (ISA Tech Hub)

**IsaPay is ISA Tech's M-Pesa payment gateway: one place that takes M-Pesa payments for every platform**, ours (egertickets.com, A-Read) or a partner's that uses IsaPay as its payment gateway. It runs on the ISA Tech Hub code in this repo (the code, the API key prefix `isa_sk_` and the `ISA-*` webhook headers keep their names, so existing integrations don't change).

Businesses can also **sign up themselves** (email and password, or Google) and use IsaPay as their M-Pesa gateway: each sees only its own platforms, tills and payments, and takes live payments once an ISA Tech admin approves it.

The Hub is the only thing that talks to Safaricom. egertickets.com, A-Read and any future or partner platform ask the Hub for payments. The Hub sends the M-Pesa PIN prompt, works out how each one ended, records the money in one place, and tells the platform. An admin dashboard shows all of it and is where new platforms are onboarded.

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
  - A payments search with filters (date, platform, status, M-Pesa confirmation code, phone, reference) and CSV export.
  - A per-payment timeline showing what was sent, what Safaricom answered, and every webhook attempt, with "Check with Safaricom" and "Resend webhook" buttons.
  - Platform onboarding: API key and webhook secret shown once, rotate either, send a test webhook, disable a platform.
  - Hosted **Payment links**: create fixed-amount or customer-entered KES links, choose reusable or single-use, share a secure M-Pesa checkout, and track the Safaricom-issued confirmation code with each payment (no customer-entered reference).
  - Numbered M-Pesa tills ("M-Pesa till 1", "M-Pesa till 2"…), each with its own numbered Daraja keys, and an audit log.
  - A **Developers** page for partners: the API base URL, endpoints, webhook signature checks in Node.js, PHP and Python, and a download of the Node.js client.
  - **Installable as an app** on Windows, macOS, Android and iPhone (see [Install the dashboard as an app](#install-the-dashboard-as-an-app)).
- **Accounts** (see [Accounts: sign-up, Google sign-in and merchants](#accounts-sign-up-google-sign-in-and-merchants)):
  - Businesses open a **merchant** account themselves at `/register`, with email and password or **Sign in with Google**.
  - Each merchant sees only its own platforms, tills, payments, invoices and activity.
  - Live payments start once an admin approves the business; a sandbox till works before that.
  - Password reset and email confirmation by email (Brevo or legacy SMTP), a public support form, and an **Accounts** page where the team approves merchants and manages people.
- **Roles**: *admin* can change everything; *viewer* is read-only, and phone numbers are masked for viewers; *merchant* changes only its own things.
- **Tills** are numbered, and each till's Daraja keys carry its number, so keys for different tills never overlap:

  | | On Render | In the dashboard |
  | --- | --- | --- |
  | Till 1 | `MPESA_SHORTCODE`, `MPESA_TILL_NUMBER`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_PASSKEY` | M-Pesa consumer key 1 |
  | Till 2 | `MPESA_SHORTCODE_2`, `MPESA_TILL_NUMBER_2`, `MPESA_CONSUMER_KEY_2`, `MPESA_CONSUMER_SECRET_2`, `MPESA_PASSKEY_2` | M-Pesa consumer key 2 |
  | Till N | the same names ending in `_N` (plus optional `MPESA_ENV_N`, `MPESA_TILL_NAME_N`) | M-Pesa consumer key N |

  Admins can also add a till in the dashboard (**M-Pesa tills → Add till**); it gets the next free number. A set of `MPESA_*_N` variables never takes over a till that was added in the dashboard or from the command line: the log says so and names the next free number. Admins can correct a till in the dashboard (**Tills → Edit till**): its name, Buy Goods or Paybill, live or sandbox, store number, till number, on/off, and its Daraja keys. These numbers decide where customers' money goes, so:
  - every save asks for the admin's password again (rate-limited);
  - every save is written to the audit log (numbers from → to; keys only by name);
  - the keys are write-only: they're stored encrypted (AES-256-GCM) and never shown, only replaced;
  - **Check Daraja sign-in** confirms the consumer key and secret.

  For each field, the latest change wins: a dashboard edit survives restarts, and a later change to the matching `MPESA_*` variable on Render is applied on the next start.

## Making money: IsaPay billing

IsaPay charges the partner platforms that use it. Your own platforms (ownership "own", e.g. egertickets and A-Read) pay nothing.

| Partner's money lands in | How they pay IsaPay | Collected |
| --- | --- | --- |
| **Your till** (till owner "ISA Tech") | **1.5%** of each payment received | At once: the money is already in your till. You send the partner the rest; **Billing → Payouts to send** lists it, and **Payout sent** records the reference. |
| **Their own till** (till owner "a partner") | **KES 1,000 a month** subscription | Invoiced after the month ends. **Request M-Pesa** sends a prompt to the partner's billing number, paid into your ISA till; the invoice is marked paid automatically. **Mark paid** records a payment made another way. |

- **Free tier:** the first KES 10,000 of payments each month is free: no percentage on it, and no subscription for a month that stays under it.
- **Unpaid subscriptions:** due 7 days after the month ends, shown as overdue on the dashboard; 14 days after that, the platform's `POST /v1/payments` answers **402** until it pays. **Extra grace until** on the platform's page lets it keep going while you sort it out.
- **Invoices are written automatically** within an hour of a month ending (or press **Invoice <month> now**). Each month is invoiced once per platform, and every invoice action is in the audit log. Billing starts with the month this version is first deployed, so nobody is billed for earlier months (`BILLING_START_MONTH=YYYY-MM` changes that).
- **Prices:** defaults come from `BILLING_PERCENT`, `BILLING_MONTHLY_FEE`, `BILLING_FREE_AMOUNT`, `BILLING_DUE_DAYS` and `BILLING_GRACE_DAYS` on Render. Any platform can have its own plan and price (**Platforms → a platform → Billing**).
- **Partners can see and pay their bill** through the API: `GET /v1/billing` and `POST /v1/billing/invoices/<number>/pay` (see the Developers page).
- Subscription payments are collected through a built-in platform called **IsaPay billing**, created on first use and pointed at your first active ISA till, so they appear under Payments like any other.

## Accounts: sign-up, Google sign-in and merchants

Anyone can open a merchant account from the sign-in page (**Create a merchant account**, at `/register`). Set `SIGNUP=false` on Render to close sign-up.

| | ISA Tech team (admin, viewer) | Merchant (a business that signed up) |
| --- | --- | --- |
| Sees | Everything | Its own platforms and tills, their payments, invoices and webhooks, and its own activity log |
| Platforms | Adds any, on any till; sets prices; enables and disables | Adds up to 10, on **IsaPay's till** (IsaPay collects, keeps the % fee, pays out the rest) or **its own till** (money goes straight to it; monthly subscription) |
| Tills | All, numbered (`MPESA_*_N`) | Up to 5 of its own, unnumbered, always "partner's own" |
| Billing | Prices, invoices, mark paid, void, payouts | Sees its plan and invoices; **Pay with M-Pesa** on its own invoices; sees payouts owed to it |
| Accounts page | Admins approve or reject merchants, add team members or merchants (temporary password shown once), reset passwords, deactivate; viewers look | — |

**Approval.** A new merchant can do everything except take live payments: until an admin approves it under **Accounts**, `POST /v1/payments` on a production till answers **403**, while a sandbox till works, so the integration can be built and tested meanwhile. The merchant sees a banner and a "Get started" checklist. Admins see "N businesses waiting for approval" on the Overview and are emailed when one signs up. Rejecting asks for a note, which the merchant sees and is emailed. Deactivating a merchant signs it out and stops its platforms at once.

**Sign in with Google.** The dashboard shows Google's button when `GOOGLE_CLIENT_ID` is set. The API checks Google's signed ID token against Google's published keys (RS256, our client ID, issued by Google, unexpired, verified email). A Google account:
- signs in to the account it is linked to;
- or links to an existing account with the same address, but only when Google is the authority for that address (a Gmail address, or a Google Workspace domain); otherwise the person signs in with their password and links Google under **Your account**;
- or, if no account has that email, opens a new merchant account.

People who only use Google can add a password under Your account; IsaPay asks for it again before any till change.

**Email.** With Brevo configured (`MAIL_PROVIDER=brevo`, `BREVO_API_KEY`, and a verified `MAIL_FROM` sender), IsaPay sends branded, mobile-friendly HTML emails with a plain-text fallback:
- password-reset links (one-time, valid for an hour, and they sign out every other session);
- email-confirmation links;
- admins when a business signs up;
- merchants when they're approved or not;
- merchants whenever their payout details change.
- support-form submissions to `SUPPORT_EMAIL`, with replies directed to the sender;
- checkout receipts to customers when the payment link collects an email address and M-Pesa confirms payment.

Email templates use IsaPay branding, inline styles for email-client compatibility, clear action buttons, and escaped customer-provided content. Account security messages, support requests, payout alerts, onboarding decisions, and payment receipts share the same layout.

Legacy SMTP remains available with `MAIL_PROVIDER=smtp` and `SMTP_URL`. Set `SUPPORT_PHONE` for the contact page; replace the documented placeholder address/phone with monitored business contacts. Set `APP_URL` if email links should point somewhere other than `CLIENT_ORIGIN`. Without an email provider, admins use **New temporary password** and **Mark email confirmed** on the account's page, and the support page shows its direct contact details.

For payment-receipt issues, Render logs include structured `payment.callback_*`, `payment.receipt_*`, and `payment.receipt_email_*` events, plus email provider/configuration events. These report payment IDs, callback result codes, attempt counts, and whether a receipt was present, but never log full receipt codes, customer contact details, or provider credentials. Check for `payment.callback_unreadable`/`payment.callback_unknown_request` if no callback was matched, `payment.receipt_not_saved` if the dashboard couldn't receive the code, and `payment.receipt_email_failed` or `email.provider_rejected` for delivery failures. Deploy the updated backend before relying on these events.

**Hosted payment links.** In the dashboard, open **Payment links → Create link**, choose a platform, and set a fixed KES amount or a payer-entered amount range. Choose reusable or single-use, and whether checkout collects the payer's name and email (for a receipt). Customers don't enter a reference; once Safaricom confirms payment, IsaPay records and displays its M-Pesa confirmation code in checkout, the dashboard, CSV export, customer receipt email, and platform webhooks. For payment-link transactions, the dashboard's Reference column shows that code after confirmation; the API `reference` remains the generated link identifier for compatibility. Payment links can be edited or deleted from the dashboard; deletion disables the checkout URL but keeps payment history. Copy and share the `https://<dashboard>/pay/<link-slug>` URL.

**Your account** (every user): name and phone; for merchants, business details and **payout details** (M-Pesa number or bank account, where IsaPay sends money it collected for them, shown to admins next to each payout to send); set or change the password; link or unlink Google; resend the email confirmation; **sign out everywhere else**.

**Safety.**
- Every query a merchant makes is limited to its own records server-side; another merchant's ids answer 404.
- Merchants can't change prices, enable or disable platforms, or move a platform to another account.
- A merchant's webhook URL must be a public `https://` address. Before each delivery the Hub checks it doesn't resolve to a private network (no requests to the server itself or the host's internal network).
- Sign-in, sign-up and email endpoints are rate-limited.
- Every sign-in, account change, approval and payout-detail change is in the audit log. Merchants see their own history, with IsaPay staff shown as "IsaPay team".

### Setting up Google sign-in

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create (or pick) a project, then **Create credentials → OAuth client ID → Web application**. You may be asked to fill in the OAuth consent screen first: app name "IsaPay", your support email.
2. Under **Authorised JavaScript origins**, add the dashboard's exact address, e.g. `https://isa-tech-hub.vercel.app`, plus `http://localhost` and `http://localhost:5173` for development. No redirect URIs are needed.
3. Copy the client ID (`….apps.googleusercontent.com`) into `GOOGLE_CLIENT_ID` on Render and redeploy. The dashboard reads it from the API, so Vercel needs no change.

The dashboard sends `Referrer-Policy: strict-origin-when-cross-origin` (in `frontend/vercel.json`, and from the API when it serves the dashboard), because Google checks the page's origin. Keep it that way: `no-referrer` breaks the Google button.

### Setting up email

Brevo is the recommended provider. In Brevo, create a transactional API key and verify the sender email/domain. Configure:

```env
MAIL_PROVIDER=brevo
BREVO_API_KEY=your-brevo-api-key
MAIL_FROM=IsaPay <no-reply@your-verified-domain.example>
SUPPORT_EMAIL=support@your-domain.example
SUPPORT_PHONE=+254 700 000 000
```

Set these on Render (the key is a secret) or in `backend/.env` locally. `MAIL_FROM` must be a verified Brevo sender. Password-reset and account messages, contact-form submissions, and checkout receipts all use this provider. Email links point at the first `CLIENT_ORIGIN`, or `APP_URL` if set.

Existing SMTP deployments remain supported with `MAIL_PROVIDER=smtp`, `SMTP_URL`, and `MAIL_FROM`. For Gmail, turn on 2-step verification and create an **app password** (Google Account → Security → App passwords), then configure `SMTP_URL=smtps://you%40gmail.com:<app password>@smtp.gmail.com:465`.

## Repository layout

| Part | Stack |
| --- | --- |
| `backend/` | Node.js 22, Express 5, MongoDB (Mongoose), zod. Tests with `node:test` |
| `frontend/` | The dashboard: React 19, Vite, React Router, TanStack Query, lucide icons; installable (PWA: `public/manifest.webmanifest`, `public/sw.js`) |
| `sdk/node/isa-hub.cjs` | A one-file, no-dependency client for platforms (CommonJS and ESM) |

```
backend/src/
  routes/v1.js          platform API (API key)
  routes/mpesa.js       Safaricom callbacks
  routes/auth.js        dashboard sign-in, sign-up, Google, password reset, your account
  routes/admin.js       dashboard API (stats, payments, platforms, tills, billing, accounts, audit),
                        every query scoped to the merchant when a merchant asks
  services/daraja.js    STK push, status query, callback parsing
  services/payments.js  every payment state change, the background sweep
  services/webhooks.js  signed delivery to platforms, retries
  services/google.js    checks "Sign in with Google" ID tokens with Google's keys
  services/mailer.js    email over SMTP_URL (or a log line when it's not set)
  services/accounts.js  one-time email links, sign-up and approval emails
  models/               Till, Platform, Payment, PaymentLink, WebhookDelivery, AdminUser (team and merchants),
                        AuthToken (email links), AuditLog, Invoice
  utils/network.js      keeps merchants' webhook URLs on the public internet
  services/billing.js   plans, monthly invoices, M-Pesa collection, suspension when unpaid
  services/keepAlive.js keeps a free Render service awake
backend/scripts/        admin.js (dashboard accounts), till.js (tills and Daraja credentials)
```

## Deploy: API on Render, dashboard on Vercel

| | Where | Folder | Address (example) |
| --- | --- | --- | --- |
| Hub API | Render: free plan with keep-alive for now, Starter (always on) later | `backend/` | `https://isa-tech-hub.onrender.com` |
| Dashboard | Vercel | `frontend/` | `https://isa-tech-hub.vercel.app` |
| Database | MongoDB Atlas | | a new database, e.g. `isa-tech-hub` |

Render and Vercel build from `main` unless you pick another branch, so merge this code into `main` first.

1. **Database.** In Atlas, reuse a cluster (A-Read's is fine) with a new database name. Copy the connection string ending in `/isa-tech-hub`, and allow Render to connect under Network Access (`0.0.0.0/0`, or Render's outbound IPs).
2. **API on Render.** Go to **New → Blueprint**, pick this repo, and Render reads `render.yaml`. It generates `JWT_SECRET` and `HUB_SECRET_KEY`; copy `HUB_SECRET_KEY` somewhere safe as well. It asks for:
   - `MONGODB_URI`: the string from step 1.
   - `CLIENT_ORIGIN`: the Vercel address from step 3 (put a placeholder for now and fix it in step 4).
   - `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`: your first dashboard sign-in (10+ characters). Use your Gmail address and you can later sign in with Google too.
   - Optional: `GOOGLE_CLIENT_ID` for "Sign in with Google", `SMTP_URL` and `MAIL_FROM` for email (see [Setting up Google sign-in](#setting-up-google-sign-in) and [Setting up email](#setting-up-email)). Both can be added later.
   - The till: `MPESA_SHORTCODE`, `MPESA_TILL_NUMBER`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_PASSKEY`. These are the same values egertickets already has: its `MPESA_SHORTCODE` (the store / head office number) and its `MPESA_STORE_NUMBER` (the till customers pay). `MPESA_ENV` is preset to `production`.

   On the first start the log says *Created dashboard admin …* and *Added production till …*. Check that `https://<service>.onrender.com/health` answers `{"ok":true}`. Safaricom's callback address is the service's own `https://…onrender.com`, so nothing needs registering with Safaricom.
3. **Dashboard on Vercel.** Go to **Add New → Project**, import this repo, and set **Root Directory** to `frontend` (`frontend/vercel.json` sets Vite, the build and the routing). Add the environment variable `VITE_API_URL` = `https://<service>.onrender.com/api`, then deploy.
   *Repo already linked to a Vercel project from the Next.js starter?* Change that project's Root Directory to `frontend` and add the same variable.
4. **Connect the two.** On Render, set `CLIENT_ORIGIN` to the exact Vercel address (no trailing slash; separate several with commas) and redeploy.
5. **Sign in** at the Vercel address. Change your password under **Account**, then delete `BOOTSTRAP_ADMIN_PASSWORD` on Render. **Tills** should show "ISA main till" with credentials set.
6. **Add the platforms and try a real KES 1 payment** (see [Connecting a platform](#connecting-a-platform)).

**Notes**
- **Changing the till later.** The easiest way is **Tills → Edit till** in the dashboard; the change applies from the next payment. Changing an `MPESA_*` variable on Render also works: it's applied on the next start. Either way the till keeps its id, so its platforms follow along, and the change is in the audit log.
- **More than one till** (for a partner's own till): **M-Pesa tills → Add till** in the dashboard, or the numbered `MPESA_*_2` variables on Render, or `npm run till -- add …` from your computer with the production `MONGODB_URI` and `HUB_SECRET_KEY` in `backend/.env`. **More dashboard users:** **Accounts → Add account** in the dashboard (or `npm run admin:create -- --email … --name … [--role viewer]`). Businesses sign up themselves at `/register`.
- **Custom domains.** If the API gets one (e.g. `hub-api.isatech.co.ke`), set `PUBLIC_URL` to it on Render. For the dashboard, add the domain in Vercel and to `CLIENT_ORIGIN`.
- **Render's free plan and keep-alive.** The free plan sleeps after 15 minutes without incoming requests; a sleeping server loses Safaricom's callbacks, stops the 30-second recovery sweep, and takes about a minute to answer a platform's first request. Until you move to the Starter plan, the API pings its own public address (`/health`) every 10 minutes so it never looks idle. It's on by default on Render (`KEEP_ALIVE`, `KEEP_ALIVE_EVERY_MINUTES`); the open dashboard also checks `/api/health` every minute. When you upgrade to Starter, change `plan: free` to `plan: starter` in `render.yaml` and set `KEEP_ALIVE=false`. A free instance running all month uses about 744 of the 750 free hours Render gives each workspace, so keep only this one free service always on. A redeploy or crash still restarts the server; for extra safety, an external monitor (e.g. UptimeRobot every 5 minutes on `/health`) can also wake it.
- **One server instead of two.** You can skip Vercel: set the Render build command to `npm ci && npm ci --prefix ../frontend && npm run build --prefix ../frontend`, and set `SERVE_CLIENT=true`. The API then serves the dashboard too.

## Install the dashboard as an app

The dashboard is a Progressive Web App: it installs like a native app, with its own icon and window, opens instantly, and updates itself with every Vercel deploy. Money data is never cached; it always comes live from the API.

- **Windows / macOS / Linux (Chrome or Edge):** open the dashboard and press **Install app** at the top right (or the install icon in the address bar).
- **Android (Chrome):** **Install app**, or ⋮ → **Install app** / **Add to Home screen**.
- **iPhone / iPad (Safari):** **Share** → **Add to Home Screen**.

Sign-ins last until the app window is closed, as in the browser.

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
ISA_HUB_URL=https://isa-tech-hub.onrender.com
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
| `GET /v1/billing` | The platform's IsaPay plan, fees so far this month, standing and invoices |
| `POST /v1/billing/invoices/:number/pay` | Pay a subscription invoice: sends an M-Pesa prompt to `{ phone }` (or the billing number) |

A payment looks like this:
```json
{ "id": "…", "platform": "a-read", "reference": "donation-42", "purpose": "donation",
  "amount": 100, "paidAmount": 100, "currency": "KES", "phone": "254712345678",
  "status": "paid", "receipt": "TJ1ABC2DEF", "message": "Payment received",
  "metadata": {}, "createdAt": "…", "paidAt": "…" }
```

`status` is one of `pending`, `paid`, `failed` or `disputed`. `POST /v1/payments` answers `201` (sent) or `200` with `"replayed": true` (same idempotency key). It answers `502` with the failed `payment` when M-Pesa refuses the request, `402` when the platform's IsaPay subscription is overdue past its grace period, `403` when the merchant that runs the platform isn't approved yet (on a live till) or is deactivated, `409` when that phone already has a prompt waiting, and `400` with `details` for invalid input.

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
  if (event.type === 'payment.paid') {
    const payment = event.data.payment;
    markOrderPaid(payment.reference, payment.mpesaReceipt || payment.receipt);
  }
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
- numbered tills from `MPESA_*_N` variables and from the dashboard, and the keep-alive ping;
- billing: percentage and subscription invoices, the free tier, M-Pesa collection and suspension when unpaid;
- polling, signed webhooks and their retries;
- key rotation, disabling a platform and viewer permissions;
- CSV export, the audit log, and the `sdk/` client;
- accounts (`test/accounts.test.js`):
  - sign-up, email confirmation and password reset by one-time link;
  - Google sign-in against a stand-in for Google's keys: new accounts, linking only when Google is the authority, forged and foreign tokens refused;
  - a merchant seeing only its own platforms, tills, payments, invoices and history;
  - approval gating live payments while sandbox works;
  - staff approving, rejecting, deactivating and managing the team;
- merchant webhook addresses kept off private networks (unit tests).

**Use a throwaway database: the tests drop it.**

## Next steps

1. **A-Read → Hub: done.** It's on A-Read's `claude/magical-planck-401rdq` branch. A-Read uses the Hub once `ISA_HUB_URL`, `ISA_HUB_API_KEY` and `ISA_HUB_WEBHOOK_SECRET` are set, with its webhook at `/api/payments/hub-webhook`. Until then it keeps its own Daraja connection.
2. **egertickets → Hub, behind `MPESA_VIA_HUB`.** [`docs/prompts/egertickets-integration.md`](docs/prompts/egertickets-integration.md) is a ready-to-paste prompt for a Claude Code session with the egertickets repo. It covers which files change, the webhook at `/api/payments/isa-hub/webhook`, tests, and rollout and rollback. Paystack and organizer payouts stay in egertickets.
3. **Authenticator codes (TOTP) for dashboard sign-in**, as egertickets' superadmin console has.
4. **Payments made from the M-Pesa menu.** Register the till's C2B confirmation URL with the Hub, add an "unmatched payments" queue, and let payers claim a payment by M-Pesa code.
5. **Statement matching**: upload the M-Pesa org-portal statement and flag differences.
6. **Partner reports**: merchants already sign in and see only their own platforms; next are monthly statements they can download, and payouts sent automatically (M-Pesa B2C) instead of by hand.
7. **Two-factor sign-in for merchants** (with item 3), and document upload for business verification (registration certificate, KRA PIN) on the approval page.
