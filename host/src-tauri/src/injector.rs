use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::{client::client_with_config, protocol::WebSocketConfig, Message};

const DYNAMIC_EFFECTS_JS: &str = include_str!("../assets/dynamic-effects.v5.js");
const DYNAMIC_EFFECTS_CSS: &str = include_str!("../assets/dynamic-effects.v5.css");
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

fn http_get_json_via_powershell(port: u16, path: &str) -> Result<Value, String> {
    // Fallback when direct TcpStream to Chromium CDP is filtered in the current process.
    let script = format!(
    "$ProgressPreference='SilentlyContinue'; try {{ (Invoke-WebRequest -Uri 'http://127.0.0.1:{port}{path}' -UseBasicParsing -TimeoutSec 3).Content }} catch {{ [Console]::Error.WriteLine($_.Exception.Message); exit 2 }}"
  );
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_str(String::from_utf8_lossy(&output.stdout).trim())
        .map_err(|e| format!("CDP JSON parse failed: {e}"))
}

fn http_get_json(port: u16, path: &str) -> Result<Value, String> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let direct = (|| -> Result<Value, String> {
        let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(800))
            .map_err(|e| format!("CDP HTTP connect failed: {e}"))?;
        stream.set_nodelay(true).ok();
        stream.set_read_timeout(Some(Duration::from_secs(3))).ok();
        stream.set_write_timeout(Some(Duration::from_secs(3))).ok();
        let req = format!(
      "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
        stream
            .write_all(req.as_bytes())
            .map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        if buf.is_empty() {
            return Err("CDP HTTP empty response".into());
        }
        let text = String::from_utf8_lossy(&buf);
        let body = text
            .split("\r\n\r\n")
            .nth(1)
            .or_else(|| text.split("\n\n").nth(1))
            .ok_or_else(|| "CDP HTTP response missing body".to_string())?;
        let json_start = body
            .find(['{', '['])
            .ok_or_else(|| "CDP HTTP body has no JSON".to_string())?;
        let json = body[json_start..].trim();
        let end = json.rfind(['}', ']']).map(|i| i + 1).unwrap_or(json.len());
        serde_json::from_str(json[..end].trim_start_matches('\u{feff}'))
            .map_err(|e| format!("CDP JSON parse failed: {e}"))
    })();
    match direct {
        Ok(value) => Ok(value),
        Err(_) => http_get_json_via_powershell(port, path),
    }
}

pub fn browser_id(port: u16) -> Result<String, String> {
    let version = http_get_json(port, "/json/version")?;
    let ws = version
        .get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .unwrap_or("");
    let marker = "/devtools/browser/";
    let idx = ws
        .find(marker)
        .ok_or_else(|| "CDP version missing browser websocket".to_string())?;
    let id = &ws[idx + marker.len()..];
    let id = id.split(['?', '#']).next().unwrap_or(id);
    if id.is_empty() || id.len() > 200 {
        return Err("invalid browser id".into());
    }
    Ok(id.to_string())
}

pub fn list_app_targets(port: u16) -> Result<Vec<Value>, String> {
    let targets = http_get_json(port, "/json/list")?;
    let arr = targets
        .as_array()
        .ok_or_else(|| "CDP target list is not an array".to_string())?;
    Ok(arr
        .iter()
        .filter(|item| {
            item.get("type").and_then(Value::as_str) == Some("page")
                && item
                    .get("url")
                    .and_then(Value::as_str)
                    .map(|u| u.starts_with("app://"))
                    .unwrap_or(false)
                && item
                    .get("webSocketDebuggerUrl")
                    .and_then(Value::as_str)
                    .is_some()
        })
        .cloned()
        .collect())
}

pub fn cdp_ready(port: u16) -> bool {
    match (browser_id(port), list_app_targets(port)) {
        (Ok(_), Ok(targets)) => !targets.is_empty(),
        _ => false,
    }
}

struct CdpSession {
    socket: tungstenite::WebSocket<TcpStream>,
    next_id: u64,
}

impl CdpSession {
    fn connect(ws_url: &str) -> Result<Self, String> {
        let url = url_parse_ws(ws_url)?;
        let stream = TcpStream::connect_timeout(&url.addr, Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        stream.set_read_timeout(Some(Duration::from_secs(12))).ok();
        stream.set_write_timeout(Some(Duration::from_secs(12))).ok();
        let (socket, _) =
            client_with_config(&url.request_url, stream, Some(WebSocketConfig::default()))
                .map_err(|e| format!("CDP websocket handshake failed: {e}"))?;
        let mut session = Self { socket, next_id: 1 };
        session.send("Runtime.enable", json!({}))?;
        session.send("Page.enable", json!({}))?;
        Ok(session)
    }

    fn send(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = json!({"id": id, "method": method, "params": params});
        self.socket
            .send(Message::Text(payload.to_string()))
            .map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if Instant::now() > deadline {
                return Err(format!("CDP command timed out: {method}"));
            }
            let msg = self.socket.read().map_err(|e| e.to_string())?;
            let text = match msg {
                Message::Text(t) => t,
                Message::Ping(p) => {
                    let _ = self.socket.send(Message::Pong(p));
                    continue;
                }
                Message::Close(_) => return Err("CDP socket closed".into()),
                _ => continue,
            };
            let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(err) = value.get("error") {
                return Err(format!(
                    "{} ({})",
                    err.get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("cdp error"),
                    err.get("code").unwrap_or(&json!(null))
                ));
            }
            return Ok(value.get("result").cloned().unwrap_or(json!({})));
        }
    }

