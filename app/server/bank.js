// Bank statement import. Reads the CSV a bank's internet banking exports, lines it up against the books,
// and adds the lines that are missing as transactions.
//
// Banks disagree about column names, order and date formats, so the columns are worked out from the header
// row (or from the data when there is none) and can be overridden from the screen.
import { inTransaction } from './db.js';
import { createTransaction, bankBalance, nextReference, UserError } from './ledger.js';
import { isIsoDate, addDays, todayIso } from '../shared/money.js';

// ---- reading the file --------------------------------------------------------------------------------

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const s = text.replace(/^﻿/, '');
  const delim = (s.split('\n', 1)[0].match(/;/g) || []).length > (s.split('\n', 1)[0].match(/,/g) || []).length ? ';' : (s.split('\n', 1)[0].includes('\t') && !s.split('\n', 1)[0].includes(',') ? '\t' : ',');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x.trim() !== '')) rows.push(row.map(x => x.trim()));
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim() !== '')) rows.push(row.map(x => x.trim()));
  return rows;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// New Zealand bank dates: day first. Returns 'YYYY-MM-DD' or null.
export function parseDate(v) {
  const s = String(v || '').trim();
  let y, m, d, r;
  if ((r = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) [, y, m, d] = r;
  else if ((r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s))) [, d, m, y] = r;
  else if ((r = /^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{2}|\d{4})$/.exec(s))) { d = r[1]; m = MONTHS[r[2].toLowerCase()]; y = r[3]; }
  else if ((r = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) [, y, m, d] = r;
  else return null;
  if (!m) return null;
  if (String(y).length === 2) y = Number(y) + (Number(y) > 70 ? 1900 : 2000);
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

// "1,234.50", "-12.5", "(45.00)", "45.00 DR" -> signed cents, or null.
export function parseAmount(v) {
  let s = String(v ?? '').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/\bDR$/i.test(s)) { neg = true; s = s.replace(/\s*DR$/i, ''); }
  s = s.replace(/\s*CR$/i, '').replace(/[$,\s]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d*(\.\d{1,2})?$/.test(s) || s === '' || s === '.') return null;
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole || 0) * 100 + Number((frac + '00').slice(0, 2));
  return neg ? -cents : cents;
}

const ROLE_PATTERNS = [
  ['date', /^(transaction ?date|date|tran date|date of transaction)$/i, /date/i],
  ['debit', /^(debit|debits|withdrawal|withdrawals|money out|paid out|debit amount)$/i, null],
  ['credit', /^(credit|credits|deposit|deposits|money in|paid in|credit amount)$/i, null],
  ['amount', /^(amount|amount \(nzd\)|value|transaction amount)$/i, /amount/i],
  ['balance', /^(balance|running balance|closing balance|account balance)$/i, /balance/i],
  ['payee', /^(payee|other party|other party name|description|details|transaction details|memo\/description|narrative)$/i, null]
];
const DETAIL = /^(particulars|code|reference|memo|analysis code|tran type|transaction type|type|details|description|other party account)$/i;

