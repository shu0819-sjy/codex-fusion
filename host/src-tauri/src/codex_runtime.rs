use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::injector;

/// 本次启动是否发生过"外来会话自动恢复"：宿主后台自检先自愈，前端启动自检随后
/// 执行（端口已就绪、不再恢复），该标记让报告与提示如实反映本次启动的自愈事实。
static STARTUP_RECOVERED: AtomicBool = AtomicBool::new(false);

const SKIN_VERSION: &str = "1.5.16-fusion";
const RENDERER_INJECT_JS: &str = include_str!("../assets/renderer-inject.js");
const DREAM_SKIN_CSS: &str = include_str!("../assets/dream-skin.css");
const DYNAMIC_EFFECTS_CSS: &str = include_str!("../assets/dynamic-effects.v5.css");
const DYNAMIC_EFFECTS_JS: &str = include_str!("../assets/dynamic-effects.v5.js");

fn state_root() -> PathBuf {
    crate::runtime_state_root()
}
fn state_path() -> PathBuf {
    state_root().join("state.json")
}
fn active_theme_dir() -> PathBuf {
    state_root().join("active-theme")
}
fn themes_dir() -> PathBuf {
    state_root().join("themes")
}
fn profile_path() -> PathBuf {
    state_root().join("cdp-profile")
}
fn default_port() -> u16 {
    9335
}

fn read_state() -> Value {
    fs::read_to_string(state_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}))
}
fn write_state(mut state: Value) -> Result<(), String> {
    if let Some(obj) = state.as_object_mut() {
        obj.insert("schemaVersion".into(), json!(3));
        obj.insert("platform".into(), json!("windows"));
        obj.insert("updatedAt".into(), json!(timestamp()));
        obj.remove("injectorPid");
        obj.remove("injectorPath");
        obj.remove("nodePath");
        obj.remove("nodeVersion");
        obj.remove("notificationBridgePid");
        obj.remove("notificationBridgePath");
        obj.insert("host".into(), json!("codex-fusion"));
    }
    fs::create_dir_all(state_root()).map_err(|e| e.to_string())?;
    atomic_write_json(&state_path(), &state)
}
fn timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

/// 原子写文件：先写同目录临时文件再 rename，避免进程崩溃/断电把 JSON 写坏成半截。
pub(crate) fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("state");
    let tmp = path.with_file_name(format!("{file_name}.{}.tmp", std::process::id()));
    fs::write(&tmp, bytes).map_err(|e| format!("写临时文件失败：{e}"))?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("原子替换文件失败：{e}"));
    }
    Ok(())
}

pub(crate) fn atomic_write_json(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    atomic_write_bytes(path, &bytes)
}

fn resolve_codex_exe(state: &Value) -> Result<PathBuf, String> {
    if let Some(exe) = state.get("codexExe").and_then(Value::as_str) {
        let path = PathBuf::from(exe);
        if path.is_file() {
            return Ok(path);
        }
    }
    // Discover via Appx (transient powershell; does not leave a background process).
    let mut ps = Command::new("powershell.exe");
    crate::proc::hide_console(&mut ps);
    let output = ps
    .args(["-NoProfile","-NonInteractive","-Command",
      "$p=Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1; if(-not $p){exit 2}; $exe=Join-Path $p.InstallLocation 'app\\ChatGPT.exe'; if(-not (Test-Path -LiteralPath $exe)){exit 3}; Write-Output $exe"])
    .output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("找不到已安装的官方 OpenAI.Codex（ChatGPT.exe）".into());
    }
    let exe = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let path = PathBuf::from(&exe);
    if !path.is_file() {
        return Err(format!("Codex 可执行文件无效：{exe}"));
    }
    Ok(path)
}

