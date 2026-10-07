# Changelog

One entry per version installed into the master database, newest first. Each entry says what changed for
the person using it, which objects changed, and which BUGS_AND_IMPROVEMENTS items it closes.

## Application 0.7.0 - 2026-10-07 (in use from the company folder)

- McKay Accounts now runs from the company folder on the NAS (`McKay Accounts` under McKay Consultants Ltd):
  the program in `app`, the accounts in `data`. Any computer with Node.js runs it from there after
  "Install on this computer.cmd" has added the shortcut.
- One person at a time: the first computer to open the accounts leaves a note in the data folder; another
  is told who has them and does not start. The note is refreshed every half minute and ignored after three
  minutes of silence, so a crashed computer does not lock everyone out. The program stops by itself about
  45 seconds after its window is closed (or after 15 minutes of silence), handing the accounts back.
- On the network folder the database uses SQLite's classic journal and is held exclusively (the write-ahead
  log cannot be used across a network).
- `tools/deploy.ps1` tests, builds and copies the program to the folder; it never touches existing data.
- Bank import: transfers are recognised by From, Frm or To and are not shaded; a resumed transfer line
  with an empty reference is numbered automatically.
- Tested: 31 automated tests pass. In a trial folder with made-up data: start, lock note written, second
  copy refused, stop 49 s after the window closed with the note removed, refusal when another computer
  holds a fresh note, take-over of a note ten minutes old. On the NAS: 21,538 transactions copied and
  checked table by table; started from the NAS by the shortcut's launcher (17 s the first time, which
  included the day's backup); count, checksum and last date equal the copy on the PC, and the running
  balance ends at the bank balance.
- Fixed the same day: the taskbar pin still pointed at the copy on the PC, which started on a new, empty
  database (the live data on the NAS was untouched). The program now refuses to start when the accounts
  file is missing instead of creating an empty one, and the launcher on the PC passes old shortcuts and pins
  on to the shared folder (`app/moved-to.txt`, this computer only).
- Not tested: a second computer (only this one has been tried); behaviour if the network drops mid-use.

## Application 0.6.0 - 2026-10-06 (prototype)

- The bank import is a session. The statement file and everything typed against it (dates, references,
  splits, quick codes, payees, ledger codes) are saved in the database as you go, so the screen can be left,
  the app closed or the computer restarted, and the import picked up where it was. One import is open at a
  time. Nothing is in the books until Add; once the statement is added the saved session is deleted, and
  "Discard this import" throws away the typing without touching the books.
- Also since 0.5.1: receipts shaded, date picker on split rows, transfers in ("From ...") numbered as bank
  entries, tick boxes removed.
- Tested: 31 automated tests pass. In the browser on a made-up statement: typed a split, references, a
  quick code, a ledger code and a payee; left the screen and returned, then reloaded the page - everything
  came back each time with nothing in the books; added it (four entries as typed, session gone); started
  another and discarded it (session gone, books unchanged).

## Application 0.5.1 - 2026-10-05 (prototype)

- Tick boxes removed from the import preview (Craig, 5 Oct 2026): every new line on the statement is added.
  A split line shows the amount left on its first row as the split amounts are typed; split rows carry the
  date, the bank description with "(split)", formatted amounts and a running balance.
- Removed the "possibly already entered" question from the bank import. A statement line is either matched
  to an entry of the same amount within 4 days (and ticked off) or it is new. The server's last check
  against doubling up now uses the same 4 days.
- Money coming in whose bank description starts with the word "From" is a transfer from another of the
  company's accounts: it gets an automatic bank reference like a payment, not a blank one for an invoice number.
- Tested: 30 automated tests pass; in the browser a line whose amount matches an entry nine days earlier
  arrives as an ordinary ticked line with no question.

## Application 0.5.0 - 2026-10-05 (prototype)

- Import preview: a statement line can be split into parts, each its own entry with its own amount,
  reference, quick code, payee and ledger code. The first part holds whatever the others leave; the parts
  must come to the bank's figure (checked on screen and again by the server).
