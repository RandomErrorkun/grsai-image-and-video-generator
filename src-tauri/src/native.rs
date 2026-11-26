//! 官方插件没覆盖到的几件平台小事：放行路径、读剪贴板里的文件列表、用系统程序打开路径。
//! 每个命令都尽量短，说明写在各自上面。

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;

/// 全屏独立预览子窗口的共享状态：保存当前预览路径、打开时刻与是否曾获得焦点，并用异步互斥锁串行化建窗。
#[derive(Default)]
pub struct PreviewState {
    inner: Mutex<PreviewInner>,
    op_lock: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct PreviewInner {
    path: Option<String>,
    opened_at: Option<Instant>,
    has_focused: bool,
}

/// 打开或复用全屏独立预览子窗口（覆盖主窗口所在的整个显示器，无边框透明暗底浮层）。
/// 注意：Windows 下 WebviewWindowBuilder::build 必须在 async 命令里调用，同步命令运行在 UI 线程会直接死锁 WebView2。
#[tauri::command]
pub async fn open_preview_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, PreviewState>,
    path: String,
) -> Result<(), String> {
    if path.is_empty() {
        return Ok(());
    }

    let _guard = state.op_lock.lock().await;

    // 先放行该文件，确保子窗口立刻可读
    let file_path = std::path::PathBuf::from(&path);
    let _ = app.fs_scope().allow_file(&file_path);
    let _ = app.asset_protocol_scope().allow_file(&file_path);

    // 记下当前路径和打开时刻，重置焦点标志（等子窗口真正获得一次焦点后才允许失焦自动隐藏）
    if let Ok(mut guard) = state.inner.lock() {
        guard.path = Some(path.clone());
        guard.opened_at = Some(Instant::now());
        guard.has_focused = false;
    }

    // 获取主窗口所在的显示器几何信息（支持多显示器与不同 DPI 缩放）
    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());

    if let Some(preview) = app.get_webview_window("preview") {
        if let Some(m) = monitor {
            let pos = m.position();
            let size = m.size();
            let _ = preview.set_position(PhysicalPosition::new(pos.x, pos.y));
            let _ = preview.set_size(PhysicalSize::new(size.width, size.height));
        }
        let _ = preview.show();
        let _ = preview.set_focus();
        let _ = preview.emit("preview:open", &path);
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(
        &app,
        "preview",
        WebviewUrl::App("index.html?window=preview".into()),
    )
    .title("Preview")
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .resizable(false)
    .visible(false);

    if let Some(m) = &monitor {
        let scale = m.scale_factor();
        let pos = m.position();
        let size = m.size();
        builder = builder
            .position(pos.x as f64 / scale, pos.y as f64 / scale)
            .inner_size(size.width as f64 / scale, size.height as f64 / scale);
    }

    let preview = builder.build().map_err(|err| err.to_string())?;
    if let Some(m) = monitor {
        let pos = m.position();
        let size = m.size();
        let _ = preview.set_position(PhysicalPosition::new(pos.x, pos.y));
        let _ = preview.set_size(PhysicalSize::new(size.width, size.height));
    }
    let _ = preview.show();
    let _ = preview.set_focus();
    Ok(())
}

/// 关闭（隐藏复用）全屏预览子窗口，并将焦点交还主窗口。
/// 当 return_to_main 为 true 时，通知主窗口重新以窗口内灯箱打开当前文件，实现 F11 / 按钮无缝切换。
#[tauri::command]
pub async fn close_preview_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, PreviewState>,
    return_to_main: Option<bool>,
) -> Result<(), String> {
    let _guard = state.op_lock.lock().await;
    let prev_path = if let Ok(mut guard) = state.inner.lock() {
        guard.has_focused = false;
        guard.path.take()
    } else {
        None
    };
    if let Some(preview) = app.get_webview_window("preview") {
        let _ = preview.emit("preview:closed", ());
        let _ = preview.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        if return_to_main.unwrap_or(false) {
            if let Some(path) = prev_path {
                let _ = main.emit("preview:restore_inline", &path);
            }
        }
        let _ = main.set_focus();
    }
    Ok(())
}

/// 预览子窗口启动后主动拉取当前待展示路径，避免首次建窗与事件推送竞态。
#[tauri::command]
pub fn get_preview_path(state: tauri::State<'_, PreviewState>) -> Option<String> {
    state.inner.lock().ok().and_then(|g| g.path.clone())
}

/// 预览窗口获得焦点时标记已就绪。
pub fn handle_preview_focus(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<PreviewState>() {
        if let Ok(mut guard) = state.inner.lock() {
            if guard.path.is_some() {
                guard.has_focused = true;
            }
        }
    }
}

/// 预览窗口收到关闭请求（如 Alt+F4）时改为隐藏复用并清空状态、通知前端停播。
pub fn handle_preview_close_requested(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<PreviewState>() {
        if let Ok(mut guard) = state.inner.lock() {
            guard.path = None;
            guard.has_focused = false;
        }
    }
    if let Some(preview) = app.get_webview_window("preview") {
        let _ = preview.emit("preview:closed", ());
        let _ = preview.hide();
    }
}

