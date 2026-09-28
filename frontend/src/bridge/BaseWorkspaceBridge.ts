import type {
  BridgeRequest,
  BridgeResponse,
  BridgeError,
  ListParams,
  ListResult,
  PreviewResult,
  SaveResult,
  CreateParams,
  RenameParams,
  MoveParams,
  CopyParams,
  DeleteParams,
  WorkspaceContext,
  WorkspaceEntry,
  WorkspaceBridge,
} from './WorkspaceBridge';
import { BridgeOperationError } from './WorkspaceBridge';

/**
 * 桥接层基类：把类型化方法调用统一转换为 JSONL 形状的 BridgeRequest，
 * 经 send() 发出后解包 BridgeResponse，失败时抛出 BridgeOperationError。
 *
 * 子类只需实现 send()：
 * - MockWorkspaceBridge：内存中的假工作区；
 * - NativeWorkspaceBridge：把请求交给宿主注入的 transport。
 */
export abstract class BaseWorkspaceBridge implements WorkspaceBridge {
  abstract readonly name: string;

  /** 请求自增序号，保证 id 唯一 */
  private requestSeq = 0;

  /**
   * 生成一条请求 id。本地进程内使用足够唯一；不依赖随机数以免影响测试确定性。
   */
  protected buildRequestId(): string {
    this.requestSeq += 1;
    return `req-${Date.now().toString(36)}-${this.requestSeq}`;
  }

  /**
   * 发出请求并解包响应。
   * 子类实现具体传输（mock 内存路由 / 宿主 transport）。
   */
  protected abstract send(request: BridgeRequest): Promise<BridgeResponse<unknown>>;

  /**
   * 发送请求、检查 ok 标志，失败时抛出携带桥接层 code/message 的错误。
   */
  protected async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    const request: BridgeRequest = {
      id: this.buildRequestId(),
      method,
      params,
    };
    const response = await this.send(request);
    if (!response.ok) {
      const error: BridgeError = response.error ?? {
        code: 'UNKNOWN',
        message: '桥接层返回了未知错误',
      };
      throw new BridgeOperationError(error.code, error.message);
    }
    return response.result;
  }

  async getContext(): Promise<WorkspaceContext> {
    return (await this.dispatch('workspace.context', {})) as WorkspaceContext;
  }

  async list(params: ListParams): Promise<ListResult> {
    return (await this.dispatch('workspace.list', { ...params })) as ListResult;
  }

  async preview(params: { relativePath: string }): Promise<PreviewResult> {
    return (await this.dispatch('workspace.preview', { ...params })) as PreviewResult;
  }

  async save(params: { relativePath: string; expectedVersion: string; content: string }): Promise<SaveResult> {
    return (await this.dispatch('workspace.save', { ...params })) as SaveResult;
  }

  async create(params: CreateParams): Promise<WorkspaceEntry> {
    return (await this.dispatch('workspace.create', { ...params })) as WorkspaceEntry;
  }

  async rename(params: RenameParams): Promise<WorkspaceEntry> {
    return (await this.dispatch('workspace.rename', { ...params })) as WorkspaceEntry;
  }

  async move(params: MoveParams): Promise<WorkspaceEntry> {
    return (await this.dispatch('workspace.move', { ...params })) as WorkspaceEntry;
  }

  async copy(params: CopyParams): Promise<WorkspaceEntry> {
    return (await this.dispatch('workspace.copy', { ...params })) as WorkspaceEntry;
  }

  async delete(params: DeleteParams): Promise<null> {
    return (await this.dispatch('workspace.delete', { ...params })) as null;
  }
}
