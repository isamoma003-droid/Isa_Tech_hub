import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
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
      <form className="card login-card" onSubmit={onSubmit}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ISA
          </span>
          <span>
            <strong>ISA Tech Hub</strong>
            <small>Payments for every platform</small>
          </span>
        </div>
        <h1>Sign in</h1>
        <ErrorMessage error={error} title="Couldn't sign you in" />
        <Field label="Email">
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="hint">Accounts are created by an admin from the server (npm run admin:create).</p>
      </form>
    </div>
  );
}
