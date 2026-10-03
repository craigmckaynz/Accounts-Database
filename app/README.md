# McKay Accounts - the application

The replacement for the Access cashbook: a small web application that runs on this computer. Version 0.1 is
a first working prototype.

- **Stack:** Node.js (24 or later), Express, Vue 3, Vite, plain JavaScript. Data in SQLite through Node's
  built-in `node:sqlite` (no Access, no native modules). The SQL is plain so PostgreSQL can replace it later.
- **Data:** `C:\claude\accounts-data\accounts.sqlite` - beside the repository, never inside it (the
  repository is public). A dated copy is written to `accounts-data\backups` the first time the app starts
  each day; the newest 30 are kept.
- **Access:** the app listens on this computer only (`127.0.0.1:4310`) and has no login.

## Running it

Double-click `Start Accounts.bat` in the repository root, or:

```
cd app
npm install
npm run build
npm start            # http://localhost:4310
```

Bringing the data across from Access (reads a copy of the `.accdb`, never writes to it):

```
npm run import -- "C:\claude\accounts-work\accounts-copy.accdb"             # first time
npm run import -- "C:\claude\accounts-work\accounts-copy.accdb" --replace   # again later; backs up first
```

It prints the counts and whether the bank balance agrees with Access. While Access is still the system
in use, re-import with `--replace` to pick up new entries; anything entered only in the app is lost by that.

Made-up data for trying things out: `npm run demo`, then `node server/index.js --db C:\claude\accounts-data\demo.sqlite --port 4312`.

Tests (made-up data, in memory): `npm test`.

## What is in it

| Screen | What it does |
|---|---|
| Transactions | One entry line: date, payee or quick code, payment/receipt, amount, ledger code. A quick code fills the payee and ledger code; GST shows as you type; the reference is offered for the month of the date; Enter saves and leaves the cursor ready for the next statement line with the date kept. The month's entries sit below with the bank balance after each one, so the screen can be read down beside the statement. Click an entry to change or delete it (delete has Undo). Search covers every year. |
| Reports | By ledger code (with or without every transaction), transaction listing with running balance, and GST summary, for a preset or custom period and any set of ledger codes. Print or save as PDF, or download for Excel. Every report shows the opening and closing bank balance. |
| Problem finder | Enter a bank statement's closing balance. Where the books first disagree, it searches the entries since the last statement that agreed and lists the likeliest culprits: an entry made twice, a payment entered as a receipt, digits swapped, a slipped decimal point, an extra or missing digit - each with a one-click fix. It also lists skipped reference numbers and entries edited or deleted in that stretch, and sweeps for missing data, unknown ledger codes, future dates, references in the wrong month, double entries and GST that does not match the rate for the date. |
| Setup | Bank account name, opening balance, financial year start, lock date, ledger codes, quick codes, GST rates. |

## How it differs from the Access database

- Invoicing is not carried over (unused since 2005).
- Each transaction holds the amount, type and GST once. The redundant gross, payment and receipt columns are
  gone; they are worked out when needed. Money is stored as whole cents.
- GST uses the rate for the transaction's date, rounded to the cent, and is recalculated only when the
  date, type, amount or ledger code of an entry changes. Opening or re-saving an entry never changes it.
  GST can be typed in by hand for an entry that is only partly subject to GST.
- Imported entries keep the GST they had in Access (rounded to the cent). The Access figures at 12.5% for
  2010-2018 are therefore still there, and the problem finder lists them under "GST differs from the rate for
  the date". They are left for the accountant's decision.
- The reference number restarts by itself in a new month (`bk26/08-01`).
- Locking is one date: everything on or before it is read-only.
- Every add, edit and delete is recorded, which gives Undo and lets the problem finder show what was
  disturbed.

## Layout

```
server/db.js             tables, settings, daily backup
server/ledger.js         transactions, bank balance, references, validation, GST on entry
server/problems.js       the problem finder
server/reports.js        ledger report, GST summary, period balances
server/index.js          the web server and API
server/import-access.js  import from the .accdb
server/seed-demo.js      made-up data
server/test/             tests
shared/money.js          cents, GST and date helpers used by server and browser
client/                  the Vue application
```

## Not done yet

- Importing the bank's CSV statement, so entries are matched or created rather than typed.
- A login, if it is ever to be used from more than this computer.
- PostgreSQL in Docker, to match the Site Inspection application.
- The reports have been checked for arithmetic (they add up to the bank balance) but not yet laid beside
  the Access reports the accountant is used to.
