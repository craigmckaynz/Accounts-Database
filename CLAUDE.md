# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

The design of **McKay Consultants Accounts**, a Microsoft Access cashbook Craig McKay wrote and has used
since 1995 for McKay Consultants Ltd's bank transactions, GST and year-end reporting. What it does is in
[README.md](README.md) and, object by object, in [docs/DATABASE.md](docs/DATABASE.md). Known faults and
their status are in [BUGS_AND_IMPROVEMENTS.md](BUGS_AND_IMPROVEMENTS.md).

Repo: https://github.com/craigmckaynz/Accounts-Database - checked out at `C:\claude\Accounts-Database`.

## Rules

1. **The repository is public. No accounting data goes into it.** No `.accdb`, no exports of table rows, no
   spreadsheets, no amounts, payee names or bank details in documents, commit messages or test files. Counts
   and dates are fine. `.gitignore` blocks the obvious file types; check `git status` before every commit.
2. **Never open the master for writing.** The master is
   `Z:\Craig\McKay Consultants Ltd\Accounts Database\McKay Consultants Accounts V6.20.accdb` (the number
   changes with each version). The tools copy it to `C:\claude\accounts-work\accounts-copy.accdb` and work
   there. Installing into the master is a step Craig does or explicitly approves each time.
3. **These are a company's accounts.** A change that alters a stored figure, or how a figure is calculated
   (GST, gross, balance, locking), needs Craig's sign-off before it is made, and its CHANGELOG entry states
   the rows affected. Never "tidy" data. Questions about what should have been filed are for Craig's
   accountant.
4. Read data in the copy only as far as the task needs, and prefer counts to rows.

## Tools

Office is 32-bit, so run everything with 32-bit PowerShell and with Access closed:

```
C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -ExecutionPolicy Bypass -File tools\<script>
```

| Script | What it does |
|---|---|
| `tools/export-source.ps1` | Copies the master to the working copy and exports every form, report, macro, module and query to `source/`. `-NoCopy` exports the working copy as it is (after editing it). `-Master` names a different master file |
| `tools/dump-schema.ps1` | Writes `source/schema.json`: tables, fields, indexes, relations, queries, object names. Structure only |
| `tools/test-transactions.ps1` | Runs the Transactions form's code in a scratch copy: compiles, proves displaying records changes nothing, checks GST by date. Prints pass/fail only |
| `tools/load-objects.ps1 -Objects "forms/Transactions,modules/Module1"` | Loads edited text from `source/` into the working copy. Refuses anything on Z: |

Both Access scripts open the database with macros and VBA disabled (`AutomationSecurity = 3`) and close the
start-up form, so nothing in the database runs.

Notes on the exports:

- Form and report files are Access `SaveAsText` output converted to UTF-8, with the lines that change on
  every save removed (`Checksum`, `NameMap`, `GUID`, `PrtDevNames`, `PublishOption`, `WebImagePadding*`).
  Page setup (`PrtMip`, `PrtDevMode`) is kept so a reloaded report keeps its orientation and margins.
- After a load and re-export, an object that was loaded shows changes in its `PrtDevMode` hex lines and
  sometimes in the capitalisation of a VBA name. That is noise. Only commit the files of objects actually
  changed (`git add -p` or by name), and `git checkout` the rest.
- Table design and query changes are not loaded from text. Make them in the working copy (Access, or DAO
  SQL in a script kept under `tools/changes/`), then re-run both export scripts so git records them.

## The update process

Every change, however small, goes through these steps.

1. **Start from the master.** Confirm with Craig that Access is closed on the master, then run
   `export-source.ps1` and `dump-schema.ps1`. If `git status` shows differences, the master was changed
   outside this process: commit that first as "Sync with master", so it is not mixed into the new work.
2. **Agree the change.** Find or add the item in BUGS_AND_IMPROVEMENTS.md and mark it `agreed`. For
   anything touching figures, write down what will change and get a yes first (rule 3).
3. **Make it in the working copy.** Either edit the text under `source/` and run `load-objects.ps1`, or
   change it in Access in the copy and run `export-source.ps1 -NoCopy`.
4. **Test in the working copy.** Open the copy in Access and exercise the change. For calculation changes,
   compare before and after with counts and totals queried from the copy, and say what was and was not
   tested. Compile the VBA (Debug > Compile) - a load does not check that it compiles.
5. **Record it.** Update docs/DATABASE.md if behaviour changed, mark the BUGS item `done (Vx.xx)`, add the
   CHANGELOG entry, update the version text on the switchboard, and commit with the version in the message.
6. **Install.** With Access closed everywhere:
   - copy the master to `...Accounts V6.20 backup yyyy-mm-dd.accdb` beside it;
   - if no transactions were entered in the master since step 1, copy the tested working copy over as the
     next version (`...Accounts V6.21.accdb`); otherwise re-run steps 1 and 3 on a fresh copy so no entries
     are lost - the master's data always wins;
   - Craig opens the new version, checks the bank balance equals what the old one showed, and enters a
     transaction;
   - keep the previous version and its backup until the new one has been used for a month.
7. **Tag and push.** `git tag v6.21`, push the branch and the tag.

## Working notes

- Forms' VBA lives at the end of each `source/forms/*.form.txt`, after the line `CodeBehindForm`.
- The Transactions form is the heart of it; `CalcTotals` and `FindNextRef` there hold nearly all the logic.
- Field names were tidied at some point (`Date` → `transaction_date`, table `Ledger Accounts` →
  `ledger_accounts`) and several objects still use the old names - that is behind many of the open bugs.
- `tools/load-objects.ps1` declares a mandatory parameter, which makes `$PSScriptRoot` empty in parameter
  defaults under PowerShell 5.1; the script works its folder out in the body instead.

## The JavaScript application (app/)

Craig asked on 4 Oct 2026 for the whole database to be redesigned as a JavaScript application: invoicing
dropped, the bugs and poor coding removed, modern and pleasant to use, with the bank balance matching as it
does now, reports to send the accountant for GST returns and year-end tax, and a "problem finder" for the
entry that stops the books balancing. The screen layout need not copy Access. [app/README.md](app/README.md)
describes what is built and what is not.

- Node 24+, Express, Vue 3, Vite, plain JavaScript, `node:sqlite`. Keep the SQL plain (PostgreSQL later).
- Real data: `C:claudeaccounts-dataaccounts.sqlite`, outside the repository. Demo data:
  `demo.sqlite` in the same folder (`npm run demo`). **Use the demo data for screenshots, browser checks and
  tests**; check the real data with counts and true/false comparisons only.
- Money is integer cents everywhere; `shared/money.js` is the only place GST arithmetic lives.
- After changing anything under `app/`: `npm test`, then `npm run build` (the server serves `dist/`), then
  check the screen on the demo data.
- The import must keep reporting "bank balance agrees with Access: YES". If it does not, stop and find out why.
- Stored GST on imported entries is not to be recalculated in bulk (BUGS_AND_IMPROVEMENTS item 1 is a
  decision for Craig and the accountant).
- Rules 1 to 4 above apply to the app as well.
