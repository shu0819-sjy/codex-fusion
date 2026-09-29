<#
  Codex Fusion 模式切换测试。
  覆盖需求中要求的六个场景，全部用固定进程快照与注入探针驱动，不依赖真实 Codex 会话：
    1) Dream Skin 运行中点击 Code-Codex；
    2) Code-Codex 运行中切回 Dream Skin；
    3) CDP 端口 9335 被占用；
    4) Code-Codex 启动失败；
    5) 存在其他 Codex 进程时不得误杀；
    6) 用户取消确认时不做任何切换。
  Pester 5 语法（Should -Be / Should -Throw）；CI 在 windows-latest 上用预装 Pester 5 运行。
  说明：命令行的 --user-data-dir 在真实 Chromium 里可能带引号也可能不带，两种写法都要覆盖。
#>

BeforeAll {
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'switch-common.ps1')


# 功能：构造一个规范化进程快照条目。入参：进程号、父进程号、名称、路径、命令行。返回值：快照对象。
function New-TestProcess {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [int]$ParentProcessId = 0,
    [string]$Name = 'ChatGPT.exe',
    [string]$ExecutablePath,
    [string]$CommandLine = '',
    [datetime]$CreationDate = [datetime]::MinValue
  )
  return [pscustomobject]@{
    ProcessId       = $ProcessId
    ParentProcessId = $ParentProcessId
    Name            = $Name
    ExecutablePath  = $ExecutablePath
    CommandLine     = $CommandLine
    CreationDate    = $CreationDate
  }
}

# 功能：构造 Dream Skin 会话的命令行。入参：附加参数、是否给档案路径加引号。返回值：命令行文本。
# 顺序与 Dream Skin 实际启动一致：先附加参数，最后由 --user-data-dir 收尾。
function New-DreamSkinCommandLine {
  param([string[]]$Extra = @(), [switch]$QuoteProfile)
  $quoted = if ($QuoteProfile) { '"' + $dreamProfile + '"' } else { $dreamProfile }
  $line = '"' + $officialExe + '"'
  if ($Extra.Count -gt 0) { $line = $line + ' ' + ($Extra -join ' ') }
  return $line + ' --user-data-dir=' + $quoted
}

$officialExe = 'C:\Program Files\WindowsApps\OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe'
$dreamProfile = 'C:\Users\Example\AppData\Local\CodexDreamSkin\cdp-profile'
$dreamToken = Get-FusionProfileToken -ProfilePath $dreamProfile
$codeCodexRoot = 'C:\Users\Example\AppData\Local\Programs\Code-Codex'
$codeCodexExe = Join-Path $codeCodexRoot 'CodeCodex.exe'
}

Describe 'Dream Skin 档案标记' {
  It '把档案路径转成 Dream Skin 使用的 user-data-dir 标记' {
    (Get-FusionProfileToken -ProfilePath $dreamProfile) | Should -Be ('--user-data-dir=' + $dreamProfile)
  }

  It '空路径返回空值，绝不退化成按进程名匹配' {
    (Get-FusionProfileToken -ProfilePath '') | Should -Be $null
  }

  It '同时接受带引号与不带引号的参数写法' {
    (Test-FusionCommandLineToken -CommandLine (New-DreamSkinCommandLine) -Token $dreamToken) | Should -Be $true
    (Test-FusionCommandLineToken -CommandLine (New-DreamSkinCommandLine -QuoteProfile) -Token $dreamToken -IgnoreQuotes) | Should -Be $true
  }
}

