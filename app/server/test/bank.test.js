// Bank statement import. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import * as ledger from '../ledger.js';
import { parseCsv, parseDate, parseAmount, detectColumns, statementLines, preview, commit, matchKey } from '../bank.js';
import { findProblems } from '../problems.js';

function fresh() {
  const db = openDb(':memory:');
  db.exec(`INSERT INTO accounts (code, main_code, description, gst_exempt) VALUES ('230', '230', 'Sales', 0), ('270', '270', 'Fuel', 0), ('424', '424', 'Bank Charges', 1);
    INSERT INTO payees (code, name, account_code) VALUES ('FUEL', 'HILLTOP FUEL STOP', '270');
    INSERT INTO gst_rates (start_date, end_date, rate_bp) VALUES ('2010-10-01', NULL, 1500);
    UPDATE settings SET value = '100000' WHERE key = 'opening_balance_cents';`);
  return db;
}

test('dates and amounts in the forms banks use', () => {
  assert.equal(parseDate('03/07/2026'), '2026-07-03');
  assert.equal(parseDate('3/7/26'), '2026-07-03');
  assert.equal(parseDate('2026-07-03'), '2026-07-03');
  assert.equal(parseDate('2026/07/03'), '2026-07-03');
  assert.equal(parseDate('03-Jul-2026'), '2026-07-03');
  assert.equal(parseDate('3 July 2026'), '2026-07-03');
  assert.equal(parseDate('20260703'), '2026-07-03');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('Fuel'), null);
  assert.equal(parseAmount('-1,234.50'), -123450);
  assert.equal(parseAmount('(45.00)'), -4500);
  assert.equal(parseAmount('45.00 DR'), -4500);
  assert.equal(parseAmount('$12'), 1200);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('abc'), null);
});

test('CSV with quotes, commas inside cells and blank lines', () => {
  const rows = parseCsv('Date,Details,Amount\r\n"01/07/2026","SMITH, J ""JOE""",-10.00\r\n\r\n02/07/2026,X,5\r\n');
  assert.equal(rows.length, 3);
  assert.equal(rows[1][1], 'SMITH, J "JOE"');
});

test('one amount column, newest first, with a preamble above the header', () => {
  const csv = `Account 12-3456,,,,\nCreated 31/07/2026,,,,\nDate,Amount,Payee,Particulars,Balance\n05/07/2026,-57.50,HILLTOP FUEL STOP,CARD 4421,942.50\n01/07/2026,1000.00,NORTHFIELD COUNCIL,INV 12,1000.00\n`;
  const rows = parseCsv(csv);
  const d = detectColumns(rows);
  assert.equal(d.headerRow, 2);
  assert.deepEqual([d.mapping.date, d.mapping.amount, d.mapping.payee, d.mapping.balance], [0, 1, 2, 4]);
  const { lines } = statementLines(rows, d);
  assert.deepEqual(lines.map(l => [l.date, l.amount_cents, l.balance_cents]), [['2026-07-01', 100000, 100000], ['2026-07-05', -5750, 94250]]);
});

test('separate debit and credit columns', () => {
  const rows = parseCsv('Transaction Date,Description,Debit,Credit,Balance\n01/07/2026,RENT,1840.00,,160.00\n02/07/2026,CLIENT,,500.00,660.00\n');
  const { lines } = statementLines(rows, detectColumns(rows));
  assert.deepEqual(lines.map(l => l.amount_cents), [-184000, 50000]);
});

test('no header row: columns are judged by their contents', () => {
  const rows = parseCsv('01/07/2026,HILLTOP FUEL STOP,-57.50,942.50\n02/07/2026,BANK FEE,-5.00,937.50\n03/07/2026,CLIENT LTD,200.00,1137.50\n');
  const d = detectColumns(rows);
  assert.equal(d.headerRow, -1);
  const { lines } = statementLines(rows, d);
  assert.deepEqual(lines.map(l => [l.amount_cents, l.balance_cents, l.description]), [[-5750, 94250, 'HILLTOP FUEL STOP'], [-500, 93750, 'BANK FEE'], [20000, 113750, 'CLIENT LTD']]);
});

test('reference numbers in a description do not make it a different payee', () => {
  assert.equal(matchKey('Countdown 4421 12/07'), matchKey('COUNTDOWN 4421 19/07'));
});

const CSV = `Date,Amount,Payee,Particulars,Balance
01/07/2026,-57.50,HILLTOP FUEL STOP,CARD 4421,942.50
03/07/2026,-5.00,MONTHLY ACCOUNT FEE,,937.50
04/07/2026,-57.50,HILLTOP FUEL STOP,CARD 4421,880.00
06/07/2026,2300.00,NORTHFIELD COUNCIL,INV 12,3180.00
`;

