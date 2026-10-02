import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Send } from 'lucide-react';
import { api } from '../api/client.js';
import { useAction, usePayment } from '../api/queries.js';
import { ErrorMessage, PageHeader, Spinner, StatusBadge } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { formatFullDateTime, formatKes, timeAgo } from '../utils/format.js';

const EVENT_LABELS = {
  created: 'Payment created by the platform',
  'stk.sent': 'PIN prompt sent to the phone',
  'stk.refused': 'Safaricom refused the request',
  callback: 'Safaricom reported the result',
  'status.paid': 'Marked paid',
  'status.failed': 'Marked failed',
  'status.disputed': 'Held as disputed',
};

const SOURCE_LABELS = {
  api: 'platform',
  daraja: 'Safaricom',
  safaricom: 'Safaricom callback',
  callback: 'callback, confirmed with Safaricom',
  sweep: 'background check',
  poll: "check while the platform's page waited",
  admin: 'admin check',
};

function Row({ label, children }) {
  return (
    <div className="kv-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default function PaymentPage() {
  const { id } = useParams();
  const { canEdit } = useAuth();
  const { data, isPending, error } = usePayment(id);
  const check = useAction(() => api(`/payments/${id}/check`, { method: 'POST' }), [['payment', id], ['payments'], ['stats']]);
  const resend = useAction(() => api(`/payments/${id}/resend-webhook`, { method: 'POST' }), [['payment', id]]);

  if (isPending) return <Spinner />;
  if (error) return <ErrorMessage error={error} />;
  const { payment, platform, till, deliveries } = data;

  return (
    <>
      <Link to="/payments" className="back">
        <ArrowLeft size={16} aria-hidden="true" /> Payments
      </Link>
      <PageHeader
        title={formatKes(payment.amount)}
        subtitle={`${platform?.name || payment.platform} · ${payment.reference}`}
        actions={
          canEdit && (
            <>
              {payment.status === 'pending' && (
                <button type="button" className="btn btn-ghost" onClick={() => check.mutate()} disabled={check.isPending}>
                  <RefreshCw size={16} aria-hidden="true" className={check.isPending ? 'spin' : ''} />
                  Check with Safaricom
                </button>
              )}
              {payment.status !== 'pending' && platform?.webhookUrl && (
                <button type="button" className="btn btn-ghost" onClick={() => resend.mutate()} disabled={resend.isPending}>
                  <Send size={16} aria-hidden="true" />
                  Resend webhook
                </button>
              )}
            </>
          )
        }
      />
      <ErrorMessage error={check.error || resend.error} title="That didn't work" />
      {resend.isSuccess && <div className="notice notice-ok">A fresh webhook is queued for {platform?.name}.</div>}

      <section className="grid-2">
        <div className="card">
          <h2>
            <StatusBadge status={payment.status} />
          </h2>
          <p className="lead">{payment.message}</p>
          <dl className="kv">
            <Row label="Amount asked">{formatKes(payment.amount)}</Row>
            {payment.paidAmount !== null && <Row label="Amount M-Pesa reported">{formatKes(payment.paidAmount)}</Row>}
            <Row label="M-Pesa receipt">
              <span className="mono">{payment.receipt || '—'}</span>
            </Row>
            <Row label="Phone">
              <span className="mono">{payment.phone}</span>
            </Row>
            <Row label="Created">{formatFullDateTime(payment.createdAt)}</Row>
            {payment.paidAt && <Row label="Paid">{formatFullDateTime(payment.paidAt)}</Row>}
            {payment.failedAt && <Row label="Failed">{formatFullDateTime(payment.failedAt)}</Row>}
            {payment.resultCode !== null && <Row label="Safaricom result">{`${payment.resultCode}${payment.resultDesc ? ` · ${payment.resultDesc}` : ''}`}</Row>}
          </dl>
        </div>
        <div className="card">
          <h2>Details</h2>
          <dl className="kv">
            <Row label="Platform">{platform ? <Link to={`/platforms/${platform.id}`}>{platform.name}</Link> : payment.platform}</Row>
            <Row label="Reference">
              <span className="mono">{payment.reference}</span>
            </Row>
            {payment.purpose && <Row label="Purpose">{payment.purpose}</Row>}
            {payment.description && <Row label="Description">{payment.description}</Row>}
            <Row label="Till">{till ? `${till.name} (${till.payNumber})` : '—'}</Row>
            <Row label="Checkout request">
              <span className="mono small">{payment.checkoutRequestId || '—'}</span>
            </Row>
            {payment.idempotencyKey && (
              <Row label="Idempotency key">
                <span className="mono small">{payment.idempotencyKey}</span>
              </Row>
            )}
            <Row label="Status checks">{payment.checks ? `${payment.checks}, last ${timeAgo(payment.lastCheckedAt)}` : 'none needed'}</Row>
            {Object.keys(payment.metadata || {}).length > 0 && (
              <Row label="Metadata">
                <code className="small">{JSON.stringify(payment.metadata)}</code>
              </Row>
            )}
            <Row label="IsaPay payment id">
              <span className="mono small">{payment.id}</span>
            </Row>
          </dl>
        </div>
      </section>

      <section className="grid-2">
        <div className="card">
          <h2>Timeline</h2>
          <ol className="timeline">
            {[...payment.events].reverse().map((event, i) => (
              <li key={`${event.at}-${i}`}>
                <span className="timeline-time">{formatFullDateTime(event.at)}</span>
                <strong>{EVENT_LABELS[event.type] || event.type}</strong>
                {event.source && <span className="muted"> · {SOURCE_LABELS[event.source] || event.source}</span>}
                {event.note && <p className="small">{event.note}</p>}
                {event.data?.receipt && <p className="small mono">Receipt {event.data.receipt}</p>}
              </li>
            ))}
          </ol>
        </div>
        <div className="card">
          <h2>Webhooks to {platform?.name || 'the platform'}</h2>
          {!platform?.webhookUrl && <p className="hint">This platform has no webhook URL, so it learns the result by polling.</p>}
          {deliveries.length ? (
            <ul className="deliveries">
              {deliveries.map((d) => (
                <li key={d.id}>
                  <div>
                    <strong className="mono">{d.event}</strong> <StatusBadge status={d.status === 'delivered' ? 'delivered' : d.status === 'failed' ? 'failed' : 'pending'} />
                  </div>
                  <span className="small muted">
                    {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                    {d.lastStatus ? ` · last answer HTTP ${d.lastStatus}` : ''}
                    {d.lastError && d.status !== 'delivered' ? ` · ${d.lastError}` : ''}
                    {d.status === 'pending' && d.attempts > 0 ? ` · next try ${formatFullDateTime(d.nextAttemptAt)}` : ''}
                    {d.deliveredAt ? ` · delivered ${timeAgo(d.deliveredAt)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            platform?.webhookUrl && <p className="hint">Nothing sent yet: webhooks go out once the payment is settled.</p>
          )}
        </div>
      </section>
    </>
  );
}