/// 仅结束归属 Dream Skin 档案的 Codex 进程；绝不按进程名批量杀。
/// 入参：期望的 user-data-dir（cdp-profile）与 CDP 端口；返回：结束结果 JSON 文本。
/// 边界：命令行须同时包含档案路径与调试端口才可杀；无归属证据的进程一律跳过。
fn stop_owned_dream_skin_chatgpt(profile: &Path, port: u16) -> Result<String, String> {
    let profile_token = profile.display().to_string().replace('\'', "''");
    let script = format!(
    "$ErrorActionPreference='Continue'; $profile = [string]'{profile}'; $port = {port}; $profileFull = [IO.Path]::GetFullPath($profile); $stopped = New-Object System.Collections.ArrayList; $skipped = New-Object System.Collections.ArrayList; $procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe'\" -ErrorAction SilentlyContinue); foreach ($p in $procs) {{ $cmd = [string]$p.CommandLine; if ([string]::IsNullOrWhiteSpace($cmd)) {{ [void]$skipped.Add([int]$p.ProcessId); continue }}; $hasProfile = $cmd.IndexOf($profileFull, [StringComparison]::OrdinalIgnoreCase) -ge 0; $hasPort = ($cmd -match ('--remote-debugging-port=' + [regex]::Escape([string]$port))); if ($hasProfile -and $hasPort) {{ try {{ Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction Stop; [void]$stopped.Add([int]$p.ProcessId) }} catch {{ [void]$skipped.Add([int]$p.ProcessId) }} }} else {{ [void]$skipped.Add([int]$p.ProcessId) }} }}; (@{{ stopped = @($stopped); skipped = @($skipped); ownedStopped = ($stopped.Count -gt 0) }} | ConvertTo-Json -Compress)",
    profile = profile_token,
    port = port
  );
    let mut ps = Command::new("powershell.exe");
    crate::proc::hide_console(&mut ps);
    let output = ps
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .output()
        .map_err(|e| format!("结束归属 Codex 失败：{e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("结束归属 Codex 脚本失败：{}", err.trim()));
    }
    thread::sleep(Duration::from_millis(800));
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if text.is_empty() {
        "{\"stopped\":[],\"skipped\":[],\"ownedStopped\":false}".into()
    } else {
        text
    })
}

fn launch_codex(exe: &Path, port: u16, profile: &Path) -> Result<(), String> {
    fs::create_dir_all(profile).map_err(|e| e.to_string())?;
    let args = [
        "--remote-debugging-address=127.0.0.1".to_string(),
        format!("--remote-debugging-port={port}"),
        format!("--user-data-dir={}", profile.display()),
    ];
    Command::new(exe)
        .args(&args)
        .spawn()
        .map_err(|e| format!("启动 Codex 失败：{e}"))?;
    Ok(())
}

fn wait_for_cdp(port: u16, timeout: Duration) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    let mut last = "waiting".to_string();
    while Instant::now() < deadline {
        match injector::browser_id(port) {
            Ok(id) if injector::cdp_ready(port) => return Ok(id),
            Ok(_) => last = "browser id ok but no app:// target yet".into(),
            Err(e) => last = e,
        }
        thread::sleep(Duration::from_millis(400));
    }
    Err(format!(
        "Codex 未在 {} 秒内暴露 CDP {port}: {last}",
        timeout.as_secs()
    ))
}

fn simple_hash(bytes: &[u8]) -> String {
    // Lightweight non-crypto stamp for payload revision.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/jpeg",
    }
}

