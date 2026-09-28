/**
 * 本地桥接协议与 WorkspaceBridge 接口定义。
 *
 * 协议形状：每次调用对应一条 JSONL 请求（BridgeRequest → BridgeResponse）。
 * 前端只传递相对路径，绝不拼接或展示工作区外的绝对文件路径。
 */

/** 工作区条目类型 */
export type WorkspaceEntryKind = 'file' | 'directory' | 'symlink';

/** 文件树 / 操作结果中的条目 */
export interface WorkspaceEntry {
  /** 稳定标识，用于 React key 与条目追踪（重命名、移动后保持不变） */
  id: string;
  /** 显示名称（不含路径） */
  name: string;
  /** 相对工作区根目录的路径，使用 '/' 分隔 */
  relativePath: string;
  kind: WorkspaceEntryKind;
  /** 无权限访问（桥接层标记，前端据此禁用操作并展示提示） */
  inaccessible: boolean;
}

/** workspace.context 的成功结果 */
export interface WorkspaceContext {
  /** 工作区显示名（由桥接层提供，可能是受限工作区的别名） */
  displayName: string;
  /** 工作区根目录是否有效可访问 */
  rootValid: boolean;
}

/** workspace.list 的参数 */
export interface ListParams {
  relativePath?: string;
  cursor?: string;
  limit?: number;
  showHidden?: boolean;
  showIgnored?: boolean;
}

/** workspace.list 的成功结果 */
export interface ListResult {
  entries: WorkspaceEntry[];
  nextCursor?: string;
  /** 是否因达到 limit 而截断（存在更多条目，需用 nextCursor 继续拉取） */
  truncated: boolean;
}

/** 预览内容类型：text=文本；image=图片（桥接层提供可渲染地址）；binary=其他二进制；symlink=符号链接；directory=目录 */
export type PreviewKind = 'text' | 'image' | 'binary' | 'symlink' | 'directory';

/** workspace.preview 的成功结果 */
export interface PreviewResult {
  /** 是否允许编辑（只读、二进制、截断、符号链接均为 false） */
  editable: boolean;
  kind: PreviewKind;
  /** 文本内容；二进制等场景不返回，前端绝不把二进制渲染进编辑器 */
  text?: string;
  /** 内容被截断（文件过大）时为 true，此时不可编辑 */
  truncated?: boolean;
  /** 乐观并发版本号；仅在可编辑文本上存在 */
  version?: string;
  /** 文件字节大小 */
  sizeBytes: number;
  /** 图片可渲染地址（kind === 'image' 时由桥接层提供，data URL 或受限资源 URL） */
  imageUrl?: string;
  /** 图片像素宽度（可选，用于布局展示） */
  imageWidth?: number;
  /** 图片像素高度（可选，用于布局展示） */
  imageHeight?: number;
}

/** workspace.save 的成功结果（含新版本号的预览结果） */
export interface SaveResult extends PreviewResult {
  version: string;
}

/** workspace.create 的参数 */
export interface CreateParams {
  parentRelativePath: string;
  name: string;
  kind: 'file' | 'directory';
}

/** workspace.rename 的参数 */
export interface RenameParams {
  relativePath: string;
  newName: string;
}

/** workspace.move 的参数 */
export interface MoveParams {
  relativePath: string;
  destinationParentRelativePath: string;
}

/** workspace.copy 的参数 */
export interface CopyParams {
  relativePath: string;
  destinationParentRelativePath: string;
}

/** workspace.delete 的参数 */
export interface DeleteParams {
  relativePath: string;
}

/** 桥接层错误 */
export interface BridgeError {
  code: string;
  message: string;
}

/** 一条 JSONL 请求 */
export interface BridgeRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** 一条 JSONL 响应 */
export interface BridgeResponse<T = unknown> {
  id: string;
  ok: boolean;
  result?: T;
  error?: BridgeError;
}

/** 版本冲突错误码：保存时 expectedVersion 与桥接层当前版本不一致 */
export const VERSION_CONFLICT = 'VERSION_CONFLICT';

/** 未接入原生宿主时的错误码 */
export const NOT_CONNECTED = 'NOT_CONNECTED';

/**
 * 桥接层错误对象。UI 统一展示 code 与 message，不猜测失败原因。
 */
export class BridgeOperationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BridgeOperationError';
    this.code = code;
  }
}

/**
 * 把任意捕获值归一化为 BridgeOperationError。
 * 已知桥接错误原样返回；未知错误统一编码为 UNKNOWN。
 */
export function toBridgeError(cause: unknown): BridgeOperationError {
  if (cause instanceof BridgeOperationError) {
    return cause;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new BridgeOperationError('UNKNOWN', message);
}

/**
 * WorkspaceBridge：前端唯一的取数 / 写入口。
 * 开发环境使用 MockWorkspaceBridge，生产环境预留 NativeWorkspaceBridge（宿主注入）。
 */
export interface WorkspaceBridge {
  /** 桥接层名称，用于调试与状态栏展示 */
  readonly name: string;
  getContext(): Promise<WorkspaceContext>;
  list(params: ListParams): Promise<ListResult>;
  preview(params: { relativePath: string }): Promise<PreviewResult>;
  save(params: { relativePath: string; expectedVersion: string; content: string }): Promise<SaveResult>;
  create(params: CreateParams): Promise<WorkspaceEntry>;
  rename(params: RenameParams): Promise<WorkspaceEntry>;
  move(params: MoveParams): Promise<WorkspaceEntry>;
  copy(params: CopyParams): Promise<WorkspaceEntry>;
  delete(params: DeleteParams): Promise<null>;
}
