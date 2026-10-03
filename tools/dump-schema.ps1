# Dumps the structure of the Accounts database (tables, fields, indexes, relations, saved queries,
# and the names of forms/reports/macros/modules) to JSON. Structure only - no rows are read.
# Run with 32-bit PowerShell (Office is 32-bit):
#   C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -ExecutionPolicy Bypass -File tools\dump-schema.ps1
# Always point it at a COPY of the database (the default), never the master on Z:.
param(
  [string]$DbPath = "C:\claude\accounts-work\accounts-copy.accdb",
  [string]$Out = "$PSScriptRoot\..\source\schema.json"
)
$ErrorActionPreference = 'Continue'
$engine = New-Object -ComObject DAO.DBEngine.120
$dbo = $engine.OpenDatabase($DbPath, $false, $true)   # shared, read-only

function PropVal($obj, $name) { try { return $obj.Properties.Item($name).Value } catch { return $null } }

$result = [ordered]@{ tables = @(); queries = @(); relations = @(); objects = [ordered]@{}; dbprops = [ordered]@{} }
foreach ($p in $dbo.Properties) { try { $v = $p.Value; if ($v -is [string] -or $v -is [int] -or $v -is [bool] -or $v -is [int16]) { $result.dbprops[$p.Name] = $v } } catch {} }

foreach ($td in $dbo.TableDefs) {
  if ($td.Name -like 'MSys*' -or $td.Name -like '~*') { continue }
  $t = [ordered]@{ name = $td.Name; connect = $td.Connect; sourceTable = $td.SourceTableName; recordCount = $td.RecordCount; description = (PropVal $td 'Description'); fields = @(); indexes = @() }
  foreach ($f in $td.Fields) {
    $t.fields += [ordered]@{
      name = $f.Name; type = $f.Type; size = $f.Size; attributes = $f.Attributes; required = $f.Required
      allowZeroLength = $f.AllowZeroLength; defaultValue = $f.DefaultValue; validationRule = $f.ValidationRule; validationText = $f.ValidationText
      ordinal = $f.OrdinalPosition
      format = (PropVal $f 'Format'); decimalPlaces = (PropVal $f 'DecimalPlaces'); caption = (PropVal $f 'Caption'); inputMask = (PropVal $f 'InputMask')
      displayControl = (PropVal $f 'DisplayControl'); rowSourceType = (PropVal $f 'RowSourceType'); rowSource = (PropVal $f 'RowSource')
      boundColumn = (PropVal $f 'BoundColumn'); columnCount = (PropVal $f 'ColumnCount'); limitToList = (PropVal $f 'LimitToList')
      description = (PropVal $f 'Description')
    }
  }
  foreach ($ix in $td.Indexes) {
    $cols = @(); foreach ($c in $ix.Fields) { $cols += $c.Name }
    $t.indexes += [ordered]@{ name = $ix.Name; primary = $ix.Primary; unique = $ix.Unique; foreign = $ix.Foreign; fields = $cols }
  }
  $result.tables += $t
}
foreach ($qd in $dbo.QueryDefs) {
  if ($qd.Name -like '~*') { continue }
  $params = @(); foreach ($p in $qd.Parameters) { $params += [ordered]@{ name = $p.Name; type = $p.Type } }
  $result.queries += [ordered]@{ name = $qd.Name; type = $qd.Type; sql = $qd.SQL; parameters = $params }
}
foreach ($r in $dbo.Relations) {
  $flds = @(); foreach ($f in $r.Fields) { $flds += [ordered]@{ name = $f.Name; foreignName = $f.ForeignName } }
  $result.relations += [ordered]@{ name = $r.Name; table = $r.Table; foreignTable = $r.ForeignTable; attributes = $r.Attributes; fields = $flds }
}
foreach ($c in 'Forms', 'Reports', 'Scripts', 'Modules') {
  $names = @(); foreach ($d in $dbo.Containers.Item($c).Documents) { if ($d.Name -notlike '~*') { $names += $d.Name } }
  $result.objects[$c] = @($names | Sort-Object)
}
$dbo.Close()
$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
$result | ConvertTo-Json -Depth 8 | Out-File -Encoding utf8 $Out
"tables=$($result.tables.Count) queries=$($result.queries.Count) relations=$($result.relations.Count) forms=$($result.objects.Forms.Count) reports=$($result.objects.Reports.Count) macros=$($result.objects.Scripts.Count) modules=$($result.objects.Modules.Count)"
