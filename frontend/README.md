# Codex Fusion 独立前端

这是 Codex Fusion 的独立工作区界面，位于 `C:\codex-fusion\frontend`。前端只依赖 `WorkspaceBridge`，不直接访问文件系统、不启动进程、不连接 CDP。

## 本地运行

```powershell
Set-Location C:\codex-fusion\frontend
npm install
npm run dev
```

默认开发模式使用内存 `MockWorkspaceBridge`，可以演示文件树懒加载、文本编辑、保存、版本冲突、创建、重命名、移动、复制和删除确认；编辑器支持多标签页与图片预览（`kind: 'image'` 时渲染桥接层提供的 `imageUrl`，mock 内为演示用 data URL），并带面包屑导航、图片缩放、树中定位等交互。

## 验收命令

```powershell
npm run build
npm run test
```

当前验收覆盖模式切换协议（含 `ready`→success、`executeModeSwitch` 单次确认）、ThemeStudio 确认流、文件树/编辑器、错误可复制与重试等自动化测试。

## Polish R1（UI / 连贯性）要点

- 模式切换：ThemeStudio 确认框后走 `executeModeSwitch`，避免与 `window.confirm` 双重确认。
- ensure：`outcome=ready` 归一化为 `success`，启动成功不再显示为 warning。
- 启动自检失败可见；顶栏统一 Mode+CDP 芯片；关键错误提供重试/复制。
- 视觉：`--radius-lg ≤ 8px`，减弱装饰性渐变，保持克制高密度工作台。

## 验证迭代边界

按项目边界，前端**不引入**账号登录、遥测埋点、联网上报或第三方分析代码；A/B 实验不在本前端范围内。验证迭代以自动化测试（jsdom 全量渲染，`npm run test`）+ 类型/构建门禁（`npm run build`）+ 产物冒烟为主，交互与布局改动先补测试再交付。组件与设计令牌约定见 `COMPONENTS.md`。

## 原生宿主边界

生产环境需要在页面加载前注入 `window.__codexFusionBridge__`，或注入 `window.__codexFusionTransport__`。后者接收一条 `BridgeRequest`，返回一个 `BridgeResponse`，由 `NativeWorkspaceBridge` 完成类型化适配。Rust `fusion-bridge.exe` 当前是 JSONL 标准输入输出服务，尚未由前端自行管理进程，也没有把它暴露成 HTTP 端口。

前端不会绕过官方 Codex 或 Dream Skin 的进程校验；接入原生宿主时仍必须只传递工作区相对路径，并保留桥接返回的错误码和版本冲突语义。
