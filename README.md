# Codex Fusion

Local desktop companion for [OpenAI Codex](https://openai.com/codex): wallpaper themes, dynamic effects, and a bounded workspace shell — without modifying the official Codex install.

> Status: **v0.3.0** — adds a foreign-session guard, file diagnostics, and process-spawn hardening on top of the v0.2.0 open-source baseline (portable paths, templated config, hardened tray/single-instance).

## Features

- **Theme Studio** — browse / create / apply local Dream Skin wallpapers with live preview
- **Dynamic effects** — rain, particles, snow, fog, and more (requires Codex CDP)
- **Foreign-session guard** — detect un-skinned official Codex sessions and close them in one click to free resources
- **File diagnostics** — `host-out.log` / `host-crash.log` with an in-Studio "open log" button
- **Single entry** — one Fusion host launches theme service + optional CDP inject
- **Tray native** — close-to-tray, left-click restore, restart Codex with skin
- **Bounded workspace** — optional Code-Codex style file tree via Rust bridge (workspace rooted)

## Requirements

- Windows 10/11
- [Rust](https://rustup.rs/) + Node.js 18+
- Official Codex (Microsoft Store / OpenAI package)
- Optional: [Code-Codex](https://github.com/Rice-dog/code-codex) for workspace mode

## Quick start

```powershell
git clone https://github.com/shu0819-sjy/codex-fusion.git
cd codex-fusion
copy fusion-config.example.json fusion-config.json
# edit fusion-config.json → set "workspace" to a real folder

# 1) frontend
cd frontend
npm install
npm run build

# 2) host
cd ..\host\src-tauri
cargo build --release

# 3) workspace bridge (built from upstream Code-Codex)
git clone https://github.com/Rice-dog/code-codex.git ..\code-codex-upstream
cargo build --release -p workspace-service --manifest-path ..\code-codex-upstream\crates\workspace-service\Cargo.toml
copy ..\code-codex-upstream\target\release\workspace-service.exe ..\..\bin\fusion-bridge.exe

# 4) run
..\..\start-codex-fusion.cmd
# or
.\target\release\codex-fusion-host.exe
```

Environment overrides (optional):

| Variable | Meaning |
|---|---|
| `CODEX_FUSION_ROOT` | Install root (auto-detected from exe if unset) |
| `CODEX_CODEX_PATH` | Path to `CodeCodex.exe` |
| `CODEX_FUSION_BRIDGE` | Path to `fusion-bridge.exe` |

On first run, the host creates the configured `dreamSkinStateRoot` directory if it does not exist. The tray restart action waits for the Codex process, CDP endpoint, and skin injection result; a failed restart is returned as an error instead of an immediate success. Diagnostics are written to `host-out.log` (and `host-crash.log` on panic) in the install root — both are gitignored.

## Safety boundaries

- Does **not** patch or replace the official Codex binary
- Process kill paths are path+profile scoped (never kill-by-name alone)
- Theme apply / Codex restart are **user-triggered**
- If Codex is already running without CDP, use tray **Restart Codex (with skin)**

## Project layout

```
codex-fusion/
  frontend/          # React Theme Studio + workspace UI
  host/src-tauri/    # Tauri 2 host, theme HTTP :17890, CDP inject
  bin/               # fusion-bridge.exe (workspace RPC)
  licenses/          # third-party notices
  fusion-config.example.json
```

## License

MIT — see [LICENSE](./LICENSE). Third-party components retain their own licenses under `licenses/`.

## Disclaimer

Unofficial community tool. Not affiliated with OpenAI. Use at your own risk.
