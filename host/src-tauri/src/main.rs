#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, State};
mod codex_runtime;
mod injector;
mod theme_service;

use std::sync::OnceLock;

const THEME_PORT: u16 = 17890;
const DREAM_SKIN_CDP_PORT: u16 = 9335;

fn local_app_data_fallback() -> String {
    std::env::var("USERPROFILE")
        .map(|u| format!("{u}\\AppData\\Local"))
        .unwrap_or_else(|_| r"C:\ProgramData".into())
}

fn resolve_fusion_root() -> PathBuf {
    if let Ok(v) = std::env::var("CODEX_FUSION_ROOT") {
        let p = PathBuf::from(v);
        if p.is_dir() {
            return p;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        for _ in 0..8 {
            if let Some(ref d) = dir {
                if d.join("fusion-config.json").is_file()
                    || d.join("fusion-config.example.json").is_file()
                    || (d.join("frontend").is_dir() && d.join("host").is_dir())
                {
                    return d.clone();
                }
                dir = d.parent().map(|p| p.to_path_buf());
            } else {
                break;
            }
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// 安装根目录：优先环境变量 CODEX_FUSION_ROOT，否则从可执行文件向上探测。
pub fn fusion_root() -> PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(resolve_fusion_root).clone()
}

fn config_path() -> PathBuf {
    fusion_root().join("fusion-config.json")
}

fn bridge_path() -> PathBuf {
    if let Ok(v) = std::env::var("CODEX_FUSION_BRIDGE") {
        return PathBuf::from(v);
    }
    fusion_root().join("bin").join("fusion-bridge.exe")
}

fn code_codex_path() -> PathBuf {
    if let Ok(v) = std::env::var("CODEX_CODEX_PATH") {
        return PathBuf::from(v);
    }
    PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_else(|_| local_app_data_fallback()))
        .join("Programs")
        .join("Code-Codex")
        .join("CodeCodex.exe")
}

#[derive(Debug, Deserialize, Serialize)]
struct FusionConfig {
    workspace: String,
    #[serde(default = "default_dream_skin_port")]
    #[serde(rename = "dreamSkinPort")]
    dream_skin_port: u16,
    #[serde(default = "default_dream_skin_state_root")]
    #[serde(rename = "dreamSkinStateRoot")]
    dream_skin_state_root: String,
    #[serde(default = "default_safe_mode")]
    #[serde(rename = "safeMode")]
    safe_mode: bool,
    #[serde(default)]
    version: Option<String>,
}

fn default_dream_skin_port() -> u16 {
    DREAM_SKIN_CDP_PORT
}
fn default_dream_skin_state_root() -> String {
    PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default())
        .join("CodexDreamSkin")
        .display()
        .to_string()
}
fn default_safe_mode() -> bool {
    true
}

/// 读取并校验 fusion-config.json。
/// 入参：无；返回：合法配置；边界：路径穿越/不存在/端口越界/与主题端口冲突/关闭 safeMode 均拒绝。
fn load_fusion_config() -> Result<FusionConfig, String> {
    let config_file = config_path();
    let example = fusion_root().join("fusion-config.example.json");
    if !config_file.is_file() && example.is_file() {
        let mut seeded: FusionConfig = serde_json::from_str(
            &fs::read_to_string(&example).map_err(|error| format!("读取示例配置失败：{error}"))?,
        )
        .map_err(|error| format!("解析示例配置失败：{error}"))?;
        if seeded.workspace.contains("YOUR_") || seeded.workspace.trim().is_empty() {
            seeded.workspace = fusion_root().display().to_string();
        }
        if seeded.dream_skin_state_root.contains("YOUR_")
            || seeded.dream_skin_state_root.trim().is_empty()
        {
            seeded.dream_skin_state_root = PathBuf::from(
                std::env::var("LOCALAPPDATA").unwrap_or_else(|_| local_app_data_fallback()),
            )
            .join("CodexDreamSkin")
            .display()
            .to_string();
        }
        fs::write(
            &config_file,
            serde_json::to_string_pretty(&seeded)
                .map_err(|error| format!("写入默认配置失败：{error}"))?,
        )
        .map_err(|error| format!("写入默认配置失败：{error}"))?;
    }
    let config_text = fs::read_to_string(&config_file)
        .map_err(|error| format!("读取配置失败（{}）：{error}", config_file.display()))?;
    let mut config: FusionConfig =
        serde_json::from_str(&config_text).map_err(|error| format!("解析配置失败：{error}"))?;
    let workspace = PathBuf::from(&config.workspace);
    let workspace = workspace
        .canonicalize()
        .map_err(|error| format!("工作区路径无效或不可访问：{} ({error})", config.workspace))?;
    if !workspace.is_dir() {
        return Err(format!("工作区不是目录：{}", workspace.display()));
    }
    config.workspace = workspace.display().to_string();
    if !(1024..=65535).contains(&config.dream_skin_port) {
        return Err(format!(
            "dreamSkinPort 超出允许范围：{}",
            config.dream_skin_port
        ));
    }
    if config.dream_skin_port == THEME_PORT {
        return Err(format!(
            "dreamSkinPort 不能与主题服务端口 {THEME_PORT} 相同"
        ));
    }
    if config.dream_skin_port != DREAM_SKIN_CDP_PORT {
        return Err(format!(
      "dreamSkinPort={} 与宿主固定 CDP 端口 {DREAM_SKIN_CDP_PORT} 不一致；本轮不允许漂移，请改回 {DREAM_SKIN_CDP_PORT}",
      config.dream_skin_port
    ));
    }
    let state_root = PathBuf::from(&config.dream_skin_state_root);
    if config.dream_skin_state_root.trim().is_empty()
        || config.dream_skin_state_root.contains('\0')
        || config.dream_skin_state_root.contains("..")
    {
        return Err("dreamSkinStateRoot 不合法".into());
    }
    if !state_root.exists() {
        return Err(format!(
            "dreamSkinStateRoot 不存在：{}",
            state_root.display()
        ));
    }
    if !config.safe_mode {
        return Err("safeMode=false 已被拒绝：Fusion 要求始终限制在工作区根内".into());
    }
    Ok(config)
}

struct BridgeProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Drop for BridgeProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// 桥接进程可能不存在（启动失败时降级，主题工作台仍可正常使用）。
struct BridgeState(Mutex<Option<BridgeProcess>>);

/// 单实例保护：使用 Windows 命名互斥体检测是否已有实例在运行。
/// 已存在实例时把已有窗口带回前台并返回 true，调用方应立即退出。
/// 入参：无；返回：是否已存在运行中的实例；边界：互斥体创建失败时放行，避免误伤。
#[cfg(windows)]
mod single_instance {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(
            lpMutexAttributes: *const c_void,
            bInitialOwner: i32,
            lpName: *const u16,
        ) -> *mut c_void;
        fn GetLastError() -> u32;
        fn GetCurrentThreadId() -> u32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(lpClassName: *const u16, lpWindowName: *const u16) -> *mut c_void;
        fn ShowWindow(hwnd: *mut c_void, nCmdShow: i32) -> i32;
        fn SetForegroundWindow(hwnd: *mut c_void) -> i32;
        fn GetForegroundWindow() -> *mut c_void;
        fn GetWindowThreadProcessId(hwnd: *mut c_void, lpdwProcessId: *mut u32) -> u32;
        fn AttachThreadInput(idAttach: u32, idAttachTo: u32, fAttach: i32) -> i32;
        fn SwitchToThisWindow(hwnd: *mut c_void, fAltTab: i32);
    }

    const ERROR_ALREADY_EXISTS: u32 = 183;
    const SW_RESTORE: i32 = 9;
    const MUTEX_NAME: &str = "Local\\CodexFusionHostInstance";
    const WINDOW_TITLE: &str = "Dream Skin 壁纸主题工作台";

    pub fn check_existing_instance() -> bool {
        let mutex_name: Vec<u16> = MUTEX_NAME
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: 标准命名互斥体探测；句柄保持到进程退出由系统回收，首个实例借此持有互斥。
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr()) };
        if handle.is_null() {
            return false;
        }
        let already_exists = unsafe { GetLastError() == ERROR_ALREADY_EXISTS };
        if !already_exists {
            return false;
        }
        // 把已有实例的窗口带回前台（找不到窗口则静默跳过）
        let title: Vec<u16> = WINDOW_TITLE
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: 按标题查找本机窗口，仅做前台提示，不持有窗口资源。
        let existing = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
        if !existing.is_null() {
            unsafe {
                ShowWindow(existing, SW_RESTORE);
                // SetForegroundWindow 受系统前台锁定限制常被静默忽略（表现为「点了没反应」）：
                // 先 AttachThreadInput 借用前台线程的输入态再切换，最后用 SwitchToThisWindow 兜底。
                let this_thread = GetCurrentThreadId();
                let foreground = GetForegroundWindow();
                let mut foreground_pid: u32 = 0;
                let foreground_thread = if foreground.is_null() {
                    0
                } else {
                    GetWindowThreadProcessId(foreground, &mut foreground_pid)
                };
                let attached = foreground_thread != 0
                    && foreground_thread != this_thread
                    && AttachThreadInput(this_thread, foreground_thread, 1) != 0;
                SetForegroundWindow(existing);
                if attached {
                    AttachThreadInput(this_thread, foreground_thread, 0);
                }
                SwitchToThisWindow(existing, 0);
            }
        }
        true
    }
}

