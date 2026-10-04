// Builds a made-up set of accounts for trying the app and for screenshots: no real data.
//   npm run demo            writes ../../accounts-data/demo.sqlite
// Start the app on it with:  set ACCOUNTS_DB=<that file>  then  npm start
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, defaultDbPath, inTransaction } from './db.js';
import { bankBalance, nextReference } from './ledger.js';
import { gstInside, addDays, todayIso } from '../shared/money.js';

export function seedDemo(db, { today = todayIso(), months = 14, plantProblems = true } = {}) {
  // Small repeatable random number generator, so the demo is the same every time.
  let seed = 20261004;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const between = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * 100);

  const accounts = [
    ['230', 'Sales', '', 0], ['196', 'Interest Received', '', 1], ['240', 'Purchases', '', 0],
    ['270', 'Vehicle', 'Fuel', 0], ['275', 'Vehicle', 'Maintenance', 0], ['380', 'Office Rent', '', 0],
    ['404', 'Computer Expenses', '', 0], ['415', 'Printing and Stationery', '', 0], ['418', 'Telephones', '', 0],
    ['420', 'Insurance', '', 0], ['424', 'Bank Charges', '', 1], ['232', 'Wages', '', 1], ['476', 'Tax', 'PAYE', 1], ['950', 'Directors', 'Drawings', 1]
  ];
  const payees = [
    ['FUEL', 'HILLTOP FUEL STOP', '270'], ['TYRE', 'RIVERSIDE TYRES & SERVICE', '275'], ['RENT', 'HARBOUR PROPERTY TRUST', '380'],
    ['NET', 'KIWILINK BROADBAND', '418'], ['MOB', 'SOUTHERN MOBILE', '418'], ['STAT', 'PAPER & INK LTD', '415'],
    ['SOFT', 'CLOUDLEDGER SOFTWARE', '404'], ['INS', 'TASMAN INSURANCE', '420'], ['BANK', 'BANK FEE', '424'],
    ['WAGE', 'WAGES', '232'], ['PAYE', 'INLAND REVENUE PAYE', '476'], ['DRAW', 'DIRECTOR DRAWINGS', '950'], ['HARD', 'TRADE HARDWARE', '240']
  ];
  const clients = ['NORTHFIELD DISTRICT COUNCIL', 'BAYVIEW CONTRACTING LTD', 'ALPINE ROADING GROUP', 'COASTAL CIVIL LTD'];

  inTransaction(db, () => {
    for (const t of ['transactions', 'accounts', 'payees', 'gst_rates', 'checkpoints', 'changes']) db.exec(`DELETE FROM ${t}`);
    const insA = db.prepare('INSERT INTO accounts (code, main_code, description, sub_description, gst_exempt) VALUES (?, ?, ?, ?, ?)');
    for (const a of accounts) insA.run(a[0], a[0], a[1], a[2], a[3]);
    const insP = db.prepare('INSERT INTO payees (code, name, account_code) VALUES (?, ?, ?)');
    for (const p of payees) insP.run(...p);
    db.prepare("INSERT INTO gst_rates (start_date, end_date, rate_bp) VALUES ('1989-07-01', '2010-09-30', 1250), ('2010-10-01', NULL, 1500)").run();
    const setS = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    setS.run('bank_account', 'Demo Cheque Account');
    setS.run('opening_balance_cents', '1250000');
    setS.run('locked_to', '');

    const exempt = new Map(accounts.map(a => [a[0], a[3]]));
    const ins = db.prepare(`INSERT INTO transactions (reference, date, type, amount_cents, gst_cents, payee_code, payee_name, account_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const add = (date, type, amount, code, name, account, ref) => {
      const now = date + 'T09:00:00.000Z';
      const reference = ref || nextReference(db, date);
      ins.run(reference, date, type, amount, exempt.get(account) ? 0 : gstInside(amount, 1500), code, name, account, now, now);
    };
    const insC = db.prepare('INSERT INTO checkpoints (date, balance_cents, note) VALUES (?, ?, ?)');

    const start = new Date(today + 'T00:00:00Z');
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - months);
    for (let m = 0; m <= months; m++) {
      const first = new Date(start); first.setUTCMonth(start.getUTCMonth() + m);
      const y = first.getUTCFullYear(), mo = first.getUTCMonth();
      const days = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      const day = d => new Date(Date.UTC(y, mo, Math.min(d, days))).toISOString().slice(0, 10);
      const entries = [];
      entries.push([1, 'P', 184000, 'RENT', 'HARBOUR PROPERTY TRUST', '380']);
      entries.push([5, 'P', between(70, 95), 'NET', 'KIWILINK BROADBAND', '418']);
      entries.push([12, 'P', between(55, 140), 'MOB', 'SOUTHERN MOBILE', '418']);
      entries.push([15, 'P', 420000, 'WAGE', 'WAGES', '232']);
      entries.push([20, 'P', 96500, 'PAYE', 'INLAND REVENUE PAYE', '476']);
      entries.push([days, 'P', 1250, 'BANK', 'BANK FEE', '424']);
      entries.push([days, 'R', between(2, 30), null, 'INTEREST', '196']);
      entries.push([25, 'P', 300000, 'DRAW', 'DIRECTOR DRAWINGS', '950']);
      for (let i = 0; i < 6; i++) entries.push([1 + Math.floor(rnd() * days), 'P', between(60, 190), 'FUEL', 'HILLTOP FUEL STOP', '270']);
      for (let i = 0; i < 4; i++) { const p = pick(payees.filter(x => ['TYRE', 'STAT', 'SOFT', 'HARD', 'INS'].includes(x[0]))); entries.push([1 + Math.floor(rnd() * days), 'P', between(25, 900), p[0], p[1], p[2]]); }
      for (let i = 0; i < 3; i++) entries.push([3 + Math.floor(rnd() * (days - 3)), 'R', between(2500, 9500), null, pick(clients), '230']);
      entries.sort((a, b) => a[0] - b[0]);
      for (const e of entries) { const d = day(e[0]); if (d <= today) add(d, e[1], e[2], e[3], e[4], e[5]); }
      // A statement balance at each month end that has passed.
      if (day(days) < today) insC.run(day(days), bankBalance(db, day(days)), 'Month-end statement');
    }

    if (plantProblems) {
      // Three slips after the last statement that agreed, the kind the problem finder is for:
      const cps = db.prepare('SELECT * FROM checkpoints ORDER BY date DESC LIMIT 2').all();
      if (cps.length === 2) {
        const [last, prev] = cps;
        const rows = db.prepare("SELECT * FROM transactions WHERE date > ? AND date <= ? AND account_code = '270' ORDER BY id").all(prev.date, last.date);
        if (rows.length) {
          // 1. digits swapped in a fuel payment (statement says the true amount)
          const t = rows[0];
          const s = String(t.amount_cents);
          const i = [...s].findIndex((c, k) => k < s.length - 1 && c !== s[k + 1]);
          const swapped = Number(s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2));
          db.prepare('UPDATE transactions SET amount_cents = ?, gst_cents = ? WHERE id = ?').run(swapped, gstInside(swapped, 1500), t.id);
        }
      }
      // 2. an entry made twice, and 3. a reference from the wrong month - both after the last statement, so
      //    they show up in the sweep without disturbing a statement balance.
      if (cps.length) {
        const recent = db.prepare('SELECT * FROM transactions WHERE date > ? ORDER BY date, id LIMIT 1').get(cps[0].date);
        if (recent) add(recent.date, recent.type, recent.amount_cents, recent.payee_code, recent.payee_name, recent.account_code);
        const next = addDays(cps[0].date, 1);
        if (next <= today) add(next, 'P', 4830, 'STAT', 'PAPER & INK LTD', '415', nextReference(db, cps[0].date));
      }
    }
  });
  return db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] || path.join(path.dirname(defaultDbPath()), 'demo.sqlite');
  if (path.resolve(file) === path.resolve(defaultDbPath()) && !process.env.ACCOUNTS_DB) { console.error('Refusing to write demo data over the real accounts.'); process.exit(1); }
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(file + ext, { force: true });
  const db = openDb(file);
  console.log(`${seedDemo(db)} demo transactions written to ${file}`);
  // A matching bank statement to try the import with: this month's entries as the bank would show them,
  // plus two lines the books do not have yet.
  const month = todayIso().slice(0, 7);
  const rows = db.prepare("SELECT * FROM transactions WHERE date LIKE ? ORDER BY date, id").all(month + '%');
  let balance = bankBalance(db, addDays(month + '-01', -1));
  const nz = d => d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4);
  // The entry planted twice in the books went through the bank once.
  const once = new Set();
  const lines = rows.filter(t => { const k = `${t.date}|${t.type}|${t.amount_cents}|${t.payee_name}`; if (once.has(k)) return false; once.add(k); return true; }).map(t => ({ date: t.date, amount: t.type === 'R' ? t.amount_cents : -t.amount_cents, payee: t.payee_name, particulars: t.type === 'R' ? 'DIRECT CREDIT' : 'EFTPOS 4421' }));
  lines.push({ date: todayIso(), amount: -8990, payee: 'KIWILINK BROADBAND', particulars: 'DIRECT DEBIT' }, { date: todayIso(), amount: -1500, payee: 'CITY PARKING', particulars: 'CARD 4421' });
  const csv = ['Date,Amount,Payee,Particulars,Balance'].concat(lines.map(l => { balance += l.amount; return [nz(l.date), (l.amount / 100).toFixed(2), l.payee, l.particulars, (balance / 100).toFixed(2)].join(','); })).join('\r\n') + '\r\n';
  const csvFile = path.join(path.dirname(file), 'demo-statement.csv');
  fs.writeFileSync(csvFile, csv);
  console.log(`Demo bank statement written to ${csvFile}`);
}
