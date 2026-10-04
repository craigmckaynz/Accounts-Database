// Bank statement import. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import * as ledger from '../ledger.js';
import { parseCsv, parseDate, parseAmount, detectColumns, statementLines, preview, commit, matchKey, buildHistory, bestMatch, words } from '../bank.js';
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

test('statement lines are matched to the books, the rest are offered with a ledger code', () => {
  const db = fresh();
  ledger.createTransaction(db, { date: '2026-07-01', type: 'P', amount_cents: 5750, account_code: '270', payee_name: 'HILLTOP FUEL STOP', payee_code: 'FUEL' });
  ledger.createTransaction(db, { date: '2026-07-05', type: 'R', amount_cents: 230000, account_code: '230', payee_name: 'NORTHFIELD DC' });   // banked a day earlier in the books
  const extra = ledger.createTransaction(db, { date: '2026-07-02', type: 'P', amount_cents: 9900, account_code: '270', payee_name: 'NOT ON STATEMENT' });
  const p = preview(db, CSV);
  assert.deepEqual(p.lines.map(l => l.status), ['matched', 'new', 'new', 'matched']);
  assert.equal(p.lines[2].suggestion.account_code, '270');            // second fuel line: known payee
  assert.equal(p.lines[2].suggestion.payee_code, 'FUEL');
  assert.equal(p.lines[1].suggestion.account_code, null);             // bank fee: never seen before
  assert.deepEqual(p.book_only.map(t => t.id), [extra.id]);
  assert.deepEqual(p.counts, { total: 4, done: 0, matched: 2, fresh: 2, possible: 0, book_only: 1 });
});

test('importing adds the new lines once, remembers the ledger code, and records the closing balance', () => {
  const db = fresh();
  db.prepare("UPDATE settings SET value = '100000' WHERE key = 'opening_balance_cents'").run();
  ledger.createTransaction(db, { date: '2026-07-01', type: 'P', amount_cents: 5750, account_code: '270', payee_name: 'HILLTOP FUEL STOP' });
  ledger.createTransaction(db, { date: '2026-07-06', type: 'R', amount_cents: 230000, account_code: '230', payee_name: 'NORTHFIELD COUNCIL' });
  let p = preview(db, CSV);
  const add = p.lines.filter(l => l.status === 'new').map(l => ({ ...l, payee_name: l.suggestion.payee_name, payee_code: l.suggestion.payee_code, account_code: l.suggestion.account_code || '424' }));
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

  // next month the fee is recognised
  const next = preview(db, 'Date,Amount,Payee,Particulars,Balance\n03/08/2026,-5.00,MONTHLY ACCOUNT FEE,,0\n');
  assert.equal(next.lines[0].suggestion.account_code, '424');
});

test('a line with no ledger code stops the whole import', () => {
  const db = fresh();
  const p = preview(db, CSV);
  const add = p.lines.map(l => ({ ...l, payee_name: l.description, account_code: l.suggestion.account_code }));
  assert.throws(() => commit(db, { add }), /MONTHLY ACCOUNT FEE: Choose a ledger code/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 0);
});

test('unreadable columns ask for a mapping instead of failing', () => {
  const db = fresh();
  const p = preview(db, 'When,What,How much\nyesterday,thing,lots\n');
  assert.ok(p.needs_mapping);
  assert.deepEqual(p.columns, ['When', 'What', 'How much']);
});

test('past entries give the ledger code and quick code, even when the bank words the payee differently', () => {
  const db = fresh();
  db.exec("INSERT INTO accounts (code, main_code, description) VALUES ('240', '240', 'Purchases'), ('418', '418', 'Telephones'); INSERT INTO payees (code, name, account_code) VALUES ('NET', 'KIWILINK BROADBAND', '418');");
  const add = (date, name, account, extra = {}) => ledger.createTransaction(db, { date, type: 'P', amount_cents: 5000, account_code: account, payee_name: name, ...extra });
  for (let d = 1; d <= 5; d++) add('2026-05-0' + d, 'HILLTOP FUEL', '270', { payee_code: 'FUEL' });
  add('2026-05-10', 'HILLTOP CAFE', '240');
  ledger.createTransaction(db, { date: '2026-05-12', type: 'R', amount_cents: 230000, account_code: '230', payee_name: 'NORTHFIELD DC' });
  const h = buildHistory(db);
  const line = (description, amount = -5000, detail = '') => ({ description, detail, amount_cents: amount });

  let m = bestMatch(h, line('HILLTOP FUEL STOP WHAKATANE', -6120, 'CARD 4421'));
  assert.match(m.payee.name, /^HILLTOP FUEL/);      // the quick code's own name or the typed one: same codes
  assert.equal(m.payee.account_code, '270');
  assert.equal(m.payee.payee_code, 'FUEL');
  assert.equal(bestMatch(h, line('HILLTOP CAFE 4421')).payee.account_code, '240');           // the other Hilltop
  assert.equal(bestMatch(h, line('NORTHFIELD DISTRICT COUNCIL', 99000, 'DIRECT CREDIT')).payee.account_code, '230');
  assert.equal(bestMatch(h, line('KIWILINK BROADBAN', -8990, 'DIRECT DEBIT')).payee.payee_code, 'NET');   // a quick code never used yet, name cut short
  assert.equal(bestMatch(h, line('SOMEWHERE NEVER SEEN')), null);
  assert.equal(bestMatch(h, line('EFTPOS CARD 4421')), null);                                  // nothing but noise words
  assert.deepEqual(words('Direct Debit KIWILINK Broadband Ltd 0042'), ['KIWILINK', 'BROADBAND']);
});