/// 读取桌面容器配置并启动受限 Rust 桥接进程。
/// 入参：无；返回：桥接进程句柄或启动错误；边界：配置、桥接文件缺失时明确失败。
fn start_bridge() -> Result<BridgeProcess, String> {
    let config = load_fusion_config()?;
    let bridge_path = bridge_path();
    if !bridge_path.is_file() {
        return Err(format!("找不到 Rust 桥接程序：{}", bridge_path.display()));
    }
    let mut command = Command::new(&bridge_path);
    command
        .arg(config.workspace)
        .current_dir(fusion_root())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 Rust 桥接失败：{error}"))?;
    let stdin = child.stdin.take().ok_or("无法取得桥接标准输入")?;
    let stdout = child.stdout.take().ok_or("无法取得桥接标准输出")?;
    Ok(BridgeProcess {
        child,
        stdin,
        stdout: BufReader::new(stdout),
    })
}

/// 等待本机回环端口可连接（用于主题服务就绪探测，避免前端首屏请求撞上服务未启动）。
/// 入参：端口号与总超时；返回：是否在超时内就绪；边界：超时返回 false，不阻塞主流程。
fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let started = Instant::now();
    loop {
        if TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(100),
        )
        .is_ok()
        {
            return true;
        }
        if started.elapsed() > timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// 主题代理允许的方法+路径（精确匹配）与预览前缀。
