# 场景 6 实测：用户取消确认时，切换必须完全不发生（不关任何进程，不动任何配置）。
#
# 为什么以前只做了单元测试：确认对话框是 `WScript.Shell.Popup(..., 52)` 的模态 Win32 对话框，
# `echo no |` 之类往 stdin 灌答案根本到不了它。这里用 tests\close-fusion-prompt.ps1 按窗口标题
# 找到这个 #32770 对话框并点击「否」，等价于用户真的点了取消。
$ErrorActionPreference = 'Continue'
$fusion = 'C:\codex-fusion'
$ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Get-Roots {
  $out = @()
  foreach ($q in @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue)) {
    $cl = "$($q.CommandLine)"
    if ($cl -match '(?i)(?:^|\s)--type(?:=|\s+)') { continue }
    $kind = 'foreign'
    if ($cl -match 'CodexDreamSkin\\cdp-profile') { $kind = 'dream-skin' }
    elseif ($cl -match 'remote-debugging') { $kind = 'code-codex' }
    $out += "pid=$($q.ProcessId)[$kind]"
  }
  ($out | Sort-Object) -join ' '
}

function Get-Port9335 { @(Get-NetTCPConnection -LocalPort 9335 -State Listen -ErrorAction SilentlyContinue).Count }

"=== 0) 起点：必须处于 Dream Skin（这样取消才有东西可观察）==="
if ((Get-Roots) -notmatch 'dream-skin') {
  "起点不是 Dream Skin，先建立 Dream Skin 会话..."
  & $ps -NoProfile -ExecutionPolicy Bypass -File "$fusion\ensure-dream-skin-mode.ps1" -ResultPath "$fusion\logs\cancel-setup.json" *> "$fusion\logs\cancel-setup-console.txt"
  "SETUP_EXIT=$LASTEXITCODE"
  Start-Sleep -Seconds 6
}
$before = Get-Roots
$beforePort = Get-Port9335
"起点 root: $before"
"起点 9335 监听: $beforePort"

""
"=== 1) 起一次「切到 Code-Codex」，在对话框上点「否」==="
$result = "$fusion\logs\cancel-result.json"
if (Test-Path $result) { Remove-Item $result -Force }

# 后台等对话框并点「否」（不带 -AssumeYes，所以脚本一定会弹框等人）
$clicker = Start-Process -FilePath $ps -PassThru -WindowStyle Hidden -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', "$fusion\tests\close-fusion-prompt.ps1",
  '-TitleMatch', 'Codex Fusion', '-ButtonId', '7', '-TimeoutSeconds', '45'
)
Start-Sleep -Seconds 2

& $ps -NoProfile -ExecutionPolicy Bypass -File "$fusion\switch-to-code-codex.ps1" -ResultPath $result *> "$fusion\logs\cancel-switch-console.txt"
$switchExit = $LASTEXITCODE
"SWITCH_EXIT=$switchExit（期望 3 = Cancelled）"

$clicker | Wait-Process -Timeout 60 -ErrorAction SilentlyContinue

Start-Sleep -Seconds 5
$after = Get-Roots
$afterPort = Get-Port9335
"取消后 root: $after"
"取消后 9335 监听: $afterPort"

""
"=== 2) 判定 ==="
$verdict = @()
if ($switchExit -eq 3) { $verdict += 'PASS 退出码 3（cancelled）' } else { $verdict += "FAIL 退出码 $switchExit，期望 3" }
if (Test-Path $result) {
  $j = [System.IO.File]::ReadAllText($result) | ConvertFrom-Json
  "result: outcome=$($j.outcome) exitCode=$($j.exitCode)"
  "result message=$($j.message)"
  if ($j.outcome -eq 'cancelled') { $verdict += 'PASS 结果文件如实记录 cancelled' } else { $verdict += "FAIL 结果 outcome=$($j.outcome)" }
} else {
  $verdict += 'FAIL 没有写出结果文件'
}
if ($before -eq $after) { $verdict += 'PASS 进程完全没变（没关任何 Codex、没启动 Code-Codex）' } else { $verdict += "FAIL $before -> $after" }
if ($beforePort -eq $afterPort) { $verdict += 'PASS 9335 监听状态没变' } else { $verdict += "FAIL 端口 $beforePort -> $afterPort" }
$claim = "$fusion\state\code-codex-session.json"
if (Test-Path $claim) { $verdict += 'FAIL 竟然写入了会话凭据' } else { $verdict += 'PASS 没有写入会话凭据' }

$verdict | ForEach-Object { $_ }
if ($verdict -match '^FAIL') { "CANCEL_SMOKE=FAIL"; exit 1 }
"CANCEL_SMOKE=PASS"
