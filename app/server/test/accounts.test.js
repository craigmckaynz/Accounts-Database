// Run with: npm test   (uses made-up data in memory; never touches the real accounts)
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import * as ledger from '../ledger.js';
import { findProblems, typoKind, suspectsFor } from '../problems.js';
import { ledgerReport, gstSummary, periodBalances } from '../reports.js';
import { seedDemo } from '../seed-demo.js';
import { scaled } from '../import-access.js';
import { toCents, fromCents, gstInside, rateOn, isIsoDate } from '../../shared/money.js';

function fresh() {
  const db = openDb(':memory:');
  db.exec(`INSERT INTO accounts (code, main_code, description, gst_exempt) VALUES ('230', '230', 'Sales', 0), ('270', '270', 'Fuel', 0), ('424', '424', 'Bank Charges', 1);
    INSERT INTO gst_rates (start_date, end_date, rate_bp) VALUES ('1989-07-01', '2010-09-30', 1250), ('2010-10-01', NULL, 1500);
    UPDATE settings SET value = '100000' WHERE key = 'opening_balance_cents';`);
  return db;
}
const pay = (db, date, amount, extra = {}) => ledger.createTransaction(db, { date, type: 'P', amount_cents: amount, account_code: '270', payee_name: 'FUEL', ...extra });

test('money: parsing, formatting and GST inside an amount', () => {
  assert.equal(toCents('1,234.50'), 123450);
  assert.equal(toCents('$12'), 1200);
  assert.equal(toCents('.5'), 50);
  assert.equal(toCents('12.345'), null);
  assert.equal(toCents('abc'), null);
  assert.equal(fromCents(-123456), '-1,234.56');
  assert.equal(gstInside(11500, 1500), 1500);
  assert.equal(gstInside(10000, 1500), 1304);      // 13.043 -> 13.04
  assert.equal(gstInside(11250, 1250), 1250);
  assert.equal(gstInside(100, 1500), 13);
  assert.equal(gstInside(0, 1500), 0);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('2026-02-28'), true);
});

test('GST rate comes from the transaction date', () => {
  const db = fresh();
  assert.equal(rateOn(ledger.gstRates(db), '2010-09-30'), 1250);
  assert.equal(rateOn(ledger.gstRates(db), '2010-10-01'), 1500);
  assert.equal(rateOn(ledger.gstRates(db), '1980-01-01'), null);
  assert.equal(pay(db, '2005-06-01', 11250).gst_cents, 1250);
  assert.equal(pay(db, '2026-06-01', 11500).gst_cents, 1500);
  assert.equal(pay(db, '2026-06-02', 11500, { account_code: '424' }).gst_cents, 0);     // exempt code
  assert.throws(() => pay(db, '1980-01-01', 100), /no GST rate/);
});

test('references run on within the month and restart in a new one', () => {
  const db = fresh();
  assert.equal(pay(db, '2026-07-01', 100).reference, 'bk26/07-01');
  assert.equal(pay(db, '2026-07-15', 100).reference, 'bk26/07-02');
  assert.equal(pay(db, '2026-08-01', 100).reference, 'bk26/08-01');
  assert.equal(ledger.nextReference(db, '2026-07-20'), 'bk26/07-03');
  assert.throws(() => pay(db, '2026-07-20', 100, { reference: 'bk26/07-01' }), /already used/);
});

test('bank balance is the opening balance plus receipts less payments', () => {
  const db = fresh();
  pay(db, '2026-07-01', 2500);
  ledger.createTransaction(db, { date: '2026-07-03', type: 'R', amount_cents: 10000, account_code: '230', payee_name: 'CLIENT' });
  assert.equal(ledger.bankBalance(db), 100000 - 2500 + 10000);
  assert.equal(ledger.bankBalance(db, '2026-07-02'), 97500);
  const rows = ledger.listTransactions(db, {});
  assert.deepEqual(rows.map(r => r.balance_cents), [97500, 107500]);
});

test('what is typed is checked', () => {
  const db = fresh();
  assert.throws(() => pay(db, '', 100), /date/);
  assert.throws(() => pay(db, '2026-07-01', 0), /amount/);
  assert.throws(() => pay(db, '2026-07-01', 100, { account_code: '999' }), /does not exist/);
  assert.throws(() => pay(db, '2099-01-01', 100), /future/);
});

test('editing recalculates GST only when the amount, date, type or code changes', () => {
  const db = fresh();
  const t = pay(db, '2026-07-01', 11500);
  db.prepare('UPDATE transactions SET gst_cents = 1278 WHERE id = ?').run(t.id);        // as if imported at an old rate
  assert.equal(ledger.updateTransaction(db, t.id, { payee_name: 'RENAMED' }).gst_cents, 1278);
  assert.equal(ledger.updateTransaction(db, t.id, { amount_cents: 23000 }).gst_cents, 3000);
  assert.equal(ledger.updateTransaction(db, t.id, { gst_manual: 1, gst_cents: 500 }).gst_cents, 500);
});

test('locked periods cannot be changed', () => {
  const db = fresh();
  const t = pay(db, '2026-03-31', 100);
  db.prepare("UPDATE settings SET value = '2026-03-31' WHERE key = 'locked_to'").run();
  assert.throws(() => ledger.updateTransaction(db, t.id, { amount_cents: 200 }), /locked/);
  assert.throws(() => ledger.deleteTransaction(db, t.id), /locked/);
  assert.throws(() => pay(db, '2026-03-01', 100), /locked/);
  assert.ok(pay(db, '2026-04-01', 100));
});

