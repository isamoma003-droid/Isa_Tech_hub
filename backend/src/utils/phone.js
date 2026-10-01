// Accepts 07XXXXXXXX, 01XXXXXXXX, 7XXXXXXXX, +2547XXXXXXXX and 2547XXXXXXXX (spaces and dashes
// allowed). Returns 2547XXXXXXXX / 2541XXXXXXXX, or null if it isn't a Kenyan mobile number.
export function normalizePhone(input) {
  const digits = String(input || '').replace(/[\s\-()]/g, '').replace(/^\+/, '');
  let local;
  if (/^254[17]\d{8}$/.test(digits)) local = digits.slice(3);
  else if (/^0[17]\d{8}$/.test(digits)) local = digits.slice(1);
  else if (/^[17]\d{8}$/.test(digits)) local = digits;
  else return null;
  return `254${local}`;
}

// 254712345678 → 0712***678, for screens and logs.
export const maskPhone = (phone) => (phone && phone.length >= 12 ? `0${phone.slice(3, 6)}***${phone.slice(-3)}` : phone || '');