/// 即使代理会附带可信 Origin，也不得把任意路径转发给主题服务。
fn theme_path_allowed(method: &str, path: &str) -> bool {
    const ALLOWED: &[(&str, &str)] = &[
        ("GET", "/api/health"),
        ("GET", "/api/themes"),
        ("GET", "/api/effect/current"),
        ("GET", "/api/effects"),
        ("GET", "/api/active-preview"),
        ("GET", "/api/open-dir"),
        ("POST", "/api/restart-codex"),
        ("POST", "/api/themes/apply"),
        ("POST", "/api/themes/delete"),
        ("POST", "/api/themes/create"),
        ("POST", "/api/background"),
        ("POST", "/api/effect"),
        ("POST", "/api/effects/apply"),
        ("POST", "/api/effects/create"),
        ("POST", "/api/effects/update"),
        ("POST", "/api/effects/delete"),
    ];
    if let Some((base, query)) = path.split_once('?') {
        // 仅允许 /api/themes?q=... 这种已知查询
        if method == "GET" && base == "/api/themes" && query.starts_with("q=") {
            return query.len() <= 200 && !query.contains('\r') && !query.contains('\n');
        }
        return false;
    }
    if method == "GET" && path.starts_with("/api/preview/") {
        let id = &path["/api/preview/".len()..];
        return !id.is_empty()
            && id.len() <= 120
            && id
                .bytes()
                .enumerate()
                .all(|(i, c)| c.is_ascii_alphanumeric() || (i > 0 && (c == b'_' || c == b'-')));
    }
    ALLOWED.iter().any(|(m, p)| *m == method && *p == path)
}

