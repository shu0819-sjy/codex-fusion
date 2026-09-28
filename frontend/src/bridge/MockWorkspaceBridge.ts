import type {
  BridgeRequest,
  BridgeResponse,
  BridgeError,
  ListResult,
  PreviewResult,
  SaveResult,
  WorkspaceContext,
  WorkspaceEntry,
  WorkspaceEntryKind,
} from './WorkspaceBridge';
import { BaseWorkspaceBridge } from './BaseWorkspaceBridge';

/** mock 配置：latencyMs 模拟真实桥接延迟（测试传 0 加速） */
export interface MockWorkspaceBridgeOptions {
  latencyMs?: number;
}

/** 内存中的工作区节点 */
interface MockNode {
  id: string;
  name: string;
  relativePath: string;
  kind: WorkspaceEntryKind;
  content: string | null;
  binary: boolean;
  readonly: boolean;
  inaccessible: boolean;
  hidden: boolean;
  ignored: boolean;
  sizeBytes: number;
  version: string | null;
  children: MockNode[];
  parent: MockNode | null;
  /** 图片可渲染地址（data URL 或受限资源 URL） */
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
}

/** 大文件截断阈值（字节），超过后仅返回前 TRUNCATE_PREVIEW_CHARS 个字符 */
const TRUNCATE_BYTES = 256 * 1024;
/** 截断预览返回的字符数 */
const TRUNCATE_PREVIEW_CHARS = 2000;

/** 延迟工具：等待指定毫秒数 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 相对路径拼接：parent 为空表示根目录 */
function joinPath(parent: string, name: string): string {
  return parent.length === 0 ? name : `${parent}/${name}`;
}

/** 取父目录相对路径：'a/b.txt' → 'a'；'a.txt' → '' */
function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/** 版本号自增：'v1' → 'v2' */
function nextVersion(version: string): string {
  const number = Number.parseInt(version.slice(1), 10);
  return `v${Number.isNaN(number) ? 1 : number + 1}`;
}

/** 计算文本字节数（UTF-8） */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 校验名称是否合法（单个名称，不含路径分隔符） */
function validateName(name: string): string | null {
  if (name.length === 0) {
    return '名称不能为空';
  }
  if (name.includes('/') || name.includes('\\')) {
    return '名称不能包含路径分隔符（/ 或 \\）';
  }
  if (name === '.' || name === '..') {
    return '名称不能是 . 或 ..';
  }
  if (/^[A-Za-z]:/.test(name)) {
    return '名称不能包含盘符';
  }
  return null;
}

/**
 * MockWorkspaceBridge：本地开发 / 测试用的内存假工作区。
 *
 * 行为边界：
 * - 数据只存在于内存，刷新页面即还原；
 * - 模拟 80ms 默认延迟（可用 latencyMs 覆盖）；
 * - 保存携带 expectedVersion，外部修改（simulateExternalSave）后保存会返回 VERSION_CONFLICT；
 * - 二进制文件不返回文本；超过 TRUNCATE_BYTES 的文件只返回截断预览且不可编辑；
 * - 无权限条目返回 ACCESS_DENIED；非空目录删除返回 NOT_EMPTY。
 */
export class MockWorkspaceBridge extends BaseWorkspaceBridge {
  readonly name = 'mock';

  private readonly latencyMs: number;
  private root: MockNode;
  private idSeq = 0;

  constructor(options: MockWorkspaceBridgeOptions = {}) {
    super();
    this.latencyMs = options.latencyMs ?? 80;
    this.root = this.buildFixture();
  }

  /** 生成稳定的节点 id */
  private nextId(): string {
    this.idSeq += 1;
    return `mock-${this.idSeq}`;
  }

