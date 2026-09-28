import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { FilePlus, FolderPlus, Loader2, PenLine, RefreshCw, Trash2 } from 'lucide-react';
import type { BridgeError, WorkspaceBridge, WorkspaceEntry } from '../bridge/WorkspaceBridge';
import { toBridgeError } from '../bridge/WorkspaceBridge';
import { parentOfPath } from '../utils/path';
import { FileTreeNode } from './FileTreeNode';

/** 目录加载状态 */
interface DirState {
  entries: WorkspaceEntry[];
  nextCursor?: string;
  truncated: boolean;
  status: 'loading' | 'ready' | 'error';
  error?: BridgeError;
}

/** 空目录初始状态 */
const emptyDirState: DirState = { entries: [], truncated: false, status: 'loading' };

/** 树中定位请求：自动展开目标路径的祖先目录并滚动到目标行 */
export interface RevealRequest {
  path: string;
  /** 递增序号，保证每次请求都是新一次定位 */
  nonce: number;
}

/** 右键上下文菜单的动作回调（由外层 WorkspaceShell 提供对话框与刷新入口） */
export interface FileTreeContextMenuHandlers {
  /** 在指定父目录新建文件（空字符串 = 根目录） */
  onNewFileIn: (parentRelativePath: string) => void;
  /** 在指定父目录新建目录 */
  onNewDirectoryIn: (parentRelativePath: string) => void;
  onRename: (entry: WorkspaceEntry) => void;
  onDelete: (entry: WorkspaceEntry) => void;
  onRefresh: () => void;
}

/** 右键菜单状态 */
interface ContextMenuState {
  x: number;
  y: number;
  entry: WorkspaceEntry | null;
}

/**
 * 文件树：延迟展开目录、加载状态、空目录、无权限、隐藏/忽略项提示。
 * 数据全部来自 WorkspaceBridge.list（只传相对路径），内部维护目录缓存与分页。
 * 交互增强：↑/↓/←/→/Enter 键盘导航（焦点高亮与选中分离），右键上下文菜单。
 */
export interface FileTreeProps {
  bridge: WorkspaceBridge;
  /** 当前选中条目的相对路径 */
  selectedPath: string | null;
  /** 变更后触发整树刷新（新建/重命名/移动/复制/删除后由外层自增） */
  refreshToken: number;
  /** 点击条目（文件→预览；目录→选中并展开） */
  onSelect: (entry: WorkspaceEntry) => void;
  /** 树中定位请求（面包屑跳转 / 切换标签时由外层发出），非空时自动展开并滚动 */
  revealRequest?: RevealRequest | null;
  /** 右键菜单回调（未提供时禁用右键菜单） */
  contextMenu?: FileTreeContextMenuHandlers;
}