// Works out which column is which. Returns { headerRow, columns: [names], mapping: { date, amount, debit, credit, balance, payee, details: [] } }.
export function detectColumns(rows) {
  let headerRow = -1;
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    if (rows[i].some(c => /date/i.test(c)) && !rows[i].some(c => parseDate(c))) { headerRow = i; break; }
  }
  // A first row of plain words above rows of data is a header too, whatever it calls its columns.
  if (headerRow < 0 && rows.length > 1 && rows[0].every(c => !parseDate(c) && (c === '' || parseAmount(c) === null))) headerRow = 0;
  const width = Math.max(...rows.map(r => r.length));
  const mapping = { date: -1, amount: -1, debit: -1, credit: -1, balance: -1, payee: -1, details: [] };
  let columns;
  if (headerRow >= 0) {
    columns = rows[headerRow];
    for (const strict of [true, false]) {
      for (const [role, exact, loose] of ROLE_PATTERNS) {
        if (mapping[role] >= 0) continue;
        const re = strict ? exact : loose;
        if (!re) continue;
        const i = columns.findIndex((c, k) => re.test(c) && !Object.values(mapping).includes(k));
        if (i >= 0) mapping[role] = i;
      }
    }
    columns.forEach((c, k) => { if (DETAIL.test(c) && k !== mapping.payee) mapping.details.push(k); });
  } else {
    // No header: judge each column by what it holds.
    columns = Array.from({ length: width }, (_, k) => `Column ${k + 1}`);
    const sample = rows.slice(0, 50);
    const share = (k, fn) => sample.filter(r => fn(r[k])).length / sample.length;
    for (let k = 0; k < width; k++) {
      if (mapping.date < 0 && share(k, parseDate) > 0.8) { mapping.date = k; continue; }
      const numeric = share(k, v => /\d/.test(v || '') && parseAmount(v) !== null && !parseDate(v)) > 0.8;
      if (numeric && mapping.amount < 0) mapping.amount = k;
      else if (numeric && mapping.balance < 0) mapping.balance = k;
      else if (!numeric && share(k, v => /[A-Za-z]{3}/.test(v || '')) > 0.5) { if (mapping.payee < 0) mapping.payee = k; else mapping.details.push(k); }
    }
  }
  return { headerRow, columns, mapping };
}

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
// What a description boils down to for remembering which ledger code it goes to: letters only, no card or
// reference numbers, so "COUNTDOWN 4421 12/07" and "COUNTDOWN 4421 19/07" are the same payee.
export const matchKey = s => clean(s).toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();

// The statement lines, oldest first: { n, date, amount_cents (payments negative), description, detail, balance_cents, fp }.
export function statementLines(rows, { headerRow, mapping }) {
  if (mapping.date < 0) throw new UserError('Could not tell which column holds the date. Choose the columns below.');
  if (mapping.amount < 0 && mapping.debit < 0 && mapping.credit < 0) throw new UserError('Could not tell which column holds the amount. Choose the columns below.');
  const lines = [];
  const skipped = [];
  rows.forEach((r, i) => {
    if (i <= headerRow) return;
    const date = parseDate(r[mapping.date]);
    let amount = null;
    if (mapping.amount >= 0) amount = parseAmount(r[mapping.amount]);
    if (amount === null && (mapping.debit >= 0 || mapping.credit >= 0)) {
      const dr = mapping.debit >= 0 ? parseAmount(r[mapping.debit]) : null;
      const cr = mapping.credit >= 0 ? parseAmount(r[mapping.credit]) : null;
      if (dr) amount = -Math.abs(dr); else if (cr) amount = Math.abs(cr);
    }
    if (!date || amount === null || amount === 0) { skipped.push(i + 1); return; }
    const payee = mapping.payee >= 0 ? clean(r[mapping.payee]) : '';
    const detail = mapping.details.map(k => clean(r[k])).filter(Boolean).join(' ');
    lines.push({ date, amount_cents: amount, description: payee || detail, detail: payee ? detail : '', balance_cents: mapping.balance >= 0 ? parseAmount(r[mapping.balance]) : null });
  });
  // Banks export newest first as often as oldest first.
  if (lines.length > 1 && lines[0].date > lines[lines.length - 1].date) lines.reverse();
  else if (lines.length > 1 && lines[0].date === lines[lines.length - 1].date && lines[0].balance_cents !== null) {
    const forward = lines.every((l, i) => i === 0 || l.balance_cents === lines[i - 1].balance_cents + l.amount_cents);
    if (!forward) lines.reverse();
  }
  // A fingerprint per line so the same statement can be loaded twice without doubling up. Identical lines on
  // one day are told apart by their order.
  const seen = new Map();
  lines.forEach((l, n) => {
    const base = `${l.date}|${l.amount_cents}|${matchKey(l.description + ' ' + l.detail)}`;
    const k = (seen.get(base) || 0) + 1;
    seen.set(base, k);
    l.n = n;
    l.fp = `${base}|${k}`;
  });
  return { lines, skipped };
}

// An entry of the same amount within MATCH_DAYS of the bank's date is taken to be the same transaction and is
// ticked off rather than added. Anything further away is treated as a different transaction.
const MATCH_DAYS = 4;

// ---- lining the statement up against the books -------------------------------------------------------

const signedOf = t => (t.type === 'R' ? t.amount_cents : -t.amount_cents);

