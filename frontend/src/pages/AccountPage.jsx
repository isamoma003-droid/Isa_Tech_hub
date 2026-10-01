import { useState } from 'react';
import { api } from '../api/client.js';
import { useAction } from '../api/queries.js';
import { ErrorMessage, Field, PageHeader } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { formatFullDateTime } from '../utils/format.js';

export default function AccountPage() {
  const { admin, replaceSession } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const change = useAction((body) => api('/auth/password', { method: 'POST', body }));
  const mismatch = confirm && newPassword !== confirm;

  const submit = (event) => {
    event.preventDefault();
    if (mismatch) return;
    change.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: (session) => {
          replaceSession(session);
          setCurrentPassword('');
          setNewPassword('');
          setConfirm('');
        },
      },
    );
  };

  return (
    <>
      <PageHeader title="Your account" subtitle={`${admin.name} · ${admin.email}`} />
      <section className="grid-2">
        <div className="card">
          <h2>Access</h2>
          <dl className="kv">
            <div className="kv-row">
              <dt>Role</dt>
              <dd>{admin.role === 'admin' ? 'Admin: can change platforms and resend webhooks' : 'Viewer: can look at everything, change nothing'}</dd>
            </div>
            <div className="kv-row">
              <dt>Signed in</dt>
              <dd>{formatFullDateTime(admin.lastLoginAt)}</dd>
            </div>
          </dl>
          <p className="hint">Sessions end after 8 hours, or when you close the tab.</p>
        </div>
        <form className="card form" onSubmit={submit}>
          <h2>Change password</h2>
          <ErrorMessage error={change.error} title="Password not changed" />
          {change.isSuccess && <div className="notice notice-ok">Password changed. Every other session has been signed out.</div>}
          <Field label="Current password">
            <input type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
          </Field>
          <Field label="New password" hint="At least 10 characters. A few random words work well.">
            <input type="password" autoComplete="new-password" minLength={10} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
          </Field>
          <Field label="New password again" error={mismatch ? "The two new passwords don't match" : null}>
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </Field>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={change.isPending || mismatch}>
              {change.isPending ? 'Saving…' : 'Change password'}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
