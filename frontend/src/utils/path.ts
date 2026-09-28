/**
 * 相对路径工具。
 *
 * 边界：前端只处理相对路径（以 '/' 分隔），禁止拼接 / 展示工作区外的绝对路径；
 * isRelativePath 用于在对话框提交前拦截绝对路径类输入。
 */

/** 相对路径拼接：parent 为空表示根目录 */
export function joinRelative(parent: string, name: string): string {
  return parent.length === 0 ? name : `${parent}/${name}`;
}

/** 取父目录相对路径：'a/b.txt' → 'a'；'a.txt' → ''（根目录） */
export function parentOfPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/** 取名称：'a/b.txt' → 'b.txt' */
export function baseNameOfPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/**
 * 校验输入是否为合法相对路径（允许空字符串表示根目录）。
 * 拒绝：以 / 或 \\ 开头、含盘符、含 \\、含 . 或 .. 段。
 */
export function isRelativePath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return true;
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    return false;
  }
  if (/^[A-Za-z]:/.test(trimmed)) {
    return false;
  }
  if (trimmed.includes('\\')) {
    return false;
  }
  if (trimmed.split('/').some((segment) => segment === '.' || segment === '..')) {
    return false;
  }
  return true;
}

/** 生成"另存为副本"的文件名：README.md → README-copy.md，冲突时追加序号 */
export function buildCopyName(name: string, usedNames: string[]): string {
  const dotIndex = name.lastIndexOf('.');
  const hasExtension = dotIndex > 0 && dotIndex < name.length - 1;
  const stem = hasExtension ? name.slice(0, dotIndex) : name;
  const extension = hasExtension ? name.slice(dotIndex) : '';
  const used = new Set(usedNames);
  let candidate = `${stem}-copy${extension}`;
  let seq = 2;
  while (used.has(candidate)) {
    candidate = `${stem}-copy-${seq}${extension}`;
    seq += 1;
  }
  return candidate;
}
