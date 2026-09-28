import { Copy, FilePlus, FolderInput, FolderPlus, PanelLeft, PanelLeftClose, Palette, PenLine, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { WorkspaceContext } from '../bridge/WorkspaceBridge';
import { IconButton } from './IconButton';

/**
 * 顶部工具栏：刷新、新建文件、新建目录、重命名、移动、复制、删除、保存 + 侧栏折叠。
 * 所有按钮具备 disabled / loading / tooltip 状态；操作名与忙状态由外层 WorkspaceShell 控制。
 */
export interface ToolbarProps {
  context: WorkspaceContext | null;
  /** 当前正在执行的操作名（'refresh' | 'save' | 其他），非空时禁用全部操作 */
  busy: string | null;
  /** 是否允许保存（可编辑 + 有未保存修改） */
  canSave: boolean;
  hasSelection: boolean;
  sidebarCollapsed: boolean;
  onRefresh: () => void;
  onNewFile: () => void;
  onNewDirectory: () => void;
  onRename: () => void;
  onMove: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onSave: () => void;
  onToggleSidebar: () => void;
  onOpenThemeStudio?: () => void;
}

export function Toolbar(props: ToolbarProps) {
  const {
    context,
    busy,
    canSave,
    hasSelection,
    sidebarCollapsed,
    onRefresh,
    onNewFile,
    onNewDirectory,
    onRename,
    onMove,
    onCopy,
    onDelete,
    onSave,
    onToggleSidebar,
    onOpenThemeStudio,
  } = props;

  const opsDisabled = busy !== null;
  const selectionDisabled = opsDisabled || !hasSelection;

  return (
    <div className="toolbar" role="toolbar" aria-label="工作区操作" aria-busy={busy !== null}>
      <div className="toolbar-group">
        <IconButton
          icon={sidebarCollapsed ? PanelLeft : PanelLeftClose}
          label="折叠文件树"
          tooltip={sidebarCollapsed ? '展开文件树' : '折叠文件树'}
          onClick={onToggleSidebar}
        />
        <span className="toolbar-divider" />
        <IconButton icon={RefreshCw} label="刷新" tooltip="刷新工作区" onClick={onRefresh} disabled={opsDisabled} loading={busy === 'refresh'} />
      </div>
      <div className="toolbar-group">
        <IconButton icon={FilePlus} label="新建文件" tooltip="新建文件" onClick={onNewFile} disabled={opsDisabled} />
        <IconButton icon={FolderPlus} label="新建目录" tooltip="新建目录" onClick={onNewDirectory} disabled={opsDisabled} />
        <span className="toolbar-divider" />
        <IconButton icon={PenLine} label="重命名" tooltip="重命名 (F2)" onClick={onRename} disabled={selectionDisabled} />
        <IconButton icon={FolderInput} label="移动" tooltip="移动到目录…" onClick={onMove} disabled={selectionDisabled} />
        <IconButton icon={Copy} label="复制" tooltip="复制到目录…" onClick={onCopy} disabled={selectionDisabled} />
        <span className="toolbar-divider" />
        <IconButton icon={Trash2} label="删除" tooltip="删除 (Delete)" onClick={onDelete} disabled={selectionDisabled} danger />
      </div>
      <div className="toolbar-group toolbar-right">
        {onOpenThemeStudio ? <IconButton icon={Palette} label="返回壁纸主题" tooltip="返回 Dream Skin 主题" onClick={onOpenThemeStudio} /> : null}
        <IconButton
          icon={Save}
          label="保存"
          text="保存"
          tooltip={canSave ? '保存 (Ctrl+S)' : '没有可保存的修改'}
          onClick={onSave}
          disabled={!canSave || opsDisabled}
          loading={busy === 'save'}
          primary
        />
        {context ? (
          <span className={context.rootValid ? 'workspace-badge ok' : 'workspace-badge bad'} title={context.rootValid ? '工作区有效' : '工作区无效'}>
            {context.rootValid ? '工作区有效' : '工作区无效'}
          </span>
        ) : null}
      </div>
    </div>
  );
}
