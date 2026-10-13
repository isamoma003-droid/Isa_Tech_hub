import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccounts, useTills } from '../api/queries.js';
import { BRAND } from '../brand.js';
import { useAuth } from '../context/AuthContext.jsx';
import { ErrorMessage, Field } from './ui.jsx';

const blank = {
  name: '',
  slug: '',
  website: '',
  till: '',
  ownership: 'own',
  owner: '',
  webhookUrl: '',
  accountReference: '',
  contact: { name: '', email: '', phone: '' },
  notes: '',
};

const slugify = (text) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);

// A merchant picks IsaPay's till ("isapay": the money lands with IsaPay, which pays it out) or
// one of its own tills; staff pick any till.
const tillValue = (till, isMerchant) => (!till ? '' : isMerchant && !till.account ? 'isapay' : till.id || till);

// Merchant accounts staff can hand a platform to.
function OwnerField({ value, onChange, error }) {
  const { data } = useAccounts({ kind: 'merchant' });
  return (
    <Field label="Run by" hint="A merchant account that manages this platform in the dashboard." error={error}>
      <select value={value} onChange={onChange}>
        <option value="">ISA Tech (no merchant account)</option>
        {(data?.accounts || []).map((a) => (
          <option key={a.id} value={a.id}>
            {a.business?.name || a.name} · {a.email}
          </option>
        ))}
      </select>
    </Field>
  );
}

