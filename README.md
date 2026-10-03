# McKay Consultants Accounts

A Microsoft Access cashbook for McKay Consultants Ltd. It records every bank payment and receipt, codes
each one to a ledger account, works out the GST content, and reports on them for a date range. It has been
in use since September 1995 and holds about 21,400 transactions.

This repository holds the **design** of the database (forms, reports, VBA, queries, table structure) as text,
plus the tools and notes for changing it safely. **It holds no accounting data** - the repository is public,
and the `.accdb` itself stays on the office drive.

| | |
|---|---|
| Master database | `Z:\Craig\McKay Consultants Ltd\Accounts Database\McKay Consultants Accounts V6.20.accdb` |
| Baseline in git | V6.20 as last saved 12 Aug 2026, exported 4 Oct 2026 |
| Access | 32-bit Office, `.accdb` format, opens on the `forms_switchboard` form |
| Size | 9 tables, 3 saved queries, 13 forms, 8 reports, 2 modules, 1 macro |

## What it does

**Transactions** (the main screen). One record per bank transaction:

1. A reference is offered automatically: the last `bk…` reference plus one (`bk26/07-87` → `bk26/07-88`,
   i.e. bank, year/month, running number). References must be unique.
2. Enter the date, the total, and whether it is a Payment or a Receipt.
3. Type a **quick code** (up to 4 letters for a regular payee). It fills in the payee name and the ledger
   code that payee normally goes to. Otherwise type the name and pick the ledger code.
4. The form works out the rest: `Gross_Total` (negative for payments), `GST_Total` (the GST inside the
   total, zero if the ledger code is GST exempt), and either `Payment` or `Receipt`.
5. The foot of the form shows the **current bank balance**: opening balance plus the sum of every
   transaction's gross total.

**Reports** (Transactions Report Generator). Pick a date range and up to ten ledger codes (default `*` =
all), then:

- *Preview/Print* - a transaction listing with payments, receipts and running bank balance, or, with
  *Group Transactions* ticked, the same transactions grouped by ledger code with subtotals of expenses,
  income, GST and gross (the report used for GST returns and the year-end accounts).
- *Transfer to Excel* - writes the selection to `mckay_consultants_transactions.xls` in a folder you choose
  and formats it.

**Set-up screens**

- *Accounts Codes* - the chart of accounts: main code, optional sub code, descriptions, GST exempt flag.
- *Quick Codes* - regular payees and the ledger code each defaults to.
- *Opening Bank Balance* - the bank account name and its balance before the first transaction.
- *Lock Accounts* - marks transactions up to a date as locked so they cannot be edited or deleted.

**Invoicing** (Contacts, Jobs/Contracts, Invoices, Invoices Summary Report). Raises tax invoices with line
items and an hours/km/expenses breakdown. It was last used in 2005 and no longer works as it stands - see
[BUGS_AND_IMPROVEMENTS.md](BUGS_AND_IMPROVEMENTS.md).

Full detail of every table, form, report and calculation is in [docs/DATABASE.md](docs/DATABASE.md).

## Layout

```
source/schema.json     tables, fields, indexes, saved queries, object names (structure only)
source/forms/          one text export per form (design + VBA)
source/reports/        one per report
source/modules/        VBA modules
source/macros/         macros
source/queries/        saved query SQL
tools/                 export, load and schema scripts (PowerShell)
docs/DATABASE.md       how the database works
BUGS_AND_IMPROVEMENTS.md   known faults and ideas, with status
CHANGELOG.md           what changed in each version
CLAUDE.md              the update process and the rules for working on it
```

## Changing the database

The short version - the full process is in [CLAUDE.md](CLAUDE.md):

1. Never work in the master. `tools\export-source.ps1` copies it to `C:\claude\accounts-work` and exports
   the copy.
2. Make the change in the copy (in Access, or by editing the text and `tools\load-objects.ps1`), test it there.
3. Re-export, review the diff, commit, note it in `CHANGELOG.md`.
4. Install into the master by hand with Access closed and a dated backup taken first, saved as the next
   version number.
