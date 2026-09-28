import { AlertCircle, Copy } from 'lucide-react';
import { useState } from 'react';
import type { BridgeError } from '../bridge/WorkspaceBridge';

/**
 * 错误提示条：如实展示桥接层返回的 error.code 与 error.message，不猜测原因。
 * onDismiss 为空时不可关闭（用于对话框内的错误）。
 * 可选 actions / 复制，供主题页与工作区统一可恢复反馈（V2）。
 */
export interface ErrorNoticeAction {
  label: string;
  onClick: () => void;
}

export interface ErrorNoticeProps {
  error: BridgeError;
  onDismiss?: () => void;
  /** 额外恢复操作（重试 / 重新检测等） */
  actions?: ErrorNoticeAction[];
  /** 是否显示「复制错误」按钮；默认 true */
  copyable?: boolean;
}

export function ErrorNotice(props: ErrorNoticeProps) {
  const { error, onDismiss, actions, copyable = true } = props;
  const [copied, setCopied] = useState(false);

  /** 把错误码与消息复制到剪贴板，便于上报。 */
  const handleCopy = async () => {
    const text = `${error.code}: ${error.message}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', 'true');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="error-notice" role="alert">
      <AlertCircle size={14} aria-hidden="true" />
      <span className="error-code">{error.code}</span>
      <span className="error-message">{error.message}</span>
      <span className="error-actions">
        {actions?.map((action) => (
          <button key={action.label} type="button" className="error-action" onClick={action.onClick}>
            {action.label}
          </button>
        ))}
        {copyable ? (
          <button type="button" className="error-action" onClick={() => void handleCopy()} aria-label="复制错误信息">
            <Copy size={12} aria-hidden="true" /> {copied ? '已复制' : '复制'}
          </button>
        ) : null}
        {onDismiss ? (
          <button type="button" className="error-dismiss" aria-label="关闭错误提示" onClick={onDismiss}>
            ×
          </button>
        ) : null}
      </span>
    </div>
  );
}
