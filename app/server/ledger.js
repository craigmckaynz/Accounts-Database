// The cashbook itself: reading, adding, changing and deleting transactions, the bank balance and references.
import { getSettings, inTransaction } from './db.js';
import { gstInside, rateOn, isIsoDate, todayIso, addDays } from '../shared/money.js';

export class UserError extends Error {
  constructor(message, field) { super(message); this.field = field; this.status = 400; }
}

const SIGNED = "CASE type WHEN 'R' THEN amount_cents ELSE -amount_cents END";

export function gstRates(db) {
  return db.prepare('SELECT id, start_date, end_date, rate_bp FROM gst_rates ORDER BY start_date').all();
}

// Opening balance plus every transaction up to and including a date (all of them when no date is given).
export function bankBalance(db, asAt = null) {
  const opening = Number(getSettings(db).opening_balance_cents || 0);
  const row = asAt
    ? db.prepare(`SELECT COALESCE(SUM(${SIGNED}), 0) AS s FROM transactions WHERE date <= ?`).get(asAt)
    : db.prepare(`SELECT COALESCE(SUM(${SIGNED}), 0) AS s FROM transactions`).get();
  return opening + row.s;
}

// Next bank reference for a date: prefix + yy/mm + running number within that month, e.g. bk26/07-88.
export function nextReference(db, date) {
  const prefix = getSettings(db).bank_prefix || 'bk';
  const d = isIsoDate(date) ? date : todayIso();
  const stem = `${prefix}${d.slice(2, 4)}/${d.slice(5, 7)}-`;
  let max = 0;
  for (const r of db.prepare('SELECT reference FROM transactions WHERE reference LIKE ?').all(stem + '%')) {
    const n = Number(r.reference.slice(stem.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return stem + String(max + 1).padStart(2, '0');
}

// Transactions in (date, id) order with the bank balance after each one.
export function listTransactions(db, { from, to, q, account, limit = 2000 } = {}) {
  const opening = Number(getSettings(db).opening_balance_cents || 0);
  const where = [];
  const args = [opening];
  if (from) { where.push('date >= ?'); args.push(from); }
  if (to) { where.push('date <= ?'); args.push(to); }
  if (account) { where.push('account_code = ?'); args.push(account); }
  if (q) {
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    const cents = Math.round(Number(q.replace(/[$,\s]/g, '')) * 100);
    where.push('(payee_name LIKE ? OR reference LIKE ? OR account_code LIKE ? OR payee_code LIKE ?' + (Number.isFinite(cents) && cents > 0 ? ' OR amount_cents = ?)' : ')'));
    args.push(like, like, like, like);
    if (Number.isFinite(cents) && cents > 0) args.push(cents);
  }
  args.push(limit);
  const sql = `
    WITH run AS (
      SELECT t.*, ? + SUM(${SIGNED}) OVER (ORDER BY date, id ROWS UNBOUNDED PRECEDING) AS balance_cents
      FROM transactions t
    )
    SELECT * FROM (
      SELECT * FROM run ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC, id DESC LIMIT ?
    ) ORDER BY date, id`;
  return db.prepare(sql).all(...args);
}

export function getTransaction(db, id) {
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
}

function isLocked(db, date) {
  const lockedTo = getSettings(db).locked_to;
  return Boolean(lockedTo && date && date <= lockedTo);
}

// Checks what was typed and works out the GST. Returns the row to store.
function prepare(db, input, existing) {
  const accounts = db.prepare('SELECT code, gst_exempt FROM accounts WHERE code = ?');
  const t = {
    reference: String(input.reference ?? existing?.reference ?? '').trim(),
    date: input.date ?? existing?.date ?? null,
    type: input.type ?? existing?.type ?? 'P',
    amount_cents: input.amount_cents ?? existing?.amount_cents ?? null,
    payee_code: (input.payee_code ?? existing?.payee_code ?? '') || null,
    payee_name: String(input.payee_name ?? existing?.payee_name ?? '').trim(),
    account_code: String(input.account_code ?? existing?.account_code ?? '').trim()
  };
  if (!isIsoDate(t.date)) throw new UserError('Enter the transaction date.', 'date');
  if (t.date > addDays(todayIso(), 60)) throw new UserError('That date is more than 60 days in the future.', 'date');
  if (t.type !== 'P' && t.type !== 'R') throw new UserError('Choose Payment or Receipt.', 'type');
  if (!Number.isInteger(t.amount_cents) || t.amount_cents <= 0) throw new UserError('Enter the amount, as it appears on the bank statement.', 'amount_cents');
  if (!t.account_code) throw new UserError('Choose a ledger code.', 'account_code');
  const account = accounts.get(t.account_code);
  if (!account || t.account_code === '*') throw new UserError(`Ledger code "${t.account_code}" does not exist. Pick one from the list or add it under Setup.`, 'account_code');
  if (!t.reference) t.reference = nextReference(db, t.date);
  const clash = db.prepare('SELECT id FROM transactions WHERE reference = ? AND id <> ?').get(t.reference, existing?.id ?? -1);
  if (clash) throw new UserError(`Reference ${t.reference} is already used.`, 'reference');

  if (input.gst_manual) {
    if (!Number.isInteger(input.gst_cents) || input.gst_cents < 0 || input.gst_cents > t.amount_cents) throw new UserError('GST must be between zero and the amount.', 'gst_cents');
    t.gst_cents = input.gst_cents;
    t.gst_manual = 1;
  } else {
    // Recalculated only when something it depends on changed, so an old entry keeps the GST it was filed with.
    const depends = !existing || existing.gst_manual || ['date', 'type', 'amount_cents', 'account_code'].some(k => t[k] !== existing[k]);
    if (depends) {
      const rate = rateOn(gstRates(db), t.date);
      if (rate === null && !account.gst_exempt) throw new UserError(`There is no GST rate for ${t.date}. Add one under Setup.`, 'date');
      t.gst_cents = account.gst_exempt ? 0 : gstInside(t.amount_cents, rate);
    } else {
      t.gst_cents = existing.gst_cents;
    }
    t.gst_manual = 0;
  }
  return t;
}

function log(db, action, id, before, after) {
  db.prepare('INSERT INTO changes (at, action, transaction_id, before_json, after_json) VALUES (?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), action, id, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}

export function createTransaction(db, input) {
  return inTransaction(db, () => {
    const t = prepare(db, input, null);
    if (isLocked(db, t.date)) throw new UserError(`The accounts are locked up to ${getSettings(db).locked_to}. Unlock them under Setup to add entries in that period.`, 'date');
    const now = new Date().toISOString();
    const r = db.prepare(`INSERT INTO transactions (reference, date, type, amount_cents, gst_cents, gst_manual, payee_code, payee_name, account_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t.reference, t.date, t.type, t.amount_cents, t.gst_cents, t.gst_manual, t.payee_code, t.payee_name, t.account_code, now, now);
    const row = getTransaction(db, Number(r.lastInsertRowid));
    log(db, 'add', row.id, null, row);
    return row;
  });
}

export function updateTransaction(db, id, input) {
  return inTransaction(db, () => {
    const existing = getTransaction(db, id);
    if (!existing) throw new UserError('That transaction no longer exists.');
    if (isLocked(db, existing.date)) throw new UserError(`This entry is locked (accounts are locked up to ${getSettings(db).locked_to}).`);
    const t = prepare(db, input, existing);
    if (isLocked(db, t.date)) throw new UserError(`The accounts are locked up to ${getSettings(db).locked_to}.`, 'date');
    db.prepare(`UPDATE transactions SET reference = ?, date = ?, type = ?, amount_cents = ?, gst_cents = ?, gst_manual = ?, payee_code = ?, payee_name = ?, account_code = ?, updated_at = ? WHERE id = ?`)
      .run(t.reference, t.date, t.type, t.amount_cents, t.gst_cents, t.gst_manual, t.payee_code, t.payee_name, t.account_code, new Date().toISOString(), id);
    const row = getTransaction(db, id);
    log(db, 'edit', id, existing, row);
    return row;
  });
}

export function deleteTransaction(db, id) {
  return inTransaction(db, () => {
    const existing = getTransaction(db, id);
    if (!existing) throw new UserError('That transaction no longer exists.');
    if (isLocked(db, existing.date)) throw new UserError(`This entry is locked (accounts are locked up to ${getSettings(db).locked_to}).`);
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    log(db, 'delete', id, existing, null);
    return existing;
  });
}

// Puts a deleted transaction back exactly as it was (same reference, GST and id).
export function restoreTransaction(db, changeId) {
  return inTransaction(db, () => {
    const ch = db.prepare("SELECT * FROM changes WHERE id = ? AND action = 'delete'").get(changeId);
    if (!ch) throw new UserError('Nothing to restore.');
    const t = JSON.parse(ch.before_json);
    if (getTransaction(db, t.id)) throw new UserError('That entry has already been restored.');
    if (db.prepare('SELECT 1 FROM transactions WHERE reference = ?').get(t.reference)) throw new UserError(`Reference ${t.reference} has been used again since; it cannot be restored.`);
    db.prepare(`INSERT INTO transactions (id, reference, date, type, amount_cents, gst_cents, gst_manual, payee_code, payee_name, account_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t.id, t.reference, t.date, t.type, t.amount_cents, t.gst_cents, t.gst_manual, t.payee_code, t.payee_name, t.account_code, t.created_at, new Date().toISOString());
    log(db, 'restore', t.id, null, t);
    return getTransaction(db, t.id);
  });
}

export function lastDeleteChangeId(db, transactionId) {
  const r = db.prepare("SELECT id FROM changes WHERE action = 'delete' AND transaction_id = ? ORDER BY id DESC LIMIT 1").get(transactionId);
  return r ? r.id : null;
}

export { SIGNED };