- References: money going out is numbered automatically as before. Money coming in starts with an empty
  reference for the invoice number, and must be given one before adding (typing just the bank prefix, "bk",
  gives it the next bank number). The real data showed why: since 2024 every payment has a bk reference,
  while 125 of 200 receipts carry something else.
- Changing a bank reference renumbers every automatic reference below it from that number. Other
  references (invoice numbers) use up no bank number.
- A possible duplicate confirmed as separate becomes an ordinary line. Quick code box fills in when the
  list is down to one row. Up/Down and Ctrl+' work on split parts too.
- Tested: 30 automated tests pass. In the browser on a made-up statement: a receipt split into three
  (two invoice numbers and a bank number), the remainder shown on the first part and flagged when the
  parts exceed the line, renumbering after editing a bank reference, the missing-reference block, and six
  entries added with the references and amounts shown in the preview.

## Application 0.4.0 - 2026-10-04 (prototype)

- Bank import no longer suggests codes. Quick code and ledger code start empty on every new line, at
  Craig's instruction: guessing is a bad idea, and empty boxes make the user check every transaction. The
  matching against past entries, the "remembered" codes and the copying of a code to other lines from the
  same payee are removed (the code is in git history at 0a18d60 if hints are ever wanted).
- Import preview: Quick code column (choosing one fills the payee and ledger code, as the Access form did),
  Reference column numbered automatically per month and editable, GST column removed, rows aligned on one
  line, table sized to fit a 1280-wide window.
- Ledger code and quick code lists have titled, aligned columns (Description / Code / GST; Code / Payee /
  Ledger code); the ledger list is in description order.
- Transactions screen has the same quick code combo. In the import preview the Up and Down keys move between
  lines in the same column, Ctrl+' copies the value from the line above (a copied quick code also fills
  the payee and ledger code), and lists open by typing, clicking, F4 or Alt+Down rather than on arrival.
- Tested: 29 automated tests pass. In the browser on a made-up statement: every new line arrives with empty
  codes, coding one line leaves an identical one empty, a quick code fills payee and ledger code, and Add is
  refused while any ticked line has no ledger code.

## Application 0.3.1 - 2026-10-04 (prototype)

- Bank import preview shows a running balance on every line: the bank's own balance (when the file has
  one) beside the books' balance as it will be with the lines ticked. The first line where the two part is
  highlighted; ticking, unticking and "same entry" decisions update it at once.
- Ledger code box replaced by a picker used on the import preview and the Transactions entry line: code and
  description on one line, in the box's row and in the list; the list shows 20 or more codes at a time
  (given a window at least 560 px high), filters as you type on code or description, and works with the
  arrow keys, Enter and Tab.
- Tested: 31 automated tests pass; in the browser at 1366 x 768 with 30 demo codes the list showed 21 lines,
  each on one line, inside the window, from both screens; the balance columns followed ticks and unticks.

## Application 0.3.0 - 2026-10-04 (prototype)

- Bank import suggests the payee, quick code and ledger code from past entries, matching the bank's
  description to payees already in the books on the words they share; falls back on an amount that has only
  ever gone to one place. Each suggestion says where it came from.
- The import screen is a preview: date, payee and ledger code can be edited per line, GST is shown, lines
  can be unticked, and a confirmation summary comes before anything is added.
- Duplicate protection: possible duplicates (same amount, 5 to 14 days away) are held back for a decision,
  and the server refuses to add a line the books already appear to have.
- "McKay Accounts" shortcut (desktop and Start menu) with its own icon; opens the app in its own window.
- Tested: 31 automated tests pass. In the browser on a made-up statement: suggestions from past entries
  with quick codes, a possible duplicate held back and resolved as "same entry", the confirmation summary,
  3 entries added and 3 ticked off, nothing added before confirming. Launcher: cold start in about 3.5 s
  and reuse of the running server on a second launch. On the real data (counts only): 1,032 recent entries
  fed back through the matcher, all matched, 1,025 to the ledger code they were given.
