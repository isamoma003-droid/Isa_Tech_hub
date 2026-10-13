import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Banknote, CheckCheck, Smartphone, XCircle } from 'lucide-react';
import { api } from '../api/client.js';
import { useAction } from '../api/queries.js';
import { useAuth } from '../context/AuthContext.jsx';
import { formatDateTime, formatKes, formatNumber, formatPayout, formatPeriod } from '../utils/format.js';
import { ErrorMessage, Field, StatusBadge } from './ui.jsx';

export const PLAN_LABELS = {
  exempt: 'No fees',
  percent: 'Percentage per payment',
  subscription: 'Monthly subscription',
};

/** "1.5% above KES 10,000 a month" and the like. */
export function planSummary(pricing) {
  if (!pricing) return '—';
  const free = pricing.freeAmount ? `, first ${formatKes(pricing.freeAmount)} a month free` : '';
  if (pricing.plan === 'percent') return `${pricing.percent}% of each payment received${free}`;
  if (pricing.plan === 'subscription') return `${formatKes(pricing.monthlyFee)} a month${pricing.freeAmount ? `, free in a month under ${formatKes(pricing.freeAmount)}` : ''}`;
  return 'No fees (your own platform)';
}

const REFRESH = [['invoices'], ['billing'], ['platform'], ['stats']];

function InvoiceActions({ invoice }) {
  const { isAdmin, isMerchant } = useAuth();
  const [message, setMessage] = useState(null);
  const collect = useAction((body) => api(`/invoices/${invoice.id}/collect`, { method: 'POST', body }), REFRESH);
  const markPaid = useAction((body) => api(`/invoices/${invoice.id}/mark-paid`, { method: 'POST', body }), REFRESH);
  const voidIt = useAction((body) => api(`/invoices/${invoice.id}/void`, { method: 'POST', body }), REFRESH);
  const payout = useAction((body) => api(`/invoices/${invoice.id}/payout`, { method: 'POST', body }), REFRESH);
  const busy = collect.isPending || markPaid.isPending || voidIt.isPending || payout.isPending;
  const error = collect.error || markPaid.error || voidIt.error || payout.error;

  const onCollect = () => {
    const phone = window.prompt(
      isMerchant
        ? `Pay ${formatKes(invoice.fee)} for ${invoice.number}. The M-Pesa number to send the prompt to:`
        : `Send an M-Pesa prompt for ${formatKes(invoice.fee)} (${invoice.number}). Phone number, or leave empty for the platform's billing phone:`,
      '',
    );
    if (phone === null) return;
    collect.mutate(phone.trim() ? { phone: phone.trim() } : {}, {
      onSuccess: (r) =>
        setMessage(isMerchant ? 'Check your phone and enter your M-Pesa PIN. The invoice is marked paid once it goes through.' : `Prompt sent. The invoice is marked paid as soon as payment ${r.payment.id.slice(-6)} goes through.`),
    });
  };
  const onMarkPaid = () => {
    const receipt = window.prompt(`Mark ${invoice.number} as paid. M-Pesa receipt or reference (optional):`, '');
    if (receipt !== null) markPaid.mutate({ receipt: receipt.trim() || undefined });
  };
  const onVoid = () => {
    const note = window.prompt(`Void ${invoice.number}? The platform won't owe it any more. Reason:`, '');
    if (note !== null) voidIt.mutate({ note: note.trim() || undefined });
  };
  const onPayout = () => {
    const to = invoice.payTo ? ` (${formatPayout(invoice.payTo)})` : '';
    const reference = window.prompt(`You sent ${formatKes(invoice.payout)} to the partner${to} for ${formatPeriod(invoice.period)}. M-Pesa or bank reference:`, '');
    if (reference?.trim()) payout.mutate({ reference: reference.trim() });
  };

  return (
    <div className="row-actions">
      {invoice.kind === 'subscription' && invoice.status === 'open' && (
        <button type="button" className="btn btn-primary btn-small" disabled={busy} onClick={onCollect}>
          <Smartphone size={14} aria-hidden="true" /> {isMerchant ? 'Pay with M-Pesa' : 'Request M-Pesa'}
        </button>
      )}
      {isAdmin && invoice.kind === 'subscription' && invoice.status === 'open' && (
        <>
          <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={onMarkPaid}>
            <CheckCheck size={14} aria-hidden="true" /> Mark paid
          </button>
          <button type="button" className="btn btn-danger btn-small" disabled={busy} onClick={onVoid}>
            <XCircle size={14} aria-hidden="true" /> Void
          </button>
        </>
      )}
      {isAdmin && invoice.payoutStatus === 'pending' && (
        <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={onPayout}>
          <Banknote size={14} aria-hidden="true" /> Payout sent
        </button>
      )}
      {message && <span className="small muted">{message}</span>}
      {error && <span className="field-error">{error.message}</span>}
    </div>
  );
}

