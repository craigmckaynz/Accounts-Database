# Bugs and improvements

Found while documenting the V6.20 baseline on 4 Oct 2026. Nothing here has been changed yet - each item
needs Craig's go-ahead, because several alter stored figures or how the accounts are kept.

How each was established:
**[data]** counted in a copy of the database · **[code]** read from the exported design, not yet run in Access.

Status: `open` until agreed, then `agreed`, `done (Vx.xx)` or `won't fix`.

## Affects the figures

### 1. GST stored at 12.5% for eight years after the rate went to 15% - open [data]

GST rose to 15% on 1 Oct 2010. From then until September 2018, 4,413 transactions have a `GST_Total` equal
to one ninth of the total (12.5%) rather than 3/23 (15%). The first 15% entry is dated 2 Jul 2018 and the
last 12.5% entry 7 Sep 2018, so the code was corrected around then. Only nine entries in that period match
neither rate.

What this means depends on how the GST returns for those years were prepared. If they were taken from the
GST column of the grouped report, both GST collected and GST claimed were understated by about one seventh
(1/9 of the total recorded where 3/23 was due). If the accountant worked from gross amounts, the returns are unaffected and only the stored
column is wrong. **This needs a decision from Craig and his accountant before anything is recalculated.**

### 2. Looking at an old transaction recalculates and re-saves it - done (V6.21, tested in the working copy, not yet installed in the master)

`Form_Current` calls `CalcTotals` every time a record is displayed, and `CalcTotals` writes `Gross_Total`,
`GST_Total`, `Payment` and `Receipt` at today's rate and then saves. So scrolling to a transaction from the
12.5% years, or one whose ledger code has since been made exempt, silently changes its stored GST. The data
shows the trace of it: nine transactions dated before October 2010 carry 15% GST, and one to three a year in
2011-2017.

Fixed: totals are calculated only when the total, type, date or ledger code is edited (or a quick code
fills the ledger code), never on display. Confirmed by running V6.20 and V6.21 through
`tools/test-transactions.ps1`: stepping through 404 records changed stored figures in V6.20 and none in V6.21.
The GST label now shows the rate held in the record's own figures.

### 3. The GST rate is written into the code - done (V6.21, tested in the working copy, not yet installed in the master)

`CalcTotals` reads the `GST_Rates` table for the transaction date and then ignores the answer
(`dblGST = 1.15`, with the lookup commented out). A future rate change needs a code change, and old
transactions cannot be recalculated at their own rate. Fixed: `CalcTotals` uses the `GST_Rates` row covering
the transaction date and refuses to calculate (with a message) if there is none. Note the consequence for
item 1: editing the total, type, date or code of a 2010-2018 transaction now recalculates it at 15%.

### 4. Locking does not work - open [code, supported by data]

The Lock Records button runs an update on `[transactions].[date]`. The field was renamed
`transaction_date`, so Access asks for "transactions.date" as a second prompt instead of comparing the
real dates. No transaction in the database is locked, in any year.

### 5. Transactions on GST-exempt codes that carry GST - open [data]

246 transactions are coded to a ledger account marked GST exempt but have a non-zero `GST_Total`
(probably entered before the code was marked exempt). Also 3 transactions use a ledger code that is not in
`ledger_accounts`, and 3 have no date, code or total.

### 6. The date is not actually checked on entry - open [code]

`Account_Code_Exit` tests `IsNull(Date)`. `Date` there is VBA's today's-date function, which is never
null, so a transaction with no date passes the "missing data" check.

## Things that are broken

### 7. Report code pickers read a table that was renamed - open [code]

The ten ledger code lists on the Transactions Report Generator select from `[Ledger Accounts]`; the table
is now `ledger_accounts`. The default `*` (all codes) still works, picking specific codes from the lists
does not. The `quick_codes` report has the same fault.

### 8. Grouped report still uses old field names - open [code]

`transactions_grouped` sorts and groups on `Date` and `Reference` (now `transaction_date`,
`transaction_reference`). To be confirmed by running it: Access will prompt for them or sort wrongly.

### 9. Chart of accounts report button - open [code]

The Report button on Accounts Codes opens "Ledger Accounts"; the report is named `ledger_accounts`. The
report also has a `% GST` column bound to a `GST` field the table does not have.

### 10. Invoicing is out of service - open [code]

Last invoice 2005. The `jobs_contracts` table is missing; GST is fixed at 12.5% in the form, the invoice and
the summary query; Print Invoice refers to a missing "Invoices Filter"; the invoice footer has an old phone
number. Decide: repair it, or remove the invoicing forms, reports and tables.

### 11. Dead objects - open [code]

Query `Total GST` (1999 dates, old field name), report `Transactions_new` (unfinished copy), the Quick
Codes handler that opens a missing "Payee Codes List" form, four unused FindNext buttons' code in
`invoicesDialogBox`.

## Robustness

### 12. Next reference - open [code]

`FindNextRef` fails if the latest `bk` reference has no `-`, and does not roll over to a new month by
itself. It also runs two queries on every record move.

### 13. Text typed into SQL - open [code]

The duplicate-reference check and Find Record build SQL by joining text, so a reference containing an
apostrophe raises an error.

### 14. 32-bit only - open [code]

`Module1`'s API declarations lack `PtrSafe`; the database will not compile under 64-bit Office.

### 15. Excel export writes the old .xls format and needs the Excel library reference - open [code]

### 16. No primary key on `transactions`, no relationships, payees stored by name - open [data]

### 17. Version shown on the switchboard is "V6.5"; the file is V6.20 - open [code]

### 18. One copy, on a network drive - open

The master sits alone in its folder with no dated backups beside it and Auto Compact off. A backup step is
part of the update process in CLAUDE.md; a routine backup outside of updates would be worth adding.

## Larger ideas (not started, for discussion)

- Bank statement import (CSV from the bank) with quick-code matching, instead of typing each transaction.
- A GST return report: totals for the period boxes directly, from correctly dated rates.
- More than one bank account.
- Moving off Access, as for the Site Inspection database (Node, Vue 3, PostgreSQL).