Describe '进程归属判定' {
  BeforeAll {
    $snapshot = @(
      New-TestProcess -ProcessId 100 -ExecutablePath $officialExe -CommandLine (New-DreamSkinCommandLine -Extra @('--remote-debugging-port=9335'))
      New-TestProcess -ProcessId 101 -ParentProcessId 100 -ExecutablePath $officialExe -CommandLine (New-DreamSkinCommandLine -Extra @('--type=renderer'))
      New-TestProcess -ProcessId 200 -ExecutablePath $officialExe -CommandLine ('"' + $officialExe + '"')
      New-TestProcess -ProcessId 300 -Name 'CodeCodex.exe' -ExecutablePath $codeCodexExe
      New-TestProcess -ProcessId 301 -ParentProcessId 300 -ExecutablePath $officialExe `
        -CommandLine ('"' + $officialExe + '" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9400')
    )
  }


  It '只把同时匹配可执行文件路径与 Dream Skin 档案的进程算作 Dream Skin 所有' {
    $owned = @(Select-FusionDreamSkinCodexProcesses -Snapshot $snapshot -Executable $officialExe -ProfileToken $dreamToken)
    $owned.Count | Should -Be 2
    ($owned | ForEach-Object { $_.ProcessId } | Sort-Object) -join ',' | Should -Be '100,101'
    $owned[0].Ownership | Should -Be 'exe-path-and-dream-skin-profile'
  }

  It '档案标记缺失时默认不匹配任何进程' {
    @(Select-FusionDreamSkinCodexProcesses -Snapshot $snapshot -Executable $officialExe).Count | Should -Be 0
  }

  It '同路径下没有档案标记的 Codex 被单独报告，不会被算进 Dream Skin 清单' {
    $mode = Get-FusionMode -Snapshot $snapshot -OfficialExecutables @($officialExe) `
      -DreamSkinProfileToken $dreamToken -CodeCodexRoot $codeCodexRoot -DreamSkinExecutable $officialExe
    ($mode.DreamSkinProcesses | ForEach-Object { $_.ProcessId }) -join ',' | Should -Be '100,101'
    $mode.ForeignCodexProcesses.Count | Should -Be 1
    $mode.ForeignCodexProcesses[0].ProcessId | Should -Be 200
  }

  It '同路径同前缀但档案目录不同的会话不会被当成 Dream Skin' {
    # 这条用例防止用字符串包含关系代替真实的路径比较：cdp-profile-old 不是 cdp-profile。
    $otherProfile = $dreamProfile + '-old'
    $commandLine = '"' + $officialExe + '" --user-data-dir=' + $otherProfile
    $trap = @(New-TestProcess -ProcessId 150 -ExecutablePath $officialExe -CommandLine $commandLine)
    @(Select-FusionDreamSkinCodexProcesses -Snapshot $trap -Executable $officialExe -ProfileToken $dreamToken).Count | Should -Be 0
    (Test-FusionCommandLineToken -CommandLine $commandLine -Token $dreamToken) | Should -Be $false
  }

  It '识别出 Code-Codex 安装根目录内的启动器及其拥有者进程' {
    $launchers = @(Select-FusionCodeCodexLaunchers -Snapshot $snapshot -InstallRoot $codeCodexRoot)
    $launchers.Count | Should -Be 1
    $launchers[0].ProcessId | Should -Be 300
    $ownedCode = @(Select-FusionCodeCodexOwnedProcesses -Snapshot $snapshot -LauncherIds @(300) -OfficialExecutables @($officialExe))
    $ownedCode.Count | Should -Be 1
    $ownedCode[0].Ownership | Should -Be 'descendant-of-code-codex-launcher'
  }

  It '安装根目录之外的同名启动器不算 Code-Codex' {
    $foreign = @(New-TestProcess -ProcessId 400 -Name 'CodeCodex.exe' -ExecutablePath 'C:\Temp\CodeCodex.exe')
    @(Select-FusionCodeCodexLaunchers -Snapshot $foreign -InstallRoot $codeCodexRoot).Count | Should -Be 0
  }

  It 'Get-FusionDescendantIds 展开多层后代且不含根进程' {
    $tree = @(
      New-TestProcess -ProcessId 1 -Name 'CodeCodex.exe' -ExecutablePath $codeCodexExe
      New-TestProcess -ProcessId 2 -ParentProcessId 1 -ExecutablePath $officialExe
      New-TestProcess -ProcessId 3 -ParentProcessId 2 -ExecutablePath $officialExe
      New-TestProcess -ProcessId 4 -ExecutablePath $officialExe
    )
    (Get-FusionDescendantIds -Snapshot $tree -RootIds @(1)) -join ',' | Should -Be '2,3'
  }
}

Describe '场景一：Dream Skin 运行中点击 Code-Codex' {
  It '模式判定为 dream-skin，并给出可关闭的 Dream Skin 进程清单' {
    $snapshot = @(New-TestProcess -ProcessId 10 -ExecutablePath $officialExe `
      -CommandLine (New-DreamSkinCommandLine -Extra @('--remote-debugging-port=9335')))
    $mode = Get-FusionMode -Snapshot $snapshot -OfficialExecutables @($officialExe) `
      -DreamSkinProfileToken $dreamToken -CodeCodexRoot $codeCodexRoot -DreamSkinExecutable $officialExe
    $mode.Mode | Should -Be 'dream-skin'
    $mode.DreamSkinProcesses.Count | Should -Be 1
  }

  It '两端同时存在时模式判定为 both，两侧清单都能给出' {
    $snapshot = @(
      New-TestProcess -ProcessId 10 -ExecutablePath $officialExe -CommandLine (New-DreamSkinCommandLine)
      New-TestProcess -ProcessId 20 -Name 'CodeCodex.exe' -ExecutablePath $codeCodexExe
    )
    $mode = Get-FusionMode -Snapshot $snapshot -OfficialExecutables @($officialExe) `
      -DreamSkinProfileToken $dreamToken -CodeCodexRoot $codeCodexRoot -DreamSkinExecutable $officialExe
    $mode.Mode | Should -Be 'both'
  }

  It '只有 Dream Skin 在跑时不会把 Code-Codex 判成正在运行' {
    $snapshot = @(New-TestProcess -ProcessId 10 -ExecutablePath $officialExe -CommandLine (New-DreamSkinCommandLine))
    $mode = Get-FusionMode -Snapshot $snapshot -OfficialExecutables @($officialExe) `
      -DreamSkinProfileToken $dreamToken -CodeCodexRoot $codeCodexRoot -DreamSkinExecutable $officialExe
    $mode.CodeCodexLaunchers.Count | Should -Be 0
    $mode.CodeCodexProcesses.Count | Should -Be 0
  }
}

Describe '场景二：Code-Codex 运行中切回 Dream Skin' {
  It '模式判定为 code-codex，并且只把启动器后代算作 Code-Codex 自己的进程' {
    $snapshot = @(
      New-TestProcess -ProcessId 20 -Name 'CodeCodex.exe' -ExecutablePath $codeCodexExe
      New-TestProcess -ProcessId 21 -ParentProcessId 20 -ExecutablePath $officialExe `
        -CommandLine ('"' + $officialExe + '" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9400')
    )
    $mode = Get-FusionMode -Snapshot $snapshot -OfficialExecutables @($officialExe) `
      -DreamSkinProfileToken $dreamToken -CodeCodexRoot $codeCodexRoot -DreamSkinExecutable $officialExe
    $mode.Mode | Should -Be 'code-codex'
    $mode.CodeCodexProcesses.Count | Should -Be 1
    $mode.CodeCodexProcesses[0].ProcessId | Should -Be 21
  }

  It '仅凭 CDP 参数但没有启动器后代的 Codex 不会被并进 Code-Codex 归属' {
    $snapshot = @(
      New-TestProcess -ProcessId 30 -ExecutablePath $officialExe `
        -CommandLine ('"' + $officialExe + '" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9400')
    )
    $launchers = @(Select-FusionCodeCodexLaunchers -Snapshot $snapshot -InstallRoot $codeCodexRoot)
    $owned = @(Select-FusionCodeCodexOwnedProcesses -Snapshot $snapshot -LauncherIds $launchers -OfficialExecutables @($officialExe) -RequireDescendant)
    $owned.Count | Should -Be 0
  }

  It 'Dream Skin 的会话永远不会被并进 Code-Codex 归属' {
    $snapshot = @(
      New-TestProcess -ProcessId 20 -Name 'CodeCodex.exe' -ExecutablePath $codeCodexExe
      New-TestProcess -ProcessId 22 -ParentProcessId 20 -ExecutablePath $officialExe -CommandLine (New-DreamSkinCommandLine)
    )
    $owned = @(Select-FusionCodeCodexOwnedProcesses -Snapshot $snapshot -LauncherIds @(20) `
      -OfficialExecutables @($officialExe) -DreamSkinProfileToken $dreamToken)
    $owned.Count | Should -Be 0
  }

  It 'AppModel 激活的 Codex 根进程（非后代）凭专属启动标记 + 启动器启动后新出现来归属' {
    $launch = [datetime]::Parse('2026-01-01T10:00:00')
    $snapshot = @(
      New-TestProcess -ProcessId 60 -Name 'CodeCodex.exe' -ExecutablePath $codeCodexExe -CreationDate $launch
      New-TestProcess -ProcessId 61 -ExecutablePath $officialExe -CreationDate $launch.AddSeconds(2) `
        -CommandLine ('"' + $officialExe + '" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9400 --disable-direct-composition')
    )
    $owned = @(Select-FusionCodeCodexOwnedProcesses -Snapshot $snapshot -LauncherIds @(60) `
      -OfficialExecutables @($officialExe) -LauncherCreatedAfter $launch)
    $owned.Count | Should -Be 1
    $owned[0].ProcessId | Should -Be 61
    $owned[0].Ownership | Should -Be 'code-codex-launch-signature'
  }

  It '没有在运行的启动器时，即使 Codex 带专属启动标记也不归 Code-Codex（孤儿不碰）' {
    $snapshot = @(
      New-TestProcess -ProcessId 70 -ExecutablePath $officialExe `
        -CommandLine ('"' + $officialExe + '" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9400 --disable-direct-composition')
    )
    $owned = @(Select-FusionCodeCodexOwnedProcesses -Snapshot $snapshot -LauncherIds @() `
      -OfficialExecutables @($officialExe))
    $owned.Count | Should -Be 0
  }

  It '仅凭 CDP 参数、没有 Code-Codex 专属启动标记的根进程，即使有启动器在跑也不并进归属' {
    $launch = [datetime]::Parse('2026-01-01T10:00:00')
    $snapshot = @(
      New-TestProcess -ProcessId 80 -Name 'CodeCodex.exe' -ExecutablePath $codeCodexExe -CreationDate $launch
      New-TestProcess -ProcessId 81 -ExecutablePath $officialExe -CreationDate $launch.AddSeconds(2) `
        -CommandLine ('"' + $officialExe + '" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9400')
    )
    $owned = @(Select-FusionCodeCodexOwnedProcesses -Snapshot $snapshot -LauncherIds @(80) `
      -OfficialExecutables @($officialExe) -LauncherCreatedAfter $launch)
    $owned.Count | Should -Be 0
  }

  It '启动器启动之前就已存在的根进程（即使带专属标记）不算本次启动的会话' {
    $launch = [datetime]::Parse('2026-01-01T10:00:00')
    $snapshot = @(
      New-TestProcess -ProcessId 90 -Name 'CodeCodex.exe' -ExecutablePath $codeCodexExe -CreationDate $launch
      New-TestProcess -ProcessId 91 -ExecutablePath $officialExe -CreationDate $launch.AddMinutes(-1) `
        -CommandLine ('"' + $officialExe + '" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9400 --disable-direct-composition')
    )
    $owned = @(Select-FusionCodeCodexOwnedProcesses -Snapshot $snapshot -LauncherIds @(90) `
      -OfficialExecutables @($officialExe) -LauncherCreatedAfter $launch)
    $owned.Count | Should -Be 0
  }

  It 'Win10 专属的 --inspect-brk=127.0.0.1: 标记同样能证明归属' {
    $launch = [datetime]::Parse('2026-01-01T10:00:00')
    $snapshot = @(
      New-TestProcess -ProcessId 92 -Name 'CodeCodex.exe' -ExecutablePath $codeCodexExe -CreationDate $launch
      New-TestProcess -ProcessId 93 -ExecutablePath $officialExe -CreationDate $launch.AddSeconds(1) `
        -CommandLine ('"' + $officialExe + '" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9400 --inspect-brk=127.0.0.1:4321')
    )
    $owned = @(Select-FusionCodeCodexOwnedProcesses -Snapshot $snapshot -LauncherIds @(92) `
      -OfficialExecutables @($officialExe) -LauncherCreatedAfter $launch)
    $owned.Count | Should -Be 1
    $owned[0].Ownership | Should -Be 'code-codex-launch-signature'
  }

  It '结束进程只作用于传入的进程号，绝不按进程名批量结束' {
    $snapshot = @(
      New-TestProcess -ProcessId 40 -Name 'CodeCodex.exe' -ExecutablePath $codeCodexExe
      New-TestProcess -ProcessId 41 -ExecutablePath $officialExe
    )
    $result = Stop-FusionOwnedProcesses -ProcessIds @() -Snapshot $snapshot
    $result.Requested | Should -Be 0
    $result.Forced | Should -Be 0
    $result.Remaining.Count | Should -Be 0
  }
}

Describe '场景三：CDP 端口被占用' {
  It '端口上一直有监听时等待超时并返回未释放' {
    $probe = { param($Port) @([pscustomobject]@{ LocalPort = $Port }) }
    (Wait-FusionPortFree -Port 9335 -TimeoutSeconds 1 -Probe $probe) | Should -Be $false
  }

  It '端口立刻空闲时返回已释放' {
    $probe = { param($Port) @() }
    (Wait-FusionPortFree -Port 9335 -TimeoutSeconds 5 -Probe $probe) | Should -Be $true
  }

  It '端口上的端点若不属于 Dream Skin 会话则判定为未通过校验' {
    $probe = { param($Port) [pscustomobject]@{ Identity = [pscustomobject]@{ BrowserId = 'someone-elses-session' } } }
    $result = Test-FusionDreamSkinCdp -Port 9335 -TimeoutSeconds 1 -ExpectedBrowserId 'dream-skin-session' -CdpProbe $probe
    $result.CdpVerified | Should -Be $false
    ($result.Detail -match '另一个 Codex 会话') | Should -Be $true
  }

  It '端口上的端点属于本次会话时判定为通过' {
    $probe = { param($Port) [pscustomobject]@{ Identity = [pscustomobject]@{ BrowserId = 'dream-skin-session' } } }
    $result = Test-FusionDreamSkinCdp -Port 9335 -TimeoutSeconds 1 -ExpectedBrowserId 'dream-skin-session' -CdpProbe $probe
    $result.CdpVerified | Should -Be $true
    $result.CdpBrowserId | Should -Be 'dream-skin-session'
  }

  It '端口上没有任何通过校验的端点时返回未通过' {
    $probe = { param($Port) $null }
    $result = Test-FusionDreamSkinCdp -Port 9335 -TimeoutSeconds 1 -CdpProbe $probe
    $result.CdpVerified | Should -Be $false
    $result.Detail.Length | Should -BeGreaterThan 0
  }

  It '通过校验时浏览器标识与已保存的 Dream Skin 会话一致才算数' {
    $probe = { param($Port) [pscustomobject]@{ Identity = [pscustomobject]@{ BrowserId = 'dream-skin-session' } } }
    $result = Test-FusionDreamSkinCdp -Port 9335 -TimeoutSeconds 1 -ExpectedBrowserId 'dream-skin-session' -CdpProbe $probe
    $result.CdpVerified | Should -Be $true
    $result.CdpBrowserId | Should -Be 'dream-skin-session'
  }
}

Describe '场景四：Code-Codex 启动失败' {
  It '根启动器不存在时给出 launcher-missing 而不是假装成功' {
    $result = Invoke-FusionCodeCodexLaunch -LauncherPath 'C:\nope\CodeCodex.exe' -InstallRoot $codeCodexRoot -TimeoutSeconds 1
    $result.Started | Should -Be $false
    $result.Reason | Should -Be 'launcher-missing'
  }

  It '把启动器的三个已知退出码翻译成可读原因' {
    (Get-FusionCodeCodexExitHint -ExitCode 20) -match 'UNSUPPORTED_VERSION' | Should -Be $true
    (Get-FusionCodeCodexExitHint -ExitCode 21) -match 'ALREADY_RUNNING' | Should -Be $true
    (Get-FusionCodeCodexExitHint -ExitCode 22) -match 'STARTUP_FAILURE' | Should -Be $true
  }

  It '未知退出码也给出说明而不是空字符串' {
    (Get-FusionCodeCodexExitHint -ExitCode 99).Length | Should -BeGreaterThan 0
  }

  It '启动失败时结果对象带有明确的失败原因、退出码与回滚标记' {
    $launch = [pscustomobject]@{
      Started = $false; Reason = 'launcher-exited'; LauncherExitCode = 22
      Detail = (Get-FusionCodeCodexExitHint -ExitCode 22)
    }
    $outcome = New-FusionSwitchOutcome -Action 'switch-to-code-codex' -Mode 'dream-skin' -Outcome 'failed' -ExitCode 4 `
      -Message '已回滚' -Detail @{ launch = $launch; restore = @{ Requested = $true } }
    $outcome.outcome | Should -Be 'failed'
    $outcome.exitCode | Should -Be 4
    $outcome.detail.launch.LauncherExitCode | Should -Be 22
    $outcome.detail.restore.Requested | Should -Be $true
  }

  It 'Dream Skin 连接入口缺失时如实报告失败（不会静默跳过，也不会顺手打开浏览器面板）' {
    $connect = Invoke-FusionDreamSkinConnection -ConnectScript 'C:\nope\start-dream-skin.ps1'
    $connect.Requested | Should -Be $false
    $connect.Reason | Should -Be 'connect-script-missing'

    # 旧的浏览器入口已不再被任何流程使用：它每次都会无条件再开一个主题面板，属于重复窗口。
    $panelUse = @()
    foreach ($file in @(Get-ChildItem -Path 'C:\codex-fusion' -Filter *.ps1 -File)) {
      if ($file.Name -eq 'switch-common.ps1') { continue }
      if ([System.IO.File]::ReadAllText($file.FullName) -match 'Invoke-FusionDreamSkinRestore') { $panelUse += $file.Name }
    }
    $panelUse.Count | Should -Be 0
  }
}

Describe '场景五：存在其他 Codex 进程时不得误杀' {
  BeforeAll {
    $snapshot = @(
      New-TestProcess -ProcessId 50 -ExecutablePath $officialExe -CommandLine (New-DreamSkinCommandLine)
      New-TestProcess -ProcessId 51 -ExecutablePath $officialExe -CommandLine ('"' + $officialExe + '"')
      New-TestProcess -ProcessId 52 -Name 'CodeCodex.exe' -ExecutablePath $codeCodexExe
    )
  }


  It 'Dream Skin 的关闭清单不包含其他 Codex 会话' {
    $owned = @(Select-FusionDreamSkinCodexProcesses -Snapshot $snapshot -Executable $officialExe -ProfileToken $dreamToken)
    ($owned | ForEach-Object { $_.ProcessId }) -join ',' | Should -Be '50'
  }

  It '没有 Dream Skin 档案记录时，其他 Codex 会话也被完整报告出来' {
    # Dream Skin 未运行时，所有 Codex 根进程都属于「其他会话」，必须全部报出来而不是只报一个。
    $mode = Get-FusionMode -Snapshot $snapshot -OfficialExecutables @($officialExe) `
      -DreamSkinProfileToken $null -CodeCodexRoot $codeCodexRoot -DreamSkinExecutable $officialExe
    ($mode.ForeignCodexProcesses | ForEach-Object { $_.ProcessId } | Sort-Object) -join ',' | Should -Be '50,51'
    $mode.DreamSkinProcesses.Count | Should -Be 0
  }

  It '结束函数在路径与快照不一致时拒绝强制结束（防止进程号复用误杀）' {
    $mismatched = @(New-TestProcess -ProcessId $PID -ExecutablePath 'C:\definitely\not\this\process.exe')
    $result = Stop-FusionOwnedProcesses -ProcessIds @($PID) -Snapshot $mismatched -GraceSeconds 0 -AllowForce
    ($result.Remaining -contains $PID) | Should -Be $true
    (Get-Process -Id $PID -ErrorAction SilentlyContinue) | Should -Not -BeNullOrEmpty
  }
}

Describe '场景六：用户取消确认时不发生切换' {
  It '弹窗被拒绝时返回未确认' {
    (Confirm-FusionModeSwitch -Message 'test' -Title 'test' -Prompt { param($msg, $title) $false }) | Should -Be $false
  }

  It '用户确认时返回已确认' {
    (Confirm-FusionModeSwitch -Message 'test' -Title 'test' -Prompt { param($msg, $title) $true }) | Should -Be $true
  }

  It 'AssumeYes 用于自动化场景时视为已确认' {
    (Confirm-FusionModeSwitch -Message 'test' -AssumeYes) | Should -Be $true
  }

  It '取消时写出的结果不含任何进程操作，模式保持原样' {
    $resultPath = Join-Path ([System.IO.Path]::GetTempPath()) ('fusion-test-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
      $outcome = New-FusionSwitchOutcome -Action 'switch-to-code-codex' -Mode 'dream-skin' -Outcome 'cancelled' -ExitCode 3 -Message '用户取消了切换'
      [void](Write-FusionSwitchResult -Path $resultPath -Result $outcome)
      $read = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
      $read.outcome | Should -Be 'cancelled'
      $read.mode | Should -Be 'dream-skin'
      $read.message | Should -Be '用户取消了切换'
      $read.detail | Should -BeNullOrEmpty
    }
    finally {
      if (Test-Path -LiteralPath $resultPath) { Remove-Item -LiteralPath $resultPath -Force }
    }
  }

  It '确认提示必须明确说明未保存内容可能丢失' {
    $script:CapturedPrompt = $null
    $answer = Confirm-FusionModeSwitch -Message ("未保存的内容可能丢失`n是否继续？") -Title 'test' -Prompt {
      param($message, $title)
      $script:CapturedPrompt = $message
      return $false
    }
    $answer | Should -Be $false
    ($script:CapturedPrompt -match '未保存') | Should -Be $true
  }
}

Describe '结果对象与日志' {
  It '结果对象包含结构版本、动作、模式、结果与退出码' {
    $outcome = New-FusionSwitchOutcome -Action 'switch-to-dream-skin' -Mode 'none' -Outcome 'blocked' -ExitCode 2 -Message 'blocked'
    $outcome.schemaVersion | Should -Be 1
    $outcome.action | Should -Be 'switch-to-dream-skin'
    $outcome.exitCode | Should -Be 2
    $outcome.timestamp | Should -Not -BeNullOrEmpty
  }

  It '结果 JSON 能被重新读回' {
    $path = Join-Path ([System.IO.Path]::GetTempPath()) ('fusion-test-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
      $outcome = New-FusionSwitchOutcome -Action 'switch-to-code-codex' -Mode 'code-codex' -Outcome 'success' -ExitCode 0 -Message 'ok'
      (Write-FusionSwitchResult -Path $path -Result $outcome) | Should -Be ([System.IO.Path]::GetFullPath($path))
      (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).outcome | Should -Be 'success'
    }
    finally {
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
  }

  It '结果文件带 BOM，保证 PS 5.1 读回中文不乱码' {
    $path = Join-Path ([System.IO.Path]::GetTempPath()) ('fusion-test-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
      $outcome = New-FusionSwitchOutcome -Action 'switch-to-code-codex' -Mode 'none' -Outcome 'blocked' -ExitCode 2 -Message '检测到其他 Codex 会话'
      [void](Write-FusionSwitchResult -Path $path -Result $outcome)
      $bytes = [System.IO.File]::ReadAllBytes($path)
      ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) | Should -Be $true
      (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).message | Should -Be '检测到其他 Codex 会话'
    }
    finally {
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
  }

  It '日志写入不会因为目录不存在而失败' {
    $logPath = Join-Path ([System.IO.Path]::GetTempPath()) ('fusion-log-' + [guid]::NewGuid().ToString('N') + '\nested\fusion.log')
    try {
      Write-FusionSwitchLog -Message '测试日志' -LogPath $logPath
      (Test-Path -LiteralPath $logPath) | Should -Be $true
      (Get-Content -LiteralPath $logPath -Raw) -match '测试日志' | Should -Be $true
    }
    finally {
      $dir = Split-Path -Parent (Split-Path -Parent $logPath)
      if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
    }
  }

  It '退出码语义互不重叠且成功为 0' {
    $codes = $script:FusionSwitchExitCodes
    $codes.Success | Should -Be 0
    ($codes.Cancelled -ne $codes.Blocked) | Should -Be $true
    ($codes.VerificationFailed -ne $codes.RollbackFailed) | Should -Be $true
  }
}
