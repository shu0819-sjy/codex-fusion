import { Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * 图标按钮：Lucide 图标 + CSS tooltip + disabled / loading 状态。
 * tooltip 通过 data-tooltip 属性由纯 CSS 呈现，不引入额外组件。
 */
export interface IconButtonProps {
  icon: LucideIcon;
  label: string;
  tooltip?: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  danger?: boolean;
  /** 主操作强调样式（如保存按钮） */
  primary?: boolean;
  /** 可选文本标签（工具栏按钮用），为空则仅图标 */
  text?: string;
}

export function IconButton(props: IconButtonProps) {
  const { icon: Icon, label, tooltip, onClick, disabled = false, loading = false, danger = false, primary = false, text } = props;
  return (
    <button
      type="button"
      className={['icon-btn', danger ? 'danger' : '', primary ? 'primary' : '', text ? 'with-text' : ''].filter(Boolean).join(' ')}
      aria-label={label}
      data-tooltip={tooltip ?? label}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {loading ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Icon size={15} aria-hidden="true" />}
      {text ? <span className="icon-btn-text">{text}</span> : null}
    </button>
  );
}
