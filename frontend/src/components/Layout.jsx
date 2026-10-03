import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Blocks, Code2, CreditCard, Download, History, LayoutDashboard, LogOut, Menu, ReceiptText, Smartphone, Users, X } from 'lucide-react';
import { useHealth } from '../api/queries.js';
import { BRAND } from '../brand.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useInstallPrompt } from '../pwa.js';
import { Brand } from './Logo.jsx';

// The ISA Tech team sees the whole gateway; a merchant sees its own corner of it.
const STAFF_NAV = [
  {
    section: 'Money',
    links: [
      { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
      { to: '/payments', label: 'Payments', icon: CreditCard },
      { to: '/billing', label: 'Billing & revenue', icon: ReceiptText },
    ],
  },
  {
    section: 'Gateway',
    links: [
      { to: '/platforms', label: 'Platforms', icon: Blocks },
      { to: '/tills', label: 'M-Pesa tills', icon: Smartphone },
      { to: '/developers', label: 'Developers', icon: Code2 },
    ],
  },
  {
    section: 'People & security',
    links: [
      { to: '/accounts', label: 'Accounts', icon: Users },
      { to: '/audit', label: 'Audit log', icon: History },
    ],
  },
];

const MERCHANT_NAV = [
  {
    section: 'Money',
    links: [
      { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
      { to: '/payments', label: 'Payments', icon: CreditCard },
      { to: '/billing', label: 'Billing & payouts', icon: ReceiptText },
    ],
  },
  {
    section: 'Integration',
    links: [
      { to: '/platforms', label: 'Your platforms', icon: Blocks },
      { to: '/tills', label: 'Your M-Pesa tills', icon: Smartphone },
      { to: '/developers', label: 'Developers', icon: Code2 },
    ],
  },
  { section: 'Account', links: [{ to: '/audit', label: 'Activity', icon: History }] },
];

const ROLE_LABEL = { admin: 'Admin', viewer: 'Viewer (read-only)', merchant: 'Merchant' };

// Until IsaPay approves a merchant, its live payments wait; sandbox tills work meanwhile.
function ApprovalBanner({ admin }) {
  const status = admin.approval?.status;
  if (admin.role !== 'merchant' || status === 'approved') return null;
  return (
    <div className={`banner ${status === 'rejected' ? 'banner-warn' : 'banner-info'}`} role="status">
      {status === 'rejected' ? (
        <>
          {BRAND.name} hasn't approved your business for live payments yet. <Link to="/account">See why and update your details</Link>
        </>
      ) : (
        <>
          {BRAND.name} is reviewing your business. Set up your platforms and test with a sandbox till meanwhile: live payments start once
          you're approved. <Link to="/account">Complete your business details</Link>
        </>
      )}
    </div>
  );
}

const initials = (name = '') =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '?';

function ApiStatus() {
  const { data, error, isPending } = useHealth();
  const state = isPending ? 'checking' : error || !data?.ok ? 'down' : 'up';
  const label = { checking: 'Checking API…', down: 'API unreachable', up: 'API online' }[state];
  return (
    <span className={`api-status api-${state}`} role="status" title={label}>
      <span className="dot" aria-hidden="true" />
      <span className="api-label">{label}</span>
    </span>
  );
}

function InstallButton() {
  const { canInstall, iosHint, install } = useInstallPrompt();
  const [showIosHint, setShowIosHint] = useState(false);
  if (canInstall) {
    return (
      <button type="button" className="btn btn-ghost btn-small" onClick={install}>
        <Download size={15} aria-hidden="true" /> Install app
      </button>
    );
  }
  if (!iosHint) return null;
  return (
    <span className="install-ios">
      <button type="button" className="btn btn-ghost btn-small" onClick={() => setShowIosHint((v) => !v)} aria-expanded={showIosHint}>
        <Download size={15} aria-hidden="true" /> Install app
      </button>
      {showIosHint && (
        <span className="popover" role="note">
          In Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
        </span>
      )}
    </span>
  );
}

export default function Layout() {
  const { admin, isMerchant, signOut } = useAuth();
  const nav = isMerchant ? MERCHANT_NAV : STAFF_NAV;
  const location = useLocation();
  // The mobile menu stays open only on the page it was opened from, so navigating closes it.
  const [openOn, setOpenOn] = useState(null);
  const open = openOn === location.pathname;
  const setOpen = (value) => setOpenOn(value ? location.pathname : null);

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-head">
          <Brand subtitle={`by ${BRAND.company}`} />
          <button type="button" className="icon-btn menu-close" onClick={() => setOpen(false)} aria-label="Close menu">
            <X size={20} />
          </button>
        </div>
        <nav className="nav" aria-label="Main">
          {nav.map(({ section, links }) => (
            <div key={section} className="nav-section">
              <span className="nav-heading">{section}</span>
              {links.map(({ to, label, icon: Icon, end }) => (
                <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                  <Icon size={18} aria-hidden="true" />
                  {label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <NavLink to="/account" className={({ isActive }) => `user-card ${isActive ? 'active' : ''}`}>
            <span className="avatar" aria-hidden="true">
              {admin.avatarUrl ? <img src={admin.avatarUrl} alt="" referrerPolicy="no-referrer" /> : initials(admin.name)}
            </span>
            <span className="who">
              {admin.name}
              <small>{isMerchant && admin.business?.name ? admin.business.name : ROLE_LABEL[admin.role]}</small>
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
        <header className="topbar">
          <button type="button" className="icon-btn menu-open" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu size={22} />
          </button>
          <strong className="topbar-brand">{BRAND.name}</strong>
          <div className="topbar-right">
            <ApiStatus />
            <InstallButton />
          </div>
        </header>
        <ApprovalBanner admin={admin} />
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
