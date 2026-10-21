import { Link, NavLink } from 'react-router-dom';
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
          <NavLink to="/" end>Home</NavLink>
          <NavLink to="/developers">Developers</NavLink>
          <NavLink to="/contact">Contact</NavLink>
          <NavLink to="/faq">FAQ</NavLink>
          <NavLink to="/privacy">Privacy</NavLink>
        </nav>

        <div className="nav-cta">
          <Link to="/login" className="btn btn-ghost">Sign in</Link>
          <Link to="/register" className="btn btn-primary">Get started</Link>
        </div>
      </div>
    </header>
  );
}
