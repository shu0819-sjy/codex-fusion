# Changelog

All notable changes to Codex Fusion are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/), versioning: SemVer.

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
- Machine-specific hard-coded paths (`C:\codex-fusion`, `C:\Users\Example\...`) from the host source.
- Stale backup copies, probe/scratch scripts, and root-level test output files.
