import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, KeyRound } from 'lucide-react';
import { api } from '../api/client.js';
import { useAction, useTills } from '../api/queries.js';
import { ErrorMessage, Field, PageHeader } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const EMPTY = { name: '', kind: 'till', environment: 'production', shortcode: '', tillNumber: '', consumerKey: '', consumerSecret: '', passkey: '' };

export default function NewTillPage() {
  const { canEdit } = useAuth();
  const navigate = useNavigate();
  const { data } = useTills();
  const [form, setForm] = useState(EMPTY);
  const [password, setPassword] = useState('');
  const create = useAction((body) => api('/tills', { method: 'POST', body }), [['tills']]);

  // The number this till will get; the server has the final say.
  const slot = Math.max(0, ...(data?.tills || []).map((t) => t.slot || 0)) + 1;
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const fieldError = (path) => create.error?.details?.find((d) => d.path === path)?.message;

  const submit = (event) => {
    event.preventDefault();
    const body = { ...form, password };
    if (body.kind === 'paybill') delete body.tillNumber;
    create.mutate(body, { onSuccess: (result) => navigate(`/tills/${result.till.id}`, { replace: true }) });
  };

  if (!canEdit) return <ErrorMessage error={new Error('Only admins can add tills.')} />;

  return (
    <>
      <Link to="/tills" className="back">
        <ArrowLeft size={16} aria-hidden="true" /> M-Pesa tills
      </Link>
      <PageHeader title={`Add M-Pesa till ${slot}`} subtitle="A Buy Goods till or Paybill with its own Daraja app. Platforms can then be pointed at it." />
      <form className="form" onSubmit={submit}>
        <fieldset disabled={create.isPending}>
          <section className="card">
            <h2>Numbers</h2>
            <p className="card-sub">What Safaricom sees on every M-Pesa prompt for this till.</p>
            <div className="form-grid">
              <Field label="Name" hint="Shown in the dashboard only, e.g. “Partner shop till”." error={fieldError('name')}>
                <input value={form.name} onChange={set('name')} maxLength={60} required />
              </Field>
              <Field label="Type">
                <select value={form.kind} onChange={set('kind')}>
                  <option value="till">Buy Goods till</option>
                  <option value="paybill">Paybill</option>
                </select>
              </Field>
              <Field label="Environment">
                <select value={form.environment} onChange={set('environment')}>
                  <option value="production">Live (real money)</option>
                  <option value="sandbox">Sandbox (test money)</option>
                </select>
              </Field>
            </div>
            <div className="form-grid">
              <Field
                label={form.kind === 'till' ? 'Store (head office) number' : 'Paybill number'}
                hint="Signs every request (BusinessShortCode). The number your Daraja passkey was issued for."
                error={fieldError('shortcode')}
              >
                <input value={form.shortcode} onChange={set('shortcode')} inputMode="numeric" pattern="\d{5,8}" required />
              </Field>
              {form.kind === 'till' && (
                <Field label="Till number" hint="The till customers pay (PartyB). It must belong to the store number." error={fieldError('tillNumber')}>
                  <input value={form.tillNumber} onChange={set('tillNumber')} inputMode="numeric" pattern="\d{5,8}" required />
                </Field>
              )}
            </div>
          </section>

          <section className="card">
            <h2>Daraja keys for till {slot}</h2>
            <p className="card-sub">
              From the Daraja app for this till. They're stored encrypted and never shown again. On Render the same keys would be{' '}
              <code>MPESA_CONSUMER_KEY{slot === 1 ? '' : `_${slot}`}</code>, <code>MPESA_CONSUMER_SECRET{slot === 1 ? '' : `_${slot}`}</code> and{' '}
              <code>MPESA_PASSKEY{slot === 1 ? '' : `_${slot}`}</code>.
            </p>
            <div className="form-grid">
              <Field label={`M-Pesa consumer key ${slot}`} error={fieldError('consumerKey')}>
                <input type="password" autoComplete="off" value={form.consumerKey} onChange={set('consumerKey')} required />
              </Field>
              <Field label={`M-Pesa consumer secret ${slot}`} error={fieldError('consumerSecret')}>
                <input type="password" autoComplete="off" value={form.consumerSecret} onChange={set('consumerSecret')} required />
              </Field>
              <Field label={`M-Pesa passkey ${slot}`} hint="Lipa na M-Pesa Online passkey, issued for the store number." error={fieldError('passkey')}>
                <input type="password" autoComplete="off" value={form.passkey} onChange={set('passkey')} required />
              </Field>
            </div>
          </section>

          <section className="card">
            <h2>Confirm</h2>
            <ErrorMessage error={create.error} title="Not added" />
            <div className="form-grid">
              <Field label="Your password" hint="Asked every time, because these numbers decide where customers' money goes.">
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
            </div>
            <div className="form-actions">
              <Link to="/tills" className="btn btn-ghost">
                Cancel
              </Link>
              <button type="submit" className="btn btn-primary" disabled={!password || create.isPending}>
                <KeyRound size={16} aria-hidden="true" /> {create.isPending ? 'Adding…' : `Add till ${slot}`}
              </button>
            </div>
          </section>
        </fieldset>
      </form>
    </>
  );
}
