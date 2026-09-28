# 本轮修复的回归测试：窗口恢复的「已满足」语义 + 验证退出码兜底。
# 背景（实测得出的两条事实）：
#   1) Codex 26.908 在会话交接后会把主窗口留在屏外（坐标 -32000），此时 IsWindowVisible 仍为真、
#      IsIconic 为假；渲染进程按 Chromium 规则判定 document.hidden=true，verify 的 documentPass 失败。
#      修复前「可见就跳过」会把这种窗口整段跳过，所以恢复必须同时检查「是否留在屏幕内」。
#   2) 窗口本来就正常时恢复函数不做任何动作（Restored=0）；若等待循环只认 Restored>0，
#      就会空等到超时，把「本来就正常」误报成「恢复失败」。因此需要 Satisfied 语义。
#   3) Start-Process 有时读不到子进程退出码，此时必须改用同步调用拿真实退出码，
#      否则 exit=0 的 verify 会被判成失败。

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path (Split-Path -Parent $here) 'switch-common.ps1')

Describe '窗口恢复的「已满足」语义' {

  It '缺少归属证据时不做任何动作，且明确报告未满足（绝不按名字动别的窗口）' {
    $result = Restore-FusionDreamSkinWindow -LogPath (Join-Path $env:TEMP 'fusion-test.log')
    $result.Restored | Should Be 0
    $result.Satisfied | Should Be $false
    $result.Detail | Should Match '跳过窗口恢复'
  }

  It '恢复结果对象始终带 Satisfied 与 AlreadyVisible 字段（等待循环据此立即结束，而不是空等超时）' {
    $result = Restore-FusionDreamSkinWindow -LogPath (Join-Path $env:TEMP 'fusion-test.log')
    @($result.PSObject.Properties.Name) -contains 'Satisfied' | Should Be $true
    @($result.PSObject.Properties.Name) -contains 'AlreadyVisible' | Should Be $true
  }

  It '窗口已满足时等待函数立即返回并标记 already-visible，不消耗整个等待预算' {
    # 只替换「窗口发现」这一步：让恢复函数报告窗口已满足（Restored=0、Satisfied=true），
    # 复现真实场景——被管的 Codex 窗口本来就好好地留在屏幕内。
    # 这正是修复前会空等到超时、把「本来就正常」误报成「恢复失败」的那条路径。
    $restoreFunction = Get-Command -Name 'Restore-FusionDreamSkinWindow' -CommandType Function
    $savedBody = $restoreFunction.ScriptBlock
    $script:restoreCalls = 0
    Set-Item -Path 'Function:Restore-FusionDreamSkinWindow' -Value {
      param($DreamSkinProfileToken, [string[]]$OfficialExecutables = @(), $LogPath)
      $script:restoreCalls++
      return [pscustomobject]@{ Restored = 0; AlreadyVisible = 1; Satisfied = $true; Detail = '窗口已在屏幕内可见。' }
    }
    try {
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $wait = Wait-FusionDreamSkinWindowRestored -DreamSkinProfileToken 'token' `
        -OfficialExecutables @('C:\fake\ChatGPT.exe') -MaxWaitSeconds 150 -LogPath (Join-Path $env:TEMP 'fusion-test.log')
      $sw.Stop()
      $wait.Attempts | Should Be 1
      $wait.Reason | Should Be 'already-visible'
      $wait.Satisfied | Should Be $true
      $script:restoreCalls | Should Be 1
      # 关键：不能空等到 150 秒。留足富余量，避免把机器慢误判成失败。
      ($sw.Elapsed.TotalSeconds -lt 60) | Should Be $true
    }
    finally {
      Set-Item -Path 'Function:Restore-FusionDreamSkinWindow' -Value $savedBody
    }
  }
}

Describe '验证退出码兜底' {

  It '缺少验证脚本时如实报失败，不伪装成功' {
    $result = Invoke-FusionDreamSkinVerify -VerifyScript (Join-Path $env:TEMP 'no-such-verify.ps1') -Attempts 1
    $result.Passed | Should Be $false
    $result.Detail | Should Match '缺失'
  }

  It '验证进程给出退出码 0 时判定通过' {
    $root = Join-Path $env:TEMP ('fusion-verify-ok-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $script = Join-Path $root 'verify-ok.ps1'
    # 模拟 Dream Skin 的验证脚本：成功时退出码 0。
    [System.IO.File]::WriteAllText($script, "param([int]`$Port)`nexit 0`n", (New-Object System.Text.UTF8Encoding($true)))
    try {
      $result = Invoke-FusionDreamSkinVerify -VerifyScript $script -Attempts 1 -TimeoutSeconds 60
      $result.Passed | Should Be $true
      $result.ExitCode | Should Be 0
    }
    finally {
      Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
    }
  }

  It '验证进程给出非零退出码时判定未通过，并保留失败证据' {
    $root = Join-Path $env:TEMP ('fusion-verify-fail-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $script = Join-Path $root 'verify-fail.ps1'
    [System.IO.File]::WriteAllText($script, "param([int]`$Port)`nexit 7`n", (New-Object System.Text.UTF8Encoding($true)))
    try {
      $result = Invoke-FusionDreamSkinVerify -VerifyScript $script -Attempts 1 -TimeoutSeconds 60
      $result.Passed | Should Be $false
      $result.ExitCode | Should Be 7
    }
    finally {
      Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
    }
  }
}