    fn evaluate(&mut self, expression: &str) -> Result<Value, String> {
        let result = self.send(
            "Runtime.evaluate",
            json!({
              "expression": expression,
              "awaitPromise": true,
              "returnByValue": true,
              "userGesture": false
            }),
        )?;
        if result.get("exceptionDetails").is_some() {
            let detail = result
                .pointer("/exceptionDetails/exception/description")
                .or_else(|| result.pointer("/exceptionDetails/text"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            return Err(format!("Renderer evaluation failed: {detail}"));
        }
        Ok(result
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }
}

struct WsUrl {
    addr: std::net::SocketAddr,
    request_url: String,
}

fn url_parse_ws(ws_url: &str) -> Result<WsUrl, String> {
    // Expect ws://127.0.0.1:PORT/devtools/page/ID
    let rest = ws_url
        .strip_prefix("ws://")
        .ok_or_else(|| "only ws:// CDP urls accepted".to_string())?;
    let (hostport, path) = rest
        .split_once('/')
        .ok_or_else(|| "invalid ws url".to_string())?;
    if !(hostport.starts_with("127.0.0.1:") || hostport.starts_with("localhost:")) {
        return Err("CDP websocket host must be loopback".into());
    }
    let port: u16 = hostport
        .rsplit(':')
        .next()
        .unwrap()
        .parse()
        .map_err(|_| "invalid port".to_string())?;
    let addr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|e| format!("{e}"))?;
    Ok(WsUrl {
        addr,
        request_url: format!("ws://127.0.0.1:{port}/{path}"),
    })
}

fn ensure_engine_expression() -> String {
    let css = serde_json::to_string(DYNAMIC_EFFECTS_CSS).unwrap();
    let js = serde_json::to_string(DYNAMIC_EFFECTS_JS).unwrap();
    format!(
        r#"(function() {{
    if (!document.getElementById('ds-dynamic-effects-css')) {{
      var style = document.createElement('style');
      style.id = 'ds-dynamic-effects-css';
      style.textContent = {css};
      (document.head || document.documentElement).appendChild(style);
    }}
    if (!window.dynamicEffects) {{
      (0, eval)({js});
    }}
    return !!(window.dynamicEffects && typeof window.dynamicEffects.setEffect === 'function');
  }})()"#
    )
}

fn set_effect_expression(effect: &str, config: &Value) -> String {
    let effect_json = serde_json::to_string(effect).unwrap();
    let config_json = serde_json::to_string(config).unwrap();
    let config_attr = serde_json::to_string(&config_json).unwrap();
    format!(
        r#"(function() {{
    var effect = {effect_json};
    var config = {config_json};
    var root = document.documentElement;
    var api = window.dynamicEffects;
    if (effect === 'none') {{
      root.removeAttribute('data-ds-effect');
      root.removeAttribute('data-ds-effect-config');
      if (api && typeof api.stop === 'function') api.stop();
      return {{ effect: 'none', verified: true, diagnostics: api && typeof api.getDiagnostics === 'function' ? api.getDiagnostics() : null, canvas: {{ connected: false, effect: null }} }};
    }}
    root.setAttribute('data-ds-effect', effect);
    root.setAttribute('data-ds-effect-config', {config_attr});
    var needsCanvas = ['rain','particles','snow','fog','stars','matrix','road'].indexOf(effect) !== -1;
    if (!needsCanvas) {{
      return {{ effect: root.getAttribute('data-ds-effect'), verified: root.getAttribute('data-ds-effect') === effect, diagnostics: api && typeof api.getDiagnostics === 'function' ? api.getDiagnostics() : null, canvas: {{ connected: false, effect: null }} }};
    }}
    if (!api || typeof api.setEffect !== 'function' || typeof api.getDiagnostics !== 'function') {{
      return {{ effect: root.getAttribute('data-ds-effect'), verified: false, reason: '动态引擎未就绪' }};
    }}
    var started = api.setEffect(effect, config);
    var diagnostics = api.getDiagnostics();
    var canvas = document.getElementById('ds-dynamic-canvas');
    var canvasState = {{ connected: Boolean(canvas && canvas.isConnected), effect: root.getAttribute('data-ds-canvas-effect'), width: canvas ? canvas.width : 0, height: canvas ? canvas.height : 0 }};
    return {{ effect: root.getAttribute('data-ds-effect'), verified: Boolean(started && diagnostics && diagnostics.active && diagnostics.effect === effect && canvasState.connected && canvasState.effect === effect), diagnostics: diagnostics, canvas: canvasState }};
  }})()"#
    )
}

