import { useState } from 'react';
import { CheckCircle2, Mail, Phone } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuthConfig } from '../api/queries.js';
import { ErrorMessage, Field, PageHeader } from '../components/ui.jsx';

const EMPTY = { name: '', email: '', subject: '', message: '' };

export default function ContactPage() {
  const { data: config } = useAuthConfig();
  const [form, setForm] = useState(EMPTY);
  const [state, setState] = useState({ busy: false, sent: false, error: null });
  const supportEmail = config?.support?.email || 'support@isapay.co.ke';
  const supportPhone = config?.support?.phone || '+254 700 000 000';

  const onSubmit = async (event) => {
    event.preventDefault();
    setState({ busy: true, sent: false, error: null });
    try {
      await api('/auth/contact', { method: 'POST', body: form });
      setForm(EMPTY);
      setState({ busy: false, sent: true, error: null });
    } catch (error) {
      setState({ busy: false, sent: false, error });
    }
  };

  return (
    <div className="public-content">
      <PageHeader title="Contact IsaPay support" subtitle="Tell us what you need help with. Our support team will get back to you." />
      <div className="contact-grid">
        <section className="card stack">
          {state.sent ? (
            <div className="notice notice-ok" role="status">
              <CheckCircle2 size={18} aria-hidden="true" />
              <p>Your message has been sent. We’ll reply to the email address you provided.</p>
            </div>
          ) : (
            <>
              {!config?.email && (
                <div className="notice notice-warn">
                  <p>The support form is temporarily unavailable. Please email us directly instead.</p>
                </div>
              )}
              <ErrorMessage error={state.error} title="Message not sent" />
              <form className="stack" onSubmit={onSubmit}>
                <div className="form-grid">
                  <Field label="Your name">
                    <input autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required minLength={2} maxLength={80} />
                  </Field>
                  <Field label="Email address">
                    <input type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required maxLength={120} />
                  </Field>
                </div>
                <Field label="Subject">
                  <input value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })} required minLength={3} maxLength={120} />
                </Field>
                <Field label="How can we help?">
                  <textarea rows="6" value={form.message} onChange={(event) => setForm({ ...form, message: event.target.value })} required minLength={10} maxLength={5000} />
                </Field>
                <button type="submit" className="btn btn-primary" disabled={state.busy || !config?.email}>
                  {state.busy ? 'Sending…' : 'Send message'}
                </button>
              </form>
            </>
          )}
        </section>

        <aside className="card contact-details">
          <h2>Other ways to reach us</h2>
          <p>For account access, integration, or payment questions, contact our support team.</p>
          <a href={`mailto:${supportEmail}`}>
            <Mail size={18} aria-hidden="true" />
            <span><strong>Email</strong><br />{supportEmail}</span>
          </a>
          <a href={`tel:${supportPhone.replace(/[^\d+]/g, '')}`}>
            <Phone size={18} aria-hidden="true" />
            <span><strong>Phone</strong><br />{supportPhone}</span>
          </a>
          <p className="hint">Please never send passwords, M-Pesa PINs, API keys, or webhook secrets in a support message.</p>
        </aside>
      </div>
    </div>
  );
}
