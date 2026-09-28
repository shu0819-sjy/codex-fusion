[CmdletBinding()]
param(
  [int]$Port = 9335,
  [string]$StateRoot,
  [string]$CodeCodexRoot,
  [string]$FusionRoot,
  [string]$ResultPath,
  [switch]$AssumeYes,
  [int]$PortReleaseTimeoutSeconds = 30,
  [int]$VerifyTimeoutSeconds = 120
)

# Code-Codex -> Dream Skin 切换。
# 行为约定：
#   1) 先向用户确认（同样提示未保存内容可能丢失）；
#   2) 只结束 Code-Codex 自己的进程（安装根目录内的启动器及其官方 Codex 后代），
#      不结束其他 Codex 会话；
#   3) 调用 Dream Skin 自己的手动入口 start-codex-and-panel.ps1 恢复；
#   4) 恢复后验证 CDP 端口与壁纸效果确实生效；
#   5) 恢复失败时如实报告，绝不再去结束别的进程来「凑」成功。

$ErrorActionPreference = 'Stop'

if (-not $StateRoot) { $StateRoot = Join-Path $env:LOCALAPPDATA 'CodexDreamSkin' }
if (-not $CodeCodexRoot) { $CodeCodexRoot = Join-Path $env:LOCALAPPDATA 'Programs\Code-Codex' }
if (-not $FusionRoot) { $FusionRoot = $PSScriptRoot }

. (Join-Path $FusionRoot 'switch-common.ps1')

$paths = Get-FusionSwitchPaths -StateRoot $StateRoot -CodeCodexRoot $CodeCodexRoot -FusionRoot $FusionRoot
if (-not $ResultPath) { $ResultPath = Join-Path $paths.LogsRoot 'switch-to-dream-skin.result.json' }
$exitCodes = $script:FusionSwitchExitCodes

# 功能：收尾并返回结构化结果。入参：结果对象。返回值：无（通过 exit 结束脚本）。
function Complete-FusionSwitch {
  param([Parameter(Mandatory = $true)][object]$Outcome)
  try {
    [void](Write-FusionSwitchResult -Path $ResultPath -Result $Outcome)
  } catch {
    Write-Warning "切换结果写入失败：$($_.Exception.Message)"
  }
  try {
    Write-FusionSwitchLog -Message "$($Outcome.outcome)：$($Outcome.message)" -LogPath $paths.LogPath
  } catch {
    Write-Warning "切换日志写入失败：$($_.Exception.Message)"
  }
  exit ([int]$Outcome.exitCode)
}

Write-FusionSwitchLog -Message '开始切换：Code-Codex -> Dream Skin' -LogPath $paths.LogPath

# 先落「进行中」标记：从这一刻起，无论脚本因为什么原因中止（抛错、被结束、宿主被关闭），
# 结果文件里都留有痕迹，界面与宿主都不会再把这次切换看成「什么都没发生」。
Write-FusionSwitchRunningMarker -Action 'switch-to-dream-skin' -ResultPath $ResultPath -LogPath $paths.LogPath

# 整体兜底：脚本主体任何一步抛出终止错误，都必须落下一个明确结论再退出。
# 没有这段，出错就等于「静默消失」——结果文件永远不写，界面只能看到没有反应。
trap {
  $failure = $_
  Write-FusionSwitchLog -Message "切换过程中出错并被中止：$($failure.Exception.Message)" -LogPath $paths.LogPath
  Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-dream-skin' -Mode 'unknown' -Outcome 'failed' `
    -ExitCode $exitCodes.UnexpectedFailure `
    -Message "切换过程中出错并已中止（运行模式可能停在中间状态）：$($failure.Exception.Message)")
}

# 1) 载入 Dream Skin 脚本库（需要其官方安装枚举与验证函数）。
# 同样必须在本脚本作用域内 dot-source。
try {
  Assert-FusionDreamSkinLibrary -Paths $paths
  . $paths.CommonScript
  . $paths.ThemeScript
} catch {
  Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-dream-skin' -Mode 'unknown' -Outcome 'failed' `
    -ExitCode $exitCodes.UnexpectedFailure -Message $_.Exception.Message)
}

