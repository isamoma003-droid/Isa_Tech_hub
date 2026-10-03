import { Link } from 'react-router-dom';
import { AlertTriangle, Plus } from 'lucide-react';
import { usePlatforms } from '../api/queries.js';
import { Empty, ErrorMessage, PageHeader, Spinner, StatusBadge } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { formatKes, formatNumber, timeAgo } from '../utils/format.js';

export default function PlatformsPage() {
  const { canEdit, isMerchant } = useAuth();
  const { data, isPending, error } = usePlatforms();

  return (
    <>
      <PageHeader
        title={isMerchant ? 'Your platforms' : 'Platforms'}
        subtitle={
          isMerchant
            ? 'Your sites and apps that take M-Pesa payments through IsaPay. Each has its own API key and webhook.'
            : 'Your sites and apps, and partners using IsaPay as their M-Pesa payment gateway.'
        }
        actions={
          canEdit && (
            <Link to="/platforms/new" className="btn btn-primary">
              <Plus size={16} aria-hidden="true" /> Add platform
            </Link>
          )
        }
      />
      {isPending ? (
        <Spinner />
      ) : error ? (
        <ErrorMessage error={error} />
      ) : data.platforms.length ? (
        <div className="platform-grid">
          {data.platforms.map((p) => (
            <Link key={p.id} to={`/platforms/${p.id}`} className="card platform-card">
              <div className="card-head">
                <h2>{p.name}</h2>
                <StatusBadge status={p.status} />
              </div>
              <p className="muted small mono">
                {p.slug}
                {!isMerchant && ` · ${p.owner ? p.owner.business || p.owner.name : p.ownership === 'partner' ? 'partner' : 'ours'}`}
              </p>
              <p className="platform-money">
                {formatKes(p.stats.month.amount)}
                <small>
                  {formatNumber(p.stats.month.count)} paid in 30 days
                </small>
              </p>
              <dl className="kv kv-tight">
                <div className="kv-row">
                  <dt>Till</dt>
                  <dd>{p.till ? `${p.till.name} (${p.till.payNumber})` : '—'}</dd>
                </div>
                <div className="kv-row">
                  <dt>Last payment</dt>
                  <dd>{timeAgo(p.stats.lastPaymentAt)}</dd>
                </div>
                <div className="kv-row">
                  <dt>Webhook</dt>
                  <dd>{p.webhookUrl ? new URL(p.webhookUrl).host : 'not set'}</dd>
                </div>
              </dl>
              {p.stats.failedWebhooks > 0 && (
                <p className="alert alert-warn">
                  <AlertTriangle size={16} aria-hidden="true" /> {p.stats.failedWebhooks} webhook{p.stats.failedWebhooks === 1 ? '' : 's'} gave up
                </p>
              )}
            </Link>
          ))}
        </div>
      ) : (
        <Empty title="No platforms yet">
          {isMerchant
            ? 'Add your site or app to get its API key, then start M-Pesa payments from its server.'
            : canEdit
              ? 'Add egertickets, A-Read or a partner platform to start taking payments.'
              : 'An admin can add the first platform.'}
        </Empty>
      )}
    </>
  );
}
