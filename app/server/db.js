// Opens the accounts database (SQLite) and creates the tables if they are missing.
// Money is held as whole cents, dates as 'YYYY-MM-DD' text. The SQL is kept plain so PostgreSQL can replace it.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// The data lives outside the repository (which is public) and outside OneDrive.
export function defaultDbPath() {
  return process.env.ACCOUNTS_DB || path.resolve(here, '..', '..', '..', 'accounts-data', 'accounts.sqlite');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  code            TEXT PRIMARY KEY,
  main_code       TEXT,
  description     TEXT NOT NULL DEFAULT '',
  sub_description TEXT NOT NULL DEFAULT '',
  gst_exempt      INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS payees (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  account_code TEXT
);
CREATE TABLE IF NOT EXISTS gst_rates (
  id         INTEGER PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date   TEXT,
  rate_bp    INTEGER NOT NULL            -- basis points: 1500 = 15%
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY,
  reference    TEXT NOT NULL UNIQUE,
  date         TEXT,                     -- null only on rows imported that way; the problem finder lists them
  type         TEXT NOT NULL CHECK (type IN ('P', 'R')),
  amount_cents INTEGER,                  -- as on the bank statement, always positive
  gst_cents    INTEGER NOT NULL DEFAULT 0,   -- GST inside the amount, positive
  gst_manual   INTEGER NOT NULL DEFAULT 0,   -- 1 = GST typed in by hand, never recalculated
  payee_code   TEXT,
  payee_name   TEXT NOT NULL DEFAULT '',
  account_code TEXT,
  created_at   TEXT,
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS transactions_date ON transactions (date, id);
CREATE INDEX IF NOT EXISTS transactions_account ON transactions (account_code);
CREATE TABLE IF NOT EXISTS checkpoints (       -- balances read off bank statements
  id            INTEGER PRIMARY KEY,
  date          TEXT NOT NULL UNIQUE,
  balance_cents INTEGER NOT NULL,
  note          TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS bank_session (     -- the bank statement import in progress (at most one), so it can be resumed
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  file_name  TEXT NOT NULL DEFAULT '',
  csv_text   TEXT NOT NULL,
  mapping    TEXT,                             -- JSON: which column is which, when chosen by hand
  edits      TEXT NOT NULL DEFAULT '{}',       -- JSON: what has been typed so far, by statement line
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS changes (           -- every add, edit and delete, for undo and for finding slips
  id             INTEGER PRIMARY KEY,
  at             TEXT NOT NULL,
  action         TEXT NOT NULL,
  transaction_id INTEGER,
  before_json    TEXT,
  after_json     TEXT
);
`;

const DEFAULT_SETTINGS = {
  bank_account: 'Bank account',
  opening_balance_cents: '0',
  locked_to: '',              // transactions on or before this date cannot be changed
  year_start_month: '4',      // financial year starts 1 April
  bank_prefix: 'bk'
};

export function openDb(file = defaultDbPath()) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Added after 0.1.0: the bank statement line an entry was matched to or created from.
  if (!db.prepare('PRAGMA table_info(transactions)').all().some(c => c.name === 'bank_ref')) db.exec('ALTER TABLE transactions ADD COLUMN bank_ref TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS transactions_bank_ref ON transactions (bank_ref)');
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

export function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

// Runs fn as one unit: all of it is saved or none of it. Calls may nest; the outermost one commits.
const depth = new WeakMap();
export function inTransaction(db, fn) {
  const d = depth.get(db) || 0;
  if (d > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth.set(db, 0); }
}

// One dated copy a day, newest 30 kept, written before the day's first change can happen.
export function dailyBackup(db, file) {
  if (file === ':memory:') return null;
  const dir = path.join(path.dirname(file), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toLocaleDateString('en-CA');     // local yyyy-mm-dd
  const target = path.join(dir, `accounts-${stamp}.sqlite`);
  if (fs.existsSync(target)) return null;
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(dir).filter(f => /^accounts-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 30))) fs.unlinkSync(path.join(dir, f));
  return target;
}
