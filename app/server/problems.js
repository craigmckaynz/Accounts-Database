// The problem finder. Two jobs:
//  1. Compare the book balance with balances read off bank statements (checkpoints), find the first one that
//     does not agree, and name the entries in that stretch most likely to be the cause.
//  2. Sweep the entries for things that are wrong or suspicious whatever the balance says.
import { getSettings } from './db.js';
import { gstRates, SIGNED } from './ledger.js';
import { gstInside, rateOn, todayIso, addDays } from '../shared/money.js';

const signed = t => (t.type === 'R' ? t.amount_cents : -t.amount_cents);

// How could `wrong` be a slip of the pen for `right`? Returns a description or null. Both are positive cents.
export function typoKind(wrong, right) {
  if (wrong === right || right <= 0 || wrong <= 0) return null;
  if (wrong === right * 10 || right === wrong * 10 || wrong === right * 100 || right === wrong * 100) return 'decimal point in the wrong place';
  const a = String(wrong), b = String(right);
  if (a.length === b.length) {
    const diff = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]) return 'two digits swapped';
    if (diff.length === 1) return 'one digit different';
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  if (long.length === short.length + 1) {
    for (let i = 0; i < long.length; i++) if (long.slice(0, i) + long.slice(i + 1) === short) return a.length > b.length ? 'an extra digit' : 'a digit left out';
  }
  return null;
}

const TYPO_RANK = { 'two digits swapped': 1, 'decimal point in the wrong place': 2, 'an extra digit': 3, 'a digit left out': 3, 'one digit different': 4 };

