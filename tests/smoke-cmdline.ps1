# 只读侦查：抓取关键进程的完整命令行，判断 PID 29688 的真实归属与 CDP 端口。
$ErrorActionPreference = 'SilentlyContinue'
Set-Location C:\codex-fusion
. .\switch-common.ps1
$paths = Get-FusionSwitchPaths
Assert-FusionDreamSkinLibrary -Paths $paths
. $paths.CommonScript
. $paths.ThemeScript

$st = if (Test-Path -LiteralPath $paths.StatePath) { Read-DreamSkinState -Path $paths.StatePath } else { $null }
$official = @()
foreach ($i in @(Get-DreamSkinRegisteredCodexInstalls)) { $official += [string]$i.Executable }
$snap = @(Get-FusionProcessSnapshot)
$tok = Get-FusionProfileToken -ProfilePath $st.profilePath
$mode = Get-FusionMode -Snapshot $snap -OfficialExecutables $official -DreamSkinProfileToken $tok `
  -CodeCodexRoot $paths.CodeCodexRoot -DreamSkinExecutable $st.codexExe

Write-Output "=== 所有 ChatGPT.exe 进程的完整命令行 ==="
$allChat = @($snap | Where-Object { "$($_.Name)" -ieq 'ChatGPT.exe' })
Write-Output ("count=" + $allChat.Count)
foreach ($p in $allChat) {
  Write-Output "---- PID $($p.ProcessId) parent=$($p.ParentProcessId) ----"
  Write-Output ("  exe: " + $p.ExecutablePath)
  Write-Output ("  cmd: " + $p.CommandLine)
}

Write-Output ""
Write-Output "=== 9335 之外所有 ChatGPT.exe 的 CDP 端口 (从命令行正则抽取) ==="
foreach ($p in $allChat) {
  $cl = "$($p.CommandLine)"
  $port = $null
  if ($cl -match '(?i)--remote-debugging-port(?:=|\s+)(\d+)') { $port = $Matches[1] }
  $addr = $null
  if ($cl -match '(?i)--remote-debugging-address(?:=|\s+)(\S+)') { $addr = $Matches[1] }
  $hasDsTok = $tok -and (Test-FusionCommandLineToken -CommandLine $cl -Token $tok)
  Write-Output ("PID $($p.ProcessId): port=$port addr=$addr dreamSkinToken=$hasDsTok")
}

Write-Output ""
Write-Output "=== 所有 Code-Codex 安装根下的进程 ==="
@(Get-Process -ErrorAction SilentlyContinue) | Where-Object {
  "$($_.Path)" -and "$($_.Path)".StartsWith($paths.CodeCodexRoot, [System.StringComparison]::OrdinalIgnoreCase)
} | ForEach-Object { Write-Output ("PID " + $_.Id + " | " + $_.ProcessName + " | " + $_.Path) }
Write-Output "(若上方为空说明 CodeCodex.exe 未运行)"
