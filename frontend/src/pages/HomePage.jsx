import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, CheckCircle2, ExternalLink, ShieldCheck, Zap } from 'lucide-react';
import { Brand } from '../components/Logo.jsx';
import PublicNav from '../components/PublicNav.jsx';

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
    <div>
      <PublicNav />
      <div className="home-page container">
        <section className="home-hero card">
          <div className="hero-copy">
            <div className="eyebrow">IsaPay by ISA Tech</div>
            <Brand subtitle="M‑Pesa gateway for platform teams" />
            <h1>Simplify M‑Pesa payments across all your platforms.</h1>
            <p>
              Switch from ad-hoc Daraja integrations to a single, auditable gateway. Start payments from any platform with a server-to-server
              API call, receive verified webhooks, and rely on dashboard tools for billing and reconciliation.
            </p>

            <div className="hero-actions">
              <Link className="btn btn-primary" to="/developers">
                Integrate now <ArrowRight size={16} />
              </Link>
              <Link className="btn btn-ghost" to="/faq">Read FAQs</Link>
            </div>

            <ul className="check-list">
              <li><CheckCircle2 size={16} /> Server-only API keys (never embed on clients)</li>
              <li><CheckCircle2 size={16} /> Idempotency & duplicate protection</li>
              <li><CheckCircle2 size={16} /> Signed webhooks and retry logic</li>
            </ul>
          </div>

          <div className="hero-panel">
            <div className="mini-card">
              <span className="mini-label">Live flow</span>
              <strong>Platform → IsaPay Hub → Safaricom → Platform</strong>
            </div>
            <div className="mini-card muted-card">
              <span className="mini-label">Status</span>
              <strong>Created • Pending • Paid</strong>
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
            <span className="eyebrow">Built for platform teams</span>
            <h2>Centralise payment logic, not risk.</h2>
          </div>
          <div className="cta-links">
            <Link className="btn btn-primary" to="/developers">View API docs</Link>
            <Link className="btn btn-ghost" to="/privacy">Privacy <ExternalLink size={14} /></Link>
          </div>
        </section>

        <section className="info-links card">
          <h3>Helpful links</h3>
          <div className="link-grid">
            <Link to="/developers">Developers & SDK</Link>
            <Link to="/faq">FAQs</Link>
            <Link to="/privacy">Privacy policy</Link>
            <Link to="/terms">Terms of use</Link>
            <Link to="https://github.com/isamoma003-droid/Isa_Tech_hub/blob/main/docs/INTEGRATION.md" target="_blank" rel="noopener noreferrer">Integration guide</Link>
          </div>
        </section>
      </div>
    </div>
  );
}
