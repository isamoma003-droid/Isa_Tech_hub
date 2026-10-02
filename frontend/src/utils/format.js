const TIME_ZONE = 'Africa/Nairobi';

const kes = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 });
export const formatKes = (amount) => `KES ${kes.format(Math.round(amount || 0))}`;
export const formatNumber = (value) => kes.format(value || 0);

// 1,284 · 12.9K · 4.2M, for stat tiles and axis ticks.
export const compact = (value) =>
  new Intl.NumberFormat('en-KE', { notation: 'compact', maximumFractionDigits: value >= 1000 && value < 10_000 ? 1 : 0 }).format(value || 0);

export const formatDateTime = (date) =>
  date
    ? new Date(date).toLocaleString('en-KE', { timeZone: TIME_ZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    : '—';

export const formatFullDateTime = (date) =>
  date
    ? new Date(date).toLocaleString('en-KE', {
        timeZone: TIME_ZONE,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : '—';

// "2026-10-01" (a Kenyan calendar day) → "1 Oct".
export const formatDay = (day, options = { day: 'numeric', month: 'short' }) =>
  new Date(`${day}T12:00:00+03:00`).toLocaleDateString('en-KE', { timeZone: TIME_ZONE, ...options });

export function timeAgo(date) {
  if (!date) return 'never';
  const seconds = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} d ago` : formatDateTime(date);
}

export const percent = (ratio) => (ratio === null || ratio === undefined ? '—' : `${Math.round(ratio * 100)}%`);

// "2026-09" → "Sep 2026".
export const formatPeriod = (period) =>
  period ? new Date(`${period}-15T12:00:00+03:00`).toLocaleDateString('en-KE', { timeZone: TIME_ZONE, month: 'short', year: 'numeric' }) : '—';
