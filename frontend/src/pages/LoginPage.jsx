import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuthConfig } from '../api/queries.js';
import { BRAND } from '../brand.js';
import AuthLayout from '../components/AuthLayout.jsx';
import GoogleButton, { OrDivider } from '../components/GoogleButton.jsx';
import { ErrorMessage, Field } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';

export default function LoginPage() {
  const { admin, signIn, googleSignIn } = useAuth();
  const { data: config } = useAuthConfig();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const next = location.state?.from || '/';

  if (admin) return <Navigate to={next} replace />;

  const run = async (attempt) => {
    setBusy(true);
    setError(null);
    try {
      await attempt();
      navigate(next, { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  const onSubmit = (event) => {
    event.preventDefault();
    run(() => signIn(email, password));
  };

  return (
    <AuthLayout title="Sign in" subtitle={`to your ${BRAND.name} dashboard`} onSubmit={onSubmit}>
      <ErrorMessage error={error} title="Couldn't sign you in" />
      <GoogleButton text="signin_with" onCredential={(credential) => run(() => googleSignIn(credential))} />
      <OrDivider />
      <Field label="Email">
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      </Field>
      <Field label="Password">
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </Field>
      <button type="submit" className="btn btn-primary btn-block btn-large" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="auth-links">
        <Link to="/forgot-password">Forgot your password?</Link>
      </p>
      {config?.signup !== false && (
        <p className="auth-switch">
          New to {BRAND.name}? <Link to="/register">Create a merchant account</Link>
        </p>
      )}
      {config?.google && <p className="hint">Signed up with Google? Use the Google button: your account may not have a password.</p>}
    </AuthLayout>
  );
}
