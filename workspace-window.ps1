[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Workspace,
  [Parameter(Mandatory = $true)][string]$FusionRoot,
  [string]$BridgePath,
  [bool]$SafeMode = $true
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms, Microsoft.VisualBasic
$script:BridgeProcess = $null
$script:EditorVersion = $null

function Get-FusionRelativePath {
  <# 功能：计算工作区内路径的相对路径。入参：根目录和目标绝对路径。返回值：相对路径；目标越界时抛出异常。 #>
  param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$Target)
  $rootUri = New-Object Uri(([IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'))
  $targetUri = New-Object Uri([IO.Path]::GetFullPath($Target))
  if (-not $rootUri.IsBaseOf($targetUri)) { throw '目标路径不在工作区内' }
  return [Uri]::UnescapeDataString($rootUri.MakeRelativeUri($targetUri).ToString()).Replace('/', '\')
}

function Start-FusionBridge {
  <# 功能：启动 Rust 工作区桥接进程。入参：桥接程序路径和工作区根目录。返回值：已重定向标准输入输出的 Process；路径缺失或进程启动失败时抛出异常。 #>
  param([Parameter(Mandatory = $true)][string]$Executable, [Parameter(Mandatory = $true)][string]$Root)
  if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "桥接程序不存在：$Executable" }
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $process.StartInfo.FileName = $Executable
  $process.StartInfo.Arguments = '"' + $Root.Replace('"', '""') + '"'
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.RedirectStandardInput = $true
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  if (-not $process.Start()) { throw '桥接进程启动失败' }
  return $process
}

function Invoke-FusionBridge {
  <# 功能：向 Rust 工作区桥接发送一条 JSONL 请求。入参：方法名和参数对象。返回值：响应对象；进程退出或返回无效 JSON 时抛出异常。 #>
  param([Parameter(Mandatory = $true)][string]$Method, [hashtable]$Params = @{})
  if ($null -eq $script:BridgeProcess -or $script:BridgeProcess.HasExited) { throw '工作区桥接进程未运行' }
  $request = @{ id = [Guid]::NewGuid().ToString('N'); method = $Method; params = $Params } | ConvertTo-Json -Compress
  $script:BridgeProcess.StandardInput.WriteLine($request)
  $line = $script:BridgeProcess.StandardOutput.ReadLine()
  if ([string]::IsNullOrWhiteSpace($line)) { throw '工作区桥接没有返回结果' }
  $response = $line | ConvertFrom-Json
  if (-not $response.ok) { throw "$($response.error.code)：$($response.error.message)" }
  return $response.result
}

function Get-SafeFullPath {
  <# 功能：把相对路径解析到工作区并阻止越界。入参：工作区根目录、相对路径、是否允许根目录。返回值：规范化绝对路径；越界、空路径或重解析点时抛出异常。 #>
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$RelativePath,
    [bool]$AllowRoot = $true
  )
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $candidate = if ([string]::IsNullOrWhiteSpace($RelativePath)) { $rootFull } else { [IO.Path]::GetFullPath((Join-Path $rootFull $RelativePath)) }
  if (-not $AllowRoot -and $candidate -eq $rootFull) { throw '不能操作工作区根目录' }
  $prefix = "$rootFull\"
  if ($candidate -ne $rootFull -and -not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw '路径超出工作区范围' }
  $current = $candidate
  while ($current -and $current.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '不允许通过符号链接或重解析点操作文件' }
    }
    $parent = Split-Path -Parent $current
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
  return $candidate
}

function Split-FusionCreatePath {
  <# 功能：把用户输入的相对创建路径拆分为桥接服务所需的父目录和名称。入参：工作区根目录、相对创建路径。返回值：含 parentRelativePath、name 的哈希表；根目录、越界或空名称时抛出异常。 #>
  param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$RelativePath)
  $target = Get-SafeFullPath -Root $Root -RelativePath $RelativePath -AllowRoot:$false
  $normalizedRelativePath = Get-FusionRelativePath -Root $Root -Target $target
  $name = Split-Path -Leaf $normalizedRelativePath
  $parent = Split-Path -Parent $normalizedRelativePath
  if ([string]::IsNullOrWhiteSpace($name)) { throw '名称不能为空' }
  return @{ parentRelativePath = if ([string]::IsNullOrWhiteSpace($parent)) { '' } else { $parent }; name = $name }
}

