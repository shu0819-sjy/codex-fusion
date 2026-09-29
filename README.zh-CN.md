# Codex Fusion

面向官方 Codex 的本地桌面融合工具：壁纸主题、动态效果、受限工作区。**不修改**官方 Codex 安装包。

> 当前版本：**v0.3.0**（在 v0.2.0 开源底座之上新增：外来会话守卫、文件诊断日志、子进程防闪窗加固）。

## 功能

- 壁纸主题工作台（预览 / 上传 / 应用）
- 动态效果（需 Codex 开启 CDP 调试端口）
- 外来会话守卫：检测未加皮肤的官方 Codex 会话，一键关闭释放资源
- 文件诊断：`host-out.log` / `host-crash.log`，工作台内一键打开日志
- 单一入口：Fusion 宿主拉起主题服务并按需注入
- 托盘常驻：关窗缩托盘、左键唤出、一键「重启 Codex（带皮肤）」
- 可选工作区文件树（Rust bridge，限制在配置的 workspace 根内）

## 快速开始

```powershell
git clone https://github.com/shu0819-sjy/codex-fusion.git
cd codex-fusion
copy fusion-config.example.json fusion-config.json
# 编辑 fusion-config.json，把 workspace 改成你的真实目录

# 1) 前端
cd frontend
npm install
npm run build

# 2) 宿主
cd ..\host\src-tauri
cargo build --release

# 3) 工作区桥（从上游 Code-Codex 构建 workspace-service）
git clone https://github.com/Rice-dog/code-codex.git ..\code-codex-upstream
cargo build --release -p workspace-service --manifest-path ..\code-codex-upstream\crates\workspace-service\Cargo.toml
copy ..\code-codex-upstream\target\release\workspace-service.exe ..\..\bin\fusion-bridge.exe

# 4) 运行
..\..\start-codex-fusion.cmd
```

> `third_party\` 与 `bin\` 是本地第三方拷贝和构建产物，不随仓库分发；构建产物可用 `CODEX_FUSION_BRIDGE` 指向任意位置。

可选环境变量：`CODEX_FUSION_ROOT`、`CODEX_CODEX_PATH`、`CODEX_FUSION_BRIDGE`。

首次运行时，宿主会自动创建配置中的 `dreamSkinStateRoot` 目录。托盘里的重启动作会等待 Codex 进程、CDP 端口和皮肤注入结果；失败会如实返回错误，不会先显示成功。诊断日志写在安装根目录的 `host-out.log`（panic 时另有 `host-crash.log`），均已 gitignore。

## 使用注意

- 日常请从 **Codex Fusion** 启动，不要只点官方 Codex 图标（否则无皮肤）
- 若已误开无调试端口的 Codex：托盘 → **重启 Codex（带皮肤）**
- `fusion-config.json` 含本机路径，已加入 `.gitignore`，请用 `fusion-config.example.json` 作为模板
- 已知边界：托盘「重启 Codex（带皮肤）」与宿主启动注入链完全自包含；旧式「模式互切」中的切回 Dream Skin 方向保留了对本地 Dream Skin engine 的兼容依赖，第三方环境若没有该 engine 会收到明确报错，不影响主题工作台与自动注入

## 许可

MIT，见 [LICENSE](./LICENSE)。第三方组件见 `licenses/`。

## 声明

非官方社区工具，与 OpenAI 无关。风险自负。
