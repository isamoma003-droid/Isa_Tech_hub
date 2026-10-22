import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Link2, Pencil, Plus, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { api } from '../api/client.js';
import { useAction, useAuthConfig, usePaymentLinks, usePlatforms } from '../api/queries.js';
import { CopyButton, ErrorMessage, Field, PageHeader, Spinner } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { formatDateTime, formatKes } from '../utils/format.js';

const INITIAL = {
  platform: '',
  title: '',
  description: '',
  amountType: 'fixed',
  amount: '',
  minAmount: '1',
  maxAmount: '150000',
  usage: 'reusable',
  collectName: true,
  collectEmail: true,
};

function LinkForm({ platforms, limits, item, mutation, onCancel, onSaved }) {
  const [form, setForm] = useState(() => ({
    ...INITIAL,
    minAmount: String(limits.minAmount),
    maxAmount: String(limits.maxAmount),
    ...(item && {
      platform: item.platform?.id || '',
      title: item.title,
      description: item.description,
      amountType: item.amountType,
      amount: item.amount === null ? '' : String(item.amount),
      minAmount: String(item.minAmount ?? limits.minAmount),
      maxAmount: String(item.maxAmount ?? limits.maxAmount),
      usage: item.usage,
      collectName: item.collectName,
      collectEmail: item.collectEmail,
    }),
  }));
  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const configurationLocked = item?.status === 'paid';

  const submit = (event) => {
    event.preventDefault();
    const body = {
      title: form.title,
      description: form.description,
      ...(!configurationLocked && { amountType: form.amountType }),
      ...(!configurationLocked && {
        usage: form.usage,
        collectName: form.collectName,
        collectEmail: form.collectEmail,
      }),
      ...(item ? {} : { platform: form.platform || platforms[0]?.id || '' }),
      ...(!configurationLocked && (form.amountType === 'fixed'
        ? { amount: Number(form.amount) }
        : { minAmount: Number(form.minAmount), maxAmount: Number(form.maxAmount) })),
    };
    if (!configurationLocked) {
      if (form.amountType === 'fixed') delete body.minAmount;
      else delete body.amount;
    }
    mutation.mutate(item ? { id: item.id, body } : body, { onSuccess: (result) => onSaved(result?.paymentLink) });
  };

  return (
    <section className="card stack">
      <h2>{item ? `Edit ${item.title}` : 'Create a payment link'}</h2>
      {configurationLocked && <p className="hint">This single-use link has been paid. Only its name and description can be changed.</p>}
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Platform">
            <select value={form.platform || platforms[0]?.id || ''} onChange={(event) => update('platform', event.target.value)} required disabled={Boolean(item)}>
              {platforms.map((platform) => <option value={platform.id} key={platform.id}>{platform.name}</option>)}
            </select>
          </Field>
          <Field label="Link name">
            <input value={form.title} onChange={(event) => update('title', event.target.value)} required minLength={2} maxLength={100} placeholder="e.g. Event ticket" />
          </Field>
        </div>
        <Field label="Description" hint="Optional details shown on the checkout page.">
          <textarea rows="2" value={form.description} onChange={(event) => update('description', event.target.value)} maxLength={500} />
        </Field>
        <div className="form-grid">
          <Field label="Amount">
            <select value={form.amountType} onChange={(event) => update('amountType', event.target.value)} disabled={configurationLocked}>
              <option value="fixed">Fixed amount</option>
              <option value="customer">Customer enters amount</option>
            </select>
          </Field>
          <Field label="Link usage">
            <select value={form.usage} onChange={(event) => update('usage', event.target.value)} disabled={configurationLocked}>
              <option value="reusable">Reusable</option>
              <option value="single-use">Single use</option>
            </select>
          </Field>
        </div>
        {form.amountType === 'fixed' ? (
          <Field label="Amount (KES)">
            <input type="number" min="1" step="1" value={form.amount} onChange={(event) => update('amount', event.target.value)} required disabled={configurationLocked} />
          </Field>
        ) : (
          <div className="form-grid">
            <Field label="Minimum (KES)">
              <input type="number" min="1" step="1" value={form.minAmount} onChange={(event) => update('minAmount', event.target.value)} required disabled={configurationLocked} />
            </Field>
            <Field label="Maximum (KES)">
              <input type="number" min="1" step="1" value={form.maxAmount} onChange={(event) => update('maxAmount', event.target.value)} required disabled={configurationLocked} />
            </Field>
          </div>
        )}
        <fieldset className="link-fields">
          <legend>Ask the customer for</legend>
          <label><input type="checkbox" checked={form.collectName} onChange={(event) => update('collectName', event.target.checked)} disabled={configurationLocked} /> Name</label>
          <label><input type="checkbox" checked={form.collectEmail} onChange={(event) => update('collectEmail', event.target.checked)} disabled={configurationLocked} /> Email and receipt</label>
        </fieldset>
        <ErrorMessage error={mutation.error} title={item ? 'Payment link not updated' : 'Payment link not created'} />
        <div className="button-row">
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending || (!item && !platforms.length)}>
            {mutation.isPending ? (item ? 'Saving…' : 'Creating…') : item ? 'Save changes' : 'Create link'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </section>
  );
}

