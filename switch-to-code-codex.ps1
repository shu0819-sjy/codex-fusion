[CmdletBinding()]
param(
  [int]$Port = 9335,
  [string]$StateRoot,
  [string]$CodeCodexRoot,
  [string]$FusionRoot,
  [string]$ResultPath,
  [switch]$AssumeYes,
  [int]$PortReleaseTimeoutSeconds = 30,
  [int]$LaunchTimeoutSeconds = 60
)

# Dream Skin -> Code-Codex 切换。
# 行为约定：
#   1) 先向用户确认，并明确提示「未保存内容可能丢失」；用户取消时不做任何改动；
#   2) 只结束 Dream Skin 自己管理的官方 Codex 进程（可执行文件路径 + Dream Skin 档案路径双重匹配）；
#   3) 结束 Dream Skin 注入器与托盘进程，并等待 CDP 端口释放；
#   4) 启动真实安装的 Code-Codex 根启动器，并验证它确实接管了 Codex；
#   5) 启动失败时自动恢复 Dream Skin 原模式。
# 明确不做的事：不结束其他 Codex 会话，不伪造、不绕过 Code-Codex 的进程所有权校验，不修改官方 Codex 安装。

$ErrorActionPreference = 'Stop'

if (-not $StateRoot) { $StateRoot = Join-Path $env:LOCALAPPDATA 'CodexDreamSkin' }
if (-not $CodeCodexRoot) { $CodeCodexRoot = Join-Path $env:LOCALAPPDATA 'Programs\Code-Codex' }
if (-not $FusionRoot) { $FusionRoot = $PSScriptRoot }

. (Join-Path $FusionRoot 'switch-common.ps1')

$paths = Get-FusionSwitchPaths -StateRoot $StateRoot -CodeCodexRoot $CodeCodexRoot -FusionRoot $FusionRoot
if (-not $ResultPath) { $ResultPath = Join-Path $paths.LogsRoot 'switch-to-code-codex.result.json' }
$exitCodes = $script:FusionSwitchExitCodes

# 功能：收尾并返回结构化结果。入参：结果对象。返回值：无（通过 exit 结束脚本）；边界：结果写入失败时仍按原退出码结束。
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

Write-FusionSwitchLog -Message '开始切换：Dream Skin -> Code-Codex' -LogPath $paths.LogPath

# 先落「进行中」标记：切换一旦开工，结果文件就必须始终有痕迹。
# 这样即使脚本中途被中止，界面也能区分「从未开始」与「开始了但没走完」。
Write-FusionSwitchRunningMarker -Action 'switch-to-code-codex' -ResultPath $ResultPath -LogPath $paths.LogPath

# 整体兜底：任何一步抛出终止错误，都要先落下明确结论再退出，绝不静默消失。
trap {
  $failure = $_
  Write-FusionSwitchLog -Message "切换过程中出错并被中止：$($failure.Exception.Message)" -LogPath $paths.LogPath
  Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-code-codex' -Mode 'unknown' -Outcome 'failed' `
    -ExitCode $exitCodes.UnexpectedFailure `
    -Message "切换过程中出错并已中止（运行模式可能停在中间状态）：$($failure.Exception.Message)")
}

# 1) 载入 Dream Skin 官方脚本库，复用其所有权判定与状态读取，避免自行发明匹配规则。
# 必须在本脚本作用域内 dot-source，函数内部 dot-source 会让导入的函数随作用域销毁而失效。
try {
  Assert-FusionDreamSkinLibrary -Paths $paths
  . $paths.CommonScript
  . $paths.ThemeScript
} catch {
  Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-code-codex' -Mode 'unknown' -Outcome 'failed' `
    -ExitCode $exitCodes.UnexpectedFailure -Message $_.Exception.Message)
}

# 2) 读取 Dream Skin 状态，得出当前模式。
$state = $null
try {
  if (Test-Path -LiteralPath $paths.StatePath -PathType Leaf) {
    $state = Read-DreamSkinState -Path $paths.StatePath
  }
} catch {
  Write-FusionSwitchLog -Message "读取 Dream Skin 状态失败（按未运行处理）：$($_.Exception.Message)" -LogPath $paths.LogPath
  $state = $null
}

$officialExecutables = @()
try {
  foreach ($install in @(Get-DreamSkinRegisteredCodexInstalls)) { $officialExecutables += "$($install.Executable)" }
} catch {
  Write-FusionSwitchLog -Message "枚举官方 Codex 安装失败：$($_.Exception.Message)" -LogPath $paths.LogPath
}