test('when a payee has been recoded, the recent coding wins', () => {
  const db = fresh();
  db.exec("INSERT INTO accounts (code, main_code, description) VALUES ('240', '240', 'Purchases')");
  for (let d = 1; d <= 9; d++) ledger.createTransaction(db, { date: '2025-03-0' + d, type: 'P', amount_cents: 1000, account_code: '240', payee_name: 'TRADE HARDWARE' });
  for (let d = 10; d <= 22; d++) ledger.createTransaction(db, { date: '2026-03-' + d, type: 'P', amount_cents: 1000, account_code: '270', payee_name: 'TRADE HARDWARE' });
  assert.equal(bestMatch(buildHistory(db), { description: 'TRADE HARDWARE 0031', detail: '', amount_cents: -4500 }).payee.account_code, '270');
});

test('a description that says nothing falls back on an amount that always goes to one place', () => {
  const db = fresh();
  db.exec("INSERT INTO accounts (code, main_code, description) VALUES ('380', '380', 'Office Rent')");
  const today = new Date();
  for (let m = 1; m <= 4; m++) { const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - m, 1)).toISOString().slice(0, 10); ledger.createTransaction(db, { date: d, type: 'P', amount_cents: 184000, account_code: '380', payee_name: 'HARBOUR PROPERTY TRUST' }); }
  const d = new Date().toLocaleDateString('en-CA');
  const nz = d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4);
  const p = preview(db, ['Date,Amount,Payee', nz + ',-1840.00,AP 0012345', nz + ',-77.00,AP 0099999'].join('\n'));
  assert.equal(p.lines[0].suggestion.account_code, '380');
  assert.match(p.lines[0].suggestion.from, /same amount/);
  assert.equal(p.lines[1].suggestion.account_code, null);
});

test('nothing already in the books is added again', () => {
  const db = fresh();
  // typed by hand nine days before the bank's date: too far to be assumed the same, close enough to ask
  const typed = ledger.createTransaction(db, { date: '2026-06-22', type: 'P', amount_cents: 5750, account_code: '270', payee_name: 'HILLTOP FUEL' });
  const csv = ['Date,Amount,Payee', '01/07/2026,-57.50,HILLTOP FUEL STOP'].join('\n');
  const p = preview(db, csv);
  assert.equal(p.lines[0].status, 'new');
  assert.equal(p.lines[0].possible.id, typed.id);
  assert.equal(p.counts.possible, 1);
  const line = { ...p.lines[0], bank_date: p.lines[0].date, payee_name: 'HILLTOP FUEL', account_code: '270' };

  // the server refuses it even if the screen sends it as new
  assert.throws(() => commit(db, { add: [line] }), /already have bk26.06-01 for the same amount/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 1);

  // "it is the same entry": ticked off, nothing added, and the file is clean next time
  assert.deepEqual(commit(db, { matched: [{ fp: line.fp, transaction_id: typed.id }] }), { added: 0, ticked: 1 });
  assert.equal(preview(db, csv).lines[0].status, 'done');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 1);
});

test('two identical payments on the statement and one in the books: one is new, and can be added on purpose', () => {
  const db = fresh();
  const typed = ledger.createTransaction(db, { date: '2026-07-01', type: 'P', amount_cents: 5750, account_code: '270', payee_name: 'HILLTOP FUEL' });
  const p = preview(db, ['Date,Amount,Payee', '01/07/2026,-57.50,HILLTOP FUEL STOP', '01/07/2026,-57.50,HILLTOP FUEL STOP'].join('\n'));
  assert.deepEqual(p.lines.map(l => l.status), ['matched', 'new']);
  assert.equal(p.lines[1].possible, undefined);
  const r = commit(db, { matched: [{ fp: p.lines[0].fp, transaction_id: typed.id }], add: [{ ...p.lines[1], bank_date: p.lines[1].date, payee_name: 'HILLTOP FUEL', account_code: '270' }] });
  assert.deepEqual(r, { added: 1, ticked: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 2);
});

test('a separate transaction of the same amount can be added once it is confirmed', () => {
  const db = fresh();
  ledger.createTransaction(db, { date: '2026-06-22', type: 'P', amount_cents: 5750, account_code: '270', payee_name: 'HILLTOP FUEL' });
  const p = preview(db, ['Date,Amount,Payee', '01/07/2026,-57.50,HILLTOP FUEL STOP'].join('\n'));
  const r = commit(db, { add: [{ ...p.lines[0], bank_date: p.lines[0].date, payee_name: 'HILLTOP FUEL', account_code: '270', allow_duplicate: true }] });
  assert.equal(r.added, 1);
});
