import { useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useDialogSubmit } from '../hooks/useDialogSubmit';
import { ErrorNotice } from './ErrorNotice';
import { Modal } from './Modal';

/**
 * 名称输入对话框：新建文件 / 新建目录 / 重命名共用。
 * 名称校验（非空、不含路径分隔符）由桥接层返回 INVALID_NAME 错误并原样展示。
 */
export interface NameDialogProps {
  title: string;
  /** 输入框标签文案 */
  label: string;
  /** 初始值（重命名时为当前名称） */
  initialValue: string;
  /** 输入提示 */
  placeholder: string;
  confirmText: string;
  /** 提交回调；抛错时错误显示在对话框内 */
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}

export function NameDialog(props: NameDialogProps) {
  const { title, label, initialValue, placeholder, confirmText, onSubmit, onClose } = props;
  const [value, setValue] = useState(initialValue);
  const { busy, error, run } = useDialogSubmit(() => onSubmit(value.trim()));

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Enter' && value.trim().length > 0) {
      run();
    }
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
          <button type="button" className="btn primary" disabled={busy || value.trim().length === 0} onClick={run}>
            {busy ? '处理中…' : confirmText}
          </button>
        </>
      }
    >
      <label className="field-label" htmlFor="name-input">
        {label}
      </label>
      <input
        id="name-input"
        className="text-input"
        type="text"
        value={value}
        placeholder={placeholder}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      {error ? <ErrorNotice error={error} /> : null}
    </Modal>
  );
}
