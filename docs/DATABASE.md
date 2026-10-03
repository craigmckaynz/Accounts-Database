# How the Accounts database works

Written from the V6.20 baseline (master saved 12 Aug 2026). Figures such as row counts were read from a copy
on 4 Oct 2026. Where something is described as not working, the detail and status are in
[../BUGS_AND_IMPROVEMENTS.md](../BUGS_AND_IMPROVEMENTS.md).

## Tables

There are no relationships defined between tables; links are by matching text values.

### transactions (about 21,400 rows, 30 Sep 1995 onward)

The cashbook. One row per bank transaction.

| Field | Type | Meaning |
|---|---|---|
| `transaction_id` | AutoNumber | Entry order. Used to find the most recent `bk` reference |
| `transaction_reference` | Text 50, required, unique | e.g. `bk26/07-87`. Other prefixes exist for older cheque books, petty cash (`PC`), etc. |
| `transaction_date` | Date | |
| `Payment_receipt` | Text | `Payment` or `Receipt` (default Payment) |
| `transaction_total` | Currency | The amount as typed, always positive |
| `Payee_Code` | Text | Quick code, if one was used |
| `Payee_Name` | Text | Payee / description |
| `Account_Code` | Text | Ledger code (`ledger_accounts.account_code`) |
| `Gross_Total` | Currency | `+total` for a receipt, `-total` for a payment |
| `GST_Total` | Currency | GST inside the total, same sign as `Gross_Total`; 0 for exempt codes |
| `Payment` | Currency | `-total` for payments, else Null |
| `Receipt` | Currency | `+total` for receipts, else Null |
| `accounts_locked` | Yes/No | Locked against edits and deletes |

Indexes: unique on `transaction_reference`, unique on (`transaction_date`, `transaction_reference`), plus
`Account_Code`, `Payee_Code`, `transaction_date`. There is no primary key.

### ledger_accounts (60 rows)

The chart of accounts. `account_code` (unique) is the combined code typed on a transaction; `main_code` +
`Description` is the account, `sub_code` + `sub_code_description` an optional split within it; `GST_exempt`
makes the GST on a transaction zero. One row has code `*` ("All Codes"), used by the report picker.

### quick_codes (104 rows)

`Payee_Code` (primary key, up to 4 characters, shown upper case), `Payee_Name`, and `Auto_Code` - the ledger
code filled in when the quick code is used.

### opening_balance (1 row)

`bank_account` (name) and `opening_balance` - the balance before the first transaction. The database handles
one bank account.

### GST_Rates (3 rows)

`GSTStartDate`, `GSTEndDate`, `GSTRate`: 10% from 1 Jul 1986, 12.5% from 1 Jul 1989, 15% from 1 Oct 2010.
**Not currently used** - the transaction form has 15% written into the code.

### Invoicing tables

`contacts` (13 rows: company, address, phones, email, contact person), `invoices` (1 row: number, date,
company, contact, job name, order number, totals, lock flag), `invoices_detail` (0 rows: description, units,
quantity, rate, amount), `invoices_notes_detail` (4 rows: date, hours, km, expenses, comment). The
`jobs_contracts` table that the Jobs/Contracts form and the invoice's Job Name list read from no longer exists.

## Saved queries

| Query | Used by | What it does |
|---|---|---|
| `Transactionsquery` | Transactions reports, Excel export | Transactions between the dialog's two dates whose ledger code is `Like` Code1 or equals any of Code2-Code10, joined to `ledger_accounts` for the descriptions, ordered by date then reference |
| `Invoicesquery` | Invoices Summary Report | Invoices between two dates with the line items summed; GST worked out at 12.5% |
| `Total GST` | nothing | A leftover from 1999; refers to a field name that no longer exists |

## Forms

### forms_switchboard (start-up form)

Buttons open: Accounts Codes (`ledger_accounts`), Transactions, Reports (`TransactionsDialogBox`), Opening
Bank Balance, Quick Codes, Lock Accounts (`lock_records`), and Exit (asks, then quits Access). The code also
has handlers for Contacts, Invoices, Jobs/Contracts and the Invoices Summary Report. The title on the form
still reads "Accounts V6.5".

### Transactions

Bound to the `transactions` table. The logic, all in the form's code:

- **Next reference** (`FindNextRef`, run on every record move): takes the row with the highest
  `transaction_id` whose reference starts `bk`, splits it at the `-`, adds one to the number and formats it to
  at least two digits. That becomes the default for a new record. The part before the `-` (year/month) is
  copied, so the first reference of a new month is typed by hand.
- **Duplicate check** (`transaction_reference_Exit`): on a new record, a reference that already exists is
  refused.
