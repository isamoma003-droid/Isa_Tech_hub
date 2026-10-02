import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Banknote, CalendarCheck, Clock, TrendingUp } from 'lucide-react';
import { api } from '../api/client.js';
import { useAction, useBilling, useInvoices } from '../api/queries.js';
import { InvoiceTable, PLAN_LABELS, planSummary } from '../components/Billing.jsx';
import { Empty, ErrorMessage, PageHeader, Pager, Spinner, StatusBadge } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { formatDateTime, formatKes, formatNumber, formatPeriod } from '../utils/format.js';

const FILTERS = [
  ['', 'All'],
  ['open', 'Unpaid'],
  ['overdue', 'Overdue'],
  ['payout', 'Payouts to send'],
  ['paid', 'Paid'],
];

function Tile({ icon: Icon, label, value, sub }) {
  return (
    <div className="tile">
      <span className="tile-label">
        <span className="tile-icon" aria-hidden="true">
          <Icon size={16} />
        </span>
        {label}
      </span>
      <span className="tile-value">{value}</span>
      <span className="tile-sub">{sub}</span>
    </div>
  );
}

function Invoices({ canEdit }) {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, isPending, error, isFetching } = useInvoices({ status, page });
  return (
    <section className={`card ${isFetching && !isPending ? 'refreshing' : ''}`}>
      <div className="card-head">
        <h2>Invoices</h2>
        <div className="segmented" role="tablist" aria-label="Show">
          {FILTERS.map(([value, label]) => (
            <button
              key={value || 'all'}
              type="button"
              role="tab"
              aria-selected={status === value}
              className={status === value ? 'active' : ''}
              onClick={() => {
                setStatus(value);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {isPending ? (
        <Spinner />
      ) : error ? (
        <ErrorMessage error={error} />
      ) : data.invoices.length ? (
        <>
          <InvoiceTable invoices={data.invoices} canEdit={canEdit} />
          <Pager page={data.page} pages={data.pages} onPage={setPage} />
        </>
      ) : (
        <Empty title="No invoices here">Invoices are written automatically a few minutes after each month ends.</Empty>
      )}
    </section>
  );
}

export default function BillingPage() {
  const { canEdit } = useAuth();
  const { data, isPending, error } = useBilling();
  const close = useAction((body) => api('/billing/close-month', { method: 'POST', body }), [['invoices'], ['billing']]);

  if (isPending) return <Spinner />;
  if (error) return <ErrorMessage error={error} />;
  const { summary, platforms, defaults, period, lastPeriod } = data;
  const earned = summary.earnedThisYear.subscription.amount + summary.earnedThisYear.commission.amount;

  return (
    <>
      <PageHeader
        title="Billing & revenue"
        subtitle={`What IsaPay earns from the platforms that use it. ${formatPeriod(period)} so far, in Kenya time.`}
        actions={
          canEdit && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={close.isPending}
              onClick={() => close.mutate({ period: lastPeriod })}
              title="Invoices are written automatically; this does it now"
            >
              <CalendarCheck size={16} aria-hidden="true" /> {close.isPending ? 'Invoicing…' : `Invoice ${formatPeriod(lastPeriod)} now`}
            </button>
          )
        }
      />
      {close.data && <div className="notice notice-ok">{formatPeriod(close.data.period)}: {close.data.invoices} invoice(s) written or already there.</div>}
      <ErrorMessage error={close.error} title="Couldn't invoice" />

      <section className="tiles">
        <Tile icon={TrendingUp} label="This month so far" value={formatKes(summary.thisMonthEstimate)} sub="estimated fees if the month ended now" />
        <Tile
          icon={Banknote}
          label={`Earned in ${period.slice(0, 4)}`}
          value={formatKes(earned)}
          sub={`${formatKes(summary.earnedThisYear.commission.amount)} commission · ${formatKes(summary.earnedThisYear.subscription.amount)} subscriptions`}
        />
        <Tile
          icon={summary.overdue.count ? AlertTriangle : Clock}
          label="Unpaid subscriptions"
          value={formatKes(summary.outstanding.amount + summary.overdue.amount)}
          sub={summary.overdue.count ? `${summary.overdue.count} overdue (${formatKes(summary.overdue.amount)})` : `${summary.outstanding.count} not yet due`}
        />
        <Tile icon={Banknote} label="Payouts to send" value={formatKes(summary.payoutsPending.amount)} sub={`to ${summary.payoutsPending.count} partner month(s) on your till`} />
      </section>

      <div className="notice notice-info">
        <strong>How IsaPay charges.</strong> Partners on <strong>your till</strong> pay {defaults.percent}% of what they receive: you keep the fee and
        send them the rest (Payouts to send). Partners on <strong>their own till</strong> pay {formatKes(defaults.monthlyFee)} a month, invoiced after the
        month ends and collected by M-Pesa prompt into your till. The first {formatKes(defaults.freeAmount)} each month is free. Subscriptions are due{' '}
        {defaults.dueDays} days after the month; {defaults.graceDays} days after that, the platform can't start new payments until it pays. Your own
        platforms pay nothing. Change the defaults with the <code>BILLING_*</code> variables on Render, or one platform's price on its page.
      </div>

      <section className="card">
        <h2>Platforms this month</h2>
        {platforms.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Platform</th>
                  <th>Plan</th>
                  <th className="num">Received</th>
                  <th className="num">Fee so far</th>
                  <th>Standing</th>
                </tr>
              </thead>
              <tbody>
                {platforms.map((row) => (
                  <tr key={row.platform.id}>
                    <td>
                      <Link to={`/platforms/${row.platform.id}`}>{row.platform.name}</Link>
                      <span className="block small muted">
                        {row.platform.ownership === 'partner' ? 'partner' : 'yours'}
                        {row.till ? ` · ${row.till.label || row.till.name} (${row.till.owner === 'partner' ? 'their till' : 'your till'})` : ''}
                      </span>
                    </td>
                    <td>
                      {PLAN_LABELS[row.pricing.plan]}
                      <span className="block small muted">{planSummary(row.pricing)}</span>
                    </td>
                    <td className="num">
                      {formatKes(row.volume.amount)}
                      <span className="block small muted">{formatNumber(row.volume.count)} payments</span>
                    </td>
                    <td className="num">
                      <strong>{formatKes(row.estimatedFee)}</strong>
                    </td>
                    <td>
                      <StatusBadge status={row.standing === 'open' ? 'ok' : row.standing} />
                      {row.suspendAt && row.standing === 'overdue' && <span className="block small muted">suspended from {formatDateTime(row.suspendAt)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No platforms yet" />
        )}
      </section>

      <Invoices canEdit={canEdit} />
    </>
  );
}