export function FileTree(props: FileTreeProps) {
  const { bridge, selectedPath, refreshToken, onSelect, revealRequest, contextMenu } = props;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [showHidden, setShowHidden] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  // 键盘导航焦点（与选中分离：焦点是方向键所在行，选中是最后打开/激活的项）
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  // 每个路径的加载序号，用于丢弃过期响应（快速展开/折叠时避免错位）
  const pathSeqRef = useRef<Record<string, number>>({});
  const expandedRef = useRef<Set<string>>(expanded);
  const dirsRef = useRef<Record<string, DirState>>(dirs);
  useEffect(() => {
    expandedRef.current = expanded;
    dirsRef.current = dirs;
  }, [expanded, dirs]);

  /** 加载某个目录（'' 表示根目录）；带 cursor 时为追加分页 */
  const loadDir = useCallback(
    (path: string, cursor?: string) => {
      const seq = (pathSeqRef.current[path] ?? 0) + 1;
      pathSeqRef.current[path] = seq;
      setDirs((prev) => ({
        ...prev,
        [path]: {
          entries: cursor ? (prev[path]?.entries ?? []) : [],
          nextCursor: undefined,
          truncated: false,
          status: 'loading',
        },
      }));
      bridge
        .list({
          relativePath: path.length === 0 ? undefined : path,
          cursor,
          showHidden,
          showIgnored,
        })
        .then((result) => {
          if (pathSeqRef.current[path] !== seq) {
            return;
          }
          setDirs((prev) => {
            const base = prev[path]?.entries ?? [];
            return {
              ...prev,
              [path]: {
                entries: cursor ? [...base, ...result.entries] : result.entries,
                nextCursor: result.nextCursor,
                truncated: result.truncated,
                status: 'ready',
              },
            };
          });
        })
        .catch((cause) => {
          if (pathSeqRef.current[path] !== seq) {
            return;
          }
          setDirs((prev) => ({
            ...prev,
            [path]: { entries: [], truncated: false, status: 'error', error: toBridgeError(cause) },
          }));
        });
    },
    [bridge, showHidden, showIgnored],
  );

  /** 整树刷新：清空缓存，重载根目录与所有已展开目录 */
  const reloadTree = useCallback(() => {
    for (const key of Object.keys(pathSeqRef.current)) {
      pathSeqRef.current[key] += 1;
    }
    setDirs({});
    loadDir('');
    for (const path of expandedRef.current) {
      loadDir(path);
    }
  }, [loadDir]);

  // 初始加载 + 刷新令牌 / 过滤开关变化时整树刷新
  useEffect(() => {
    reloadTree();
  }, [reloadTree, refreshToken]);

  /** 树中定位：沿目标路径逐级加载并展开祖先目录，最后滚动到目标行 */
  useEffect(() => {
    if (!revealRequest) {
      return;
    }
    let cancelled = false;
    const target = revealRequest.path;
    const segments = target.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) {
      return;
    }
    void (async () => {
      try {
        let prefix = '';
        // 展开所有祖先目录（不含目标自身）
        for (let i = 0; i < segments.length - 1; i++) {
          if (cancelled) {
            return;
          }
          prefix = prefix.length === 0 ? segments[i] : `${prefix}/${segments[i]}`;
          const cached = dirsRef.current[prefix];
          if (!cached || cached.status !== 'ready') {
            const result = await bridge.list({
              relativePath: prefix,
              showHidden,
              showIgnored,
            });
            if (cancelled) {
              return;
            }
            setDirs((prev) => ({
              ...prev,
              [prefix]: {
                entries: result.entries,
                nextCursor: result.nextCursor,
                truncated: result.truncated,
                status: 'ready',
              },
            }));
          }
          setExpanded((prev) => (prev.has(prefix) ? prev : new Set(prev).add(prefix)));
        }
        if (cancelled) {
          return;
        }
        // 等布局稳定后滚动到目标行（jsdom 不支持 scrollIntoView 时静默跳过）
        window.requestAnimationFrame(() => {
          if (cancelled) {
            return;
          }
          const rows = document.querySelectorAll<HTMLElement>('[data-tree-path]');
          for (const row of rows) {
            if (row.dataset.treePath === target) {
              try {
                row.scrollIntoView({ block: 'nearest' });
              } catch {
                // 测试环境无滚动实现，忽略
              }
              break;
            }
          }
        });
      } catch {
        // 定位失败（目录不存在 / 无权限）时静默，树保持现状
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revealRequest, bridge, showHidden, showIgnored]);

  /** 展开/折叠目录 */
  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    setExpanded(next);
    // 首次展开时懒加载；若已缓存则直接使用
    if (next.has(path) && !dirs[path]) {
      loadDir(path);
    }
  };

  /** 点击节点：目录选中并展开（无权限目录仅选中），文件选中并预览 */
  const handleSelect = (entry: WorkspaceEntry) => {
    onSelect(entry);
    if (entry.kind === 'directory' && !entry.inaccessible) {
      toggle(entry.relativePath);
    }
  };

  /** 按相对路径从已加载目录中查找条目 */
  const findEntryByPath = useCallback(
    (path: string): WorkspaceEntry | null => {
      const parent = parentOfPath(path);
      const list = (parent === '' ? dirs[''] : dirs[parent])?.entries ?? [];
      return list.find((e) => e.relativePath === path) ?? null;
    },
    [dirs],
  );

  /** 滚动到指定路径的行（键盘导航时保持焦点行可见） */
  const focusRow = useCallback((path: string) => {
    window.requestAnimationFrame(() => {
      const rows = document.querySelectorAll<HTMLElement>('[data-tree-path]');
      for (const row of rows) {
        if (row.dataset.treePath === path) {
          try {
            row.scrollIntoView({ block: 'nearest' });
          } catch {
            // 测试环境无滚动实现，忽略
          }
          break;
        }
      }
    });
  }, []);

  /** 当前可见节点路径（按渲染顺序）：根就绪后递归展开目录 */
  const visiblePaths = useMemo(() => {
    const list: string[] = [];
    const walk = (entries: WorkspaceEntry[]) => {
      for (const entry of entries) {
        list.push(entry.relativePath);
        if (entry.kind === 'directory' && expanded.has(entry.relativePath)) {
          const state = dirs[entry.relativePath];
          if (state && state.status === 'ready') {
            walk(state.entries);
          }
        }
      }
    };
    const root = dirs[''];
    if (root && root.status === 'ready') {
      walk(root.entries);
    }
    return list;
  }, [dirs, expanded]);

  /** 键盘导航：↑↓ 移动焦点，→ 展开/进入，← 折叠/回父，Enter 打开 */
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (menu) {
      return;
    }
    const index = focusPath ? visiblePaths.indexOf(focusPath) : -1;
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = visiblePaths[Math.min(visiblePaths.length - 1, index + 1)];
        if (next) {
          setFocusPath(next);
          focusRow(next);
        }
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const next = visiblePaths[Math.max(0, index - 1)];
        if (next) {
          setFocusPath(next);
          focusRow(next);
        }
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        if (!focusPath) {
          break;
        }
        const entry = findEntryByPath(focusPath);
        if (entry && entry.kind === 'directory' && !entry.inaccessible) {
          if (!expanded.has(focusPath)) {
            toggle(focusPath);
          } else {
            const children = dirs[focusPath]?.entries ?? [];
            const first = children[0];
            if (first) {
              setFocusPath(first.relativePath);
              focusRow(first.relativePath);
            }
          }
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (!focusPath) {
          break;
        }
        if (expanded.has(focusPath)) {
          toggle(focusPath);
        } else {
          const parent = parentOfPath(focusPath);
          if (parent) {
            setFocusPath(parent);
            focusRow(parent);
          }
        }
        break;
      }
      case 'Enter': {
        event.preventDefault();
        if (!focusPath) {
          break;
        }
        const entry = findEntryByPath(focusPath);
        if (entry) {
          handleSelect(entry);
        }
        break;
      }
      default:
        break;
    }
  };

  /** 关闭右键菜单 */
  const closeMenu = useCallback(() => setMenu(null), []);

  /** 右键菜单：定位到命中的节点；空白处视为根目录 */
  const handleContextMenu = (event: React.MouseEvent) => {
    if (!contextMenu) {
      return;
    }
    event.preventDefault();
    const target = (event.target as HTMLElement).closest('[data-tree-path]');
    let entry: WorkspaceEntry | null = null;
    if (target) {
      const path = target.getAttribute('data-tree-path') ?? '';
      entry = findEntryByPath(path);
    }
    setMenu({ x: event.clientX, y: event.clientY, entry });
  };

  /** 菜单项的父目录：目录 → 自身；文件 → 其父；空白 → 根 */
  const menuParent = (entry: WorkspaceEntry | null): string =>
    entry ? (entry.kind === 'directory' ? entry.relativePath : parentOfPath(entry.relativePath)) : '';

  /** 渲染菜单项 */
  const menuItem = (label: string, icon: ReactNode, onAction: () => void, danger = false) => (
    <button
      type="button"
      className={danger ? 'context-menu-item danger' : 'context-menu-item'}
      role="menuitem"
      onClick={() => {
        closeMenu();
        onAction();
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  /** 递归渲染一行及其子节点 */
  const renderRow = (entry: WorkspaceEntry, depth: number): ReactNode => {
    const isDirectory = entry.kind === 'directory';
    const isExpanded = expanded.has(entry.relativePath);
    const state = isDirectory ? dirs[entry.relativePath] : undefined;
    return (
      <Fragment key={entry.id}>
        <FileTreeNode
          entry={entry}
          depth={depth}
          expanded={isExpanded}
          selected={selectedPath === entry.relativePath}
          focused={focusPath === entry.relativePath}
          onToggle={() => toggle(entry.relativePath)}
          onSelect={() => handleSelect(entry)}
        />
        {isDirectory && isExpanded ? (
          <div className="tree-children" role="group">
            {!state || state.status === 'loading' ? (
              <div className="tree-hint">
                <Loader2 size={12} className="spin" aria-hidden="true" />
                加载中…
              </div>
            ) : null}
            {state?.status === 'error' && state.error ? (
              <div className="tree-hint tree-error" role="alert">
                {state.error.code}: {state.error.message}
              </div>
            ) : null}
            {state?.status === 'ready' ? (
              <>
                {state.entries.length === 0 ? <div className="tree-hint">（空目录）</div> : null}
                {state.entries.map((child) => renderRow(child, depth + 1))}
                {state.truncated && state.nextCursor ? (
                  <button type="button" className="tree-load-more" onClick={() => loadDir(entry.relativePath, state.nextCursor)}>
                    加载更多
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </Fragment>
    );
  };

  const rootState = dirs[''] ?? emptyDirState;

  return (
    <div className="file-tree">
      <div className="tree-header">
        <span className="tree-header-title">文件</span>
        <span className="tree-header-count" aria-hidden="true">
          {rootState.status === 'ready' ? rootState.entries.length : '…'}
        </span>
      </div>
      <div
        className="tree-scroll"
        role="tree"
        aria-label="工作区文件树"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
      >
        {rootState.status === 'loading' ? (
          <div className="tree-hint">
            <Loader2 size={12} className="spin" aria-hidden="true" />
            加载中…
          </div>
        ) : null}
        {rootState.status === 'error' && rootState.error ? (
          <div className="tree-hint tree-error" role="alert">
            {rootState.error.code}: {rootState.error.message}
          </div>
        ) : null}
        {rootState.status === 'ready' ? (
          <>
            {rootState.entries.length === 0 ? <div className="tree-hint">（空目录）</div> : null}
            {rootState.entries.map((entry) => renderRow(entry, 0))}
          </>
        ) : null}
      </div>
      <div className="tree-filters">
        <label className="tree-filter">
          <input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />
          <span>显示隐藏项</span>
        </label>
        <label className="tree-filter">
          <input type="checkbox" checked={showIgnored} onChange={(event) => setShowIgnored(event.target.checked)} />
          <span>显示忽略项</span>
        </label>
        <p className="tree-hint">隐藏项（. 开头）默认不显示</p>
      </div>
      {menu ? (
        <>
          <div className="context-menu-backdrop" onClick={closeMenu} onContextMenu={(event) => { event.preventDefault(); closeMenu(); }} />
          <div className="context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 180), top: Math.min(menu.y, window.innerHeight - 200) }} role="menu">
            {menuItem('新建文件', <FilePlus size={14} />, () => contextMenu?.onNewFileIn(menuParent(menu.entry)))}
            {menuItem('新建目录', <FolderPlus size={14} />, () => contextMenu?.onNewDirectoryIn(menuParent(menu.entry)))}
            {menu.entry ? (
              <>
                <div className="context-menu-divider" />
                {menuItem('重命名', <PenLine size={14} />, () => contextMenu?.onRename(menu.entry as WorkspaceEntry))}
                {menuItem('删除', <Trash2 size={14} />, () => contextMenu?.onDelete(menu.entry as WorkspaceEntry), true)}
              </>
            ) : null}
            <div className="context-menu-divider" />
            {menuItem('刷新', <RefreshCw size={14} />, () => contextMenu?.onRefresh())}
          </div>
        </>
      ) : null}
    </div>
  );
}
