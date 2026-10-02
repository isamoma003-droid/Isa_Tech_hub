import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { BRAND } from '../brand.js';
import { Brand } from '../components/Logo.jsx';
import { ErrorMessage, Field } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';

export default function LoginPage() {
  const { admin, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (admin) return <Navigate to={location.state?.from || '/'} replace />;

  const onSubmit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <section className="login-hero" aria-hidden="true">
        <Brand subtitle={`by ${BRAND.company}`} />
        <div className="login-pitch">
          <h2>One M-Pesa gateway for every platform you run or partner with.</h2>
          <ul>
            <li>
              <CheckCircle2 size={18} /> STK push to any Kenyan number, confirmed with Safaricom before it counts
            </li>
            <li>
              <CheckCircle2 size={18} /> Signed webhooks, automatic retries and lost-callback recovery
            </li>
            <li>
              <CheckCircle2 size={18} /> Several tills, each with its own numbered Daraja keys
            </li>
          </ul>
        </div>
        <small>© {new Date().getFullYear()} {BRAND.company}</small>
      </section>
      <div className="login-panel">
        <form className="login-card" onSubmit={onSubmit}>
          <div className="login-mobile-brand">
            <Brand />
          </div>
          <div>
            <h1>Sign in</h1>
            <p className="subtitle">to the {BRAND.name} dashboard</p>
          </div>
          <ErrorMessage error={error} title="Couldn't sign you in" />
          <Field label="Email">
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          <Field label="Password">
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <button type="submit" className="btn btn-primary btn-block btn-large" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="hint">Accounts are created by an admin from the server (npm run admin:create).</p>
        </form>
      </div>
    </div>
  );
}
