import { BRAND } from '../brand.js';

export function LogoMark({ size = 36 }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="isapay-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b5bdb" />
          <stop offset="1" stopColor="#0c8f6a" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#isapay-logo)" />
      <g fill="#fff">
        <circle cx="20" cy="17" r="5" />
        <rect x="15" y="26" width="10" height="24" rx="5" />
      </g>
      <path d="M35 50V19h7.5a10 10 0 0 1 0 20H35" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand({ subtitle = BRAND.tagline }) {
  return (
    <div className="brand">
      <LogoMark />
      <span className="brand-text">
        <strong>{BRAND.name}</strong>
        <small>{subtitle}</small>
      </span>
    </div>
  );
}
