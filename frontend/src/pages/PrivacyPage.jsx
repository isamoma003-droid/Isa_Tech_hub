import { Link } from 'react-router-dom';
import { Brand } from '../components/Logo.jsx';

export default function PrivacyPage() {
  return (
    <div className="page container">
      <header className="page-header">
        <div>
          <Brand subtitle="by ISA Tech" />
          <p className="subtitle muted">How ISA Tech Hub (IsaPay) collects, uses and protects data.</p>
        </div>
      </header>

      <article className="card stack">
        <section>
          <h2>Summary</h2>
          <p className="lead">
            IsaPay collects the minimum personal information needed to process payments and operate the dashboard: names, email
            addresses, phone numbers for M‑Pesa, and billing records. We use this data to process payments, send transactional emails,
            and for fraud detection and accounting.
          </p>
        </section>

        <section>
          <h2>What we collect</h2>
          <ul>
            <li>Payment-related: phone numbers, amounts, payment receipts and timestamps.</li>
            <li>Account information: name, email, role and business details for merchants.</li>
            <li>Operational logs and audit entries for compliance and troubleshooting.</li>
          </ul>
        </section>

        <section>
          <h2>How we share data</h2>
          <p>
            We do not share merchant data with other merchants. We deliver signed webhooks to each platform’s configured webhook URL so
            that the platform can reconcile payments; webhook payloads contain only the data necessary to identify and settle a payment.
          </p>
        </section>

        <section>
          <h2>Your rights</h2>
          <p>
            You can request export or deletion of your platform’s data by contacting <a href="mailto:hello@isatech.co.ke">hello@isatech.co.ke</a>.
          </p>
        </section>

        <footer className="page-foot">
          <p className="muted">Last updated: {new Date().toLocaleDateString()}</p>
          <p>
            <Link to="/">Back to dashboard</Link>
          </p>
        </footer>
      </article>
    </div>
  );
}
