# Codex Fusion Tauri 宿主

这里是 Codex Fusion 的桌面容器。它使用 Tauri 2 创建窗口，由 Rust 宿主按 `CODEX_FUSION_ROOT` 或可执行文件位置解析仓库根目录，并通过配置或 `CODEX_FUSION_BRIDGE` 定位 `fusion-bridge.exe`。前端只通过 JSON 请求访问工作区能力。

## 构建

先构建前端：

```powershell
Set-Location <仓库根目录>
npm run build
```

再构建宿主：

```powershell
Set-Location <仓库根目录>\host
npm install
npm run build
```

开发运行：

```powershell
Set-Location <仓库根目录>\frontend
npm run dev
```

浏览器开发模式不启动 Rust 进程；桌面构建时由 Tauri 宿主自动创建配置中的状态目录，并连接现有配置中的工作区和桥接程序。重启 Codex 接口会等待启动、CDP 和皮肤注入结果，失败时返回错误，不会提前报告成功。
