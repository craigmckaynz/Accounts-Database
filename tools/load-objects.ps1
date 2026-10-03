# Loads edited text exports from source/ back into the WORKING COPY of the database (Access LoadFromText),
# so a change made in git can be tried in Access. It never opens the master.
# Run with 32-bit PowerShell, Access closed:
#   C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -ExecutionPolicy Bypass -File tools\load-objects.ps1 -Objects "forms/Transactions","modules/Module1"
# Names are <folder>/<object name> as they appear under source/ (without the extension).
param(
  [Parameter(Mandatory = $true)][string]$Objects,
  [string]$Work = "C:\claude\accounts-work\accounts-copy.accdb",
  [string]$SourceDir = ""
)
$ErrorActionPreference = 'Stop'
if (-not $SourceDir) { $SourceDir = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\source" }
if ($Work -like 'Z:\*') { throw "Refusing to load into a database on Z:. Load into the working copy and install by hand (see CLAUDE.md)." }
$SourceDir = [IO.Path]::GetFullPath($SourceDir)
$kinds = @{ forms = @{ type = 2; ext = 'form.txt' }; reports = @{ type = 3; ext = 'report.txt' }; macros = @{ type = 4; ext = 'macro.txt' }; modules = @{ type = 5; ext = 'bas' } }

$acc = New-Object -ComObject Access.Application
$acc.AutomationSecurity = 3
$acc.Visible = $false
try {
  $acc.OpenCurrentDatabase($Work, $true)
  try { $acc.DoCmd.Close(2, $acc.CurrentDb().Properties.Item('StartUpForm').Value, 2) } catch {}
  foreach ($o in ($Objects -split ',')) {
    $o = $o.Trim(); if (-not $o) { continue }
    $folder, $name = $o -split '/', 2
    $k = $kinds[$folder]
    if (-not $k) { throw "Unknown folder '$folder' in '$o' (forms, reports, macros or modules; queries are changed in Access or by SQL)." }
    $file = Join-Path (Join-Path $SourceDir $folder) ($name + '.' + $k.ext)
    if (-not (Test-Path -LiteralPath $file)) { throw "No such export: $file" }
    # Access wants UTF-16 for forms/reports/macros and ANSI for modules.
    $text = [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8)
    $tmp = Join-Path $env:TEMP "accload.tmp"
    if ($k.type -eq 5) { [IO.File]::WriteAllText($tmp, $text, [Text.Encoding]::GetEncoding(1252)) }
    else { [IO.File]::WriteAllText($tmp, $text, [Text.Encoding]::Unicode) }
    $acc.LoadFromText($k.type, $name, $tmp)
    Remove-Item $tmp -ErrorAction SilentlyContinue
    "loaded $o"
  }
}
finally {
  try { $acc.CloseCurrentDatabase() } catch {}
  $acc.Quit(1)      # acQuitSaveAll
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($acc)
}