$profilePath = if ($state) { "$($state.profilePath)" } else { '' }
$profileToken = Get-FusionProfileToken -ProfilePath $profilePath
$dreamSkinExecutable = if ($state) { "$($state.codexExe)" } else { '' }
$effectivePort = if ($state -and $state.port) { [int]$state.port } else { $Port }

$snapshot = @(Get-FusionProcessSnapshot)
$mode = Get-FusionMode -Snapshot $snapshot -OfficialExecutables $officialExecutables -DreamSkinProfileToken $profileToken `
  -CodeCodexRoot $paths.CodeCodexRoot -DreamSkinExecutable $dreamSkinExecutable -SessionPath $paths.SessionPath

Write-FusionSwitchLog -Message ("当前模式：" + $mode.Mode + "；Dream Skin 进程 " + $mode.DreamSkinProcesses.Count +
  " 个；Code-Codex 启动器 " + $mode.CodeCodexLaunchers.Count + " 个；其他 Codex 根进程 " +
  $mode.ForeignCodexProcesses.Count + " 个。") -LogPath $paths.LogPath

# 3) 已经是 Code-Codex 模式：幂等返回，不做任何进程操作。
if ($mode.Mode -eq 'code-codex') {
  Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-code-codex' -Mode 'code-codex' -Outcome 'already-active' `
    -ExitCode $exitCodes.Success -Message 'Code-Codex 已在运行，未做任何改动。')
}

$dreamSkinRunning = $mode.Mode -in @('dream-skin', 'both')

if (-not $dreamSkinRunning) {
  # Dream Skin 未运行。若已有其他 Codex 根进程，Code-Codex 会因为自己的所有权校验拒绝启动（退出码 21），
  # 而我们绝不允许为了让 Code-Codex 成功而结束别人的会话，因此在这里就明确阻止。
  if ($mode.ForeignCodexProcesses.Count -gt 0) {
    Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-code-codex' -Mode 'none' -Outcome 'blocked' `
      -ExitCode $exitCodes.Blocked `
      -Message '检测到未由 Dream Skin 管理的 Codex 会话正在运行。Code-Codex 的进程所有权校验会拒绝接管该会话（退出码 21），因此不会结束它，也不会启动 Code-Codex。请手动关闭该 Codex 窗口后重试。' `
      -Detail @{ foreignCodex = $mode.ForeignCodexProcesses })
  }
} elseif ($mode.ForeignCodexProcesses.Count -gt 0) {
  # Dream Skin 在运行，但另外还有别人的 Codex 会话。先如实告知，避免用户以为切换后一定能用。
  Write-FusionSwitchLog -Message '存在其他 Codex 根进程，Code-Codex 的所有权校验可能拒绝启动。' -LogPath $paths.LogPath
}

# 4) 用户确认。必须显式提示未保存内容可能丢失。
if ($dreamSkinRunning) {
  $warnLines = @(
    '即将从 Dream Skin 切换到 Code-Codex。',
    '',
    '• 将关闭 Dream Skin 当前管理的 Codex 会话，未保存的内容可能丢失。',
    '• 只关闭 Dream Skin 自己管理的进程，其他 Codex 窗口不受影响。',
    '• Code-Codex 会使用它自己的界面、插件与效果，不继承 Dream Skin 壁纸配置。'
  )
  if ($mode.ForeignCodexProcesses.Count -gt 0) {
    $warnLines += ''
    $warnLines += '注意：检测到其他 Codex 会话正在运行，Code-Codex 可能因所有权校验拒绝启动，此时会自动恢复 Dream Skin。'
  }
  $warnLines += ''
  $warnLines += '是否继续？'
  if (-not (Confirm-FusionModeSwitch -Message ($warnLines -join "`n") -Title 'Codex Fusion · 切换到 Code-Codex' -AssumeYes:$AssumeYes)) {
    Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-code-codex' -Mode $mode.Mode -Outcome 'cancelled' `
      -ExitCode $exitCodes.Cancelled -Message '用户取消了切换，Dream Skin 与 Codex 均未改动。')
  }
} else {
  Write-FusionSwitchLog -Message 'Dream Skin 未运行，直接启动 Code-Codex。' -LogPath $paths.LogPath
}