$officialExecutables = @()
try {
  foreach ($install in @(Get-DreamSkinRegisteredCodexInstalls)) { $officialExecutables += "$($install.Executable)" }
} catch {
  Write-FusionSwitchLog -Message "枚举官方 Codex 安装失败：$($_.Exception.Message)" -LogPath $paths.LogPath
}

# Dream Skin 的档案标记可能不存在（例如从未连接过），此时只用「安装根目录 + 官方可执行文件路径」判定 Code-Codex 归属。
$state = $null
try {
  if (Test-Path -LiteralPath $paths.StatePath -PathType Leaf) { $state = Read-DreamSkinState -Path $paths.StatePath }
} catch {
  Write-FusionSwitchLog -Message "读取 Dream Skin 状态失败：$($_.Exception.Message)" -LogPath $paths.LogPath
  $state = $null
}
$profileToken = Get-FusionProfileToken -ProfilePath $(if ($state) { "$($state.profilePath)" } else { '' })
$dreamSkinExecutable = if ($state) { "$($state.codexExe)" } else { '' }
$effectivePort = if ($state -and $state.port) { [int]$state.port } else { $Port }

$snapshot = @(Get-FusionProcessSnapshot)
$mode = Get-FusionMode -Snapshot $snapshot -OfficialExecutables $officialExecutables -DreamSkinProfileToken $profileToken `
  -CodeCodexRoot $paths.CodeCodexRoot -DreamSkinExecutable $dreamSkinExecutable -SessionPath $paths.SessionPath

Write-FusionSwitchLog -Message ("当前模式：" + $mode.Mode + "；Dream Skin 进程 " + $mode.DreamSkinProcesses.Count +
  " 个；Code-Codex 启动器 " + $mode.CodeCodexLaunchers.Count + " 个；Code-Codex 拥有的 Codex 进程 " +
  $mode.CodeCodexProcesses.Count + " 个；其他 Codex 根进程 " + $mode.ForeignCodexProcesses.Count + " 个。") -LogPath $paths.LogPath

# 2) 已经是 Dream Skin 模式：幂等返回。
if ($mode.Mode -eq 'dream-skin') {
  $existing = Test-FusionDreamSkinCdp -Port $effectivePort -TimeoutSeconds 3
  Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-dream-skin' -Mode 'dream-skin' -Outcome 'already-active' `
    -ExitCode $exitCodes.Success -Message 'Dream Skin 已在运行，未做任何改动。' -Detail @{ verification = $existing })
}

$codeCodexRunning = $mode.Mode -in @('code-codex', 'both')
if (-not $codeCodexRunning) {
  if ($mode.ForeignCodexProcesses.Count -gt 0) {
    Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-dream-skin' -Mode 'none' -Outcome 'blocked' `
      -ExitCode $exitCodes.Blocked `
      -Message '检测到 Code-Codex 未运行，但有其他 Codex 会话正在运行。Dream Skin 需要接管官方 Codex 会话，为避免影响该窗口，已停止切换。请手动关闭该 Codex 后重试。' `
      -Detail @{ foreignCodex = $mode.ForeignCodexProcesses })
  }
}

# 3) 用户确认。
$warnLines = @(
  '即将从 Code-Codex 切换回 Dream Skin。',
  '',
  '• 将关闭 Code-Codex 自己的进程，其中未保存的内容可能丢失。',
  '• 只关闭 Code-Codex 的进程，其他 Codex 窗口不受影响。',
  '• 随后调用 Dream Skin 自己的启动脚本恢复壁纸与动态效果。'
)
if ($mode.ForeignCodexProcesses.Count -gt 0) {
  $warnLines += ''
  $warnLines += '注意：检测到其他 Codex 会话正在运行，Dream Skin 可能需要先接管官方 Codex 会话。'
}
$warnLines += ''
$warnLines += '是否继续？'
if (-not (Confirm-FusionModeSwitch -Message ($warnLines -join "`n") -Title 'Codex Fusion · 切换回 Dream Skin' -AssumeYes:$AssumeYes)) {
  Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-dream-skin' -Mode $mode.Mode -Outcome 'cancelled' `
    -ExitCode $exitCodes.Cancelled -Message '用户取消了切换，Code-Codex 与 Dream Skin 均未改动。')
}

