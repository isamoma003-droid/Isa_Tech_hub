import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuthConfig } from '../api/queries.js';
import AuthLayout from '../components/AuthLayout.jsx';
import { ErrorMessage, Field, Spinner } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';

// The one-time token from an emailed link. It's taken out of the address bar at once, so it doesn't
// linger in the browser history or a screenshot.
function useLinkToken() {
  const [params, setParams] = useSearchParams();
  const [token] = useState(() => params.get('token') || '');
  useEffect(() => {
    if (params.has('token')) setParams({}, { replace: true });
  }, [params, setParams]);
  return token;
}

export function ForgotPasswordPage() {
  const { data: config } = useAuthConfig();
  const [email, setEmail] = useState('');
  const [state, setState] = useState({ busy: false, sent: false, error: null });

  const onSubmit = async (event) => {
    event.preventDefault();
    setState({ busy: true, sent: false, error: null });
    try {
      await api('/auth/forgot-password', { method: 'POST', body: { email } });
      setState({ busy: false, sent: true, error: null });
    } catch (error) {
      setState({ busy: false, sent: false, error });
    }
  };

  if (state.sent) {
    return (
      <AuthLayout title="Check your email" subtitle={email}>
        <div className="notice notice-ok">
          <CheckCircle2 size={18} aria-hidden="true" />
          <p>If there's an account for this address, a link to choose a new password is on its way. It works for an hour.</p>
        </div>
        <p className="hint">Nothing after a few minutes? Check spam, or ask an IsaPay admin to reset your password.</p>
        <p className="auth-switch">
          <Link to="/login">Back to sign in</Link>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Forgot your password?" subtitle="We'll email you a link to choose a new one." onSubmit={onSubmit}>
      {config && !config.email && (
        <div className="notice notice-warn">
          <p>This server can't send email yet. Ask an IsaPay admin to reset your password from the Accounts page.</p>
        </div>
      )}
      <ErrorMessage error={state.error} title="Couldn't send the link" />
      <Field label="Email">
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      </Field>
      <button type="submit" className="btn btn-primary btn-block btn-large" disabled={state.busy}>
        {state.busy ? 'Sending…' : 'Email me a link'}
      </button>
      <p className="auth-switch">
        Remembered it? <Link to="/login">Sign in</Link>
      </p>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const token = useLinkToken();
  const { replaceSession } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [state, setState] = useState({ busy: false, error: null });
  const mismatch = confirm && password !== confirm;

  const onSubmit = async (event) => {
    event.preventDefault();
    if (mismatch) return;
    setState({ busy: true, error: null });
    try {
      replaceSession(await api('/auth/reset-password', { method: 'POST', body: { token, password } }));
      navigate('/', { replace: true });
    } catch (error) {
      setState({ busy: false, error });
    }
  };

  if (!token) {
    return (
      <AuthLayout title="This link is incomplete" subtitle="Open the link from the email again, or ask for a new one.">
        <Link to="/forgot-password" className="btn btn-primary btn-block">
          Ask for a new link
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password" subtitle="Every other session will be signed out." onSubmit={onSubmit}>
      <ErrorMessage error={state.error} title="Password not changed" />
      {state.error?.status === 400 && (
        <p>
          <Link to="/forgot-password">Ask for a new link</Link>
        </p>
      )}
      <Field label="New password" hint="At least 10 characters. A few random words work well.">
        <input type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
      </Field>
      <Field label="New password again" error={mismatch ? "The two passwords don't match" : null}>
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </Field>
      <button type="submit" className="btn btn-primary btn-block btn-large" disabled={state.busy || mismatch}>
        {state.busy ? 'Saving…' : 'Save and sign in'}
      </button>
    </AuthLayout>
  );
}

export function VerifyEmailPage() {
  const token = useLinkToken();
  const { admin, refresh } = useAuth();
  const [state, setState] = useState({ done: false, email: null, error: token ? null : new Error('This link is incomplete.') });
  // Each link works once: never send it twice (React runs effects twice in development).
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    api('/auth/verify-email', { method: 'POST', body: { token } })
      .then(({ email }) => {
        setState({ done: true, email, error: null });
        if (admin) refresh().catch(() => {});
      })
      .catch((error) => setState({ done: false, email: null, error }));
  }, [token, admin, refresh]);

  return (
    <AuthLayout title={state.done ? 'Email confirmed' : state.error ? "Couldn't confirm your email" : 'Confirming your email…'} subtitle={state.email}>
      {!state.done && !state.error && <Spinner label="Checking the link…" />}
      <ErrorMessage error={state.error} title="Not confirmed" />
      {state.done && (
        <div className="notice notice-ok">
          <CheckCircle2 size={18} aria-hidden="true" />
          <p>Thanks. Your email address is confirmed.</p>
        </div>
      )}
      <Link to={admin ? '/account' : '/login'} className="btn btn-primary btn-block">
        {admin ? 'Back to your account' : 'Sign in'}
      </Link>
    </AuthLayout>
  );
}