# 5) 结束 Dream Skin 自己管理的进程。所有权必须同时匹配可执行文件路径与 Dream Skin 档案路径。
if ($dreamSkinRunning) {
  if (-not $dreamSkinExecutable -or -not $profileToken) {
    Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-code-codex' -Mode $mode.Mode -Outcome 'blocked' `
      -ExitCode $exitCodes.Blocked `
      -Message 'Dream Skin 状态文件缺少可执行文件路径或配置档案路径，无法证明进程归属。为避免误关其他 Codex，已停止切换且未结束任何进程。请先重新连接 Dream Skin 以刷新状态。')
  }
  $targets = @($mode.DreamSkinProcesses | ForEach-Object { [int]$_.ProcessId })
  $stopResult = Stop-FusionOwnedProcesses -ProcessIds $targets -Snapshot $snapshot -GraceSeconds 15 -AllowForce -LogPath $paths.LogPath
  Write-FusionSwitchLog -Message ("已结束 Dream Skin Codex 进程：请求 " + $stopResult.Requested + "，强制 " +
    $stopResult.Forced + "，残留 " + $stopResult.Remaining.Count + "。") -LogPath $paths.LogPath
  if ($stopResult.Remaining.Count -gt 0) {
    Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-code-codex' -Mode $mode.Mode -Outcome 'failed' `
      -ExitCode $exitCodes.UnexpectedFailure `
      -Message 'Dream Skin 管理的 Codex 未能安全关闭，已停止切换以避免出现半个会话。Code-Codex 未启动。' `
      -Detail @{ remainingProcessIds = $stopResult.Remaining })
  }

  # 结束 Dream Skin 注入器与托盘，避免它们继续向已关闭的会话注入。
  try {
    $null = Stop-DreamSkinRecordedInjector -State $state
    Write-FusionSwitchLog -Message 'Dream Skin 注入器已停止。' -LogPath $paths.LogPath
  } catch {
    Write-FusionSwitchLog -Message "停止 Dream Skin 注入器失败：$($_.Exception.Message)" -LogPath $paths.LogPath
  }
  try {
    $null = Stop-DreamSkinTrayProcess
    Write-FusionSwitchLog -Message 'Dream Skin 托盘进程已停止。' -LogPath $paths.LogPath
  } catch {
    Write-FusionSwitchLog -Message "停止 Dream Skin 托盘失败：$($_.Exception.Message)" -LogPath $paths.LogPath
  }

  # 等待 CDP 端口释放，避免 Code-Codex 遇到端口占用或接到半死的端点。
  if (-not (Wait-FusionPortFree -Port $effectivePort -TimeoutSeconds $PortReleaseTimeoutSeconds)) {
    Write-FusionSwitchLog -Message "端口 $effectivePort 在超时内未释放，开始回滚。" -LogPath $paths.LogPath
    $restore = Invoke-FusionDreamSkinConnection -ConnectScript $paths.StartSkinScript -Port $effectivePort -RestartExisting -LogPath $paths.LogPath
    Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-code-codex' -Mode 'dream-skin' -Outcome 'rollback' `
      -ExitCode $exitCodes.Blocked `
      -Message "端口 $effectivePort 在 $PortReleaseTimeoutSeconds 秒内未释放，已恢复 Dream Skin。请关闭占用该端口的程序后重试。" `
      -Detail @{ restore = $restore })
  }
}

# 启动前先清掉上一轮可能残留的会话凭据：即使本次启动失败，也不会让旧证据冒充新的归属。
[void](Remove-FusionCodeCodexSession -Path $paths.SessionPath -LogPath $paths.LogPath)

