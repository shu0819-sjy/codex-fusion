import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './IconButton';

/**
 * 通用模态框外壳：遮罩 + 面板 + 标题 + 关闭按钮。
 * 支持 Escape 关闭；点击遮罩不关闭（避免误触丢失输入）。
 */
export interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  /** 底部操作区（按钮组） */
  footer?: ReactNode;
  width?: number;
}

export function Modal(props: ModalProps) {
  const { title, children, onClose, footer, width = 420 } = props;

  // 打开时监听 Escape；同时阻止背景滚动
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div className="modal-overlay" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <IconButton icon={X} label="关闭" tooltip="关闭 (Esc)" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