export function analyse(db, lines) {
  if (!lines.length) throw new UserError('No transactions were found in that file.');
  const first = lines[0].date, last = lines[lines.length - 1].date;
  const books = db.prepare('SELECT * FROM transactions WHERE date >= ? AND date <= ? ORDER BY date, id').all(addDays(first, -MATCH_DAYS - 1), addDays(last, MATCH_DAYS + 1));
  const byFp = new Map(books.filter(t => t.bank_ref).map(t => [t.bank_ref, t]));
  for (const t of db.prepare(`SELECT * FROM transactions WHERE bank_ref IN (${lines.map(() => '?').join(',')})`).all(...lines.map(l => l.fp))) byFp.set(t.bank_ref, t);
  const used = new Set();
  const out = lines.map(l => ({ ...l, status: 'new', transaction: null }));
  for (const l of out) {
    const t = byFp.get(l.fp);
    if (t) { l.status = 'done'; l.transaction = t; used.add(t.id); }
  }
  const free = books.filter(t => !t.bank_ref && t.amount_cents);
  // Same amount on the same day first, then the nearest day within four.
  for (const reach of [0, MATCH_DAYS]) {
    for (const l of out) {
      if (l.status !== 'new') continue;
      let best = null;
      for (const t of free) {
        if (used.has(t.id) || signedOf(t) !== l.amount_cents) continue;
        const gap = Math.abs((Date.parse(t.date) - Date.parse(l.date)) / 86400000);
        if (gap <= reach && (!best || gap < best.gap)) best = { t, gap };
      }
      if (best) { l.status = 'matched'; l.transaction = best.t; used.add(best.t.id); }
    }
  }
  // No ledger code or quick code is suggested: each new line is coded by the person checking it. The payee
  // starts as the bank's own wording.
  for (const l of out) if (l.status === 'new') l.payee_name = clean(l.description).toUpperCase().slice(0, 50);

  // Entries in the books for the statement's dates that the statement does not have.
  const bookOnly = books.filter(t => t.date >= first && t.date <= last && !used.has(t.id) && !t.bank_ref);

  const withBalance = out.filter(l => l.balance_cents !== null);
  let closing = null;
  if (withBalance.length) {
    const end = withBalance[withBalance.length - 1];
    const book = bankBalance(db, end.date);
    const toAdd = out.filter(l => l.status === 'new').reduce((s, l) => s + l.amount_cents, 0);
    closing = { date: end.date, balance_cents: end.balance_cents, book_cents: book, book_after_cents: book + toAdd };
  }
  // For a running balance down the statement: the books' balance before it starts, less entries dated
  // earlier that a statement line claims (they are counted at their line), and the other entries in the
  // statement's dates, which count on their own date.
  const usedEarly = books.filter(t => used.has(t.id) && t.date < first).reduce((s, t) => s + signedOf(t), 0);
  const running = {
    base_cents: bankBalance(db, addDays(first, -1)) - usedEarly,
    others: books.filter(t => t.date >= first && t.date <= last && !used.has(t.id) && t.amount_cents).map(t => ({ id: t.id, date: t.date, signed_cents: signedOf(t) }))
  };
  // The next free reference in each month the statement touches (and the months either side, in case a date
  // is edited across a month end), e.g. { "2026-10": "bk26/10-05" }. The preview numbers the new lines from these.
  const nextRefs = {};
  for (let d = new Date(first.slice(0, 7) + '-01T00:00:00Z'), i = -1; ; i++) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1)).toISOString().slice(0, 7);
    nextRefs[m] = nextReference(db, m + '-01');
    if (m > last.slice(0, 7)) break;
  }
  return {
    next_refs: nextRefs,
    from: first, to: last, lines: out, book_only: bookOnly, closing, running,
    counts: { total: out.length, done: out.filter(l => l.status === 'done').length, matched: out.filter(l => l.status === 'matched').length, fresh: out.filter(l => l.status === 'new').length, book_only: bookOnly.length }
  };
}

export function preview(db, text, mapping) {
  const rows = parseCsv(text);
  if (rows.length < 1) throw new UserError('That file is empty.');
  const detected = detectColumns(rows);
  if (mapping) detected.mapping = { ...detected.mapping, ...mapping, details: Array.isArray(mapping.details) ? mapping.details : detected.mapping.details };
  let parsed;
  try { parsed = statementLines(rows, detected); }
  catch (e) { if (e instanceof UserError) return { columns: detected.columns, mapping: detected.mapping, sample: rows.slice(detected.headerRow + 1, detected.headerRow + 4), needs_mapping: e.message }; throw e; }
  return { columns: detected.columns, mapping: detected.mapping, skipped: parsed.skipped, ...analyse(db, parsed.lines) };
}

