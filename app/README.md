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

**In use:** the accounts run from the company folder on the NAS,
`Z:\Craig\McKay Consultants Ltd\McKay Accounts` (`\\nas\public\...`):

```
app\                            the program (replaced by tools/deploy.ps1; do not edit there)
data\accounts.sqlite            the accounts
data\backups\                  a dated copy for each day the accounts were used, newest 30 kept
data\in-use.json                present while someone has the accounts open: who, and since when
Install on this computer.cmd    run once per computer: adds the McKay Accounts shortcut
READ ME.txt
```

Each computer needs Node.js 22.13 or newer (https://nodejs.org, LTS). The shortcut runs `app\launch.ps1`,
which starts the program on that computer (it listens on that computer only, port 4310) and opens it in its
own window. **One person at a time**: a second computer is told who has the accounts open. The program stops
about 45 seconds after its window is closed.

To update the program after a change (the data is not touched; nobody may have the accounts open):

```
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1
```

**For development** (this checkout, with data in `C:\claude\accounts-data`):

```
cd app
npm install
npm run build
npm start            # http://localhost:4310
```

Importing from Access (reads a copy of the `.accdb`, never writes to it) is `npm run import -- "<copy.accdb>"`.
It replaces whatever the target database holds, so it is not for the live accounts now that entries are made
in the app. Made-up data for trying things out: `npm run demo`, then
`node server/index.js --db C:\claude\accounts-data\demo.sqlite --port 4312`. Tests: `npm test`.

## What is in it

| Screen | What it does |
|---|---|
| Transactions | One entry line: date, payee or quick code, payment/receipt, amount, ledger code. A quick code fills the payee and ledger code; GST shows as you type; the reference is offered for the month of the date; Enter saves and leaves the cursor ready for the next statement line with the date kept. The month's entries sit below with the bank balance after each one, so the screen can be read down beside the statement. Click an entry to change or delete it (delete has Undo). Search covers every year. |
| Bank import | Choose the CSV exported from internet banking. You get a **preview**: nothing reaches the books until you press Add and confirm the summary. Each statement line is lined up against the books. Lines already entered are ticked off. New lines are offered as entries with the bank's wording as the payee. Money going out gets a bank reference, numbered on from the last one in the books for that month; changing one renumbers those below it. Money coming in starts with an empty reference for the invoice number (type the bank prefix alone for the next bank number). A line can be split into parts - one receipt covering several invoices, one payment across ledger codes - each part its own entry. **The quick code and ledger code are left empty on purpose** - nothing is guessed, so every new line is looked at and coded by the person importing. Choosing a quick code fills the payee name and its ledger code, as the Access form did; the ledger code can also be chosen directly. The preview shows a running balance (the bank's beside the books', the first line where they part highlighted), and the date, reference and payee can be edited and lines unticked. Entries in the books that the statement does not have are listed - the usual home of a double entry or a wrong amount. |
| Reports | By ledger code (with or without every transaction), transaction listing with running balance, and GST summary, for a preset or custom period and any set of ledger codes. Print or save as PDF, or download for Excel. Every report shows the opening and closing bank balance. |
| Problem finder | Enter a bank statement's closing balance. Where the books first disagree, it searches the entries since the last statement that agreed and lists the likeliest culprits: an entry made twice, a payment entered as a receipt, digits swapped, a slipped decimal point, an extra or missing digit - each with a one-click fix. It also lists skipped reference numbers and entries edited or deleted in that stretch, and sweeps for missing data, unknown ledger codes, future dates, references in the wrong month, double entries and GST that does not match the rate for the date. |
| Setup | Bank account name, opening balance, financial year start, lock date, ledger codes, quick codes, GST rates. |

## An import can be closed and resumed

Choosing a statement file starts an import session, kept in the `bank_session` table: the file's text, the
column mapping, and what has been typed against each line. It is saved a moment after every change and when
the screen is left. Opening the Bank import screen again - after going to another screen, closing the app, or
restarting - brings it back as it was. There is one session at a time. Adding the statement to the books
deletes the session; "Discard this import" deletes it without adding anything.

## No duplicates on import

1. A line brought in before carries a fingerprint (date, amount, description, position among identical
   lines) and is recognised as done, however the files overlap.
2. An entry of the same amount within 4 days of the bank's date is taken to be the same transaction and is
   ticked off instead of added. Each entry can only be claimed by one statement line, so two identical
   payments on the statement against one in the books leaves one to add.
3. If such an entry is typed into the books after the preview was drawn, the server refuses the line and
   nothing is added.

Entries of the same amount further away than 4 days are treated as different transactions. The earlier
"possibly already entered" question (5 to 14 days) was removed on 5 Oct 2026 at Craig's instruction: the
statement being imported is checked before it is loaded.

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
server/bank.js           bank statement import: reading the CSV, matching, adding
server/reports.js        ledger report, GST summary, period balances
server/index.js          the web server and API
server/import-access.js  import from the .accdb
server/seed-demo.js      made-up data
server/test/             tests
shared/money.js          cents, GST and date helpers used by server and browser
client/                  the Vue application
```

## Not done yet

- The bank import has been tested on made-up statements in the common layouts (one amount column, separate
  money in / money out columns, newest or oldest first, with or without a header row). It has not yet been
  run on a real export from your bank.
- A login, if it is ever to be used from more than this computer.
- PostgreSQL in Docker, to match the Site Inspection application.
- The reports have been checked for arithmetic (they add up to the bank balance) but not yet laid beside
  the Access reports the accountant is used to.
