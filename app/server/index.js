// The web server: a JSON API over the cashbook plus the built browser app.
// It listens on this computer only (127.0.0.1); there is no login.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, defaultDbPath, sharedDataDir, getSettings, dailyBackup, inTransaction } from './db.js';
import { claim, stopWhenIdle, InUseError } from './shared.js';
import * as ledger from './ledger.js';
import { UserError } from './ledger.js';
import { findProblems } from './problems.js';
import { ledgerReport, gstSummary, periodBalances } from './reports.js';
import * as bank from './bank.js';
import { isIsoDate, todayIso } from '../shared/money.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// `idle` (shared installations only) is told about every request and about the window closing, so the server
// can stop and hand the accounts back when nobody is using them.
export function createApp(db, { idle = null } = {}) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api', (req, res, next) => { if (idle && req.path !== '/closing') idle.seen(); next(); });
  app.get('/api/ping', (req, res) => res.json({ ok: true, shared: Boolean(idle) }));
  app.post('/api/closing', (req, res) => { if (idle) idle.closing(); res.json({ ok: true }); });
  const need = (cond, msg, field) => { if (!cond) throw new UserError(msg, field); };
  const dates = q => { need(isIsoDate(q.from) && isIsoDate(q.to) && q.from <= q.to, 'Choose a valid date range.'); return { from: q.from, to: q.to }; };

  app.get('/api/meta', (req, res) => {
    const last = db.prepare('SELECT MAX(date) AS d, COUNT(*) AS n FROM transactions').get();
    res.json({
      settings: getSettings(db),
      accounts: db.prepare('SELECT * FROM accounts ORDER BY code').all(),
      payees: db.prepare('SELECT * FROM payees ORDER BY code').all(),
      gst_rates: ledger.gstRates(db),
      balance_cents: ledger.bankBalance(db),
      last_date: last.d, count: last.n, today: todayIso()
    });
  });

  // ---- transactions
  app.get('/api/transactions', (req, res) => {
    const { from, to, q, account } = req.query;
    const limit = Math.min(Math.max(Number(req.query.limit) || 2000, 1), 200000);
    res.json(ledger.listTransactions(db, { from: isIsoDate(from) ? from : null, to: isIsoDate(to) ? to : null, q: q ? String(q).trim() : null, account: account || null, limit }));
  });
  app.get('/api/next-reference', (req, res) => res.json({ reference: ledger.nextReference(db, req.query.date) }));
  app.post('/api/transactions', (req, res) => res.json(ledger.createTransaction(db, req.body)));
  app.put('/api/transactions/:id', (req, res) => res.json(ledger.updateTransaction(db, Number(req.params.id), req.body)));
  app.delete('/api/transactions/:id', (req, res) => {
    const row = ledger.deleteTransaction(db, Number(req.params.id));
    res.json({ deleted: row, change_id: ledger.lastDeleteChangeId(db, row.id) });
  });
  app.post('/api/restore/:changeId', (req, res) => res.json(ledger.restoreTransaction(db, Number(req.params.changeId))));

  // ---- problem finder and statement balances
  app.get('/api/problems', (req, res) => res.json(findProblems(db, { since: isIsoDate(req.query.since) ? req.query.since : null })));
  app.post('/api/checkpoints', (req, res) => {
    const { date, balance_cents, note = '' } = req.body;
    need(isIsoDate(date), 'Enter the statement date.', 'date');
    need(Number.isInteger(balance_cents), 'Enter the balance shown on the statement.', 'balance_cents');
    db.prepare('INSERT INTO checkpoints (date, balance_cents, note) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET balance_cents = excluded.balance_cents, note = excluded.note').run(date, balance_cents, String(note));
    res.json({ ok: true });
  });
  app.delete('/api/checkpoints/:id', (req, res) => { db.prepare('DELETE FROM checkpoints WHERE id = ?').run(Number(req.params.id)); res.json({ ok: true }); });

  // ---- bank statement import
  app.post('/api/bank/preview', (req, res) => {
    need(typeof req.body.text === 'string' && req.body.text.trim(), 'Choose the CSV file exported from internet banking.');
    res.json(bank.preview(db, req.body.text, req.body.mapping || null));
  });
  app.post('/api/bank/import', (req, res) => res.json(bank.commit(db, req.body)));
  // The import in progress: kept so the screen can be closed and resumed.
  app.get('/api/bank/session', (req, res) => res.json(bank.getSession(db)));
  app.put('/api/bank/session', (req, res) => res.json(bank.startSession(db, req.body)));
  app.put('/api/bank/session/edits', (req, res) => res.json(bank.saveSessionEdits(db, req.body)));
  app.delete('/api/bank/session', (req, res) => res.json(bank.endSession(db)));

  // ---- reports
  app.get('/api/reports/ledger', (req, res) => {
    const d = dates(req.query);
    const codes = req.query.codes ? String(req.query.codes).split(',').filter(Boolean) : [];
    res.json({ ...ledgerReport(db, { ...d, codes, detail: req.query.detail !== '0' }), balances: periodBalances(db, d) });
  });
  app.get('/api/reports/gst', (req, res) => { const d = dates(req.query); res.json({ ...gstSummary(db, d), balances: periodBalances(db, d) }); });

  // ---- setup
  app.put('/api/settings', (req, res) => {
    const allowed = ['bank_account', 'opening_balance_cents', 'locked_to', 'year_start_month', 'bank_prefix'];
    const b = req.body;
    if ('opening_balance_cents' in b) need(Number.isInteger(b.opening_balance_cents), 'Enter the opening balance.', 'opening_balance_cents');
    if ('locked_to' in b) need(b.locked_to === '' || isIsoDate(b.locked_to), 'Enter a valid lock date.', 'locked_to');
    if ('year_start_month' in b) need(Number(b.year_start_month) >= 1 && Number(b.year_start_month) <= 12, 'Month must be 1 to 12.', 'year_start_month');
    if ('bank_prefix' in b) need(/^[a-z]{1,4}$/i.test(b.bank_prefix), 'The reference prefix is one to four letters.', 'bank_prefix');
    const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    inTransaction(db, () => { for (const k of allowed) if (k in b) set.run(k, String(b[k])); });
    res.json(getSettings(db));
  });

  app.put('/api/accounts/:code', (req, res) => {
    const code = req.params.code.trim();
    const { main_code = '', description = '', sub_description = '', gst_exempt = 0, active = 1 } = req.body;
    need(code && code !== '*', 'Enter a ledger code.', 'code');
    need(String(description).trim(), 'Enter a description.', 'description');
    db.prepare(`INSERT INTO accounts (code, main_code, description, sub_description, gst_exempt, active) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET main_code = excluded.main_code, description = excluded.description, sub_description = excluded.sub_description, gst_exempt = excluded.gst_exempt, active = excluded.active`)
      .run(code, String(main_code || code), String(description).trim(), String(sub_description).trim(), gst_exempt ? 1 : 0, active ? 1 : 0);
    res.json({ ok: true });
  });
  app.delete('/api/accounts/:code', (req, res) => {
    const used = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_code = ?').get(req.params.code).n;
    need(!used, `This code is used by ${used} transactions, so it cannot be deleted. Untick Active to retire it instead.`);
    db.prepare('DELETE FROM accounts WHERE code = ?').run(req.params.code);
    db.prepare('UPDATE payees SET account_code = NULL WHERE account_code = ?').run(req.params.code);
    res.json({ ok: true });
  });

  app.put('/api/payees/:code', (req, res) => {
    const code = req.params.code.trim().toUpperCase();
    const { name = '', account_code = null } = req.body;
    need(/^[A-Z0-9]{1,6}$/.test(code), 'A quick code is one to six letters or digits.', 'code');
    need(String(name).trim(), 'Enter the payee name.', 'name');
    need(!account_code || db.prepare('SELECT 1 FROM accounts WHERE code = ?').get(account_code), 'That ledger code does not exist.', 'account_code');
    db.prepare('INSERT INTO payees (code, name, account_code) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name, account_code = excluded.account_code')
      .run(code, String(name).trim(), account_code || null);
    res.json({ ok: true });
  });
  app.delete('/api/payees/:code', (req, res) => { db.prepare('DELETE FROM payees WHERE code = ?').run(req.params.code); res.json({ ok: true }); });

  app.put('/api/gst-rates', (req, res) => {
    const rows = req.body;
    need(Array.isArray(rows) && rows.length, 'At least one GST rate is needed.');
    for (const r of rows) {
      need(isIsoDate(r.start_date), 'Each rate needs a start date.');
      need(!r.end_date || (isIsoDate(r.end_date) && r.end_date >= r.start_date), 'An end date must be after its start date.');
      need(Number.isInteger(r.rate_bp) && r.rate_bp >= 0 && r.rate_bp < 10000, 'Enter the rate as a percentage, e.g. 15.');
    }
    const sorted = rows.slice().sort((a, b) => a.start_date.localeCompare(b.start_date));
    for (let i = 1; i < sorted.length; i++) need(sorted[i - 1].end_date && sorted[i - 1].end_date < sorted[i].start_date, 'GST rate periods overlap. Each must end before the next starts.');
    inTransaction(db, () => {
      db.exec('DELETE FROM gst_rates');
      const ins = db.prepare('INSERT INTO gst_rates (start_date, end_date, rate_bp) VALUES (?, ?, ?)');
      for (const r of sorted) ins.run(r.start_date, r.end_date || null, r.rate_bp);
    });
    res.json(ledger.gstRates(db));
  });

  // ---- the browser app
  const dist = path.resolve(here, '..', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((err, req, res, next) => {
    if (err instanceof UserError) return res.status(400).json({ error: err.message, field: err.field || null });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. Nothing was saved.' });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // node server/index.js [--db <file>] [--port <n>]
  const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  const file = arg('--db') ? path.resolve(arg('--db')) : defaultDbPath();
  // Never start on an empty set of books by accident. If the accounts file is not where it should be (the
  // folder was moved, the network drive is not connected), say so and stop; a new one is made only on request.
  if (!fs.existsSync(file) && !process.argv.includes('--create')) {
    console.error(`NO DATA: The accounts were not found at ${file}. Nothing was opened. If the accounts are on the network drive, check it is connected.`);
    process.exit(4);
  }
  // Run from the shared company folder: one person at a time, and stop when the window is closed.
  const sharedDir = !arg('--db') && !process.env.ACCOUNTS_DB ? sharedDataDir() : null;
  let lock = null;
  if (sharedDir) {
    try { lock = claim(sharedDir); }
    catch (e) { console.error(e instanceof InUseError ? 'IN USE: ' + e.message : e.message); process.exit(e instanceof InUseError ? 3 : 1); }
  }
  const db = openDb(file, { shared: Boolean(sharedDir) });
  const backup = dailyBackup(db, file);
  const port = Number(arg('--port') || process.env.PORT || 4310);
  const stop = () => { try { db.close(); } catch { /* already closed */ } if (lock) lock.release(); process.exit(0); };
  const idle = sharedDir ? stopWhenIdle({ onStop: () => { console.log('Nobody is using the accounts: stopping.'); stop(); } }) : null;
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', () => { if (lock) lock.release(); });
  createApp(db, { idle }).listen(port, '127.0.0.1', () => {
    console.log(`McKay Accounts running at http://localhost:${port}`);
    console.log(`Data: ${file}${sharedDir ? ' (shared folder, one person at a time)' : ''}${backup ? `\nBackup taken: ${backup}` : ''}`);
  });
}