export default function PaymentLinksPage() {
  const { canEdit } = useAuth();
  const links = usePaymentLinks();
  const platformsQuery = usePlatforms();
  const config = useAuthConfig();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [created, setCreated] = useState(null);
  const create = useAction((body) => api('/payment-links', { method: 'POST', body }), [['payment-links']]);
  const update = useAction(({ id, body }) => api(`/payment-links/${id}`, { method: 'PATCH', body }), [['payment-links']]);
  const toggle = useAction(
    ({ id, active }) => api(`/payment-links/${id}`, { method: 'PATCH', body: { active } }),
    [['payment-links']],
  );
  const remove = useAction(({ id }) => api(`/payment-links/${id}`, { method: 'DELETE' }), [['payment-links']]);

  if (links.isPending || platformsQuery.isPending || config.isPending) return <Spinner />;
  if (links.error) return <ErrorMessage error={links.error} />;
  if (platformsQuery.error) return <ErrorMessage error={platformsQuery.error} />;
  if (config.error) return <ErrorMessage error={config.error} />;
  const items = links.data.paymentLinks;
  const platforms = platformsQuery.data.platforms.filter((platform) => platform.status === 'active');

  return (
    <>
      <PageHeader
        title="Payment links"
        subtitle="Share a secure checkout page and accept M-Pesa payments without building a checkout flow."
        actions={canEdit && <button type="button" className="btn btn-primary" onClick={() => { setEditing(null); setShowForm((value) => !value); }}><Plus size={16} aria-hidden="true" /> Create link</button>}
      />
      <ErrorMessage error={toggle.error} title="Could not update link" />
      <ErrorMessage error={update.error || remove.error} title="Could not update payment link" />
      {created && (
        <div className="notice notice-ok payment-link-created" role="status">
          <div><strong>Your payment link is ready</strong><p>{created.url}</p></div>
          <CopyButton value={created.url} label="Copy link" />
        </div>
      )}
      {showForm && canEdit && (
        platforms.length ? (
          <LinkForm platforms={platforms} limits={config.data.limits} mutation={create} onCancel={() => setShowForm(false)} onSaved={(link) => { setCreated(link); setShowForm(false); }} />
        ) : (
          <div className="notice notice-warn"><p>Set up an active platform before creating a payment link. <Link to="/platforms/new">Add a platform</Link>.</p></div>
        )
      )}
      {editing && canEdit && (
        <LinkForm
          key={editing.id}
          platforms={platformsQuery.data.platforms}
          limits={config.data.limits}
          item={editing}
          mutation={update}
          onCancel={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}
      {items.length ? (
        <div className="payment-links-list">
          {items.map((item) => (
            <article className="card payment-link-card" key={item.id}>
              <div className="payment-link-main">
                <span className="payment-link-icon"><Link2 size={18} aria-hidden="true" /></span>
                <div>
                  <h2>{item.title}</h2>
                  <p>{item.platform?.name || 'Platform'} · {item.amountType === 'fixed' ? formatKes(item.amount) : `${formatKes(item.minAmount)} – ${formatKes(item.maxAmount)}`} · {item.usage === 'single-use' ? 'Single use' : 'Reusable'}</p>
                  <div className="payment-link-url"><code>{item.url}</code><CopyButton value={item.url} label="Copy" /></div>
                  <small className="muted">{item.successfulPayments} successful · Created {formatDateTime(item.createdAt)}</small>
                </div>
              </div>
              <div className="payment-link-actions">
                <span className={`badge badge-${item.status === 'active' ? 'active' : item.status === 'paid' ? 'paid' : 'disabled'}`}>{item.status === 'paid' ? 'Paid' : item.status === 'active' ? 'Active' : 'Paused'}</span>
                <a href={item.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-small" aria-label={`Open ${item.title} checkout`}><ExternalLink size={15} /> Open</a>
                {canEdit && (
                  <>
                    <button type="button" className="btn btn-ghost btn-small" onClick={() => { setShowForm(false); setEditing(item); }}><Pencil size={15} aria-hidden="true" /> Edit</button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(`Delete "${item.title}"? Its checkout link will stop working; payment history will be kept.`)) remove.mutate({ id: item.id });
                      }}
                    >
                      <Trash2 size={15} aria-hidden="true" /> Delete
                    </button>
                  </>
                )}
                {canEdit && item.status !== 'paid' && (
                  <button type="button" className="btn btn-ghost btn-small" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: item.id, active: item.status !== 'active' })}>
                    {item.status === 'active' ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                    {item.status === 'active' ? 'Pause' : 'Enable'}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : !showForm && (
        <div className="card empty"><strong>No payment links yet</strong><p>Create a link to give customers a hosted M-Pesa checkout page.</p></div>
      )}
    </>
  );
}