/// 通过本机回环地址代理 Dream Skin JSON API。
/// 入参：HTTP 方法、受控路径和可选 JSON 请求体；返回：解析后的 JSON；边界：拒绝未白名单路径、跨主机路径和非 JSON 响应。
fn send_theme_request(method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    if !path.starts_with('/') || path.contains('\r') || path.contains('\n') || path.contains("..") {
        return Err("主题请求路径不合法".to_string());
    }
    if !theme_path_allowed(method, path) {
        return Err(format!("主题请求不在允许列表中：{method} {path}"));
    }
    let payload = body
        .map(|value| {
            serde_json::to_string(&value).map_err(|error| format!("主题请求序列化失败：{error}"))
        })
        .transpose()?;
    let payload = payload.unwrap_or_default();
    let request = format!(
    "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{THEME_PORT}\r\nOrigin: http://127.0.0.1:{THEME_PORT}\r\nReferer: http://127.0.0.1:{THEME_PORT}/\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
    payload.len()
  );
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", THEME_PORT))
        .map_err(|error| format!("连接主题服务失败：{error}"))?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(8)))
        .map_err(|error| format!("设置主题读取超时失败：{error}"))?;
    stream
        .set_write_timeout(Some(std::time::Duration::from_secs(8)))
        .map_err(|error| format!("设置主题写入超时失败：{error}"))?;
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("写入主题请求失败：{error}"))?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("读取主题响应失败：{error}"))?;
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("主题响应格式不合法")?;
    let header = String::from_utf8(response[..header_end].to_vec())
        .map_err(|_| "主题响应头不是 UTF-8".to_string())?;
    let raw_body = &response[header_end + 4..];
    let response_body = if header
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        decode_chunked_body(raw_body)?
    } else {
        raw_body.to_vec()
    };
    let status = header
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or("主题响应状态码缺失")?;
    let response_text =
        String::from_utf8(response_body).map_err(|_| "主题响应不是 UTF-8".to_string())?;
    let value: Value = serde_json::from_str(response_text.trim())
        .map_err(|error| format!("解析主题响应失败：{error}"))?;
    if !(200..300).contains(&status) {
        return Err(format!("主题服务返回 HTTP {status}: {value}"));
    }
    Ok(value)
}

/// 解码 HTTP 分块传输正文。
/// 入参：带分块长度和 CRLF 的原始正文；返回：拼接后的 JSON 字节；边界：长度、终止块或分隔符异常时返回错误。
fn decode_chunked_body(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut cursor = 0usize;
    let mut output = Vec::new();
    loop {
        let line_end = input[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or("主题分块长度缺失")?
            + cursor;
        let size_text = std::str::from_utf8(&input[cursor..line_end])
            .map_err(|_| "主题分块长度不是 UTF-8")?
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| "主题分块长度不合法")?;
        cursor = line_end + 2;
        if size == 0 {
            return Ok(output);
        }
        if input.len() < cursor + size + 2 || &input[cursor + size..cursor + size + 2] != b"\r\n" {
            return Err("主题分块正文不完整".to_string());
        }
        output.extend_from_slice(&input[cursor..cursor + size]);
        cursor += size + 2;
    }
}

/// 将一次 JSON 请求转发给 fusion-bridge 并读取一行响应。
/// 入参：前端传入的 JSON 对象和桥接状态；返回：桥接响应 JSON；边界：桥接进程不可用、进程退出或响应非法时返回错误。
#[tauri::command]
fn workspace_request(request: Value, state: State<'_, BridgeState>) -> Result<Value, String> {
    const WORKSPACE_METHODS: &[&str] = &[
        "workspace.context",
        "workspace.list",
        "workspace.preview",
        "workspace.save",
        "workspace.create",
        "workspace.rename",
        "workspace.move",
        "workspace.copy",
        "workspace.delete",
    ];
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    if !WORKSPACE_METHODS.contains(&method) {
        return Err(format!("工作区方法不在允许列表中：{method}"));
    }
    let mut guard = state.0.lock().map_err(|_| "桥接状态锁定失败".to_string())?;
    let bridge = guard
    .as_mut()
    .ok_or_else(|| "Rust 桥接进程不可用：请检查 bin\\fusion-bridge.exe 与 fusion-config.json 后重新启动应用".to_string())?;
    let payload =
        serde_json::to_string(&request).map_err(|error| format!("序列化请求失败：{error}"))?;
    bridge
        .stdin
        .write_all(format!("{payload}\n").as_bytes())
        .map_err(|error| format!("写入桥接请求失败：{error}"))?;
    bridge
        .stdin
        .flush()
        .map_err(|error| format!("刷新桥接请求失败：{error}"))?;
    let mut response_line = String::new();
    let bytes_read = bridge
        .stdout
        .read_line(&mut response_line)
        .map_err(|error| format!("读取桥接响应失败：{error}"))?;
    if bytes_read == 0 {
        return Err("Rust 桥接进程已退出".to_string());
    }
    serde_json::from_str(response_line.trim()).map_err(|error| format!("解析桥接响应失败：{error}"))
}

/// 处理前端的主题管理请求。
/// 入参：HTTP 方法、主题 API 相对路径和 JSON 请求体；返回：主题服务 JSON；边界：仅允许本机固定端口。
#[tauri::command]
fn theme_request(method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    if method != "GET" && method != "POST" {
        return Err("主题请求方法不支持".to_string());
    }
    send_theme_request(&method, &path, body)
}

/// 模式切换脚本是唯一有权结束进程的组件；宿主只负责调用它并读取结构化结果。
const SWITCH_SCRIPT_TIMEOUT: Duration = Duration::from_secs(360);