fn build_skin_payload() -> Result<String, String> {
    let theme_dir = active_theme_dir();
    let theme: Value = fs::read_to_string(theme_dir.join("theme.json")).ok()
    .and_then(|t| serde_json::from_str(&t).ok())
    .unwrap_or_else(|| json!({"schemaVersion":1,"id":"default","name":"默认","appearance":"auto","image":"art.jpg"}));
    let image_name = theme
        .get("image")
        .and_then(Value::as_str)
        .unwrap_or("art.jpg");
    let image_path = theme_dir.join(image_name);
    let image_bytes = fs::read(&image_path).unwrap_or_default();
    let art = if image_bytes.is_empty() {
        String::new()
    } else {
        use base64::Engine;
        format!(
            "data:{};base64,{}",
            mime_for(&image_path),
            base64::engine::general_purpose::STANDARD.encode(&image_bytes)
        )
    };
    let safe_css = fs::read_to_string(theme_dir.join("theme.css")).unwrap_or_default();
    let combined_css = format!("{DREAM_SKIN_CSS}\n{safe_css}\n{DYNAMIC_EFFECTS_CSS}\n");
    let effect_state = fs::read_to_string(state_root().join("active-effect.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let effect_bootstrap = if let Some(effect) = effect_state
        .as_ref()
        .and_then(|v| v.get("effect"))
        .and_then(Value::as_str)
    {
        let config = effect_state
            .as_ref()
            .and_then(|v| v.get("config"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        format!(";(()=>{{const r=document.documentElement;r.setAttribute('data-ds-effect',{});r.setAttribute('data-ds-effect-config',{});}})();",
      serde_json::to_string(effect).unwrap(), serde_json::to_string(&serde_json::to_string(&config).unwrap()).unwrap())
    } else {
        String::new()
    };
    let combined_js = format!("{RENDERER_INJECT_JS}\n{effect_bootstrap}\n;{DYNAMIC_EFFECTS_JS}\n");
    let style_revision = simple_hash(combined_css.as_bytes());
    let payload_revision =
        simple_hash(format!("{SKIN_VERSION}{combined_css}{combined_js}{theme}").as_bytes());
    let mut payload = combined_js;
    // Function-style replace semantics: avoid $ interpretation by using split/join via manual replace loops.
    for (token, value) in [
        (
            "__DREAM_SKIN_CSS_JSON__",
            serde_json::to_string(&combined_css).unwrap(),
        ),
        (
            "__DREAM_SKIN_ART_JSON__",
            serde_json::to_string(&art).unwrap(),
        ),
        (
            "__DREAM_SKIN_THEME_JSON__",
            serde_json::to_string(&theme).unwrap(),
        ),
        (
            "__DREAM_SKIN_VERSION_JSON__",
            serde_json::to_string(SKIN_VERSION).unwrap(),
        ),
        (
            "__DREAM_SKIN_STYLE_REVISION_JSON__",
            serde_json::to_string(&style_revision).unwrap(),
        ),
        (
            "__DREAM_SKIN_PAYLOAD_REVISION_JSON__",
            serde_json::to_string(&payload_revision).unwrap(),
        ),
    ] {
        payload = payload.replace(token, &value);
    }
    if payload.contains("__DREAM_SKIN_") {
        return Err("皮肤注入模板占位符未完全替换".into());
    }
    Ok(payload)
}

pub fn inject_active_skin(port: u16, browser_id: Option<&str>) -> Result<Value, String> {
    let payload = build_skin_payload()?;
    injector::evaluate_on_app_targets(port, &payload, browser_id)
}

/// 判断进程命令行是否使用了给定档案（忽略大小写、容忍 \\?\ verbatim 前缀差异）。
/// 入参：进程命令行、期望档案路径；返回：是否匹配。边界：空串不匹配。
fn cmdline_matches_profile(cmd: &str, profile: &str) -> bool {
    if cmd.is_empty() || profile.is_empty() {
        return false;
    }
    let profile_lower = profile.to_lowercase();
    let cmd_lower = cmd.to_lowercase();
    if cmd_lower.contains(&profile_lower) {
        return true;
    }
    // state.json 的 profilePath 常带 \\?\ 前缀而命令行是普通路径：去掉前缀再宽松匹配。
    let plain = profile_lower.trim_start_matches(r"\\?\");
    !plain.is_empty() && cmd_lower.contains(plain)
}

/// 探测当前 ChatGPT 进程归属：owned=使用我们 cdp-profile 档案的会话；foreign=其余 ChatGPT 会话。
/// 入参：期望档案路径；返回：(owned, foreign)；边界：查询失败视为无会话，交由后续流程兜底。
fn chatgpt_session_state(profile: &Path) -> (bool, bool) {
    let script = "$ErrorActionPreference='SilentlyContinue'; $procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe'\" -ErrorAction SilentlyContinue); $cmds = @(); foreach ($p in $procs) { $cmd = [string]$p.CommandLine; if (-not [string]::IsNullOrWhiteSpace($cmd)) { $cmds += $cmd } }; ConvertTo-Json -Compress -InputObject $cmds";
    let mut ps = Command::new("powershell.exe");
    crate::proc::hide_console(&mut ps);
    let output = ps
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let value: Value =
                serde_json::from_str(&String::from_utf8_lossy(&o.stdout)).unwrap_or_default();
            let cmds: Vec<String> = value
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let profile_full = profile.display().to_string();
            let owned = cmds
                .iter()
                .any(|c| cmdline_matches_profile(c, &profile_full));
            let foreign = cmds
                .iter()
                .any(|c| !cmdline_matches_profile(c, &profile_full));
            (owned, foreign)
        }
        _ => (false, false),
    }
}

/// 探测外来（非归属档案、且未启用调试端口）ChatGPT 会话的进程 PID 列表。
/// 入参：期望档案路径；返回：外来 PID 列表（按命令行精确判定，绝不按进程名）；
/// 边界：带调试端口但非归属档案的实例视为其他工具在用，不在候选内；查询失败返回空。
pub fn foreign_codex_pids(profile: &Path) -> Vec<u32> {
    let script = "$ErrorActionPreference='SilentlyContinue'; $procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe'\" -ErrorAction SilentlyContinue); $rows = @(); foreach ($p in $procs) { $cmd = [string]$p.CommandLine; if (-not [string]::IsNullOrWhiteSpace($cmd)) { $rows += [pscustomobject]@{ pid = [int]$p.ProcessId; cmd = $cmd } } }; ConvertTo-Json -Compress -InputObject $rows";
    let mut ps = Command::new("powershell.exe");
    crate::proc::hide_console(&mut ps);
    let output = ps
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output();
    let Ok(o) = output else {
        return Vec::new();
    };
    if !o.status.success() {
        return Vec::new();
    }
    let value: Value =
        serde_json::from_str(&String::from_utf8_lossy(&o.stdout)).unwrap_or_default();
    let profile_full = profile.display().to_string();
    value
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let pid = row.get("pid").and_then(Value::as_u64).unwrap_or(0);
                    let cmd = row.get("cmd").and_then(Value::as_str).unwrap_or("");
                    if pid == 0 || cmd.is_empty() {
                        return None;
                    }
                    // 归属档案或带调试端口的实例均不在外来候选内
                    if cmdline_matches_profile(cmd, &profile_full)
                        || cmd.to_lowercase().contains("--remote-debugging-port")
                    {
                        return None;
                    }
                    Some(pid as u32)
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn ensure_dream_skin_runtime(restart: bool) -> Result<Value, String> {
    let port = default_port();
    let profile = profile_path();
    let mut state = read_state();
    let exe = resolve_codex_exe(&state)?;
    // 自愈标记：检测到外来（非归属）Codex 会话运行但未启用调试端口时，自动并行启动归属会话。
    // 该标记跨本次启动内的多次自检保留：宿主后台自检先完成自愈，前端启动自检随后执行
    // （此时端口已就绪、本调用不再恢复），报告仍如实反映"本次启动已自动恢复"。
    let mut auto_recovered = STARTUP_RECOVERED.load(Ordering::Relaxed);

    // Match legacy ensure-dream-skin-mode.ps1 policy:
    // - restart=false never kills an existing Codex window
    // - restart=true (explicit /api/restart-codex) may stop ONLY owned Dream Skin Codex
    //   (executable cmdline contains cdp-profile + our debugging port); never by process name
    if restart {
        let stop_report = stop_owned_dream_skin_chatgpt(&profile, port)?;
        let tcp_up = std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(400),
        )
        .is_ok();
        if tcp_up {
            return Err(format!(
        "调试端口 {port} 仍被占用，且无法在不按进程名批量结束的前提下释放。已跳过非归属会话。详情：{stop_report}"
      ));
        }
        launch_codex(&exe, port, &profile)?;
    } else {
        // Prefer a cheap TCP probe first. Full CDP JSON probing can spawn many PowerShell
        // fallbacks and has been observed to AppHang the Tauri UI during startup.
        let tcp_up = std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(250),
        )
        .is_ok();
        if tcp_up {
            // 归属会话已在监听：无需重复启动。
        } else {
            // 自愈：按命令行归属区分会话，绝不按进程名批量处理。
            // - 归属会话（带 cdp-profile）存在但端口未监听：属异常中间态，要求显式重启，不自动再开一份（避免同档案冲突）；
            // - 外来会话（如点了官方图标启动、未带调试端口）：自动并行启动归属会话，皮肤即刻可用；
            // - 无任何 Codex：正常启动归属会话。
            let (owned, foreign) = chatgpt_session_state(&profile);
            if owned {
                return Err("检测到归属 Codex 会话存在但调试端口未监听。请使用 Fusion 的「重启 Codex」显式重启。".into());
            }
            auto_recovered = foreign || STARTUP_RECOVERED.load(Ordering::Relaxed);
            if foreign {
                STARTUP_RECOVERED.store(true, Ordering::Relaxed);
            }
            launch_codex(&exe, port, &profile)?;
        }
    }

    let browser_id = match injector::browser_id(port) {
        Ok(id) => id,
        Err(_) => wait_for_cdp(port, Duration::from_secs(20))?,
    };
    if let Some(obj) = state.as_object_mut() {
        obj.insert("port".into(), json!(port));
        obj.insert("browserId".into(), json!(browser_id));
        obj.insert("codexExe".into(), json!(exe.display().to_string()));
        if let Some(root) = exe.parent().and_then(|p| p.parent()) {
            obj.insert("codexPackageRoot".into(), json!(root.display().to_string()));
        }
        obj.insert("profilePath".into(), json!(profile.display().to_string()));
        obj.insert(
            "themeDir".into(),
            json!(active_theme_dir().display().to_string()),
        );
    }
    write_state(state.clone())?;

    // Defer heavy skin injection so the Tauri UI thread stays responsive during startup.
    // Explicit theme apply / restart-codex still inject immediately.
    let browser_for_inject = browser_id.clone();
    let should_inject_now = restart;
    let inject = if should_inject_now {
        inject_active_skin(port, Some(&browser_id))
            .map_err(|error| format!("Codex 已启动但皮肤注入失败：{error}"))?
    } else {
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(8));
            if let Err(error) = inject_active_skin(port, Some(browser_for_inject.as_str())) {
                crate::log::line(&format!("延迟皮肤注入失败：{error}"));
            }
        });
        json!({"ok":true,"deferred":true})
    };
    let message = if auto_recovered {
        "检测到官方 Codex 会话已运行（未启用调试端口），已自动启动带皮肤的归属会话，原会话保留。"
            .to_string()
    } else {
        "Codex Fusion 已确保 Dream Skin 运行时（单进程宿主注入）".to_string()
    };
    Ok(json!({
      "ok": true,
      "schemaVersion": 1,
      "action": "ensure-dream-skin-mode",
      "outcome": "success",
      "exitCode": 0,
      "mode": "dream-skin",
      "port": port,
      "browserId": browser_id,
      "codexExe": exe.display().to_string(),
      "profilePath": profile.display().to_string(),
      "injected": inject,
      "recovered": auto_recovered,
      "timestamp": timestamp(),
      "message": message
    }))
}