function New-TreeNode {
  <# 功能：创建一个文件树节点。入参：文件系统对象。返回值：带绝对路径标签的 TreeViewItem。 #>
  param([Parameter(Mandatory = $true)][IO.FileSystemInfo]$Item)
  $node = New-Object System.Windows.Controls.TreeViewItem
  $node.Header = $Item.Name
  $node.Tag = $Item.FullName
  if ($Item.PSIsContainer) { [void]$node.Items.Add('加载中…') }
  return $node
}

function Set-TreeChildren {
  <# 功能：加载目录节点的一级子项。入参：TreeViewItem。返回值：无；读取失败时显示错误节点。 #>
  param([Parameter(Mandatory = $true)][System.Windows.Controls.TreeViewItem]$Node)
  if (-not $Node.Tag -or -not (Test-Path -LiteralPath $Node.Tag -PathType Container)) { return }
  $Node.Items.Clear()
  try {
    Get-ChildItem -LiteralPath $Node.Tag -Force -ErrorAction Stop | Sort-Object @{Expression = { -not $_.PSIsContainer }}, Name | ForEach-Object { [void]$Node.Items.Add((New-TreeNode -Item $_)) }
  } catch {
    [void]$Node.Items.Add("读取失败：$($_.Exception.Message)")
  }
}

function Refresh-Tree {
  <# 功能：刷新工作区树。入参：TreeView 控件、工作区根目录。返回值：无。 #>
  param([Parameter(Mandatory = $true)][System.Windows.Controls.TreeView]$Tree, [Parameter(Mandatory = $true)][string]$Root)
  $Tree.Items.Clear()
  $rootItem = Get-Item -LiteralPath $Root -Force
  $rootNode = New-TreeNode -Item $rootItem
  [void]$Tree.Items.Add($rootNode)
  Set-TreeChildren -Node $rootNode
  $rootNode.IsExpanded = $true
}

function Show-SelectedFile {
  <# 功能：读取选中文件到编辑框。入参：树节点、文本框、状态标签。返回值：无；超出大小或非文本文件时拒绝读取。 #>
  param([System.Windows.Controls.TreeViewItem]$Node, [System.Windows.Controls.TextBox]$Editor, [System.Windows.Controls.TextBlock]$Status)
  if (-not $Node -or -not (Test-Path -LiteralPath $Node.Tag -PathType Leaf)) { $Editor.IsEnabled = $false; $Editor.Tag = $null; return }
  $info = Get-Item -LiteralPath $Node.Tag -Force
  if ($info.Length -gt 5MB) { $Editor.IsEnabled = $false; $Editor.Text = ''; $Editor.Tag = $null; $Status.Text = '文件超过 5 MB，仅显示元数据'; return }
  try {
    $relativePath = Get-FusionRelativePath -Root $root -Target $Node.Tag
    $preview = Invoke-FusionBridge -Method 'workspace.preview' -Params @{ relativePath = $relativePath }
    if (-not $preview.editable) { $Editor.IsEnabled = $false; $Editor.Tag = $null; $script:EditorVersion = $null; $Status.Text = '该文件不可编辑'; return }
    $Editor.Text = [string]$preview.text
    $Editor.Tag = $Node.Tag
    $script:EditorVersion = [string]$preview.version
    $Editor.IsEnabled = $true
    $Status.Text = "已打开：$($Node.Tag)"
  } catch {
    $Editor.Text = ''; $Status.Text = "无法作为 UTF-8 文本打开：$($_.Exception.Message)"
  }
}

