use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

pub const PORT: u16 = 17890;
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const PANEL_ORIGIN: &str = "http://127.0.0.1:17890";
const EFFECT_TYPES: &[&str] = &[
    "none",
    "rain",
    "particles",
    "snow",
    "fog",
    "stars",
    "matrix",
    "road",
    "gradient-shift",
    "kenburns",
];

fn state_root() -> PathBuf {
    crate::runtime_state_root()
}
fn themes_dir() -> PathBuf {
    state_root().join("themes")
}
fn active_dir() -> PathBuf {
    state_root().join("active-theme")
}
fn effects_dir() -> PathBuf {
    state_root().join("effects")
}
const PANEL_HTML: &str = include_str!("../assets/panel.html");

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}
fn resource_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .bytes()
            .enumerate()
            .all(|(i, c)| c.is_ascii_alphanumeric() || (i > 0 && (c == b'_' || c == b'-')))
}
fn direct_child(root: &Path, name: &str) -> Option<PathBuf> {
    if name.is_empty() || Path::new(name).file_name()?.to_string_lossy() != name {
        return None;
    }
    Some(root.join(name))
}
fn timestamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
fn active_theme_name() -> String {
    read_json(&active_dir().join("theme.json"))
        .and_then(|v| v.get("name")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| "未知".into())
}
fn codex_running() -> bool {
    Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", "if (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"]).status().map(|s| s.success()).unwrap_or(false)
}
fn cdp_port() -> u16 {
    read_json(&state_root().join("state.json"))
        .and_then(|v| v.get("port")?.as_u64())
        .filter(|p| (1024..=65535).contains(p))
        .map(|p| p as u16)
        .unwrap_or(9335)
}
fn cdp_tcp_up() -> bool {
    let port = cdp_port();
    TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(200)).is_ok()
}
fn cached_browser_id(port: u16) -> Option<String> {
    use std::sync::{Mutex, OnceLock};
    struct Cache {
        at: Instant,
        id: Option<String>,
    }
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| {
        Mutex::new(Cache {
            at: Instant::now() - Duration::from_secs(60),
            id: None,
        })
    });
    if let Ok(guard) = cache.lock() {
        if guard.at.elapsed() < Duration::from_secs(5) {
            return guard.id.clone();
        }
    }
    let id = crate::injector::browser_id(port).ok();
    if let Ok(mut guard) = cache.lock() {
        guard.at = Instant::now();
        guard.id = id.clone();
    }
    id
}
fn cdp_connected() -> bool {
    cdp_tcp_up()
}
fn status() -> Value {
    let port = cdp_port();
    let tcp_up = cdp_tcp_up();
    let browser = if tcp_up {
        cached_browser_id(port)
    } else {
        None
    };
    let connected = tcp_up; // TCP up is enough for UI; browser id is informational.
    let running = connected || codex_running();
    let (state, message) = if connected {
        ("connected", "Codex 已连接")
    } else if running {
        (
            "running_no_cdp",
            "Codex 正在运行但未启用调试端口，需要重启以应用主题",
        )
    } else {
        ("not_running", "Codex 未运行")
    };
    // 不向本机任意 GET 调用方回传原始 browserId，降低本机信息泄露面。
    json!({"status":state,"processRunning":running,"cdpConnected":connected,"port":if connected {Some(port)} else {None},"browserPresent":browser.is_some(),"browser":Value::Null,"message":message})
}
fn theme_list(filter: &str) -> Vec<Value> {
    let root = themes_dir();
    let active = active_theme_name();
    let mut out = vec![];
    let Ok(entries) = fs::read_dir(&root) else {
        return out;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let Some(t) = read_json(&entry.path().join("theme.json")) else {
            continue;
        };
        let name = t
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_string();
        if !filter.is_empty() && !name.to_lowercase().contains(&filter.to_lowercase()) {
            continue;
        }
        let image = t.get("image").and_then(Value::as_str);
        let image_path = image.and_then(|n| direct_child(&entry.path(), n));
        let has_image = image_path.as_ref().map(|p| p.is_file()).unwrap_or(false);
        let image_size = image_path
            .as_ref()
            .and_then(|p| fs::metadata(p).ok())
            .map(|m| {
                let n = m.len();
                if n > 1_048_576 {
                    format!("{:.1} MB", n as f64 / 1_048_576.0)
                } else {
                    format!("{} KB", n / 1024)
                }
            })
            .unwrap_or_default();
        let created = fs::metadata(entry.path())
            .ok()
            .and_then(|m| m.created().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default();
        out.push(json!({"id":id,"name":name,"image":image,"hasImage":has_image,"imageSize":image_size,"imageDims":"","appearance":t.get("appearance").and_then(Value::as_str).unwrap_or("auto"),"created":created,"hasTagline":t.get("tagline").is_some(),"isActive":name==active}));
    }
    out
}
fn apply_theme(id: &str) -> Value {
    if !resource_id(id) {
        return json!({"ok":false,"error":"主题标识无效"});
    }
    let dir = themes_dir().join(id);
    if !dir.is_dir() {
        return json!({"ok":false,"error":"主题不存在"});
    }
    if !cdp_connected() {
        // Try to bring CDP up via in-process runtime before failing.
        if crate::codex_runtime::ensure_dream_skin_runtime(false).is_err() {
            return json!({"ok":false,"error":"Codex 未连接（CDP 调试端口不可用）。请通过 Codex Fusion 重启 Codex。","cdpError":true});
        }
    }
    match crate::codex_runtime::activate_saved_theme(id) {
        Ok(_) => json!({"ok":true}),
        Err(e) => json!({"ok":false,"error":e}),
    }
}
fn effect_list() -> Vec<Value> {
    let mut out = vec![];
    let Ok(entries) = fs::read_dir(effects_dir()) else {
        return out;
    };
    for entry in entries.flatten() {
        if entry.path().extension().and_then(|x| x.to_str()) == Some("json") {
            if let Some(v) = read_json(&entry.path()) {
                if v.get("id").is_some() {
                    out.push(v)
                }
            }
        }
    }
    out
}
fn mime(path: &Path) -> &'static str {
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
fn static_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        _ => mime(path),
    }
}
fn preview_static_dir() -> std::path::PathBuf {
    crate::fusion_root()
        .join("frontend")
        .join("dist")
        .join("dream-skin")
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
fn parse_request(stream: &mut TcpStream) -> Result<Request, String> {
    stream.set_read_timeout(Some(Duration::from_secs(8))).ok();
    let mut data = Vec::new();
    let mut buf = [0u8; 8192];
    let header_end;
    loop {
        let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("incomplete request".into());
        }
        data.extend_from_slice(&buf[..n]);
        if let Some(p) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = p;
            break;
        }
        if data.len() > 65536 {
            return Err("headers too large".into());
        }
    }
    let head = String::from_utf8_lossy(&data[..header_end]);
    let mut lines = head.lines();
    let first = lines.next().ok_or("missing request line")?;
    let mut f = first.split_whitespace();
    let method = f.next().unwrap_or("").to_string();
    let path = f.next().unwrap_or("").to_string();
    let headers: Vec<_> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let length = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    if length > MAX_REQUEST_BYTES {
        return Ok(Request {
            method,
            path,
            headers,
            body: vec![0; MAX_REQUEST_BYTES + 1],
        });
    }
    let start = header_end + 4;
    while data.len() < start + length {
        let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buf[..n]);
    }
    Ok(Request {
        method,
        path,
        headers,
        body: data[start..data.len().min(start + length)].to_vec(),
    })
}
fn response(stream: &mut TcpStream, code: u16, ctype: &str, body: &[u8]) {
    let reason = match code {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "Error",
    };
    let h=format!("HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",body.len());
    let _ = stream.write_all(h.as_bytes());
    let _ = stream.write_all(body);
}
fn json_response(stream: &mut TcpStream, code: u16, value: Value) {
    response(
        stream,
        code,
        "application/json; charset=utf-8",
        serde_json::to_string(&value)
            .unwrap_or_else(|_| "{}".into())
            .as_bytes(),
    )
}
fn trusted(req: &Request) -> bool {
    let origin = req
        .headers
        .iter()
        .find(|(k, _)| k == "origin")
        .map(|(_, v)| v.as_str());
    if let Some(v) = origin {
        return v == PANEL_ORIGIN;
    }
    req.headers
        .iter()
        .find(|(k, _)| k == "referer")
        .map(|(_, v)| v.starts_with(&format!("{PANEL_ORIGIN}/")))
        .unwrap_or(false)
}
fn body_json(req: &Request) -> Result<Value, String> {
    serde_json::from_slice(&req.body).map_err(|e| e.to_string())
}

