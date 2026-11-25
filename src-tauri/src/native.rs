//! 官方插件没覆盖到的几件平台小事：放行路径、读剪贴板里的文件列表、用系统程序打开路径。
//! 每个命令都尽量短，说明写在各自上面。

use tauri::Manager;
use tauri_plugin_fs::FsExt;

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

/// 流式计算本地文件的 SHA-256（小写 64 位十六进制），即使大视频也只占用固定 64 KB 缓冲。
#[tauri::command]
pub async fn file_sha256(path: String) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::fmt::Write;
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buf).await.map_err(|error| error.to_string())?;
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