# 4) 结束 Code-Codex 自己的进程（启动器 + 它拥有的官方 Codex 后代）。
if ($codeCodexRunning) {
  $targets = @()
  $targets += $mode.CodeCodexLaunchers | ForEach-Object { [int]$_.ProcessId }
  # Code-Codex 的 Codex 经 AppModel 激活（不是启动器后代），其归属由「启动器启动时间之后新出现的根进程 + 专属启动标记」证明，
  # 关闭时同样先优雅结束启动器（触发 Code-Codex 自己的包终止），再把仍然残留的、已证明归属的 Codex 进程收尾。
  $ownedDescendants = @($mode.CodeCodexProcesses | Where-Object {
    "$($_.Ownership)" -in @('descendant-of-code-codex-launcher', 'code-codex-launch-signature', 'code-codex-session-claim')
  })
  $targets += $ownedDescendants | ForEach-Object { [int]$_.ProcessId }
  $targets = @($targets | Sort-Object -Unique)

  $launcherIds = @($mode.CodeCodexLaunchers | ForEach-Object { [int]$_.ProcessId })
  $stopLaunchers = Stop-FusionOwnedProcesses -ProcessIds $launcherIds -Snapshot $snapshot -GraceSeconds 15 -AllowForce -LogPath $paths.LogPath
  Write-FusionSwitchLog -Message ("已结束 Code-Codex 启动器：请求 " + $stopLaunchers.Requested + "，强制 " +
    $stopLaunchers.Forced + "，残留 " + $stopLaunchers.Remaining.Count + "。") -LogPath $paths.LogPath

  # 再处理官方 Codex 后代：只在它确实属于启动器后代且启动器已退出时收尾。
  $leftover = @($ownedDescendants | ForEach-Object { [int]$_.ProcessId } | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  if ($leftover.Count -gt 0) {
    $stopOwned = Stop-FusionOwnedProcesses -ProcessIds $leftover -Snapshot $snapshot -GraceSeconds 15 -AllowForce -LogPath $paths.LogPath
    Write-FusionSwitchLog -Message ("已收尾 Code-Codex 拥有的 Codex 进程：强制 " + $stopOwned.Forced +
      "，残留 " + $stopOwned.Remaining.Count + "。") -LogPath $paths.LogPath
  }

  # 复核：确认被允许范围之外的 Codex 会话数量没有变化（即没有误伤别人的窗口）。
  $stillRunning = @($targets | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  $unexpected = @($mode.ForeignCodexProcesses | Where-Object { Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue })
  if ($unexpected.Count -ne $mode.ForeignCodexProcesses.Count) {
    Write-FusionSwitchLog -Message '警告：其他 Codex 会话数量发生变化，请检查日志。' -LogPath $paths.LogPath
  }
  Write-FusionSwitchLog -Message ("切换后剩余目标进程 " + $stillRunning.Count + " 个。") -LogPath $paths.LogPath

  # 等待端口释放，避免 Dream Skin 启动时遇到端口占用。
  if (-not (Wait-FusionPortFree -Port $effectivePort -TimeoutSeconds $PortReleaseTimeoutSeconds)) {
    Write-FusionSwitchLog -Message "端口 $effectivePort 未在超时内释放，仍继续请求 Dream Skin 恢复（Dream Skin 会自行选择端口）。" -LogPath $paths.LogPath
  }
}

# 4.5) Code-Codex 的进程已经结束，它对应的会话凭据随之失效，必须清除：
# 留着会让下一次切换把「同一个进程号被复用的新进程」当成 Code-Codex 的会话。
[void](Remove-FusionCodeCodexSession -Path $paths.SessionPath -LogPath $paths.LogPath)

# 5) 请求 Dream Skin 建立连接。这里用 Dream Skin 自己的连接脚本而不是 start-codex-and-panel.ps1：
#    后者会无条件再打开一个浏览器主题面板，而 Fusion 自己就是 Dream Skin 的界面，
#    再弹一个面板等于又多一个重复窗口。连接脚本不含浏览器步骤，其余行为完全一致。
#    -RestartExisting 与原来经 start-codex-and-panel.ps1 的路径保持一致：
#    此时 Code-Codex 的进程已在上一步结束，这里只会收尾它自己残留的 Codex。
$restore = Invoke-FusionDreamSkinConnection -ConnectScript $paths.StartSkinScript -Port $effectivePort -RestartExisting -LogPath $paths.LogPath
if (-not $restore.Requested) {
  Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-dream-skin' -Mode 'code-codex' -Outcome 'failed' `
    -ExitCode $exitCodes.UnexpectedFailure -Message "无法请求 Dream Skin 恢复：$($restore.Detail)" -Detail @{ restore = $restore })
}

# 6) 验证 CDP 端口与壁纸效果：先确认端口上的端点通过了 Dream Skin 自己的所有权校验，
#    再调用 Dream Skin 自带的 verify-dream-skin.ps1（内部即 injector.mjs --verify）确认壁纸确实生效。
$verification = Test-FusionDreamSkinCdp -Port $effectivePort -TimeoutSeconds $VerifyTimeoutSeconds
$renderDetail = 'CDP 端点未通过校验，未执行壁纸渲染校验。'
$wallpaperVerified = $false
if ($verification.CdpVerified) {
  # 先恢复 Dream Skin 自己的窗口：verify-dream-skin.ps1 把 documentPass 当硬条件，
  # 窗口最小化时 document.hidden 为 true 会让「皮肤已生效」被误判为失败。
  # 恢复窗口与验证合并成一步：Dream Skin 会话刚回来时 state.json 可能还被归档着，
  # 只有等档案标记恢复后才能真正证明窗口归属并把它从最小化恢复出来。
  $render = Invoke-FusionDreamSkinVerify -VerifyScript $paths.VerifyScript -Port $effectivePort -TimeoutSeconds 180 -Attempts 3 `
    -DreamSkinProfileToken $profileToken -OfficialExecutables $officialExecutables -StatePath $paths.StatePath `
    -WindowRestoreTimeoutSeconds 150 -LogPath $paths.LogPath
  $lastWindowRestore = $null
  if (@($render.WindowRestores).Count -gt 0) { $lastWindowRestore = @($render.WindowRestores)[-1] }
  $windowRestore = if ($lastWindowRestore) { $lastWindowRestore } else { [pscustomobject]@{ Restored = 0; Detail = '未执行窗口恢复。'; Attempts = 0 } }
  $wallpaperVerified = [bool]$render.Passed
  $renderDetail = "$($windowRestore.Detail)$($render.Detail)"
}
$verification = [pscustomobject]@{
  CdpVerified       = [bool]$verification.CdpVerified
  CdpBrowserId      = "$($verification.CdpBrowserId)"
  WallpaperVerified = $wallpaperVerified
  Detail            = "$($verification.Detail) $renderDetail"
}

if ($verification.CdpVerified -and $verification.WallpaperVerified) {
  Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-dream-skin' -Mode 'dream-skin' -Outcome 'success' `
    -ExitCode $exitCodes.Success -Message '已恢复 Dream Skin，CDP 端口所有权与壁纸效果均验证通过。' `
    -Detail @{ restore = $restore; verification = $verification })
}

if ($verification.CdpVerified) {
  Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-dream-skin' -Mode 'dream-skin' -Outcome 'partial' `
    -ExitCode $exitCodes.VerificationFailed `
    -Message "Dream Skin 已恢复且 CDP 端口通过所有权校验，但壁纸效果未通过验证：$($verification.Detail)" `
    -Detail @{ restore = $restore; verification = $verification })
}

Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-dream-skin' -Mode 'none' -Outcome 'failed' `
  -ExitCode $exitCodes.VerificationFailed `
  -Message "已请求 Dream Skin 恢复，但未观察到通过所有权校验的 CDP 端点：$($verification.Detail)" `
  -Detail @{ restore = $restore; verification = $verification })
