import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Plus } from 'lucide-react';
import { API_URL } from '../api/client.js';
import { BRAND } from '../brand.js';
import { CodeBlock, CopyButton, PageHeader } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';

// Platforms call the gateway at its origin (/v1/...), the dashboard at /api/admin.
const BASE_URL = new URL(API_URL).origin;

const ENDPOINTS = [
  ['GET', '/v1/config', 'The till to show for “pay from the M-Pesa menu”, and the amount limits'],
  ['POST', '/v1/payments', 'Start a payment: sends the M-Pesa PIN prompt to the payer'],
  ['GET', '/v1/payments/:id', 'Current state of a payment (asks Safaricom when the callback is late)'],
  ['GET', '/v1/payments?reference=&status=&limit=', 'The platform’s own payments'],
];

const SAMPLES = {
  curl: {
    title: 'Terminal',
    code: `curl -X POST ${BASE_URL}/v1/payments \\
  -H "Authorization: Bearer $ISAPAY_API_KEY" \\
  -H "Idempotency-Key: order-123-attempt-1" \\
  -H "Content-Type: application/json" \\
  -d '{"phone":"0712345678","amount":100,"reference":"order-123","purpose":"checkout"}'`,
  },
  node: {
    title: 'Node.js (with the IsaPay client)',
    code: `import express from 'express';
import { IsaPay, verifyWebhook } from './isa-hub.cjs';

const isapay = new IsaPay({ apiKey: process.env.ISAPAY_API_KEY, baseUrl: '${BASE_URL}' });

// 1. Start: the payer gets the M-Pesa PIN prompt.
const { payment } = await isapay.createPayment({
  phone: '0712345678',
  amount: 100,
  reference: 'order-123',
  idempotencyKey: 'order-123-attempt-1',
});

// 2. Settle: IsaPay posts signed webhooks. Keep the raw body to check the signature.
app.post('/payments/isapay-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = verifyWebhook({ secret: process.env.ISAPAY_WEBHOOK_SECRET, rawBody: req.body, signature: req.get('isa-signature') });
  } catch {
    return res.status(400).end();
  }
  if (event.type === 'payment.paid') markOrderPaid(event.data.payment.reference, event.data.payment.receipt);
  res.status(204).end();
});`,
  },
  php: {
    title: 'PHP: checking a webhook',
    code: `<?php
$raw = file_get_contents('php://input');
$header = $_SERVER['HTTP_ISA_SIGNATURE'] ?? '';
parse_str(str_replace(',', '&', $header), $sig); // t=…&v1=…
$expected = hash_hmac('sha256', $sig['t'] . '.' . $raw, getenv('ISAPAY_WEBHOOK_SECRET'));
if (!hash_equals($expected, $sig['v1'] ?? '') || abs(time() - (int) $sig['t']) > 300) {
    http_response_code(400);
    exit;
}
$event = json_decode($raw, true);
if ($event['type'] === 'payment.paid') {
    // mark $event['data']['payment']['reference'] as paid
}
http_response_code(204);`,
  },
  python: {
    title: 'Python: checking a webhook',
    code: `import hashlib, hmac, json, os, time

def verify(raw_body: bytes, header: str) -> dict:
    parts = dict(p.split("=", 1) for p in header.split(","))
    signed = f"{parts['t']}.".encode() + raw_body
    expected = hmac.new(os.environ["ISAPAY_WEBHOOK_SECRET"].encode(), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, parts.get("v1", "")) or abs(time.time() - int(parts["t"])) > 300:
        raise ValueError("bad signature")
    return json.loads(raw_body)`,
  },
};

