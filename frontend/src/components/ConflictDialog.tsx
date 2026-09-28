import { useState } from 'react';
import type { BridgeError } from '../bridge/WorkspaceBridge';
import { toBridgeError } from '../bridge/WorkspaceBridge';
import { ErrorNotice } from './ErrorNotice';
import { Modal } from './Modal';

/**
 * 版本冲突对话框：保存时桥接层返回 VERSION_CONFLICT 后出现。
 * 用户当前未保存文本始终保留在编辑器中，由用户选择：
 * - 重新加载：放弃本地草稿，加载桥接层最新内容；
 * - 另存为副本：把草稿写入新建副本文件并打开。
 */
export interface ConflictDialogProps {
  error: BridgeError;
  onReload: () => Promise<void>;
  onSaveAsCopy: () => Promise<void>;
  onClose: () => void;
}

export function ConflictDialog(props: ConflictDialogProps) {
  const { error, onReload, onSaveAsCopy, onClose } = props;
  const [busy, setBusy] = useState<'reload' | 'copy' | null>(null);
  const [actionError, setActionError] = useState<BridgeError | null>(null);

  const run = async (action: 'reload' | 'copy', handler: () => Promise<void>) => {
    if (busy) {
      return;
    }
    setBusy(action);
    setActionError(null);
    try {
      await handler();
    } catch (cause) {
      setActionError(toBridgeError(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title="版本冲突"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={busy !== null} onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => run('reload', onReload)}>
            {busy === 'reload' ? '处理中…' : '重新加载'}
          </button>
          <button type="button" className="btn primary" disabled={busy !== null} onClick={() => run('copy', onSaveAsCopy)}>
            {busy === 'copy' ? '处理中…' : '另存为副本'}
          </button>
        </>
      }
    >
      <p className="confirm-message">你的未保存修改仍保留在编辑器中，不会被静默覆盖。</p>
      <div className="conflict-error">
        <ErrorNotice error={error} />
      </div>
      <ul className="conflict-options">
        <li>
          <strong>重新加载</strong>：放弃本地草稿，加载桥接层的最新版本。
        </li>
        <li>
          <strong>另存为副本</strong>：把当前草稿保存为带 -copy 后缀的新文件。
        </li>
      </ul>
      {actionError ? <ErrorNotice error={actionError} /> : null}
    </Modal>
  );
}
