import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, KeyRound, Power, Send, ShieldCheck } from 'lucide-react';
import { API_URL, api } from '../api/client.js';
import { useAction, usePlatform } from '../api/queries.js';
import { BillingSettings, InvoiceTable, PLAN_LABELS, planSummary } from '../components/Billing.jsx';
import PlatformForm from '../components/PlatformForm.jsx';
import { CopyButton, ErrorMessage, PageHeader, SecretReveal, Spinner, StatusBadge } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { formatDateTime, formatKes, formatNumber, formatPeriod, timeAgo } from '../utils/format.js';

// Platforms call the Hub at its origin (/v1/...), the dashboard at /api/admin.
const HUB_URL = new URL(API_URL).origin;

function Integration({ platform }) {
  const curl = `curl -X POST ${HUB_URL}/v1/payments \\
  -H "Authorization: Bearer $ISA_HUB_API_KEY" \\
  -H "Idempotency-Key: order-123-attempt-1" \\
  -H "Content-Type: application/json" \\
  -d '{"phone":"0712345678","amount":100,"reference":"order-123","purpose":"donation"}'`;
  return (
    <div className="card">
      <h2>Connect {platform.name}</h2>
      <ol className="steps">
        <li>
          Store the API key on the platform's <strong>server</strong> (for example <code>ISA_HUB_API_KEY</code>) and the webhook secret as{' '}
          <code>ISA_HUB_WEBHOOK_SECRET</code>.
        </li>
        <li>
          Start a payment from the server. The payer gets the M-Pesa PIN prompt:
          <div className="code-block">
            <div className="code-head">
              <span>Terminal</span>
              <CopyButton value={curl} />
            </div>
            <pre>{curl}</pre>
          </div>
        </li>
        <li>
          Show "check your phone", then poll <code>GET {HUB_URL}/v1/payments/&lt;id&gt;</code> every few seconds, or wait for the webhook.
        </li>
        <li>
          On <code>payment.paid</code>, check the <code>ISA-Signature</code> header with the webhook secret, then deliver what was paid for. The
          README and <code>sdk/node/isa-hub.cjs</code> have a ready-made client.
        </li>
      </ol>
    </div>
  );
}

