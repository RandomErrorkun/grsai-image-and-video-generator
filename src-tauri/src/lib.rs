use tauri::Manager;

mod api;
mod native;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(api::ApiState::default())
        .setup(|app| {
            // 防止从隐藏控制台（SW_HIDE）拉起时主窗口被继承的 ShowWindow 参数隐藏
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api::api_request,
            api::api_download,
            api::api_probe_remote_sha256,
            native::allow_paths,
            native::open_path,
            native::clipboard_files,
            native::file_sha256
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