- Not tested: a real export from the bank; pinning to the taskbar (Windows only lets the user do that).

## Application 0.2.0 - 2026-10-04 (prototype)

- Bank statement import: reads the bank's CSV, ticks off lines already in the books, offers the rest as
  entries with payee and ledger code suggested (remembered from last time, from past entries, or from a
  quick code), lists entries in the books that the statement lacks, and records the closing balance.
- Loading the same statement twice adds nothing twice. Entries ticked off against the bank are no longer
  offered as suspects by the problem finder.
- Tested: 25 automated tests pass (10 for the import: date and amount formats, layouts, matching, repeat
  import, an uncoded line stopping the whole import). In the browser on a made-up statement: 3 lines matched,
  2 added, the double entry listed, a repeat import showing everything ticked off.
- Not tested: a real export from the bank.

## Application 0.1.0 - 2026-10-04 (prototype; Access remains the system in use)

The first working version of the JavaScript application in `app/`.

- Transactions screen with one-line entry, quick codes, live GST, automatic references and a running bank balance.
- Reports: by ledger code, transaction listing, GST summary; print/PDF and download for Excel.
- Problem finder: statement balances, likely culprits with one-click fixes, and a sweep of the entries.
- Setup: bank account, opening balance, lock date, ledger codes, quick codes, GST rates.
- Import from the Access file: 59 ledger codes, 104 quick codes, 3 GST rates, 21,378 transactions; the bank
  balance agrees with Access to the cent.
- Tested: 15 automated tests pass; each screen exercised in the browser on made-up data (entry, the fix
  button, the three reports, setup). On the real data: the running balance of the latest month ends at the
  bank balance, and a year's ledger report plus the opening balance equals the closing balance.
- Not tested: printing on paper; the reports against the Access reports the accountant receives; use over
  several days.

## V6.21 - 2026-10-04 (tested in the working copy; NOT yet installed in the master)

- Displaying a transaction no longer recalculates and re-saves it. Totals are worked out only when the
  date, Payment/Receipt, total or ledger code is changed, or a quick code fills the ledger code.
- GST is calculated at the rate in force on the transaction date, from the GST_Rates table, instead of a
  fixed 15%. If the table has no rate for the date the form says so and calculates nothing.
- The label beside GST shows the rate held in the record's stored figures (so a 2012 entry stored at 12.5%
  reads 12.5%).
- The Total box's own event handler was never connected (wrong name); it is now, as are the date and
  Payment/Receipt boxes.
- Switchboard title reads V6.21.
- Objects changed: forms/Transactions, forms/forms_switchboard
- Closes: BUGS_AND_IMPROVEMENTS 2, 3
- Data changed: none
- Tested with tools/test-transactions.ps1 (16 checks, all pass): compiles; stepping through 404 records
  changes no stored figure (the same test fails on V6.20); 2005 entries calculate at 12.5%, 2012 and 2024 at
  15%; exempt codes give zero; recalculating 40 entries from 2019 on reproduces their stored figures exactly.
  Not tested: typing into the form by hand.

## V6.20 - baseline (master saved 12 Aug 2026; exported 4 Oct 2026)

The database as it stood when it was first put into git. No changes made.

- Exported all 13 forms, 8 reports, 2 modules, 1 macro, 3 queries and the table structure to `source/`.
- Documented what it does (README.md, docs/DATABASE.md) and what was found (BUGS_AND_IMPROVEMENTS.md).

Earlier versions (V1 to V6.19, 1995 to 2026) were not recorded.

<!--
Template for the next entry:

## V6.21 - yyyy-mm-dd

- What the user sees differently.
- Objects changed: forms/Transactions, ...
- Closes: BUGS_AND_IMPROVEMENTS 2, 3
- Data changed: none / describe exactly, with row counts before and after
- Backup taken: McKay Consultants Accounts V6.20 backup yyyy-mm-dd.accdb
-->
