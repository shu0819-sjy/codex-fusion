import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { BridgeError, PreviewResult, WorkspaceBridge, WorkspaceContext, WorkspaceEntry } from '../bridge/WorkspaceBridge';
import { VERSION_CONFLICT, toBridgeError } from '../bridge/WorkspaceBridge';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { buildCopyName, baseNameOfPath, parentOfPath } from '../utils/path';
import { Toolbar } from './Toolbar';
import { FileTree } from './FileTree';
import { EditorPane } from './EditorPane';
import { StatusBar } from './StatusBar';
import { ErrorNotice } from './ErrorNotice';
import { ConfirmDialog } from './ConfirmDialog';
import { NameDialog } from './NameDialog';
import { MoveCopyDialog } from './MoveCopyDialog';
import { ConflictDialog } from './ConflictDialog';

/** 对话框状态机 */
type DialogState =
  | { type: 'confirm-delete'; entry: WorkspaceEntry }
  | { type: 'confirm-close-dirty'; path: string; name: string }
  | { type: 'name'; mode: 'create-file' | 'create-dir' | 'rename'; entry?: WorkspaceEntry; parentPath?: string }
  | { type: 'move-copy'; mode: 'move' | 'copy'; entry: WorkspaceEntry }
  | { type: 'conflict'; error: BridgeError }
  | null;

/** 单个编辑器标签页的状态 */
export interface EditorTab {
  /** 文件相对路径（标签唯一键） */
  path: string;
  previewState: 'loading' | 'ready' | 'error';
  preview: PreviewResult | null;
  previewError: BridgeError | null;
  /** 未保存草稿；null 表示无修改 */
  draft: string | null;
}

/**
 * WorkspaceShell：工作台整体编排（多标签页模型）。
 * 持有文件树选中项、打开的标签页列表、激活标签、对话框与忙状态；
 * 所有数据操作只经由 WorkspaceBridge，失败时统一展示桥接层返回的 code/message。
 */
export interface WorkspaceShellProps {
  bridge: WorkspaceBridge;
  /** 返回 Dream Skin 主题页；未提供时隐藏入口，便于独立嵌入工作区。 */
  onOpenThemeStudio?: () => void;
  /** 当前运行模式只读标签（U6）；未提供时不展示。 */
  modeLabel?: string | null;
}

