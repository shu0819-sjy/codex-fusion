/**
 * 底部状态栏：工作区显示名 / 有效性 + 当前文件路径与未保存标记。
 * 只展示桥接层提供的相对路径与状态，不展示任何绝对路径。
 * 可选只读模式指示（U6），不新增宿主 API。
 */
export interface StatusBarProps {
  displayName: string | null;
  rootValid: boolean | null;
  currentPath: string | null;
  dirty: boolean;
  /** 当前运行模式显示名；未提供时不展示 */
  modeLabel?: string | null;
}

export function StatusBar(props: StatusBarProps) {
  const { displayName, rootValid, currentPath, dirty, modeLabel } = props;
  return (
    <div className="status-bar">
      <span className="status-item status-workspace" title={displayName ?? ''}>
        {displayName ?? '未连接工作区'}
        {rootValid !== null ? (
          <span className={rootValid ? 'status-dot ok' : 'status-dot bad'} title={rootValid ? '工作区有效' : '工作区无效'} />
        ) : null}
      </span>
      {modeLabel ? (
        <span className="status-item status-mode" title="当前运行模式（只读）">
          {modeLabel}
        </span>
      ) : null}
      <span className="status-spacer" />
      {currentPath ? (
        <span className="status-item status-path" title={currentPath}>
          {currentPath}
        </span>
      ) : (
        <span className="status-item status-dim">未打开文件</span>
      )}
      {dirty ? <span className="status-item status-dirty">● 未保存的更改</span> : null}
    </div>
  );
}
