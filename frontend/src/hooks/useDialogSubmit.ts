import { useState } from 'react';
import type { BridgeError } from '../bridge/WorkspaceBridge';
import { toBridgeError } from '../bridge/WorkspaceBridge';

/**
 * 对话框提交流程 hook：管理 busy / error 状态。
 * onSubmit 抛错时错误显示在对话框内并保持打开；成功后由调用方关闭对话框。
 */
export function useDialogSubmit(onSubmit: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<BridgeError | null>(null);

  const run = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (cause) {
      setError(toBridgeError(cause));
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, run };
}
