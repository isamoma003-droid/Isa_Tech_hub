import { Link } from 'react-router-dom';
import { Brand } from '../components/Logo.jsx';

export default function TermsPage() {
  return (
    <div className="page container">
      <header className="page-header">
        <div>
          <Brand subtitle="by ISA Tech" />
          <p className="subtitle muted">Terms of use for IsaPay / ISA Tech Hub.</p>
        </div>
      </header>

      <article className="card stack">
        <section>
          <h2>Acceptance of terms</h2>
          <p className="lead">
            By using IsaPay, you agree to use the gateway lawfully and only for payment flows that you are authorised to operate.
          </p>
        </section>

        <section>
          <h3>Use of services</h3>
          <p>
            You are responsible for your platform, customer support, compliance, and any data you store or send using the Isapay API.
            IsaPay provides payment processing and related tools, but your business remains responsible for your product and customer experience.
          </p>
        </section>

        <section>
          <h3>Security and liability</h3>
          <p>
            Store API keys and webhook secrets only on trusted servers. You agree not to share credentials publicly or in browser code.
            IsaPay provides best-effort operational availability and will investigate incidents when reported, but not all indirect losses are covered.
          </p>
        </section>

        <section>
          <h3>Changes to terms</h3>
          <p>
            These terms may be adjusted as the product evolves. Continued use of the service after updates indicates acceptance of the revised terms.
          </p>
        </section>

        <footer className="page-foot">
          <p className="muted">Last updated: {new Date().toLocaleDateString()}</p>
          <p><Link to="/">Back to home</Link></p>
        </footer>
      </article>
    </div>
  );
}
