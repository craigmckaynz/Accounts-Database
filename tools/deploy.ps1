# Puts McKay Accounts into a shared folder (the company folder on the NAS) so any computer can run it from
# there, one person at a time. Run it again after a change to update the program; the data is never touched
# by an update.
#
#   powershell -ExecutionPolicy Bypass -File tools\deploy.ps1                       update the program
#   powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 -InitialDataFrom C:\claude\accounts-data\accounts.sqlite
#                                                                                   first time: also copy the data in
#
# The folder ends up as:
#   <Target>\app\                      the program (server, built screens, the two libraries it needs)
#   <Target>\data\accounts.sqlite      the accounts; data\backups\ holds a dated copy per day used
#   <Target>\Install on this computer.cmd   run once on each computer to get the McKay Accounts shortcut
#   <Target>\READ ME.txt
param(
  [string]$Target = "Z:\Craig\McKay Consultants Ltd\McKay Accounts",
  [string]$InitialDataFrom = ""
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$src = Join-Path $repo 'app'
$appOut = Join-Path $Target 'app'
$dataOut = Join-Path $Target 'data'

# Nobody may be using it while the program files change underneath them.
$inUse = Join-Path $dataOut 'in-use.json'
if (Test-Path $inUse) {
  $age = ((Get-Date) - (Get-Item $inUse).LastWriteTime).TotalMinutes
  if ($age -lt 3) { $who = Get-Content $inUse -Raw | ConvertFrom-Json; throw "McKay Accounts is open on $($who.computer) ($($who.user)). Close it there first." }
}

Push-Location $src
try {
  "Testing..."
  & npm test --silent | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The tests failed; nothing was copied." }
  "Building the screens..."
  & npm run build --silent | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The build failed; nothing was copied." }
} finally { Pop-Location }

# Only the libraries the running program needs (not the build tools), fetched into a scratch folder.
$stage = Join-Path $env:TEMP 'mckay-accounts-stage'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item (Join-Path $src 'package.json'), (Join-Path $src 'package-lock.json') $stage
Push-Location $stage
try { "Fetching libraries..."; & npm ci --omit=dev --silent | Out-Null; if ($LASTEXITCODE -ne 0) { throw "npm could not fetch the libraries." } } finally { Pop-Location }

New-Item -ItemType Directory -Force $appOut, $dataOut | Out-Null
"Copying the program to $appOut ..."
foreach ($dir in 'server', 'shared', 'dist') { & robocopy (Join-Path $src $dir) (Join-Path $appOut $dir) /MIR /NFL /NDL /NJH /NJS /NP /XD test | Out-Null; if ($LASTEXITCODE -ge 8) { throw "Copying $dir failed." } }
& robocopy (Join-Path $stage 'node_modules') (Join-Path $appOut 'node_modules') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying the libraries failed." }
Copy-Item (Join-Path $src 'package.json'), (Join-Path $src 'launch.ps1'), (Join-Path $src 'accounts.ico'), (Join-Path $repo 'tools\make-shortcut.ps1') $appOut -Force
$global:LASTEXITCODE = 0

if ($InitialDataFrom) {
  $db = Join-Path $dataOut 'accounts.sqlite'
  if (Test-Path $db) { throw "There is already data at $db. It was left alone. (Remove -InitialDataFrom to update only the program.)" }
  "Copying the accounts data..."
  # A clean single-file copy made by SQLite itself, so nothing half-written comes across.
  & node (Join-Path $src 'server/copy-data.js') $InitialDataFrom $db
  if ($LASTEXITCODE -ne 0) { throw "Copying the data failed." }
}

Set-Content -Path (Join-Path $Target 'Install on this computer.cmd') -Encoding ASCII -Value @'
@echo off
rem Run this once on each computer that will use McKay Accounts. It puts the shortcut on the desktop and in
rem the Start menu. Node.js must be installed on the computer (https://nodejs.org, the LTS version).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\make-shortcut.ps1"
echo.
echo Done. Use the McKay Accounts shortcut on the desktop.
pause
'@
Set-Content -Path (Join-Path $Target 'READ ME.txt') -Encoding UTF8 -Value @"
McKay Accounts
==============

The company cashbook: bank transactions, bank statement import, reports for the accountant, problem finder.

To use it on a computer
  1. Install Node.js once (https://nodejs.org - the LTS version, all the default choices).
  2. Double-click "Install on this computer.cmd" in this folder. It adds the McKay Accounts shortcut.
  3. Open McKay Accounts from the shortcut.

One person at a time
  Only one computer can have the accounts open. If someone else has them open you are told who.
  Closing the McKay Accounts window hands them back within about a minute.

Where things are
  data\accounts.sqlite     the accounts themselves
  data\backups\            one dated copy for each day the accounts were used (the newest 30 are kept)
  app\                     the program - do not edit; it is replaced when the program is updated

Do not open, copy over or move data\accounts.sqlite while the accounts are in use.

Program source and change history: https://github.com/craigmckaynz/Accounts-Database
Updated $(Get-Date -Format 'd MMM yyyy') from version $((Get-Content (Join-Path $src 'package.json') -Raw | ConvertFrom-Json).version).
"@
"Done: $Target"
