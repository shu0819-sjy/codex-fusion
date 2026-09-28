/**
 * 文件图标着色工具：按扩展名返回 CSS 类名（icon-*），树节点与编辑器标签共用。
 * 未知类型返回空串，使用默认灰色。
 */
export function fileIconClass(name: string): string {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === name.length - 1) {
    return '';
  }
  const ext = name.slice(dotIndex + 1).toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'icon-ts';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'icon-js';
    case 'json':
    case 'jsonc':
      return 'icon-json';
    case 'md':
    case 'markdown':
      return 'icon-md';
    case 'txt':
      return 'icon-txt';
    case 'log':
      return 'icon-log';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
    case 'ico':
      return 'icon-img';
    case 'css':
    case 'scss':
    case 'less':
      return 'icon-css';
    case 'html':
    case 'htm':
      return 'icon-html';
    default:
      return '';
  }
}
