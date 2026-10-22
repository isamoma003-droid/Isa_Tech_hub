import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuthConfig } from '../api/queries.js';
import { BRAND } from '../brand.js';
import AuthLayout from '../components/AuthLayout.jsx';
import GoogleButton, { OrDivider } from '../components/GoogleButton.jsx';
import { ErrorMessage, Field } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const BLANK = { name: '', businessName: '', email: '', phone: '', website: '', password: '' };

// A business opens its own IsaPay account. It can set everything up and test on a sandbox till at
// once; live payments start once an IsaPay admin approves the business.
export default function RegisterPage() {
  const { admin, register, googleSignIn } = useAuth();
  const { data: config, error: configError, refetch: retryConfig } = useAuthConfig();
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Signed in (just now, or already): on to the dashboard, with a welcome for a new account.
  if (admin) return <Navigate to="/dashboard" replace state={busy ? { welcome: true } : undefined} />;
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const fieldError = (path) => error?.details?.find?.((d) => d.path === path)?.message;

  const run = async (attempt) => {
    setBusy(true);
    setError(null);
    try {
      await attempt();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  const onSubmit = (event) => {
    event.preventDefault();
    const body = Object.fromEntries(Object.entries(form).filter(([key, value]) => value || !['phone', 'website'].includes(key)));
    run(() => register(body));
  };

  if (config?.signup === false) {
    return (
      <AuthLayout title="Sign-up is closed" subtitle={`${BRAND.name} isn't taking new accounts right now.`}>
        <p>Contact {BRAND.company} to be invited.</p>
        <p className="auth-switch">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Create your account" subtitle={`Start taking M-Pesa payments with ${BRAND.name}`} onSubmit={onSubmit}>
      {configError && (
        <div className="notice notice-warn" role="status">
          <p>Couldn't load account settings. You can still submit the form, but IsaPay's API must be available to create your account.</p>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => retryConfig()}>
            Retry settings
          </button>
        </div>
      )}
      <ErrorMessage error={error} title="Couldn't create your account" />
      <GoogleButton text="signup_with" onCredential={(credential) => run(() => googleSignIn(credential))} />
      <OrDivider />
      <div className="form-grid form-grid-tight">
        <Field label="Your name" error={fieldError('name')}>
          <input autoComplete="name" value={form.name} onChange={set('name')} required minLength={2} maxLength={80} autoFocus />
        </Field>
        <Field label="Business name" error={fieldError('businessName')}>
          <input autoComplete="organization" value={form.businessName} onChange={set('businessName')} required minLength={2} maxLength={100} />
        </Field>
      </div>
      <Field label="Work email" error={fieldError('email')}>
        <input type="email" autoComplete="email" value={form.email} onChange={set('email')} required maxLength={120} />
      </Field>
      <div className="form-grid form-grid-tight">
        <Field label="M-Pesa phone (optional)" error={fieldError('phone')}>
          <input type="tel" inputMode="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} placeholder="0712 345 678" maxLength={20} />
        </Field>
        <Field label="Website (optional)" error={fieldError('website')}>
          <input type="url" autoComplete="url" value={form.website} onChange={set('website')} placeholder="https://" maxLength={200} />
        </Field>
      </div>
      <Field label="Password" hint="At least 10 characters. A few random words work well." error={fieldError('password')}>
        <input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} required minLength={10} maxLength={200} />
      </Field>
      <button type="submit" className="btn btn-primary btn-block btn-large" disabled={busy}>
        {busy ? 'Creating your account…' : 'Create account'}
      </button>
      <p className="hint">
        You can set up your platforms and test with a sandbox till straight away. {BRAND.name} reviews your business before live payments
        start.
      </p>
      <p className="auth-switch">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </AuthLayout>
  );
}