export function InvoiceTable({ invoices, showPlatform = true, canEdit }) {
  const { isMerchant } = useAuth();
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Invoice</th>
            {showPlatform && <th>Platform</th>}
            <th>Month</th>
            <th className="num">Received</th>
            <th className="num">IsaPay fee</th>
            <th>Status</th>
            <th>{isMerchant ? 'Paid out to you' : 'Partner payout'}</th>
            {canEdit && <th />}
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <tr key={inv.id}>
              <td>
                <span className="mono nowrap">{inv.number}</span>
                <span className="block small muted">{inv.kind === 'subscription' ? 'Subscription' : `${inv.percent}% commission`}</span>
              </td>
              {showPlatform && <td>{inv.platform?.id ? <Link to={`/platforms/${inv.platform.id}`}>{inv.platform.name}</Link> : '—'}</td>}
              <td className="nowrap">{formatPeriod(inv.period)}</td>
              <td className="num">
                {formatKes(inv.volume.amount)}
                <span className="block small muted">{formatNumber(inv.volume.count)} payments</span>
              </td>
              <td className="num">
                <strong>{formatKes(inv.fee)}</strong>
              </td>
              <td>
                <StatusBadge status={inv.overdue ? 'overdue' : inv.status} />
                {inv.status === 'open' && <span className="block small muted">due {formatDateTime(inv.dueAt)}</span>}
                {inv.status === 'paid' && inv.kind === 'subscription' && (
                  <span className="block small muted">
                    {formatDateTime(inv.paidAt)}
                    {inv.receipt ? ` · ${inv.receipt}` : ''}
                  </span>
                )}
              </td>
              <td>
                {inv.kind === 'commission' ? (
                  <>
                    {formatKes(inv.payout)}
                    <span className="block small muted">
                      {inv.payoutStatus === 'sent' ? `sent · ${inv.payoutReference}` : inv.payoutStatus === 'pending' ? (isMerchant ? 'on its way' : 'to send') : '—'}
                    </span>
                    {inv.payTo && <span className="block small">to {formatPayout(inv.payTo)}</span>}
                    {inv.payTo === null && <span className="block small muted">no payout details yet</span>}
                  </>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              {canEdit && (
                <td>
                  <InvoiceActions invoice={inv} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const fromPlatform = (platform) => ({
  plan: platform.billing.plan,
  percent: platform.billing.percent ?? '',
  monthlyFee: platform.billing.monthlyFee ?? '',
  freeAmount: platform.billing.freeAmount ?? '',
  phone: platform.billing.phone || '',
  email: platform.billing.email || '',
  graceUntil: platform.billing.graceUntil ? platform.billing.graceUntil.slice(0, 10) : '',
});

/** A platform's plan and prices. Empty prices follow the defaults (BILLING_* on Render). */
export function BillingSettings({ platform, canEdit }) {
  const [form, setForm] = useState(() => fromPlatform(platform));
  const save = useAction((body) => api(`/platforms/${platform.id}/billing`, { method: 'PUT', body }), REFRESH);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const fieldError = (path) => save.error?.details?.find?.((d) => d.path === path)?.message;
  const numberOrNull = (value) => (value === '' ? null : Number(value));

  const submit = (event) => {
    event.preventDefault();
    save.mutate({
      plan: form.plan,
      percent: numberOrNull(form.percent),
      monthlyFee: numberOrNull(form.monthlyFee),
      freeAmount: numberOrNull(form.freeAmount),
      phone: form.phone,
      email: form.email,
      graceUntil: form.graceUntil ? new Date(`${form.graceUntil}T23:59:00+03:00`).toISOString() : null,
    });
  };
  const autoPlan = platform.ownership !== 'partner' ? 'no fees (your own platform)' : platform.till?.owner === 'partner' ? 'a monthly subscription (partner’s own till)' : 'a percentage (money lands in your till)';

  return (
    <form className="form" onSubmit={submit}>
      <fieldset disabled={!canEdit || save.isPending}>
        <div className="form-grid">
          <Field label="Plan" hint={form.plan === 'auto' ? `Automatic: ${autoPlan}.` : undefined}>
            <select value={form.plan} onChange={set('plan')}>
              <option value="auto">Automatic</option>
              <option value="percent">Percentage per payment</option>
              <option value="subscription">Monthly subscription</option>
              <option value="exempt">No fees</option>
            </select>
          </Field>
          <Field label="Percentage" hint="Empty: the default" error={fieldError('percent')}>
            <input type="number" min="0" max="100" step="0.1" value={form.percent} onChange={set('percent')} placeholder="default" />
          </Field>
          <Field label="Monthly fee (KES)" hint="Empty: the default" error={fieldError('monthlyFee')}>
            <input type="number" min="0" step="1" value={form.monthlyFee} onChange={set('monthlyFee')} placeholder="default" />
          </Field>
          <Field label="Free each month (KES)" hint="Empty: the default" error={fieldError('freeAmount')}>
            <input type="number" min="0" step="1" value={form.freeAmount} onChange={set('freeAmount')} placeholder="default" />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Billing M-Pesa number" hint="Gets the prompt for subscription invoices" error={fieldError('phone')}>
            <input value={form.phone} onChange={set('phone')} inputMode="tel" placeholder="07…" />
          </Field>
          <Field label="Billing email" error={fieldError('email')}>
            <input type="email" value={form.email} onChange={set('email')} />
          </Field>
          <Field label="Extra grace until" hint="Lets an overdue platform keep taking payments until this day">
            <input type="date" value={form.graceUntil} onChange={set('graceUntil')} />
          </Field>
        </div>
        {canEdit && (
          <>
            <ErrorMessage error={save.error} title="Not saved" />
            {save.isSuccess && <div className="notice notice-ok">Billing saved.</div>}
            <div className="form-actions">
              <button type="submit" className="btn btn-primary">
                {save.isPending ? 'Saving…' : 'Save billing'}
              </button>
            </div>
          </>
        )}
      </fieldset>
    </form>
  );
}
