# Codex Fusion 模式切换共享库。
# 被 switch-to-code-codex.ps1 与 switch-to-dream-skin.ps1 复用。
# 设计约束（不可放宽）：
#   1) 关闭进程必须同时满足「可执行文件路径匹配」与「Dream Skin 配置档案路径匹配」，
#      绝不按进程名批量结束进程；
#   2) Code-Codex 拥有自己的进程所有权校验（Job Object + is_executable_running），
#      本库只负责在切换前把 Dream Skin 管理的 Codex 正常关掉，让 Code-Codex 自己的校验通过，
#      绝不绕过、绝不伪造它的校验结果；
#   3) 任何一步失败都必须能回到原模式（由调用方执行回滚）。
# 纯选择函数（Select-* / Get-FusionMode / Get-FusionDescendantIds）只吃快照数组，
# 便于用固定数据做单元测试，不触碰真实进程。

# 统一输出编码为 UTF-8：宿主（Rust）按 UTF-8 捕获 stdout/stderr，避免中文错误信息乱码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$script:FusionSwitchExitCodes = [ordered]@{
  Success                 = 0
  UnexpectedFailure       = 1
  Blocked                 = 2
  Cancelled               = 3
  VerificationFailed      = 4
  RollbackFailed          = 5
}

# 功能：把规范化后的进程快照字段整理成统一结构。入参：原始进程对象。返回值：统一字段对象。
function ConvertTo-FusionProcessRecord {
  param([Parameter(Mandatory = $true)][object]$Process)
  $name = if ($Process.PSObject.Properties.Name -contains 'Name') { "$($Process.Name)" } else { '' }
  $path = if ($Process.PSObject.Properties.Name -contains 'ExecutablePath') { "$($Process.ExecutablePath)" } else { '' }
  $commandLine = if ($Process.PSObject.Properties.Name -contains 'CommandLine') { "$($Process.CommandLine)" } else { '' }
  $parent = 0
  if ($Process.PSObject.Properties.Name -contains 'ParentProcessId') {
    [void][int]::TryParse("$($Process.ParentProcessId)", [ref]$parent)
  }
  $processId = 0
  if ($Process.PSObject.Properties.Name -contains 'ProcessId') {
    [void][int]::TryParse("$($Process.ProcessId)", [ref]$processId)
  }
  $creationDate = $null
  if ($Process.PSObject.Properties.Name -contains 'CreationDate') {
    try { $creationDate = [datetime]$Process.CreationDate } catch { $creationDate = $null }
  }
  return [pscustomobject]@{
    ProcessId       = $processId
    ParentProcessId = $parent
    Name            = $name
    ExecutablePath  = $path
    CommandLine     = $commandLine
    CreationDate    = $creationDate
  }
}

# 功能：读取进程快照。入参：可选快照文件（测试用）。返回值：规范化进程数组；边界：快照文件缺失时回退到真实进程查询。
function Get-FusionProcessSnapshot {
  param([string]$SourceFile)
  $raw = @()
  if ($SourceFile) {
    if (-not (Test-Path -LiteralPath $SourceFile -PathType Leaf)) {
      throw "进程快照文件不存在：$SourceFile"
    }
    $text = Get-Content -LiteralPath $SourceFile -Raw -Encoding UTF8
    $parsed = $text | ConvertFrom-Json -ErrorAction Stop
    $raw = @($parsed)
  } else {
    $raw = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  }
  $records = @()
  foreach ($item in $raw) { $records += ConvertTo-FusionProcessRecord -Process $item }
  return $records
}

# 功能：解析切换所需的固定路径。入参：Dream Skin 状态根、Code-Codex 安装根。返回值：路径对象。
function Get-FusionSwitchPaths {
  param(
    [string]$StateRoot = (Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'),
    [string]$CodeCodexRoot = (Join-Path $env:LOCALAPPDATA 'Programs\Code-Codex'),
    [string]$FusionRoot = $PSScriptRoot
  )
  $fullStateRoot = [System.IO.Path]::GetFullPath($StateRoot)
  $fullCodeCodexRoot = [System.IO.Path]::GetFullPath($CodeCodexRoot)
  $scripts = Join-Path $fullStateRoot 'engine\scripts'
  return [pscustomobject]@{
    StateRoot         = $fullStateRoot
    StatePath         = Join-Path $fullStateRoot 'state.json'
    PauseFile         = Join-Path $fullStateRoot 'paused'
    ActiveTheme       = Join-Path $fullStateRoot 'active-theme'
    PanelScript       = Join-Path $fullStateRoot 'start-codex-and-panel.ps1'
    ScriptsRoot       = $scripts
    CommonScript      = Join-Path $scripts 'common-windows.ps1'
    ThemeScript       = Join-Path $scripts 'theme-windows.ps1'
    VerifyScript      = Join-Path $scripts 'verify-dream-skin.ps1'
    StartSkinScript   = Join-Path $scripts 'start-dream-skin.ps1'
    CodeCodexRoot     = $fullCodeCodexRoot
    CodeCodexLauncher = Join-Path $fullCodeCodexRoot 'CodeCodex.exe'
    CodeCodexVersion  = Join-Path $fullCodeCodexRoot 'current-version'
    CodeCodexVersions = Join-Path $fullCodeCodexRoot 'versions'
    # Code-Codex 的启动器链路（根 shim -> 版本化 GUI 包装 -> 控制台启动器）会在把 Codex 分离拉起后全部退出，
    # 因此「启动器还活着」不能当作回程唯一的归属证据。启动成功时把会话凭据落盘，回程据此认领。
    StateDir          = Join-Path ([System.IO.Path]::GetFullPath($FusionRoot)) 'state'
    SessionPath       = Join-Path (Join-Path ([System.IO.Path]::GetFullPath($FusionRoot)) 'state') 'code-codex-session.json'
    FusionRoot        = [System.IO.Path]::GetFullPath($FusionRoot)
    LogPath           = Join-Path ([System.IO.Path]::GetFullPath($FusionRoot)) 'logs\fusion.log'
    LogsRoot          = Join-Path ([System.IO.Path]::GetFullPath($FusionRoot)) 'logs'
  }
}

# 功能：写入切换日志。入参：消息、日志路径。返回值：无；边界：日志不可写时只在控制台告警，不中断切换。
function Write-FusionSwitchLog {
  param(
    [Parameter(Mandatory = $true)][string]$Message,
    [string]$LogPath
  )
  $line = "$(Get-Date -Format o) [switch] $Message"
  if ($LogPath) {
    try {
      $directory = [System.IO.Path]::GetDirectoryName($LogPath)
      if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        [void][System.IO.Directory]::CreateDirectory($directory)
      }
      Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
    } catch {
      Write-Warning "切换日志写入失败：$($_.Exception.Message)"
    }
  }
  Write-Verbose $line
}

# 功能：校验 Dream Skin 官方脚本库是否存在。入参：路径对象。返回值：无；边界：脚本缺失时抛出明确错误。
# 注意：这里只做校验，不做 dot-source。dot-source 必须由调用脚本在自身作用域里执行，
# 若在函数内部 dot-source，被导入的函数会随函数作用域一起消失，调用方会拿不到任何 Dream Skin 函数。
function Assert-FusionDreamSkinLibrary {
  param([Parameter(Mandatory = $true)][object]$Paths)
  foreach ($required in @($Paths.CommonScript, $Paths.ThemeScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Dream Skin 脚本库缺失：$required"
    }
  }
}

# 功能：判断命令行是否带指定参数标记（与 Dream Skin 自身语义一致）。入参：命令行、标记、是否忽略引号。
# 返回值：是否匹配；边界：Chromium 有时把参数值写成 --flag="值"、有时写成 --flag=值，忽略引号后两种写法都能匹配。
function Test-FusionCommandLineToken {
  param([string]$CommandLine, [string]$Token, [switch]$IgnoreQuotes)
  if (-not $CommandLine -or -not $Token) { return $false }
  if ($IgnoreQuotes) { $CommandLine = $CommandLine -replace '"', '' }
  $pattern = '(?i)(?:^|[\s"])' + [regex]::Escape($Token) + '(?=$|[\s"])'
  return [regex]::IsMatch($CommandLine, $pattern)
}

# 功能：计算 Dream Skin 档案路径标记。入参：档案路径。返回值：--user-data-dir 标记；边界：空路径返回 $null。
function Get-FusionProfileToken {
  param([string]$ProfilePath)
  if (-not $ProfilePath) { return $null }
  return '--user-data-dir=' + ([System.IO.Path]::GetFullPath($ProfilePath))
}

# 功能：从快照中挑出「Dream Skin 管理」的官方 Codex 进程。入参：快照、官方可执行文件路径、档案标记、是否允许缺少档案标记。
# 返回值：候选对象数组（含 Ownership 理由）；边界：档案标记缺失且未显式允许时返回空数组，绝不退化成按名字批量匹配。
function Select-FusionDreamSkinCodexProcesses {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Snapshot,
    [Parameter(Mandatory = $true)][string]$Executable,
    [string]$ProfileToken,
    [switch]$AllowMissingProfileToken
  )
  $results = @()
  if (-not $Executable) { return $results }
  $expected = [System.IO.Path]::GetFullPath($Executable)
  foreach ($process in $Snapshot) {
    if ("$($process.Name)" -ine 'ChatGPT.exe') { continue }
    $path = "$($process.ExecutablePath)"
    if (-not $path) { continue }
    if (-not ([System.IO.Path]::GetFullPath($path)).Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    $commandLine = "$($process.CommandLine)"
    if ($ProfileToken) {
      if (-not (Test-FusionCommandLineToken -CommandLine $commandLine -Token $ProfileToken -IgnoreQuotes)) { continue }
      $ownership = 'exe-path-and-dream-skin-profile'
    } else {
      if (-not $AllowMissingProfileToken) { continue }
      # 缺少档案标记时只接受根进程，避免误伤其他 Codex 会话的渲染进程。
      if ($commandLine -match '(?i)(?:^|\s)--type(?:=|\s+)') { continue }
      $ownership = 'exe-path-only-no-profile-recorded'
    }
    $results += [pscustomobject]@{
      ProcessId       = [int]$process.ProcessId
      ParentProcessId = [int]$process.ParentProcessId
      Name            = "$($process.Name)"
      ExecutablePath  = $path
      CommandLine     = $commandLine
      Ownership       = $ownership
    }
  }
  return $results
}

