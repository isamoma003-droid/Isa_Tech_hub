import { CheckCircle2 } from 'lucide-react';
import { BRAND } from '../brand.js';
import { Brand } from './Logo.jsx';

const POINTS = [
  'STK push to any Kenyan number, confirmed with Safaricom before it counts',
  'Signed webhooks, automatic retries and lost-callback recovery',
  "Use IsaPay's till, or bring your own Buy Goods till or Paybill",
];

// The two-column frame of the sign-in, sign-up and password pages.
export default function AuthLayout({ title, subtitle, children, onSubmit }) {
  const Card = onSubmit ? 'form' : 'div';
  return (
    <div className="auth-page">
      <div className="login">
        <section className="login-hero" aria-hidden="true">
          <Brand subtitle={`by ${BRAND.company}`} />
          <div className="login-pitch">
            <h2>Take M-Pesa payments on your site or app, the easy way.</h2>
            <ul>
              {POINTS.map((point) => (
                <li key={point}>
                  <CheckCircle2 size={18} /> {point}
                </li>
              ))}
            </ul>
          </div>
          <small>© {new Date().getFullYear()} {BRAND.company}</small>
        </section>
        <div className="login-panel">
          <Card className="login-card" onSubmit={onSubmit}>
            <div>
              <h1>{title}</h1>
              {subtitle && <p className="subtitle">{subtitle}</p>}
            </div>
            {children}
          </Card>
        </div>
      </div>
    </div>
  );
}