/// 解析 switch-common.ps1 写出的结果 JSON。
/// 入参：结果文件文本；返回：若文本是对象则原样返回；边界：空文本或非对象返回 None。
fn parse_switch_result(text: &str) -> Option<Value> {
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(trimmed).ok()?;
    if value.is_object() {
        Some(value)
    } else {
        None
    }
}

/// 判断结果文件里是否带有脚本判定出的 outcome 字段（有则说明脚本已给出权威结论）。
/// 边界：切换脚本开工时会先写一条 outcome=running 的「进行中」标记。
/// 那只是中途痕迹而不是结论，必须排除，否则界面会把一次被中止的切换当成已经完成。
fn has_outcome(result: &Value) -> bool {
    match result.get("outcome").and_then(Value::as_str) {
        Some(outcome) => outcome != "running",
        None => false,
    }
}

/// 结果文件缺失时的兜底说明。
/// 入参：进程退出码与脚本 stderr；返回：面向用户的失败说明；边界：退出码含义固定，不猜测未定义码的语义。
fn describe_switch_failure(code: i32, stderr_text: &str) -> String {
    // 0=成功；1=意外内部失败；2=前置条件不满足；3=用户取消；4=已切换但验证未通过；5=回滚未通过
    let reason = match code {
        0 => "切换脚本未写出结果文件，无法确认切换结果。",
        2 => "切换被阻止：当前存在不允许自动关闭的 Codex 会话。",
        3 => "切换已取消，当前运行模式保持不变。",
        4 => "模式已切换，但效果验证未通过。",
        5 => "切换失败且未能恢复原来的模式，请手动恢复。",
        _ => "模式切换失败。",
    };
    let tail: String = stderr_text.trim().chars().take(400).collect();
    if tail.is_empty() {
        format!("{reason}（退出码 {code}）")
    } else {
        format!("{reason}（退出码 {code}）{tail}")
    }
}

/// 调用切换脚本并回读结果文件，脚本的退出码是唯一权威判定。
/// 入参：脚本绝对路径、脚本参数、结果文件路径；返回：脚本写出的结果 JSON；边界：超时、结果文件缺失或退出码非零时如实上报，绝不伪造成功。
fn run_switch_script(
    script: &PathBuf,
    args: &[String],
    result_path: &PathBuf,
) -> Result<Value, String> {
    if !script.is_file() {
        return Err(format!("找不到模式切换脚本：{}", script.display()));
    }
    // 清掉上一轮结果，确保本次成功必然伴随本脚本新写出的结果文件
    let _ = fs::remove_file(result_path);
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .args(args)
        .arg("-ResultPath")
        .arg(result_path)
        .current_dir(fusion_root())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动模式切换脚本失败：{error}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() > SWITCH_SCRIPT_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(
                        "模式切换超时：脚本未在限定时间内结束，运行模式可能未改变。".to_string()
                    );
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(error) => return Err(format!("等待模式切换脚本失败：{error}")),
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("读取模式切换结果失败：{error}"))?;
    let code = output.status.code().unwrap_or(-1);
    let stderr_text = String::from_utf8_lossy(&output.stderr).to_string();
    let result_text = fs::read_to_string(result_path).unwrap_or_default();
    let result = parse_switch_result(&result_text);
    // 脚本写出的结果文件是权威结论：它同时带上 outcome、真实观测模式与面向用户的说明。
    // 退出码只用于结果文件缺失时的兜底，绝不据此伪造成功。
    // 特别注意：文件存在但停在 running，说明脚本开跑了却没走到结束（被中止），
    // 这不是成功，也不能说成「什么都没发生」。
    match result {
        Some(value) if has_outcome(&value) => Ok(value),
        Some(value) => {
            let interrupted = value.get("outcome").and_then(Value::as_str) == Some("running");
            if interrupted {
                let tail: String = stderr_text.trim().chars().take(400).collect();
                Err(format!(
          "模式切换被中断：脚本已经开跑但没能走到结束，运行模式可能停在中间状态（退出码 {code}）。{tail}"
        ))
            } else {
                Err(describe_switch_failure(code, &stderr_text))
            }
        }
        None => Err(describe_switch_failure(code, &stderr_text)),
    }
}

