// Money and date helpers used by both the server and the browser. Amounts are whole cents throughout.

// "1,234.50" / "$12" / 12.5 -> cents, or null when it is not an amount.
export function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(/[$,\s]/g, '');
  if (!/^-?\d*(\.\d{0,2})?$/.test(s) || s === '' || s === '-' || s === '.') return null;
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const cents = Number(whole || 0) * 100 + Number((frac + '00').slice(0, 2));
  return neg ? -cents : cents;
}

export function fromCents(c, { blankZero = false } = {}) {
  if (c === null || c === undefined) return '';
  if (blankZero && c === 0) return '';
  const neg = c < 0;
  const a = Math.abs(c);
  const s = Math.floor(a / 100).toLocaleString('en-NZ') + '.' + String(a % 100).padStart(2, '0');
  return neg ? '-' + s : s;
}

// GST inside a GST-inclusive amount: amount x rate / (1 + rate), rounded half up to the cent.
// rateBp is the rate in basis points (1500 = 15%). Integer arithmetic only.
export function gstInside(amountCents, rateBp) {
  if (!amountCents || !rateBp) return 0;
  const den = 10000 + rateBp;
  return Math.floor((2 * Math.abs(amountCents) * rateBp + den) / (2 * den));
}

// The GST rate (basis points) in force on a date, from rows { start_date, end_date, rate_bp }; null if none.
export function rateOn(rates, date) {
  if (!date) return null;
  for (const r of rates) if (r.start_date <= date && (!r.end_date || date <= r.end_date)) return r.rate_bp;
  return null;
}

export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function todayIso() { return new Date().toLocaleDateString('en-CA'); }

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "2026-07-30" -> "30 Jul 2026"
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function niceDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}
