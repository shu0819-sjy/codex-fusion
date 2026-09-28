# Regression tests for the Code-Codex session claim.
#
# Why this exists: Code-Codex's launcher chain (root shim -> versioned GUI wrapper -> console launcher)
# delegates, spawns Codex detached, and then exits. On the return leg no launcher process is left to
# prove ownership, so the surviving Codex used to be treated as a foreign session and the switch was
# blocked. Ownership is now persisted at launch time and re-verified against the live snapshot.

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path (Split-Path -Parent $here) 'switch-common.ps1')

$script:officialExe = 'C:\Program Files\WindowsApps\OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe'
$script:ccxRoot = 'C:\Users\ROG\AppData\Local\Programs\Code-Codex'
$script:dreamProfileToken = '--user-data-dir=C:\Users\ROG\AppData\Local\CodexDreamSkin\cdp-profile'
$script:signature = '--remote-debugging-address=127.0.0.1 --remote-debugging-port=59555 --disable-direct-composition'

function New-FusionTestRecord {
  param($Id, $Parent, $Name, $Path, $CommandLine, $Created)
  return [pscustomobject]@{
    ProcessId       = $Id
    ParentProcessId = $Parent
    Name            = $Name
    ExecutablePath  = $Path
    CommandLine     = $CommandLine
    CreationDate    = $Created
  }
}