export function WorkspaceShell(props: WorkspaceShellProps) {
  const { bridge, onOpenThemeStudio, modeLabel = null } = props;
  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<WorkspaceEntry | null>(null);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<BridgeError | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  // 树中定位请求（标签切换 / 面包屑跳转时发出）
  const [revealRequest, setRevealRequest] = useState<{ path: string; nonce: number } | null>(null);
  const revealNonceRef = useRef(0);
  // null = 跟随媒体查询（≤1024px 折叠）；用户手动切换后以显式值为准
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  // 操作成功的 toast 反馈（右下角短暂显示）
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const isNarrow = useMediaQuery('(max-width: 1024px)');
  const sidebarCollapsed = userCollapsed ?? isNarrow;

  // 用 ref 镜像异步回调里需要的状态，避免陈旧闭包
  const activePathRef = useRef<string | null>(null);
  const tabsRef = useRef<EditorTab[]>([]);
  const selectedEntryRef = useRef<WorkspaceEntry | null>(null);
  const busyRef = useRef<string | null>(null);
  const dialogRef = useRef<DialogState>(null);
  const previewSeqRef = useRef(0);
  useEffect(() => {
    activePathRef.current = activePath;
    tabsRef.current = tabs;
    selectedEntryRef.current = selectedEntry;
    busyRef.current = busy;
    dialogRef.current = dialog;
  }, [activePath, tabs, selectedEntry, busy, dialog]);

  /** 激活标签页（无激活时取第一个） */
  const activeTab: EditorTab | null = tabs.find((t) => t.path === activePath) ?? tabs[0] ?? null;

  /** 展示短暂的操作成功提示（自动消失） */
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 2200);
  }, []);

  /** 按路径局部更新标签状态 */
  const updateTab = useCallback((path: string, patch: Partial<EditorTab>) => {
    setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, ...patch } : t)));
  }, []);

  /** 加载工作区上下文（显示名 / 有效性） */
  const loadContext = useCallback(async () => {
    setBannerError(null);
    try {
      const ctx = await bridge.getContext();
      setContext(ctx);
    } catch (cause) {
      setBannerError(toBridgeError(cause));
    }
  }, [bridge]);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  /** 加载（重载）指定标签的预览；序号守卫丢弃过期的异步响应。
   *  preserveDraft=true 时保留未保存草稿（重命名/移动后使用，避免用户输入丢失）。 */
  const loadPreview = useCallback(
    async (path: string, preserveDraft = false) => {
      const seq = ++previewSeqRef.current;
      const patch: Partial<EditorTab> = { previewState: 'loading', preview: null, previewError: null };
      if (!preserveDraft) {
        patch.draft = null;
      }
      updateTab(path, patch);
      try {
        const result = await bridge.preview({ relativePath: path });
        if (seq !== previewSeqRef.current) {
          return;
        }
        updateTab(path, { previewState: 'ready', preview: result });
      } catch (cause) {
        if (seq !== previewSeqRef.current) {
          return;
        }
        updateTab(path, { previewState: 'error', previewError: toBridgeError(cause) });
      }
    },
    [bridge, updateTab],
  );

  /** 点击树节点：目录仅选中（展开由 FileTree 处理）；文件打开/激活标签 */
  const handleSelect = useCallback(
    (entry: WorkspaceEntry) => {
      setSelectedPath(entry.relativePath);
      setSelectedEntry(entry);
      if (entry.kind === 'directory') {
        return;
      }
      const existing = tabsRef.current.find((t) => t.path === entry.relativePath);
      if (existing) {
        setActivePath(entry.relativePath);
        return;
      }
      setTabs((prev) => [
        ...prev,
        { path: entry.relativePath, previewState: 'loading', preview: null, previewError: null, draft: null },
      ]);
      setActivePath(entry.relativePath);
      void loadPreview(entry.relativePath);
    },
    [loadPreview],
  );

  /** 发出树中定位请求（非空时 FileTree 自动展开祖先目录并滚动） */
  const revealPath = useCallback((path: string) => {
    setRevealRequest({ path, nonce: ++revealNonceRef.current });
  }, []);

  /** 切换激活标签：同步树选中，并在树中定位该文件（自动展开祖先） */
  const handleSwitchTab = useCallback(
    (path: string) => {
      setActivePath(path);
      setSelectedPath(path);
      revealPath(path);
    },
    [revealPath],
  );

  /** 面包屑跳转：定位目录到树中并选中（用于导航结构与路径的层级跳转） */
  const handleNavigatePath = useCallback(
    async (dirPath: string) => {
      setSelectedPath(dirPath);
      revealPath(dirPath);
      const parent = parentOfPath(dirPath);
      try {
        const list = await bridge.list({
          relativePath: parent.length > 0 ? parent : undefined,
          showHidden: true,
          showIgnored: true,
        });
        const entry = list.entries.find((e) => e.relativePath === dirPath);
        if (entry) {
          setSelectedEntry(entry);
        }
      } catch {
        // 定位失败不影响树展示
      }
    },
    [bridge, revealPath],
  );

  /** 关闭标签；关闭激活标签时激活相邻标签。
   *  confirmDirty=true 时（来自标签栏关闭按钮）若存在未保存草稿，先弹确认，防止误关丢内容；
   *  删除文件等内部路径传 false 直接关闭。 */
  const closeTab = useCallback(
    (path: string, confirmDirty = false) => {
      if (confirmDirty) {
        const tab = tabsRef.current.find((t) => t.path === path);
        const hasDraft = tab !== undefined && tab.draft !== null && tab.preview?.text !== undefined && tab.draft !== tab.preview.text;
        if (hasDraft) {
          setDialog({ type: 'confirm-close-dirty', path, name: baseNameOfPath(tab.path) });
          return;
        }
      }
      const index = tabsRef.current.findIndex((t) => t.path === path);
      const next = tabsRef.current.filter((t) => t.path !== path);
      setTabs(next);
      if (path === activePathRef.current) {
        if (next.length === 0) {
          setActivePath(null);
          setSelectedPath(null);
          setSelectedEntry(null);
        } else {
          const neighbor = next[Math.max(0, index - 1)];
          handleSwitchTab(neighbor.path);
        }
      }
    },
    [handleSwitchTab],
  );

  /** 确认丢弃草稿并关闭标签 */
  const confirmCloseDirty = useCallback(async () => {
    const dialogEntry = dialogRef.current;
    if (dialogEntry && dialogEntry.type === 'confirm-close-dirty') {
      closeTab(dialogEntry.path, false);
    }
    setDialog(null);
  }, [closeTab]);

  /** 刷新：重载上下文、整树，并重载没有未保存草稿的标签（避免丢内容） */
  const refresh = useCallback(() => {
    if (busyRef.current) {
      return;
    }
    setBusy('refresh');
    setBannerError(null);
    void (async () => {
      try {
        const ctx = await bridge.getContext();
        setContext(ctx);
        setRefreshToken((t) => t + 1);
        const paths = tabsRef.current.filter((t) => t.draft === null).map((t) => t.path);
        await Promise.all(paths.map((p) => loadPreview(p)));
      } catch (cause) {
        setBannerError(toBridgeError(cause));
      } finally {
        setBusy(null);
      }
    })();
  }, [bridge, loadPreview]);

  const dirty = activeTab !== null && activeTab.draft !== null && activeTab.preview?.text !== undefined && activeTab.draft !== activeTab.preview.text;
  const canSave =
    activeTab !== null &&
    activeTab.previewState === 'ready' &&
    activeTab.preview !== null &&
    activeTab.preview.editable &&
    activeTab.preview.truncated !== true &&
    dirty &&
    busy === null &&
    dialog === null;

  /** 保存激活标签；版本冲突时打开冲突对话框，草稿原样保留 */
  const save = useCallback(async () => {
    const path = activePathRef.current;
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!path || !tab || !tab.preview || !tab.preview.editable || tab.draft === null || busyRef.current) {
      return;
    }
    setBusy('save');
    setBannerError(null);
    try {
      const result = await bridge.save({
        relativePath: path,
        expectedVersion: tab.preview.version ?? '',
        content: tab.draft,
      });
      updateTab(path, { preview: result, previewState: 'ready', draft: null });
      showToast(`已保存（${result.version}）`);
    } catch (cause) {
      const error = toBridgeError(cause);
      if (error.code === VERSION_CONFLICT) {
        setDialog({ type: 'conflict', error });
      } else {
        setBannerError(error);
      }
    } finally {
      setBusy(null);
    }
  }, [bridge, updateTab, showToast]);

  /** 新建文件 / 新建目录 / 重命名的目标父目录 */
  const currentParentPath = useCallback((): string => {
    const entry = selectedEntryRef.current;
    if (!entry) {
      return '';
    }
    return entry.kind === 'directory' ? entry.relativePath : parentOfPath(entry.relativePath);
  }, []);

  /** 名称类对话框提交（新建 / 重命名） */
  const handleNameSubmit = useCallback(
    async (target: Extract<DialogState, { type: 'name' }>, name: string) => {
      if (target.mode === 'rename') {
        const entry = target.entry;
        if (!entry) {
          return;
        }
        const result = await bridge.rename({ relativePath: entry.relativePath, newName: name });
        setDialog(null);
        setRefreshToken((t) => t + 1);
        setSelectedPath(result.relativePath);
        setSelectedEntry(result);
        // 同步已打开标签的路径并重载；保留未保存草稿，避免重命名丢内容
        setTabs((prev) => prev.map((t) => (t.path === entry.relativePath ? { ...t, path: result.relativePath } : t)));
        if (activePathRef.current === entry.relativePath) {
          setActivePath(result.relativePath);
          await loadPreview(result.relativePath, true);
        }
        showToast(`已重命名为 ${result.name}`);
        return;
      }
      const parent = target.parentPath ?? currentParentPath();
      const kind = target.mode === 'create-file' ? 'file' : 'directory';
      const result = await bridge.create({ parentRelativePath: parent, name, kind });
      setDialog(null);
      setRefreshToken((t) => t + 1);
      setSelectedPath(result.relativePath);
      setSelectedEntry(result);
      showToast(`已创建 ${result.name}`);
      if (kind === 'file') {
        handleSelect(result);
      }
    },
    [bridge, currentParentPath, handleSelect, loadPreview, showToast],
  );

  /** 移动 / 复制对话框提交 */
  const handleMoveCopySubmit = useCallback(
    async (target: Extract<DialogState, { type: 'move-copy' }>, destinationParentRelativePath: string) => {
      const entry = target.entry;
      if (target.mode === 'move') {
        const result = await bridge.move({ relativePath: entry.relativePath, destinationParentRelativePath });
        setDialog(null);
        setRefreshToken((t) => t + 1);
        setSelectedPath(result.relativePath);
        setSelectedEntry(result);
        setTabs((prev) => prev.map((t) => (t.path === entry.relativePath ? { ...t, path: result.relativePath } : t)));
        if (activePathRef.current === entry.relativePath) {
          setActivePath(result.relativePath);
          await loadPreview(result.relativePath, true);
        }
        showToast(`已移动到 ${result.relativePath}`);
        return;
      }
      await bridge.copy({ relativePath: entry.relativePath, destinationParentRelativePath });
      setDialog(null);
      setRefreshToken((t) => t + 1);
      showToast(`已复制到 ${destinationParentRelativePath === '' ? '根目录' : destinationParentRelativePath}`);
    },
    [bridge, loadPreview, showToast],
  );

  /** 删除确认提交；前端只发请求，不承诺回收站语义；删除已打开文件时关闭其标签 */
  const handleDeleteConfirm = useCallback(
    async (entry: WorkspaceEntry) => {
      await bridge.delete({ relativePath: entry.relativePath });
      setDialog(null);
      setRefreshToken((t) => t + 1);
      setSelectedPath(null);
      setSelectedEntry(null);
      showToast(`已删除 ${entry.name}`);
      if (tabsRef.current.some((t) => t.path === entry.relativePath)) {
        closeTab(entry.relativePath);
      }
    },
    [bridge, closeTab, showToast],
  );

  /** 冲突对话框：重新加载（放弃草稿，用户显式选择） */
  const handleConflictReload = useCallback(async () => {
    const path = activePathRef.current;
    if (path) {
      await loadPreview(path);
    }
    setDialog(null);
  }, [loadPreview]);

  /** 冲突对话框：另存为副本（把草稿写入新文件并作为新标签打开） */
  const handleConflictSaveAsCopy = useCallback(async () => {
    const path = activePathRef.current;
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!path || !tab || tab.draft === null) {
      setDialog(null);
      return;
    }
    const parent = parentOfPath(path);
    const list = await bridge.list({ relativePath: parent, showHidden: true, showIgnored: true });
    const name = buildCopyName(baseNameOfPath(path), list.entries.map((e) => e.name));
    const entry = await bridge.create({ parentRelativePath: parent, name, kind: 'file' });
    const fresh = await bridge.preview({ relativePath: entry.relativePath });
    await bridge.save({ relativePath: entry.relativePath, expectedVersion: fresh.version ?? '', content: tab.draft });
    setDialog(null);
    setRefreshToken((t) => t + 1);
    setSelectedPath(entry.relativePath);
    setSelectedEntry(entry);
    showToast(`已保存副本 ${entry.name}`);
    handleSelect(entry);
  }, [bridge, handleSelect, showToast]);

  /** 打开各对话框的入口；新建入口支持指定父目录（右键菜单传入），缺省跟随当前选中项 */
  // 注意：Toolbar 以 onClick={openNewFile} 直接绑定，会把 MouseEvent 当作首个实参传进来，
  // 因此这里只接受 string 类型的父目录，其余一律视为「未指定」。
  const openNewFile = useCallback((parentPath?: string) => {
    const normalized = typeof parentPath === 'string' ? parentPath : undefined;
    setDialog({ type: 'name', mode: 'create-file', parentPath: normalized });
  }, []);
  const openNewDirectory = useCallback((parentPath?: string) => {
    const normalized = typeof parentPath === 'string' ? parentPath : undefined;
    setDialog({ type: 'name', mode: 'create-dir', parentPath: normalized });
  }, []);
  const openRename = () => {
    const entry = selectedEntryRef.current;
    if (entry) {
      setDialog({ type: 'name', mode: 'rename', entry });
    }
  };
  const openMove = () => {
    const entry = selectedEntryRef.current;
    if (entry) {
      setDialog({ type: 'move-copy', mode: 'move', entry });
    }
  };
  const openCopy = () => {
    const entry = selectedEntryRef.current;
    if (entry) {
      setDialog({ type: 'move-copy', mode: 'copy', entry });
    }
  };
  const openDelete = () => {
    const entry = selectedEntryRef.current;
    if (entry) {
      setDialog({ type: 'confirm-delete', entry });
    }
  };

  // 全局快捷键：对话框 / 忙时不响应
  useKeyboardShortcuts({
    onSave: () => {
      void save();
    },
    onRename: openRename,
    onDelete: openDelete,
    enabled: dialog === null && busy === null,
  });

  return (
    <div className="shell">
      <Toolbar
        context={context}
        busy={busy}
        canSave={canSave}
        hasSelection={selectedEntry !== null}
        sidebarCollapsed={sidebarCollapsed}
        onRefresh={refresh}
        onNewFile={openNewFile}
        onNewDirectory={openNewDirectory}
        onRename={openRename}
        onMove={openMove}
        onCopy={openCopy}
        onDelete={openDelete}
        onSave={() => void save()}
        onToggleSidebar={() => setUserCollapsed((v) => (v === null ? !isNarrow : !v))}
        onOpenThemeStudio={onOpenThemeStudio}
      />
      {bannerError ? (
        <div className="banner">
          <ErrorNotice error={bannerError} onDismiss={() => setBannerError(null)} />
        </div>
      ) : null}
      <div className="shell-content">
        <aside className={sidebarCollapsed ? 'sidebar collapsed' : 'sidebar'} aria-label="文件树面板">
          <FileTree
            bridge={bridge}
            selectedPath={selectedPath}
            refreshToken={refreshToken}
            revealRequest={revealRequest}
            onSelect={handleSelect}
            contextMenu={{
              onNewFileIn: (parent) => setDialog({ type: 'name', mode: 'create-file', parentPath: parent }),
              onNewDirectoryIn: (parent) => setDialog({ type: 'name', mode: 'create-dir', parentPath: parent }),
              onRename: (entry) => setDialog({ type: 'name', mode: 'rename', entry }),
              onDelete: (entry) => setDialog({ type: 'confirm-delete', entry }),
              onRefresh: () => {
                void refresh();
              },
            }}
          />
        </aside>
        <main className="main">
          <EditorPane
            tabs={tabs}
            activePath={activeTab?.path ?? null}
            onSwitchTab={handleSwitchTab}
            onNavigatePath={handleNavigatePath}
            onCloseTab={(path) => closeTab(path, true)}
            onDraftChange={(value) => {
              if (activeTab) {
                updateTab(activeTab.path, { draft: value });
              }
            }}
            onRetry={(path) => {
              void loadPreview(path);
            }}
          />
        </main>
      </div>
      <StatusBar
        displayName={context?.displayName ?? null}
        rootValid={context ? context.rootValid : null}
        currentPath={activeTab?.path ?? null}
        dirty={dirty}
        modeLabel={modeLabel}
      />
      {dialog?.type === 'confirm-delete' ? (
        <ConfirmDialog
          title="删除确认"
          message={`确定删除 ${dialog.entry.name}？删除后无法恢复，前端不承诺回收站语义。`}
          confirmText="删除"
          danger
          onConfirm={() => handleDeleteConfirm(dialog.entry)}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.type === 'confirm-close-dirty' ? (
        <ConfirmDialog
          title="关闭未保存的更改"
          message={`${dialog.name} 有未保存的修改，关闭标签将丢弃这些更改。`}
          confirmText="丢弃并关闭"
          danger
          onConfirm={confirmCloseDirty}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.type === 'name' ? (
        <NameDialog
          title={dialog.mode === 'rename' ? '重命名' : dialog.mode === 'create-file' ? '新建文件' : '新建目录'}
          label={dialog.mode === 'rename' ? '新名称' : '名称'}
          initialValue={dialog.mode === 'rename' ? (dialog.entry?.name ?? '') : ''}
          placeholder="名称（不含路径）"
          confirmText={dialog.mode === 'rename' ? '重命名' : '创建'}
          onSubmit={(name) => handleNameSubmit(dialog, name)}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.type === 'move-copy' ? (
        <MoveCopyDialog
          title={dialog.mode === 'move' ? '移动到…' : '复制到…'}
          description={`${dialog.mode === 'move' ? '移动' : '复制'} ${dialog.entry.relativePath} 到目标目录：`}
          initialPath={parentOfPath(dialog.entry.relativePath)}
          confirmText={dialog.mode === 'move' ? '移动' : '复制'}
          onSubmit={(destinationParentRelativePath) => handleMoveCopySubmit(dialog, destinationParentRelativePath)}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.type === 'conflict' ? (
        <ConflictDialog
          error={dialog.error}
          onReload={handleConflictReload}
          onSaveAsCopy={handleConflictSaveAsCopy}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {toast ? (
        <div className="toast" role="status">
          <CheckCircle2 size={14} aria-hidden="true" />
          <span>{toast}</span>
        </div>
      ) : null}
    </div>
  );
}
