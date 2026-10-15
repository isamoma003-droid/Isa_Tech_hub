import { Link } from 'react-router-dom';
import { Brand } from './Logo.jsx';
import './PublicNav.css';

export default function PublicNav() {
  return (
    <header className="public-nav" role="banner">
      <div className="container nav-inner">
        <Link to="/" className="nav-brand" aria-label="IsaPay home">
          <Brand subtitle="by ISA Tech" />
        </Link>

        <nav className="nav-links" aria-label="Primary">
          <Link to="/developers">Developers</Link>
          <Link to="/faq">FAQ</Link>
          <Link to="/privacy">Privacy</Link>
          <a href="https://github.com/isamoma003-droid/Isa_Tech_hub" target="_blank" rel="noopener noreferrer">GitHub</a>
        </nav>

        <div className="nav-cta">
          <Link to="/login" className="btn btn-ghost">Sign in</Link>
          <Link to="/register" className="btn btn-primary">Get started</Link>
        </div>
      </div>
    </header>
  );
}
