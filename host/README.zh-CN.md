# Codex Fusion Tauri 宿主

这里是 Codex Fusion 的桌面容器。它使用 Tauri 2 创建窗口，由 Rust 宿主启动并管理 `C:\codex-fusion\bin\fusion-bridge.exe`，前端只通过 JSON 请求访问工作区能力。

## 构建

先构建前端：

```powershell
Set-Location C:\codex-fusion\frontend
npm run build
```

再构建宿主：

```powershell
Set-Location C:\codex-fusion\host
npm install
npm run build
```

开发运行：

```powershell
Set-Location C:\codex-fusion\frontend
npm run dev
```

浏览器开发模式不启动 Rust 进程；桌面构建时由 Tauri 宿主自动连接现有配置中的工作区和桥接程序。
