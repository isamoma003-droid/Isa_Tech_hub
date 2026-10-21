import { Link } from 'react-router-dom';

export default function PrivacyPage() {
  return (
    <div className="page container">
      <header className="page-header">
        <div>
          <h1>Privacy policy</h1>
          <p className="subtitle muted">How ISA Tech Hub (IsaPay) collects, uses and protects data.</p>
        </div>
      </header>

      <article className="card stack">
        <section>
          <h2>Summary</h2>
          <p className="lead">
            IsaPay collects the minimum personal information needed to process payments and operate the dashboard: names, email
            addresses, phone numbers for M‑Pesa, and billing records. Hosted checkout collects the customer details selected by the
            business, and the contact form collects the details needed to respond to support requests. We use this data to process
            payments, send transactional emails, provide support, and for fraud detection and accounting.
          </p>
        </section>

        <section>
          <h2>What we collect</h2>
          <ul>
            <li>Payment-related: phone numbers, amounts, payment receipts and timestamps.</li>
            <li>Hosted checkout and support: customer name, email and order reference when requested by the business, and messages submitted to support.</li>
            <li>Account information: name, email, role and business details for merchants.</li>
            <li>Operational logs and audit entries for compliance and troubleshooting.</li>
          </ul>
        </section>

        <section>
          <h2>How we share data</h2>
          <p>
            We do not share merchant data with other merchants. We deliver signed webhooks to each platform’s configured webhook URL so
            that the platform can reconcile payments; for hosted checkout, a platform may receive the payer details collected for its
            payment. Transactional email, including password resets and optional checkout receipts, is sent through the configured
            email provider. Support messages go to the IsaPay support address.
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
            <Link to="/">Back to home</Link>
          </p>
        </footer>
      </article>
    </div>
  );
}