// Adds the chosen statement lines as transactions, ticks off the ones already in the books, and records the
// statement's closing balance.
export function commit(db, { add = [], matched = [], checkpoint = null }) {
  return inTransaction(db, () => {
    const hasFp = db.prepare('SELECT 1 FROM transactions WHERE bank_ref = ?');
    const stamp = db.prepare('UPDATE transactions SET bank_ref = ? WHERE id = ? AND bank_ref IS NULL');
    let added = 0, ticked = 0;
    // Tick off first, so the entries they claim cannot also be mistaken for duplicates of the new lines.
    for (const m of matched) if (m.fp && m.transaction_id) ticked += Number(stamp.run(m.fp, m.transaction_id).changes);
    // A last check against doubling up if the books changed after the preview was drawn: an entry of the same
    // amount within the matching window that no statement line has claimed. A split line is exempt (its parts
    // are not the bank's amount).
    const twin = db.prepare('SELECT reference, date FROM transactions WHERE bank_ref IS NULL AND type = ? AND amount_cents = ? AND date >= ? AND date <= ? ORDER BY date LIMIT 1');
    // A statement line may arrive as several parts (fingerprints "line", "line#2", ...). Together they must come
    // to exactly the bank's figure for that line, or nothing is added.
    const lineTotals = new Map();
    for (const l of add) {
      if (!Number.isInteger(l.line_cents)) continue;
      const base = String(l.fp).split('#')[0];
      const t = lineTotals.get(base) || { want: l.line_cents, got: 0, name: l.description };
      t.got += l.amount_cents;
      lineTotals.set(base, t);
    }
    for (const t of lineTotals.values()) {
      if (t.got !== t.want) throw new UserError(`The parts of ${t.name} come to ${(Math.abs(t.got) / 100).toFixed(2)}, but the bank line is ${(Math.abs(t.want) / 100).toFixed(2)}. Nothing was added.`);
    }
    const sorted = add.slice().sort((a, b) => a.date.localeCompare(b.date) || a.n - b.n);
    for (const l of sorted) {
      if (!l.fp || hasFp.get(l.fp)) continue;                    // already brought in
      if (!Number.isInteger(l.amount_cents) || l.amount_cents === 0) throw new UserError('A statement line has no amount.');
      const bankDate = isIsoDate(l.bank_date) ? l.bank_date : l.date;
      const dup = l.allow_duplicate ? null : twin.get(l.amount_cents > 0 ? 'R' : 'P', Math.abs(l.amount_cents), addDays(bankDate, -MATCH_DAYS), addDays(bankDate, MATCH_DAYS));
      if (dup) throw new UserError(`${bankDate} ${l.payee_name || l.description}: the books already have ${dup.reference} for the same amount, dated ${dup.date}. Nothing was added. Load the statement again to line it up.`);
      let t;
      try {
        t = createTransaction(db, { reference: typeof l.reference === 'string' ? l.reference.trim() : '', date: l.date, type: l.amount_cents > 0 ? 'R' : 'P', amount_cents: Math.abs(l.amount_cents), payee_name: l.payee_name, payee_code: l.payee_code || null, account_code: l.account_code });
      } catch (e) {
        if (e instanceof UserError) throw new UserError(`${l.date} ${l.payee_name || l.description}: ${e.message}`);
        throw e;
      }
      db.prepare('UPDATE transactions SET bank_ref = ? WHERE id = ?').run(l.fp, t.id);
      added++;
    }
    if (checkpoint && isIsoDate(checkpoint.date) && Number.isInteger(checkpoint.balance_cents)) {
      db.prepare("INSERT INTO checkpoints (date, balance_cents, note) VALUES (?, ?, 'Bank statement import') ON CONFLICT(date) DO UPDATE SET balance_cents = excluded.balance_cents, note = excluded.note").run(checkpoint.date, checkpoint.balance_cents);
    }
    return { added, ticked };
  });
}
