import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Blocks, CreditCard, History, LayoutDashboard, LogOut, Menu, Smartphone, UserRound, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/payments', label: 'Payments', icon: CreditCard },
  { to: '/platforms', label: 'Platforms', icon: Blocks },
  { to: '/tills', label: 'Tills', icon: Smartphone },
  { to: '/audit', label: 'Audit log', icon: History },
];

export default function Layout() {
  const { admin, signOut } = useAuth();
  const location = useLocation();
  // The mobile menu stays open only on the page it was opened from, so navigating closes it.
  const [openOn, setOpenOn] = useState(null);
  const open = openOn === location.pathname;
  const setOpen = (value) => setOpenOn(value ? location.pathname : null);

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ISA
          </span>
          <span>
            <strong>ISA Tech Hub</strong>
            <small>Payments for every platform</small>
          </span>
          <button type="button" className="icon-btn menu-close" onClick={() => setOpen(false)} aria-label="Close menu">
            <X size={20} />
          </button>
        </div>
        <nav className="nav">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              <Icon size={18} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <NavLink to="/account" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <UserRound size={18} aria-hidden="true" />
            <span className="who">
              {admin.name}
              <small>{admin.role === 'admin' ? 'Admin' : 'Viewer (read-only)'}</small>
            </span>
          </NavLink>
          <button type="button" className="nav-link" onClick={signOut}>
            <LogOut size={18} aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>
      {open && <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
      <div className="main">
        <div className="topbar">
          <button type="button" className="icon-btn" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu size={22} />
          </button>
          <strong>ISA Tech Hub</strong>
        </div>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