function New-FusionTestSessionFile {
  param([int[]]$Ids = @(12748), [string[]]$Exes = $null, [datetime]$Started = ([datetime]'2026-09-13T17:50:00'))
  if (-not $Exes) { $Exes = @($script:officialExe) }
  $path = Join-Path $env:TEMP ('fusion-session-' + [guid]::NewGuid().ToString('N') + '.json')
  [void](Save-FusionCodeCodexSession -Path $path -ProcessIds $Ids -Executables $Exes -StartedAt $Started `
    -CodeCodexRoot $script:ccxRoot -Port 9335)
  return $path
}

Describe 'Code-Codex session claim: survives the launcher exiting' {

  It 'round-trips a session record and claims the surviving Codex root' {
    $path = $null
    try {
      $started = [datetime]'2026-09-13T17:50:00'
      $path = New-FusionTestSessionFile -Started $started
      (Test-Path -LiteralPath $path -PathType Leaf) | Should Be $true

      $claim = Read-FusionCodeCodexSession -Path $path
      $claim | Should Not BeNullOrEmpty
      $claim.Kind | Should Be 'code-codex-session'
      ($claim.ProcessIds -join ',') | Should Be '12748'

      $snapshot = @(New-FusionTestRecord 12748 50488 'ChatGPT.exe' $script:officialExe $script:signature ($started.AddSeconds(45)))
      $hit = @(Test-FusionCodeCodexSessionClaim -Claim $claim -Snapshot $snapshot -OfficialExecutables @($script:officialExe))
      ($hit -join ',') | Should Be '12748'
    }
    finally {
      if ($path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
  }

  It 'the selector reports session-claim ownership when no launcher is running' {
    $path = $null
    try {
      $started = [datetime]'2026-09-13T17:50:00'
      $path = New-FusionTestSessionFile -Started $started
      $claim = Read-FusionCodeCodexSession -Path $path
      $snapshot = @(New-FusionTestRecord 12748 50488 'ChatGPT.exe' $script:officialExe $script:signature ($started.AddSeconds(45)))

      $owned = @(Select-FusionCodeCodexOwnedProcesses -Snapshot $snapshot -LauncherIds @() `
        -OfficialExecutables @($script:officialExe) -SessionClaim $claim)
      $owned.Count | Should Be 1
      $owned[0].ProcessId | Should Be 12748
      $owned[0].Ownership | Should Be 'code-codex-session-claim'
    }
    finally {
      if ($path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
  }

  It 'reports code-codex mode from the record alone, and no foreign session' {
    $path = $null
    try {
      $started = [datetime]'2026-09-13T17:50:00'
      $path = New-FusionTestSessionFile -Started $started
      $snapshot = @(New-FusionTestRecord 12748 50488 'ChatGPT.exe' $script:officialExe $script:signature ($started.AddSeconds(45)))

      $mode = Get-FusionMode -Snapshot $snapshot -OfficialExecutables @($script:officialExe) `
        -CodeCodexRoot $script:ccxRoot -DreamSkinExecutable $script:officialExe -SessionPath $path
      $mode.Mode | Should Be 'code-codex'
      $mode.CodeCodexProcesses.Count | Should Be 1
      $mode.ForeignCodexProcesses.Count | Should Be 0
      ($mode.SessionClaimProcessIds -join ',') | Should Be '12748'
    }
    finally {
      if ($path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
  }

  It 'still reports none (and a foreign session) when no record exists' {
    $missing = Join-Path $env:TEMP ('fusion-missing-' + [guid]::NewGuid().ToString('N') + '.json')
    $started = [datetime]'2026-09-13T17:50:00'
    $snapshot = @(New-FusionTestRecord 12748 50488 'ChatGPT.exe' $script:officialExe $script:signature ($started.AddSeconds(45)))

    $mode = Get-FusionMode -Snapshot $snapshot -OfficialExecutables @($script:officialExe) `
      -CodeCodexRoot $script:ccxRoot -DreamSkinExecutable $script:officialExe -SessionPath $missing
    $mode.Mode | Should Be 'none'
    $mode.CodeCodexProcesses.Count | Should Be 0
    $mode.ForeignCodexProcesses.Count | Should Be 1
  }

  It 'never claims anything without a live launcher and without a record' {
    $started = [datetime]'2026-09-13T17:50:00'
    $snapshot = @(New-FusionTestRecord 12748 50488 'ChatGPT.exe' $script:officialExe $script:signature ($started.AddSeconds(45)))
    $owned = @(Select-FusionCodeCodexOwnedProcesses -Snapshot $snapshot -LauncherIds @() `
      -OfficialExecutables @($script:officialExe) -SessionClaim $null)
    $owned.Count | Should Be 0
  }
}

Describe 'Code-Codex session claim: refuses weak or recycled evidence' {

  It 'ignores a record whose pid no longer carries the Code-Codex launch signature' {
    $path = $null
    try {
      $started = [datetime]'2026-09-13T17:50:00'
      $path = New-FusionTestSessionFile -Started $started
      $claim = Read-FusionCodeCodexSession -Path $path
      # Same pid, but the command line is a plain Dream Skin style launch with no Code-Codex marker.
      $snapshot = @(New-FusionTestRecord 12748 50488 'ChatGPT.exe' $script:officialExe `
        '--remote-debugging-address=127.0.0.1 --remote-debugging-port=9335' ($started.AddSeconds(45)))
      @(Test-FusionCodeCodexSessionClaim -Claim $claim -Snapshot $snapshot -OfficialExecutables @($script:officialExe)).Count | Should Be 0
    }
    finally {
      if ($path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
  }

  It 'ignores a reused pid when the executable is not an official Codex build' {
    $path = $null
    try {
      $started = [datetime]'2026-09-13T17:50:00'
      $path = New-FusionTestSessionFile -Started $started
      $claim = Read-FusionCodeCodexSession -Path $path
      $snapshot = @(New-FusionTestRecord 12748 50488 'ChatGPT.exe' 'C:\Other\ChatGPT.exe' $script:signature ($started.AddSeconds(45)))
      @(Test-FusionCodeCodexSessionClaim -Claim $claim -Snapshot $snapshot -OfficialExecutables @($script:officialExe)).Count | Should Be 0
    }
    finally {
      if ($path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
  }

  It 'never claims a Dream Skin profile session' {
    $path = $null
    try {
      $started = [datetime]'2026-09-13T17:50:00'
      $path = New-FusionTestSessionFile -Started $started
      $claim = Read-FusionCodeCodexSession -Path $path
      $commandLine = "$script:dreamProfileToken $script:signature"
      $snapshot = @(New-FusionTestRecord 12748 50488 'ChatGPT.exe' $script:officialExe $commandLine ($started.AddSeconds(45)))
      @(Test-FusionCodeCodexSessionClaim -Claim $claim -Snapshot $snapshot -OfficialExecutables @($script:officialExe) `
        -DreamSkinProfileToken $script:dreamProfileToken).Count | Should Be 0
    }
    finally {
      if ($path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
  }

  It 'ignores a process that predates the recorded launch' {
    $path = $null
    try {
      $started = [datetime]'2026-09-13T17:50:00'
      $path = New-FusionTestSessionFile -Started $started
      $claim = Read-FusionCodeCodexSession -Path $path
      $snapshot = @(New-FusionTestRecord 12748 50488 'ChatGPT.exe' $script:officialExe $script:signature ($started.AddSeconds(-30)))
      @(Test-FusionCodeCodexSessionClaim -Claim $claim -Snapshot $snapshot -OfficialExecutables @($script:officialExe)).Count | Should Be 0
    }
    finally {
      if ($path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
  }

  It 'treats missing, empty, malformed and foreign records as no evidence' {
    $missing = Join-Path $env:TEMP ('fusion-none-' + [guid]::NewGuid().ToString('N') + '.json')
    (Read-FusionCodeCodexSession -Path $missing) | Should BeNullOrEmpty
    (Read-FusionCodeCodexSession -Path '') | Should BeNullOrEmpty

    $cases = @(
      '{}',
      '{"schemaVersion":1,"kind":"something-else","processIds":[123]}',
      '{"schemaVersion":1,"kind":"code-codex-session","processIds":[]}',
      'not json at all'
    )
    foreach ($payload in $cases) {
      $path = Join-Path $env:TEMP ('fusion-bad-' + [guid]::NewGuid().ToString('N') + '.json')
      try {
        [System.IO.File]::WriteAllText($path, $payload, (New-Object System.Text.UTF8Encoding($true)))
        (Read-FusionCodeCodexSession -Path $path) | Should BeNullOrEmpty
      }
      finally {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
      }
    }
  }

  It 'writes no record when there is no ownership evidence' {
    $path = Join-Path $env:TEMP ('fusion-noids-' + [guid]::NewGuid().ToString('N') + '.json')
    (Save-FusionCodeCodexSession -Path $path -ProcessIds @() -Executables @($script:officialExe)) | Should BeNullOrEmpty
    (Test-Path -LiteralPath $path) | Should Be $false
  }
}