/// 预览窗口失焦（例如点击到其他显示器或切到外部程序）时自动关闭；仅在获得过焦点且超过 250ms 后生效。
pub fn handle_preview_blur(app: &tauri::AppHandle) {
    let should_close = app
        .try_state::<PreviewState>()
        .and_then(|state| {
            state.inner.lock().ok().map(|g| {
                g.path.is_some()
                    && g.has_focused
                    && g.opened_at
                        .map(|at| at.elapsed() > Duration::from_millis(250))
                        .unwrap_or(true)
            })
        })
        .unwrap_or(false);
    if !should_close {
        return;
    }
    if let Some(state) = app.try_state::<PreviewState>() {
        if let Ok(mut guard) = state.inner.lock() {
            guard.path = None;
            guard.has_focused = false;
        }
    }
    if let Some(preview) = app.get_webview_window("preview") {
        let _ = preview.emit("preview:closed", ());
        let _ = preview.hide();
    }
}

/// 把路径加进文件插件和资源协议的作用域。对话框选中的路径插件会自动放行，
/// 拖进来的、从历史记录里翻出来的、用户另选的输出文件夹要靠这个命令。
/// recursive 为真时把整个目录连同子目录一起放行。
#[tauri::command]
pub fn allow_paths(app: tauri::AppHandle, paths: Vec<String>, recursive: Option<bool>) -> Result<(), String> {
    let recursive = recursive.unwrap_or(false);
    for path in paths.iter().filter(|path| !path.is_empty()) {
        let path = std::path::PathBuf::from(path);
        let allowed = if recursive {
            app.fs_scope()
                .allow_directory(&path, true)
                .and_then(|_| app.asset_protocol_scope().allow_directory(&path, true))
        } else {
            app.fs_scope()
                .allow_file(&path)
                .and_then(|_| app.asset_protocol_scope().allow_file(&path))
        };
        allowed.map_err(|error| format!("{}: {error}", path.display()))?;
    }
    Ok(())
}

/// 用系统默认程序打开一个文件，或者用资源管理器打开一个文件夹。
/// 对应源项目的 QDesktopServices.openUrl(QUrl.fromLocalFile(...))。
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|error| error.to_string())
}

/// 剪贴板里的文件列表，也就是在资源管理器里复制的文件。没有就返回空数组。
#[tauri::command]
pub fn clipboard_files() -> Vec<String> {
    clipboard::file_list().unwrap_or_default()
}

/// 流式计算本地文件的 SHA-256（小写 64 位十六进制）。
/// 在单独的阻塞线程池任务中使用 2 MB 连续缓冲同步读取，避免大图片（8MB+）和 2K 长视频触发数千次异步调度与阻塞 tokio 工作线程。
#[tauri::command]
pub async fn file_sha256(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use sha2::{Digest, Sha256};
        use std::fmt::Write;
        use std::io::Read;

        let mut file = std::fs::File::open(&path).map_err(|error| error.to_string())?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 2 * 1024 * 1024];
        loop {
            let count = file.read(&mut buf).map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            hasher.update(&buf[..count]);
        }
        let digest = hasher.finalize();
        let mut hex = String::with_capacity(digest.len() * 2);
        for byte in digest {
            let _ = write!(&mut hex, "{byte:02x}");
        }
        Ok(hex)
    })
    .await
    .map_err(|error| error.to_string())?
}

mod clipboard {
    /// Windows 剪贴板里的文件列表格式代号（CF_HDROP）。
    #[cfg(windows)]
    const CF_HDROP: u32 = 15;

    #[cfg(windows)]
    pub fn file_list() -> Option<Vec<String>> {
        use windows_sys::Win32::System::DataExchange::{
            CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        };

        // SAFETY: 剪贴板只在 OpenClipboard 和 CloseClipboard 之间可以读。
        // 没打开成功就直接返回，打开了才关。
        unsafe {
            if OpenClipboard(std::ptr::null_mut()) == 0 {
                return None;
            }
            let files = if IsClipboardFormatAvailable(CF_HDROP) == 0 {
                None
            } else {
                read_files(GetClipboardData(CF_HDROP))
            };
            CloseClipboard();
            files
        }
    }

    /// 把 CF_HDROP 句柄里的路径逐个读出来；句柄为空返回 None。
    ///
    /// # Safety
    ///
    /// 只能在剪贴板打开期间调用，handle 必须是 GetClipboardData 给的原样句柄。
    #[cfg(windows)]
    unsafe fn read_files(handle: windows_sys::Win32::Foundation::HANDLE) -> Option<Vec<String>> {
        use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

        let drop = handle as HDROP;
        if drop.is_null() {
            return None;
        }
        // SAFETY: 调用方保证剪贴板正开着，drop 是它给的原样句柄；
        // 缓冲区按上一步问到的长度分配，多留一个位置给结尾的零。
        unsafe {
            // 序号给 u32::MAX 是问文件个数；之后逐个问长度、再取内容，长度不含结尾的零
            let count = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);
            let mut files = Vec::with_capacity(count as usize);
            for index in 0..count {
                let length = DragQueryFileW(drop, index, std::ptr::null_mut(), 0);
                let mut buffer = vec![0u16; length as usize + 1];
                let copied = DragQueryFileW(drop, index, buffer.as_mut_ptr(), buffer.len() as u32);
                if copied > 0 {
                    files.push(String::from_utf16_lossy(&buffer[..copied as usize]));
                }
            }
            Some(files)
        }
    }

    #[cfg(not(windows))]
    pub fn file_list() -> Option<Vec<String>> {
        None
    }
}
