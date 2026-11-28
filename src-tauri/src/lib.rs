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
        .manage(native::PreviewState::default())
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Destroyed if window.label() == "main" => {
                    if let Some(preview) = window.app_handle().get_webview_window("preview") {
                        let _ = preview.destroy();
                    }
                    window.app_handle().exit(0);
                }
                tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "preview" => {
                    api.prevent_close();
                    native::handle_preview_close_requested(window.app_handle());
                }
                tauri::WindowEvent::Focused(true) if window.label() == "preview" => {
                    native::handle_preview_focus(window.app_handle());
                }
                tauri::WindowEvent::Focused(false) if window.label() == "preview" => {
                    native::handle_preview_blur(window.app_handle());
                }
                _ => {}
            }
        })
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
            native::file_sha256,
            native::load_pose_body_pack,
            native::scan_poses_dir,
            native::open_preview_window,
            native::close_preview_window,
            native::get_preview_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