export default function DevelopersPage() {
  const { canEdit } = useAuth();
  const [tab, setTab] = useState('curl');

  return (
    <>
      <PageHeader
        title="Developers"
        subtitle={`Use ${BRAND.name} as the M-Pesa payment gateway for any platform: yours or a partner's.`}
        actions={
          <>
            <a href="/sdk/isa-hub.cjs" download className="btn btn-ghost">
              <Download size={16} aria-hidden="true" /> Node.js client
            </a>
            {canEdit && (
              <Link to="/platforms/new" className="btn btn-primary">
                <Plus size={16} aria-hidden="true" /> Onboard a platform
              </Link>
            )}
          </>
        }
      />

      <section className="card hero-card">
        <span className="eyebrow">API base URL</span>
        <div className="base-url">
          <code>{BASE_URL}</code>
          <CopyButton value={BASE_URL} />
        </div>
        <p className="card-sub">
          Every call is server-to-server with <code>Authorization: Bearer isa_sk_…</code>. Never put the API key in a browser or a mobile app: it
          can start payments into your till.
        </p>
      </section>

      <section className="grid-2">
        <div className="card">
          <h2>Onboarding a platform</h2>
          <ol className="steps">
            <li>
              In <Link to="/platforms/new">Platforms → Add platform</Link>, choose the M-Pesa till its money goes to and enter its webhook URL.
              Mark it as a <strong>partner</strong> if it isn't yours.
            </li>
            <li>
              Hand the <strong>API key</strong> (<code>isa_sk_…</code>) and <strong>webhook secret</strong> (<code>whsec_…</code>) to the platform's
              developers over a safe channel. They're shown once.
            </li>
            <li>The platform starts payments with the API and marks orders paid when the signed webhook arrives.</li>
            <li>
              Press <strong>Send test webhook</strong> on the platform's page, then make a real KES 1 payment and watch it under{' '}
              <Link to="/payments">Payments</Link>.
            </li>
          </ol>
        </div>
        <div className="card">
          <h2>Webhooks</h2>
          <p className="card-sub">POSTed as JSON to the platform's webhook URL, retried 9 times over about two days until it answers 2xx.</p>
          <dl className="kv kv-tight">
            <div className="kv-row">
              <dt>Events</dt>
              <dd>
                <code>payment.paid</code>, <code>payment.failed</code>, <code>payment.disputed</code>, <code>ping</code>
              </dd>
            </div>
            <div className="kv-row">
              <dt>Headers</dt>
              <dd>
                <code>ISA-Event</code>, <code>ISA-Delivery</code>, <code>ISA-Signature</code>
              </dd>
            </div>
            <div className="kv-row">
              <dt>Signature</dt>
              <dd>
                <code>t=&lt;unix&gt;,v1=&lt;hex HMAC-SHA256 of “t.raw body”&gt;</code> with the webhook secret
              </dd>
            </div>
            <div className="kv-row">
              <dt>Good to know</dt>
              <dd>A failed payment can turn paid if a late success arrives. Handle events idempotently by payment id.</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="card">
        <h2>Endpoints</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>Purpose</th>
              </tr>
            </thead>
            <tbody>
              {ENDPOINTS.map(([method, path, purpose]) => (
                <tr key={`${method} ${path}`}>
                  <td>
                    <span className={`method method-${method.toLowerCase()}`}>{method}</span>
                  </td>
                  <td className="mono">{path}</td>
                  <td>{purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          <code>status</code> is one of <code>pending</code>, <code>paid</code>, <code>failed</code> or <code>disputed</code>. <code>POST /v1/payments</code>{' '}
          answers 201 (prompt sent), 200 with <code>"replayed": true</code> (same Idempotency-Key), 409 when the phone already has a prompt waiting,
          and 502 when M-Pesa refuses the request.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Examples</h2>
          <div className="segmented" role="tablist" aria-label="Language">
            {Object.keys(SAMPLES).map((key) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
                {{ curl: 'cURL', node: 'Node.js', php: 'PHP', python: 'Python' }[key]}
              </button>
            ))}
          </div>
        </div>
        <CodeBlock title={SAMPLES[tab].title} code={SAMPLES[tab].code} />
      </section>
    </>
  );
}
