# 本轮修复的回归测试：Code-Codex 根启动器「转发后立刻退出 0」、壁纸校验摘要、窗口恢复边界。
# 这里用真实进程与真实 JSON 做验证，避免只测 mock 出来的假象。

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path (Split-Path -Parent $here) 'switch-common.ps1')

# 生产环境里官方 Codex 安装清单来自 Dream Skin 的 common-windows.ps1；
# 测试里用固定清单替代，保证归属判定走的是真实逻辑而不是外部环境。
$script:officialCodexExe = 'C:\Program Files\WindowsApps\OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe'
function Get-DreamSkinRegisteredCodexInstalls {
  return @([pscustomobject]@{ Executable = $script:officialCodexExe })
}

Describe 'Code-Codex 根启动器转发语义（真实进程）' {

  It '根启动器退出码 0 后继续等待，观察到版本化启动器拥有的 Codex 即算成功' {
    $root = Join-Path $env:TEMP ('fusion-launch-ok-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $launcherPath = Join-Path $root 'CodeCodex.exe'
    # 真实可执行文件：模拟根启动器「转发成功后立刻退出 0」。
    Add-Type -TypeDefinition 'public class ShimOk { public static int Main(string[] a) { return 0; } }' `
      -OutputAssembly $launcherPath -OutputType ConsoleApplication -ErrorAction Stop
    $versionedPath = Join-Path $root 'versions\0.2.11\CodeCodex.exe'
    $script:phase = 0
    $snapshotProvider = {
      $script:phase++
      if ($script:phase -le 3) {
        # 转发器已经退出：快照里没有任何启动器，也没有任何 Codex。
        return @()
      }
      return @(
        [pscustomobject]@{
          ProcessId = 910001; ParentProcessId = 1; Name = 'CodeCodex.exe'
          ExecutablePath = $script:versionedPath; CommandLine = $script:versionedPath
          CreationDate = (Get-Date)
        }
        [pscustomobject]@{
          ProcessId = 910002; ParentProcessId = 1; Name = 'ChatGPT.exe'
          ExecutablePath = $script:officialCodexExe
          CommandLine = '--remote-debugging-address=127.0.0.1 --remote-debugging-port=57466 --disable-direct-composition'
          CreationDate = (Get-Date).AddSeconds(1)
        }
      )
    }
    $script:versionedPath = $versionedPath
    try {
      $result = Invoke-FusionCodeCodexLaunch -LauncherPath $launcherPath -InstallRoot $root `
        -SnapshotProvider $snapshotProvider -TimeoutSeconds 30
      $result.Started | Should Be $true
      $result.Reason | Should Be 'codex-process-observed'
      $result.LauncherExitCode | Should BeNullOrEmpty
    }
    finally {
      Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
    }
  }

  It '根启动器以非零退出码（21 已在运行）结束时如实报告失败' {
    $root = Join-Path $env:TEMP ('fusion-launch-fail-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $launcherPath = Join-Path $root 'CodeCodex.exe'
    Add-Type -TypeDefinition 'public class ShimFail { public static int Main(string[] a) { return 21; } }' `
      -OutputAssembly $launcherPath -OutputType ConsoleApplication -ErrorAction Stop
    try {
      $result = Invoke-FusionCodeCodexLaunch -LauncherPath $launcherPath -InstallRoot $root `
        -SnapshotProvider { return @() } -TimeoutSeconds 30
      $result.Started | Should Be $false
      $result.Reason | Should Be 'launcher-exited'
      $result.LauncherExitCode | Should Be 21
    }
    finally {
      Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
    }
  }

  It '根启动器退出 0 但始终没有 Codex 接管时，超时后如实报告失败（不假定成功）' {
    $root = Join-Path $env:TEMP ('fusion-launch-timeout-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $launcherPath = Join-Path $root 'CodeCodex.exe'
    Add-Type -TypeDefinition 'public class ShimIdle { public static int Main(string[] a) { return 0; } }' `
      -OutputAssembly $launcherPath -OutputType ConsoleApplication -ErrorAction Stop
    try {
      $result = Invoke-FusionCodeCodexLaunch -LauncherPath $launcherPath -InstallRoot $root `
        -SnapshotProvider { return @() } -TimeoutSeconds 5
      $result.Started | Should Be $false
      $result.Reason | Should Be 'verification-timeout'
    }
    finally {
      Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
    }
  }
}