# 功能：从快照中挑出 Code-Codex 自己的启动器进程（安装根目录内的可执行文件）。入参：快照、安装根。返回值：候选数组。
function Select-FusionCodeCodexLaunchers {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Snapshot,
    [Parameter(Mandatory = $true)][string]$InstallRoot
  )
  $results = @()
  if (-not $InstallRoot) { return $results }
  $root = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') + '\'
  foreach ($process in $Snapshot) {
    $path = "$($process.ExecutablePath)"
    if (-not $path) { continue }
    $full = [System.IO.Path]::GetFullPath($path)
    if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    $fileName = [System.IO.Path]::GetFileName($full)
    if ($fileName -notmatch '(?i)^(CodeCodex|code-codex)(\.Shortcut)?\.exe$') { continue }
    $results += [pscustomobject]@{
      ProcessId       = [int]$process.ProcessId
      ParentProcessId = [int]$process.ParentProcessId
      Name            = "$($process.Name)"
      ExecutablePath  = $full
      CommandLine     = "$($process.CommandLine)"
      CreationDate    = $process.CreationDate
      Ownership       = 'code-codex-install-root'
    }
  }
  return $results
}

# 功能：由根进程号展开全部后代进程号（纯函数，不吃真实进程表）。入参：快照、根进程号。返回值：后代进程号数组（不含根）。
function Get-FusionDescendantIds {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Snapshot,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][int[]]$RootIds
  )
  $roots = @{}
  foreach ($id in $RootIds) { if ($id -gt 0) { $roots[$id] = $true } }
  $children = @{}
  foreach ($process in $Snapshot) {
    $parent = [int]$process.ParentProcessId
    if ($parent -le 0) { continue }
    if (-not $children.ContainsKey($parent)) { $children[$parent] = @() }
    $children[$parent] += [int]$process.ProcessId
  }
  $found = @{}
  $queue = [System.Collections.Generic.Queue[int]]::new()
  foreach ($id in $roots.Keys) { $queue.Enqueue([int]$id) }
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    if (-not $children.ContainsKey($current)) { continue }
    foreach ($child in $children[$current]) {
      if ($found.ContainsKey($child)) { continue }
      $found[$child] = $true
      $queue.Enqueue($child)
    }
  }
  return @($found.Keys | Sort-Object)
}

# 功能：挑出 Code-Codex 拥有的官方 Codex 进程。入参：快照、启动器进程号、官方可执行文件集合、Dream Skin 档案标记、启动器最早创建时间、启动器可执行文件路径集合。
# 返回值：候选数组（含 Ownership 理由）；边界：无法证明归属的进程一律不返回，避免误杀其他 Codex 会话。
# 归属规则（只接受能证明「这个 Codex 确实是 Code-Codex 启动的」证据，绝不退化成按 CDP 参数匹配）：
#   a) Code-Codex 通过 AppModel 激活（IApplicationActivationManager）启动打包版 Codex，所以 Codex 不是 CodeCodex.exe 的子进程，
#      不能靠父子链证明归属。改用「启动器启动时间之后新出现的官方 Codex 根进程」这一证据；
#   b) 同时要求命令行带 Code-Codex 专属标记（--disable-direct-composition 或 --inspect-brk=127.0.0.1:）——
#      这两种标记都由 Code-Codex 的 build_launch_arguments 专门注入，Dream Skin 从不使用；
#   c) 没有在运行的启动器（LauncherIds 为空）时一律返回空：孤儿 Codex 不归 Code-Codex 管理，不碰。
# 功能：判定命令行是否带 Code-Codex 专属启动标记。入参：命令行。返回值：是否匹配。
# 依据：--disable-direct-composition 与 --inspect-brk=127.0.0.1: 都由 Code-Codex 的 build_launch_arguments 专门注入，Dream Skin 从不使用。
function Test-FusionCodeCodexLaunchSignature {
  param([string]$CommandLine)
  if (-not $CommandLine) { return $false }
  if (Test-FusionCommandLineToken -CommandLine $CommandLine -Token '--disable-direct-composition') { return $true }
  return [regex]::IsMatch($CommandLine, '(?i)(?:^|\s)--inspect-brk=127\.0\.0\.1(?::\d+)?(?=\s|$)')
}

# 功能：读取落盘的 Code-Codex 会话凭据。入参：凭据路径。
# 返回值：凭据对象或 $null；边界：文件缺失、损坏或结构不符时一律返回 $null（宁可不认领，也绝不误杀别的会话）。
function Read-FusionCodeCodexSession {
  param([string]$Path)
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop
    if (-not $raw -or -not $raw.Trim()) { return $null }
    $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return $null
  }
  if (-not $parsed) { return $null }
  if ("$($parsed.schemaVersion)" -ne '1') { return $null }
  if ("$($parsed.kind)" -ne 'code-codex-session') { return $null }
  $ids = @()
  foreach ($item in @($parsed.processIds)) {
    if ($null -ne $item -and [int]$item -gt 0) { $ids += [int]$item }
  }
  if ($ids.Count -eq 0) { return $null }
  $startedAt = [datetime]::MinValue
  if ("$($parsed.startedAt)") {
    try { $startedAt = [datetime]$parsed.startedAt } catch { $startedAt = [datetime]::MinValue }
  }
  return [pscustomobject]@{
    SchemaVersion = 1
    Kind          = 'code-codex-session'
    ProcessIds    = @($ids | Sort-Object -Unique)
    Executables   = @(@($parsed.executables) | ForEach-Object { "$_" } | Where-Object { $_ })
    StartedAt     = $startedAt
    CodeCodexRoot = "$($parsed.codeCodexRoot)"
    Port          = $(if ("$($parsed.port)") { [int]$parsed.port } else { 0 })
    RecordedAt    = "$($parsed.recordedAt)"
  }
}

# 功能：用当前进程快照严格复核会话凭据，返回其中仍然成立的进程号。入参：凭据、快照、官方可执行文件集合、Dream Skin 档案标记。
# 返回值：可认领的进程号数组（空数组表示凭据已失效，调用方必须按「无证据」处理）。
# 边界：必须同时满足「进程号仍在」「进程名是 ChatGPT.exe」「可执行文件路径同时属于官方 Codex 与凭据记录」
#       「命令行带 Code-Codex 专属启动标记」「不是 Dream Skin 档案会话」「创建时间不早于凭据记录的开始时刻」，
#       任一不满足即不认领。这样即使进程号被系统复用，也不会把别人的窗口当成 Code-Codex 的会话。
function Test-FusionCodeCodexSessionClaim {
  param(
    [Parameter(Mandatory = $true)][object]$Claim,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Snapshot,
    [AllowEmptyCollection()][string[]]$OfficialExecutables = @(),
    [string]$DreamSkinProfileToken
  )
  $recorded = @()
  foreach ($item in @($Claim.Executables)) {
    if ($item) { $recorded += [System.IO.Path]::GetFullPath("$item") }
  }
  $official = @()
  foreach ($item in $OfficialExecutables) {
    if ($item) { $official += [System.IO.Path]::GetFullPath("$item") }
  }
  if ($recorded.Count -eq 0 -or $official.Count -eq 0) { return @() }
  $claimed = @{}
  foreach ($id in @($Claim.ProcessIds)) { $claimed[[int]$id] = $true }
  $matches = @()
  foreach ($process in $Snapshot) {
    $id = [int]$process.ProcessId
    if (-not $claimed.ContainsKey($id)) { continue }
    if ("$($process.Name)" -ine 'ChatGPT.exe') { continue }
    $path = "$($process.ExecutablePath)"
    if (-not $path) { continue }
    $full = [System.IO.Path]::GetFullPath($path)
    $isOfficial = $false
    foreach ($expected in $official) {
      if ($full.Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)) { $isOfficial = $true; break }
    }
    if (-not $isOfficial) { continue }
    $isRecorded = $false
    foreach ($expected in $recorded) {
      if ($full.Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)) { $isRecorded = $true; break }
    }
    if (-not $isRecorded) { continue }
    $commandLine = "$($process.CommandLine)"
    if (-not (Test-FusionCodeCodexLaunchSignature -CommandLine $commandLine)) { continue }
    if ($DreamSkinProfileToken -and (Test-FusionCommandLineToken -CommandLine $commandLine -Token $DreamSkinProfileToken)) { continue }
    $created = $process.CreationDate
    if ($null -ne $created -and $Claim.StartedAt -gt [datetime]::MinValue) {
      if ([datetime]$created -lt $Claim.StartedAt) { continue }
    }
    $matches += $id
  }
  return @($matches | Sort-Object -Unique)
}

