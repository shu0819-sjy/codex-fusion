[CmdletBinding()]
param(
  [int]$Port = 9335,
  [string]$StateRoot,
  [string]$CodeCodexRoot,
  [string]$FusionRoot,
  [string]$ResultPath,
  [int]$VerifyTimeoutSeconds = 120
)

# Codex Fusion 启动时的「自动进入 Dream Skin 模式」。
#
# 设计边界（与两个切换脚本保持一致）：
#   1) 只负责把「没有任何模式在跑」或「已经是 Dream Skin」这两种情况带到 Dream Skin；
#   2) 如果当前跑的是 Code-Codex，绝不自动杀掉它——那属于一次需要用户确认的切换，
#      本脚本只如实报告 code-codex-active，交由界面上的按钮处理；
#   3) 检测到其他 Codex 会话时一律不动，返回 blocked；
#   4) 调用 Dream Skin 自己的连接脚本时**不带** -RestartExisting，
#      这样它不会去关闭任何已打开的 Codex，宁可直接失败也不会误关窗口；
#   5) 不打开浏览器面板——Fusion 自己就是 Dream Skin 的界面。

$ErrorActionPreference = 'Stop'

if (-not $StateRoot) { $StateRoot = Join-Path $env:LOCALAPPDATA 'CodexDreamSkin' }
if (-not $CodeCodexRoot) { $CodeCodexRoot = Join-Path $env:LOCALAPPDATA 'Programs\Code-Codex' }
if (-not $FusionRoot) { $FusionRoot = $PSScriptRoot }

. (Join-Path $FusionRoot 'switch-common.ps1')

$paths = Get-FusionSwitchPaths -StateRoot $StateRoot -CodeCodexRoot $CodeCodexRoot -FusionRoot $FusionRoot
if (-not $ResultPath) { $ResultPath = Join-Path $paths.LogsRoot 'ensure-dream-skin-mode.result.json' }

# 功能：收尾并返回结构化结果。入参：结果对象。返回值：无（通过 exit 结束脚本）。
function Complete-FusionEnsure {
  param([Parameter(Mandatory = $true)][object]$Outcome)
  try {
    [void](Write-FusionSwitchResult -Path $ResultPath -Result $Outcome)
  } catch {
    Write-Warning "启动自检结果写入失败：$($_.Exception.Message)"
  }
  try {
    Write-FusionSwitchLog -Message "启动自检：$($Outcome.outcome)：$($Outcome.message)" -LogPath $paths.LogPath
  } catch {
    Write-Warning "启动自检日志写入失败：$($_.Exception.Message)"
  }
  exit ([int]$Outcome.exitCode)
}

$exitCodes = $script:FusionSwitchExitCodes
Write-FusionSwitchLog -Message '开始启动自检：按当前模式决定是否需要进入 Dream Skin' -LogPath $paths.LogPath

# 整体兜底：自检中途抛错同样必须留下明确结论，不能静默消失。
trap {
  $failure = $_
  Write-FusionSwitchLog -Message "启动自检过程中出错并被中止：$($failure.Exception.Message)" -LogPath $paths.LogPath
  Complete-FusionEnsure (New-FusionSwitchOutcome -Action 'ensure-dream-skin-mode' -Mode 'unknown' -Outcome 'failed' `
    -ExitCode $exitCodes.UnexpectedFailure -Message "启动自检过程中出错并已中止：$($failure.Exception.Message)")
}

# 载入 Dream Skin 脚本库（需要其官方安装枚举与验证函数）。
try {
  Assert-FusionDreamSkinLibrary -Paths $paths
  . $paths.CommonScript
  . $paths.ThemeScript
} catch {
  Complete-FusionEnsure (New-FusionSwitchOutcome -Action 'ensure-dream-skin-mode' -Mode 'unknown' -Outcome 'failed' `
    -ExitCode $exitCodes.UnexpectedFailure -Message "Dream Skin 脚本库不可用：$($_.Exception.Message)")
}

$officialExecutables = @()
try {
  foreach ($install in @(Get-DreamSkinRegisteredCodexInstalls)) { $officialExecutables += "$($install.Executable)" }
} catch {
  Write-FusionSwitchLog -Message "枚举官方 Codex 安装失败：$($_.Exception.Message)" -LogPath $paths.LogPath
}

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

Write-FusionSwitchLog -Message ("启动自检读到当前模式：" + $mode.Mode + "；其他 Codex 根进程 " + $mode.ForeignCodexProcesses.Count + " 个。") -LogPath $paths.LogPath

