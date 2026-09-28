# 前端设计规范（COMPONENTS）

Codex Fusion 独立前端的组件与交互约定。目标：跨页面风格统一、交互模式可复用、新组件按同一套规则接入。

## 1. 设计令牌（Design Tokens）

所有颜色、圆角、字号、间距都定义在 `src/styles/global.css` 的 `:root`：

| 分类 | 变量 | 说明 |
| --- | --- | --- |
| 背景 | `--bg` / `--bg-panel` / `--bg-elevated` / `--bg-hover` / `--bg-active` / `--bg-input` | 层级从深到浅 |
| 边框 | `--border` / `--border-strong` | 常规 / 强调 |
| 文本 | `--text` / `--text-dim` / `--text-faint` | 主 / 次 / 弱 |
| 品牌色 | `--accent` / `--accent-bright` / `--accent-dim` / `--accent-soft` | 按钮、选中、焦点 |
| 语义色 | `--danger` / `--warn` / `--ok` 及 soft 变体 | 错误 / 警告 / 成功 |
| 圆角 | `--radius`(6px) / `--radius-sm`(4px) / `--radius-lg`(12px) | 常规圆角不超过 8px，`--radius-lg` 仅空状态徽章使用 |
| 布局 | `--toolbar-h` / `--statusbar-h` / `--sidebar-w` | 固定尺寸 |

文件类型着色统一使用 `src/utils/fileIcons.ts` 的 `fileIconClass`（`.icon-ts` 等），不要手写分散的扩展名判断。

## 2. 组件清单

| 组件 | 职责 | 复用规则 |
| --- | --- | --- |
| `WorkspaceShell` | 唯一状态编排层：标签页、选中项、对话框、忙状态、toast | 组件间通信只经由它，不跨层传状态 |
| `Toolbar` | 顶部操作区；所有按钮具备 disabled / loading / tooltip | 操作按钮一律用 `IconButton` |
| `FileTree` / `FileTreeNode` | 文件树：懒加载、分页、过滤、树中定位 | 行元素带 `data-tree-path`，定位用 aria-label |
| `EditorPane` | 多标签编辑区：文本 / 图片 / 只读 / 二进制 | 标签键盘 ←/→ 切换、面包屑跳转 |
| `Modal` 系 | `Modal` 外壳 + `ConfirmDialog` / `NameDialog` / `MoveCopyDialog` / `ConflictDialog` | 对话框统一：Esc 关闭、Enter 提交、输入框 autoFocus、`role="dialog"` |
| `IconButton` | 图标按钮（含 CSS tooltip、loading、danger、primary） | 工具栏 / 模态框关闭按钮 |
| `ErrorNotice` / `StatusBar` | 错误统一展示 / 底部状态 | 错误只显示桥接层返回的 code + message，不猜测 |
| `Toast` | 操作成功反馈（2200ms 自动消失） | `role="status"`，带图标弹跳动效 |

## 3. 交互模式（复用约定）

- **危险操作**：删除必须经过 `ConfirmDialog`，前端只发请求，不承诺回收站语义。
- **版本冲突**：保存收到 `VERSION_CONFLICT` 时保留草稿，只提供"重新加载 / 另存为副本"两个显式选项，绝不静默覆盖。
- **失败展示**：所有桥接错误统一显示 `error.code: error.message`；图片加载失败有独立容错占位 + 重试。
- **快捷键**：`Ctrl+S` 保存、`F2` 重命名、`Delete` 删除；输入框聚焦 / 对话框打开 / 忙状态时禁用。标签栏 ←/→ 切换。
- **树中定位**：切换标签或点击面包屑目录段时，文件树自动展开祖先目录并滚动到目标行。
- **忙状态**：任一操作进行中，`Toolbar` 设置 `aria-busy` 并禁用全部操作按钮。

## 4. 视觉与可访问性约束

- 不引入首屏宣传页、渐变球、大圆角卡片、嵌套卡片；常规圆角 ≤ 8px。
- 文件树 ≤1024px 默认折叠为浮层；≤768px 工具栏收敛为纯图标。
- 全站尊重 `prefers-reduced-motion`；键盘焦点统一走 `:focus-visible` 蓝色轮廓。
- 文本使用 `tabular-nums`（尺寸/字节/版本号），不重叠、不溢出、可省略（ellipsis）。

## 5. 变更守则

- 自定义函数必须带简体中文注释（功能、入参、返回值、边界情况）；2 空格缩进、单引号、camelCase/PascalCase。
- 新增可复用 UI 前先检查上表是否存在；状态类（disabled/loading/error）不得遗漏。
- 任何交互或布局改动必须补/改测试（`src/test/`），`npm run test` 全绿后才能交付。
