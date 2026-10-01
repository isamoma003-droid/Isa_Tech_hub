import { useState } from 'react';
import { useTills } from '../api/queries.js';
import { ErrorMessage, Field } from './ui.jsx';

const blank = {
  name: '',
  slug: '',
  website: '',
  till: '',
  ownership: 'own',
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

// Shared by "Add platform" and a platform's settings. The slug is fixed once created.
export default function PlatformForm({ initial, submitLabel, onSubmit, busy, error, disabled }) {
  const { data: tillData } = useTills();
  const [form, setForm] = useState(() => ({
    ...blank,
    ...initial,
    till: initial?.till?.id || initial?.till || '',
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
    onSubmit(isNew ? { ...rest, slug } : rest);
  };

  const tills = tillData?.tills || [];
  const selectedTill = tills.find((t) => t.id === form.till);

  return (
    <form className="form" onSubmit={submit}>
      <ErrorMessage error={error} title="Please check the form" />
      <fieldset disabled={disabled || busy}>
        <div className="form-grid">
          <Field label="Name" error={fieldError('name')}>
            <input value={form.name} onChange={set('name')} required maxLength={60} placeholder="A-Read" />
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
              placeholder="a-read"
            />
          </Field>
          <Field label="Website" error={fieldError('website')}>
            <input value={form.website} onChange={set('website')} placeholder="https://a-read.vercel.app" />
          </Field>
          <Field label="Whose platform" error={fieldError('ownership')}>
            <select value={form.ownership} onChange={set('ownership')}>
              <option value="own">Ours</option>
              <option value="partner">A partner's</option>
            </select>
          </Field>
          <Field
            label="Till"
            hint={selectedTill ? `Customers pay ${selectedTill.kind === 'till' ? 'till' : 'Paybill'} ${selectedTill.payNumber} (${selectedTill.environment}).` : 'Where this platform\'s money lands.'}
            error={fieldError('till')}
          >
            <select value={form.till} onChange={set('till')} required>
              <option value="" disabled>
                {tills.length ? 'Choose a till' : 'No tills yet: add one from the server'}
              </option>
              {tills.map((t) => (
                <option key={t.id} value={t.id} disabled={!t.active}>
                  {t.name} · {t.payNumber} · {t.environment}
                  {t.active ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Account reference" hint="Shown on the payer's M-Pesa prompt. 12 characters max." error={fieldError('accountReference')}>
            <input value={form.accountReference} onChange={set('accountReference')} maxLength={12} placeholder="A-Read" />
          </Field>
        </div>
        <Field
          label="Webhook URL"
          hint="The Hub posts payment.paid, payment.failed and payment.disputed here, signed with the platform's webhook secret."
          error={fieldError('webhookUrl')}
        >
          <input type="url" value={form.webhookUrl} onChange={set('webhookUrl')} placeholder="https://api.a-read.example/api/payments/hub-webhook" />
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
        <Field label="Notes" hint="Agreement, revenue share, anything the next person should know.">
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