# 功能：把 Code-Codex 会话凭据落盘。入参：路径、进程号集合、可执行文件集合、启动时刻、安装根、端口、日志路径。
# 返回值：写入的路径或 $null；边界：进程号集合为空时不写，避免落一份空凭据让回程产生虚假证据。
function Save-FusionCodeCodexSession {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [AllowEmptyCollection()][int[]]$ProcessIds = @(),
    [AllowEmptyCollection()][string[]]$Executables = @(),
    [datetime]$StartedAt = [datetime]::MinValue,
    [string]$CodeCodexRoot,
    [int]$Port = 0,
    [string]$LogPath
  )
  $ids = @()
  foreach ($id in @($ProcessIds)) { if ($null -ne $id -and [int]$id -gt 0) { $ids += [int]$id } }
  $ids = @($ids | Sort-Object -Unique)
  if ($ids.Count -eq 0) { return $null }
  $payload = [pscustomobject]@{
    schemaVersion = 1
    kind          = 'code-codex-session'
    processIds    = @($ids)
    executables   = @(@($Executables) | Where-Object { $_ } | Sort-Object -Unique)
    startedAt     = $(if ($StartedAt -gt [datetime]::MinValue) { $StartedAt.ToString('o') } else { $null })
    codeCodexRoot = "$CodeCodexRoot"
    port          = [int]$Port
    recordedAt    = (Get-Date).ToUniversalTime().ToString('o')
  }
  try {
    [void](Write-FusionSwitchResult -Path $Path -Result $payload)
  } catch {
    Write-FusionSwitchLog -Message "写入 Code-Codex 会话凭据失败（本次切换继续，但回程可能无法证明归属）：$($_.Exception.Message)" -LogPath $LogPath
    return $null
  }
  return [System.IO.Path]::GetFullPath($Path)
}

# 功能：清除会话凭据。入参：路径、日志路径。返回值：是否真的删除了文件；边界：文件不存在时静默返回 $false。
function Remove-FusionCodeCodexSession {
  param([string]$Path, [string]$LogPath)
  if (-not $Path) { return $false }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try {
    Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    Write-FusionSwitchLog -Message '已清除 Code-Codex 会话凭据。' -LogPath $LogPath
    return $true
  } catch {
    Write-FusionSwitchLog -Message "清除 Code-Codex 会话凭据失败：$($_.Exception.Message)" -LogPath $LogPath
    return $false
  }
}

function Select-FusionCodeCodexOwnedProcesses {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Snapshot,
    [AllowEmptyCollection()][int[]]$LauncherIds = @(),
    [AllowEmptyCollection()][string[]]$OfficialExecutables = @(),
    [string]$DreamSkinProfileToken,
    [datetime]$LauncherCreatedAfter = [datetime]::MinValue,
    [switch]$RequireDescendant,
    [object]$SessionClaim = $null
  )
  $results = @()
  # 没有在运行的 Code-Codex 启动器时，无法证明任何 Codex 归属 Code-Codex，直接返回空。
  # 没有运行中的启动器时，只有「启动成功时落盘的会话凭据」能证明归属；凭据缺失或复核不通过一律返回空。
  $claimedIds = @()
  if ($LauncherIds.Count -eq 0) {
    if (-not $SessionClaim) { return $results }
    $claimedIds = @(Test-FusionCodeCodexSessionClaim -Claim $SessionClaim -Snapshot $Snapshot `
      -OfficialExecutables $OfficialExecutables -DreamSkinProfileToken $DreamSkinProfileToken)
    if ($claimedIds.Count -eq 0) { return $results }
  }
  $expectedPaths = @()
  foreach ($item in $OfficialExecutables) {
    if ($item) { $expectedPaths += [System.IO.Path]::GetFullPath($item) }
  }
  if ($expectedPaths.Count -eq 0) { return $results }
  $descendants = @{}
  if ($LauncherIds.Count -gt 0) {
    foreach ($id in @(Get-FusionDescendantIds -Snapshot $Snapshot -RootIds $LauncherIds)) { $descendants[[int]$id] = $true }
  }
  $activeRootIds = @{}
  foreach ($process in $Snapshot) {
    if ("$($process.Name)" -ine 'ChatGPT.exe') { continue }
    if ($descendants.ContainsKey([int]$process.ProcessId)) { continue }
    $activeRootIds[[int]$process.ProcessId] = $true
  }
  foreach ($process in $Snapshot) {
    if ("$($process.Name)" -ine 'ChatGPT.exe') { continue }
    $path = "$($process.ExecutablePath)"
    if (-not $path) { continue }
    $full = [System.IO.Path]::GetFullPath($path)
    $pathMatches = $false
    foreach ($expected in $expectedPaths) {
      if ($full.Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)) { $pathMatches = $true; break }
    }
    if (-not $pathMatches) { continue }
    $commandLine = "$($process.CommandLine)"
    # 属于 Dream Skin 的会话绝不并入 Code-Codex 归属。
    if ($DreamSkinProfileToken -and (Test-FusionCommandLineToken -CommandLine $commandLine -Token $DreamSkinProfileToken)) { continue }
    # 启动器已退出时用会话凭据认领：进程号、官方可执行文件路径、专属启动标记、创建时间四重校验已在复核函数里完成。
    if ($claimedIds -contains [int]$process.ProcessId) {
      $results += [pscustomobject]@{
        ProcessId       = [int]$process.ProcessId
        ParentProcessId = [int]$process.ParentProcessId
        Name            = "$($process.Name)"
        ExecutablePath  = $full
        CommandLine     = $commandLine
        Ownership       = 'code-codex-session-claim'
      }
      continue
    }
    $isLauncherDescendant = $descendants.ContainsKey([int]$process.ProcessId)
    $hasLaunchSignature = (Test-FusionCommandLineToken -CommandLine $commandLine -Token '--disable-direct-composition') -or
      ($commandLine -match '(?i)(?:^|\s)--inspect-brk=127\.0\.0\.1(?::\d+)?(?=\s|$)')
    # 打包版 Codex 经 AppModel 激活，不是启动器后代；用「启动器启动时间之后新出现的根进程」+「Code-Codex 专属标记」证明归属。
    $isRootCreatedAfterLaunch = $false
    if (-not $isLauncherDescendant -and $LauncherCreatedAfter -gt [datetime]::MinValue) {
      $created = $process.CreationDate
      if ($null -ne $created -and $activeRootIds.ContainsKey([int]$process.ProcessId)) {
        $isRootCreatedAfterLaunch = ($created -ge $LauncherCreatedAfter)
      }
    }
    $ownership = $null
    if ($isLauncherDescendant) { $ownership = 'descendant-of-code-codex-launcher' }
    elseif ($hasLaunchSignature -and $isRootCreatedAfterLaunch) { $ownership = 'code-codex-launch-signature' }
    if (-not $ownership) { continue }
    $results += [pscustomobject]@{
      ProcessId       = [int]$process.ProcessId
      ParentProcessId = [int]$process.ParentProcessId
      Name            = "$($process.Name)"
      ExecutablePath  = $full
      CommandLine     = $commandLine
      Ownership       = $ownership
    }
  }
  return $results
}

# 功能：判定当前模式。入参：快照、官方可执行文件集合、Dream Skin 档案标记、Code-Codex 安装根。
# 返回值：模式对象（Mode 为 dream-skin / code-codex / both / none，并带两侧进程明细）。
function Get-FusionMode {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Snapshot,
    [AllowEmptyCollection()][string[]]$OfficialExecutables = @(),
    [string]$DreamSkinProfileToken,
    [Parameter(Mandatory = $true)][string]$CodeCodexRoot,
    [string]$DreamSkinExecutable,
    [string]$SessionPath
  )
  $firstExecutable = if ($OfficialExecutables.Count -gt 0) { "$($OfficialExecutables[0])" } else { '' }
  # 注意：必须用显式赋值加 @()，不能写成 `= if (...) { @(...) }`。
  # 语句结果在只有一个元素时会被 PowerShell 解包成标量，随后 .Count 就是 $null，
  # 会把「已确认的 Dream Skin 会话」误判成「未运行」。
  $dreamProcesses = @()
  if ($DreamSkinExecutable) {
    $dreamProcesses = @(Select-FusionDreamSkinCodexProcesses -Snapshot $Snapshot -Executable $DreamSkinExecutable -ProfileToken $DreamSkinProfileToken -AllowMissingProfileToken:$false)
  }
  $launchers = @(Select-FusionCodeCodexLaunchers -Snapshot $Snapshot -InstallRoot $CodeCodexRoot)
  # 启动器可能已经退出（Code-Codex 的启动器链路是「转发后退出」），此时靠启动时落盘的会话凭据证明归属。
  $sessionClaim = Read-FusionCodeCodexSession -Path $SessionPath
  $sessionClaimedIds = @()
  if ($launchers.Count -eq 0 -and $sessionClaim) {
    $sessionClaimedIds = @(Test-FusionCodeCodexSessionClaim -Claim $sessionClaim -Snapshot $Snapshot `
      -OfficialExecutables $OfficialExecutables -DreamSkinProfileToken $DreamSkinProfileToken)
  }
  $launcherIds = @($launchers | ForEach-Object { [int]$_.ProcessId })
  # 启动器启动时间用作「AppModel 激活的 Codex 根进程是在本次启动之后才出现」的判定基准。
  $launcherCreatedAfter = [datetime]::MinValue
  foreach ($launcher in $launchers) {
    if ($null -ne $launcher.CreationDate -and ($launcher.CreationDate -gt $launcherCreatedAfter)) {
      $launcherCreatedAfter = [datetime]$launcher.CreationDate
    }
  }
  # 传入会话凭据：仅当复核确实命中当前进程快照时才交给选择函数，避免拿失效凭据去认领。
  $codeProcesses = @(Select-FusionCodeCodexOwnedProcesses -Snapshot $Snapshot -LauncherIds $launcherIds -OfficialExecutables $OfficialExecutables -DreamSkinProfileToken $DreamSkinProfileToken -LauncherCreatedAfter $launcherCreatedAfter -SessionClaim $(if ($sessionClaimedIds.Count -gt 0) { $sessionClaim } else { $null }))
  $mode = 'none'
  if ($dreamProcesses.Count -gt 0 -and ($launchers.Count -gt 0 -or $codeProcesses.Count -gt 0)) {
    $mode = 'both'
  } elseif ($dreamProcesses.Count -gt 0) {
    $mode = 'dream-skin'
  } elseif ($launchers.Count -gt 0 -or $codeProcesses.Count -gt 0) {
    $mode = 'code-codex'
  }
  # 其他 Codex 会话：官方可执行文件路径的根进程既不属于 Dream Skin 也不属于 Code-Codex。
  $foreign = @()
  foreach ($process in $Snapshot) {
    if ("$($process.Name)" -ine 'ChatGPT.exe') { continue }
    $path = "$($process.ExecutablePath)"
    if (-not $path) { continue }
    $full = [System.IO.Path]::GetFullPath($path)
    $pathMatches = $false
    foreach ($expected in $OfficialExecutables) {
      if ($expected -and $full.Equals([System.IO.Path]::GetFullPath($expected), [System.StringComparison]::OrdinalIgnoreCase)) { $pathMatches = $true; break }
    }
    if (-not $pathMatches) { continue }
    $commandLine = "$($process.CommandLine)"
    if ($DreamSkinProfileToken -and (Test-FusionCommandLineToken -CommandLine $commandLine -Token $DreamSkinProfileToken)) { continue }
    if ($commandLine -match '(?i)(?:^|\s)--type(?:=|\s+)') { continue }
    $claimedByCodeCodex = $false
    foreach ($owned in $codeProcesses) { if ([int]$owned.ProcessId -eq [int]$process.ProcessId) { $claimedByCodeCodex = $true; break } }
    if ($claimedByCodeCodex) { continue }
    $foreign += [pscustomobject]@{
      ProcessId      = [int]$process.ProcessId
      ExecutablePath = $full
      CommandLine    = $commandLine
    }
  }
  return [pscustomobject]@{
    Mode                 = $mode
    DreamSkinProcesses   = $dreamProcesses
    CodeCodexLaunchers   = $launchers
    CodeCodexProcesses   = $codeProcesses
    ForeignCodexProcesses = $foreign
    PrimaryExecutable    = $firstExecutable
    SessionClaimProcessIds = @($sessionClaimedIds)
    SessionPath            = "$SessionPath"
  }
}