- **Quick code** (`payee_code_AfterUpdate`): looks up `Payee_Name` and `Auto_Code` in `quick_codes`, fills
  the name and ledger code, moves to the ledger code. With no quick code, focus goes to the name.
- **Totals** (`CalcTotals`, run when the total, the Payment/Receipt choice or the ledger code changes, **and
  every time a record is displayed**):
  - Receipt: `Gross_Total = total`, `GST_Total = total - total / 1.15`, `Receipt = total`, `Payment = Null`
  - Payment: `Gross_Total = -total`, `GST_Total = -(total - total / 1.15)`, `Payment = -total`, `Receipt = Null`
  - If the ledger code is GST exempt: `GST_Total = 0`
  - The label beside GST shows the rate used.
- **Ledger category / sub category**: looked up from `ledger_accounts` for display.
- **Locked records** (`Form_Current`): when `accounts_locked` is set, edits and deletions are switched off
  and "Record is locked" is shown.
- **Current Bank Balance** (form footer): `Sum(Gross_Total)` over all transactions plus the opening balance.
- **Find Record**: a list of references to jump to. Buttons open Account Codes, Quick Codes, Lock/Unlock
  Accounts and the Transactions Report dialog.

### TransactionsDialogBox (Transactions Report Generator)

Opens with the date range 30 Sep 1995 to today, Code1 = `*`, the opening balance from `opening_balance`,
and Group Transactions unticked.

- **Preview/Print**: checks the dates, then opens report `Transactions`, or `transactions_grouped` when
  Group Transactions is ticked.
- **Transfer to Excel**: asks for a folder (Windows Browse for Folder, via `Module1`), exports
  `Transactionsquery` to `mckay_consultants_transactions.xls` there, opens it in Excel and formats it (Arial 8,
  grey bold bordered header row in Title Case, columns auto-fitted, row height 15).

### lock_records

*Lock Records* asks for a date and sets `accounts_locked` on transactions up to it; *Unlock Records* clears
the flag on every transaction.

### ledger_accounts, Quick Codes, Opening Balance

Plain data-entry forms on their tables, each with Exit and (the first two) a Report button. Quick Codes shows
the ledger category and sub category of the chosen auto code.

### Invoicing forms

- `Contacts` - data entry on `contacts`, Report button.
- `jobs_contracts` - a job name list (its table is missing).
- `invoices` - header (company from Contacts, which fills address and contact person; job name; order
  number; date) with the `invoices_subform` line items (amount = quantity x rate; units each/Hrs/km/LS/no.)
  and a pop-up Breakdown (`invoices_notes_detail subform`: date, hours, km, expenses, comments, with totals).
  Subtotal, GST at 12.5% and total due are calculated on screen. Find, Preview, Print and Delete Invoice buttons.
- `invoicesDialogBox` - date range for the Invoices Summary Report.

## Reports

| Report | Source | Content |
|---|---|---|
| `Transactions` | `Transactionsquery` | Date, reference, code, description, payment, receipt, running bank balance from the dialog's opening balance; totals. Refuses to open unless the dialog form is open |
| `transactions_grouped` | `Transactionsquery` | Grouped by ledger code (description / sub description): date, reference, business expenses, business income, GST, gross, with subtotals per code and grand totals |
| `Transactions_new` | `Transactionsquery` | An unfinished copy of `Transactions` (caption "Report1"); nothing opens it |
| `ledger_accounts` | `ledger_accounts` | Chart of accounts listing |
| `quick_codes` | `quick_codes` joined to ledger accounts | Quick codes with their auto code descriptions |
| `Contacts` | `contacts` | Contact list |
| `invoices` | the invoice open on the Invoices form | The tax invoice |
| `Invoices_report` | `Invoicesquery` | Invoices Summary Report for a date range |

## Modules and macro

- `IsLoadedModule` - `IsLoaded(formName)`: is a form open (not in design view). Used by the reports.
- `Module1` - `GetBrowse()` / `BrowseForFolder()`: the Windows Browse for Folder dialog through shell32 API
  calls. The declarations are 32-bit only.
- Macro `SaveRecord` - runs the Save Record command.

## Facts about the data worth knowing

Counts only; no amounts are recorded here.

- Roughly 500 to 1,100 transactions a year; about 88% are payments.
- 86% of references use the `bk` scheme; the rest are older cheque-book numbers and special prefixes.
- No transaction is currently locked.
- Stored GST matches 12.5% of the GST-exclusive amount up to September 2018 and 15% after - see
  BUGS_AND_IMPROVEMENTS item 1.
