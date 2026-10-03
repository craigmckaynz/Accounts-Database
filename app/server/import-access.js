// Brings the data across from the Access database: ledger codes, quick codes, GST rates, opening balance and
// every transaction. It reads the .accdb file directly (no Access needed) and never writes to it.
//
//   npm run import -- "C:\path\to\copy of accounts.accdb"            first import into an empty database
//   npm run import -- "C:\path\to\copy.accdb" --replace               replace what is there (a backup is taken)
//
// It prints counts and whether the figures agree with Access; amounts are shown only with --show.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MDBReader from 'mdb-reader';
import { openDb, defaultDbPath, inTransaction } from './db.js';
import { bankBalance } from './ledger.js';
import { fromCents } from '../shared/money.js';

// Access Currency / Decimal values arrive as text ("1234.5000") or numbers; convert without floating point.
export function scaled(v, places) {
  if (v === null || v === undefined || v === '') return null;
  let s = typeof v === 'number' ? v.toFixed(6) : String(v).trim();
  const neg = s.startsWith('-');
  s = s.replace('-', '');
  const [whole, frac = ''] = s.split('.');
  const digits = (frac + '0'.repeat(places + 1)).slice(0, places + 1);       // one extra digit to round on
  let n = BigInt(whole || '0') * 10n ** BigInt(places) + BigInt(digits.slice(0, places) || '0');
  if (Number(digits[places]) >= 5) n += 1n;
  return Number(neg ? -n : n);
}

// Access dates carry no time zone. mdb-reader hands them over as UTC dates.
const iso = d => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null);
const text = v => (v === null || v === undefined ? '' : String(v).trim());

export function importAccess(accdbPath, db) {
  const reader = new MDBReader(fs.readFileSync(accdbPath));
  const table = name => reader.getTable(name).getData();
  const report = { warnings: [] };

  inTransaction(db, () => {
    for (const t of ['transactions', 'accounts', 'payees', 'gst_rates', 'changes']) db.exec(`DELETE FROM ${t}`);

    const insA = db.prepare('INSERT INTO accounts (code, main_code, description, sub_description, gst_exempt) VALUES (?, ?, ?, ?, ?)');
    let n = 0;
    for (const r of table('ledger_accounts')) {
      const code = text(r.account_code);
      if (!code || code === '*') continue;                 // "*" was only a report-picker entry
      insA.run(code, text(r.main_code), text(r.Description), text(r.sub_code_description), r.GST_exempt ? 1 : 0);
      n++;
    }
    report.accounts = n;

    const known = new Set(db.prepare('SELECT code FROM accounts').all().map(a => a.code));
    const insP = db.prepare('INSERT OR REPLACE INTO payees (code, name, account_code) VALUES (?, ?, ?)');
    n = 0;
    for (const r of table('quick_codes')) {
      const code = text(r.Payee_Code).toUpperCase();
      if (!code) continue;
      const acc = text(r.Auto_Code);
      insP.run(code, text(r.Payee_Name), known.has(acc) ? acc : null);
      n++;
    }
    report.payees = n;

    const insG = db.prepare('INSERT INTO gst_rates (start_date, end_date, rate_bp) VALUES (?, ?, ?)');
    const rates = table('GST_Rates').map(r => ({ start: iso(r.GSTStartDate), end: iso(r.GSTEndDate), bp: scaled(r.GSTRate, 4) })).filter(r => r.start).sort((a, b) => a.start.localeCompare(b.start));
    rates.forEach((r, i) => insG.run(r.start, i === rates.length - 1 ? null : r.end, r.bp));   // the current rate is open-ended
    report.gst_rates = rates.length;

    const ob = table('opening_balance')[0] || {};
    const setS = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    setS.run('opening_balance_cents', String(scaled(ob.opening_balance, 2) ?? 0));
    if (text(ob.bank_account)) setS.run('bank_account', text(ob.bank_account));

    const insT = db.prepare(`INSERT INTO transactions (id, reference, date, type, amount_cents, gst_cents, payee_code, payee_name, account_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const now = new Date().toISOString();
    let accessGross = 0, locked = 0, count = 0, signFixed = 0, fraction = 0;
    // A row without an Access id is given a new one, after the rest so it cannot take another row's number.
    const source = table('transactions').sort((a, b) => (a.transaction_id === null) - (b.transaction_id === null));
    const noId = source.filter(r => r.transaction_id === null).length;
    if (noId) report.warnings.push(`${noId} transactions had no id in Access and were given new ones.`);
    for (const r of source) {
      const type = text(r.Payment_receipt).toLowerCase().startsWith('r') ? 'R' : 'P';
      const total4 = scaled(r.transaction_total, 4);
      const gross = scaled(r.Gross_Total, 2);
      const amount = total4 === null ? null : Math.abs(scaled(r.transaction_total, 2));
      if (total4 !== null && total4 % 100 !== 0) fraction++;
      if (gross !== null) accessGross += gross;
      // The bank balance in Access is the sum of Gross_Total; an entry whose gross disagrees with its total is reported.
      if (gross !== null && amount !== null && gross !== (type === 'R' ? amount : -amount)) signFixed++;
      if (r.accounts_locked) locked++;
      insT.run(r.transaction_id, text(r.transaction_reference), iso(r.transaction_date), type, amount,
        Math.abs(scaled(r.GST_Total, 2) ?? 0), text(r.Payee_Code) || null, text(r.Payee_Name), text(r.Account_Code) || null, now, now);
      count++;
    }
    report.transactions = count;
    report.access_balance_cents = accessGross + (scaled(ob.opening_balance, 2) ?? 0);
    if (signFixed) report.warnings.push(`${signFixed} transactions have a gross total in Access that disagrees with their total and type.`);
    if (fraction) report.warnings.push(`${fraction} transactions have fractions of a cent in their total; they were rounded.`);
    if (locked) report.warnings.push(`${locked} transactions were locked in Access. Set "Locked up to" under Setup to lock a period here.`);
  });

  report.balance_cents = bankBalance(db);
  report.balance_matches = report.balance_cents === report.access_balance_cents;
  const span = db.prepare('SELECT MIN(date) AS a, MAX(date) AS b FROM transactions').get();
  report.first_date = span.a; report.last_date = span.b;
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const src = args.find(a => !a.startsWith('--'));
  if (!src || !fs.existsSync(src)) { console.error('Give the path of a COPY of the Access database.\n  npm run import -- "C:\\claude\\accounts-work\\accounts-copy.accdb"'); process.exit(1); }
  const file = defaultDbPath();
  const db = openDb(file);
  const existing = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
  if (existing && !args.includes('--replace')) { console.error(`The database already holds ${existing} transactions. Add --replace to overwrite them (a backup is taken first).`); process.exit(1); }
  if (existing) {
    const dir = path.join(path.dirname(file), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `before-import-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    console.log(`Backup of the existing data: ${target}`);
  }
  const r = importAccess(src, db);
  console.log(`Imported into ${file}`);
  console.log(`  ledger codes ${r.accounts}, quick codes ${r.payees}, GST rates ${r.gst_rates}, transactions ${r.transactions}`);
  console.log(`  transactions run from ${r.first_date} to ${r.last_date}`);
  console.log(`  bank balance agrees with Access: ${r.balance_matches ? 'YES' : 'NO'}`);
  if (args.includes('--show')) console.log(`  bank balance ${fromCents(r.balance_cents)} (Access ${fromCents(r.access_balance_cents)})`);
  for (const w of r.warnings) console.log('  note: ' + w);
  if (!r.balance_matches) process.exit(2);
}
