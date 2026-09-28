[CmdletBinding()]
param(
  [string]$Workspace,
  [switch]$NoDreamSkin
)

$ErrorActionPreference = 'Stop'
$fusionRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $fusionRoot 'fusion-config.json'
$logPath = Join-Path $fusionRoot 'logs\fusion.log'
$windowPath = Join-Path $fusionRoot 'workspace-window.ps1'

function Write-FusionLog {
  <# 功能：记录融合启动器事件。入参：消息字符串。返回值：无；日志目录不可写时只保留控制台错误。 #>
  param([Parameter(Mandatory = $true)][string]$Message)
  try {
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  } catch {
    Write-Warning "融合日志写入失败：$($_.Exception.Message)"
  }
}

function Get-FusionConfig {
  <# 功能：读取并校验本地融合配置。入参：配置文件路径。返回值：配置对象；文件缺失、字段非法或危险配置时抛出异常。 #>
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "配置文件不存在：$Path"
  }
  $config = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $config.workspace) { throw '配置缺少 workspace' }
  $config.workspace = [IO.Path]::GetFullPath([string]$config.workspace)
  if (-not (Test-Path -LiteralPath $config.workspace -PathType Container)) {
    throw "工作区不存在：$($config.workspace)"
  }
  if ($null -eq $config.PSObject.Properties['safeMode']) {
    $config | Add-Member -NotePropertyName safeMode -NotePropertyValue $true -Force
  }
  if (-not [bool]$config.safeMode) {
    throw 'safeMode=false 已被拒绝：Fusion 要求始终限制在工作区根内'
  }
  if ($null -eq $config.PSObject.Properties['dreamSkinPort'] -or [string]::IsNullOrWhiteSpace([string]$config.dreamSkinPort)) {
    throw '配置缺少 dreamSkinPort'
  }
  $port = 0
  if (-not [int]::TryParse([string]$config.dreamSkinPort, [ref]$port)) {
    throw "dreamSkinPort 不是整数：$($config.dreamSkinPort)"
  }
  if ($port -lt 1024 -or $port -gt 65535) {
    throw "dreamSkinPort 超出允许范围：$port"
  }
  if ($port -eq 17890) {
    throw 'dreamSkinPort 不能与主题服务端口 17890 相同'
  }
  if ($port -ne 9335) {
    throw "dreamSkinPort=$port 与宿主固定 CDP 端口 9335 不一致"
  }
  $config.dreamSkinPort = $port
  if ([string]::IsNullOrWhiteSpace([string]$config.dreamSkinStateRoot)) {
    throw '配置缺少 dreamSkinStateRoot'
  }
  if ([string]$config.dreamSkinStateRoot -match '\.\.') {
    throw 'dreamSkinStateRoot 不合法'
  }
  $config.dreamSkinStateRoot = [IO.Path]::GetFullPath([string]$config.dreamSkinStateRoot)
  if (-not (Test-Path -LiteralPath $config.dreamSkinStateRoot -PathType Container)) {
    throw "dreamSkinStateRoot 不存在：$($config.dreamSkinStateRoot)"
  }
  return $config
}

function Set-FusionState {
  <# 功能：回写融合运行状态。入参：状态值、最后动作和 Dream Skin 是否由本次启动。返回值：无；状态文件写失败时记录日志但不覆盖主流程错误。 #>
  param(
    [Parameter(Mandatory = $true)][string]$Status,
    [Parameter(Mandatory = $true)][string]$LastAction,
    [bool]$DreamSkinManaged = $false,
    [bool]$WorkspaceWindowManaged = $false
  )
  try {
    $state = [ordered]@{
      version = '0.1.0'
      status = $Status
      lastAction = $LastAction
      dreamSkinManaged = $DreamSkinManaged
      workspaceWindowManaged = $WorkspaceWindowManaged
      officialCodexModified = $false
    }
    $state | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fusionRoot 'state.json') -Encoding UTF8
  } catch {
    Write-FusionLog "状态回写失败：$($_.Exception.Message)"
  }
}

function Start-DreamSkin {
  <# 功能：请求 Dream Skin 使用现有官方 Codex 会话。入参：Dream Skin 状态根目录和端口。返回值：启动进程对象；脚本不存在时抛出异常。 #>
  param(
    [Parameter(Mandatory = $true)][string]$StateRoot,
    [Parameter(Mandatory = $true)][int]$Port
  )
  $scriptPath = Join-Path $StateRoot 'engine\scripts\start-dream-skin.ps1'
  if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw "Dream Skin 启动脚本不存在：$scriptPath"
  }
  $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $args = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'RemoteSigned', '-File', $scriptPath, '-RestartExisting', '-Port', "$Port")
  return Start-Process -FilePath $powershell -ArgumentList $args -WindowStyle Hidden -PassThru
}

try {
  $config = Get-FusionConfig -Path $configPath
  Write-FusionLog "启动 Codex Fusion $($config.version)，工作区：$($config.workspace)"
  Set-FusionState -Status 'starting' -LastAction 'start-requested'
  if (-not $NoDreamSkin) {
    $dreamProcess = Start-DreamSkin -StateRoot ([string]$config.dreamSkinStateRoot) -Port ([int]$config.dreamSkinPort)
    Write-FusionLog "已请求 Dream Skin，PID=$($dreamProcess.Id)"
    Set-FusionState -Status 'running' -LastAction 'dream-skin-started' -DreamSkinManaged $true -WorkspaceWindowManaged $true
  } else {
    Write-FusionLog '按参数跳过 Dream Skin，仅启动工作区窗口'
    Set-FusionState -Status 'running' -LastAction 'workspace-window-started' -WorkspaceWindowManaged $true
  }
  & $windowPath -Workspace $config.workspace -FusionRoot $fusionRoot -SafeMode ([bool]$config.safeMode)
  Write-FusionLog '工作区窗口已退出'
  Set-FusionState -Status 'stopped' -LastAction 'workspace-window-exited'
} catch {
  Write-FusionLog "启动失败：$($_.Exception.Message)"
  Write-Error $_
  exit 1
}
