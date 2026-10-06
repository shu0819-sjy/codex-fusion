# Codex Fusion

Codex Fusion is a Windows desktop companion for official Codex. It provides local wallpaper themes, dynamic effects, a bounded workspace shell, and a Tauri/Rust host without replacing the official Codex installation.

> Status: **v0.3.0**. The supported desktop target is Windows 10/11. The frontend can be built on other operating systems, but the Codex process integration, tray workflow, and PowerShell test suite are Windows-specific and are not advertised as native macOS/Linux support.

## Features

- **Theme Studio**: browse, create, preview, and apply local Dream Skin themes;
- **Dynamic effects**: rain, particles, snow, fog, and related effects through Codex CDP;
- **Foreign-session guard**: detect unskinned official Codex sessions and close them only after a user action;
- **File diagnostics**: open `host-out.log` and `host-crash.log` from the Studio;
- **Single entry point**: launch the Fusion host, theme service, and optional CDP injection together;
- **Native tray**: close to tray, restore, and restart Codex with the configured skin;
- **Bounded workspace**: optional workspace bridge rooted at the configured workspace directory.

## Requirements and support boundary

For the full desktop application:

- Windows 10 or Windows 11;
- Node.js 20 LTS or newer (Node 22 is covered by CI);
- npm 10 or newer; use the committed `package-lock.json` files;
- Rust stable with the Windows Tauri prerequisites;
- An installed official Codex package;
- Optional: [Code-Codex](https://github.com/Rice-dog/code-codex) for workspace bridge mode.

The frontend build and tests are exercised on Ubuntu, Windows, and macOS in CI. The Rust host and process/tray integration remain Windows-only in this release. Do not infer native macOS/Linux host support from the frontend matrix.

## Reproducible bootstrap

The repository uses npm consistently. Do not mix `pnpm install` with the checked-in npm lockfiles. From the repository root, create a local configuration first:

```powershell
copy fusion-config.example.json fusion-config.json
```

Edit `fusion-config.json` and set `workspace` to an existing directory. Keep this file local; it is ignored by Git because it contains machine-specific paths.

Install and build the frontend with the lockfile:

```powershell
cd frontend
npm ci
npm run build
npm test
```

Install the Tauri CLI with its own lockfile, then build the Windows host:

```powershell
cd ..\host
npm ci
cd src-tauri
cargo build --release
```

The host points at `frontend/dist`, so build the frontend before `cargo build`. The output executable is `host\src-tauri\target\release\codex-fusion-host.exe`. Start it with:

```powershell
cd ..\..
.\start-codex-fusion.cmd
```

For development mode, use the Tauri CLI from the host directory:

```powershell
cd host
npm run dev
```

The workspace bridge is optional. If you need it, clone the upstream repository separately, build only `workspace-service`, and point `CODEX_FUSION_BRIDGE` to the resulting executable. Do not commit the bridge binary or third-party checkout.

## Configuration

Start from [`fusion-config.example.json`](./fusion-config.example.json):

| Key | Meaning |
|---|---|
| `workspace` | Existing directory that bounds workspace operations; it must be a directory. |
| `dreamSkinPort` | Theme service port; the host validates the allowed range and fixed CDP relationship. |
| `dreamSkinStateRoot` | Local state directory; the host creates it if missing. |
| `safeMode` | Must remain `true`; disabling bounded workspace checks is rejected. |
| `version` | Configuration template version; update it with the repository release. |

Optional environment overrides are `CODEX_FUSION_ROOT`, `CODEX_CODEX_PATH`, and `CODEX_FUSION_BRIDGE`. Use absolute paths when overriding an executable. Diagnostics are written under the install root and are ignored by Git.

## Tests and CI

Local frontend checks:

```powershell
cd frontend
npm ci
npm run build
npm test
```

The CI workflow runs frontend install/build/tests on Ubuntu, Windows, and macOS with Node 20 and 22. It separately runs Rust `cargo check`, tests, Clippy, and formatting on Windows, dynamic-effects Node tests on Ubuntu, and the Pester process-switch suite on Windows. Hosted non-Windows jobs cover the frontend only; they do not prove native desktop support.

## Safety boundaries

- Does not patch or replace the official Codex binary;
- Process termination paths are scoped by executable path and profile, not process name alone;
- Theme application and Codex restart require a user-triggered action;
- Workspace operations stay under the configured root;
- `fusion-config.json`, logs, state, third-party copies, and generated binaries stay out of version control.

## Project layout

```text
frontend/                 # React/Vite Theme Studio and workspace UI
host/src-tauri/            # Tauri 2 Rust host and Windows integration
host/package.json          # Tauri CLI, installed with host/package-lock.json
host/src-tauri/Cargo.toml  # Rust dependencies
tests/                     # PowerShell/Pester process tests
fusion-config.example.json # Safe configuration template
licenses/                  # Third-party notices
```

## License and disclaimer

MIT, see [LICENSE](./LICENSE). Third-party components retain the licenses in `licenses/`. This is an unofficial community tool and is not affiliated with OpenAI. Use it at your own risk.