/// 在 Dream Skin 与 Code-Codex 之间切换运行模式。
/// 入参：目标模式（`code-codex` 或 `dream-skin`）；返回：切换结果 JSON；边界：只调用切换脚本，宿主自身不结束任何进程。
#[tauri::command]
fn mode_switch(target: String) -> Result<Value, String> {
    let (script_name, action) = match target.as_str() {
        "code-codex" => ("switch-to-code-codex.ps1", "switch-to-code-codex"),
        "dream-skin" => ("switch-to-dream-skin.ps1", "switch-to-dream-skin"),
        other => return Err(format!("不支持的目标模式：{other}")),
    };
    let script = fusion_root().join(script_name);
    let result_path = fusion_root().join("last-switch-result.json");
    let mut value = run_switch_script(&script, &[], &result_path)?;
    // 补齐 action，便于前端区分两个方向；脚本未提供时以本次调用为准
    if let Some(object) = value.as_object_mut() {
        object
            .entry("action")
            .or_insert_with(|| Value::String(action.to_string()));
    }
    Ok(value)
}

/// 启动时按当前运行模式把应用带入 Dream Skin 模式。
/// 入参：无；返回：自检结果 JSON；边界：由宿主内嵌运行时确保 CDP+注入，不再外启 Dream Skin 脚本；
///       脚本在 Code-Codex 正在运行或存在其他 Codex 会话时返回 blocked，绝不自作主张关闭它们。
/// 串行化 ensure，避免宿主后台自检与前端启动自检并发抢跑（冷启动红字横幅根因）。
static ENSURE_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
fn ensure_dream_skin_mode() -> Result<Value, String> {
    let _guard = ENSURE_LOCK
        .lock()
        .map_err(|_| "Dream Skin 自检锁异常，请重启 Codex Fusion".to_string())?;
    // Single-process path: host launches/attaches Codex CDP and injects skin itself.
    // Does not kill Code-Codex sessions; if foreign/non-CDP Codex is already up without
    // our profile, ensure_dream_skin_runtime will restart ChatGPT only when needed.
    match codex_runtime::ensure_dream_skin_runtime(false) {
        Ok(value) => {
            let _ = fs::write(
                fusion_root().join("last-ensure-result.json"),
                serde_json::to_vec_pretty(&value).unwrap_or_default(),
            );
            Ok(value)
        }
        Err(error) => {
            let failure = serde_json::json!({
              "ok": false,
              "outcome": "failed",
              "action": "ensure-dream-skin-mode",
              "message": error,
            });
            let _ = fs::write(
                fusion_root().join("last-ensure-result.json"),
                serde_json::to_vec_pretty(&failure).unwrap_or_default(),
            );
            Err(error)
        }
    }
}

/// 只读查询当前运行模式，用于界面在切换前如实展示状态。
/// 入参：无；返回：模式探测结果 JSON；边界：探测失败时返回 unknown，不猜测也不修改任何状态。
#[tauri::command]
fn mode_status() -> Result<Value, String> {
    let script = fusion_root().join("switch-common.ps1");
    if !script.is_file() {
        return Ok(serde_json::json!({ "mode": "unknown", "message": "找不到模式探测库。" }));
    }
    let probe = "& { . $args[0]; $paths = Get-FusionSwitchPaths; Assert-FusionDreamSkinLibrary -Paths $paths; . $paths.CommonScript; . $paths.ThemeScript; $statePath = $paths.StatePath; $state = if (Test-Path -LiteralPath $statePath) { Read-DreamSkinState -Path $statePath } else { $null }; $official = @(); foreach ($install in @(Get-DreamSkinRegisteredCodexInstalls)) { $official += [string]$install.Executable }; $mode = Get-FusionMode -Snapshot @(Get-FusionProcessSnapshot) -OfficialExecutables $official -DreamSkinProfileToken (Get-FusionProfileToken -ProfilePath $state.profilePath) -CodeCodexRoot $paths.CodeCodexRoot -DreamSkinExecutable $state.codexExe; [pscustomobject]@{ mode = $mode.Mode; dreamSkinProcesses = @($mode.DreamSkinProcesses).Count; codeCodexProcesses = @($mode.CodeCodexProcesses).Count; foreignCodexProcesses = @($mode.ForeignCodexProcesses).Count } | ConvertTo-Json -Compress }";
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
        ])
        .arg(probe)
        .arg(script.to_string_lossy().to_string())
        .current_dir(fusion_root())
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("运行模式探测失败：{error}"))?;
    if !output.status.success() {
        return Ok(serde_json::json!({ "mode": "unknown", "message": "模式探测脚本执行失败。" }));
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(parse_switch_result(&text).unwrap_or_else(|| serde_json::json!({ "mode": "unknown" })))
}

