// Reports for the accountant: the ledger report (transactions grouped by ledger code) and the GST summary.
// All figures come from what is stored on each transaction; nothing is recalculated here.
import { getSettings } from './db.js';
import { SIGNED, bankBalance } from './ledger.js';
import { addDays } from '../shared/money.js';

function range(from, to, codes) {
  const where = ['t.date >= ?', 't.date <= ?'];
  const args = [from, to];
  if (codes && codes.length) { where.push(`t.account_code IN (${codes.map(() => '?').join(',')})`); args.push(...codes); }
  return { where: where.join(' AND '), args };
}

// One group per ledger code with its transactions and subtotals, then grand totals.
export function ledgerReport(db, { from, to, codes = [], detail = true }) {
  const { where, args } = range(from, to, codes);
  const rows = db.prepare(`
    SELECT t.id, t.date, t.reference, t.payee_name, t.type, t.amount_cents, t.gst_cents, t.account_code,
           a.description, a.sub_description
    FROM transactions t LEFT JOIN accounts a ON a.code = t.account_code
    WHERE ${where} ORDER BY t.account_code, t.date, t.id`).all(...args);
  const groups = [];
  const total = { payments_cents: 0, receipts_cents: 0, gst_cents: 0, net_cents: 0, count: 0 };
  let g = null;
  for (const r of rows) {
    if (!g || g.code !== r.account_code) {
      g = { code: r.account_code, description: r.description ?? '(not in the chart of accounts)', sub_description: r.sub_description || '',
        payments_cents: 0, receipts_cents: 0, gst_cents: 0, net_cents: 0, count: 0, rows: [] };
      groups.push(g);
    }
    const sign = r.type === 'R' ? 1 : -1;
    const amount = r.amount_cents || 0;
    for (const s of [g, total]) {
      if (r.type === 'R') s.receipts_cents += amount; else s.payments_cents += amount;
      s.gst_cents += sign * r.gst_cents;              // GST on receipts positive, on payments negative
      s.net_cents += sign * amount;
      s.count++;
    }
    if (detail) g.rows.push({ id: r.id, date: r.date, reference: r.reference, payee_name: r.payee_name, type: r.type, amount_cents: amount, gst_cents: r.gst_cents });
  }
  return { from, to, groups, total };
}

// GST collected and paid in a period, split into entries that carry GST and entries that do not.
export function gstSummary(db, { from, to }) {
  const r = db.prepare(`
    SELECT type, CASE WHEN gst_cents = 0 THEN 0 ELSE 1 END AS has_gst,
           COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS amount, COALESCE(SUM(gst_cents), 0) AS gst
    FROM transactions t WHERE t.date >= ? AND t.date <= ? GROUP BY type, has_gst`).all(from, to);
  const pick = (type, has) => r.find(x => x.type === type && x.has_gst === has) || { n: 0, amount: 0, gst: 0 };
  const out = {
    from, to,
    receipts_with_gst: pick('R', 1), receipts_no_gst: pick('R', 0),
    payments_with_gst: pick('P', 1), payments_no_gst: pick('P', 0)
  };
  out.gst_collected_cents = out.receipts_with_gst.gst;
  out.gst_paid_cents = out.payments_with_gst.gst;
  out.gst_difference_cents = out.gst_collected_cents - out.gst_paid_cents;
  return out;
}

// Opening and closing bank balance for a period, with the movement between.
export function periodBalances(db, { from, to }) {
  const opening = bankBalance(db, addDays(from, -1));
  const closing = bankBalance(db, to);
  const m = db.prepare(`SELECT COALESCE(SUM(CASE WHEN type = 'R' THEN amount_cents END), 0) AS receipts,
      COALESCE(SUM(CASE WHEN type = 'P' THEN amount_cents END), 0) AS payments, COUNT(*) AS n
    FROM transactions WHERE date >= ? AND date <= ?`).get(from, to);
  return { bank_account: getSettings(db).bank_account, opening_cents: opening, closing_cents: closing, receipts_cents: m.receipts, payments_cents: m.payments, count: m.n };
}

export { SIGNED };