# 功能：仅依据一次模式判定，决定「启动时是否要自动进入 Dream Skin」。
# 入参：Get-FusionMode 的结果对象。返回值：决策对象（Outcome/ShouldConnect/RestartExisting/Message）。
# 边界：这是纯决策函数，不做任何进程或磁盘操作，便于单元测试；
#       只有「完全没有模式在跑」才会连接，且连接时一律 RestartExisting=$false，
#       这样即便判定出错也只会失败，不会去关闭任何已打开的 Codex 窗口。
function Get-FusionEnsureDreamSkinDecision {
  param(
    [Parameter(Mandatory = $true)][object]$Mode
  )
  $name = "$($Mode.Mode)"
  if ($name -eq 'dream-skin') {
    return [pscustomobject]@{
      Outcome = 'already-active'; ShouldConnect = $false; RestartExisting = $false
      Message = 'Dream Skin 已在运行，未做任何改动。'
    }
  }
  if ($name -eq 'code-codex' -or $name -eq 'both') {
    return [pscustomobject]@{
      Outcome = 'blocked'; ShouldConnect = $false; RestartExisting = $false
      Message = 'Code-Codex 正在运行。自动进入 Dream Skin 需要先关闭它的进程，这一步必须由你确认，因此本次没有改动任何东西；请点击「切回 Dream Skin」。'
    }
  }
  # 注意：@($null).Count 是 1，必须先剔除空值，否则「没有该字段」会被误判成「存在其他会话」。
  $foreign = @(@($Mode.ForeignCodexProcesses) | Where-Object { $null -ne $_ -and "$_" -ne '' })
  if ($foreign.Count -gt 0) {
    return [pscustomobject]@{
      Outcome = 'blocked'; ShouldConnect = $false; RestartExisting = $false
      Message = '检测到其他 Codex 会话正在运行。Dream Skin 需要接管官方 Codex 会话，为避免影响该窗口，本次没有改动任何东西。'
    }
  }
  return [pscustomobject]@{
    Outcome = 'connect'; ShouldConnect = $true; RestartExisting = $false
    Message = '当前没有任何模式在运行，正在进入 Dream Skin 模式。'
  }
}

