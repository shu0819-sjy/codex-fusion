$f = 'D:\CodexFusion\tests\tiny-cn.ps1'
$bytes = [System.IO.File]::ReadAllBytes($f)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
"tiny-cn bytes=$($bytes.Length) hasBom=$hasBom"
($bytes | Select-Object -First 16 | ForEach-Object { $_.ToString('X2') }) -join ' '

$txt = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)
if (-not $hasBom) {
  [System.IO.File]::WriteAllText($f, $txt, (New-Object System.Text.UTF8Encoding($true)))
  "rewritten with BOM"
}
$after = [System.IO.File]::ReadAllBytes($f)
$bom2 = ($after[0] -eq 0xEF -and $after[1] -eq 0xBB -and $after[2] -eq 0xBF)
"after hasBom=$bom2 bytes=$($after.Length)"

"powershell processes:"
$procs = @(Get-Process -Name powershell -ErrorAction SilentlyContinue)
"count=$($procs.Count)"
foreach ($p in $procs) { "  pid=$($p.Id) start=$($p.StartTime.ToString('HH:mm:ss'))" }
