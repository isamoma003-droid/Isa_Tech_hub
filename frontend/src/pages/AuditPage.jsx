import { Link, useSearchParams } from 'react-router-dom';
import { useAudit } from '../api/queries.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Empty, ErrorMessage, PageHeader, Pager, Spinner } from '../components/ui.jsx';
import { formatFullDateTime } from '../utils/format.js';

const TARGET_LINKS = { platform: (id) => `/platforms/${id}`, payment: (id) => `/payments/${id}`, till: (id) => `/tills/${id}` };

function Details({ details }) {
  if (!details || !Object.keys(details).length) return null;
  return (
    <ul className="audit-details">
      {Object.entries(details).map(([key, value]) => (
        <li key={key}>
          <span className="muted">{key}:</span>{' '}
          {value && typeof value === 'object' && 'from' in value
            ? `${JSON.stringify(value.from) ?? '—'} → ${JSON.stringify(value.to)}`
            : typeof value === 'object'
              ? JSON.stringify(value)
              : String(value)}
        </li>
      ))}
    </ul>
  );
}

export default function AuditPage() {
  const { isMerchant, isStaff } = useAuth();
  const links = isStaff ? { ...TARGET_LINKS, admin: (id) => `/accounts/${id}` } : TARGET_LINKS;
  const [params, setParams] = useSearchParams();
  const target = params.get('target') || '';
  const page = Number(params.get('page')) || 1;
  const { data, isPending, error } = useAudit({ target, page });

  return (
    <>
      <PageHeader
        title={isMerchant ? 'Activity' : 'Audit log'}
        subtitle={
          target
            ? 'Changes to one item.'
            : isMerchant
              ? 'Sign-ins and every change to your account, platforms and tills. Entries cannot be edited.'
              : 'Every change made from the dashboard or the server command line. Entries cannot be edited.'
        }
        actions={
          target && (
            <Link to="/audit" className="btn btn-ghost">
              Show everything
            </Link>
          )
        }
      />
      {isPending ? (
        <Spinner />
      ) : error ? (
        <ErrorMessage error={error} />
      ) : data.entries.length ? (
        <section className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>Item</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap">{formatFullDateTime(e.createdAt)}</td>
                    <td>
                      {e.actorLabel}
                      {e.ip && <small className="muted block">{e.ip}</small>}
                    </td>
                    <td>
                      <span className="mono">{e.action}</span>
                      <Details details={e.details} />
                    </td>
                    <td>
                      {e.target?.id && links[e.target.type] ? (
                        <Link to={links[e.target.type](e.target.id)}>{e.target.label || e.target.id}</Link>
                      ) : (
                        e.target?.label || '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            page={data.page}
            pages={data.pages}
            onPage={(next) => setParams(Object.fromEntries(Object.entries({ target, page: next > 1 ? next : '' }).filter(([, v]) => v)))}
          />
        </section>
      ) : (
        <Empty title="Nothing recorded yet" />
      )}
    </>
  );
}
