// Bank statement import. Reads the CSV a bank's internet banking exports, lines it up against the books,
// and adds the lines that are missing as transactions.
//
// Banks disagree about column names, order and date formats, so the columns are worked out from the header
// row (or from the data when there is none) and can be overridden from the screen.
import { inTransaction } from './db.js';
import { createTransaction, bankBalance, UserError } from './ledger.js';
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

// An entry of the same amount within MATCH_DAYS of the bank's date is taken to be the same transaction.
// One further away, up to DUPLICATE_DAYS, might be (a cheque banked late, an invoice date typed instead of the
// payment date): the line is held back until the user says which.
const MATCH_DAYS = 4;
const DUPLICATE_DAYS = 14;
const dayGap = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

// ---- lining the statement up against the books -------------------------------------------------------

const signedOf = t => (t.type === 'R' ? t.amount_cents : -t.amount_cents);

// ---- learning from past entries ----------------------------------------------------------------------
// A bank's description of a payee ("HILLTOP FUEL STOP 4421 WHAKATANE") is rarely what was typed into the
// books ("HILLTOP FUEL"). So past entries are matched on the words they share, rare words counting for more
// than common ones, and the ledger code and quick code most often used for that payee are offered.

// Words that say how the money moved, not who it went to.
const NOISE = new Set(('LTD LIMITED THE AND FOR NZ NEW ZEALAND CARD EFTPOS VISA DEBIT CREDIT DIRECT PAYMENT PAYMENTS PAY BILL TRANSFER ' +
  'AUTOMATIC ONLINE INTERNET BANKING DEPOSIT WITHDRAWAL PURCHASE POS REF FROM TXN TRANSACTION').split(' '));
export const words = s => [...new Set(matchKey(s).split(' ').filter(w => w.length >= 3 && !NOISE.has(w)))];
// Banks cut names short and people abbreviate: COUNTDOW matches COUNTDOWN.
const sameWord = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

// Every payee the books know, from past transactions and the quick codes, with what it was coded to.
export function buildHistory(db) {
  const validPayee = new Map(db.prepare('SELECT code, name, account_code FROM payees').all().map(p => [p.code, p]));
  const validAccount = new Set(db.prepare('SELECT code FROM accounts WHERE active = 1').all().map(a => a.code));
  const payees = new Map();              // normalised name -> what is known about it
  const entry = name => {
    const key = matchKey(name);
    if (!key) return null;
    if (!payees.has(key)) payees.set(key, { key, name, words: words(name), count: 0, uses: [], amounts: new Map(), types: { P: 0, R: 0 } });
    return payees.get(key);
  };
  // Newest first, so the latest spelling and the latest coding lead.
  for (const t of db.prepare("SELECT payee_name, payee_code, account_code, type, amount_cents, date FROM transactions WHERE payee_name <> '' AND account_code IS NOT NULL ORDER BY date DESC, id DESC").all()) {
    const p = entry(t.payee_name);
    if (!p) continue;
    p.count++;
    p.types[t.type]++;
    if (p.uses.length < 12) p.uses.push({ account_code: t.account_code, payee_code: t.payee_code });   // recent coding outweighs old
    if (t.amount_cents) p.amounts.set(`${t.type}${t.amount_cents}`, (p.amounts.get(`${t.type}${t.amount_cents}`) || 0) + 1);
  }
  for (const q of validPayee.values()) {
    const p = entry(q.name);
    if (p && !p.count && q.account_code) p.uses.push({ account_code: q.account_code, payee_code: q.code });
    if (p) p.quick = q.code;
  }
  // How telling each word is: one that appears in a single payee's name says more than one in fifty.
  const df = new Map();
  const byWord = new Map();
  for (const p of payees.values()) for (const w of p.words) {
    df.set(w, (df.get(w) || 0) + 1);
    if (!byWord.has(w)) byWord.set(w, []);
    byWord.get(w).push(p);
  }
  const n = Math.max(payees.size, 1);
  const weight = w => Math.log(1 + n / (df.get(w) || 0.5));
  for (const p of payees.values()) {
    p.weight = p.words.reduce((s, w) => s + weight(w), 0);
    const tally = (pick, ok) => { const c = new Map(); p.uses.forEach((u, i) => { const v = pick(u); if (v && ok(v)) c.set(v, (c.get(v) || 0) + 1 + (p.uses.length - i) / 100); }); return [...c].sort((a, b) => b[1] - a[1])[0]?.[0] || null; };
    p.account_code = tally(u => u.account_code, v => validAccount.has(v));
    p.payee_code = tally(u => u.payee_code, v => validPayee.has(v)) || p.quick || null;
  }
  // Amounts that always go to the same place (a rent, a loan repayment), for lines whose description says nothing.
  const byAmount = new Map();
  for (const t of db.prepare("SELECT type, amount_cents, account_code, payee_name, payee_code FROM transactions WHERE amount_cents > 0 AND account_code IS NOT NULL AND date >= ? ORDER BY date DESC, id DESC").all(addDays(todayIso(), -730))) {
    const k = `${t.type}${t.amount_cents}`;
    if (!byAmount.has(k)) byAmount.set(k, []);
    byAmount.get(k).push(t);
  }
  return { payees, byWord, weight, byAmount, validAccount, validPayee };
}

