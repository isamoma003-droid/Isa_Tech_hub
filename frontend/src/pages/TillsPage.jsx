import { useTills } from '../api/queries.js';
import { Empty, ErrorMessage, PageHeader, Spinner, StatusBadge } from '../components/ui.jsx';
import { formatDateTime } from '../utils/format.js';

export default function TillsPage() {
  const { data, isPending, error } = useTills();

  return (
    <>
      <PageHeader title="Tills" subtitle="Where the money lands. Platforms point at a till; several can share one." />
      <div className="notice notice-info">
        Tills and their Daraja credentials are set on the server only: the <code>MPESA_*</code> environment variables on Render (applied when
        the server starts), or <code>npm run till</code> for extra tills. Never from this dashboard, so a stolen dashboard password can't send
        customers' money to a different till.
      </div>
      {isPending ? (
        <Spinner />
      ) : error ? (
        <ErrorMessage error={error} />
      ) : data.tills.length ? (
        <div className="platform-grid">
          {data.tills.map((t) => (
            <div key={t.id} className="card">
              <div className="card-head">
                <h2>{t.name}</h2>
                <StatusBadge status={t.active ? 'active' : 'disabled'} />
              </div>
              <p className="platform-money">
                {t.payNumber}
                <small>{t.kind === 'till' ? 'Buy Goods till' : 'Paybill'}</small>
              </p>
              <dl className="kv kv-tight">
                <div className="kv-row">
                  <dt>Environment</dt>
                  <dd>{t.environment === 'production' ? 'Live' : 'Sandbox (test money)'}</dd>
                </div>
                <div className="kv-row">
                  <dt>Signs requests with</dt>
                  <dd className="mono">{t.shortcode}</dd>
                </div>
                <div className="kv-row">
                  <dt>Daraja credentials</dt>
                  <dd>{t.hasCredentials ? 'Set' : 'Missing: run npm run till -- set-credentials'}</dd>
                </div>
                <div className="kv-row">
                  <dt>Platforms</dt>
                  <dd>{t.platforms}</dd>
                </div>
                <div className="kv-row">
                  <dt>Callback</dt>
                  <dd className="mono small break">{t.callbackUrl}</dd>
                </div>
                <div className="kv-row">
                  <dt>Added</dt>
                  <dd>{formatDateTime(t.createdAt)}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      ) : (
        <Empty title="No tills yet">
          On Render, set <code>MPESA_ENV</code>, <code>MPESA_SHORTCODE</code>, <code>MPESA_TILL_NUMBER</code>, <code>MPESA_CONSUMER_KEY</code>,{' '}
          <code>MPESA_CONSUMER_SECRET</code> and <code>MPESA_PASSKEY</code>, then redeploy. The till appears here once the server restarts.
        </Empty>
      )}
    </>
  );
}
