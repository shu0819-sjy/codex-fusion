/// 隐藏控制台子进程窗口的工具。
///
/// GUI 子系统宿主（无控制台）用 `std::process::Command` 拉起控制台子进程
/// （powershell.exe / fusion-bridge.exe）时，Windows 默认会给子进程新建一个
/// 黑色控制台窗口（标题为 exe 路径）。加上 CREATE_NO_WINDOW(0x08000000)
/// 后子进程不创建窗口、后台静默运行。
///
/// 注意：仅用于探测/桥接等后台辅助进程；Codex 主应用（ChatGPT.exe）与
/// explorer.exe 这类需要用户可见窗口的进程**不得**调用本函数。
#[cfg(windows)]
pub fn hide_console(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_console(_cmd: &mut std::process::Command) {}