// The past payee a statement line most likely is, or null. Returns { payee, score, shared }.
export function bestMatch(history, line) {
  const mine = words(line.description + ' ' + (line.detail || ''));
  if (!mine.length) return null;
  const mineWeight = mine.reduce((s, w) => s + history.weight(w), 0);
  const type = line.amount_cents > 0 ? 'R' : 'P';
  const candidates = new Set();
  for (const w of mine) {
    for (const p of history.byWord.get(w) || []) candidates.add(p);
    if (w.length >= 4) for (const [hw, list] of history.byWord) if (hw !== w && sameWord(hw, w)) for (const p of list) candidates.add(p);
  }
  let best = null;
  for (const p of candidates) {
    if (!p.account_code) continue;
    const shared = p.words.filter(hw => mine.some(w => sameWord(hw, w)));
    if (!shared.length) continue;
    const got = shared.reduce((s, w) => s + history.weight(w), 0);
    const containment = got / p.weight;                    // how much of the known name is in the description
    if (containment < 0.5) continue;
    let score = 0.7 * containment + 0.3 * Math.min(1, got / mineWeight);
    if (p.amounts.has(`${type}${Math.abs(line.amount_cents)}`)) score += 0.15;      // same amount as before
    if (p.count && !p.types[type]) score -= 0.15;          // only ever seen going the other way
    score += Math.min(p.count, 50) / 5000;                 // between equals, the more familiar payee
    if (!best || score > best.score) best = { payee: p, score, shared };
  }
  return best && best.score >= 0.55 ? best : null;
}

function suggest(db, line, lookups) {
  const key = matchKey(line.description);
  const name = clean(line.description).toUpperCase().slice(0, 50);
  // 1. What this exact bank description was given last time it was imported.
  const remembered = key && lookups.remembered.get(key);
  if (remembered && lookups.history.validAccount.has(remembered.account_code)) {
    return { payee_name: remembered.payee_name || name, payee_code: remembered.payee_code, account_code: remembered.account_code, from: 'as last import' };
  }
  // 2. The past payee whose name it most resembles.
  const m = bestMatch(lookups.history, line);
  if (m) {
    const p = m.payee;
    return { payee_name: p.name, payee_code: p.payee_code, account_code: p.account_code,
      from: p.count ? `past entries: ${p.name} (${p.count})` : `quick code ${p.payee_code}`, score: Math.round(m.score * 100) / 100 };
  }
  // 3. An amount that has only ever gone to one place.
  const same = lookups.history.byAmount.get(`${line.amount_cents > 0 ? 'R' : 'P'}${Math.abs(line.amount_cents)}`) || [];
  if (same.length >= 3 && same.every(t => t.account_code === same[0].account_code && matchKey(t.payee_name) === matchKey(same[0].payee_name)) && lookups.history.validAccount.has(same[0].account_code)) {
    const t = same[0];
    return { payee_name: t.payee_name, payee_code: lookups.history.validPayee.has(t.payee_code) ? t.payee_code : null, account_code: t.account_code, from: `same amount as ${same.length} past entries` };
  }
  return { payee_name: name, payee_code: null, account_code: null, from: null };
}