pub fn activate_saved_theme(theme_id: &str) -> Result<Value, String> {
    if theme_id.is_empty()
        || theme_id.contains('/')
        || theme_id.contains('\\')
        || theme_id.contains("..")
    {
        return Err("主题标识无效".into());
    }
    let src = themes_dir().join(theme_id);
    if !src.is_dir() {
        return Err("主题不存在".into());
    }
    let theme: Value = serde_json::from_str(
        &fs::read_to_string(src.join("theme.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let image_name = theme
        .get("image")
        .and_then(Value::as_str)
        .ok_or("主题缺少 image 字段")?;
    let image_src = src.join(image_name);
    if !image_src.is_file() {
        return Err("主题图片不存在".into());
    }

    let active = active_theme_dir();
    fs::create_dir_all(&active).map_err(|e| e.to_string())?;
    // Clear previous active image files (keep directory).
    if let Ok(entries) = fs::read_dir(&active) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.file_name().and_then(|n| n.to_str()) == Some("theme.json") {
                continue;
            }
            let _ = fs::remove_file(&path);
        }
    }
    let image_dst = active.join(image_name);
    fs::copy(&image_src, &image_dst).map_err(|e| e.to_string())?;
    let css_src = src.join("theme.css");
    if css_src.is_file() {
        fs::copy(&css_src, active.join("theme.css")).map_err(|e| e.to_string())?;
    } else {
        let _ = fs::remove_file(active.join("theme.css"));
    }
    let theme_value = serde_json::to_value(theme).unwrap_or_else(|_| json!({}));
    atomic_write_json(&active.join("theme.json"), &theme_value).map_err(|e| e.to_string())?;

    // Live inject if CDP is up; otherwise just persist active theme.
    if injector::cdp_ready(default_port()) {
        let browser = read_state()
            .get("browserId")
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        let injected = inject_active_skin(default_port(), browser.as_deref())?;
        Ok(json!({"ok":true,"id":theme_id,"injected":true,"result":injected}))
    } else {
        Ok(
            json!({"ok":true,"id":theme_id,"injected":false,"message":"主题已激活，等待 Codex CDP 就绪后注入"}),
        )
    }
}

pub fn set_active_theme_image(image_path: &Path) -> Result<(), String> {
    let active = active_theme_dir();
    fs::create_dir_all(&active).map_err(|e| e.to_string())?;
    let mut theme: Value = fs::read_to_string(active.join("theme.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(
            || json!({"schemaVersion":1,"id":"custom","name":"自定义主题","appearance":"auto"}),
        );
    let ext = image_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg");
    let image_name = format!("art-{}.{}", timestamp(), ext);
    let dst = active.join(&image_name);
    fs::copy(image_path, &dst).map_err(|e| e.to_string())?;
    if let Some(obj) = theme.as_object_mut() {
        if let Some(old) = obj.get("image").and_then(Value::as_str) {
            let old_path = active.join(old);
            if old_path != dst {
                let _ = fs::remove_file(old_path);
            }
        }
        obj.insert("image".into(), json!(image_name));
    }
    atomic_write_json(&active.join("theme.json"), &theme).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::cmdline_matches_profile;

    #[test]
    fn profile_match_verbatim_and_plain_forms() {
        let profile = r"\\?\C:\Users\ROG\AppData\Local\CodexDreamSkin\cdp-profile";
        // 命令行带 verbatim 前缀（--user-data-dir 原样传递）
        assert!(cmdline_matches_profile(
            r#""C:\Program Files\WindowsApps\OpenAI.Codex\app\ChatGPT.exe" --user-data-dir=\\?\C:\Users\ROG\AppData\Local\CodexDreamSkin\cdp-profile --remote-debugging-port=9335"#,
            profile
        ));
        // 命令行是普通路径（无 \\?\ 前缀）
        assert!(cmdline_matches_profile(
            r#"ChatGPT.exe --user-data-dir=C:\Users\ROG\AppData\Local\CodexDreamSkin\cdp-profile --remote-debugging-port=9335"#,
            profile
        ));
        // 大小写不敏感
        assert!(cmdline_matches_profile(
            r#"--USER-DATA-DIR=c:\users\rog\appdata\local\codexdreamskin\cdp-profile"#,
            profile
        ));
        // 外来会话（默认档案）不应匹配
        assert!(!cmdline_matches_profile(
            r#"ChatGPT.exe --remote-debugging-port=9222"#,
            profile
        ));
        // 空串边界
        assert!(!cmdline_matches_profile("", profile));
    }

    #[test]
    fn profile_match_no_verbatim_prefix_input() {
        let profile = r"C:\Users\ROG\AppData\Local\CodexDreamSkin\cdp-profile";
        assert!(cmdline_matches_profile(
            r#"--user-data-dir=C:\Users\ROG\AppData\Local\CodexDreamSkin\cdp-profile"#,
            profile
        ));
        assert!(!cmdline_matches_profile(
            r#"--user-data-dir=C:\Users\ROG\AppData\Local\Other\profile"#,
            profile
        ));
    }
}