$root = Get-SafeFullPath -Root $Workspace -RelativePath ''
$bridgeExecutable = if ($BridgePath) { $BridgePath } else { Join-Path $FusionRoot 'bin\\fusion-bridge.exe' }
$script:BridgeProcess = Start-FusionBridge -Executable $bridgeExecutable -Root $root
$window = New-Object System.Windows.Window
$window.Title = 'Codex Fusion 工作区'
$window.Width = 1180
$window.Height = 760
$window.MinWidth = 820
$window.MinHeight = 520
$window.WindowStartupLocation = 'CenterScreen'

$grid = New-Object System.Windows.Controls.Grid
[void]$grid.RowDefinitions.Add((New-Object System.Windows.Controls.RowDefinition -Property @{Height = 'Auto'}))
[void]$grid.RowDefinitions.Add((New-Object System.Windows.Controls.RowDefinition -Property @{Height = '*'}))
[void]$grid.RowDefinitions.Add((New-Object System.Windows.Controls.RowDefinition -Property @{Height = 'Auto'}))
$toolbar = New-Object System.Windows.Controls.StackPanel
$toolbar.Orientation = 'Horizontal'
$toolbar.Margin = '8'
$buttons = @{}
foreach ($name in @('刷新', '新建文件', '新建文件夹', '重命名', '移到回收站', '保存')) {
  $button = New-Object System.Windows.Controls.Button
  $button.Content = $name
  $button.Margin = '0,0,8,0'
  $button.Padding = '12,5'
  [void]$toolbar.Children.Add($button)
  $buttons[$name] = $button
}
$safeLabel = New-Object System.Windows.Controls.TextBlock
$safeLabel.Text = if ($SafeMode) { '安全模式：仅限工作区' } else { '安全模式已关闭' }
$safeLabel.Margin = '8,6,0,0'
$safeLabel.Foreground = [System.Windows.Media.Brushes]::DarkGreen
[void]$toolbar.Children.Add($safeLabel)
[System.Windows.Controls.Grid]::SetRow($toolbar, 0)
[void]$grid.Children.Add($toolbar)

 $split = New-Object System.Windows.Controls.Grid
 [void]$split.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition -Property @{Width = '320'}))
 [void]$split.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition -Property @{Width = '*'}))
 $tree = New-Object System.Windows.Controls.TreeView
 $tree.Margin = '8,0,4,8'
 $editor = New-Object System.Windows.Controls.TextBox
 $editor.Margin = '4,0,8,8'
 $editor.AcceptsReturn = $true
 $editor.AcceptsTab = $true
 $editor.VerticalScrollBarVisibility = 'Auto'
 $editor.HorizontalScrollBarVisibility = 'Auto'
 $editor.TextWrapping = 'NoWrap'
 $editor.FontFamily = 'Consolas'
 $editor.IsEnabled = $false
 [System.Windows.Controls.Grid]::SetColumn($tree, 0)
 [System.Windows.Controls.Grid]::SetColumn($editor, 1)
 [void]$split.Children.Add($tree)
 [void]$split.Children.Add($editor)
 [System.Windows.Controls.Grid]::SetRow($split, 1)
 [void]$grid.Children.Add($split)

 $status = New-Object System.Windows.Controls.TextBlock
 $status.Text = "工作区：$root"
 $status.Margin = '8,0,8,8'
 [System.Windows.Controls.Grid]::SetRow($status, 2)
 [void]$grid.Children.Add($status)
 $window.Content = $grid

 Refresh-Tree -Tree $tree -Root $root
 $tree.AddHandler([System.Windows.Controls.TreeViewItem]::ExpandedEvent, [System.Windows.RoutedEventHandler]{ param($sender, $event); Set-TreeChildren -Node $event.OriginalSource })
 $tree.AddHandler([System.Windows.Controls.TreeViewItem]::SelectedEvent, [System.Windows.RoutedEventHandler]{ param($sender, $event); Show-SelectedFile -Node $event.OriginalSource -Editor $editor -Status $status })
 $buttons['刷新'].Add_Click({ Refresh-Tree -Tree $tree -Root $root; $status.Text = "已刷新：$root" })
 $buttons['保存'].Add_Click({
   if (-not $editor.Tag) { $status.Text = '请先选择文本文件'; return }
   try { $relativePath = Get-FusionRelativePath -Root $root -Target ([string]$editor.Tag); $preview = Invoke-FusionBridge -Method 'workspace.save' -Params @{ relativePath = $relativePath; expectedVersion = $script:EditorVersion; content = $editor.Text }; $script:EditorVersion = [string]$preview.version; $status.Text = "已保存：$($editor.Tag)" } catch { $status.Text = "保存失败：$($_.Exception.Message)" }
 })
 $buttons['新建文件'].Add_Click({
   $name = [Microsoft.VisualBasic.Interaction]::InputBox('输入文件名（相对当前工作区根目录）', '新建文件', 'new-file.txt')
   if ([string]::IsNullOrWhiteSpace($name)) { return }
   try { $createPath = Split-FusionCreatePath -Root $root -RelativePath $name; $created = Invoke-FusionBridge -Method 'workspace.create' -Params @{ parentRelativePath = $createPath.parentRelativePath; name = $createPath.name; kind = 'file' }; Refresh-Tree -Tree $tree -Root $root; $status.Text = "已创建：$($created.relativePath)" } catch { $status.Text = "创建失败：$($_.Exception.Message)" }
 })
 $buttons['新建文件夹'].Add_Click({
   $name = [Microsoft.VisualBasic.Interaction]::InputBox('输入新文件夹相对路径', '新建文件夹', 'new-folder')
   if ([string]::IsNullOrWhiteSpace($name)) { return }
   try { $createPath = Split-FusionCreatePath -Root $root -RelativePath $name; $created = Invoke-FusionBridge -Method 'workspace.create' -Params @{ parentRelativePath = $createPath.parentRelativePath; name = $createPath.name; kind = 'directory' }; Refresh-Tree -Tree $tree -Root $root; $status.Text = "已创建：$($created.relativePath)" } catch { $status.Text = "创建失败：$($_.Exception.Message)" }
 })
 $buttons['重命名'].Add_Click({
   $selected = $tree.SelectedItem
   if (-not $selected -or -not $selected.Tag) { $status.Text = '请先选择项目'; return }
   try { $relativePath = Get-FusionRelativePath -Root $root -Target ([string]$selected.Tag); $name = [Microsoft.VisualBasic.Interaction]::InputBox('输入新的名称', '重命名', (Split-Path -Leaf $relativePath)); if ([string]::IsNullOrWhiteSpace($name)) { return }; if ($name.Contains('\') -or $name.Contains('/')) { throw '名称不能包含路径分隔符' }; $renamed = Invoke-FusionBridge -Method 'workspace.rename' -Params @{ relativePath = $relativePath; newName = $name }; Refresh-Tree -Tree $tree -Root $root; $status.Text = "已重命名：$($renamed.relativePath)" } catch { $status.Text = "重命名失败：$($_.Exception.Message)" }
 })
 $buttons['移到回收站'].Add_Click({
   $selected = $tree.SelectedItem
   if (-not $selected -or -not $selected.Tag) { $status.Text = '请先选择项目'; return }
   try { $target = Get-SafeFullPath -Root $root -RelativePath (Get-FusionRelativePath -Root $root -Target ([string]$selected.Tag)) -AllowRoot:$false; $answer = [System.Windows.MessageBox]::Show("确认将以下项目移到回收站？`n$target", '确认操作', 'YesNo', 'Warning'); if ($answer -ne 'Yes') { return }; if ((Get-Item -LiteralPath $target).PSIsContainer) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin) } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin) }; Refresh-Tree -Tree $tree -Root $root; $status.Text = '已移到回收站' } catch { Refresh-Tree -Tree $tree -Root $root; $status.Text = "删除失败：$($_.Exception.Message)" }
 })
 [void]$window.ShowDialog()
 if ($null -ne $script:BridgeProcess -and -not $script:BridgeProcess.HasExited) { $script:BridgeProcess.StandardInput.Close(); $script:BridgeProcess.WaitForExit(1500); if (-not $script:BridgeProcess.HasExited) { $script:BridgeProcess.Kill() } }