// Shared by "Add platform" and a platform's settings. The slug is fixed once created.
export default function PlatformForm({ initial, submitLabel, onSubmit, busy, error, disabled }) {
  const { isMerchant, isStaff } = useAuth();
  const { data: tillData } = useTills();
  const initialTill = tillValue(initial?.till, isMerchant);
  const [form, setForm] = useState(() => ({
    ...blank,
    ...initial,
    till: initialTill,
    owner: initial?.owner?.id || '',
    contact: { ...blank.contact, ...initial?.contact },
  }));
  const [slugTouched, setSlugTouched] = useState(Boolean(initial));
  const isNew = !initial;
  const fieldError = (path) => error?.details?.find((d) => d.path === path)?.message;

  const set = (key) => (event) => {
    const value = event.target.value;
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key === 'name' && isNew && !slugTouched ? { slug: slugify(value) } : {}),
    }));
  };
  const setContact = (key) => (event) => setForm((current) => ({ ...current, contact: { ...current.contact, [key]: event.target.value } }));

  const submit = (event) => {
    event.preventDefault();
    const { slug, ...rest } = form;
    const body = { name: rest.name, website: rest.website, till: rest.till, webhookUrl: rest.webhookUrl, accountReference: rest.accountReference, contact: rest.contact, notes: rest.notes };
    // Only staff decide whose platform it is.
    if (isStaff) Object.assign(body, { ownership: rest.ownership, owner: rest.owner });
    // An unchanged till is left alone, so saving other settings never moves the money.
    if (!isNew && body.till === initialTill) delete body.till;
    onSubmit(isNew ? { ...body, slug } : body);
  };

  const tills = tillData?.tills || [];
  // Examples in the placeholders: ISA's own platforms for the team, a generic shop for merchants.
  const example = isMerchant
    ? { name: 'My Shop', slug: 'my-shop', website: 'https://myshop.co.ke', reference: 'MyShop', webhook: 'https://api.myshop.co.ke/payments/isapay-webhook' }
    : { name: 'A-Read', slug: 'a-read', website: 'https://a-read.vercel.app', reference: 'A-Read', webhook: 'https://api.a-read.example/api/payments/hub-webhook' };
  const selectedTill = tills.find((t) => t.id === form.till);
  const tillHint =
    form.till === 'isapay'
      ? `${BRAND.name} collects the money in its till and pays it out to you, minus a small percentage. Set your payout details under Your account.`
      : selectedTill
        ? isMerchant
          ? `Customers pay your ${selectedTill.kind === 'till' ? 'till' : 'Paybill'} ${selectedTill.payNumber} (${selectedTill.environment}). ${BRAND.name} bills a monthly subscription.`
          : `Customers pay ${selectedTill.kind === 'till' ? 'till' : 'Paybill'} ${selectedTill.payNumber} (${selectedTill.environment}).`
        : "Where this platform's money lands.";

  return (
    <form className="form" onSubmit={submit}>
      <ErrorMessage error={error} title="Please check the form" />
      <fieldset disabled={disabled || busy}>
        <div className="form-grid">
          <Field label="Name" error={fieldError('name')}>
            <input value={form.name} onChange={set('name')} required maxLength={60} placeholder={example.name} />
          </Field>
          <Field label="Slug" hint={isNew ? 'Short permanent id used in webhooks and reports.' : 'Fixed once created.'} error={fieldError('slug')}>
            <input
              value={form.slug}
              onChange={(e) => {
                setSlugTouched(true);
                set('slug')(e);
              }}
              required
              disabled={!isNew}
              pattern="[a-z0-9][a-z0-9\-]{1,29}"
              placeholder={example.slug}
            />
          </Field>
          <Field label="Website" error={fieldError('website')}>
            <input value={form.website} onChange={set('website')} placeholder={example.website} />
          </Field>
          {isStaff && (
            <Field label="Whose platform" error={fieldError('ownership')}>
              <select value={form.ownership} onChange={set('ownership')}>
                <option value="own">Ours</option>
                <option value="partner">A partner's</option>
              </select>
            </Field>
          )}
          <Field
            label="Till"
            hint={
              <>
                {tillHint}{' '}
                {selectedTill && <Link to={`/tills/${selectedTill.id}`}>Till details</Link>}
                {isMerchant && !tills.length && <Link to="/tills/new">Add your own till</Link>}
              </>
            }
            error={fieldError('till')}
          >
            <select value={form.till} onChange={set('till')} required>
              <option value="" disabled>
                {isMerchant ? 'Choose where the money goes' : tills.length ? 'Choose a till' : 'No tills yet: add one from the server'}
              </option>
              {isMerchant && <option value="isapay">{BRAND.name}'s till (we collect for you)</option>}
              {tills.map((t) => (
                <option key={t.id} value={t.id} disabled={!t.active}>
                  {isMerchant ? 'Your till: ' : ''}
                  {t.name} · {t.payNumber} · {t.environment}
                  {t.account && !isMerchant ? ` · ${t.account.name}` : ''}
                  {t.active ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </Field>
          {isStaff && <OwnerField value={form.owner} onChange={set('owner')} error={fieldError('owner')} />}
          <Field label="Account reference" hint="Shown on the payer's M-Pesa prompt. 12 characters max." error={fieldError('accountReference')}>
            <input value={form.accountReference} onChange={set('accountReference')} maxLength={12} placeholder={example.reference} />
          </Field>
        </div>
        <Field
          label="Webhook URL"
          hint="IsaPay posts payment.paid, payment.failed and payment.disputed here, signed with the platform's webhook secret."
          error={fieldError('webhookUrl')}
        >
          <input type="url" value={form.webhookUrl} onChange={set('webhookUrl')} placeholder={example.webhook} />
        </Field>
        <div className="form-grid">
          <Field label="Contact name">
            <input value={form.contact.name} onChange={setContact('name')} maxLength={80} />
          </Field>
          <Field label="Contact email" error={fieldError('contact.email')}>
            <input type="email" value={form.contact.email} onChange={setContact('email')} maxLength={120} />
          </Field>
          <Field label="Contact phone">
            <input value={form.contact.phone} onChange={setContact('phone')} maxLength={20} />
          </Field>
        </div>
        <Field label="Notes" hint={isMerchant ? `Anything ${BRAND.name} should know about this platform.` : 'Agreement, revenue share, anything the next person should know.'}>
          <textarea rows={3} value={form.notes} onChange={set('notes')} maxLength={1000} />
        </Field>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : submitLabel}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
