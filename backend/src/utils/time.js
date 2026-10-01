export const TIME_ZONE = 'Africa/Nairobi';

function parts(date, options) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hourCycle: 'h23', ...options })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
}

// Daraja wants the request time in Kenya time as YYYYMMDDHHmmss.
export function darajaTimestamp(date = new Date()) {
  const p = parts(date, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`;
}

// The calendar day in Kenya, as YYYY-MM-DD.
export function kenyaDay(date = new Date()) {
  const p = parts(date, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

// Midnight in Kenya (UTC+3, no daylight saving) `daysAgo` days back, as a Date.
export function startOfKenyaDay(daysAgo = 0, now = new Date()) {
  const [y, m, d] = kenyaDay(now).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - daysAgo, -3));
}