  /** 按相对路径查找节点；找不到返回 null */
  private findNode(relativePath: string): MockNode | null {
    if (relativePath.length === 0) {
      return this.root;
    }
    const segments = relativePath.split('/');
    let current: MockNode = this.root;
    for (const segment of segments) {
      const child = current.children.find((c) => c.name === segment);
      if (!child) {
        return null;
      }
      current = child;
    }
    return current;
  }

  /** 向父节点追加子节点并维护 relativePath */
  private attachChild(parent: MockNode, node: MockNode): void {
    node.parent = parent;
    node.relativePath = joinPath(parent.relativePath, node.name);
    this.updateDescendantPaths(node);
    parent.children.push(node);
  }

  /** 递归更新某节点及其所有后代的 relativePath（重命名 / 移动目录后调用） */
  private updateDescendantPaths(node: MockNode): void {
    for (const child of node.children) {
      child.relativePath = joinPath(node.relativePath, child.name);
      this.updateDescendantPaths(child);
    }
  }

  /** 从父节点移除子节点 */
  private detachChild(node: MockNode): void {
    if (!node.parent) {
      return;
    }
    node.parent.children = node.parent.children.filter((c) => c !== node);
    node.parent = null;
  }

  /** 判断目标路径下是否已存在同名条目 */
  private hasChildNamed(parent: MockNode, name: string): boolean {
    return parent.children.some((c) => c.name === name);
  }

  /**
   * 构造演示用 SVG 图片的 data URL（纯前端数据，不涉及真实文件）。
   * 生成一张带渐变与图形的 640×400 画布，用于演示图片渲染能力。
   */
  private buildDemoImage(accent: string, label: string): { url: string; width: number; height: number } {
    const width = 640;
    const height = 400;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="#141828"/><stop offset="1" stop-color="#202a44"/></linearGradient>` +
      `<linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${accent}"/><stop offset="1" stop-color="${accent}66"/></linearGradient>` +
      `</defs>` +
      `<rect width="${width}" height="${height}" fill="url(#bg)"/>` +
      `<circle cx="540" cy="70" r="120" fill="${accent}" opacity="0.12"/>` +
      `<rect x="48" y="70" width="180" height="44" rx="10" fill="${accent}" opacity="0.9"/>` +
      `<text x="64" y="99" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="#ffffff">${label}</text>` +
      `<rect x="48" y="150" width="70" height="140" rx="6" fill="url(#bar)"/>` +
      `<rect x="136" y="180" width="70" height="110" rx="6" fill="url(#bar)" opacity="0.8"/>` +
      `<rect x="224" y="130" width="70" height="160" rx="6" fill="url(#bar)" opacity="0.9"/>` +
      `<rect x="312" y="200" width="70" height="90" rx="6" fill="url(#bar)" opacity="0.7"/>` +
      `<path d="M48 330 H592" stroke="#ffffff" stroke-opacity="0.25" stroke-width="2"/>` +
      `<text x="48" y="360" font-family="Arial, sans-serif" font-size="14" fill="#9aa4b8">Codex Fusion preview · ${width} × ${height}</text>` +
      `</svg>`;
    return {
      url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      width,
      height,
    };
  }