/// 启动独立的 Rice-dog/code-codex 便携版。
/// 入参：无；返回：启动确认；边界：文件缺失或进程创建失败时返回错误，不修改官方 Codex 配置。
#[tauri::command]
fn launch_code_codex() -> Result<Value, String> {
    let endpoint = SocketAddr::from(([127, 0, 0, 1], DREAM_SKIN_CDP_PORT));
    if TcpStream::connect_timeout(&endpoint, Duration::from_millis(250)).is_ok() {
        return Err(format!(
      "Dream Skin 正在使用官方 Codex 调试端口 {DREAM_SKIN_CDP_PORT}。请先通过模式切换关闭 Dream Skin 管理的 Codex，再启动独立 Code-Codex；两个程序不会共享同一个 Codex 会话。"
    ));
    }
    let executable = code_codex_path();
    if !executable.is_file() {
        return Err(format!(
            "找不到 Code-Codex：{}（可用环境变量 CODEX_CODEX_PATH 指定）",
            executable.display()
        ));
    }
    let working_dir = executable.parent().ok_or("Code-Codex 工作目录无效")?;
    Command::new(&executable)
        .current_dir(working_dir)
        .spawn()
        .map_err(|error| format!("启动 Code-Codex 失败：{error}"))?;
    Ok(serde_json::json!({ "ok": true, "path": executable.display().to_string() }))
}

/// 读取上一次模式切换的结论（只读，不修改任何状态）。
/// 入参：无；返回：结果文件内容与是否存在；边界：文件不存在或内容不合法时如实返回 present=false，
///       绝不猜成一个成功结论。文件停在 running 时额外标记 interrupted，
///       让界面能告诉用户「上次切换没跑完」，而不是显示成什么都没发生。
#[tauri::command]
fn last_switch_outcome() -> Result<Value, String> {
    let result_path = fusion_root().join("last-switch-result.json");
    if !result_path.is_file() {
        return Ok(serde_json::json!({ "present": false }));
    }
    let text = fs::read_to_string(&result_path)
        .map_err(|error| format!("读取上次切换结果失败：{error}"))?;
    let parsed = parse_switch_result(&text);
    match parsed {
        Some(value) => {
            let outcome = value.get("outcome").and_then(Value::as_str).unwrap_or("");
            let interrupted = outcome == "running";
            let mut object = match value {
                Value::Object(map) => map,
                other => return Ok(serde_json::json!({ "present": false, "raw": other })),
            };
            object.insert("present".to_string(), Value::Bool(true));
            object.insert("interrupted".to_string(), Value::Bool(interrupted));
            Ok(Value::Object(object))
        }
        None => Ok(serde_json::json!({ "present": false })),
    }
}