# 功能：结束指定进程号（先礼貌请求关闭窗口，再按需强制）。入参：进程号数组、快照、等待秒数、是否允许强制、日志路径。
# 返回值：结果对象；边界：每次强杀前都重新确认归属路径，路径不再匹配则跳过。
function Stop-FusionOwnedProcesses {
  param(
    [AllowEmptyCollection()][int[]]$ProcessIds = @(),
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Snapshot,
    [int]$GraceSeconds = 15,
    [switch]$AllowForce,
    [string]$LogPath
  )
  $expected = @{}
  foreach ($process in $Snapshot) {
    $expected[[int]$process.ProcessId] = "$($process.ExecutablePath)"
  }
  $targets = @($ProcessIds | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
  if ($targets.Count -eq 0) {
    return [pscustomobject]@{ Requested = 0; Stopped = 0; Forced = 0; Remaining = @() }
  }
  $requested = 0
  foreach ($id in $targets) {
    try {
      $handle = Get-Process -Id $id -ErrorAction Stop
      if ($handle.MainWindowHandle -ne 0) { [void]$handle.CloseMainWindow() }
      $requested++
    } catch {
      # 进程可能已经退出，视为无需处理
    }
  }
  $deadline = (Get-Date).AddSeconds($GraceSeconds)
  while ((Get-Date) -lt $deadline) {
    $alive = @($targets | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($alive.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  }
  $forced = 0
  $remaining = @()
  foreach ($id in $targets) {
    $current = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $current) { continue }
    if (-not $AllowForce) { $remaining += $id; continue }
    # 强杀前重新确认身份，防止进程号复用后误杀。
    $path = $null
    try { $path = $current.Path } catch { $path = $null }
    if ($path -and $expected.ContainsKey([int]$id) -and $expected[[int]$id] -and
      (([System.IO.Path]::GetFullPath($path)).Equals([System.IO.Path]::GetFullPath($expected[[int]$id]), [System.StringComparison]::OrdinalIgnoreCase))) {
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
      $forced++
    } else {
      Write-FusionSwitchLog -Message "跳过强制结束 PID $id：磁盘路径与快照不一致，可能已被复用。" -LogPath $LogPath
      $remaining += $id
    }
  }
  # 强杀后不能只等固定 300ms 就下结论：打包版 Chromium 根进程在被强杀后往往需要几百毫秒到几秒才能真正退出。
  # 这里按 GraceSeconds 的一半（上限 8 秒、下限 2 秒）轮询，只有在观察窗口内确实仍存活的进程才计入 Remaining。
  $exitGraceSeconds = [Math]::Min(8, [Math]::Max(2, [int]($GraceSeconds / 2)))
  $exitDeadline = (Get-Date).AddSeconds($exitGraceSeconds)
  do {
    $stillAlive = @($targets | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($stillAlive.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $exitDeadline)
  $stillAlive = @($targets | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  return [pscustomobject]@{
    Requested = $requested
    Stopped   = $targets.Count - $stillAlive.Count
    Forced    = $forced
    Remaining = $stillAlive
  }
}

# 功能：等待回环端口释放。入参：端口、超时秒数、探测函数。返回值：是否已释放；边界：环境缺 Get-NetTCPConnection 时抛错而不误判为已释放。
function Wait-FusionPortFree {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [int]$TimeoutSeconds = 30,
    [scriptblock]$Probe
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    # 同样不能用 `= if (...) { @(...) }`：单个监听项会被解包成标量，导致把「端口被占用」误判成空闲。
    $listeners = @()
    if ($Probe) {
      $listeners = @(& $Probe $Port)
    } else {
      $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    }
    if ($listeners.Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $false
}

# 功能：把 Code-Codex 控制台退出码翻译成可读原因。入参：退出码。返回值：说明文本；边界：未知码返回通用说明。
function Get-FusionCodeCodexExitHint {
  param([int]$ExitCode)
  switch ($ExitCode) {
    20 { return 'Code-Codex 报告官方 Codex 版本不受支持（UNSUPPORTED_VERSION）。' }
    21 { return 'Code-Codex 报告已有 Codex 在运行（ALREADY_RUNNING），它的所有权校验拒绝接管现有会话。' }
    22 { return 'Code-Codex 启动失败（STARTUP_FAILURE）。' }
    default { return "Code-Codex 退出码 $ExitCode。" }
  }
}

# 功能：启动 Code-Codex 并验证它真的起来了。入参：启动器路径、超时秒数、日志路径、可选进程快照提供函数。
# 返回值：结果对象（Started / Reason / LauncherExitCode / Detail）；边界：只启动用户给定的根启动器，不做任何绕过所有权校验的附加参数。
function Invoke-FusionCodeCodexLaunch {
  param(
    [Parameter(Mandatory = $true)][string]$LauncherPath,
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [int]$TimeoutSeconds = 60,
    [string]$LogPath,
    [scriptblock]$SnapshotProvider
  )
  if (-not (Test-Path -LiteralPath $LauncherPath -PathType Leaf)) {
    return [pscustomobject]@{ Started = $false; Reason = 'launcher-missing'; LauncherExitCode = $null; Detail = "找不到 Code-Codex 根启动器：$LauncherPath" }
  }
  $workingDirectory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($LauncherPath))
  $process = $null
  try {
    $process = Start-Process -FilePath $LauncherPath -WorkingDirectory $workingDirectory -PassThru -ErrorAction Stop
  } catch {
    return [pscustomobject]@{ Started = $false; Reason = 'launcher-start-failed'; LauncherExitCode = $null; Detail = $_.Exception.Message }
  }
  $launcherStartedAt = Get-Date
  Write-FusionSwitchLog -Message "已启动 Code-Codex 根启动器，PID=$($process.Id)" -LogPath $LogPath

  # 根 CodeCodex.exe 是一个无窗口的「转发器」：它校验 current-version 指向的版本化 GUI 启动器并立即以退出码 0 结束
  # （成功时不等 Codex 会话结束）。因此退出码 0 不能当成失败，真正的失败是非零退出码（例如 20/21/22），
  # 或在超时内始终没观察到「版本化启动器 + 官方 Codex」这个证据。
  $delegated = $false
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if ($process.HasExited) {
      $code = $process.ExitCode
      if ($code -ne 0) {
        return [pscustomobject]@{
          Started          = $false
          Reason           = 'launcher-exited'
          LauncherExitCode = $code
          Detail           = (Get-FusionCodeCodexExitHint -ExitCode $code)
        }
      }
      # 退出码 0：转发成功，继续等待版本化启动器接管并拉起 Codex。
      $delegated = $true
    }
    # 注意：PowerShell 里 `if` 表达式返回空数组时会退化成 $null，会让下游 [object[]] 参数绑定失败，
    # 所以这里显式先置空数组、再赋值，保证「没有进程」也能安全传递。
    $snapshot = @()
    if ($SnapshotProvider) { $snapshot = @(& $SnapshotProvider) } else { $snapshot = @(Get-FusionProcessSnapshot) }
    $launchers = @(Select-FusionCodeCodexLaunchers -Snapshot $snapshot -InstallRoot $InstallRoot)
    $launcherIds = @($launchers | ForEach-Object { [int]$_.ProcessId })
    # 打包版 Codex 经 AppModel 激活，不是启动器后代，因此这里不能要求「必须是启动器后代」；
    # 改用「启动器启动时间之后新出现的根进程 + Code-Codex 专属启动标记」这一证据。
    $launcherCreatedAfter = [datetime]::MinValue
    foreach ($launcher in $launchers) {
      if ($null -ne $launcher.CreationDate -and ($launcher.CreationDate -gt $launcherCreatedAfter)) {
        $launcherCreatedAfter = [datetime]$launcher.CreationDate
      }
    }
    $official = @()
    try {
      $installs = @(Get-DreamSkinRegisteredCodexInstalls)
      foreach ($install in $installs) { $official += "$($install.Executable)" }
    } catch {
      $official = @()
    }
    $owned = @(Select-FusionCodeCodexOwnedProcesses -Snapshot $snapshot -LauncherIds $launcherIds -OfficialExecutables $official -LauncherCreatedAfter $launcherCreatedAfter)
    if ($owned.Count -gt 0) {
      return [pscustomobject]@{
        Started          = $true
        Reason           = 'codex-process-observed'
        LauncherExitCode = $null
        Detail           = "Code-Codex 已接管一个官方 Codex 进程：PID=$($owned[0].ProcessId)（归属：$($owned[0].Ownership)）"
        # 必须在这里就把归属证据带出去：启动器随时会退出，退出后就再也无法从进程表推出「这个 Codex 是谁拉起的」。
        OwnedProcessIds  = @($owned | ForEach-Object { [int]$_.ProcessId })
        OwnedExecutables = @($owned | ForEach-Object { "$($_.ExecutablePath)" })
        LauncherStartedAt = $launcherStartedAt
      }
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  if ($delegated) {
    return [pscustomobject]@{
      Started          = $false
      Reason           = 'verification-timeout'
      LauncherExitCode = $null
      Detail           = "Code-Codex 根启动器已转发到版本化启动器，但等待 $TimeoutSeconds 秒仍未观察到它接管的官方 Codex 进程。"
    }
  }
  return [pscustomobject]@{
    Started          = $false
    Reason           = 'verification-timeout'
    LauncherExitCode = $null
    Detail           = "等待 $TimeoutSeconds 秒仍未观察到 Code-Codex 接管的 Codex 进程。"
  }
}

# 功能：请求 Dream Skin 建立连接，但不打开浏览器面板（复用其连接脚本 start-dream-skin.ps1）。
# 入参：连接脚本路径、端口、是否强制重启已开着的 Codex、日志路径。
# 返回值：结果对象；边界：脚本缺失时返回失败而不是静默跳过；-RestartExisting 只作用于 Dream Skin 自己管理的官方 Codex。
function Invoke-FusionDreamSkinConnection {
  param(
    [Parameter(Mandatory = $true)][string]$ConnectScript,
    [int]$Port = 9335,
    [switch]$RestartExisting,
    [string]$LogPath
  )
  if (-not (Test-Path -LiteralPath $ConnectScript -PathType Leaf)) {
    return [pscustomobject]@{ Requested = $false; Reason = 'connect-script-missing'; Detail = "Dream Skin 连接脚本缺失：$ConnectScript" }
  }
  $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'RemoteSigned', '-File', $ConnectScript, '-Port', "$Port")
  if ($RestartExisting) { $arguments += '-RestartExisting' }
  try {
    $process = Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden -PassThru -ErrorAction Stop
    Write-FusionSwitchLog -Message "已请求 Dream Skin 建立连接（不打开浏览器面板），PID=$($process.Id)" -LogPath $LogPath
    return [pscustomobject]@{ Requested = $true; Reason = 'requested'; Detail = "已请求 Dream Skin 建立连接（PID=$($process.Id)，未打开浏览器面板）" }
  } catch {
    return [pscustomobject]@{ Requested = $false; Reason = 'connect-start-failed'; Detail = $_.Exception.Message }
  }
}

# 功能：请求 Dream Skin 恢复（复用其手动入口 start-codex-and-panel.ps1）。入参：面板脚本路径、日志路径、是否等待。
# 返回值：结果对象；边界：脚本缺失时返回失败而不是静默跳过。
function Invoke-FusionDreamSkinRestore {
  param(
    [Parameter(Mandatory = $true)][string]$PanelScript,
    [string]$LogPath
  )
  if (-not (Test-Path -LiteralPath $PanelScript -PathType Leaf)) {
    return [pscustomobject]@{ Requested = $false; Reason = 'panel-script-missing'; Detail = "Dream Skin 手动入口缺失：$PanelScript" }
  }
  $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  try {
    $process = Start-Process -FilePath $powershell -ArgumentList @(
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'RemoteSigned', '-File', $PanelScript
    ) -WindowStyle Hidden -PassThru -ErrorAction Stop
    Write-FusionSwitchLog -Message "已请求 Dream Skin 恢复，PID=$($process.Id)" -LogPath $LogPath
    return [pscustomobject]@{ Requested = $true; Reason = 'requested'; Detail = "已请求 Dream Skin 手动入口恢复（PID=$($process.Id)）" }
  } catch {
    return [pscustomobject]@{ Requested = $false; Reason = 'panel-start-failed'; Detail = $_.Exception.Message }
  }
}

# 功能：探测回环端口上的 CDP 端点，并确认端点确实属于本机回环地址。
# 入参：端口、可选身份函数。返回值：身份对象或 $null；边界：只在 127.0.0.1/::1 上确认，避免把其他地址的端点误认为 Codex。
function Get-FusionLoopbackCdpIdentity {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [scriptblock]$IdentityProvider
  )
  try {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)
    if ($listeners.Count -eq 0) { return $null }
    foreach ($listener in $listeners) {
      if ("$($listener.LocalAddress)" -notin @('127.0.0.1', '::1')) { return $null }
    }
  } catch {
    return $null
  }
  if ($IdentityProvider) { return (& $IdentityProvider $Port) }
  return (Get-DreamSkinVerifiedCdpIdentityForAnyRegistered -Port $Port)
}

# 功能：等待并确认回环端口上出现「通过 Dream Skin 自己所有权校验」的 Codex CDP 端点。
# 入参：端口、超时秒数、期望的浏览器标识、可选探测函数。
# 返回值：结果对象（CdpVerified / CdpBrowserId / Detail）；边界：端口空闲或归属校验不通过时返回未通过而不是抛错。
function Test-FusionDreamSkinCdp {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [int]$TimeoutSeconds = 60,
    [string]$ExpectedBrowserId,
    [scriptblock]$CdpProbe
  )
  $deadline = (Get-Date).AddSeconds([Math]::Max($TimeoutSeconds, 1))
  $identity = $null
  do {
    $identity = if ($CdpProbe) { & $CdpProbe $Port } else { Get-FusionLoopbackCdpIdentity -Port $Port }
    if ($null -ne $identity) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  if ($null -eq $identity) {
    return [pscustomobject]@{
      CdpVerified  = $false
      CdpBrowserId = $null
      Detail       = "回环端口 $Port 上没有出现通过所有权校验的 Codex CDP 端点。"
    }
  }
  $browserId = "$($identity.Identity.BrowserId)"
  # 浏览器标识说明端点属于哪一个 Codex 会话；与保存值不一致意味着接管的是别的会话。
  if ($ExpectedBrowserId -and $ExpectedBrowserId -cne $browserId) {
    return [pscustomobject]@{
      CdpVerified  = $false
      CdpBrowserId = $browserId
      Detail       = '端口上的 CDP 端点属于另一个 Codex 会话，与记录中的 Dream Skin 会话不一致。'
    }
  }
  return [pscustomobject]@{
    CdpVerified  = $true
    CdpBrowserId = $browserId
    Detail       = "CDP 端点已通过 Dream Skin 自己的所有权校验（BrowserId=$browserId）。"
  }
}

# 功能：调用 Dream Skin 自带的验证入口 verify-dream-skin.ps1（它内部就是 injector.mjs --verify），
#       用它自己的判定确认壁纸与动态效果确实已生效。入参：验证脚本路径、端口、超时秒数、尝试次数、日志路径。
# 返回值：结果对象（Passed / ExitCode / Attempts / Detail）；边界：脚本缺失或超时按未通过处理，不伪造成功。
# 功能：等 Dream Skin 会话真正回来后再恢复窗口，并反复恢复直到窗口不再最小化。
# 为什么必须这样：上一腿会把 Dream Skin 的 state.json 归档，回程刚开始时档案标记与官方可执行文件
# 路径都拿不到，此时唯一一次恢复调用会直接跳过，窗口停在最小化状态，
# 于是 verify-dream-skin.ps1 的 documentPass 必然失败（document.hidden=true）。
# 入参：Dream Skin 档案标记、官方可执行文件集合、会话状态文件路径、最长等待秒数、日志路径。
# 返回值：恢复结果对象；边界：拿不到归属证据时只等待并如实记录，绝不按名字去动别的窗口。
function Wait-FusionDreamSkinWindowRestored {
  param(
    [string]$DreamSkinProfileToken,
    [AllowEmptyCollection()][string[]]$OfficialExecutables = @(),
    [string]$StatePath,
    [int]$MaxWaitSeconds = 150,
    [string]$LogPath
  )
  $deadline = (Get-Date).AddSeconds([Math]::Max($MaxWaitSeconds, 5))
  $restore = $null
  $attempts = 0
  $token = $DreamSkinProfileToken
  $executables = @($OfficialExecutables)
  $liveWindowSeen = $false
  while ($true) {
    $attempts++
    # Dream Skin 自己的状态文件在上一腿结束时会被归档；等它重新出现，才能拿到档案标记与官方可执行文件路径。
    if ((-not $token) -or $executables.Count -eq 0) {
      $state = $null
      if ($StatePath -and (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
        try { $state = [System.IO.File]::ReadAllText($StatePath) | ConvertFrom-Json } catch { $state = $null }
      }
      if ($state) {
        if (-not $token) { $token = Get-FusionProfileToken -ProfilePath "$($state.profilePath)" }
        if ($executables.Count -eq 0 -and "$($state.codexExe)") { $executables = @("$($state.codexExe)") }
      }
    }
    $restore = Restore-FusionDreamSkinWindow -DreamSkinProfileToken $token -OfficialExecutables $executables -LogPath $LogPath
    if ($restore.Restored -gt 0) { break }
    # 窗口本来就已经在屏幕内可见时，恢复函数不会有任何动作（Restored=0）。
    # 若只等 Restored>0，就会一直空等到超时，最后把「本来就正常」误报成「恢复失败」。
    if ($restore.Satisfied) { break }
    # 只有确实存在「属于 Dream Skin 的 Codex 根窗口」时才值得继续等。
    if ($token) {
      foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue)) {
        $commandLine = "$($process.CommandLine)"
        if ($commandLine -match '(?i)(?:^|\s)--type(?:=|\s+)') { continue }
        if (-not (Test-FusionCommandLineToken -CommandLine $commandLine -Token $token)) { continue }
        if ($executables.Count -gt 0 -and "$($process.ExecutablePath)" -notin $executables) { continue }
        $liveWindowSeen = $true
        break
      }
    }
    if ((Get-Date) -ge $deadline) { break }
    Start-Sleep -Seconds 5
  }
  $restoredCount = 0
  if ($restore) { $restoredCount = [int]$restore.Restored }
  $satisfied = [bool]($restore -and $restore.Satisfied)
  $detail = if ($restoredCount -gt 0) {
    "已恢复 Dream Skin Codex 窗口（第 $attempts 次尝试）：$($restore.Detail)"
  } elseif ($satisfied) {
    "Dream Skin Codex 窗口已在屏幕内可见，无需恢复（第 $attempts 次尝试）：$($restore.Detail)"
  } elseif ($restore) {
    "未能恢复 Dream Skin Codex 窗口（尝试 $attempts 次，liveWindow=$liveWindowSeen）：$($restore.Detail)"
  } else {
    "窗口恢复未执行（尝试 $attempts 次，liveWindow=$liveWindowSeen）。"
  }
  Write-FusionSwitchLog -Message $detail -LogPath $LogPath
  return [pscustomobject]@{
    Requested = $true
    Reason    = $(if ($restoredCount -gt 0) { 'restored' } elseif ($satisfied) { 'already-visible' } else { 'not-restored' })
    Restored  = $restoredCount
    Satisfied = $satisfied
    Attempts  = $attempts
    Detail    = $detail
  }
}
function Restore-FusionDreamSkinWindow {
  param(
    [string]$DreamSkinProfileToken,
    [AllowEmptyCollection()][string[]]$OfficialExecutables = @(),
    [string]$LogPath
  )
  # 恢复本身是幂等的：窗口已经可见时再调一次没有任何副作用，因此可以反复调用。
  if (-not ([System.Management.Automation.PSTypeName]'FusionSwitch.NativeWindowRestore').Type) {
    try {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace FusionSwitch {
  public static class NativeWindowRestore {
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttachTo, uint idAttach, bool fAttach);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")] public static extern uint GetWindowProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", EntryPoint = "MonitorFromWindow")] public static extern IntPtr FindMonitor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll", EntryPoint = "SetWindowPos")] public static extern bool PlaceWindow(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")] public static extern bool GetWorkArea(uint action, uint param, out RECT value, uint winIni);
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    // .NET 的 Process.MainWindowHandle 只对「当前有主窗口」的进程返回值，窗口一旦隐藏就是 0，
    // 因此必须自己枚举该进程的顶层窗口，按面积挑出真正的应用主窗口（排除托盘等工具窗口）。
    public static IntPtr FindMainWindow(uint wantedPid) {
      IntPtr best = IntPtr.Zero;
      long bestArea = 0;
      EnumWindows((handle, state) => {
        uint pid;
        GetWindowProcessId(handle, out pid);
        if (pid != wantedPid) return true;
        int exStyle = GetWindowLong(handle, -20);
        bool toolWindow = (exStyle & 0x00000080) != 0 && (exStyle & 0x00040000) == 0;
        if (toolWindow) return true;
        RECT rect;
        if (!GetWindowRect(handle, out rect)) return true;
        long area = (long)(rect.Right - rect.Left) * (long)(rect.Bottom - rect.Top);
        if (area > bestArea) { bestArea = area; best = handle; }
        return true;
      }, IntPtr.Zero);
      return best;
    }
    [DllImport("user32.dll", EntryPoint = "GetSystemMetrics")] private static extern int Metric(int index);
    // 26.908 在会话交接后会把主窗口挪到屏外（坐标为 -32000），此时 IsWindowVisible 依然为真、
    // IsIconic 为假，所以只查这两个标志会把它当成「已显示」而整段跳过；但渲染进程按 Chromium 的
    // 规则认定自己被移出屏幕，document.hidden 变成 true，verify 的 documentPass 必然失败。
    // 因此必须先判断窗口是否真的留在屏幕内，再把屏外的窗口移回工作区。
    public static bool IsOnScreen(IntPtr hWnd) {
      RECT rect;
      if (!GetWindowRect(hWnd, out rect)) return false;
      int vx = Metric(76), vy = Metric(77), vw = Metric(78), vh = Metric(79);
      if (vw <= 0 || vh <= 0) return true;
      int left = Math.Max(rect.Left, vx);
      int top = Math.Max(rect.Top, vy);
      int right = Math.Min(rect.Right, vx + vw);
      int bottom = Math.Min(rect.Bottom, vy + vh);
      return (right - left) >= 160 && (bottom - top) >= 120;
    }
    public static bool MoveOnScreen(IntPtr hWnd) {
      RECT rect;
      if (!GetWindowRect(hWnd, out rect)) return false;
      RECT work;
      if (FindMonitor(hWnd, 2) == IntPtr.Zero || !GetWorkArea(0x0030, 0, out work, 0)) {
        int vx = Metric(76), vy = Metric(77);
        work.Left = vx; work.Top = vy; work.Right = vx + Metric(78); work.Bottom = vy + Metric(79);
      }
      int width = rect.Right - rect.Left;
      int height = rect.Bottom - rect.Top;
      if (width <= 0 || height <= 0) { width = 1280; height = 800; }
      int maxWidth = work.Right - work.Left;
      int maxHeight = work.Bottom - work.Top;
      if (maxWidth <= 0 || maxHeight <= 0) { return false; }
      if (width > maxWidth) { width = maxWidth; }
      if (height > maxHeight) { height = maxHeight; }
      int x = work.Left + Math.Max(0, (maxWidth - width) / 2);
      int y = work.Top + Math.Max(0, (maxHeight - height) / 2);
      return PlaceWindow(hWnd, IntPtr.Zero, x, y, width, height, 0x0004 | 0x0010 | 0x0040);
    }
  }
}
'@ -ErrorAction Stop
    } catch {
      Write-FusionSwitchLog -Message "加载窗口恢复 API 失败：$($_.Exception.Message)" -LogPath $LogPath
      return [pscustomobject]@{ Restored = 0; Detail = "无法加载窗口恢复 API：$($_.Exception.Message)" }
    }
  }
  $restore = 9
  # 仅用于探测「窗口是否可见」的只读谓词，不会改变窗口状态。
  $poll = 5
  $restored = 0
  $alreadyVisible = 0
  $seen = 0
  $candidates = @()
  foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue)) {
    $commandLine = "$($process.CommandLine)"
    if ($commandLine -match '--type=') { continue }
    $executable = "$($process.ExecutablePath)"
    if ($OfficialExecutables.Count -gt 0 -and $executable -notin $OfficialExecutables) { continue }
    if ($DreamSkinProfileToken -and -not (Test-FusionCommandLineToken -CommandLine $commandLine -Token $DreamSkinProfileToken)) { continue }
    $candidates += $process
  }
  # 只把 Dream Skin 自己的窗口算作候选：必须同时匹配官方可执行文件与 Dream Skin 档案标记。
  if ($OfficialExecutables.Count -eq 0 -or -not $DreamSkinProfileToken) {
    Write-FusionSwitchLog -Message '缺少官方可执行文件集合或 Dream Skin 档案标记，为避免误动其他窗口，跳过窗口恢复。' -LogPath $LogPath
    return [pscustomobject]@{ Restored = 0; AlreadyVisible = 0; Satisfied = $false; Detail = '无法证明窗口归属（缺少可执行文件集合或档案标记），跳过窗口恢复。' }
  }
  foreach ($process in $candidates) {
    $live = Get-Process -Id ([int]$process.ProcessId) -ErrorAction SilentlyContinue
    if (-not $live) { continue }
    # 不能用 Process.MainWindowHandle：窗口隐藏时它恒为 0，会让「隐藏但未最小化」的窗口被整段跳过。
    $handle = [FusionSwitch.NativeWindowRestore]::FindMainWindow([uint32]$process.ProcessId)
    if ($handle -eq [IntPtr]::Zero) { continue }
    try {
      $iconic = [FusionSwitch.NativeWindowRestore]::IsIconic($handle)
      $visible = [FusionSwitch.NativeWindowRestore]::IsWindowVisible($handle)
      $onScreen = [FusionSwitch.NativeWindowRestore]::IsOnScreen($handle)
      $seen++
      if ($visible -and -not $iconic -and $onScreen) { $alreadyVisible++; continue }
      # Codex 26.908 在会话交接后会把主窗口留在「屏外」：坐标恒为 -32000，功能上等于隐藏，
      # 但 IsWindowVisible 仍为真、IsIconic 为假。实测（窗口矩形 -32000 -> documentVisibility=hidden，
      # 移回屏内 -> documentVisibility=visible）证明渲染进程正是按 Chromium 的规则把它判成不可见，
      # 于是 verify 的 documentPass 失败。因此「屏外」必须和最小化、隐藏一样触发恢复。
      if ($iconic -or (-not $visible) -or (-not $onScreen)) {
        # 单纯 ShowWindow(SW_RESTORE) 会被系统立刻再次最小化（非前台进程没有恢复资格），
        # 必须临时附加到前台线程再置前，恢复结果才会稳定保持。
        $foregroundHandle = [FusionSwitch.NativeWindowRestore]::GetForegroundWindow()
        $foregroundThread = [FusionSwitch.NativeWindowRestore]::GetWindowThreadProcessId($foregroundHandle, [IntPtr]::Zero)
        $currentThread = [FusionSwitch.NativeWindowRestore]::GetCurrentThreadId()
        $attached = $false
        if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
          $attached = [FusionSwitch.NativeWindowRestore]::AttachThreadInput($currentThread, $foregroundThread, $true)
        }
        try {
          # SW_SHOW 先把「隐藏」的窗口显示出来，SW_RESTORE 再处理最小化，顺序不能颠倒。
          [void][FusionSwitch.NativeWindowRestore]::ShowWindow($handle, $poll)
          [void][FusionSwitch.NativeWindowRestore]::ShowWindow($handle, $restore)
          # 仅 ShowWindow 修不了「窗口在屏外」：坐标仍是 -32000，渲染进程照样认定不可见，
          # 必须显式把它移回监视器工作区（恢复尺寸与位置），documentPass 才会变回 true。
          [void][FusionSwitch.NativeWindowRestore]::MoveOnScreen($handle)
          [void][FusionSwitch.NativeWindowRestore]::BringWindowToTop($handle)
          [void][FusionSwitch.NativeWindowRestore]::SetForegroundWindow($handle)
        } finally {
          if ($attached) { [void][FusionSwitch.NativeWindowRestore]::AttachThreadInput($currentThread, $foregroundThread, $false) }
        }
        # 窗口状态切换是异步的，这里等到「非最小化、可见且确实留在屏内」再判定，
        # 避免把尚未生效的恢复当失败（屏外窗口在 Win32 层面也算「可见」）。
        $settled = $false
        for ($wait = 0; $wait -lt 12; $wait++) {
          Start-Sleep -Milliseconds 250
          if ((-not [FusionSwitch.NativeWindowRestore]::IsIconic($handle)) -and
              [FusionSwitch.NativeWindowRestore]::IsWindowVisible($handle) -and
              [FusionSwitch.NativeWindowRestore]::IsOnScreen($handle)) { $settled = $true; break }
        }
        if ($settled) { $restored++ }
      }
    } catch {
      Write-FusionSwitchLog -Message "恢复窗口 PID=$($process.ProcessId) 失败：$($_.Exception.Message)" -LogPath $LogPath
    }
  }
  $detail = if ($restored -gt 0) {
    "已把 $restored 个 Dream Skin Codex 窗口从最小化/屏外状态恢复到屏幕内，以便验证真实渲染状态。"
  } elseif ($alreadyVisible -gt 0) {
    'Dream Skin Codex 窗口已在屏幕内可见，无需恢复。'
  } else {
    '未发现需要恢复的 Dream Skin Codex 窗口（可能本来就已显示）。'
  }
  Write-FusionSwitchLog -Message $detail -LogPath $LogPath
  return [pscustomobject]@{ Restored = $restored; AlreadyVisible = $alreadyVisible; Satisfied = ($seen -gt 0); Detail = $detail }
}
function Invoke-FusionDreamSkinVerify {
  param(
    [Parameter(Mandatory = $true)][string]$VerifyScript,
    [int]$Port = 9335,
    [int]$TimeoutSeconds = 180,
    [int]$Attempts = 3,
    # 传入选窗口归属证据后，每次重试之前都会重新恢复 Dream Skin 窗口。
    # 否则三连尝试若都发生在窗口最小化期间，documentPass 会连续失败（假阴性）。
    [string]$DreamSkinProfileToken,
    [AllowEmptyCollection()][string[]]$OfficialExecutables = @(),
    [string]$StatePath,
    [int]$WindowRestoreTimeoutSeconds = 150,
    [string]$LogPath
  )
  if (-not (Test-Path -LiteralPath $VerifyScript -PathType Leaf)) {
    return [pscustomobject]@{ Passed = $false; ExitCode = $null; Attempts = 0; Detail = "Dream Skin 验证脚本缺失：$VerifyScript" }
  }
  $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $tempRoot = [System.IO.Path]::GetTempPath()
  $lastCode = $null
  $lastDetail = '未执行验证。'
  $tries = [Math]::Max($Attempts, 1)
  $windowRestores = @()
  for ($attempt = 1; $attempt -le $tries; $attempt++) {
    if ($DreamSkinProfileToken -or $StatePath) {
      # 每次验证之前都恢复一次窗口：Dream Skin 会话刚回来时窗口是「最小化」的，
      # 而 verify 把 documentPass 当硬条件，窗口最小化必然判成「壁纸未生效」。
      $windowRestores += Wait-FusionDreamSkinWindowRestored -DreamSkinProfileToken $DreamSkinProfileToken `
        -OfficialExecutables $OfficialExecutables -StatePath $StatePath `
        -MaxWaitSeconds $WindowRestoreTimeoutSeconds -LogPath $LogPath
    }
    $outFile = Join-Path $tempRoot ('dreamskin-verify-out-' + [guid]::NewGuid().ToString('N') + '.log')
    $errFile = Join-Path $tempRoot ('dreamskin-verify-err-' + [guid]::NewGuid().ToString('N') + '.log')
    try {
      $process = Start-Process -FilePath $powershell -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', $VerifyScript, '-Port', "$Port"
      ) -WindowStyle Hidden -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru -ErrorAction Stop
      $finished = $process.WaitForExit($TimeoutSeconds * 1000)
      if (-not $finished) {
        try { $process.Kill() } catch { Write-FusionSwitchLog -Message "结束超时的验证进程失败：$($_.Exception.Message)" -LogPath $LogPath }
        $lastCode = $null
        $lastDetail = "Dream Skin 验证在 $TimeoutSeconds 秒内未结束。"
      }
      else {
        $lastCode = $process.ExitCode
        if ($null -eq $lastCode) {
          # Start-Process 有时读不到子进程退出码；此时不能凭 stdout 猜测结果，
          # 而判定 Dream Skin 是否生效的真正权威是它自己脚本的退出码，因此重跑一次同步调用。
          $syncOut = Join-Path $tempRoot ('dreamskin-verify-sync-' + [guid]::NewGuid().ToString('N') + '.log')
          $syncErr = Join-Path $tempRoot ('dreamskin-verify-sync-' + [guid]::NewGuid().ToString('N') + '.log')
          try {
            & $powershell -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File $VerifyScript -Port "$Port" 1> $syncOut 2> $syncErr
            $lastCode = $LASTEXITCODE
          } catch {
            $lastCode = $null
          }
          if ($null -ne $lastCode) {
            foreach ($file in @($outFile, $errFile)) {
              $source = if (Test-Path -LiteralPath $syncOut -PathType Leaf) { $syncOut } else { $syncErr }
              if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination $file -Force -ErrorAction SilentlyContinue }
            }
          }
          foreach ($file in @($syncOut, $syncErr)) {
            if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
          }
          Write-FusionSwitchLog -Message "Dream Skin 验证进程退出码无法直接读取，已改用同步调用复核，得到退出码 $lastCode。" -LogPath $LogPath
        }
        if ($lastCode -eq 0) {
          return [pscustomobject]@{ Passed = $true; ExitCode = 0; Attempts = $attempt; Detail = 'Dream Skin 自带的 verify-dream-skin.ps1 判定壁纸与动态效果均已生效。'; WindowRestores = @($windowRestores) }
        }
        $lastDetail = Get-FusionDreamSkinVerifySummary -StdOutPath $outFile -StdErrPath $errFile -ExitCode $lastCode
      }
    }
    catch {
      $lastCode = $null
      $lastDetail = "调用 Dream Skin 验证失败：$($_.Exception.Message)"
    }
    finally {
      foreach ($file in @($outFile, $errFile)) {
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
      }
    }
    Write-FusionSwitchLog -Message "第 $attempt 次 Dream Skin 验证未通过（退出码 $lastCode）：$lastDetail" -LogPath $LogPath
    if ($attempt -lt $tries) { Start-Sleep -Seconds 10 }
  }
  return [pscustomobject]@{ Passed = $false; ExitCode = $lastCode; Attempts = $tries; Detail = $lastDetail; WindowRestores = @($windowRestores) }
}