  /** 构造演示工作区（纯内存，不接触真实文件系统） */
  private buildFixture(): MockNode {
    this.idSeq = 0;
    const root: MockNode = this.makeDir('', '');

    const readme = this.makeFile('README.md', 'README.md', `# Codex Fusion 受限工作区

这是一个演示用的 mock 工作区。

## 你可以尝试
- 展开左侧目录，观察延迟加载；
- 编辑本文件后保存（Ctrl+S）；
- 在另一个进程修改后保存，观察版本冲突；
`);
    const notes = this.makeFile('notes.txt', 'notes.txt', '会议纪要\n- 确认受限工作区边界\n- 桥接协议使用 JSONL\n');
    const config = this.makeFile('config.json', 'config.json', '{\n  "name": "codex-fusion",\n  "safeMode": true\n}\n');
    const spec = this.makeFile('spec.md', 'spec.md', '# 只读规范文件\n\n本文件由桥接层标记为只读，编辑区禁用输入。\n');
    spec.readonly = true;

    const src = this.makeDir('src', 'src');
    const app = this.makeFile('app.ts', 'src/app.ts', 'export function hello(): string {\n  return "hello";\n}\n');
    const utils = this.makeDir('utils', 'src/utils');
    const format = this.makeFile('format.ts', 'src/utils/format.ts', 'export function formatBytes(bytes: number): string {\n  return `${bytes} B`;\n}\n');
    const parse = this.makeFile('parse.ts', 'src/utils/parse.ts', 'export function parseLine(line: string): string {\n  return line.trim();\n}\n');

    const assets = this.makeDir('assets', 'assets');
    const logo = this.makeFile('logo.png', 'assets/logo.png', '');
    const logoImage = this.buildDemoImage('#4c8bf5', 'Codex Fusion');
    logo.imageUrl = logoImage.url;
    logo.imageWidth = logoImage.width;
    logo.imageHeight = logoImage.height;
    logo.sizeBytes = 24680;
    const cover = this.makeFile('cover.svg', 'assets/cover.svg', '');
    const coverImage = this.buildDemoImage('#c193e8', 'Cover Art');
    cover.imageUrl = coverImage.url;
    cover.imageWidth = coverImage.width;
    cover.imageHeight = coverImage.height;
    cover.sizeBytes = 18902;
    const archive = this.makeFile('archive.zip', 'assets/archive.zip', '');
    archive.binary = true;
    archive.sizeBytes = 1048576;

    const big = this.makeFile('big.log', 'big.log', this.buildBigLog());
    const locked = this.makeFile('locked.txt', 'locked.txt', 'secret');
    locked.inaccessible = true;

    const gitignore = this.makeFile('.gitignore', '.gitignore', 'node_modules/\ndist/\n');
    gitignore.hidden = true;

    const gitDir = this.makeDir('.git', '.git');
    gitDir.hidden = true;
    const head = this.makeFile('HEAD', '.git/HEAD', 'ref: refs/heads/main\n');
    head.hidden = true;

    const nodeModules = this.makeDir('node_modules', 'node_modules');
    nodeModules.ignored = true;
    const pkgDir = this.makeDir('pkg', 'node_modules/pkg');
    pkgDir.ignored = true;
    const pkgIndex = this.makeFile('index.js', 'node_modules/pkg/index.js', 'module.exports = {};\n');
    pkgIndex.ignored = true;

    const empty = this.makeDir('empty', 'empty');
    const restricted = this.makeDir('restricted', 'restricted');
    restricted.inaccessible = true;

    const link = this.makeNode('link-readme', 'link-readme', 'symlink');
    link.content = readme.content;
    link.sizeBytes = readme.sizeBytes;

    for (const child of [readme, notes, config, spec, src, assets, big, locked, gitignore, gitDir, nodeModules, empty, restricted, link]) {
      this.attachChild(root, child);
    }
    this.attachChild(src, app);
    this.attachChild(src, utils);
    this.attachChild(utils, format);
    this.attachChild(utils, parse);
    this.attachChild(assets, logo);
    this.attachChild(assets, cover);
    this.attachChild(assets, archive);
    this.attachChild(gitDir, head);
    this.attachChild(nodeModules, pkgDir);
    this.attachChild(pkgDir, pkgIndex);

    return root;
  }

  /** 构造超过截断阈值的大日志文本 */
  private buildBigLog(): string {
    const line = 'INFO request completed in 42ms status=200\n';
    const count = Math.ceil(TRUNCATE_BYTES / byteLength(line)) + 10;
    return line.repeat(count);
  }

  private makeNode(name: string, relativePath: string, kind: WorkspaceEntryKind): MockNode {
    return {
      id: this.nextId(),
      name,
      relativePath,
      kind,
      content: null,
      binary: false,
      readonly: false,
      inaccessible: false,
      hidden: false,
      ignored: false,
      sizeBytes: 0,
      version: null,
      children: [],
      parent: null,
    };
  }

