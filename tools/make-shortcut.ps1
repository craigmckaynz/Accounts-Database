# Creates the "McKay Accounts" shortcut on the desktop and in the Start menu, with its own icon.
# Windows does not let a program pin to the taskbar: right-click the desktop shortcut and choose
# "Pin to taskbar" (under "Show more options" on Windows 11).
#   powershell -ExecutionPolicy Bypass -File tools\make-shortcut.ps1
$ErrorActionPreference = 'Stop'
$app = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\app'))
$icon = Join-Path $app 'accounts.ico'

# The icon: a teal rounded square with a white M, as on the app's side bar. Drawn at 256 px and stored as a
# PNG inside the .ico, which Windows scales for the taskbar and desktop.
if (-not (Test-Path $icon)) {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap 256, 256
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 56; $d = $r * 2; $s = 240; $o = 8
  $path.AddArc($o, $o, $d, $d, 180, 90); $path.AddArc($o + $s - $d, $o, $d, $d, 270, 90)
  $path.AddArc($o + $s - $d, $o + $s - $d, $d, $d, 0, 90); $path.AddArc($o, $o + $s - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(15, 118, 110))), $path)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 26
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $g.DrawLines($pen, [System.Drawing.Point[]]@((New-Object System.Drawing.Point 68, 180), (New-Object System.Drawing.Point 68, 84), (New-Object System.Drawing.Point 128, 144), (New-Object System.Drawing.Point 188, 84), (New-Object System.Drawing.Point 188, 180)))
  $g.Dispose()
  $ms = New-Object IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $png = $ms.ToArray()
  $out = New-Object IO.MemoryStream
  $w = New-Object IO.BinaryWriter $out
  $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)          # ICONDIR: one image
  $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0)   # 256 x 256, no palette
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$png.Length); $w.Write([uint32]22)
  $w.Write($png)
  [IO.File]::WriteAllBytes($icon, $out.ToArray())
}

$shell = New-Object -ComObject WScript.Shell
$places = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
foreach ($place in $places) {
  $lnk = $shell.CreateShortcut((Join-Path $place 'McKay Accounts.lnk'))
  $lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$app\launch.ps1`""
  $lnk.WorkingDirectory = $app
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = 'McKay Consultants accounts'
  $lnk.WindowStyle = 7          # minimised, so no console window flashes up
  $lnk.Save()
  "Shortcut: $(Join-Path $place 'McKay Accounts.lnk')"
}