export default function PlatformPage() {
  const { id } = useParams();
  const { canEdit } = useAuth();
  const { data, isPending, error } = usePlatform(id);
  const [secret, setSecret] = useState(null); // { title, value }
  const [testResult, setTestResult] = useState(null);
  const keys = [['platform', id], ['platforms']];

  const save = useAction((body) => api(`/platforms/${id}`, { method: 'PATCH', body }), keys);
  const toggle = useAction((status) => api(`/platforms/${id}`, { method: 'PATCH', body: { status } }), keys);
  const rotateKey = useAction(() => api(`/platforms/${id}/api-key`, { method: 'POST' }), keys);
  const rotateSecret = useAction(() => api(`/platforms/${id}/webhook-secret`, { method: 'POST' }), keys);
  const test = useAction(() => api(`/platforms/${id}/test-webhook`, { method: 'POST' }));

  if (isPending) return <Spinner />;
  if (error) return <ErrorMessage error={error} />;
  const { platform, deliveries, failedDeliveries, billing } = data;
  const actionError = toggle.error || rotateKey.error || rotateSecret.error || test.error;

  const confirmThen = (message, run) => () => {
    if (window.confirm(message)) run();
  };

  return (
    <>
      <Link to="/platforms" className="back">
        <ArrowLeft size={16} aria-hidden="true" /> Platforms
      </Link>
      <PageHeader
        title={platform.name}
        subtitle={`${platform.slug} · ${platform.ownership === 'partner' ? 'partner platform' : 'our platform'} · added ${formatDateTime(platform.createdAt)}`}
        actions={
          <>
            <StatusBadge status={platform.status} />
            <Link to={`/payments?platform=${platform.id}`} className="btn btn-ghost">
              Payments
            </Link>
            {platform.till && (
              <Link to={`/tills/${platform.till.id}`} className="btn btn-ghost">
                Till
              </Link>
            )}
            <Link to={`/audit?target=${platform.id}`} className="btn btn-ghost">
              History
            </Link>
          </>
        }
      />
      <ErrorMessage error={actionError} title="That didn't work" />

      <section className="tiles tiles-3">
        <div className="tile">
          <span className="tile-label">Last 30 days</span>
          <span className="tile-value">{formatKes(platform.stats.month.amount)}</span>
          <span className="tile-sub">{formatNumber(platform.stats.month.count)} paid</span>
        </div>
        <div className="tile">
          <span className="tile-label">Last payment</span>
          <span className="tile-value">{timeAgo(platform.stats.lastPaymentAt)}</span>
          <span className="tile-sub">{platform.till ? `into ${platform.till.name} (${platform.till.payNumber})` : 'no till'}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Webhooks that gave up</span>
          <span className="tile-value">{formatNumber(platform.stats.failedWebhooks)}</span>
          <span className="tile-sub">after 9 tries over about two days</span>
        </div>
      </section>

      {secret && (
        <div className="card">
          <SecretReveal title={secret.title} value={secret.value} />
          <button type="button" className="btn btn-ghost btn-small" onClick={() => setSecret(null)}>
            I've saved it
          </button>
        </div>
      )}

      <section className="grid-2">
        <div className="card">
          <h2>Keys and webhook</h2>
          <dl className="kv">
            <div className="kv-row">
              <dt>API key</dt>
              <dd className="mono">
                {platform.apiKeyHint || '—'} <span className="muted small">issued {timeAgo(platform.apiKeyCreatedAt)}</span>
              </dd>
            </div>
            <div className="kv-row">
              <dt>Webhook URL</dt>
              <dd className="mono small break">{platform.webhookUrl || 'not set: the platform must poll for results'}</dd>
            </div>
          </dl>
          {canEdit && (
            <div className="button-row">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={rotateKey.isPending}
                onClick={confirmThen(`Issue a new API key for ${platform.name}? The current key stops working immediately.`, () =>
                  rotateKey.mutate(undefined, { onSuccess: (r) => setSecret({ title: 'New API key', value: r.apiKey }) }),
                )}
              >
                <KeyRound size={16} aria-hidden="true" /> New API key
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={rotateSecret.isPending}
                onClick={confirmThen(`Issue a new webhook secret for ${platform.name}? Webhooks are signed with the new one from now on.`, () =>
                  rotateSecret.mutate(undefined, { onSuccess: (r) => setSecret({ title: 'New webhook signing secret', value: r.webhookSecret }) }),
                )}
              >
                <ShieldCheck size={16} aria-hidden="true" /> New webhook secret
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!platform.webhookUrl || test.isPending}
                onClick={() => test.mutate(undefined, { onSuccess: (r) => setTestResult(r.result) })}
              >
                <Send size={16} aria-hidden="true" /> {test.isPending ? 'Sending…' : 'Send test webhook'}
              </button>
            </div>
          )}
          {testResult && (
            <div className={`notice ${testResult.ok ? 'notice-ok' : 'notice-error'}`}>
              {testResult.ok
                ? `The platform answered HTTP ${testResult.status} in ${testResult.ms} ms.`
                : `Not delivered: ${testResult.error}${testResult.ms ? ` (after ${testResult.ms} ms)` : ''}.`}
            </div>
          )}
          {failedDeliveries.length > 0 && (
            <>
              <h3>Webhooks that gave up</h3>
              <p className="hint">Fix the platform's endpoint, then open each payment and press Resend webhook.</p>
              <ul className="deliveries">
                {failedDeliveries.map((d) => (
                  <li key={d.id}>
                    <div>
                      <Link to={`/payments/${d.payment}`} className="mono">
                        {d.event}
                      </Link>{' '}
                      <StatusBadge status="failed" />
                    </div>
                    <span className="small muted">
                      {formatDateTime(d.createdAt)} · {d.attempts} attempts · {d.lastError || 'no answer'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>Recent webhooks</h3>
          {deliveries.length ? (
            <ul className="deliveries">
              {deliveries.map((d) => (
                <li key={d.id}>
                  <div>
                    <Link to={`/payments/${d.payment}`} className="mono">
                      {d.event}
                    </Link>{' '}
                    <StatusBadge status={d.status === 'delivered' ? 'delivered' : d.status === 'failed' ? 'failed' : 'pending'} />
                  </div>
                  <span className="small muted">
                    {formatDateTime(d.createdAt)} · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                    {d.lastError && d.status !== 'delivered' ? ` · ${d.lastError}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">None yet.</p>
          )}
        </div>
        <Integration platform={platform} />
      </section>

      {billing && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Billing</h2>
              <p className="card-sub">
                {PLAN_LABELS[platform.pricing.plan]}: {planSummary(platform.pricing)}.
              </p>
            </div>
            <StatusBadge status={billing.standing.state === 'open' ? 'ok' : billing.standing.state} />
          </div>
          {billing.standing.state === 'suspended' && (
            <div className="notice notice-error">This platform can't start new payments until its overdue invoice is paid, or you extend its grace below.</div>
          )}
          <dl className="kv kv-tight">
            <div className="kv-row">
              <dt>{formatPeriod(billing.currentMonth.period)} so far</dt>
              <dd>
                {formatKes(billing.currentMonth.volume.amount)} received · fee if the month ended now:{' '}
                <strong>{formatKes(billing.currentMonth.estimatedFee)}</strong>
              </dd>
            </div>
          </dl>
          {billing.invoices.length > 0 && (
            <>
              <h3>Invoices</h3>
              <InvoiceTable invoices={billing.invoices} showPlatform={false} canEdit={canEdit} />
            </>
          )}
          <h3>Price</h3>
          <BillingSettings key={platform.id} platform={platform} canEdit={canEdit} />
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Settings</h2>
          {canEdit && (
            <button
              type="button"
              className={`btn ${platform.status === 'active' ? 'btn-danger' : 'btn-ghost'}`}
              disabled={toggle.isPending}
              onClick={
                platform.status === 'active'
                  ? confirmThen(`Disable ${platform.name}? It can't start new payments until you enable it again. Payments in progress still settle.`, () =>
                      toggle.mutate('disabled'),
                    )
                  : () => toggle.mutate('active')
              }
            >
              <Power size={16} aria-hidden="true" /> {platform.status === 'active' ? 'Disable' : 'Enable'}
            </button>
          )}
        </div>
        {save.isSuccess && <div className="notice notice-ok">Saved.</div>}
        <PlatformForm
          key={platform.id}
          initial={platform}
          submitLabel="Save changes"
          busy={save.isPending}
          error={save.error}
          disabled={!canEdit}
          onSubmit={(body) => {
            if (body.till !== platform.till?.id && !window.confirm('Move this platform to a different till? New payments will be paid into that till.')) return;
            save.mutate(body);
          }}
        />
      </section>
    </>
  );
}
