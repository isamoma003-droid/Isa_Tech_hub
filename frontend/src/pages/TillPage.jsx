import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, KeyRound, ShieldCheck } from 'lucide-react';
import { api } from '../api/client.js';
import { useAction, useTill } from '../api/queries.js';
import { ErrorMessage, Field, PageHeader, Spinner, StatusBadge } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { formatDateTime } from '../utils/format.js';

const NUMBER_FIELDS = ['name', 'kind', 'environment', 'shortcode', 'tillNumber', 'active'];
const CHANGE_LABELS = {
  name: 'name',
  kind: 'type',
  environment: 'environment',
  shortcode: 'store number',
  tillNumber: 'till number',
  active: 'on/off',
  credentials: 'Daraja keys',
};

const fromTill = (till) => ({
  name: till.name,
  kind: till.kind,
  environment: till.environment,
  shortcode: till.shortcode,
  tillNumber: till.tillNumber || '',
  active: till.active,
});

function TillForm({ till, canEdit }) {
  const [form, setForm] = useState(() => fromTill(till));
  const [keys, setKeys] = useState({ consumerKey: '', consumerSecret: '', passkey: '' });
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(null);
  const save = useAction((body) => api(`/tills/${till.id}`, { method: 'PATCH', body }), [['till', till.id], ['tills'], ['platforms']]);
  const check = useAction(() => api(`/tills/${till.id}/check`, { method: 'POST' }));

  const set = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [key]: value }));
  };
  const setKey = (key) => (event) => setKeys((current) => ({ ...current, [key]: event.target.value }));
  const fieldError = (path) => save.error?.details?.find((d) => d.path === path)?.message;

  const original = fromTill(till);
  const changedFields = NUMBER_FIELDS.filter((key) => form[key] !== original[key]);
  const changedKeys = Object.entries(keys).filter(([, value]) => value.trim());
  const nothingToSave = !changedFields.length && !changedKeys.length;
  const numbersChange = ['kind', 'environment', 'shortcode', 'tillNumber'].some((key) => changedFields.includes(key));

  const submit = (event) => {
    event.preventDefault();
    const body = { password, ...Object.fromEntries(changedFields.map((key) => [key, form[key]])), ...Object.fromEntries(changedKeys) };
    if (body.kind === 'paybill') delete body.tillNumber;
    save.mutate(body, {
      onSuccess: (result) => {
        setSaved(result.changed);
        setForm(fromTill(result.till));
        setKeys({ consumerKey: '', consumerSecret: '', passkey: '' });
        setPassword('');
      },
    });
  };

  return (
    <form className="form" onSubmit={submit}>
      <fieldset disabled={!canEdit || save.isPending}>
        <section className="card">
          <h2>Numbers</h2>
          <p className="card-sub">What Safaricom sees on every M-Pesa prompt for this till.</p>
          <div className="form-grid">
            <Field label="Name" error={fieldError('name')}>
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
              hint={
                form.kind === 'till'
                  ? 'Signs every request (BusinessShortCode). The number your Daraja passkey was issued for.'
                  : 'The Paybill customers pay; it also signs every request.'
              }
              error={fieldError('shortcode')}
            >
              <input value={form.shortcode} onChange={set('shortcode')} inputMode="numeric" pattern="\d{5,8}" required />
            </Field>
            {form.kind === 'till' && (
              <Field
                label="Till number"
                hint="The till customers pay (PartyB). It must belong to the store number, or Safaricom answers 2002: “The Agent number and Store number entered do not match”."
                error={fieldError('tillNumber')}
              >
                <input value={form.tillNumber} onChange={set('tillNumber')} inputMode="numeric" pattern="\d{5,8}" required />
              </Field>
            )}
          </div>
          <label className="check">
            <input type="checkbox" checked={form.active} onChange={set('active')} />
            <span>Accept new payments on this till</span>
          </label>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Daraja keys</h2>
            {canEdit && (
              <button type="button" className="btn btn-ghost btn-small" onClick={() => check.mutate()} disabled={check.isPending}>
                <ShieldCheck size={14} aria-hidden="true" /> {check.isPending ? 'Checking…' : 'Check Daraja sign-in'}
              </button>
            )}
          </div>
          <p className="card-sub">
            {till.hasCredentials
              ? `Stored and encrypted${till.consumerKeyHint ? `; the consumer key ends ${till.consumerKeyHint}` : ''}. They are never shown. Fill a box only to replace that key.`
              : 'Missing: fill in all three.'}
          </p>
          {check.data && <div className={`notice ${check.data.ok ? 'notice-ok' : 'notice-error'}`}>{check.data.message}</div>}
          <ErrorMessage error={check.error} title="Couldn't check" />
          <div className="form-grid">
            <Field label="Consumer key">
              <input type="password" autoComplete="off" value={keys.consumerKey} onChange={setKey('consumerKey')} placeholder="Leave blank to keep" />
            </Field>
            <Field label="Consumer secret">
              <input type="password" autoComplete="off" value={keys.consumerSecret} onChange={setKey('consumerSecret')} placeholder="Leave blank to keep" />
            </Field>
            <Field label="Passkey" hint="Lipa na M-Pesa Online passkey, issued for the store number.">
              <input type="password" autoComplete="off" value={keys.passkey} onChange={setKey('passkey')} placeholder="Leave blank to keep" />
            </Field>
          </div>
        </section>

        {canEdit && (
          <section className="card">
            <h2>Confirm</h2>
            {numbersChange && till.platforms > 0 && (
              <div className="notice notice-warn">
                <AlertTriangle size={18} aria-hidden="true" />
                <p>
                  From the next M-Pesa prompt, customers of {till.platformList.map((p) => p.name).join(', ')} pay with these numbers. Check them
                  carefully: wrong numbers send money to the wrong place or make every payment fail.
                </p>
              </div>
            )}
            {saved && (
              <div className="notice notice-ok">
                {saved.length ? `Saved: ${saved.map((key) => CHANGE_LABELS[key] || key).join(', ')}. The change is in the audit log.` : 'Nothing had changed.'}
              </div>
            )}
            <ErrorMessage error={save.error} title="Not saved" />
            <div className="form-grid">
              <Field label="Your password" hint="Asked every time, because these numbers decide where customers' money goes.">
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={nothingToSave || !password || save.isPending}>
                <KeyRound size={16} aria-hidden="true" /> {save.isPending ? 'Saving…' : 'Save till'}
              </button>
            </div>
          </section>
        )}
      </fieldset>
    </form>
  );
}

