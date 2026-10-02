import { useState } from 'react';
import { AlertTriangle, Check, CircleCheck, CircleX, Clock, Copy, LoaderCircle, Scale } from 'lucide-react';

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="spinner" role="status">
      <LoaderCircle className="spin" size={20} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorMessage({ error, title = 'Something went wrong' }) {
  if (!error) return null;
  return (
    <div className="notice notice-error" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{error.message || String(error)}</p>
      </div>
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

// Status never relies on color alone: every badge has an icon and a word.
const STATUS = {
  paid: { icon: CircleCheck, label: 'Paid' },
  pending: { icon: Clock, label: 'Pending' },
  failed: { icon: CircleX, label: 'Failed' },
  disputed: { icon: Scale, label: 'Disputed' },
  delivered: { icon: CircleCheck, label: 'Delivered', tone: 'paid' },
  active: { icon: CircleCheck, label: 'Active', tone: 'paid' },
  disabled: { icon: CircleX, label: 'Disabled', tone: 'failed' },
};

export function StatusBadge({ status }) {
  const meta = STATUS[status] || { icon: Clock, label: status };
  const Icon = meta.icon;
  return (
    <span className={`badge badge-${meta.tone || status}`}>
      <Icon size={14} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

export function CopyButton({ value, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the value is still selectable on screen.
    }
  };
  return (
    <button type="button" className="btn btn-ghost btn-small" onClick={copy} aria-label={`${label}: ${copied ? 'copied' : 'copy to clipboard'}`}>
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

// A secret shown exactly once (API key, webhook signing secret).
export function SecretReveal({ title, value, children }) {
  return (
    <div className="secret">
      <div className="secret-head">
        <strong>{title}</strong>
        <CopyButton value={value} />
      </div>
      <code className="secret-value">{value}</code>
      <p className="hint">{children || 'Copy it now: it will not be shown again.'}</p>
    </div>
  );
}

export function Field({ label, hint, error, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Pager({ page, pages, onPage }) {
  if (pages <= 1) return null;
  return (
    <nav className="pager" aria-label="Pages">
      <button type="button" className="btn btn-ghost btn-small" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span>
        Page {page} of {pages}
      </span>
      <button type="button" className="btn btn-ghost btn-small" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </nav>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function CodeBlock({ title, code }) {
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{title}</span>
        <CopyButton value={code} />
      </div>
      <pre>{code}</pre>
    </div>
  );
}
