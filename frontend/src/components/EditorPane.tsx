import { useState } from 'react';
import { AlertTriangle, ChevronRight, FileText, FileWarning, FolderOpen, Link2, Loader2, Maximize, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { EditorTab } from './WorkspaceShell';
import { ErrorNotice } from './ErrorNotice';
import { formatBytes } from '../utils/format';
import { baseNameOfPath } from '../utils/path';
import { fileIconClass } from '../utils/fileIcons';

/**
 * 编辑区（多标签页）：标签栏 + 激活标签内容区。
 * - 标签栏：类型色图标 + 名称 + 未保存呼吸点 + 关闭按钮；支持 ←/→ 键盘切换；
 * - 面包屑：当前文件路径分段，点击目录段可在树中定位（导航结构与层级跳转）；
 * - 图片：棋盘格画布 + 缩放控件，加载失败时显示容错占位与重试；
 * - 只读 / 符号链接 / 截断文件只读展示；二进制文件只显示紧凑状态卡。
 */
export interface EditorPaneProps {
  tabs: EditorTab[];
  /** 激活标签路径；无匹配时回退到第一个标签 */
  activePath: string | null;
  onSwitchTab: (path: string) => void;
  /** 面包屑目录段跳转（在树中定位目录） */
  onNavigatePath: (relativePath: string) => void;
  onCloseTab: (path: string) => void;
  onDraftChange: (value: string) => void;
  /** 重试加载指定标签 */
  onRetry: (path: string) => void;
}

/** 判断标签是否有未保存修改（草稿存在且与预览内容不一致） */
function isDirty(tab: EditorTab): boolean {
  return tab.draft !== null && tab.preview?.text !== undefined && tab.draft !== tab.preview.text;
}

/** 缩放值收敛到 [0.25, 4] */
function clampZoom(value: number): number {
  return Math.min(4, Math.max(0.25, value));
}

/**
 * 图片查看器：棋盘格画布 + 缩放控件（缩小 / 放大 / 重置）+ 加载失败容错。
 * 用 key 绑定到标签路径，切换标签时缩放与错误状态自动复位。
 */
function ImageViewer(props: { url: string; alt: string }) {
  const { url, alt } = props;
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="editor-image-view">
        <div className="editor-image-error" role="alert">
          <FileWarning size={18} aria-hidden="true" />
          <span>图片加载失败，桥接层提供的地址不可用</span>
          <button type="button" className="btn" onClick={() => setFailed(false)}>
            重试
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-image-view">
      <div className="editor-image-controls" role="group" aria-label="图片缩放">
        <button type="button" className="icon-btn" aria-label="缩小图片" title="缩小" disabled={zoom <= 0.25} onClick={() => setZoom((z) => clampZoom(Math.round((z / 1.25) * 100) / 100))}>
          <ZoomOut size={14} aria-hidden="true" />
        </button>
        <button type="button" className="icon-btn" aria-label="放大图片" title="放大" disabled={zoom >= 4} onClick={() => setZoom((z) => clampZoom(Math.round(z * 1.25 * 100) / 100))}>
          <ZoomIn size={14} aria-hidden="true" />
        </button>
        <button type="button" className="icon-btn" aria-label="重置缩放" title="重置为适应画布" disabled={zoom === 1} onClick={() => setZoom(1)}>
          <Maximize size={14} aria-hidden="true" />
        </button>
        <span className="editor-image-zoom" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
      </div>
      <img
        key={url}
        className="editor-image"
        src={url}
        alt={alt}
        style={{ transform: `scale(${zoom})` }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

export function EditorPane(props: EditorPaneProps) {
  const { tabs, activePath, onSwitchTab, onNavigatePath, onCloseTab, onDraftChange, onRetry } = props;

  if (tabs.length === 0) {
    return (
      <div className="editor-pane empty">
        <div className="empty-badge" aria-hidden="true">
          <FolderOpen size={28} strokeWidth={1.3} />
          <span className="empty-badge-file">
            <FileText size={16} strokeWidth={1.6} />
          </span>
        </div>
        <p className="empty-title">Codex Fusion 工作区</p>
        <p className="empty-hint">从左侧文件树选择一个文件开始</p>
      </div>
    );
  }

  const activeTab: EditorTab = tabs.find((t) => t.path === activePath) ?? tabs[0];
  const preview = activeTab.preview;
  const segments = activeTab.path.split('/').filter((s) => s.length > 0);

  return (
    <div className="editor-pane">
      <div className="editor-tabs" role="tablist" aria-label="打开的标签页">
        {tabs.map((tab) => {
          const name = baseNameOfPath(tab.path);
          const isActive = tab.path === activeTab.path;
          const index = tabs.findIndex((t) => t.path === tab.path);
          const tabDirty = isDirty(tab);
          return (
            <div
              key={tab.path}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className={isActive ? 'editor-tab active' : 'editor-tab'}
              title={tab.path}
              onClick={() => onSwitchTab(tab.path)}
              onKeyDown={(event) => {
                // ←/→ 在标签间循环切换（可访问性规范：tablist 键盘导航）
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  const delta = event.key === 'ArrowRight' ? 1 : -1;
                  const next = tabs[(index + delta + tabs.length) % tabs.length];
                  if (next) {
                    onSwitchTab(next.path);
                  }
                }
              }}
            >
              {tab.previewState === 'loading' ? (
                <Loader2 size={13} className="spin" aria-hidden="true" />
              ) : (
                <span className={`tree-file-icon ${fileIconClass(name)}`}>
                  <FileText size={13} aria-hidden="true" />
                </span>
              )}
              <span className="editor-tab-name">{name}</span>
              {tabDirty ? <span className="editor-tab-dirty" title="未保存的更改" /> : null}
              <button
                type="button"
                className="editor-tab-close"
                aria-label={`关闭 ${name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.path);
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      {activeTab.previewState === 'loading' ? (
        <div className="editor-pane center">
          <Loader2 size={16} className="spin" aria-hidden="true" />
          <span>正在加载…</span>
        </div>
      ) : null}
      {activeTab.previewState === 'error' || !preview ? (
        <div className="editor-pane center">
          <div className="editor-error">
            {activeTab.previewError ? <ErrorNotice error={activeTab.previewError} /> : null}
            <button type="button" className="btn" onClick={() => onRetry(activeTab.path)}>
              重试
            </button>
          </div>
        </div>
      ) : null}
      {activeTab.previewState === 'ready' && preview ? (
        <>
          {preview.kind === 'binary' || preview.kind === 'symlink' || preview.truncated === true ? (
            <div className="editor-status-row">
              {preview.kind === 'binary' ? (
                <>
                  <FileWarning size={14} aria-hidden="true" />
                  <span>二进制文件（{formatBytes(preview.sizeBytes)}），无法预览或编辑</span>
                </>
              ) : null}
              {preview.kind === 'symlink' ? (
                <>
                  <Link2 size={14} aria-hidden="true" />
                  <span>符号链接，按目标内容只读展示</span>
                </>
              ) : null}
              {preview.truncated === true ? (
                <>
                  <AlertTriangle size={14} aria-hidden="true" />
                  <span>
                    文件过大（{formatBytes(preview.sizeBytes)}），已截断显示，不可编辑
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
          {preview.kind === 'image' && preview.imageUrl ? (
            <ImageViewer key={activeTab.path} url={preview.imageUrl} alt={activeTab.path} />
          ) : null}
          {preview.kind === 'binary' ? <div className="editor-binary-placeholder" /> : null}
          {preview.kind !== 'image' && preview.kind !== 'binary' && preview.editable && preview.truncated !== true ? (
            <textarea
              className="editor-textarea"
              aria-label="文本编辑器"
              value={activeTab.draft ?? preview.text ?? ''}
              spellCheck={false}
              onChange={(event) => onDraftChange(event.target.value)}
            />
          ) : null}
          {preview.kind !== 'image' && preview.kind !== 'binary' && !(preview.editable && preview.truncated !== true) ? (
            <pre className="editor-pre" aria-label="只读预览">
              {preview.text ?? ''}
            </pre>
          ) : null}
          <div className="editor-meta">
            <span className="editor-breadcrumb" aria-label="文件路径">
              {segments.map((seg, i) => {
                const prefix = segments.slice(0, i + 1).join('/');
                const isLast = i === segments.length - 1;
                return (
                  <span key={prefix} className="editor-breadcrumb-seg">
                    {i > 0 ? <ChevronRight size={11} className="crumb-sep" aria-hidden="true" /> : null}
                    {isLast ? (
                      <span className="crumb-current" title={activeTab.path}>
                        {seg}
                      </span>
                    ) : (
                      <button type="button" className="crumb-link" title={prefix} onClick={() => onNavigatePath(prefix)}>
                        {seg}
                      </button>
                    )}
                  </span>
                );
              })}
            </span>
            {preview.imageWidth !== undefined && preview.imageHeight !== undefined ? (
              <span className="meta-item">
                {preview.imageWidth} × {preview.imageHeight} px
              </span>
            ) : null}
            <span className="meta-item">{formatBytes(preview.sizeBytes)}</span>
            {preview.version ? <span className="meta-item">v{preview.version.slice(1)}</span> : null}
            {preview.kind === 'image' ? <span className="meta-item meta-badge">图片</span> : null}
            {!preview.editable && preview.kind !== 'image' ? <span className="meta-item meta-badge">只读</span> : null}
            {isDirty(activeTab) ? <span className="meta-item meta-dirty">未保存的更改</span> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
