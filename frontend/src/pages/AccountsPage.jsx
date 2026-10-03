import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, BadgeCheck, KeyRound, MailCheck, Power, ShieldCheck, ShieldX, UserPlus } from 'lucide-react';
import { api } from '../api/client.js';
import { useAccount, useAccounts, useAction } from '../api/queries.js';
import { PLAN_LABELS, planSummary } from '../components/Billing.jsx';
import { Empty, ErrorMessage, Field, PageHeader, Pager, SecretReveal, Spinner, StatusBadge } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { formatDateTime, formatFullDateTime, formatKes, formatNumber, formatPayout, formatPhone, timeAgo } from '../utils/format.js';

const TABS = [
  ['pending', 'Waiting for approval'],
  ['merchant', 'Merchants'],
  ['staff', 'Team'],
  ['all', 'Everyone'],
];
const ROLE = { admin: 'Admin', viewer: 'Viewer', merchant: 'Merchant' };

function accountStatus(account) {
  if (!account.active) return 'inactive';
  if (account.role === 'merchant') return `approval-${account.approval?.status || 'pending'}`;
  return 'active';
}

function AddAccount({ onDone }) {
  const [form, setForm] = useState({ name: '', email: '', role: 'viewer', businessName: '' });
  const [created, setCreated] = useState(null);
  const create = useAction((body) => api('/accounts', { method: 'POST', body }), [['accounts']]);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  if (created) {
    return (
      <div className="card stack">
        <SecretReveal title={`Temporary password for ${created.account.email}`} value={created.password}>
          Give it to {created.account.name} over a safe channel. They change it under Your account
          {created.account.role === 'merchant' ? ', or sign in with Google using the same address' : ''}. It isn't shown again.
        </SecretReveal>
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="card form"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(form.role === 'merchant' ? form : { ...form, businessName: undefined }, { onSuccess: setCreated });
      }}
    >
      <h2>Add an account</h2>
      <p className="card-sub">A team member, or a business you onboard yourself (approved at once). They get a temporary password.</p>
      <ErrorMessage error={create.error} title="Not added" />
      <fieldset disabled={create.isPending}>
        <div className="form-grid">
          <Field label="Name">
            <input value={form.name} onChange={set('name')} required minLength={2} maxLength={80} />
          </Field>
          <Field label="Email">
            <input type="email" value={form.email} onChange={set('email')} required maxLength={120} />
          </Field>
          <Field label="Role">
            <select value={form.role} onChange={set('role')}>
              <option value="viewer">Team: viewer (read-only)</option>
              <option value="admin">Team: admin</option>
              <option value="merchant">Merchant (a business)</option>
            </select>
          </Field>
          {form.role === 'merchant' && (
            <Field label="Business name">
              <input value={form.businessName} onChange={set('businessName')} maxLength={100} />
            </Field>
          )}
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onDone}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            <UserPlus size={16} aria-hidden="true" /> {create.isPending ? 'Adding…' : 'Add account'}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

export function AccountsPage() {
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('show') ?? 'pending';
  const q = params.get('q') || '';
  const page = Number(params.get('page')) || 1;
  const [search, setSearch] = useState(q);
  const [adding, setAdding] = useState(false);
  const filters = { ...(tab === 'pending' ? { approval: 'pending' } : tab === 'all' ? {} : { kind: tab }), q, page };
  const { data, isPending, error, isFetching } = useAccounts(filters);
  const go = (next) => setParams(Object.fromEntries(Object.entries({ show: tab, q, ...next }).filter(([, v]) => v !== '' && v !== undefined && v !== 1)));

  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle="The ISA Tech team, and the businesses that use IsaPay. Approve a business to switch on its live payments."
        actions={
          isAdmin &&
          !adding && (
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              <UserPlus size={16} aria-hidden="true" /> Add account
            </button>
          )
        }
      />
      {adding && <AddAccount onDone={() => setAdding(false)} />}
      <section className={`card ${isFetching && !isPending ? 'refreshing' : ''}`}>
        <div className="card-head">
          <div className="segmented" role="tablist" aria-label="Show">
            {TABS.map(([value, label]) => (
              <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => go({ show: value, page: 1 })}>
                {label}
              </button>
            ))}
          </div>
          <form
            className="search-inline"
            onSubmit={(event) => {
              event.preventDefault();
              go({ q: search.trim(), page: 1 });
            }}
          >
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, email or business" aria-label="Search accounts" />
          </form>
        </div>
        {isPending ? (
          <Spinner />
        ) : error ? (
          <ErrorMessage error={error} />
        ) : data.accounts.length ? (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Who</th>
                    <th>Role</th>
                    <th>Business</th>
                    <th>Status</th>
                    <th className="num">Platforms</th>
                    <th>Joined</th>
                    <th>Last sign-in</th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Link to={`/accounts/${a.id}`}>{a.name}</Link>
                        <span className="block small muted">
                          {a.email}
                          {a.emailVerified ? ' · confirmed' : ''}
                          {a.googleLinked ? ' · Google' : ''}
                        </span>
                      </td>
                      <td>{ROLE[a.role]}</td>
                      <td>{a.business?.name || <span className="muted">—</span>}</td>
                      <td>
                        <StatusBadge status={accountStatus(a)} />
                      </td>
                      <td className="num">{formatNumber(a.platforms.length)}</td>
                      <td className="nowrap">{formatDateTime(a.createdAt)}</td>
                      <td className="nowrap">{timeAgo(a.lastLoginAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={data.page} pages={data.pages} onPage={(next) => go({ page: next })} />
          </>
        ) : (
          <Empty title={tab === 'pending' ? 'Nobody is waiting for approval' : 'No accounts here'}>
            {tab === 'pending' ? 'New businesses appear here when they sign up.' : null}
          </Empty>
        )}
      </section>
    </>
  );
}

