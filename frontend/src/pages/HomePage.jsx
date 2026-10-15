import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, CheckCircle2, ExternalLink, ShieldCheck, Zap } from 'lucide-react';
import { Brand } from '../components/Logo.jsx';

const features = [
  {
    icon: Zap,
    title: 'One M‑Pesa till, many platforms',
    text: 'Run a single Daraja-backed gateway and funnel every payment through one secure, auditable flow.',
  },
  {
    icon: ShieldCheck,
    title: 'Secure webhooks & reconciliation',
    text: 'Signed events, payment verification, duplicate protection and late-callback recovery keep your payment flow trustworthy.',
  },
  {
    icon: BookOpen,
    title: 'Developer-first integration',
    text: 'Copy the Node SDK, call the payments API and verify events in minutes while keeping secrets on the server.',
  },
];

const stats = [
  { value: '1', label: 'shared till' },
  { value: 'N', label: 'platforms supported' },
  { value: '2xx', label: 'webhook acknowledgements' },
  { value: '24/7', label: 'state recovery' },
];

export default function HomePage() {
  return (
    <div className="home-page container">
      <section className="home-hero card">
        <div className="hero-copy">
          <div className="eyebrow">IsaPay by ISA Tech</div>
          <Brand subtitle="M‑Pesa payment gateway for every platform" />
          <h1>Power every platform with one secure M‑Pesa gateway.</h1>
          <p>
            IsaPay lets businesses and partner products use a single M‑Pesa till, with payment creation, signed webhooks,
            status monitoring, billing and merchant dashboards all in one place.
          </p>

          <div className="hero-actions">
            <Link className="btn btn-primary" to="/developers">
              Integrate now <ArrowRight size={16} />
            </Link>
            <Link className="btn btn-ghost" to="/faq">
              Read FAQs
            </Link>
          </div>

          <ul className="check-list">
            <li><CheckCircle2 size={16} /> Platform-ready API keys</li>
            <li><CheckCircle2 size={16} /> Signed webhook event delivery</li>
            <li><CheckCircle2 size={16} /> Merchant and admin dashboard</li>
          </ul>
        </div>

        <div className="hero-panel">
          <div className="mini-card">
            <span className="mini-label">Live flow</span>
            <strong>Platform → Hub → Safaricom → Webhook</strong>
          </div>
          <div className="mini-card muted-card">
            <span className="mini-label">Platform status</span>
            <strong>Payment created • pending • paid</strong>
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
          <h2>Stop integrating Daraja directly in every app.</h2>
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
  );
}
