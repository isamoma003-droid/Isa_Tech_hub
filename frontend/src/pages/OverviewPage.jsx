import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarDays, CalendarRange, Clock, Scale, Target, Wallet, Webhook } from 'lucide-react';
import { useStats } from '../api/queries.js';
import { DailyChart, PlatformBars } from '../components/Charts.jsx';
import { Empty, ErrorMessage, PageHeader, Spinner, StatusBadge } from '../components/ui.jsx';
import { formatDateTime, formatKes, formatNumber, percent } from '../utils/format.js';

function Tile({ label, total, icon: Icon }) {
  return (
    <div className="tile">
      <span className="tile-label">
        <span className="tile-icon" aria-hidden="true">
          <Icon size={16} />
        </span>
        {label}
      </span>
      <span className="tile-value">{formatKes(total.amount)}</span>
      <span className="tile-sub">
        {formatNumber(total.count)} payment{total.count === 1 ? '' : 's'}
      </span>
    </div>
  );
}

export default function OverviewPage() {
  const { data, isPending, error } = useStats();
  if (isPending) return <Spinner />;
  if (error) return <ErrorMessage error={error} />;

  const { totals, days, byPlatform, successRate, attention, recent } = data;
  const alerts = [
    attention.pending > 0 && { to: '/payments?status=pending', icon: Clock, text: `${attention.pending} waiting for the payer`, tone: 'info' },
    attention.disputed > 0 && { to: '/payments?status=disputed', icon: Scale, text: `${attention.disputed} disputed (amount differs)`, tone: 'warn' },
    attention.failedWebhooks > 0 && { to: '/platforms', icon: Webhook, text: `${attention.failedWebhooks} webhook${attention.failedWebhooks === 1 ? '' : 's'} gave up`, tone: 'warn' },
  ].filter(Boolean);

  return (
    <>
      <PageHeader title="Overview" subtitle="Money received through IsaPay, in Kenya time. Updates every 30 seconds." />

      <section className="tiles">
        <Tile label="Today" total={totals.today} icon={Wallet} />
        <Tile label="Last 7 days" total={totals.week} icon={CalendarDays} />
        <Tile label="Last 30 days" total={totals.month} icon={CalendarRange} />
        <div className="tile">
          <span className="tile-label">
            <span className="tile-icon" aria-hidden="true">
              <Target size={16} />
            </span>
            Prompts that end in payment
          </span>
          <span className="tile-value">{percent(successRate)}</span>
          <span className="tile-sub">last 7 days, cancelled and failed included</span>
        </div>
      </section>

      {alerts.length > 0 && (
        <section className="alerts" aria-label="Needs attention">
          {alerts.map(({ to, icon: Icon, text, tone }) => (
            <Link key={text} to={to} className={`alert alert-${tone}`}>
              {tone === 'warn' ? <AlertTriangle size={16} aria-hidden="true" /> : <Icon size={16} aria-hidden="true" />}
              {text}
            </Link>
          ))}
        </section>
      )}

      <section className="grid-2">
        <div className="card">
          <h2>Received per day</h2>
          <p className="card-sub">Last 30 days, all platforms</p>
          {totals.month.count ? <DailyChart days={days} /> : <Empty title="No payments in the last 30 days" />}
        </div>
        <div className="card">
          <h2>By platform</h2>
          <p className="card-sub">Last 30 days</p>
          {byPlatform.length ? (
            <PlatformBars rows={byPlatform} />
          ) : (
            <Empty title="Nothing yet">Platforms appear here once their first payment arrives.</Empty>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Latest payments</h2>
          <Link to="/payments" className="btn btn-ghost btn-small">
            All payments
          </Link>
        </div>
        {recent.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Platform</th>
                  <th>Reference</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((p) => (
                  <tr key={p.id}>
                    <td className="nowrap">
                      <Link to={`/payments/${p.id}`}>{formatDateTime(p.createdAt)}</Link>
                    </td>
                    <td>{p.platform?.name}</td>
                    <td className="mono">{p.reference}</td>
                    <td className="num">{formatKes(p.amount)}</td>
                    <td>
                      <StatusBadge status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No payments yet">Add a platform, then start a payment from it.</Empty>
        )}
        <p className="hint">All time: {formatKes(totals.allTime.amount)} from {formatNumber(totals.allTime.count)} payments.</p>
      </section>
    </>
  );
}
