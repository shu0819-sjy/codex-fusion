# 把新建的 PowerShell 脚本统一为「UTF-8 with BOM」。
# 原因：Windows PowerShell 5.1 在缺少 BOM 时按 ANSI 读取脚本，中文注释与提示会变成乱码甚至解析失败。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$utf8Bom = [System.Text.UTF8Encoding]::new($true)
$targets = @(
  (Join-Path $root 'switch-common.ps1'),
  (Join-Path $root 'switch-to-code-codex.ps1'),
  (Join-Path $root 'switch-to-dream-skin.ps1'),
  (Join-Path $root 'tests\parse-switch-scripts.ps1')
)
foreach ($path in $targets) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    Write-Host "SKIP $path (missing)"
    continue
  }
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $text = [System.Text.UTF8Encoding]::new($false).GetString($bytes)
  if ($hasBom) { $text = $text.TrimStart([char]0xFEFF) }
  [System.IO.File]::WriteAllText($path, $text, $utf8Bom)
  Write-Host "OK   $([System.IO.Path]::GetFileName($path)) (bom-before=$hasBom)"
}