/// 将 Codex 重启结果映射为 HTTP 响应。
/// 入参：runtime 的成功或失败结果；返回：状态码与 JSON；边界：任何错误都不能伪装为 200 成功。
fn restart_response(result: Result<Value, String>) -> (u16, Value) {
    match result {
        Ok(value) => (200, value),
        Err(error) => (502, json!({"ok": false, "error": error})),
    }
}

fn handle(mut stream: TcpStream) {
    let Ok(req) = parse_request(&mut stream) else {
        return;
    };
    if req.body.len() > MAX_REQUEST_BYTES {
        json_response(
            &mut stream,
            413,
            json!({"ok":false,"error":"请求体超过 16 MB 限制"}),
        );
        return;
    }
    if req.method == "OPTIONS" {
        response(&mut stream, 405, "text/plain", b"");
        return;
    }
    let raw_path = req.path.split('?').next().unwrap_or("");
    let changes = req.method != "GET" && req.method != "HEAD";
    if (changes || raw_path == "/api/open-dir") && !trusted(&req) {
        json_response(
            &mut stream,
            403,
            json!({"ok":false,"error":"仅允许本地主题面板执行此操作"}),
        );
        return;
    }
    match (req.method.as_str(), raw_path) {
        ("GET", "/api/health") => {
            let mut s = status();
            if let Some(o) = s.as_object_mut() {
                o.insert("activeTheme".into(), json!(active_theme_name()));
                o.insert("serverTime".into(), json!(timestamp().to_string()));
            }
            json_response(&mut stream, 200, s)
        }
        ("POST", "/api/restart-codex") => {
            let (status, body) =
                restart_response(crate::codex_runtime::ensure_dream_skin_runtime(true));
            json_response(&mut stream, status, body)
        }
        ("GET", "/api/themes") => {
            let q = req.path.split_once("q=").map(|(_, v)| v).unwrap_or("");
            let s = status();
            json_response(
                &mut stream,
                200,
                json!({"themes":theme_list(q),"active":active_theme_name(),"skinConnected":s["cdpConnected"],"codexStatus":s["status"],"codexMessage":s["message"]}),
            )
        }
        ("POST", "/api/themes/apply") => match body_json(&req) {
            Ok(v) => {
                let r = apply_theme(v.get("id").and_then(Value::as_str).unwrap_or(""));
                json_response(&mut stream, if r["ok"] == true { 200 } else { 400 }, r)
            }
            Err(e) => json_response(&mut stream, 400, json!({"ok":false,"error":e})),
        },
        ("POST", "/api/themes/delete") => match body_json(&req) {
            Ok(v) => {
                let id = v.get("id").and_then(Value::as_str).unwrap_or("");
                let r = if !resource_id(id) {
                    json!({"ok":false,"error":"主题标识无效"})
                } else {
                    let dir = themes_dir().join(id);
                    let name = read_json(&dir.join("theme.json"))
                        .and_then(|x| x.get("name")?.as_str().map(str::to_owned));
                    if name.as_deref() == Some(&active_theme_name()) {
                        json!({"ok":false,"error":"不能删除当前正在使用的主题"})
                    } else if !dir.is_dir() {
                        json!({"ok":false,"error":"主题不存在"})
                    } else {
                        match fs::remove_dir_all(dir) {
                            Ok(_) => json!({"ok":true}),
                            Err(e) => json!({"ok":false,"error":e.to_string()}),
                        }
                    }
                };
                json_response(&mut stream, if r["ok"] == true { 200 } else { 400 }, r)
            }
            Err(e) => json_response(&mut stream, 400, json!({"ok":false,"error":e})),
        },
        ("POST", "/api/themes/create") => create_theme(&mut stream, &req),
        ("POST", "/api/background") => change_background(&mut stream, &req),
        ("GET", "/api/active-preview") => serve_preview(&mut stream, &active_dir()),
        ("GET", "/api/open-dir") => {
            let r = Command::new("explorer.exe").arg(themes_dir()).spawn();
            match r {
                Ok(_) => json_response(&mut stream, 200, json!({"ok":true})),
                Err(e) => {
                    json_response(&mut stream, 500, json!({"ok":false,"error":e.to_string()}))
                }
            }
        }
        ("GET", "/api/effect/current") => {
            let e = read_json(&state_root().join("active-effect.json"));
            json_response(
                &mut stream,
                200,
                json!({"ok":true,"effect":e.as_ref().and_then(|v|v.get("effect")).and_then(Value::as_str).unwrap_or("none"),"config":e.as_ref().and_then(|v|v.get("config")).cloned().unwrap_or_else(||json!({})),"name":e.as_ref().and_then(|v|v.get("name")).cloned().unwrap_or(Value::Null),"effectId":e.as_ref().and_then(|v|v.get("effectId")).cloned().unwrap_or(Value::Null)}),
            )
        }
        ("GET", "/api/effects") => {
            json_response(&mut stream, 200, json!({"effects":effect_list()}))
        }
        ("POST", "/api/effects/create") => save_effect(&mut stream, &req, false),
        ("POST", "/api/effects/update") => save_effect(&mut stream, &req, true),
        ("POST", "/api/effects/delete") => delete_effect(&mut stream, &req),
        ("POST", "/api/effects/apply") => match body_json(&req) {
            Ok(v) => {
                let id = v.get("id").and_then(Value::as_str).unwrap_or("");
                let effect = effect_list().into_iter().find(|e| e["id"] == id);
                match effect {
                    Some(e) => {
                        let kind = e
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let params = e.get("params").cloned().unwrap_or_else(|| json!({}));
                        apply_effect(&mut stream, &kind, params, Some(e))
                    }
                    None => {
                        json_response(&mut stream, 400, json!({"ok":false,"error":"效果不存在"}))
                    }
                }
            }
            Err(e) => json_response(&mut stream, 500, json!({"ok":false,"error":e})),
        },
        ("POST", "/api/effect") => match body_json(&req) {
            Ok(v) => {
                let effect = v.get("effect").and_then(Value::as_str).unwrap_or("");
                if effect.is_empty() {
                    json_response(
                        &mut stream,
                        400,
                        json!({"ok":false,"error":"缺少 effect 参数"}),
                    )
                } else {
                    apply_effect(
                        &mut stream,
                        effect,
                        v.get("config").cloned().unwrap_or_else(|| json!({})),
                        None,
                    )
                }
            }
            Err(e) => json_response(&mut stream, 500, json!({"ok":false,"error":e})),
        },
        ("GET", "/") | ("GET", "/index.html") => response(
            &mut stream,
            200,
            "text/html; charset=utf-8",
            PANEL_HTML.as_bytes(),
        ),
        _ if req.method == "GET" && raw_path.starts_with("/dream-skin/") => {
            let rel = &raw_path["/dream-skin/".len()..];
            let Some(path) = direct_child(&preview_static_dir(), rel) else {
                response(&mut stream, 404, "text/plain", b"");
                return;
            };
            match fs::read(&path) {
                Ok(b) => response(&mut stream, 200, static_mime(&path), &b),
                Err(_) => response(&mut stream, 404, "text/plain", b""),
            }
        }
        _ if req.method == "GET" && raw_path.starts_with("/api/preview/") => {
            let id = &raw_path["/api/preview/".len()..];
            if resource_id(id) {
                serve_preview(&mut stream, &themes_dir().join(id))
            } else {
                response(&mut stream, 400, "text/plain", b"")
            }
        }
        _ => response(&mut stream, 404, "text/plain", b"Not Found"),
    }
}
fn serve_preview(stream: &mut TcpStream, dir: &Path) {
    let Some(t) = read_json(&dir.join("theme.json")) else {
        response(stream, 404, "text/plain", b"");
        return;
    };
    let Some(name) = t.get("image").and_then(Value::as_str) else {
        response(stream, 404, "text/plain", b"");
        return;
    };
    let Some(path) = direct_child(dir, name) else {
        response(stream, 404, "text/plain", b"");
        return;
    };
    match fs::read(&path) {
        Ok(b) => response(stream, 200, mime(&path), &b),
        Err(_) => response(stream, 404, "text/plain", b""),
    }
}
fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(input)
        .map_err(|e| e.to_string())
}
fn create_theme(stream: &mut TcpStream, req: &Request) {
    let Ok(v) = body_json(req) else {
        json_response(stream, 400, json!({"ok":false,"error":"请求格式无效"}));
        return;
    };
    let name = v.get("name").and_then(Value::as_str).unwrap_or("");
    let data = v.get("imageData").and_then(Value::as_str).unwrap_or("");
    if name.is_empty() || data.is_empty() {
        json_response(stream, 400, json!({"ok":false,"error":"缺少名称或图片"}));
        return;
    }
    let id = format!("custom-{}", timestamp());
    let dir = themes_dir().join(&id);
    let ext = match v.get("imageType").and_then(Value::as_str) {
        Some("image/png") => "png",
        Some("image/webp") => "webp",
        _ => "jpg",
    };
    let result=decode_base64(data).and_then(|b|{fs::create_dir_all(&dir).map_err(|e|e.to_string())?;fs::write(dir.join(format!("art.{ext}")),b).map_err(|e|e.to_string())?;fs::write(dir.join("theme.json"),serde_json::to_vec_pretty(&json!({"schemaVersion":1,"id":id,"name":name,"appearance":"auto","image":format!("art.{ext}"),"art":{"focusX":null,"focusY":null,"safeArea":"auto","taskMode":"auto"},"palette":{}})).unwrap()).map_err(|e|e.to_string())});
    match result {
        Ok(_) => json_response(stream, 200, json!({"ok":true,"id":id,"name":name})),
        Err(e) => json_response(stream, 400, json!({"ok":false,"error":e})),
    }
}
fn change_background(stream: &mut TcpStream, req: &Request) {
    let Ok(v) = body_json(req) else {
        json_response(stream, 400, json!({"ok":false,"error":"请求格式无效"}));
        return;
    };
    let data = v.get("imageData").and_then(Value::as_str).unwrap_or("");
    if data.is_empty() {
        json_response(stream, 400, json!({"ok":false,"error":"缺少图片"}));
        return;
    }
    let ext = match v.get("imageType").and_then(Value::as_str) {
        Some("image/png") => "png",
        Some("image/webp") => "webp",
        _ => "jpg",
    };
    let tmp = state_root()
        .join("tmp")
        .join(format!("bg-{}.{}", timestamp(), ext));
    let result = decode_base64(data).and_then(|b| {
        fs::create_dir_all(tmp.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(&tmp, b).map_err(|e| e.to_string())?;
        crate::codex_runtime::set_active_theme_image(&tmp)?;
        if cdp_connected() {
            let browser = read_json(&state_root().join("state.json"))
                .and_then(|s| s.get("browserId")?.as_str().map(str::to_owned));
            crate::codex_runtime::inject_active_skin(cdp_port(), browser.as_deref())?;
        }
        Ok(())
    });
    let _ = fs::remove_file(&tmp);
    match result {
        Ok(_) => json_response(stream, 200, json!({"ok":true})),
        Err(e) => json_response(stream, 400, json!({"ok":false,"error":e})),
    }
}
fn save_effect(stream: &mut TcpStream, req: &Request, update: bool) {
    let Ok(v) = body_json(req) else {
        json_response(stream, 500, json!({"ok":false,"error":"请求格式无效"}));
        return;
    };
    let id = v.get("id").and_then(Value::as_str).unwrap_or("");
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    if !resource_id(id)
        || v.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
        || !EFFECT_TYPES.contains(&kind)
    {
        json_response(stream, 400, json!({"ok":false,"error":"效果参数无效"}));
        return;
    }
    let path = effects_dir().join(format!("{id}.json"));
    if update && !path.is_file() {
        json_response(stream, 404, json!({"ok":false,"error":"效果不存在"}));
        return;
    }
    let r = fs::create_dir_all(effects_dir())
        .and_then(|_| fs::write(path, serde_json::to_vec_pretty(&v).unwrap()));
    match r {
        Ok(_) => json_response(stream, 200, json!({"ok":true,"effect":v})),
        Err(e) => json_response(stream, 500, json!({"ok":false,"error":e.to_string()})),
    }
}
fn delete_effect(stream: &mut TcpStream, req: &Request) {
    let Ok(v) = body_json(req) else {
        json_response(stream, 500, json!({"ok":false,"error":"请求格式无效"}));
        return;
    };
    let id = v.get("id").and_then(Value::as_str).unwrap_or("");
    if !resource_id(id) {
        json_response(stream, 400, json!({"ok":false,"error":"效果标识无效"}));
        return;
    }
    let path = effects_dir().join(format!("{id}.json"));
    if !path.is_file() {
        json_response(stream, 404, json!({"ok":false,"error":"效果不存在"}));
        return;
    }
    match fs::remove_file(path) {
        Ok(_) => json_response(stream, 200, json!({"ok":true})),
        Err(e) => json_response(stream, 500, json!({"ok":false,"error":e.to_string()})),
    }
}
fn apply_effect(stream: &mut TcpStream, effect: &str, config: Value, metadata: Option<Value>) {
    if !EFFECT_TYPES.contains(&effect) {
        json_response(
            stream,
            400,
            json!({"ok":false,"error":"不支持的动态效果类型"}),
        );
        return;
    }
    if !cdp_connected() {
        json_response(
            stream,
            400,
            json!({"ok":false,"error":"Codex 未连接（CDP 调试端口不可用）","cdpError":true}),
        );
        return;
    }
    let state = read_json(&state_root().join("state.json")).unwrap_or_else(|| json!({}));
    let browser = state.get("browserId").and_then(Value::as_str);
    match crate::injector::apply_effect(cdp_port(), effect, config.clone(), browser, 15000) {
        Ok(mut result) => {
            let name = metadata
                .as_ref()
                .and_then(|m| m.get("name"))
                .and_then(Value::as_str)
                .unwrap_or(effect);
            let id = metadata
                .as_ref()
                .and_then(|m| m.get("id"))
                .cloned()
                .unwrap_or(Value::Null);
            if effect == "none" {
                let _ = fs::remove_file(state_root().join("active-effect.json"));
            } else {
                let _=fs::write(state_root().join("active-effect.json"),serde_json::to_vec_pretty(&json!({"schemaVersion":1,"effect":effect,"config":config,"effectId":id,"name":name,"appliedAt":timestamp().to_string()})).unwrap());
            }
            if let Some(obj) = result.as_object_mut() {
                obj.insert("name".into(), json!(name));
                obj.insert("diagnostics".into(), Value::Null);
            }
            json_response(stream, 200, result)
        }
        Err(e) => json_response(
            stream,
            400,
            json!({"ok":false,"error":format!("动态效果注入失败：{e}")}),
        ),
    }
}

pub fn start() -> Result<(), String> {
    let listener =
        TcpListener::bind(("127.0.0.1", PORT)).map_err(|e| format!("绑定主题服务失败: {e}"))?;
    thread::Builder::new()
        .name("codex-fusion-theme-service".into())
        .spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(s) => {
                        let _ = thread::Builder::new()
                            .name("theme-http-request".into())
                            .spawn(move || handle(s));
                    }
                    Err(e) => eprintln!("主题服务连接失败: {e}"),
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::restart_response;
    use serde_json::json;

    #[test]
    fn restart_failure_is_not_reported_as_success() {
        let (status, body) = restart_response(Err("restart failed".into()));

        assert_eq!(status, 502);
        assert_eq!(body["ok"], json!(false));
        assert_eq!(body["error"], json!("restart failed"));
    }

    #[test]
    fn restart_success_preserves_runtime_result() {
        let result = json!({"ok": true, "injected": {"ok": true}});
        let (status, body) = restart_response(Ok(result.clone()));

        assert_eq!(status, 200);
        assert_eq!(body, result);
    }
}
