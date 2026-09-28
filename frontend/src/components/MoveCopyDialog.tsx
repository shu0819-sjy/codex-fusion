import { useState } from 'react';
import { useDialogSubmit } from '../hooks/useDialogSubmit';
import { ErrorNotice } from './ErrorNotice';
import { Modal } from './Modal';
import { isRelativePath } from '../utils/path';

/**
 * 移动 / 复制目标目录对话框。
 * 目标必须是相对路径（空字符串表示工作区根目录）；
 * 非法绝对路径类输入在提交前被拦截并提示，其余错误由桥接层原样展示。
 */
export interface MoveCopyDialogProps {
  title: string;
  /** 操作说明（如"移动 src/app.ts 到"） */
  description: string;
  /** 目标目录初始值（当前父目录） */
  initialPath: string;
  confirmText: string;
  onSubmit: (destinationParentRelativePath: string) => Promise<void>;
  onClose: () => void;
}

export function MoveCopyDialog(props: MoveCopyDialogProps) {
  const { title, description, initialPath, confirmText, onSubmit, onClose } = props;
  const [value, setValue] = useState(initialPath);
  const [pathError, setPathError] = useState<string | null>(null);
  const { busy, error, run } = useDialogSubmit(() => onSubmit(value.trim()));

  const handleConfirm = () => {
    const trimmed = value.trim();
    if (!isRelativePath(trimmed)) {
      setPathError('请输入相对路径（不允许盘符、\\ 或 / 开头的绝对路径）');
      return;
    }
    setPathError(null);
    run();
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={handleConfirm}>
            {busy ? '处理中…' : confirmText}
          </button>
        </>
      }
    >
      <p className="field-label">{description}</p>
      <input
        className="text-input"
        type="text"
        value={value}
        placeholder="留空表示工作区根目录"
        autoFocus
        onChange={(event) => {
          setValue(event.target.value);
          setPathError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            handleConfirm();
          }
        }}
      />
      {pathError ? (
        <div className="inline-error" role="alert">
          {pathError}
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
    </Modal>
  );
}
