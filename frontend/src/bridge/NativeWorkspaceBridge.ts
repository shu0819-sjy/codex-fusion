import type { BridgeRequest, BridgeResponse } from './WorkspaceBridge';
import { BaseWorkspaceBridge } from './BaseWorkspaceBridge';
import { NOT_CONNECTED } from './WorkspaceBridge';

/**
 * 宿主传输通道：接收一条 JSONL 形状的请求，返回解析后的响应。
 * 由原生宿主（Rust / PowerShell 包装层）注入；前端不实现任何进程管理。
 */
export type BridgeTransport = (request: BridgeRequest) => Promise<BridgeResponse<unknown>>;

/**
 * NativeWorkspaceBridge：生产环境原生宿主的接入点（适配层）。
 *
 * 仅定义"如何把类型化调用变成 JSONL 请求交给宿主"，不实现 Rust 进程管理、
 * 不连接 CDP、不读取用户文件路径。
 *
 * 边界情况：
 * - 未注入 transport 时，所有调用返回 NOT_CONNECTED 错误，界面如实展示；
 * - 宿主可通过 window.__codexFusionBridge__ 注入完整实例，或通过 window.__codexFusionTransport__ 注入传输层。
 */
export class NativeWorkspaceBridge extends BaseWorkspaceBridge {
  readonly name = 'native';

  private readonly transport: BridgeTransport | null;

  constructor(transport?: BridgeTransport) {
    super();
    this.transport = transport ?? null;
  }

  /** 实现 BaseWorkspaceBridge.send：把请求交给宿主 transport */
  protected async send(request: BridgeRequest): Promise<BridgeResponse<unknown>> {
    if (!this.transport) {
      return {
        id: request.id,
        ok: false,
        error: {
          code: NOT_CONNECTED,
          message: '原生宿主桥接尚未接入：未注入 BridgeTransport，也未提供 window.__codexFusionBridge__。',
        },
      };
    }
    return this.transport(request);
  }
}
