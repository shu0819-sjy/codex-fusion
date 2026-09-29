# Changelog

All notable changes to Codex Fusion are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/), versioning: SemVer.

## [0.3.0] - 2026-09-29

### Added
- **Foreign-session guard**: the Studio detects un-skinned official Codex sessions (`GET /api/foreign-codex`) and can close them in one click (`POST /api/close-foreign-codex`) to free CPU/memory. Only processes without the skin are matched; the skinned session is never touched.
- **File diagnostics**: the GUI-subsystem host now writes `host-out.log` (timestamped, thread-safe) and captures panics to `host-crash.log`; a new `/api/open-log` endpoint plus a Studio toolbar button open the log file directly.
- **Opt-in Code-Codex switching**: the mode-switch entry is hidden by default so accidental clicks cannot close a running skinned session; enable it explicitly in Settings.

### Changed
- Connection status shows a neutral "detecting…" state until the first probe completes — no more brief red flash while the startup self-check is still healing.
- Host internals split into dedicated `log` and `proc` modules; new application icons.
- Dynamic-effects script (v5) refinements.

### Fixed
- No more flashing console windows: every background child process (PowerShell probes, workspace bridge) is spawned with `CREATE_NO_WINDOW`.
- Runtime state (`fusion-config.json` seed, `last-ensure-result.json`) is now written atomically, so a crash mid-write can no longer leave truncated JSON.
- The ChatGPT process probe is cached for 2 seconds; frontend health polling no longer spawns a PowerShell process per request.

## [0.2.0] - 2026-09-28

Open-source baseline.

### Added
- Portable path resolution: install root auto-detected from the executable (or `CODEX_FUSION_ROOT`), no machine-specific paths compiled in.
- `fusion-config.example.json` template; the host seeds a local `fusion-config.json` from it on first run.
- Environment overrides: `CODEX_FUSION_ROOT`, `CODEX_CODEX_PATH`, `CODEX_FUSION_BRIDGE`.
- GitHub Actions CI (frontend build + vitest, `cargo check --locked` + `cargo fmt`).
- MIT `LICENSE`, root `.gitignore`, English + Chinese README, `CHANGELOG.md`.

### Changed
- Tray menu simplified: left-click opens the Studio; removed the duplicate "theme panel" entry that opened a browser.
- Tray wording: "打开工作台" / "重启 Codex（带皮肤）".
- Clearer connection-status copy (connected / no-CDP / not-running states).
- UI empty state explains how to apply themes to Codex.

### Fixed
- Cold-start race: startup self-check is serialized behind a global lock, so the host and the frontend can no longer trigger duplicate Codex ensure runs.
- Single-instance launch now reliably focuses the existing window (AttachThreadInput + SwitchToThisWindow fallback).
- Closing the window hides to tray instead of exiting; real exit lives in the tray menu.

### Removed
- Machine-specific hard-coded paths (`D:\CodexFusion`, `C:\Users\ROG\...`) from the host source.
- Stale backup copies, probe/scratch scripts, and root-level test output files.
