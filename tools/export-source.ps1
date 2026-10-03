# Exports every form, report, macro, module and saved query of the Accounts database as text
# (Access SaveAsText), so the design and VBA can be tracked in git. No table data is exported.
# Run with 32-bit PowerShell (Office is 32-bit):
#   C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -ExecutionPolicy Bypass -File tools\export-source.ps1
# It works on a COPY: -Master is copied to -Work first and only the copy is opened.
param(
  [string]$Master = "Z:\Craig\McKay Consultants Ltd\Accounts Database\McKay Consultants Accounts V6.20.accdb",
  [string]$Work = "C:\claude\accounts-work\accounts-copy.accdb",
  [string]$OutDir = "$PSScriptRoot\..\source",
  [switch]$NoCopy          # export the existing working copy as it is (e.g. after editing it)
)
$ErrorActionPreference = 'Stop'
if (-not $NoCopy) {
  New-Item -ItemType Directory -Force (Split-Path -Parent $Work) | Out-Null
  Copy-Item -LiteralPath $Master -Destination $Work -Force
}
if ((Resolve-Path -LiteralPath $Work).Path -eq $Master) { throw "Refusing to open the master. Work on a copy." }
$OutDir = [IO.Path]::GetFullPath($OutDir)

# List the objects with DAO (read-only), then let Access write each one out.
$engine = New-Object -ComObject DAO.DBEngine.120
$dbo = $engine.OpenDatabase($Work, $false, $true)
$objects = [ordered]@{}
foreach ($c in 'Forms', 'Reports', 'Scripts', 'Modules') {
  $names = @(); foreach ($d in $dbo.Containers.Item($c).Documents) { if ($d.Name -notlike '~*') { $names += $d.Name } }
  $objects[$c] = @($names | Sort-Object)
}
$queries = @(); foreach ($q in $dbo.QueryDefs) { if ($q.Name -notlike '~*') { $queries += $q.Name } }
$dbo.Close()

$kinds = @(
  @{ container = 'Forms';   type = 2; dir = 'forms';   ext = 'form.txt' },
  @{ container = 'Reports'; type = 3; dir = 'reports'; ext = 'report.txt' },
  @{ container = 'Scripts'; type = 4; dir = 'macros';  ext = 'macro.txt' },
  @{ container = 'Modules'; type = 5; dir = 'modules'; ext = 'bas' }
)
function SafeName($n) { return ($n -replace '[\\/:*?"<>|]', '_') }

# Lines that change on every save without the design changing. Dropped so diffs stay readable; Access rebuilds
# them when the text is loaded back with LoadFromText. The page setup blocks (PrtMip, PrtDevMode: margins,
# orientation, paper size) are KEPT - without them a reloaded report falls back to the default printer's portrait A4.
function CleanText($text) {
  $out = New-Object System.Collections.Generic.List[string]
  $skip = $false; $prev = ''
  foreach ($line in ($text -split "`r?`n")) {
    if ($skip) { if ($line -match '^\s*End\s*$') { $skip = $false }; continue }
    if ($line -match '^\s*(PrtDevNames|PrtDevNamesW|NameMap|GUID)\s*=\s*Begin\s*$') { $skip = $true; continue }
    if ($line -match '^\s*(Checksum|PublishOption|WebImagePadding\w+)\s*=') { continue }
    if ($line -eq $prev -and $line -match '^\s*NoSaveCTIWhenDisabled\s*=') { continue }
    $prev = $line
    $out.Add($line)
  }
  return ($out -join "`r`n")
}

$acc = New-Object -ComObject Access.Application
$acc.AutomationSecurity = 3      # no VBA or macros run while it is open
$acc.Visible = $false
$count = 0
try {
  $acc.OpenCurrentDatabase($Work, $false)
  try { $acc.DoCmd.Close(2, $acc.CurrentDb().Properties.Item('StartUpForm').Value, 2) } catch {}
  $tmp = Join-Path $env:TEMP "accexport.tmp"
  foreach ($k in $kinds) {
    $dir = Join-Path $OutDir $k.dir
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    New-Item -ItemType Directory -Force $dir | Out-Null
    foreach ($name in $objects[$k.container]) {
      $acc.SaveAsText($k.type, $name, $tmp)
      $bytes = [IO.File]::ReadAllBytes($tmp)
      if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) { $text = [Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2) }
      else { $text = [Text.Encoding]::GetEncoding(1252).GetString($bytes) }
      if ($k.type -ne 5) { $text = CleanText $text }
      [IO.File]::WriteAllText((Join-Path $dir ((SafeName $name) + '.' + $k.ext)), $text, (New-Object Text.UTF8Encoding $false))
      $count++
    }
  }
  $dir = Join-Path $OutDir 'queries'
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
  New-Item -ItemType Directory -Force $dir | Out-Null
  $db = $acc.CurrentDb()
  foreach ($name in $queries) {
    [IO.File]::WriteAllText((Join-Path $dir ((SafeName $name) + '.sql')), $db.QueryDefs.Item($name).SQL, (New-Object Text.UTF8Encoding $false))
    $count++
  }
  Remove-Item $tmp -ErrorAction SilentlyContinue
}
finally {
  try { $acc.CloseCurrentDatabase() } catch {}
  $acc.Quit(2)
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($acc)
}
"exported $count objects to $OutDir"