# 功能：读取日志文件末尾若干行，用于把子进程失败原因带进结果。入参：候选文件路径数组。返回值：最后一条非空行的合并文本。
function Get-FusionDreamSkinVerifySummary {
  param(
    [string]$StdOutPath,
    [string]$StdErrPath,
    [int]$ExitCode
  )
  foreach ($path in @($StdOutPath, $StdErrPath)) {
    if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    $raw = $null
    try { $raw = Get-Content -LiteralPath $path -Raw -ErrorAction Stop } catch { continue }
    if (-not $raw -or -not $raw.Trim()) { continue }
    $json = $null
    $trimmed = $raw.Trim()
    try { $json = $trimmed | ConvertFrom-Json -ErrorAction Stop } catch { $json = $null }
    if ($null -eq $json) {
      $start = $trimmed.IndexOf('{')
      $end = $trimmed.LastIndexOf('}')
      if ($start -ge 0 -and $end -gt $start) {
        try { $json = $trimmed.Substring($start, $end - $start + 1) | ConvertFrom-Json -ErrorAction Stop } catch { $json = $null }
      }
    }
    if ($null -eq $json) { continue }
    $target = @($json.targets) | Select-Object -First 1
    if ($null -eq $target) { continue }
    $result = $target.result
    $readiness = $result.readiness
    $failed = @()
    foreach ($flag in @('windowPass', 'documentPass', 'viewportPass', 'structurePass')) {
      if ($readiness -and -not [bool]$readiness.$flag) { $failed += $flag }
    }
    $parts = @()
    $parts += "退出码 $ExitCode"
    $parts += "主题 $($result.themeId)@$($result.revision)（期望 $($result.expectedThemeId)@$($result.expectedRevision)）"
    $parts += "样式已注入=$($result.stylePresent)"
    if ($failed.Count -gt 0) { $parts += "未通过项：" + ($failed -join '、') }
    if ($result.documentHidden) { $parts += '窗口当前处于最小化/隐藏状态（document.hidden=true）' }
    if ($result.nativeWindow -and $result.nativeWindow.reason) { $parts += "nativeWindow=$($result.nativeWindow.reason)" }
    return ('Dream Skin 壁纸校验未通过：' + ($parts -join '；') + '。')
  }
  return (Get-FusionLogTail -Paths @(@($StdErrPath, $StdOutPath) | Where-Object { $_ }))
}

