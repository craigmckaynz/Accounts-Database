# Opens McKay Accounts in its own window. Starts the server quietly if it is not already running.
# The desktop / taskbar shortcut runs this; tools\make-shortcut.ps1 creates that shortcut.
$ErrorActionPreference = 'Stop'
$app = $PSScriptRoot
$port = 4310
$url = "http://localhost:$port"

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
  if (-not $node) { Show-Problem 'Node.js is not installed, so McKay Accounts cannot start.'; exit 1 }
  Set-Location $app
  if (-not (Test-Path (Join-Path $app 'node_modules'))) { & npm install | Out-Null }
  if (-not (Test-Path (Join-Path $app 'dist\index.html'))) { & npm run build | Out-Null }
  $log = Join-Path $env:LOCALAPPDATA 'McKayAccounts'
  New-Item -ItemType Directory -Force $log | Out-Null
  Start-Process -FilePath $node -ArgumentList 'server\index.js' -WorkingDirectory $app -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $log 'server.log') -RedirectStandardError (Join-Path $log 'server-errors.log')
  $ok = $false
  foreach ($i in 1..40) { Start-Sleep -Milliseconds 250; if (Test-Running) { $ok = $true; break } }
  if (-not $ok) { Show-Problem "McKay Accounts did not start. See $log\server-errors.log"; exit 1 }
}

# Its own window, without browser tabs or address bar, when Edge or Chrome is there; otherwise the default browser.
$browser = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($browser) { Start-Process -FilePath $browser -ArgumentList "--app=$url" } else { Start-Process $url }
