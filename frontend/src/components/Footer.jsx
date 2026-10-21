import { Link } from 'react-router-dom';
import { Brand } from './Logo.jsx';

export default function Footer() {
  return (
    <footer className="app-footer">
      <div className="footer-content">
        <div className="footer-brand">
          <Brand subtitle="by ISA Tech" />
          <p>One M-Pesa gateway for platforms, with reliable payments and signed webhooks.</p>
        </div>

        <nav className="footer-links" aria-label="Footer">
          <div className="footer-column">
            <h2>Explore</h2>
            <Link to="/">Home</Link>
            <Link to="/developers">Developers &amp; API</Link>
            <Link to="/faq">Frequently asked questions</Link>
            <Link to="/contact">Contact support</Link>
          </div>

          <div className="footer-column">
            <h2>Resources</h2>
            <a href="/sdk/isa-hub.cjs" download>Download Node.js SDK</a>
            <Link to="/developers">Integration guide</Link>
            <Link to="/contact">Support center</Link>
          </div>

          <div className="footer-column">
            <h2>Account &amp; legal</h2>
            <Link to="/login">Sign in</Link>
            <Link to="/register">Create an account</Link>
            <Link to="/privacy">Privacy policy</Link>
            <Link to="/terms">Terms of use</Link>
          </div>
        </nav>
      </div>

      <div className="footer-bottom">
        <small>© {new Date().getFullYear()} ISA Tech · IsaPay. All rights reserved.</small>
      </div>
    </footer>
  );
}
