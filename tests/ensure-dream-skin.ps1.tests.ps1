# 启动自检（Fusion 作为唯一入口）的决策规则单元测试。
# 重点：自动进入 Dream Skin 必须永远是「非破坏性」的——
#       只有完全没有模式在跑时才连接，且连接时绝不带 -RestartExisting。

. (Join-Path (Split-Path -Parent $PSCommandPath) '..\switch-common.ps1')

Describe 'ensure Dream Skin on startup' {
  It 'does nothing when Dream Skin is already the running mode' {
    $mode = [pscustomobject]@{ Mode = 'dream-skin'; ForeignCodexProcesses = @(); CodeCodexLaunchers = @(); CodeCodexProcesses = @() }
    $decision = Get-FusionEnsureDreamSkinDecision -Mode $mode
    $decision.Outcome | Should Be 'already-active'
    $decision.ShouldConnect | Should Be $false
  }

  It 'blocks instead of closing a running Code-Codex session' {
    $mode = [pscustomobject]@{ Mode = 'code-codex'; ForeignCodexProcesses = @(); CodeCodexLaunchers = @(1); CodeCodexProcesses = @(2) }
    $decision = Get-FusionEnsureDreamSkinDecision -Mode $mode
    $decision.Outcome | Should Be 'blocked'
    $decision.ShouldConnect | Should Be $false
    $decision.RestartExisting | Should Be $false
  }

  It 'blocks when both modes look active' {
    $mode = [pscustomobject]@{ Mode = 'both'; ForeignCodexProcesses = @(); CodeCodexLaunchers = @(); CodeCodexProcesses = @() }
    (Get-FusionEnsureDreamSkinDecision -Mode $mode).Outcome | Should Be 'blocked'
  }

  It 'blocks when an unrelated Codex session is running' {
    $mode = [pscustomobject]@{ Mode = 'none'; ForeignCodexProcesses = @(3412); CodeCodexLaunchers = @(); CodeCodexProcesses = @() }
    $decision = Get-FusionEnsureDreamSkinDecision -Mode $mode
    $decision.Outcome | Should Be 'blocked'
    $decision.ShouldConnect | Should Be $false
  }

  It 'connects without restarting anything when no mode is running' {
    $mode = [pscustomobject]@{ Mode = 'none'; ForeignCodexProcesses = @(); CodeCodexLaunchers = @(); CodeCodexProcesses = @() }
    $decision = Get-FusionEnsureDreamSkinDecision -Mode $mode
    $decision.Outcome | Should Be 'connect'
    $decision.ShouldConnect | Should Be $true
    $decision.RestartExisting | Should Be $false
  }

  It 'never asks for a forced restart, in any of the four cases' {
    $cases = @(
      [pscustomobject]@{ Mode = 'dream-skin'; ForeignCodexProcesses = @() },
      [pscustomobject]@{ Mode = 'code-codex'; ForeignCodexProcesses = @() },
      [pscustomobject]@{ Mode = 'both'; ForeignCodexProcesses = @() },
      [pscustomobject]@{ Mode = 'none'; ForeignCodexProcesses = @() }
    )
    foreach ($case in $cases) {
      (Get-FusionEnsureDreamSkinDecision -Mode $case).RestartExisting | Should Be $false
    }
  }

  It 'treats a missing foreign list as no foreign session' {
    $mode = [pscustomobject]@{ Mode = 'none' }
    (Get-FusionEnsureDreamSkinDecision -Mode $mode).Outcome | Should Be 'connect'
  }
}
