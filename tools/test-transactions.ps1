# Tests the Transactions form's totals in a SCRATCH copy of the working copy (the scratch copy is written to
# and deleted). Checks that: the VBA compiles; displaying records changes no data; CalcTotals uses the GST
# rate for the transaction's date. Prints counts and pass/fail only - no amounts.
# Run with 32-bit PowerShell, Access closed:
#   C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -ExecutionPolicy Bypass -File tools\test-transactions.ps1
param(
  [string]$Work = "C:\claude\accounts-work\accounts-copy.accdb",
  [int]$Browse = 400        # how many records to step through
)
$ErrorActionPreference = 'Stop'
$scratch = Join-Path (Split-Path -Parent $Work) "test-scratch.accdb"
Copy-Item -LiteralPath $Work -Destination $scratch -Force
$fail = 0
function Check($name, $ok) { if ($ok) { "PASS  $name" } else { "FAIL  $name"; $script:fail++ } }

# A fingerprint of every stored figure, to prove nothing moved.
function Fingerprint($db) {
  $r = $db.OpenRecordset("SELECT Count(*) AS n, Sum(Gross_Total) AS g, Sum(GST_Total) AS t, Sum(Payment) AS p, Sum(Receipt) AS r, Sum(GST_Total*transaction_id) AS w FROM transactions")
  $s = "$($r.Fields.Item('n').Value)|$($r.Fields.Item('g').Value)|$($r.Fields.Item('t').Value)|$($r.Fields.Item('p').Value)|$($r.Fields.Item('r').Value)|$($r.Fields.Item('w').Value)"
  $r.Close(); return $s
}
# PowerShell's COM adapter cannot see an Access form's own members; Visual Basic's late binding can.
[void][Reflection.Assembly]::LoadWithPartialName('Microsoft.VisualBasic')
function CalcOnForm { [void][Microsoft.VisualBasic.Interaction]::CallByName($acc.Forms.Item('Transactions'), 'CalcTotals', 'Method', @()) }
function LabelOnForm {
  $lbl = [Microsoft.VisualBasic.Interaction]::CallByName($acc.Forms.Item('Transactions'), 'lblGSTPercent', 'Get', @())
  return [Microsoft.VisualBasic.Interaction]::CallByName($lbl, 'Caption', 'Get', @())
}
function One($db, $sql) { $r = $db.OpenRecordset($sql); $v = if ($r.EOF) { $null } else { $r.Fields.Item(0).Value }; $r.Close(); return $v }

