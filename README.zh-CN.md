# Codex Fusion

Codex Fusion 是面向官方 Codex 的 Windows 桌面伴侣工具，提供本地壁纸主题、动态效果、受限工作区和 Tauri/Rust 宿主，不替换官方 Codex 安装包。

> 当前版本：**v0.3.0**。完整桌面应用支持 Windows 10/11。前端可以在其他操作系统上构建，但 Codex 进程集成、托盘流程和 PowerShell 测试是 Windows 专属功能，当前版本不宣称原生支持 macOS/Linux 桌面宿主。

## 功能

- **主题工作台**：浏览、创建、预览和应用本地 Dream Skin 主题；
- **动态效果**：通过 Codex CDP 提供雨、粒子、雪、雾等效果；
- **外来会话守卫**：检测未加皮肤的官方 Codex 会话，只在用户操作后关闭；
- **文件诊断**：在工作台打开 `host-out.log` 和 `host-crash.log`；
- **单一入口**：一起启动 Fusion 宿主、主题服务和可选 CDP 注入；
- **系统托盘**：关闭到托盘、恢复窗口、带皮肤重启 Codex；
- **受限工作区**：可选工作区桥接，所有操作限制在配置的根目录内。

## 依赖与支持边界

完整桌面应用需要：

- Windows 10 或 Windows 11；
- Node.js 20 LTS 或更新版本（CI 同时覆盖 Node 22）；
- npm 10 或更新版本，统一使用仓库提交的 `package-lock.json`；
- Rust stable 及 Windows Tauri 构建依赖；
- 已安装的官方 Codex；
- 可选：[Code-Codex](https://github.com/Rice-dog/code-codex)，用于工作区桥模式。

CI 会在 Ubuntu、Windows、macOS 上构建和测试前端；Rust 宿主、进程控制和托盘集成仍限定 Windows。不要把前端矩阵误认为完整的 macOS/Linux 桌面支持。

## 可复现安装

仓库统一使用 npm，不要把 `pnpm install` 与已提交的 npm lockfile 混用。在仓库根目录先生成本地配置：

```powershell
copy fusion-config.example.json fusion-config.json
```

编辑 `fusion-config.json`，把 `workspace` 改成已存在的目录。该文件含本机路径，已被 Git 忽略。

构建前端：

```powershell
cd frontend
npm ci
npm run build
npm test
```

安装 Tauri CLI 并构建 Windows 宿主：

```powershell
cd ..\host
npm ci
cd src-tauri
cargo build --release
```

宿主依赖 `frontend/dist`，所以必须先构建前端。生成的程序位于 `host\src-tauri\target\release\codex-fusion-host.exe`，可这样启动：

```powershell
cd ..\..
.\start-codex-fusion.cmd
```

开发模式：

```powershell
cd host
npm run dev
```

工作区桥是可选的。需要时请单独克隆上游仓库，只构建 `workspace-service`，并通过 `CODEX_FUSION_BRIDGE` 指向生成的程序；不要把桥接二进制或第三方副本提交到本仓库。

## 配置项

从 [`fusion-config.example.json`](./fusion-config.example.json) 开始：

| 配置项 | 含义 |
|---|---|
| `workspace` | 工作区根目录，必须是已存在的目录；所有工作区操作受此目录约束。 |
| `dreamSkinPort` | 主题服务端口，宿主会校验范围和固定 CDP 关系。 |
| `dreamSkinStateRoot` | 本地状态目录，不存在时宿主会创建。 |
| `safeMode` | 必须保持 `true`，关闭受限工作区校验会被拒绝。 |
| `version` | 配置模板版本，应随仓库版本更新。 |

可选环境变量：`CODEX_FUSION_ROOT`、`CODEX_CODEX_PATH`、`CODEX_FUSION_BRIDGE`。覆盖可执行文件时建议使用绝对路径。诊断日志写在安装根目录，已加入 Git 忽略。

## 测试与 CI

本地前端检查：

```powershell
cd frontend
npm ci
npm run build
npm test
```

CI 在 Ubuntu、Windows、macOS 和 Node 20/22 上执行前端安装、构建和测试；另在 Windows 执行 Rust `cargo check`、测试、Clippy、格式检查和 Pester 进程测试，在 Ubuntu 执行动态效果 Node 测试。非 Windows 任务只覆盖前端，不证明桌面宿主可在其他系统原生运行。

## 安全边界

- 不修改或替换官方 Codex 二进制；
- 进程终止按可执行文件路径和配置范围约束，不按进程名盲杀；
- 主题应用和 Codex 重启必须由用户触发；
- 工作区操作限制在配置根目录下；
- `fusion-config.json`、日志、状态、第三方副本和生成的二进制不会进入版本控制。

## 目录结构

```text
frontend/                  # React/Vite 主题工作台和工作区 UI
host/src-tauri/             # Tauri 2 Rust 宿主和 Windows 集成
host/package.json           # Tauri CLI，使用 host/package-lock.json 安装
host/src-tauri/Cargo.toml   # Rust 依赖
tests/                      # PowerShell/Pester 进程测试
fusion-config.example.json  # 安全配置模板
licenses/                   # 第三方许可
```

## 许可与声明

MIT，见 [LICENSE](./LICENSE)。第三方组件许可见 `licenses/`。本项目是非官方社区工具，与 OpenAI 无关，使用风险由用户自行承担。
