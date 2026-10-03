import { useState } from 'react';
import { BadgeCheck, LogOut, MailWarning } from 'lucide-react';
import { api } from '../api/client.js';
import { useAction, useAuthConfig } from '../api/queries.js';
import { BRAND } from '../brand.js';
import GoogleButton from '../components/GoogleButton.jsx';
import { ErrorMessage, Field, PageHeader, StatusBadge } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { formatFullDateTime, formatPhone } from '../utils/format.js';

const ROLE_TEXT = {
  admin: `${BRAND.company} admin: can change everything, approve merchants and set prices`,
  viewer: `${BRAND.company} viewer: can look at everything, change nothing`,
  merchant: 'Merchant: you manage your own platforms, tills and payments',
};

const fieldErrorOf = (error) => (path) => error?.details?.find?.((d) => d.path === path)?.message;

function ProfileForm({ admin, onSaved }) {
  const merchant = admin.role === 'merchant';
  const [form, setForm] = useState({
    name: admin.name,
    phone: formatPhone(admin.phone),
    business: { name: admin.business?.name || '', website: admin.business?.website || '', description: admin.business?.description || '' },
  });
  const save = useAction((body) => api('/auth/me', { method: 'PATCH', body }));
  const fieldError = fieldErrorOf(save.error);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const setBusiness = (key) => (event) => setForm((current) => ({ ...current, business: { ...current.business, [key]: event.target.value } }));

  const submit = (event) => {
    event.preventDefault();
    const body = { name: form.name, phone: form.phone, ...(merchant ? { business: form.business } : {}) };
    save.mutate(body, { onSuccess: ({ admin: me }) => onSaved(me) });
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h2>{merchant ? 'You and your business' : 'Profile'}</h2>
      <ErrorMessage error={save.error} title="Not saved" />
      {save.isSuccess && <div className="notice notice-ok">Saved.</div>}
      <fieldset disabled={save.isPending}>
        <div className="form-grid">
          <Field label="Your name" error={fieldError('name')}>
            <input value={form.name} onChange={set('name')} autoComplete="name" required minLength={2} maxLength={80} />
          </Field>
          <Field label="Phone" error={fieldError('phone')}>
            <input value={form.phone} onChange={set('phone')} inputMode="tel" autoComplete="tel" placeholder="0712 345 678" maxLength={20} />
          </Field>
        </div>
        {merchant && (
          <>
            <div className="form-grid">
              <Field label="Business name" error={fieldError('business.name')}>
                <input value={form.business.name} onChange={setBusiness('name')} autoComplete="organization" required minLength={2} maxLength={100} />
              </Field>
              <Field label="Website" error={fieldError('business.website')}>
                <input type="url" value={form.business.website} onChange={setBusiness('website')} placeholder="https://" maxLength={200} />
              </Field>
            </div>
            <Field label="What you sell" hint={`Helps ${BRAND.name} review your account.`}>
              <textarea rows={2} value={form.business.description} onChange={setBusiness('description')} maxLength={500} />
            </Field>
          </>
        )}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary">
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function PayoutForm({ admin, onSaved }) {
  const [form, setForm] = useState({ ...admin.payout, phone: formatPhone(admin.payout?.phone) });
  const save = useAction((body) => api('/auth/me', { method: 'PATCH', body }));
  const fieldError = fieldErrorOf(save.error);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = (event) => {
    event.preventDefault();
    const payout = form.method === 'mpesa' ? { method: 'mpesa', phone: form.phone } : form.method === 'bank' ? { ...form, phone: '' } : { method: '' };
    save.mutate({ payout }, { onSuccess: ({ admin: me }) => onSaved(me) });
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h2>Payouts</h2>
      <p className="card-sub">
        Where {BRAND.name} sends your money when a platform of yours uses {BRAND.name}'s till: what your customers paid, minus the fee. Platforms on your own
        till are paid straight into it.
      </p>
      <ErrorMessage error={save.error} title="Not saved" />
      {save.isSuccess && <div className="notice notice-ok">Payout details saved. Changes are logged and emailed to you.</div>}
      <fieldset disabled={save.isPending}>
        <Field label="Send my money by">
          <select value={form.method} onChange={set('method')}>
            <option value="">Not set yet</option>
            <option value="mpesa">M-Pesa</option>
            <option value="bank">Bank transfer</option>
          </select>
        </Field>
        {form.method === 'mpesa' && (
          <Field label="M-Pesa number" error={fieldError('payout.phone')}>
            <input value={form.phone} onChange={set('phone')} inputMode="tel" placeholder="0712 345 678" required maxLength={20} />
          </Field>
        )}
        {form.method === 'bank' && (
          <div className="form-grid">
            <Field label="Bank">
              <input value={form.bankName} onChange={set('bankName')} required maxLength={80} />
            </Field>
            <Field label="Account name">
              <input value={form.accountName} onChange={set('accountName')} required maxLength={100} />
            </Field>
            <Field label="Account number">
              <input value={form.accountNumber} onChange={set('accountNumber')} required maxLength={40} />
            </Field>
          </div>
        )}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary">
            {save.isPending ? 'Saving…' : 'Save payout details'}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function PasswordForm({ admin }) {
  const { replaceSession } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const change = useAction((body) => api('/auth/password', { method: 'POST', body }));
  const mismatch = confirm && newPassword !== confirm;
  const first = admin.hasPassword === false;

  const submit = (event) => {
    event.preventDefault();
    if (mismatch) return;
    change.mutate(first ? { newPassword } : { currentPassword, newPassword }, {
      onSuccess: (session) => {
        replaceSession(session);
        setCurrentPassword('');
        setNewPassword('');
        setConfirm('');
      },
    });
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h2>{first ? 'Set a password' : 'Change password'}</h2>
      {first && <p className="card-sub">You sign in with Google. A password lets you sign in without it, and is asked again before any till change.</p>}
      <ErrorMessage error={change.error} title="Password not saved" />
      {change.isSuccess && <div className="notice notice-ok">Password saved. Every other session has been signed out.</div>}
      {!first && (
        <Field label="Current password">
          <input type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
        </Field>
      )}
      <Field label="New password" hint="At least 10 characters. A few random words work well.">
        <input type="password" autoComplete="new-password" minLength={10} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
      </Field>
      <Field label="New password again" error={mismatch ? "The two new passwords don't match" : null}>
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </Field>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={change.isPending || mismatch}>
          {change.isPending ? 'Saving…' : first ? 'Set password' : 'Change password'}
        </button>
      </div>
    </form>
  );
}

function SignInMethods({ admin, onSaved }) {
  const { replaceSession } = useAuth();
  const { data: config } = useAuthConfig();
  const link = useAction((credential) => api('/auth/google/link', { method: 'POST', body: { credential } }));
  const unlink = useAction(() => api('/auth/google', { method: 'DELETE' }));
  const resend = useAction(() => api('/auth/verify-email/resend', { method: 'POST' }));
  const everywhere = useAction(() => api('/auth/sign-out-everywhere', { method: 'POST' }));
  const error = link.error || unlink.error || resend.error || everywhere.error;

  return (
    <div className="card">
      <h2>Sign-in and security</h2>
      <ErrorMessage error={error} title="That didn't work" />
      <dl className="kv">
        <div className="kv-row">
          <dt>Email</dt>
          <dd>
            {admin.email}{' '}
            {admin.emailVerified ? (
              <span className="inline-ok">
                <BadgeCheck size={15} aria-hidden="true" /> confirmed
              </span>
            ) : (
              <span className="inline-warn">
                <MailWarning size={15} aria-hidden="true" /> not confirmed
              </span>
            )}
            {!admin.emailVerified && config?.email && (
              <span className="block">
                <button type="button" className="btn btn-ghost btn-small" disabled={resend.isPending || resend.isSuccess} onClick={() => resend.mutate()}>
                  {resend.isSuccess ? 'Link sent: check your inbox' : 'Email me a confirmation link'}
                </button>
              </span>
            )}
          </dd>
        </div>
        {config?.google && (
          <div className="kv-row">
            <dt>Google</dt>
            <dd>
              {admin.googleLinked ? (
                <>
                  Linked: you can use “Sign in with Google”.{' '}
                  {admin.hasPassword && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      disabled={unlink.isPending}
                      onClick={() => window.confirm('Stop signing in with Google? You will sign in with your password.') && unlink.mutate(undefined, { onSuccess: ({ admin: me }) => onSaved(me) })}
                    >
                      Unlink
                    </button>
                  )}
                </>
              ) : (
                <>
                  <span className="block muted small">Not linked. Link a Google account to sign in with one click.</span>
                  <GoogleButton text="continue_with" onCredential={(credential) => link.mutate(credential, { onSuccess: ({ admin: me }) => onSaved(me) })} />
                </>
              )}
            </dd>
          </div>
        )}
        <div className="kv-row">
          <dt>Last sign-in</dt>
          <dd>{formatFullDateTime(admin.lastLoginAt)}</dd>
        </div>
      </dl>
      <p className="hint">Sessions end after 8 hours, or when you close the tab or app.</p>
      <div className="button-row">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={everywhere.isPending}
          onClick={() => window.confirm('Sign out on every other device and browser?') && everywhere.mutate(undefined, { onSuccess: replaceSession })}
        >
          <LogOut size={16} aria-hidden="true" /> Sign out everywhere else
        </button>
      </div>
      {everywhere.isSuccess && <div className="notice notice-ok">Every other session has been signed out.</div>}
    </div>
  );
}

export default function AccountPage() {
  const { admin, setAdmin } = useAuth();
  const merchant = admin.role === 'merchant';

  return (
    <>
      <PageHeader
        title="Your account"
        subtitle={`${admin.name} · ${admin.email}`}
        actions={merchant && <StatusBadge status={`approval-${admin.approval?.status || 'pending'}`} />}
      />
      <p className="lead">{ROLE_TEXT[admin.role]}.</p>
      {merchant && admin.approval?.status === 'rejected' && admin.approval.note && (
        <div className="notice notice-warn">
          <p>
            <strong>Note from {BRAND.name}:</strong> {admin.approval.note}
          </p>
        </div>
      )}
      <section className="grid-2">
        <ProfileForm key={`profile-${admin.id}`} admin={admin} onSaved={setAdmin} />
        <SignInMethods admin={admin} onSaved={setAdmin} />
      </section>
      <section className="grid-2">
        {merchant && <PayoutForm key={`payout-${admin.id}`} admin={admin} onSaved={setAdmin} />}
        <PasswordForm admin={admin} />
      </section>
    </>
  );
}