pub fn apply_effect(
    port: u16,
    effect: &str,
    config: Value,
    expected_browser_id: Option<&str>,
    timeout_ms: u64,
) -> Result<Value, String> {
    if !EFFECT_TYPES.contains(&effect) {
        return Err(format!("不支持的动态效果类型: {effect}"));
    }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(250));
    let mut last_err = "timed out".to_string();
    while Instant::now() < deadline {
        match try_apply_once(port, effect, &config, expected_browser_id) {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_err = e;
                std::thread::sleep(Duration::from_millis(350));
            }
        }
    }
    Err(format!(
        "No verified Codex renderer on 127.0.0.1:{port}: {last_err}"
    ))
}

fn try_apply_once(
    port: u16,
    effect: &str,
    config: &Value,
    expected_browser_id: Option<&str>,
) -> Result<Value, String> {
    if let Some(expected) = expected_browser_id {
        if !expected.is_empty() {
            let actual = browser_id(port)?;
            if actual != expected {
                return Err(format!(
                    "CDP browser identity changed from {expected} to {actual}"
                ));
            }
        }
    }
    let targets = list_app_targets(port)?;
    if targets.is_empty() {
        return Err("no app:// page targets".into());
    }
    let mut results = Vec::new();
    for target in targets {
        let ws = target
            .get("webSocketDebuggerUrl")
            .and_then(Value::as_str)
            .unwrap_or("");
        let id = target
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut session = CdpSession::connect(ws)?;
        let ready = session.evaluate(&ensure_engine_expression())?;
        if ready.as_bool() != Some(true) && effect != "none" {
            results.push(json!({"targetId": id, "ok": false, "verified": false, "reason": "动态引擎注入失败"}));
            continue;
        }
        let value = session.evaluate(&set_effect_expression(effect, config))?;
        results.push(json!({
          "targetId": id,
          "ok": value.get("verified") == Some(&json!(true)),
          "effect": value.get("effect"),
          "verified": value.get("verified") == Some(&json!(true)),
          "diagnostics": value.get("diagnostics"),
          "canvas": value.get("canvas"),
          "reason": value.get("reason")
        }));
    }
    let verified = !results.is_empty()
        && results
            .iter()
            .all(|r| r.get("verified") == Some(&json!(true)));
    let applied = results
        .iter()
        .filter(|r| r.get("verified") == Some(&json!(true)))
        .count();
    if !verified {
        return Err(format!(
            "动态效果注入未全部验证通过: {}",
            json!({"results": results})
        ));
    }
    Ok(json!({
      "ok": true,
      "effect": effect,
      "type": effect,
      "applied": applied,
      "total": results.len(),
      "verified": true,
      "results": results
    }))
}

#[allow(dead_code)]
pub fn embedded_effects_js() -> &'static str {
    DYNAMIC_EFFECTS_JS
}

/// Evaluate an expression on every valid app:// Codex page target.
pub fn evaluate_on_app_targets(
    port: u16,
    expression: &str,
    expected_browser_id: Option<&str>,
) -> Result<Value, String> {
    if let Some(expected) = expected_browser_id {
        if !expected.is_empty() {
            let actual = browser_id(port)?;
            if actual != expected {
                return Err(format!(
                    "CDP browser identity changed from {expected} to {actual}"
                ));
            }
        }
    }
    let targets = list_app_targets(port)?;
    if targets.is_empty() {
        return Err("no app:// page targets".into());
    }
    let mut results = Vec::new();
    for target in targets {
        let ws = target
            .get("webSocketDebuggerUrl")
            .and_then(Value::as_str)
            .unwrap_or("");
        let id = target
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut session = CdpSession::connect(ws)?;
        match session.evaluate(expression) {
            Ok(value) => results.push(json!({"targetId": id, "ok": true, "value": value})),
            Err(error) => results.push(json!({"targetId": id, "ok": false, "error": error})),
        }
    }
    let ok = !results.is_empty() && results.iter().all(|r| r.get("ok") == Some(&json!(true)));
    if !ok {
        return Err(format!(
            "CDP evaluate failed: {}",
            json!({"results": results})
        ));
    }
    Ok(json!({"ok": true, "applied": results.len(), "results": results}))
}

#[cfg(test)]
mod tests {
    #[test]
    fn probes_live_cdp_if_present() {
        match super::http_get_json(9335, "/json/version") {
            Ok(v) => eprintln!("version_ok={v}"),
            Err(e) => eprintln!("version_err={e}"),
        }
        match super::browser_id(9335) {
            Ok(v) => eprintln!("browser_ok={v}"),
            Err(e) => eprintln!("browser_err={e}"),
        }
        match super::list_app_targets(9335) {
            Ok(v) => eprintln!("targets_ok={}", v.len()),
            Err(e) => eprintln!("targets_err={e}"),
        }
        eprintln!("cdp_ready={}", super::cdp_ready(9335));
    }
}
