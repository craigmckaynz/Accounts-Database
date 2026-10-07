# Opens McKay Accounts in its own window. Starts the program quietly if it is not already running on this
# computer. The "McKay Accounts" shortcut runs this (make-shortcut.ps1 creates the shortcut).
#
# It works from wherever this file is: a developer's checkout, or the shared company folder on the NAS. In the
# shared folder (a "data" folder beside "app") only one computer may have the accounts open at a time.
$ErrorActionPreference = 'Stop'
$app = $PSScriptRoot
$port = 4310
$url = "http://localhost:$port"

# If the accounts have moved (to the shared company folder), a file "moved-to.txt" beside this script holds the
# new app folder, and old shortcuts and taskbar pins that still point here are passed on to it.
$moved = Join-Path $app 'moved-to.txt'
if (Test-Path $moved) {
  $there = (Get-Content $moved -TotalCount 1).Trim()
  $launcher = Join-Path $there 'launch.ps1'
  if ($there -and ((Resolve-Path -LiteralPath $there -ErrorAction SilentlyContinue).Path -ne (Resolve-Path -LiteralPath $app).Path)) {
    if (Test-Path -LiteralPath $launcher) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $launcher; exit $LASTEXITCODE }
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show("McKay Accounts now lives in $there, which cannot be reached. Check the network drive is connected.", 'McKay Accounts', 'OK', 'Warning')
    exit 1
  }
}

function Test-Running {
  # 127.0.0.1, not localhost: PowerShell tries IPv6 first for "localhost" and waits seconds before falling back.
  try { $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/meta" -TimeoutSec 2; return $r.StatusCode -eq 200 } catch { return $false }
}
function Show-Problem($text) {
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show($text, 'McKay Accounts', 'OK', 'Warning')
}

if (-not (Test-Running)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Show-Problem "Node.js is not installed on this computer, so McKay Accounts cannot start.`n`nInstall it from https://nodejs.org (the LTS version, all the default choices), then try again."; exit 1 }
  $version = [version]((& $node --version).TrimStart('v'))
  if ($version -lt [version]'22.13.0') { Show-Problem "McKay Accounts needs Node.js 22.13 or newer; this computer has $version.`n`nInstall the current LTS version from https://nodejs.org, then try again."; exit 1 }

  if (-not (Test-Path (Join-Path $app 'node_modules'))) { Push-Location $app; & npm install | Out-Null; Pop-Location }
  if (-not (Test-Path (Join-Path $app 'dist\index.html'))) { Push-Location $app; & npm run build | Out-Null; Pop-Location }

  $log = Join-Path $env:LOCALAPPDATA 'McKayAccounts'
  New-Item -ItemType Directory -Force $log | Out-Null
  $errors = Join-Path $log 'server-errors.log'
  $server = Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $app 'server\index.js')`"" -WorkingDirectory $env:LOCALAPPDATA -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $log 'server.log') -RedirectStandardError $errors
  $ok = $false
  foreach ($i in 1..120) {            # up to 30 seconds: the first start from a network folder is slow
    Start-Sleep -Milliseconds 250
    if (Test-Running) { $ok = $true; break }
    if ($server.HasExited) { break }
  }
  if (-not $ok) {
    $why = if (Test-Path $errors) { (Get-Content $errors -Tail 3) -join "`n" } else { '' }
    if ($why -match 'IN USE: (.+)') { Show-Problem $Matches[1] }
    elseif ($why -match 'NO DATA: (.+)') { Show-Problem $Matches[1] }
    else { Show-Problem "McKay Accounts did not start.`n`n$why`n`nDetails: $errors" }
    exit 1
  }
}

# Its own window, without browser tabs or address bar, when Edge or Chrome is there; otherwise the default browser.
$browser = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($browser) { Start-Process -FilePath $browser -ArgumentList "--app=$url" } else { Start-Process $url }
