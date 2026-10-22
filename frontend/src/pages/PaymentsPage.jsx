import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, Search } from 'lucide-react';
import { download, queryString } from '../api/client.js';
import { usePayments, usePlatforms } from '../api/queries.js';
import { Empty, ErrorMessage, PageHeader, Pager, Spinner, StatusBadge } from '../components/ui.jsx';
import { formatDateTime, formatKes, formatNumber } from '../utils/format.js';

const STATUSES = ['paid', 'pending', 'failed', 'disputed'];

export default function PaymentsPage() {
  const [params, setParams] = useSearchParams();
  const filters = {
    platform: params.get('platform') || '',
    status: params.get('status') || '',
    q: params.get('q') || '',
    from: params.get('from') || '',
    to: params.get('to') || '',
    page: Number(params.get('page')) || 1,
  };
  // The search box follows the address bar when it changes (back button, links).
  const [search, setSearch] = useState(filters.q);
  const [shownQ, setShownQ] = useState(filters.q);
  if (shownQ !== filters.q) {
    setShownQ(filters.q);
    setSearch(filters.q);
  }

  const { data, isPending, isFetching, error } = usePayments(filters);
  const { data: platformData } = usePlatforms();
  const [exportError, setExportError] = useState(null);

  // Filters live in the address bar, so a filtered view can be bookmarked or shared.
  const update = (changes) => {
    const next = { ...filters, page: 1, ...changes };
    setParams(
      Object.fromEntries(Object.entries(next).filter(([key, value]) => value && !(key === 'page' && value === 1))),
      { replace: true },
    );
  };

  const exportCsv = async () => {
    setExportError(null);
    try {
      const { page: _page, ...rest } = filters;
      await download(`/payments/export.csv${queryString(rest)}`, 'payments.csv');
    } catch (err) {
      setExportError(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Payments"
        subtitle="Every M-Pesa prompt IsaPay has sent, newest first."
        actions={
          <button type="button" className="btn btn-ghost" onClick={exportCsv}>
            <Download size={16} aria-hidden="true" />
            Export CSV
          </button>
        }
      />
      <ErrorMessage error={exportError} title="Export failed" />

      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          update({ q: search.trim() });
        }}
      >
        <label className="filter">
          <span>From</span>
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => update({ from: e.target.value })} />
        </label>
        <label className="filter">
          <span>To</span>
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => update({ to: e.target.value })} />
        </label>
        <label className="filter">
          <span>Platform</span>
          <select value={filters.platform} onChange={(e) => update({ platform: e.target.value })}>
            <option value="">All platforms</option>
            {platformData?.platforms.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="filter">
          <span>Status</span>
          <select value={filters.status} onChange={(e) => update({ status: e.target.value })}>
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="filter filter-search">
          <span>Search</span>
          <span className="search-box">
            <input
              type="search"
              placeholder="Reference, M-Pesa confirmation code or phone"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onBlur={() => search.trim() !== filters.q && update({ q: search.trim() })}
            />
            <button type="submit" className="icon-btn" aria-label="Search">
              <Search size={16} />
            </button>
          </span>
        </label>
      </form>

      {isPending ? (
        <Spinner />
      ) : error ? (
        <ErrorMessage error={error} />
      ) : (
        <section className={`card ${isFetching ? 'refreshing' : ''}`}>
          <p className="card-sub">
            {formatNumber(data.total)} payment{data.total === 1 ? '' : 's'} · {formatKes(data.paid.amount)} received from {formatNumber(data.paid.count)} paid
          </p>
          {data.payments.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Platform</th>
                    <th>Reference</th>
                    <th>Phone</th>
                    <th className="num">Amount</th>
                    <th>Status</th>
                    <th>M-Pesa confirmation code</th>
                  </tr>
                </thead>
                <tbody>
                  {data.payments.map((p) => (
                    <tr key={p.id}>
                      <td className="nowrap">
                        <Link to={`/payments/${p.id}`}>{formatDateTime(p.createdAt)}</Link>
                      </td>
                      <td>{p.platform?.name}</td>
                      <td className="mono">
                        {p.purpose === 'payment-link' && p.mpesaReceipt ? p.mpesaReceipt : p.reference}
                        {p.purpose && <small className="muted"> · {p.purpose}</small>}
                      </td>
                      <td className="mono">{p.phone}</td>
                      <td className="num">
                        {formatKes(p.amount)}
                        {p.paidAmount !== null && p.paidAmount !== p.amount && <small className="muted"> (paid {formatKes(p.paidAmount)})</small>}
                      </td>
                      <td>
                        <StatusBadge status={p.status} />
                      </td>
                      <td className="mono">{p.mpesaReceipt || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No payments match">Try a wider date range or clear the filters.</Empty>
          )}
          <Pager page={data.page} pages={data.pages} onPage={(page) => update({ page })} />
        </section>
      )}
    </>
  );
}
