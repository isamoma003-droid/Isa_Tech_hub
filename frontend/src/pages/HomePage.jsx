import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, CheckCircle2, ExternalLink, ShieldCheck, Zap } from 'lucide-react';
import { Brand } from '../components/Logo.jsx';

const features = [
  {
    icon: Zap,
    title: 'One M‑Pesa till, many platforms',
    text: 'Centralise your Daraja credentials and let every platform send payments to one secure gateway.',
  },
  {
    icon: ShieldCheck,
    title: 'Reliable, signed webhooks',
    text: 'HMAC-signed events, retryable deliveries and a background recovery sweep mean fewer missed payments.',
  },
  {
    icon: BookOpen,
    title: 'Developer-friendly SDKs',
    text: 'Copy the lightweight Node client, or use your HTTP client — secure server-to-server calls only.',
  },
];

const stats = [
  { value: '1', label: 'shared till' },
  { value: 'N', label: 'platforms supported' },
  { value: 'Signed', label: 'webhooks' },
  { value: '30s', label: 'recovery sweep' },
];

export default function HomePage() {
  return (
    <div className="home-page container">
      <section className="home-hero card">
          <div className="hero-copy">
            <div className="eyebrow">Payments infrastructure for platform teams</div>
            <Brand subtitle="M‑Pesa gateway by ISA Tech" />
            <h1>Simplify M‑Pesa payments across all your platforms.</h1>
            <p>
              Switch from ad-hoc Daraja integrations to a single, auditable gateway. Start payments from any platform with a server-to-server
              API call, receive verified webhooks, and rely on dashboard tools for billing and reconciliation.
            </p>

            <div className="hero-actions">
              <Link className="btn btn-primary" to="/register">
                Create your account <ArrowRight size={16} />
              </Link>
              <Link className="btn btn-ghost" to="/login">Sign in</Link>
            </div>

            <ul className="check-list">
              <li><CheckCircle2 size={16} /> Server-only API keys (never embed on clients)</li>
              <li><CheckCircle2 size={16} /> Idempotency & duplicate protection</li>
              <li><CheckCircle2 size={16} /> Signed webhooks and retry logic</li>
            </ul>
          </div>

          <div className="hero-panel">
            <div className="mini-card">
              <span className="mini-label">A clear payment flow</span>
              <strong>Your platform → IsaPay → M‑Pesa → verified webhook</strong>
            </div>
            <div className="mini-card muted-card">
              <span className="mini-label">Designed for operations</span>
              <strong>Track payment status, deliveries and reconciliation in one dashboard.</strong>
            </div>
          </div>
      </section>

      <section className="stat-grid">
          {stats.map((stat) => (
            <div className="stat-card card" key={stat.label}>
              <strong>{stat.value}</strong>
              <span>{stat.label}</span>
            </div>
          ))}
      </section>

      <section className="feature-grid">
          {features.map(({ icon: Icon, title, text }) => (
            <article className="feature-card card" key={title}>
              <div className="feature-icon"><Icon size={18} /></div>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
      </section>

      <section className="cta-strip card">
          <div>
            <span className="eyebrow">Start building</span>
            <h2>Integrate once. Keep payment operations visible.</h2>
          </div>
          <div className="cta-links">
            <Link className="btn btn-primary" to="/developers">Explore the API <ArrowRight size={16} /></Link>
            <Link className="btn btn-ghost" to="/faq">Visit the FAQ <ExternalLink size={14} /></Link>
          </div>
      </section>
    </div>
  );
}
