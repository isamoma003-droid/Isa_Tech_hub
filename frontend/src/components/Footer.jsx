import { Twitter, Facebook, Linkedin, Github, Mail } from 'lucide-react';
import { Brand } from './Logo.jsx';

export default function Footer() {
  return (
    <footer className="app-footer">
      <div className="container footer-grid">
        <div className="footer-brand">
          <Brand subtitle="by ISA Tech" />
          <p className="muted">IsaPay (ISA Tech Hub) — a single M‑Pesa gateway for multiple platforms.</p>
        </div>

        <nav className="footer-links" aria-label="Footer">
          <div className="footer-column">
            <h4>Product</h4>
            <ul>
              <li><a href="/">About IsaPay</a></li>
              <li><a href="/developers">Developers & API</a></li>
              <li><a href="/payments">Payments</a></li>
            </ul>
          </div>

          <div className="footer-column">
            <h4>Docs & support</h4>
            <ul>
              <li><a href="/developers">API docs</a></li>
              <li><a href="/developers#integration">Integration guide</a></li>
              <li><a href="/account">FAQs & account help</a></li>
            </ul>
          </div>

          <div className="footer-column">
            <h4>Company</h4>
            <ul>
              <li><a href="https://github.com/isamoma003-droid/Isa_Tech_hub" target="_blank" rel="noopener noreferrer">Source on GitHub</a></li>
              <li><a href="/privacy">Privacy</a></li>
              <li><a href="/terms">Terms</a></li>
            </ul>
          </div>
        </nav>

        <div className="footer-social">
          <h4>Connect</h4>
          <div className="social-icons">
            <a href="https://twitter.com/isa_tech" target="_blank" rel="noopener noreferrer" aria-label="ISA Tech on Twitter"><Twitter size={18} /></a>
            <a href="https://facebook.com/isa-tech" target="_blank" rel="noopener noreferrer" aria-label="ISA Tech on Facebook"><Facebook size={18} /></a>
            <a href="https://linkedin.com/company/isa-tech" target="_blank" rel="noopener noreferrer" aria-label="ISA Tech on LinkedIn"><Linkedin size={18} /></a>
            <a href="https://github.com/isamoma003-droid" target="_blank" rel="noopener noreferrer" aria-label="ISA Tech on GitHub"><Github size={18} /></a>
          </div>

          <div className="contact">
            <a href="mailto:hello@isatech.co.ke" aria-label="Email ISA Tech"><Mail size={14} /> hello@isatech.co.ke</a>
          </div>
        </div>
      </div>

      <div className="footer-bottom">
        <div className="container">
          <small className="muted">© {new Date().getFullYear()} ISA Tech — IsaPay. All rights reserved.</small>
        </div>
      </div>
    </footer>
  );
}
