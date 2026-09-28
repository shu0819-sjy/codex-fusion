import { describe, expect, it, afterEach } from 'vitest';
import { createBridge } from '../bridge/createBridge';
import { NativeWorkspaceBridge } from '../bridge/NativeWorkspaceBridge';

/** 功能：清理宿主注入点；入参：无；返回值：无；避免测试之间共享全局 transport。 */
function clearHostTransport(): void {
  delete window.__codexFusionBridge__;
  delete window.__codexFusionTransport__;
}

describe('原生桥接注入', () => {
  afterEach(() => {
    clearHostTransport();
  });

  it('通过宿主 transport 发送类型化 JSONL 请求并返回结果', async () => {
    const requests: string[] = [];
    window.__codexFusionTransport__ = async (request) => {
      requests.push(request.method);
      return {
        id: request.id,
        ok: true,
        result: { displayName: 'Native workspace', rootValid: true },
      };
    };

    const bridge = createBridge();
    expect(bridge).toBeInstanceOf(NativeWorkspaceBridge);
    await expect(bridge.getContext()).resolves.toEqual({ displayName: 'Native workspace', rootValid: true });
    expect(requests).toEqual(['workspace.context']);
  });

  it('保留宿主返回的错误码和消息', async () => {
    const bridge = new NativeWorkspaceBridge(async (request) => ({
      id: request.id,
      ok: false,
      error: { code: 'ACCESS_DENIED', message: '拒绝访问' },
    }));

    await expect(bridge.list({})).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      message: '拒绝访问',
    });
  });
});
