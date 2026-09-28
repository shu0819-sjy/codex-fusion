[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$fusionRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath = Join-Path $fusionRoot 'logs\fusion.log'

function Write-FusionStopLog {
  <# 功能：记录停止操作。入参：消息字符串。返回值：无；日志不可写时不阻断停止流程。 #>
  param([Parameter(Mandatory = $true)][string]$Message)
  try { Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message" -Encoding UTF8 } catch { }
}

try {
  $windowScript = Join-Path $fusionRoot 'workspace-window.ps1'
  $startScript = Join-Path $fusionRoot 'start-codex-fusion.ps1'
  $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains($windowScript)
  })
  foreach ($process in $processes) {
    if ($process.ProcessId -ne $PID) {
      Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
    }
  }
  $startPattern = [regex]::Escape($startScript)
  $launchers = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.Name -eq 'powershell.exe' -and
    $_.CommandLine -match ('(?i)-File\s+"?' + $startPattern)
  })
  foreach ($launcher in $launchers) {
    Stop-Process -Id ([int]$launcher.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  $statePath = Join-Path $fusionRoot 'state.json'
  if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $state.status = 'stopped'
    $state.lastAction = 'workspace-window-stopped'
    $state.workspaceWindowManaged = $false
    $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
  }
  Write-FusionStopLog "已停止融合工作区窗口和启动器，共处理 $($processes.Count) 个窗口进程、$($launchers.Count) 个启动器进程；官方 Codex 与 Dream Skin 未操作。"
} catch {
  Write-FusionStopLog "停止失败：$($_.Exception.Message)"
  Write-Error $_
  exit 1
}
