# Changelog

One entry per version installed into the master database, newest first. Each entry says what changed for
the person using it, which objects changed, and which BUGS_AND_IMPROVEMENTS items it closes.

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
