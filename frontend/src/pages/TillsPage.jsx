import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useTills } from '../api/queries.js';
import { Empty, ErrorMessage, PageHeader, Spinner, StatusBadge } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { formatDateTime } from '../utils/format.js';

const SOURCE = { env: 'Render variables', dashboard: 'Added in the dashboard', cli: 'Added from the command line' };

export default function TillsPage() {
  const { canEdit } = useAuth();
  const { data, isPending, error } = useTills();

  return (
    <>
      <PageHeader
        title="M-Pesa tills"
        subtitle="Where the money lands. Platforms point at a till; several can share one."
        actions={
          canEdit && (
            <Link to="/tills/new" className="btn btn-primary">
              <Plus size={16} aria-hidden="true" /> Add till
            </Link>
          )
        }
      />
      <div className="notice notice-info">
        Every till has a number, and its Daraja keys carry the same number (<strong>M-Pesa consumer key 1</strong>,{' '}
        <strong>M-Pesa consumer key 2</strong>…), so keys for different tills never overlap. On Render, till 1 uses <code>MPESA_CONSUMER_KEY</code>,
        till 2 uses <code>MPESA_CONSUMER_KEY_2</code>, and so on. Every change asks for your password again and is written to the audit log.
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
                <div>
                  {t.slot && <span className="slot-chip">{t.label}</span>}
                  <h2>
                    <Link to={`/tills/${t.id}`}>{t.name}</Link>
                  </h2>
                </div>
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
                  <dt>{t.slot ? `M-Pesa consumer key ${t.slot}` : 'Daraja credentials'}</dt>
                  <dd>{t.hasCredentials ? `Set${t.consumerKeyHint ? ` (ends ${t.consumerKeyHint})` : ''}` : 'Missing'}</dd>
                </div>
                {t.slot && (
                  <div className="kv-row">
                    <dt>Render variables</dt>
                    <dd className="mono small">MPESA_*{t.envSuffix}</dd>
                  </div>
                )}
                <div className="kv-row">
                  <dt>Platforms</dt>
                  <dd>{t.platformList?.map((p) => p.name).join(', ') || 'none'}</dd>
                </div>
                <div className="kv-row">
                  <dt>Added</dt>
                  <dd>
                    {formatDateTime(t.createdAt)}
                    {t.source && <span className="muted small block">{SOURCE[t.source]}</span>}
                  </dd>
                </div>
              </dl>
              <div className="button-row">
                <Link to={`/tills/${t.id}`} className="btn btn-ghost btn-small">
                  {canEdit ? 'Edit till' : 'View till'}
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty title="No tills yet">
          {canEdit ? 'Add one with “Add till”, or ' : ''}on Render set <code>MPESA_ENV</code>, <code>MPESA_SHORTCODE</code>, <code>MPESA_TILL_NUMBER</code>,{' '}
          <code>MPESA_CONSUMER_KEY</code>, <code>MPESA_CONSUMER_SECRET</code> and <code>MPESA_PASSKEY</code>, then redeploy.
        </Empty>
      )}
    </>
  );
}
