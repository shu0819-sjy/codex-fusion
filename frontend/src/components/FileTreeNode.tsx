import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Link2, Lock } from 'lucide-react';
import type { WorkspaceEntry } from '../bridge/WorkspaceBridge';
import { fileIconClass } from '../utils/fileIcons';

/**
 * 文件树单个节点行（纯展示）：展开箭头 + 着色图标 + 名称 + 无权限锁标记。
 * 图标按扩展名着色（见 utils/fileIcons），目录展开时高亮；递归子节点由 FileTree 渲染。
 */

export interface FileTreeNodeProps {
  entry: WorkspaceEntry;
  depth: number;
  expanded: boolean;
  selected: boolean;
  /** 键盘导航焦点（方向键所在行；与选中分离） */
  focused?: boolean;
  /** 点击展开/折叠箭头 */
  onToggle: () => void;
  /** 点击节点主体（选中；目录同时展开） */
  onSelect: () => void;
}

/** 渲染条目图标：目录（展开/折叠）+ 符号链接 + 文件（按类型着色） */
function entryIcon(entry: WorkspaceEntry, expanded: boolean) {
  if (entry.kind === 'directory') {
    return expanded ? (
      <span className="tree-dir-icon open">
        <FolderOpen size={15} aria-hidden="true" />
      </span>
    ) : (
      <span className="tree-dir-icon">
        <Folder size={15} aria-hidden="true" />
      </span>
    );
  }
  if (entry.kind === 'symlink') {
    return (
      <span className="tree-file-icon">
        <Link2 size={15} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className={`tree-file-icon ${fileIconClass(entry.name)}`}>
      <FileText size={15} aria-hidden="true" />
    </span>
  );
}

export function FileTreeNode(props: FileTreeNodeProps) {
  const { entry, depth, expanded, selected, focused = false, onToggle, onSelect } = props;
  const isDirectory = entry.kind === 'directory';
  const canToggle = isDirectory && !entry.inaccessible;

  return (
    <div
      className={[
        'tree-node',
        selected ? 'selected' : '',
        focused ? 'focused' : '',
        entry.inaccessible ? 'inaccessible' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="treeitem"
      aria-selected={selected}
      data-tree-path={entry.relativePath}
      style={{ paddingLeft: 6 + depth * 14 }}
    >
      <button
        type="button"
        className="tree-toggle"
        aria-label={canToggle ? (expanded ? `折叠 ${entry.name}` : `展开 ${entry.name}`) : undefined}
        disabled={!canToggle}
        onClick={onToggle}
      >
        {isDirectory ? (
          expanded ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )
        ) : (
          <span className="tree-toggle-spacer" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className="tree-row-main"
        aria-label={entry.inaccessible ? `${entry.name}（无权限访问）` : entry.name}
        onClick={onSelect}
      >
        {entryIcon(entry, expanded)}
        <span className="tree-name">{entry.name}</span>
        {entry.inaccessible ? (
          <span className="tree-lock" title="无权限访问">
            <Lock size={12} aria-label="无权限访问" />
          </span>
        ) : null}
      </button>
    </div>
  );
}