# 功能：读取日志文件末尾若干行，用于把子进程失败原因带进结果。入参：候选文件路径数组。返回值：最后一条非空行的合并文本。
function Get-FusionLogTail {
  param([AllowEmptyCollection()][string[]]$Paths = @())
  foreach ($path in $Paths) {
    if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    try {
      $lines = @(Get-Content -LiteralPath $path -ErrorAction Stop | Where-Object { "$_".Trim() })
      if ($lines.Count -gt 0) { return (($lines | Select-Object -Last 3) -join ' ').Trim() }
    } catch {
      continue
    }
  }
  return '（无输出）'
}

# 功能：向用户确认模式切换。入参：消息、标题、是否假定同意、可选提示函数（测试注入）。
# 返回值：用户是否确认；边界：无人值守或无法弹窗时按未确认处理（安全默认，绝不擅自切换）。
function Confirm-FusionModeSwitch {
  param(
    [Parameter(Mandatory = $true)][string]$Message,
    [string]$Title = 'Codex Fusion',
    [switch]$AssumeYes,
    [scriptblock]$Prompt
  )
  if ($AssumeYes) { return $true }
  if ($Prompt) { return [bool](& $Prompt $Message $Title) }
  try {
    $shell = New-Object -ComObject WScript.Shell
    return $shell.Popup($Message, 0, $Title, 52) -eq 6
  } catch {
    Write-Warning '无法显示确认对话框，按用户未确认处理。'
    return $false
  }
}