export default function TillPage() {
  const { id } = useParams();
  const { canEdit } = useAuth();
  const { data, isPending, error } = useTill(id);

  if (isPending) return <Spinner />;
  if (error) return <ErrorMessage error={error} />;
  const { till } = data;

  return (
    <>
      <Link to="/tills" className="back">
        <ArrowLeft size={16} aria-hidden="true" /> Tills
      </Link>
      <PageHeader
        title={till.name}
        subtitle={`Customers pay ${till.kind === 'till' ? 'till' : 'Paybill'} ${till.payNumber} · ${till.environment === 'production' ? 'live' : 'sandbox'} · updated ${formatDateTime(till.updatedAt)}`}
        actions={
          <>
            <StatusBadge status={till.active ? 'active' : 'disabled'} />
            <Link to={`/audit?target=${till.id}`} className="btn btn-ghost">
              History
            </Link>
          </>
        }
      />
      <p className="lead">
        Used by{' '}
        {till.platformList.length
          ? till.platformList.map((p, i) => (
              <span key={p.id}>
                {i > 0 && ', '}
                <Link to={`/platforms/${p.id}`}>{p.name}</Link>
              </span>
            ))
          : 'no platform yet'}
        .
        {till.source === 'env' &&
          ' This till also comes from the MPESA_* variables on Render: a change made here stays until someone changes the matching variable there.'}
      </p>
      <TillForm key={till.id} till={till} canEdit={canEdit} />
    </>
  );
}