Describe 'Dream Skin 壁纸校验摘要' {

  It '最小化导致的 documentPass 失败会被讲清楚，而不是把结尾括号当详情' {
    $out = Join-Path $env:TEMP ('ds-verify-' + [guid]::NewGuid().ToString('N') + '.json')
    $body = '{"mode":"verify","targets":[{"targetId":"ABC","result":{' +
      '"themeId":"preset-gothic-void-crusade","revision":"rev1",' +
      '"expectedThemeId":"preset-gothic-void-crusade","expectedRevision":"rev1",' +
      '"stylePresent":true,"documentHidden":true,' +
      '"nativeWindow":{"pass":false,"unsupported":true,"reason":"browser-window-not-found"},' +
      '"readiness":{"windowPass":true,"documentPass":false,"viewportPass":true,"structurePass":true}}}]}'
    try {
      Set-Content -LiteralPath $out -Value $body -Encoding UTF8
      $detail = Get-FusionDreamSkinVerifySummary -StdOutPath $out -StdErrPath '' -ExitCode 2
      ($detail -match 'documentPass') | Should Be $true
      ($detail -match '最小化') | Should Be $true
      ($detail -match 'preset-gothic-void-crusade') | Should Be $true
      ($detail.Trim().StartsWith('}')) | Should Be $false
    }
    finally {
      Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
    }
  }

  It '带警告前缀的非纯 JSON 输出同样能被解析' {
    $out = Join-Path $env:TEMP ('ds-verify-' + [guid]::NewGuid().ToString('N') + '.json')
    $body = 'WARNING: something before json' + [Environment]::NewLine +
      '{"mode":"verify","targets":[{"targetId":"ABC","result":{"themeId":"t","revision":"r",' +
      '"expectedThemeId":"t","expectedRevision":"r","stylePresent":true,"documentHidden":false,' +
      '"readiness":{"windowPass":true,"documentPass":true,"viewportPass":true,"structurePass":true}}}]}'
    try {
      Set-Content -LiteralPath $out -Value $body -Encoding UTF8
      $detail = Get-FusionDreamSkinVerifySummary -StdOutPath $out -StdErrPath '' -ExitCode 2
      ($detail -match '未通过项') | Should Be $false
    }
    finally {
      Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
    }
  }

  It '完全无法解析时回退到尾部输出且不抛错' {
    $out = Join-Path $env:TEMP ('ds-verify-' + [guid]::NewGuid().ToString('N') + '.txt')
    try {
      Set-Content -LiteralPath $out -Value 'not json at all' -Encoding UTF8
      $detail = Get-FusionDreamSkinVerifySummary -StdOutPath $out -StdErrPath '' -ExitCode 2
      ($detail -match 'not json at all') | Should Be $true
    }
    finally {
      Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
    }
  }
}

Describe '窗口恢复的归属边界' {

  It '缺少档案标记时拒绝恢复窗口，避免误动其他 Codex 窗口' {
    $result = Restore-FusionDreamSkinWindow -DreamSkinProfileToken '' -OfficialExecutables @('C:\x\ChatGPT.exe')
    $result.Restored | Should Be 0
    $result.Detail | Should Not BeNullOrEmpty
  }

  It '缺少官方可执行文件集合时拒绝恢复窗口' {
    $result = Restore-FusionDreamSkinWindow -DreamSkinProfileToken '--user-data-dir=C:\x' -OfficialExecutables @()
    $result.Restored | Should Be 0
    $result.Detail | Should Not BeNullOrEmpty
  }

  It '档案标记与官方可执行文件都齐全时，不匹配的窗口一律不动' {
    $result = Restore-FusionDreamSkinWindow -DreamSkinProfileToken '--user-data-dir=C:\definitely-not-running' `
      -OfficialExecutables @('C:\Program Files\WindowsApps\OpenAI.Codex\app\ChatGPT.exe')
    $result.Restored | Should Be 0
  }
}