// Entries in a stretch that would explain a difference (book balance minus statement balance, in cents).
export function suspectsFor(rows, diff) {
  const out = [];
  const seen = new Map();
  for (const t of rows) {
    if (!t.amount_cents) continue;
    const key = `${t.date}|${t.type}|${t.amount_cents}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const t of rows) {
    if (!t.amount_cents) continue;
    const s = signed(t);
    const twice = seen.get(`${t.date}|${t.type}|${t.amount_cents}`) > 1;
    if (s === diff) {
      out.push({ rank: twice ? 0 : 2, transaction: t, kind: twice ? 'duplicate' : 'extra',
        why: twice ? 'Same date, type and amount as another entry, and the amount is exactly the difference. It looks entered twice.'
          : 'Its amount is exactly the difference. Check it is on the bank statement and not entered twice.' });
    }
    if (2 * s === diff) {
      out.push({ rank: 1, transaction: t, kind: 'wrong_type',
        why: `Entered as a ${t.type === 'P' ? 'payment' : 'receipt'}. If it is really a ${t.type === 'P' ? 'receipt' : 'payment'}, the balance agrees.`,
        fix: { type: t.type === 'P' ? 'R' : 'P' } });
    }
    // Changing the amount from a to a2 moves the book balance by sign x (a2 - a); that must cancel the difference.
    const a2 = t.amount_cents - (t.type === 'R' ? diff : -diff);
    const kind = typoKind(t.amount_cents, a2);
    if (kind) {
      out.push({ rank: 2 + TYPO_RANK[kind], transaction: t, kind: 'amount',
        why: `If the amount should be ${(a2 / 100).toFixed(2)} (${kind}), the balance agrees.`,
        fix: { amount_cents: a2 } });
    }
  }
  out.sort((x, y) => x.rank - y.rank || (y.transaction.date || '').localeCompare(x.transaction.date || ''));
  // "One digit different" matches a great many entries when the difference is a round number: keep a few.
  const strong = out.filter(s => s.rank < 6);
  return strong.concat(out.filter(s => s.rank >= 6).slice(0, strong.length ? 5 : 15)).slice(0, 40);
}

// Gaps in the running numbers of bank references within a month: bk26/07-12 present, -13 missing, -14 present.
function referenceGaps(rows, prefix) {
  const months = new Map();
  const re = new RegExp('^' + prefix.replace(/[^a-z0-9]/gi, '') + '(\\d\\d)/(\\d\\d)-(\\d+)$', 'i');
  for (const t of rows) {
    const m = re.exec(t.reference);
    if (!m) continue;
    const k = `${m[1]}/${m[2]}`;
    if (!months.has(k)) months.set(k, new Set());
    months.get(k).add(Number(m[3]));
  }
  const gaps = [];
  for (const [k, set] of months) {
    const max = Math.max(...set);
    const missing = [];
    for (let n = 1; n < max; n++) if (!set.has(n)) missing.push(n);
    if (missing.length && missing.length <= 20) gaps.push({ month: k, missing: missing.map(n => `${prefix}${k}-${String(n).padStart(2, '0')}`) });
  }
  return gaps;
}

export function findProblems(db, { since } = {}) {
  const settings = getSettings(db);
  const opening = Number(settings.opening_balance_cents || 0);
  const prefix = settings.bank_prefix || 'bk';
  const today = todayIso();
  const all = db.prepare('SELECT * FROM transactions ORDER BY date, id').all();

  // ---- 1. Statement balances -------------------------------------------------------------------------
  const points = db.prepare('SELECT * FROM checkpoints ORDER BY date').all();
  const balanceAt = db.prepare(`SELECT COALESCE(SUM(${SIGNED}), 0) AS s FROM transactions WHERE date <= ?`);
  const checkpoints = points.map(p => {
    const book = opening + balanceAt.get(p.date).s;
    return { ...p, book_cents: book, diff_cents: book - p.balance_cents, ok: book === p.balance_cents };
  });
  let firstBreak = null;
  let lastGood = null;
  for (const c of checkpoints) {
    if (c.ok) { lastGood = c; continue; }
    // The stretch since the last statement that agreed. A difference carried from an earlier bad one is removed.
    const idx = checkpoints.indexOf(c);
    const prev = idx > 0 ? checkpoints[idx - 1] : null;
    const carried = prev && !prev.ok ? prev.diff_cents : 0;
    const diff = c.diff_cents - carried;
    if (diff === 0) continue;                       // same error as before, not a new one
    const from = prev ? prev.date : null;
    const rows = all.filter(t => t.date && t.date <= c.date && (!from || t.date > from));
    firstBreak = {
      from, to: c.date, diff_cents: diff, count: rows.length,
      // Entries already ticked off against a bank statement line are known to be right.
      suspects: suspectsFor(rows.filter(t => !t.bank_ref), diff),
      gaps: referenceGaps(rows, prefix),
      changed: recentChanges(db, from, c.date)
    };
    break;
  }

  // ---- 2. Sweep ----------------------------------------------------------------------------------------
  // Without a statement that agrees to start from, look at the last 12 months rather than 30 years of entries.
  const from = since || (lastGood ? lastGood.date : addDays(today, -365));
  const scope = all.filter(t => !from || !t.date || t.date > from);
  const accounts = new Map(db.prepare('SELECT code, gst_exempt FROM accounts').all().map(a => [a.code, a]));
  const rates = gstRates(db);
  const checks = [];
  const add = (key, severity, title, help, items) => { if (items.length) checks.push({ key, severity, title, help, count: items.length, items: items.slice(0, 200) }); };

  add('missing', 'error', 'Entries with something missing', 'No date, no amount or no ledger code. These distort the balance or drop out of reports.',
    all.filter(t => !t.date || !t.amount_cents || !t.account_code));
  add('unknown_account', 'error', 'Ledger code not in the chart of accounts', 'These entries are left out of the ledger report.',
    all.filter(t => t.account_code && !accounts.has(t.account_code)));
  add('future', 'warn', 'Dated in the future', 'Usually a wrong year or month.', scope.filter(t => t.date && t.date > today));

  const refRe = new RegExp('^' + prefix.replace(/[^a-z0-9]/gi, '') + '(\\d\\d)/(\\d\\d)-', 'i');
  add('ref_date', 'warn', 'Reference month and date disagree', `A ${prefix}yy/mm reference normally belongs to that month. A date typed in the wrong month or year puts the entry in the wrong period.`,
    scope.filter(t => { const m = refRe.exec(t.reference); return m && t.date && (t.date.slice(2, 4) !== m[1] || t.date.slice(5, 7) !== m[2]); }));

  const groups = new Map();
  for (const t of scope) {
    if (!t.date || !t.amount_cents) continue;
    const k = `${t.date}|${t.type}|${t.amount_cents}|${(t.payee_name || '').toLowerCase()}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  add('duplicate', 'warn', 'Possible double entries', 'Same date, type, amount and payee. Some are genuine (two identical payments on one day); check them against the statement.',
    [...groups.values()].filter(g => g.length > 1).flat());

  const gaps = referenceGaps(scope, prefix);
  if (gaps.length) checks.push({ key: 'ref_gap', severity: 'info', title: 'Missing reference numbers', help: 'A number skipped within a month can mean an entry was missed or deleted.', count: gaps.reduce((n, g) => n + g.missing.length, 0), gaps });

  const gstOff = scope.filter(t => {
    if (t.gst_manual || !t.date || !t.amount_cents) return false;
    const acc = accounts.get(t.account_code);
    if (!acc) return false;
    const rate = rateOn(rates, t.date);
    const expected = acc.gst_exempt || rate === null ? 0 : gstInside(t.amount_cents, rate);
    return Math.abs(expected - t.gst_cents) > 1;
  });
  add('gst', 'info', 'GST differs from the rate for the date', 'The stored GST is not what the rate on that date gives (or the ledger code is GST exempt and GST is recorded). It does not affect the bank balance. Review with your accountant before changing any of these.', gstOff);

  return {
    as_at: today,
    balance_cents: opening + all.reduce((s, t) => s + (t.amount_cents ? signed(t) : 0), 0),
    checkpoints: checkpoints.slice().reverse(),
    first_break: firstBreak,
    sweep_from: from,
    checks,
    recent: recentChanges(db, null, null, 30)
  };
}

// Edits and deletions (not plain additions): the entries most likely to have been disturbed.
function recentChanges(db, from, to, limit = 50) {
  const rows = db.prepare("SELECT * FROM changes WHERE action IN ('edit', 'delete') ORDER BY id DESC LIMIT 500").all();
  const out = [];
  for (const r of rows) {
    const before = r.before_json ? JSON.parse(r.before_json) : null;
    const after = r.after_json ? JSON.parse(r.after_json) : null;
    const dates = [before?.date, after?.date].filter(Boolean);
    if ((from || to) && !dates.some(d => (!from || d > from) && (!to || d <= to))) continue;
    out.push({ id: r.id, at: r.at, action: r.action, before, after });
    if (out.length >= limit) break;
  }
  return out;
}