/// 只读的健康检查：判断 Code-Codex 模式的 CDP 注入链路是否真的可用。
///
/// 背景：官方 Codex 的 Chromium 136+ 会忽略默认数据目录上的 remote-debugging 开关，
/// 而 Code-Codex 正是用默认方式连接 Codex 的 CDP，因此「切换成功（进程已起）」并不等于
/// 「文件树/预览可用」。此命令扫描所有带调试端口的 ChatGPT.exe 并实测端口连通性，
/// 让界面能在切换后如实告知用户功能是否可用，而不是静默失败。
/// 入参：无；返回：模式、端口列表、连通性与面向用户的说明；边界：探测失败时如实返回 unknown。
#[tauri::command]
fn code_codex_health() -> Result<Value, String> {
    let probe = format!(
        r#"
$sessionPath = '{}'
$sessionPresent = Test-Path -LiteralPath $sessionPath
$ports = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction SilentlyContinue | ForEach-Object {{
  if ($_.CommandLine -match 'remote-debugging-port=(\d+)') {{ [int]$Matches[1] }}
}} | Sort-Object -Unique)
[pscustomobject]@{{ sessionPresent = $sessionPresent; ports = @($ports) }} | ConvertTo-Json -Compress
"#,
        fusion_root()
            .join("state")
            .join("code-codex-session.json")
            .display()
    );
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
        ])
        .arg(probe)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("运行 Code-Codex 健康探测失败：{error}"))?;
    if !output.status.success() {
        return Ok(
            serde_json::json!({ "mode": "unknown", "available": false, "reason": "健康探测脚本执行失败。" }),
        );
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let parsed: Value = serde_json::from_str(text.trim())
        .map_err(|error| format!("解析健康探测结果失败：{error}"))?;
    let session_present = parsed
        .get("sessionPresent")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let ports: Vec<u16> = parsed
        .get("ports")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_u64)
                .filter_map(|p| u16::try_from(p).ok())
                .collect()
        })
        .unwrap_or_default();
    let mut available_port: Option<u16> = None;
    for &port in &ports {
        if TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(500),
        )
        .is_ok()
        {
            available_port = Some(port);
            break;
        }
    }
    let mode = if session_present {
        "code-codex"
    } else if available_port.is_some() {
        "dream-skin"
    } else {
        "none"
    };
    let reason = if session_present && available_port.is_none() {
        Some("Code-Codex 已启动，但官方 Codex 的新版 Chromium 忽略了默认数据目录的调试端口，Code-Codex 的 CDP 注入无法建立连接，文件树/预览功能不可用。建议停留在 Dream Skin 模式并使用 Fusion 工作区。".to_string())
    } else {
        None
    };
    Ok(serde_json::json!({
      "mode": mode,
      "sessionPresent": session_present,
      "ports": ports,
      "available": available_port.is_some(),
      "connectedPort": available_port,
      "reason": reason,
    }))
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    // 菜单去重：不再单独放「主题工作台」（旧实现会用浏览器打开 17890，功能重叠且易迷惑）
    let show = MenuItem::with_id(app, "show", "打开工作台", true, None::<&str>)?;
    let apply = MenuItem::with_id(app, "apply", "应用当前主题", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启 Codex（带皮肤）", true, None::<&str>)?;
    let themes = MenuItem::with_id(app, "themes", "打开主题目录", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &apply, &restart, &themes, &exit])?;
    let mut builder = TrayIconBuilder::with_id("codex-fusion-tray")
        .menu(&menu)
        .tooltip("Codex Fusion");
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder = builder.on_menu_event(|app, event| match event.id().as_ref() {
        "show" => show_main_window(&app),
        "apply" => {
            let _ = send_theme_request(
                "POST",
                "/api/themes/apply",
                Some(serde_json::json!({"id": active_theme_id()})),
            );
        }
        "restart" => {
            let _ = send_theme_request("POST", "/api/restart-codex", Some(serde_json::json!({})));
        }
        "themes" => {
            if let Ok(root) = std::env::var("LOCALAPPDATA") {
                let _ = Command::new("explorer.exe")
                    .arg(PathBuf::from(root).join("CodexDreamSkin").join("themes"))
                    .spawn();
            }
        }
        "exit" => app.exit(0),
        _ => {}
    });
    builder = builder.on_tray_icon_event(|tray, event| {
        if let tauri::tray::TrayIconEvent::Click {
            button: tauri::tray::MouseButton::Left,
            button_state: tauri::tray::MouseButtonState::Up,
            ..
        } = event
        {
            show_main_window(tray.app_handle());
        }
    });
    builder.build(app)?;
    Ok(())
}

fn active_theme_id() -> String {
    let root = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let path = PathBuf::from(root)
        .join("CodexDreamSkin")
        .join("active-theme")
        .join("theme.json");
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v.get("id")?.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn main() {
    // 单实例：已有实例时把其窗口带回前台并退出本进程
    #[cfg(windows)]
    if single_instance::check_existing_instance() {
        return;
    }
    // 桥接启动失败不阻塞主题工作台：降级为可用的错误响应，工作区请求会返回明确提示
    let bridge = match start_bridge() {
        Ok(bridge) => Some(bridge),
        Err(error) => {
            eprintln!("Codex Fusion 桥接不可用：{error}（主题工作台仍可正常使用）");
            None
        }
    };
    if let Err(error) = theme_service::start() {
        eprintln!("Codex Fusion 内嵌主题服务不可用：{error}");
    }
    // 等主题服务就绪再进事件循环：前端首屏会立即请求 /api/themes。
    let _ = wait_for_port(THEME_PORT, Duration::from_secs(8));
    // 启动自检必须延后：过早做 CDP/注入会让窗口 AppHang，前端就会表现为主题库空白。
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(3));
        if let Err(error) = ensure_dream_skin_mode() {
            eprintln!("Codex Fusion 启动自检未能确保 Dream Skin 模式：{error}");
        }
    });
    tauri::Builder::default()
        .setup(|app| Ok(setup_tray(app)?))
        .manage(BridgeState(Mutex::new(bridge)))
        // 关窗=缩到托盘（皮肤与主题服务常驻，双击图标随时唤回）；真正退出走托盘菜单「退出」。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            workspace_request,
            theme_request,
            launch_code_codex,
            mode_switch,
            mode_status,
            ensure_dream_skin_mode,
            last_switch_outcome,
            code_codex_health
        ])
        .run(tauri::generate_context!())
        .expect("运行 Codex Fusion 宿主失败");
}