  private makeDir(name: string, relativePath: string): MockNode {
    return this.makeNode(name, relativePath, 'directory');
  }

  private makeFile(name: string, relativePath: string, content: string): MockNode {
    const node = this.makeNode(name, relativePath, 'file');
    node.content = content;
    node.sizeBytes = byteLength(content);
    node.version = 'v1';
    return node;
  }

  /** 节点 → 对外条目 */
  private toEntry(node: MockNode): WorkspaceEntry {
    return {
      id: node.id,
      name: node.name,
      relativePath: node.relativePath,
      kind: node.kind,
      inaccessible: node.inaccessible,
    };
  }

  /**
   * 排序规则：目录在前，文件在后，同级按名称排序。
   */
  private sortChildren(nodes: MockNode[]): MockNode[] {
    return [...nodes].sort((a, b) => {
      const kindDiff = Number(a.kind === 'directory') - Number(b.kind === 'directory');
      if (kindDiff !== 0) {
        return -kindDiff;
      }
      return a.name.localeCompare(b.name, 'en');
    });
  }

  /** 按过滤条件筛选子节点 */
  private filterChildren(parent: MockNode, showHidden: boolean, showIgnored: boolean): MockNode[] {
    return this.sortChildren(parent.children).filter((c) => {
      if (c.hidden && !showHidden) {
        return false;
      }
      if (c.ignored && !showIgnored) {
        return false;
      }
      return true;
    });
  }

