import { useDialogSubmit } from '../hooks/useDialogSubmit';
import { ErrorNotice } from './ErrorNotice';
import { Modal } from './Modal';

/**
 * 通用确认对话框（删除等破坏性操作）。
 * 确认按钮带 loading 与错误展示；错误来自桥接层（如 NOT_EMPTY），原样显示。
 */
export interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmText: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const { title, message, confirmText, danger = false, onConfirm, onClose } = props;
  const { busy, error, run } = useDialogSubmit(onConfirm);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} autoFocus onClick={onClose}>
            取消
          </button>
          <button type="button" className={danger ? 'btn danger' : 'btn primary'} disabled={busy} onClick={run}>
            {busy ? '处理中…' : confirmText}
          </button>
        </>
      }
    >
      <p className="confirm-message">{message}</p>
      {error ? <ErrorNotice error={error} /> : null}
    </Modal>
  );
}
