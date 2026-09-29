//! 轻量文件日志：release 构建为 GUI 子系统（无控制台），eprintln!/panic 输出默认全部丢失，
//! 导致排障黑盒。这里把诊断输出落地到 fusion_root()/host-out.log，panic 额外写 host-crash.log。

use std::fs::OpenOptions;
use std::io::Write;
use std::sync::{Mutex, OnceLock};

/// 本地时间戳。Windows 上用 kernel32 GetLocalTime（正确含时区），非 Windows 回退 UTC 算法。
// cfg 双块互斥时 Windows 块必须用 return 提前退出（块是语句位置，尾值 String 会类型不匹配），
// clippy 的 needless_return 在此是误报。
#[allow(clippy::needless_return)]
fn now() -> String {
    #[cfg(windows)]
    {
        #[repr(C)]
        struct SystemTimeFields {
            year: u16,
            month: u16,
            day_of_week: u16,
            day: u16,
            hour: u16,
            minute: u16,
            second: u16,
            milliseconds: u16,
        }
        extern "system" {
            fn GetLocalTime(lp_system_time: *mut SystemTimeFields);
        }
        let mut st = SystemTimeFields {
            year: 0,
            month: 0,
            day_of_week: 0,
            day: 0,
            hour: 0,
            minute: 0,
            second: 0,
            milliseconds: 0,
        };
        unsafe { GetLocalTime(&mut st) };
        return format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            st.year, st.month, st.day, st.hour, st.minute, st.second
        );
    }
    #[cfg(not(windows))]
    {
        utc_now()
    }
}

/// UTC 时间（civil-from-days，Howard Hinnant 算法），非 Windows 平台回退用。
#[cfg(not(windows))]
fn utc_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mon = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mon <= 2 {
        yoe as i64 + era * 400 + 1
    } else {
        yoe as i64 + era * 400
    };
    format!("{y:04}-{mon:02}-{d:02} {h:02}:{m:02}:{s:02}")
}

/// 写一行带时间戳的日志（线程安全、追加写）。
pub fn line(msg: &str) {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let guard = match LOCK.get_or_init(|| Mutex::new(())).lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let path = crate::fusion_root().join("host-out.log");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "[{}] {msg}", now());
    }
    drop(guard);
}

/// 初始化日志与 panic hook：崩溃时把现场写入 host-crash.log，避免 GUI 子系统吞掉 panic。
pub fn init() {
    line("host started");
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic".into()
        };
        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let msg = format!("PANIC: {payload} @ {loc}");
        let crash_path = crate::fusion_root().join("host-crash.log");
        if let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&crash_path)
        {
            let _ = writeln!(f, "[{}] {msg}", now());
        }
        line(&msg);
        default_hook(info);
    }));
}

#[cfg(test)]
mod tests {
    #[test]
    fn timestamp_format_is_absolute() {
        let s = super::now();
        assert_eq!(s.len(), 19, "expected YYYY-MM-DD HH:MM:SS, got {s}");
        assert!(s.starts_with("20"), "expected year 20xx, got {s}");
        assert!(s.contains('-') && s.contains(':'));
    }
}