# 6) 启动 Code-Codex 并验证它真的起来了。
$launch = Invoke-FusionCodeCodexLaunch -LauncherPath $paths.CodeCodexLauncher -InstallRoot $paths.CodeCodexRoot `
  -TimeoutSeconds $LaunchTimeoutSeconds -LogPath $paths.LogPath

if ($launch.Started) {
  # 成功：归档 Dream Skin 状态，使 Dream Skin 下次启动时重新建立会话，而不是复用已失效的记录。
  try {
    if (Test-Path -LiteralPath $paths.StatePath -PathType Leaf) {
      $archived = Archive-DreamSkinStateFile -Path $paths.StatePath
      Write-FusionSwitchLog -Message "已归档 Dream Skin 状态：$archived" -LogPath $paths.LogPath
    }
    if (Test-Path -LiteralPath $paths.PauseFile) {
      Remove-Item -LiteralPath $paths.PauseFile -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Write-FusionSwitchLog -Message "归档 Dream Skin 状态失败（不影响 Code-Codex）：$($_.Exception.Message)" -LogPath $paths.LogPath
  }
  # 关键：Code-Codex 的启动器链路会在 Codex 起来后全部退出，所以必须在「刚观测到它接管 Codex」的此刻把归属证据落盘。
  # 否则回程切换时没有任何活着的启动器可以作证，那个 Codex 会被保守判成别人的会话而拒绝切换。
  $sessionIds = @()
  foreach ($item in @($launch.OwnedProcessIds)) { if ($null -ne $item -and [int]$item -gt 0) { $sessionIds += [int]$item } }
  if ($sessionIds.Count -gt 0) {
    $sessionExecutables = @()
    foreach ($item in @($launch.OwnedExecutables)) { if ($item) { $sessionExecutables += "$item" } }
    $startedAt = [datetime]::MinValue
    if ($launch.LauncherStartedAt) { $startedAt = [datetime]$launch.LauncherStartedAt }
    $sessionPath = Save-FusionCodeCodexSession -Path $paths.SessionPath -ProcessIds $sessionIds `
      -Executables $sessionExecutables -StartedAt $startedAt -CodeCodexRoot $paths.CodeCodexRoot `
      -Port $effectivePort -LogPath $paths.LogPath
    if ($sessionPath) {
      Write-FusionSwitchLog -Message ("已记录 Code-Codex 会话凭据：$sessionPath（进程 " + $sessionIds.Count + " 个）") -LogPath $paths.LogPath
    }
  } else {
    Write-FusionSwitchLog -Message '未取得 Code-Codex 归属证据（启动观测结果里没有进程号），回程可能无法证明归属。' -LogPath $paths.LogPath
  }
  Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-code-codex' -Mode 'code-codex' -Outcome 'success' `
    -ExitCode $exitCodes.Success -Message "$($launch.Detail) Dream Skin 配置未被修改。" -Detail @{ launch = $launch })
}

# 7) 启动失败：恢复 Dream Skin 原模式。
Write-FusionSwitchLog -Message "Code-Codex 启动未确认：$($launch.Reason) $($launch.Detail)" -LogPath $paths.LogPath
$rollbackDetail = @{ launch = $launch }
$rollbackOk = $true
if ($dreamSkinRunning) {
  $restore = Invoke-FusionDreamSkinConnection -ConnectScript $paths.StartSkinScript -Port $effectivePort -RestartExisting -LogPath $paths.LogPath
  $rollbackDetail.restore = $restore
  if ($restore.Requested) {
    # 回滚同样要验证：端口上的端点必须通过 Dream Skin 自己的所有权校验，且壁纸确实生效。
    $cdp = Test-FusionDreamSkinCdp -Port $effectivePort -TimeoutSeconds 90
    $render = if ($cdp.CdpVerified) {
      Invoke-FusionDreamSkinVerify -VerifyScript $paths.VerifyScript -Port $effectivePort -TimeoutSeconds 180 -Attempts 2 -LogPath $paths.LogPath
    } else {
      [pscustomobject]@{ Passed = $false; ExitCode = $null; Detail = 'CDP 端点未通过校验，未执行壁纸渲染校验。' }
    }
    $verified = [pscustomobject]@{
      CdpVerified       = [bool]$cdp.CdpVerified
      CdpBrowserId      = "$($cdp.CdpBrowserId)"
      WallpaperVerified = [bool]$render.Passed
      Detail            = "$($cdp.Detail) $($render.Detail)"
    }
    $rollbackDetail.verification = $verified
    $rollbackOk = [bool]$verified.CdpVerified
    Write-FusionSwitchLog -Message "回滚校验：CDP=$($verified.CdpVerified) 壁纸=$($verified.WallpaperVerified) $($verified.Detail)" -LogPath $paths.LogPath
  } else {
    $rollbackOk = $false
  }
} else {
  $rollbackDetail.restore = @{ Requested = $false; Reason = 'not-needed'; Detail = 'Dream Skin 本次切换前未运行，无需恢复。' }
  $rollbackOk = $true
}

$message = "Code-Codex 未能确认启动（$($launch.Reason)）：$($launch.Detail)"
if ($dreamSkinRunning) {
  $message += if ($rollbackOk) { ' 已恢复 Dream Skin 原模式。' } else { ' 恢复 Dream Skin 未通过校验，请手动运行 Dream Skin 手动入口。' }
}
Complete-FusionSwitch (New-FusionSwitchOutcome -Action 'switch-to-code-codex' -Mode $(if ($rollbackOk) { 'dream-skin' } else { 'unknown' }) `
  -Outcome $(if ($rollbackOk) { 'failed' } else { 'rollback-failed' }) `
  -ExitCode $(if ($rollbackOk) { $exitCodes.VerificationFailed } else { $exitCodes.RollbackFailed }) `
  -Message $message -Detail $rollbackDetail)
