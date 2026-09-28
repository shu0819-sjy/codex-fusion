import type { WorkspaceBridge } from './WorkspaceBridge';
import { MockWorkspaceBridge } from './MockWorkspaceBridge';
import { NativeWorkspaceBridge } from './NativeWorkspaceBridge';

/**
 * 桥接层工厂：按优先级选择实现。
 *
 * 优先级：
 * 1. 宿主注入的 window.__codexFusionBridge__（生产环境嵌入式容器的接入点）；
 * 2. 宿主注入的 window.__codexFusionTransport__（NativeWorkspaceBridge 适配 JSONL 通道）；
 * 3. VITE_BRIDGE=native 时使用 NativeWorkspaceBridge（未注入 transport 则返回 NOT_CONNECTED）；
 * 4. 默认使用 MockWorkspaceBridge（本地开发与测试）。
 */
export function createBridge(): WorkspaceBridge {
  const hostBridge = window.__codexFusionBridge__;
  if (hostBridge) {
    return hostBridge;
  }
  const hostTransport = window.__codexFusionTransport__;
  if (hostTransport) {
    return new NativeWorkspaceBridge(hostTransport);
  }
  if (import.meta.env.VITE_BRIDGE === 'native') {
    return new NativeWorkspaceBridge();
  }
  return new MockWorkspaceBridge();
}