# 功能：写出结构化切换结果，供宿主与测试读取。入参：结果路径、结果对象。返回值：写入的路径；边界：目录缺失时自动创建。
function Write-FusionSwitchResult {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Result
  )
  $full = [System.IO.Path]::GetFullPath($Path)
  $directory = [System.IO.Path]::GetDirectoryName($full)
  if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    [void][System.IO.Directory]::CreateDirectory($directory)
  }
  $json = $Result | ConvertTo-Json -Depth 6
  # 明确写成 UTF-8 with BOM：Windows PowerShell 5.1 的 Get-Content 在没有 BOM 时按 ANSI 解码，
  # 会把结果里的中文说明读成乱码。
  [System.IO.File]::WriteAllText($full, $json + "`r`n", (New-Object System.Text.UTF8Encoding($true)))
  return $full
}

# 功能：构造统一的切换结果对象。入参：动作、模式、结果、退出码、说明、明细。返回值：结果对象。
function New-FusionSwitchOutcome {
  param(
    [Parameter(Mandatory = $true)][string]$Action,
    [Parameter(Mandatory = $true)][string]$Mode,
    [Parameter(Mandatory = $true)][string]$Outcome,
    [Parameter(Mandatory = $true)][int]$ExitCode,
    [string]$Message = '',
    [object]$Detail = $null
  )
  return [pscustomobject]@{
    schemaVersion = 1
    action        = $Action
    mode          = $Mode
    outcome       = $Outcome
    exitCode      = $ExitCode
    message       = $Message
    detail        = $Detail
    timestamp     = (Get-Date).ToUniversalTime().ToString('o')
  }
}

# 进行中标记的 outcome 字面量。宿主要把它当成「尚无结论」，绝不能当成成功。
$script:FusionSwitchRunningOutcome = 'running'

# 功能：判断某个 outcome 是否属于「脚本已经给出的权威结论」。入参：outcome 字符串。返回值：是否权威；
# 边界：running 是中途标记而非结论；空值同样不算结论。
function Test-FusionSwitchOutcomeTerminal {
  param([string]$Outcome)
  if (-not $Outcome) { return $false }
  return ($Outcome -ne $script:FusionSwitchRunningOutcome)
}

# 功能：在真正动手之前先落一条「切换进行中」标记。入参：动作、结果路径、日志路径。返回值：无。
# 为什么必须先落标记：切换脚本可能因为任何原因中止（抛错、被结束、宿主被关闭）。
# 先留下中途标记，界面与宿主才能区分「从未开始」和「开始了但没走完」，
# 不会把一次被中断的切换显示成「什么都没发生」。
function Write-FusionSwitchRunningMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Action,
    [Parameter(Mandatory = $true)][string]$ResultPath,
    [string]$LogPath
  )
  $marker = New-FusionSwitchOutcome -Action $Action -Mode 'unknown' -Outcome $script:FusionSwitchRunningOutcome `
    -ExitCode 0 -Message '切换正在进行，尚未得出结果。'
  try {
    [void](Write-FusionSwitchResult -Path $ResultPath -Result $marker)
  } catch {
    Write-Warning "切换进行中标记写入失败：$($_.Exception.Message)"
  }
  Write-FusionSwitchLog -Message '已写入切换进行中标记。' -LogPath $LogPath
}