export function analyse(db, lines) {
  if (!lines.length) throw new UserError('No transactions were found in that file.');
  const first = lines[0].date, last = lines[lines.length - 1].date;
  const books = db.prepare('SELECT * FROM transactions WHERE date >= ? AND date <= ? ORDER BY date, id').all(addDays(first, -DUPLICATE_DAYS), addDays(last, DUPLICATE_DAYS));
  const byFp = new Map(books.filter(t => t.bank_ref).map(t => [t.bank_ref, t]));
  for (const t of db.prepare(`SELECT * FROM transactions WHERE bank_ref IN (${lines.map(() => '?').join(',')})`).all(...lines.map(l => l.fp))) byFp.set(t.bank_ref, t);
  const lookups = {
    remembered: new Map(db.prepare('SELECT * FROM bank_matches').all().map(m => [m.key, m])),
    history: buildHistory(db)
  };
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
  // Lines still unmatched: is there an entry of the same amount a little further away?
  const maybe = new Set();
  for (const l of out) {
    if (l.status !== 'new') continue;
    let best = null;
    for (const t of free) {
      if (used.has(t.id) || maybe.has(t.id) || signedOf(t) !== l.amount_cents) continue;
      const gap = dayGap(t.date, l.date);
      if (gap <= DUPLICATE_DAYS && (!best || gap < best.gap)) best = { t, gap };
    }
    if (best) { l.possible = best.t; maybe.add(best.t.id); }
  }
  for (const l of out) if (l.status === 'new') l.suggestion = suggest(db, l, lookups);

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
  return {
    from: first, to: last, lines: out, book_only: bookOnly, closing, running,
    counts: { total: out.length, done: out.filter(l => l.status === 'done').length, matched: out.filter(l => l.status === 'matched').length, fresh: out.filter(l => l.status === 'new').length, possible: out.filter(l => l.possible).length, book_only: bookOnly.length }
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

// Adds the chosen statement lines as transactions, ticks off the ones already in the books, remembers which
// ledger code each description went to, and records the statement's closing balance.
export function commit(db, { add = [], matched = [], checkpoint = null }) {
  return inTransaction(db, () => {
    const hasFp = db.prepare('SELECT 1 FROM transactions WHERE bank_ref = ?');
    const stamp = db.prepare('UPDATE transactions SET bank_ref = ? WHERE id = ? AND bank_ref IS NULL');
    const remember = db.prepare('INSERT INTO bank_matches (key, payee_name, payee_code, account_code) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET payee_name = excluded.payee_name, payee_code = excluded.payee_code, account_code = excluded.account_code');
    let added = 0, ticked = 0;
    // Tick off first, so the entries they claim cannot also be mistaken for duplicates of the new lines.
    for (const m of matched) if (m.fp && m.transaction_id) ticked += Number(stamp.run(m.fp, m.transaction_id).changes);
    // The last line of defence against doubling up, whatever the screen sent: an entry of the same amount
    // near the bank's date that no statement line has claimed.
    const twin = db.prepare('SELECT reference, date FROM transactions WHERE bank_ref IS NULL AND type = ? AND amount_cents = ? AND date >= ? AND date <= ? ORDER BY date LIMIT 1');
    const sorted = add.slice().sort((a, b) => a.date.localeCompare(b.date) || a.n - b.n);
    for (const l of sorted) {
      if (!l.fp || hasFp.get(l.fp)) continue;                    // already brought in
      if (!Number.isInteger(l.amount_cents) || l.amount_cents === 0) throw new UserError('A statement line has no amount.');
      const bankDate = isIsoDate(l.bank_date) ? l.bank_date : l.date;
      const dup = l.allow_duplicate ? null : twin.get(l.amount_cents > 0 ? 'R' : 'P', Math.abs(l.amount_cents), addDays(bankDate, -DUPLICATE_DAYS), addDays(bankDate, DUPLICATE_DAYS));
      if (dup) throw new UserError(`${bankDate} ${l.payee_name || l.description}: the books already have ${dup.reference} for the same amount, dated ${dup.date}. Nothing was added. Mark the line as that entry, or confirm it is a separate transaction.`);
      let t;
      try {
        t = createTransaction(db, { date: l.date, type: l.amount_cents > 0 ? 'R' : 'P', amount_cents: Math.abs(l.amount_cents), payee_name: l.payee_name, payee_code: l.payee_code || null, account_code: l.account_code });
      } catch (e) {
        if (e instanceof UserError) throw new UserError(`${l.date} ${l.payee_name || l.description}: ${e.message}`);
        throw e;
      }
      db.prepare('UPDATE transactions SET bank_ref = ? WHERE id = ?').run(l.fp, t.id);
      const key = matchKey(l.description);
      if (key) remember.run(key, l.payee_name, l.payee_code || null, l.account_code);
      added++;
    }
    if (checkpoint && isIsoDate(checkpoint.date) && Number.isInteger(checkpoint.balance_cents)) {
      db.prepare("INSERT INTO checkpoints (date, balance_cents, note) VALUES (?, ?, 'Bank statement import') ON CONFLICT(date) DO UPDATE SET balance_cents = excluded.balance_cents, note = excluded.note").run(checkpoint.date, checkpoint.balance_cents);
    }
    return { added, ticked };
  });
}