# 决策交给 switch-common.ps1 里的纯函数，保证「运行时行为」和「单元测试」用的是同一套规则：
#   已 Dream Skin -> 不动；Code-Codex 在跑 -> 阻塞（不自动关它的进程）；
#   其他 Codex 会话在跑 -> 阻塞；完全没有模式在跑 -> 建立连接（且不强制重启）。
$decision = Get-FusionEnsureDreamSkinDecision -Mode $mode
Write-FusionSwitchLog -Message "启动自检决策：$($decision.Outcome)" -LogPath $paths.LogPath

if (-not $decision.ShouldConnect) {
  $decisionExit = if ($decision.Outcome -eq 'blocked') { $exitCodes.Blocked } else { $exitCodes.Success }
  Complete-FusionEnsure (New-FusionSwitchOutcome -Action 'ensure-dream-skin-mode' -Mode $mode.Mode -Outcome $decision.Outcome `
    -ExitCode $decisionExit -Message $decision.Message `
    -Detail @{ codeCodexLaunchers = @($mode.CodeCodexLaunchers).Count; codeCodexProcesses = @($mode.CodeCodexProcesses).Count; foreignCodex = $mode.ForeignCodexProcesses })
}

# 决策为「建立连接」：不打开浏览器面板，且不带 -RestartExisting（宁可失败也不误关窗口）。
$connection = Invoke-FusionDreamSkinConnection -ConnectScript $paths.StartSkinScript -Port $effectivePort -LogPath $paths.LogPath
if (-not $connection.Requested) {
  Complete-FusionEnsure (New-FusionSwitchOutcome -Action 'ensure-dream-skin-mode' -Mode 'none' -Outcome 'failed' `
    -ExitCode $exitCodes.UnexpectedFailure -Message "无法请求 Dream Skin 建立连接：$($connection.Detail)" -Detail @{ connection = $connection })
}

# 5) 验证：CDP 端口所有权 + 壁纸效果（与回程同一套校验，含窗口屏外恢复）。
$verification = Test-FusionDreamSkinCdp -Port $effectivePort -TimeoutSeconds $VerifyTimeoutSeconds
$renderDetail = 'CDP 端点未通过校验，未执行壁纸渲染校验。'
$wallpaperVerified = $false
if ($verification.CdpVerified) {
  $render = Invoke-FusionDreamSkinVerify -VerifyScript $paths.VerifyScript -Port $effectivePort -TimeoutSeconds 180 -Attempts 3 `
    -DreamSkinProfileToken $profileToken -OfficialExecutables $officialExecutables -StatePath $paths.StatePath `
    -WindowRestoreTimeoutSeconds 150 -LogPath $paths.LogPath
  $lastWindowRestore = $null
  if (@($render.WindowRestores).Count -gt 0) { $lastWindowRestore = @($render.WindowRestores)[-1] }
  $windowRestore = if ($lastWindowRestore) { $lastWindowRestore } else { [pscustomobject]@{ Restored = 0; Detail = '未执行窗口恢复。'; Attempts = 0 } }
  $wallpaperVerified = [bool]$render.Passed
  $renderDetail = "$($windowRestore.Detail)$($render.Detail)"
}
$summary = [pscustomobject]@{
  CdpVerified       = [bool]$verification.CdpVerified
  CdpBrowserId      = "$($verification.CdpBrowserId)"
  WallpaperVerified = $wallpaperVerified
  Detail            = "$($verification.Detail) $renderDetail"
}

if ($summary.CdpVerified -and $summary.WallpaperVerified) {
  Complete-FusionEnsure (New-FusionSwitchOutcome -Action 'ensure-dream-skin-mode' -Mode 'dream-skin' -Outcome 'success' `
    -ExitCode $exitCodes.Success -Message '已自动进入 Dream Skin 模式，CDP 端口所有权与壁纸效果均验证通过。' `
    -Detail @{ connection = $connection; verification = $summary })
}

if ($summary.CdpVerified) {
  Complete-FusionEnsure (New-FusionSwitchOutcome -Action 'ensure-dream-skin-mode' -Mode 'dream-skin' -Outcome 'partial' `
    -ExitCode $exitCodes.VerificationFailed `
    -Message "Dream Skin 已连接且 CDP 端口通过所有权校验，但壁纸效果未通过验证：$($summary.Detail)" `
    -Detail @{ connection = $connection; verification = $summary })
}

Complete-FusionEnsure (New-FusionSwitchOutcome -Action 'ensure-dream-skin-mode' -Mode 'none' -Outcome 'failed' `
  -ExitCode $exitCodes.VerificationFailed `
  -Message "已请求 Dream Skin 建立连接，但未观察到通过所有权校验的 CDP 端点：$($summary.Detail)" `
  -Detail @{ connection = $connection; verification = $summary })