test('statement lines are matched to the books; the rest are offered with no codes filled in', () => {
  const db = fresh();
  ledger.createTransaction(db, { date: '2026-07-01', type: 'P', amount_cents: 5750, account_code: '270', payee_name: 'HILLTOP FUEL STOP', payee_code: 'FUEL' });
  ledger.createTransaction(db, { date: '2026-07-05', type: 'R', amount_cents: 230000, account_code: '230', payee_name: 'NORTHFIELD DC' });   // banked a day earlier in the books
  const extra = ledger.createTransaction(db, { date: '2026-07-02', type: 'P', amount_cents: 9900, account_code: '270', payee_name: 'NOT ON STATEMENT' });
  const p = preview(db, CSV);
  assert.deepEqual(p.lines.map(l => l.status), ['matched', 'new', 'new', 'matched']);
  // nothing is guessed, even for a payee the books know well: the person checking codes every new line
  for (const l of p.lines.filter(x => x.status === 'new')) {
    assert.equal(l.suggestion, undefined);
    assert.equal(l.account_code, undefined);
    assert.equal(l.payee_code, undefined);
  }
  assert.equal(p.lines[2].payee_name, 'HILLTOP FUEL STOP');             // the bank's wording, to edit
  assert.deepEqual(p.book_only.map(t => t.id), [extra.id]);
  assert.deepEqual(p.counts, { total: 4, done: 0, matched: 2, fresh: 2, book_only: 1 });
});