$before = @(Get-Process MSACCESS -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$acc = New-Object -ComObject Access.Application
$acc.AutomationSecurity = 1      # the form's own code must run for this test
$acc.Visible = $false
try {
  $acc.OpenCurrentDatabase($scratch, $true)
  try { $acc.DoCmd.Close(2, 'forms_switchboard', 2) } catch {}
  $db = $acc.CurrentDb()

  $acc.DoCmd.OpenModule('Module1')
  $acc.RunCommand(126)           # acCmdCompileAndSaveAllModules
  Check "VBA compiles" $acc.IsCompiled
  try { $acc.DoCmd.Close(5, 'Module1', 2) } catch {}

  # 1. Displaying records must not change anything.
  $fp0 = Fingerprint $db
  $acc.DoCmd.OpenForm('Transactions')
  $total = One $db "SELECT Count(*) FROM transactions"
  $step = [Math]::Max(1, [int][Math]::Floor($total / $Browse))
  $seen = 0
  for ($i = 1; $i -le $total; $i += $step) { $acc.DoCmd.GoToRecord(2, 'Transactions', 4, $i); $seen++ }   # acDataForm, acGoTo
  $acc.DoCmd.GoToRecord(2, 'Transactions', 3)     # last
  $acc.DoCmd.GoToRecord(2, 'Transactions', 2)     # first
  $acc.DoCmd.Close(2, 'Transactions', 2)
  Check "displaying $seen records across all years changed no stored figure" ((Fingerprint $db) -eq $fp0)

  # 2. CalcTotals uses the rate in force on the transaction date.
  $cases = @(
    @{ label = '2005 payment (12.5%)'; where = "transaction_date BETWEEN #2005-01-01# AND #2005-12-31# AND Payment_receipt='Payment'"; factor = 1 / 9 },
    @{ label = '2012 payment (15%)';   where = "transaction_date BETWEEN #2012-01-01# AND #2012-12-31# AND Payment_receipt='Payment'"; factor = 3 / 23 },
    @{ label = '2012 receipt (15%)';   where = "transaction_date BETWEEN #2012-01-01# AND #2012-12-31# AND Payment_receipt='Receipt'"; factor = 3 / 23 },
    @{ label = '2024 payment (15%)';   where = "transaction_date BETWEEN #2024-01-01# AND #2024-12-31# AND Payment_receipt='Payment'"; factor = 3 / 23 }
  )
  foreach ($c in $cases) {
    $id = One $db ("SELECT TOP 1 t.transaction_id FROM transactions AS t INNER JOIN ledger_accounts AS l ON t.Account_Code = l.account_code WHERE l.GST_exempt = False AND t.transaction_total > 20 AND " + ($c.where -replace 'transaction_date', 't.transaction_date' -replace 'Payment_receipt', 't.Payment_receipt') + " ORDER BY t.transaction_id")
    if ($null -eq $id) { Check "$($c.label): a test record exists" $false; continue }
    $acc.DoCmd.OpenForm('Transactions', 0, '', "transaction_id = $id")
    CalcOnForm
    $caption = LabelOnForm
    $acc.DoCmd.Close(2, 'Transactions', 2)
    $r = $db.OpenRecordset("SELECT transaction_total, Gross_Total, GST_Total, Payment, Receipt, Payment_receipt FROM transactions WHERE transaction_id = $id")
    $tot = [double]$r.Fields.Item('transaction_total').Value; $gst = [double]$r.Fields.Item('GST_Total').Value; $gross = [double]$r.Fields.Item('Gross_Total').Value
    $isPay = $r.Fields.Item('Payment_receipt').Value -eq 'Payment'
    $pay = $r.Fields.Item('Payment').Value; $rec = $r.Fields.Item('Receipt').Value
    $r.Close()
    $sign = if ($isPay) { -1 } else { 1 }
    Check "$($c.label): GST is the right share of the total" ([Math]::Abs($gst - $sign * $tot * $c.factor) -lt 0.0001)
    Check "$($c.label): gross, payment and receipt are right" (($gross -eq $sign * $tot) -and $(if ($isPay) { ([double]$pay -eq -$tot) -and ($rec -is [DBNull]) } else { ([double]$rec -eq $tot) -and ($pay -is [DBNull]) }))
    $want = if ($c.factor -lt 0.12) { '(12.5%)' } else { '(15%)' }
    Check "$($c.label): label shows $want (got $caption)" ($caption -eq $want)
  }

  # 3. An exempt ledger code still gives zero GST.
  $id = One $db "SELECT TOP 1 t.transaction_id FROM transactions AS t INNER JOIN ledger_accounts AS l ON t.Account_Code = l.account_code WHERE l.GST_exempt = True AND t.transaction_total > 20 AND t.transaction_date > #2020-01-01# ORDER BY t.transaction_id"
  $acc.DoCmd.OpenForm('Transactions', 0, '', "transaction_id = $id")
  CalcOnForm
  $caption = LabelOnForm
  $acc.DoCmd.Close(2, 'Transactions', 2)
  Check "exempt ledger code: GST is zero, label (0%) (got $caption)" (([double](One $db "SELECT GST_Total FROM transactions WHERE transaction_id = $id") -eq 0) -and ($caption -eq '(0%)'))

  # 4. Recalculating records already at 15% reproduces the stored figure exactly (same arithmetic as before).
  $ids = @(); $r = $db.OpenRecordset("SELECT TOP 40 t.transaction_id FROM transactions AS t INNER JOIN ledger_accounts AS l ON t.Account_Code = l.account_code WHERE l.GST_exempt = False AND t.transaction_date >= #2019-01-01# AND Abs(t.GST_Total) > 0 ORDER BY t.transaction_total DESC, t.transaction_id")
  while (-not $r.EOF) { $ids += $r.Fields.Item(0).Value; $r.MoveNext() }; $r.Close()
  $fpA = Fingerprint $db
  foreach ($id in $ids) {
    $acc.DoCmd.OpenForm('Transactions', 0, '', "transaction_id = $id")
    CalcOnForm
    $acc.DoCmd.Close(2, 'Transactions', 2)
  }
  Check "recalculating $($ids.Count) records from 2019 on leaves them exactly as stored" ((Fingerprint $db) -eq $fpA)
}
finally {
  try { $acc.CloseCurrentDatabase() } catch {}
  try { $acc.Quit(2) } catch {}
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($acc)
  Start-Sleep -Milliseconds 800
  Get-Process MSACCESS -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $scratch -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath ($scratch -replace '\.accdb$', '.laccdb') -Force -ErrorAction SilentlyContinue
}
if ($fail) { "$fail check(s) FAILED"; exit 1 } else { "all checks passed" }