test('a deleted entry can be put back as it was', () => {
  const db = fresh();
  const t = pay(db, '2026-07-01', 2500);
  ledger.deleteTransaction(db, t.id);
  assert.equal(ledger.bankBalance(db), 100000);
  const back = ledger.restoreTransaction(db, ledger.lastDeleteChangeId(db, t.id));
  assert.equal(back.reference, t.reference);
  assert.equal(ledger.bankBalance(db), 97500);
});

test('typo detection', () => {
  assert.equal(typoKind(15840, 15480), 'two digits swapped');
  assert.equal(typoKind(1500, 15000), 'decimal point in the wrong place');
  assert.equal(typoKind(12345, 12845), 'one digit different');
  assert.equal(typoKind(12345, 1234), 'an extra digit');
  assert.equal(typoKind(12345, 99999), null);
});

test('problem finder names the entry behind a difference', () => {
  const db = fresh();
  pay(db, '2026-07-01', 5000);
  const wrong = pay(db, '2026-07-05', 15840);                       // statement says 154.80
  const flipped = pay(db, '2026-07-06', 3333);
  // a transposition: book is 3.60 lower than the statement
  let s = suspectsFor(db.prepare('SELECT * FROM transactions').all(), -360);
  assert.equal(s[0].transaction.id, wrong.id);
  assert.equal(s[0].fix.amount_cents, 15480);
  // a receipt entered as a payment: book is 2 x 33.33 lower
  s = suspectsFor(db.prepare('SELECT * FROM transactions').all(), -6666);
  assert.equal(s[0].transaction.id, flipped.id);
  assert.deepEqual(s[0].fix, { type: 'R' });
});

test('problem finder: the first statement that disagrees sets the stretch to search', () => {
  const db = fresh();
  pay(db, '2026-06-10', 5000);
  db.prepare("INSERT INTO checkpoints (date, balance_cents) VALUES ('2026-06-30', 95000)").run();
  pay(db, '2026-07-05', 2000);
  pay(db, '2026-07-05', 2000);                                       // entered twice
  db.prepare("INSERT INTO checkpoints (date, balance_cents) VALUES ('2026-07-31', 93000)").run();
  const p = findProblems(db);
  assert.equal(p.checkpoints.find(c => c.date === '2026-06-30').ok, true);
  assert.equal(p.first_break.from, '2026-06-30');
  assert.equal(p.first_break.to, '2026-07-31');
  assert.equal(p.first_break.diff_cents, -2000);
  assert.equal(p.first_break.suspects[0].kind, 'duplicate');
  assert.ok(p.checks.some(c => c.key === 'duplicate'));
});

test('sweep: wrong month, gaps, missing data, GST off', () => {
  const db = fresh();
  pay(db, '2026-07-01', 100);
  pay(db, '2026-07-02', 100, { reference: 'bk26/07-04' });
  pay(db, '2026-06-02', 100, { reference: 'bk26/07-05' });           // July reference, June date
  db.prepare("INSERT INTO transactions (reference, date, type, amount_cents, gst_cents, account_code) VALUES ('x1', NULL, 'P', 100, 0, '270'), ('x2', '2026-07-03', 'P', 11500, 1278, '270')").run();
  const keys = Object.fromEntries(findProblems(db, { since: '2000-01-01' }).checks.map(c => [c.key, c]));
  assert.equal(keys.ref_date.count, 1);
  assert.deepEqual(keys.ref_gap.gaps[0].missing, ['bk26/07-02', 'bk26/07-03']);
  assert.equal(keys.missing.count, 1);
  assert.equal(keys.gst.count, 1);
});

test('reports add up', () => {
  const db = openDb(':memory:');
  seedDemo(db, { today: '2026-10-04', plantProblems: false });
  const from = '2026-04-01', to = '2026-09-30';
  const rep = ledgerReport(db, { from, to });
  const bal = periodBalances(db, { from, to });
  assert.equal(bal.opening_cents + rep.total.net_cents, bal.closing_cents);
  assert.equal(rep.total.receipts_cents - rep.total.payments_cents, rep.total.net_cents);
  assert.equal(rep.groups.reduce((s, g) => s + g.net_cents, 0), rep.total.net_cents);
  for (const g of rep.groups) assert.equal(g.rows.reduce((s, r) => s + (r.type === 'R' ? 1 : -1) * r.amount_cents, 0), g.net_cents);
  const gst = gstSummary(db, { from, to });
  assert.equal(gst.gst_collected_cents - gst.gst_paid_cents, rep.total.gst_cents);
  assert.equal(gst.receipts_with_gst.amount + gst.receipts_no_gst.amount, rep.total.receipts_cents);
  // every month-end statement in the demo agrees when no problems are planted
  assert.ok(findProblems(db).checkpoints.every(c => c.ok));
  assert.equal(findProblems(db).first_break, null);
});

test('demo with planted slips: the finder points at the swapped digits', () => {
  const db = openDb(':memory:');
  seedDemo(db, { today: '2026-10-04' });
  const p = findProblems(db);
  assert.ok(p.first_break);
  assert.equal(p.first_break.suspects[0].kind, 'amount');
  assert.match(p.first_break.suspects[0].why, /two digits swapped/);
});

test('Access currency text converts without floating point', () => {
  assert.equal(scaled('1234.5000', 2), 123450);
  assert.equal(scaled('-0.0750', 2), -8);
  assert.equal(scaled('13.0435', 2), 1304);
  assert.equal(scaled('0.150', 4), 1500);
  assert.equal(scaled(null, 2), null);
});