function Row({ label, children }) {
  return (
    <div className="kv-row">
      <dt>{label}</dt>
      <dd>{children || <span className="muted">—</span>}</dd>
    </div>
  );
}

export function AccountDetailPage() {
  const { id } = useParams();
  const { admin: me, isAdmin } = useAuth();
  const { data, isPending, error } = useAccount(id);
  const [secret, setSecret] = useState(null);
  const refresh = [['account', id], ['accounts'], ['stats']];
  const approve = useAction((body) => api(`/accounts/${id}/approve`, { method: 'POST', body }), refresh);
  const reject = useAction((body) => api(`/accounts/${id}/reject`, { method: 'POST', body }), refresh);
  const update = useAction((body) => api(`/accounts/${id}`, { method: 'PATCH', body }), refresh);
  const reset = useAction(() => api(`/accounts/${id}/reset-password`, { method: 'POST' }), refresh);
  const verify = useAction(() => api(`/accounts/${id}/verify-email`, { method: 'POST' }), refresh);

  if (isPending) return <Spinner />;
  if (error) return <ErrorMessage error={error} />;
  const { account, platforms, tills } = data;
  const merchant = account.role === 'merchant';
  const self = account.id === me.id;
  const decided = approve.data || reject.data;
  const actionError = approve.error || reject.error || update.error || reset.error || verify.error;

  const onApprove = () => {
    if (window.confirm(`Approve ${account.business?.name || account.name}? Their platforms can take live payments at once.`)) approve.mutate({});
  };
  const onReject = () => {
    const note = window.prompt('Why not? The merchant sees this note and gets it by email:', account.approval?.note || '');
    if (note?.trim()) reject.mutate({ note: note.trim() });
  };

  return (
    <>
      <Link to="/accounts" className="back">
        <ArrowLeft size={16} aria-hidden="true" /> Accounts
      </Link>
      <PageHeader
        title={merchant && account.business?.name ? account.business.name : account.name}
        subtitle={`${account.name} · ${account.email} · ${ROLE[account.role]} since ${formatDateTime(account.createdAt)}`}
        actions={
          <>
            <StatusBadge status={accountStatus(account)} />
            <Link to={`/audit?target=${account.id}`} className="btn btn-ghost">
              History
            </Link>
          </>
        }
      />
      <ErrorMessage error={actionError} title="That didn't work" />
      {decided && (
        <div className="notice notice-ok">
          {decided.account.approval.status === 'approved' ? 'Approved: their platforms can take live payments.' : 'Marked not approved.'}{' '}
          {decided.emailed ? 'They were emailed.' : 'Email is off on this server, so let them know yourself.'}
        </div>
      )}
      {secret && (
        <div className="card">
          <SecretReveal title={`New temporary password for ${account.email}`} value={secret} />
          <button type="button" className="btn btn-ghost btn-small" onClick={() => setSecret(null)}>
            I've passed it on
          </button>
        </div>
      )}

      {isAdmin && (
        <section className="card">
          <h2>Actions</h2>
          <div className="button-row">
            {merchant && account.approval?.status !== 'approved' && (
              <button type="button" className="btn btn-primary" disabled={approve.isPending} onClick={onApprove}>
                <ShieldCheck size={16} aria-hidden="true" /> Approve for live payments
              </button>
            )}
            {merchant && account.approval?.status !== 'rejected' && (
              <button type="button" className="btn btn-ghost" disabled={reject.isPending} onClick={onReject}>
                <ShieldX size={16} aria-hidden="true" /> {account.approval?.status === 'approved' ? 'Withdraw approval' : 'Don’t approve'}
              </button>
            )}
            {!account.emailVerified && (
              <button type="button" className="btn btn-ghost" disabled={verify.isPending} onClick={() => verify.mutate()}>
                <MailCheck size={16} aria-hidden="true" /> Mark email confirmed
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              disabled={reset.isPending}
              onClick={() => window.confirm(`Give ${account.email} a new temporary password? Their sessions end.`) && reset.mutate(undefined, { onSuccess: (r) => setSecret(r.password) })}
            >
              <KeyRound size={16} aria-hidden="true" /> New temporary password
            </button>
            {!merchant && !self && (
              <button type="button" className="btn btn-ghost" disabled={update.isPending} onClick={() => update.mutate({ role: account.role === 'admin' ? 'viewer' : 'admin' })}>
                <BadgeCheck size={16} aria-hidden="true" /> Make {account.role === 'admin' ? 'viewer' : 'admin'}
              </button>
            )}
            {!self && (
              <button
                type="button"
                className={`btn ${account.active ? 'btn-danger' : 'btn-ghost'}`}
                disabled={update.isPending}
                onClick={() =>
                  account.active
                    ? window.confirm(`Deactivate ${account.email}? They're signed out${merchant ? ', and their platforms stop taking payments' : ''}.`) &&
                      update.mutate({ active: false })
                    : update.mutate({ active: true })
                }
              >
                <Power size={16} aria-hidden="true" /> {account.active ? 'Deactivate' : 'Reactivate'}
              </button>
            )}
          </div>
        </section>
      )}

      <section className="grid-2">
        <div className="card">
          <h2>{merchant ? 'Business' : 'Person'}</h2>
          <dl className="kv">
            {merchant && <Row label="Business">{account.business?.name}</Row>}
            {merchant && (
              <Row label="Website">
                {account.business?.website && (
                  <a href={account.business.website} target="_blank" rel="noreferrer noopener">
                    {account.business.website}
                  </a>
                )}
              </Row>
            )}
            {merchant && <Row label="What they sell">{account.business?.description}</Row>}
            <Row label="Contact">{account.name}</Row>
            <Row label="Email">
              {account.email} {account.emailVerified ? '(confirmed)' : '(not confirmed)'}
            </Row>
            <Row label="Phone">{formatPhone(account.phone)}</Row>
            <Row label="Signs in with">{[account.hasPassword && 'password', account.googleLinked && 'Google'].filter(Boolean).join(' and ')}</Row>
            <Row label="Last sign-in">{account.lastLoginAt && formatFullDateTime(account.lastLoginAt)}</Row>
          </dl>
        </div>
        {merchant && (
          <div className="card">
            <h2>Approval and payouts</h2>
            <dl className="kv">
              <Row label="Approval">
                <StatusBadge status={`approval-${account.approval?.status || 'pending'}`} />
                {account.approval?.at && (
                  <span className="block small muted">
                    {formatDateTime(account.approval.at)}
                    {account.approval.by ? ` by ${account.approval.by}` : ''}
                  </span>
                )}
              </Row>
              <Row label="Note">{account.approval?.note}</Row>
              <Row label="Payouts by">{formatPayout(account.payout)}</Row>
            </dl>
            <p className="hint">Payouts are for platforms on an ISA till: Billing → Payouts to send lists what's owed.</p>
          </div>
        )}
      </section>

      {(merchant || platforms.length > 0) && (
        <section className="card">
          <h2>Platforms</h2>
          {platforms.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Platform</th>
                    <th>Till</th>
                    <th>Plan</th>
                    <th className="num">Last 30 days</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {platforms.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link to={`/platforms/${p.id}`}>{p.name}</Link>
                        <span className="block small muted mono">{p.slug}</span>
                      </td>
                      <td>
                        {p.till ? `${p.till.name} (${p.till.payNumber})` : '—'}
                        {p.till && <span className="block small muted">{p.till.environment === 'sandbox' ? 'sandbox' : p.till.owner === 'partner' ? 'their till' : 'ISA till'}</span>}
                      </td>
                      <td>
                        {PLAN_LABELS[p.pricing.plan]}
                        <span className="block small muted">{planSummary(p.pricing)}</span>
                      </td>
                      <td className="num">
                        {formatKes(p.stats.month.amount)}
                        <span className="block small muted">{formatNumber(p.stats.month.count)} paid</span>
                      </td>
                      <td>
                        <StatusBadge status={p.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No platforms yet" />
          )}
          {tills.length > 0 && (
            <>
              <h3>Their own tills</h3>
              <ul className="plain-list">
                {tills.map((t) => (
                  <li key={t.id}>
                    <Link to={`/tills/${t.id}`}>{t.name}</Link> · {t.kind === 'till' ? 'Buy Goods' : 'Paybill'} {t.payNumber} · {t.environment}
                    {t.active ? '' : ' · off'}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </>
  );
}