test('importing adds the new lines once and records the closing balance', () => {
  const db = fresh();
  db.prepare("UPDATE settings SET value = '100000' WHERE key = 'opening_balance_cents'").run();
  ledger.createTransaction(db, { date: '2026-07-01', type: 'P', amount_cents: 5750, account_code: '270', payee_name: 'HILLTOP FUEL STOP' });
  ledger.createTransaction(db, { date: '2026-07-06', type: 'R', amount_cents: 230000, account_code: '230', payee_name: 'NORTHFIELD COUNCIL' });
  let p = preview(db, CSV);
  const add = p.lines.filter(l => l.status === 'new').map(l => ({ ...l, account_code: l.description.includes('FEE') ? '424' : '270' }));
  const matched = p.lines.filter(l => l.status === 'matched').map(l => ({ fp: l.fp, transaction_id: l.transaction.id }));
  assert.equal(p.closing.book_after_cents, 100000 - 5750 + 230000 - 500 - 5750);
  const r = commit(db, { add, matched, checkpoint: { date: p.closing.date, balance_cents: p.closing.book_after_cents } });
  assert.deepEqual(r, { added: 2, ticked: 2 });
  assert.equal(ledger.bankBalance(db), p.closing.book_after_cents);
  assert.ok(findProblems(db).checkpoints[0].ok);

  // the same file again: everything is already there
  p = preview(db, CSV);
  assert.deepEqual(p.lines.map(l => l.status), ['done', 'done', 'done', 'done']);
  assert.deepEqual(commit(db, { add, matched }), { added: 0, ticked: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 4);

  // next month the same payee still arrives uncoded
  const next = preview(db, ['Date,Amount,Payee', '03/08/2026,-5.00,MONTHLY ACCOUNT FEE'].join('\n'));
  assert.equal(next.lines[0].account_code, undefined);
});

test('a line with no ledger code stops the whole import', () => {
  const db = fresh();
  const p = preview(db, CSV);
  const add = p.lines.map(l => ({ ...l, account_code: '' }));
  assert.throws(() => commit(db, { add }), /Choose a ledger code/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 0);
});

test('unreadable columns ask for a mapping instead of failing', () => {
  const db = fresh();
  const p = preview(db, 'When,What,How much\nyesterday,thing,lots\n');
  assert.ok(p.needs_mapping);
  assert.deepEqual(p.columns, ['When', 'What', 'How much']);
});

test('two identical payments on the statement and one in the books: one is new, and can be added on purpose', () => {
  const db = fresh();
  const typed = ledger.createTransaction(db, { date: '2026-07-01', type: 'P', amount_cents: 5750, account_code: '270', payee_name: 'HILLTOP FUEL' });
  const p = preview(db, ['Date,Amount,Payee', '01/07/2026,-57.50,HILLTOP FUEL STOP', '01/07/2026,-57.50,HILLTOP FUEL STOP'].join('\n'));
  assert.deepEqual(p.lines.map(l => l.status), ['matched', 'new']);
  const r = commit(db, { matched: [{ fp: p.lines[0].fp, transaction_id: typed.id }], add: [{ ...p.lines[1], bank_date: p.lines[1].date, payee_name: 'HILLTOP FUEL', account_code: '270' }] });
  assert.deepEqual(r, { added: 1, ticked: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 2);
});

test('references: the preview gives the next number for each month, and the import uses the ones it is sent', () => {
  const db = fresh();
  ledger.createTransaction(db, { date: '2026-07-01', type: 'P', amount_cents: 100, account_code: '270', payee_name: 'A' });   // bk26/07-01
  ledger.createTransaction(db, { date: '2026-07-02', type: 'P', amount_cents: 200, account_code: '270', payee_name: 'B' });   // bk26/07-02
  const p = preview(db, ['Date,Amount,Payee', '30/07/2026,-11.00,SHOP ONE', '31/07/2026,-12.00,SHOP TWO', '01/08/2026,-13.00,SHOP THREE'].join('\n'));
  assert.equal(p.next_refs['2026-07'], 'bk26/07-03');
  assert.equal(p.next_refs['2026-08'], 'bk26/08-01');
  const add = p.lines.map((l, i) => ({ ...l, bank_date: l.date, payee_name: l.description, account_code: '270', reference: ['bk26/07-03', 'PC-17', ''][i] }));
  commit(db, { add });
  const refs = db.prepare('SELECT reference FROM transactions WHERE bank_ref IS NOT NULL ORDER BY date').all().map(r => r.reference);
  assert.deepEqual(refs, ['bk26/07-03', 'PC-17', 'bk26/08-01']);       // as sent, as typed, and numbered when left blank
  // a reference already in the books stops the import
  const again = preview(db, ['Date,Amount,Payee', '05/08/2026,-14.00,SHOP FOUR'].join('\n'));
  assert.throws(() => commit(db, { add: [{ ...again.lines[0], bank_date: again.lines[0].date, payee_name: 'X', account_code: '270', reference: 'PC-17' }] }), /PC-17 is already used/);
});

test('a statement line split into parts: each part is its own entry, and the parts must add up', () => {
  const db = fresh();
  const csv = ['Date,Amount,Payee', '10/08/2026,32200.00,PINNACLES CI'].join('\n');
  const p = preview(db, csv);
  const line = p.lines[0];
  const part = (fp, cents, reference) => ({ ...line, fp, bank_date: line.date, amount_cents: cents, line_cents: line.amount_cents, reference, payee_name: 'PINNACLES', account_code: '230', allow_duplicate: true });

  assert.throws(() => commit(db, { add: [part(line.fp, 2000000, 'F6-101'), part(line.fp + '#2', 1000000, 'F6-102')] }), /come to 30000.00, but the bank line is 32200.00/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 0);

  const r = commit(db, { add: [part(line.fp, 2000000, 'F6-101'), part(line.fp + '#2', 1000000, 'F6-102'), part(line.fp + '#3', 220000, 'F6-103')] });
  assert.equal(r.added, 3);
  assert.deepEqual(db.prepare('SELECT reference, amount_cents, type FROM transactions ORDER BY id').all().map(t => [t.reference, t.amount_cents, t.type]),
    [['F6-101', 2000000, 'R'], ['F6-102', 1000000, 'R'], ['F6-103', 220000, 'R']]);
  assert.equal(ledger.bankBalance(db), 100000 + 3220000);

  // the same statement again: the line is recognised as done and its parts are not listed as strays
  const again = preview(db, csv);
  assert.equal(again.lines[0].status, 'done');
  assert.equal(again.book_only.length, 0);
});

test('an entry of the same amount more than four days away is a different transaction: the line is simply new', () => {
  const db = fresh();
  ledger.createTransaction(db, { date: '2026-06-22', type: 'P', amount_cents: 5750, account_code: '270', payee_name: 'HILLTOP FUEL' });
  const p = preview(db, ['Date,Amount,Payee', '01/07/2026,-57.50,HILLTOP FUEL STOP'].join('\n'));
  assert.equal(p.lines[0].status, 'new');
  assert.equal(p.lines[0].possible, undefined);
  assert.equal(p.counts.possible, undefined);
  assert.equal(commit(db, { add: [{ ...p.lines[0], bank_date: p.lines[0].date, account_code: '270' }] }).added, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 2);
});

test('if the same entry is typed into the books after the preview was drawn, adding the line is refused', () => {
  const db = fresh();
  const p = preview(db, ['Date,Amount,Payee', '01/07/2026,-57.50,HILLTOP FUEL STOP'].join('\n'));
  ledger.createTransaction(db, { date: '2026-07-02', type: 'P', amount_cents: 5750, account_code: '270', payee_name: 'HILLTOP FUEL' });
  assert.throws(() => commit(db, { add: [{ ...p.lines[0], bank_date: p.lines[0].date, account_code: '270' }] }), /already have bk26.07-01 for the same amount/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 1);
});