  /** 分页切片：cursor 为偏移量字符串 */
  private paginate<T>(items: T[], cursor: string | undefined, limit: number | undefined): { page: T[]; nextCursor?: string; truncated: boolean } {
    const offset = cursor === undefined ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0);
    const size = limit === undefined || limit <= 0 ? items.length : limit;
    const page = items.slice(offset, offset + size);
    const truncated = offset + size < items.length;
    return {
      page,
      nextCursor: truncated ? String(offset + size) : undefined,
      truncated,
    };
  }

  // ---------------------------------------------------------------------------
  // 各方法的处理器：返回 BridgeResponse（错误以 error 字段返回，模拟真实桥接层）
  // ---------------------------------------------------------------------------

  private handleContext(): BridgeResponse<WorkspaceContext> {
    return {
      id: '',
      ok: true,
      result: {
        displayName: '受限工作区 · 演示',
        rootValid: true,
      },
    };
  }

  private handleList(request: BridgeRequest): BridgeResponse<ListResult> {
    const params = request.params as {
      relativePath?: string;
      cursor?: string;
      limit?: number;
      showHidden?: boolean;
      showIgnored?: boolean;
    };
    const path = params.relativePath ?? '';
    const node = this.findNode(path);
    if (!node) {
      return this.fail(request.id, 'NOT_FOUND', `路径不存在：${path}`);
    }
    if (node.kind !== 'directory') {
      return this.fail(request.id, 'INVALID_PATH', `不是目录：${path}`);
    }
    if (node.inaccessible) {
      return this.fail(request.id, 'ACCESS_DENIED', `无权限访问目录：${path}`);
    }
    const showHidden = params.showHidden === true;
    const showIgnored = params.showIgnored === true;
    const filtered = this.filterChildren(node, showHidden, showIgnored);
    const { page, nextCursor, truncated } = this.paginate(filtered, params.cursor, params.limit);
    return {
      id: request.id,
      ok: true,
      result: {
        entries: page.map((c) => this.toEntry(c)),
        nextCursor,
        truncated,
      },
    };
  }

  private handlePreview(request: BridgeRequest): BridgeResponse<PreviewResult> {
    const params = request.params as { relativePath: string };
    const node = this.findNode(params.relativePath);
    if (!node) {
      return this.fail(request.id, 'NOT_FOUND', `路径不存在：${params.relativePath}`);
    }
    if (node.kind === 'directory') {
      return this.fail(request.id, 'INVALID_PATH', `是目录而非文件：${params.relativePath}`);
    }
    if (node.inaccessible) {
      return this.fail(request.id, 'ACCESS_DENIED', `无权限读取：${params.relativePath}`);
    }
    if (node.imageUrl) {
      return {
        id: request.id,
        ok: true,
        result: {
          editable: false,
          kind: 'image',
          sizeBytes: node.sizeBytes,
          imageUrl: node.imageUrl,
          imageWidth: node.imageWidth,
          imageHeight: node.imageHeight,
        },
      };
    }
    if (node.binary) {
      return {
        id: request.id,
        ok: true,
        result: {
          editable: false,
          kind: 'binary',
          sizeBytes: node.sizeBytes,
        },
      };
    }
    const text = node.content ?? '';
    const truncated = node.sizeBytes > TRUNCATE_BYTES;
    const editable = node.kind !== 'symlink' && !node.readonly && !truncated;
    return {
      id: request.id,
      ok: true,
      result: {
        editable,
        kind: node.kind === 'symlink' ? 'symlink' : 'text',
        text: truncated ? text.slice(0, TRUNCATE_PREVIEW_CHARS) : text,
        truncated,
        version: editable && node.version ? node.version : undefined,
        sizeBytes: node.sizeBytes,
      },
    };
  }

  private handleSave(request: BridgeRequest): BridgeResponse<SaveResult> {
    const params = request.params as { relativePath: string; expectedVersion: string; content: string };
    const node = this.findNode(params.relativePath);
    if (!node) {
      return this.fail(request.id, 'NOT_FOUND', `路径不存在：${params.relativePath}`);
    }
    if (node.kind !== 'file') {
      return this.fail(request.id, 'INVALID_PATH', `不是文件：${params.relativePath}`);
    }
    if (node.inaccessible || node.readonly || node.binary || node.sizeBytes > TRUNCATE_BYTES) {
      return this.fail(request.id, 'NOT_EDITABLE', '文件不可编辑，拒绝保存');
    }
    if (node.version === null) {
      return this.fail(request.id, 'NOT_EDITABLE', '文件没有版本信息，拒绝保存');
    }
    if (params.expectedVersion !== node.version) {
      return this.fail(
        request.id,
        'VERSION_CONFLICT',
        `文件已被其他进程修改（期望版本 ${params.expectedVersion}，当前版本 ${node.version}）。请重新加载或另存为副本。`,
      );
    }
    node.content = params.content;
    node.sizeBytes = byteLength(params.content);
    node.version = nextVersion(node.version);
    const truncated = node.sizeBytes > TRUNCATE_BYTES;
    return {
      id: request.id,
      ok: true,
      result: {
        editable: !truncated,
        kind: 'text',
        text: truncated ? node.content.slice(0, TRUNCATE_PREVIEW_CHARS) : node.content,
        truncated,
        version: node.version,
        sizeBytes: node.sizeBytes,
      },
    };
  }

  private handleCreate(request: BridgeRequest): BridgeResponse<WorkspaceEntry> {
    const params = request.params as { parentRelativePath: string; name: string; kind: 'file' | 'directory' };
    const nameError = validateName(params.name);
    if (nameError) {
      return this.fail(request.id, 'INVALID_NAME', nameError);
    }
    const parent = this.findNode(params.parentRelativePath);
    if (!parent) {
      return this.fail(request.id, 'NOT_FOUND', `父目录不存在：${params.parentRelativePath}`);
    }
    if (parent.kind !== 'directory') {
      return this.fail(request.id, 'INVALID_PATH', `父路径不是目录：${params.parentRelativePath}`);
    }
    if (parent.inaccessible) {
      return this.fail(request.id, 'ACCESS_DENIED', `无权限访问目录：${params.parentRelativePath}`);
    }
    if (this.hasChildNamed(parent, params.name)) {
      return this.fail(request.id, 'ALREADY_EXISTS', `已存在同名条目：${params.name}`);
    }
    const node =
      params.kind === 'directory'
        ? this.makeDir(params.name, joinPath(parent.relativePath, params.name))
        : this.makeFile(params.name, joinPath(parent.relativePath, params.name), '');
    if (params.name.startsWith('.')) {
      node.hidden = true;
    }
    this.attachChild(parent, node);
    return { id: request.id, ok: true, result: this.toEntry(node) };
  }

  private handleRename(request: BridgeRequest): BridgeResponse<WorkspaceEntry> {
    const params = request.params as { relativePath: string; newName: string };
    const nameError = validateName(params.newName);
    if (nameError) {
      return this.fail(request.id, 'INVALID_NAME', nameError);
    }
    const node = this.findNode(params.relativePath);
    if (!node) {
      return this.fail(request.id, 'NOT_FOUND', `路径不存在：${params.relativePath}`);
    }
    if (node === this.root) {
      return this.fail(request.id, 'INVALID_PATH', '不能重命名工作区根目录');
    }
    if (node.parent && this.hasChildNamed(node.parent, params.newName)) {
      return this.fail(request.id, 'ALREADY_EXISTS', `已存在同名条目：${params.newName}`);
    }
    const oldPath = node.relativePath;
    node.name = params.newName;
    node.relativePath = joinPath(parentOf(oldPath), params.newName);
    this.updateDescendantPaths(node);
    return { id: request.id, ok: true, result: this.toEntry(node) };
  }

  private handleMove(request: BridgeRequest): BridgeResponse<WorkspaceEntry> {
    const params = request.params as { relativePath: string; destinationParentRelativePath: string };
    const node = this.findNode(params.relativePath);
    if (!node) {
      return this.fail(request.id, 'NOT_FOUND', `路径不存在：${params.relativePath}`);
    }
    const destination = this.findNode(params.destinationParentRelativePath);
    if (!destination) {
      return this.fail(request.id, 'NOT_FOUND', `目标目录不存在：${params.destinationParentRelativePath}`);
    }
    if (destination.kind !== 'directory') {
      return this.fail(request.id, 'INVALID_PATH', `目标不是目录：${params.destinationParentRelativePath}`);
    }
    if (destination.inaccessible) {
      return this.fail(request.id, 'ACCESS_DENIED', `无权限访问目标目录：${params.destinationParentRelativePath}`);
    }
    if (node === destination || this.isSelfOrDescendant(destination, node)) {
      return this.fail(request.id, 'INVALID_DESTINATION', '不能把目录移动到自身或其子目录中');
    }
    if (this.hasChildNamed(destination, node.name)) {
      return this.fail(request.id, 'ALREADY_EXISTS', `目标目录已存在同名条目：${node.name}`);
    }
    this.detachChild(node);
    this.attachChild(destination, node);
    return { id: request.id, ok: true, result: this.toEntry(node) };
  }

  private handleCopy(request: BridgeRequest): BridgeResponse<WorkspaceEntry> {
    const params = request.params as { relativePath: string; destinationParentRelativePath: string };
    const node = this.findNode(params.relativePath);
    if (!node) {
      return this.fail(request.id, 'NOT_FOUND', `路径不存在：${params.relativePath}`);
    }
    const destination = this.findNode(params.destinationParentRelativePath);
    if (!destination) {
      return this.fail(request.id, 'NOT_FOUND', `目标目录不存在：${params.destinationParentRelativePath}`);
    }
    if (destination.kind !== 'directory') {
      return this.fail(request.id, 'INVALID_PATH', `目标不是目录：${params.destinationParentRelativePath}`);
    }
    if (destination.inaccessible) {
      return this.fail(request.id, 'ACCESS_DENIED', `无权限访问目标目录：${params.destinationParentRelativePath}`);
    }
    if (this.hasChildNamed(destination, node.name)) {
      return this.fail(request.id, 'ALREADY_EXISTS', `目标目录已存在同名条目：${node.name}`);
    }
    const copy = this.cloneSubtree(node, destination.relativePath);
    this.attachChild(destination, copy);
    return { id: request.id, ok: true, result: this.toEntry(copy) };
  }

  private handleDelete(request: BridgeRequest): BridgeResponse<null> {
    const params = request.params as { relativePath: string };
    const node = this.findNode(params.relativePath);
    if (!node) {
      return this.fail(request.id, 'NOT_FOUND', `路径不存在：${params.relativePath}`);
    }
    if (node === this.root) {
      return this.fail(request.id, 'INVALID_PATH', '不能删除工作区根目录');
    }
    if (node.kind === 'directory' && node.children.length > 0) {
      return this.fail(request.id, 'NOT_EMPTY', `目录不为空，拒绝删除：${params.relativePath}`);
    }
    this.detachChild(node);
    return { id: request.id, ok: true, result: null };
  }

  /** 判断 target 是否为 node 自身或其子孙节点 */
  private isSelfOrDescendant(target: MockNode, node: MockNode): boolean {
    let current: MockNode | null = target;
    while (current) {
      if (current === node) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  /** 深拷贝子树（复制时内容不变、版本重置为 v1） */
  private cloneSubtree(node: MockNode, parentPath: string): MockNode {
    const clone: MockNode = {
      ...node,
      id: this.nextId(),
      relativePath: joinPath(parentPath, node.name),
      version: node.version === null ? null : 'v1',
      children: [],
      parent: null,
    };
    for (const child of node.children) {
      clone.children.push(this.cloneSubtree(child, clone.relativePath));
    }
    return clone;
  }

  /** 构造失败响应 */
  private fail(id: string, code: string, message: string): BridgeResponse<never> {
    const error: BridgeError = { code, message };
    return { id, ok: false, error };
  }

  /** 协议路由入口：依据 method 分发到各处理器 */
  private handle(request: BridgeRequest): BridgeResponse<unknown> {
    switch (request.method) {
      case 'workspace.context':
        return this.handleContext();
      case 'workspace.list':
        return this.handleList(request);
      case 'workspace.preview':
        return this.handlePreview(request);
      case 'workspace.save':
        return this.handleSave(request);
      case 'workspace.create':
        return this.handleCreate(request);
      case 'workspace.rename':
        return this.handleRename(request);
      case 'workspace.move':
        return this.handleMove(request);
      case 'workspace.copy':
        return this.handleCopy(request);
      case 'workspace.delete':
        return this.handleDelete(request);
      default:
        return this.fail(request.id, 'METHOD_NOT_FOUND', `未知方法：${request.method}`);
    }
  }

  /** 实现 BaseWorkspaceBridge.send：模拟网络延迟后返回响应包 */
  protected async send(request: BridgeRequest): Promise<BridgeResponse<unknown>> {
    await delay(this.latencyMs);
    return this.handle(request);
  }

  /**
   * 测试辅助：模拟"另一个进程"修改了文件内容并推进版本号。
   * 之后用旧版本号保存会触发 VERSION_CONFLICT。
   */
  simulateExternalSave(relativePath: string, content: string): void {
    const node = this.findNode(relativePath);
    if (!node || node.kind !== 'file' || node.binary || node.inaccessible || node.version === null) {
      return;
    }
    node.content = content;
    node.sizeBytes = byteLength(content);
    node.version = nextVersion(node.version);
  }

  /** 测试辅助：查询某相对路径节点是否存在 */
  hasEntry(relativePath: string): boolean {
    return this.findNode(relativePath) !== null;
  }
}
