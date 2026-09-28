import { useEffect } from 'react';

/** 快捷键配置 */
export interface KeyboardShortcutHandlers {
  /** Ctrl+S 保存 */
  onSave: () => void;
  /** F2 重命名当前选中项 */
  onRename: () => void;
  /** Delete 删除当前选中项（触发确认） */
  onDelete: () => void;
  /** 是否启用快捷键（对话框打开 / 忙时禁用） */
  enabled: boolean;
}

/** 判断事件目标是否处于文本输入状态（输入框 / 文本域 / 可编辑元素） */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

/**
 * 全局快捷键 hook：
 * - Ctrl+S 允许在文本输入时触发保存（浏览器默认保存页面对话框被阻止）；
 * - F2 / Delete 仅在非输入状态下生效，避免误操作编辑中的文本。
 */
export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers) {
  const { onSave, onRename, onDelete, enabled } = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!enabled) {
        return;
      }
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 's') {
        event.preventDefault();
        onSave();
        return;
      }
      if (isTypingTarget(event.target)) {
        return;
      }
      if (key === 'f2') {
        event.preventDefault();
        onRename();
      } else if (key === 'delete') {
        event.preventDefault();
        onDelete();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled, onSave, onRename, onDelete]);
}
