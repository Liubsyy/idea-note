// Idea Note - Rust backend commands for the file workspace.
// All file I/O goes through these commands so behavior is identical across
// desktop and (future) mobile targets. Each functional area lives in its own
// module; this file only declares them and assembles the Tauri builder.

mod ai_models;
mod app_data;
mod clipboard;
mod encoding;
mod files;
mod git;
mod open_with;
mod print;
mod proc;
mod search;
mod terminal;
mod tree;

use open_with::PendingOpenFiles;
use terminal::TerminalState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Windows/Linux deliver an "Open With" launch as a file path in this
    // process's own argv. Seed the cold-start queue before the window loads;
    // macOS uses the "Opened" event instead (handled in the run loop below).
    let pending = PendingOpenFiles::default();
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let args: Vec<String> = std::env::args().collect();
        let cwd = std::env::current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default();
        let _ = pending.queue_if_not_ready(&open_with::file_paths_from_args(&args, &cwd));
    }

    let builder = tauri::Builder::default();

    // The single-instance plugin must be registered first. When a second
    // "Open With" launch happens while the app runs (Windows/Linux spawn a new
    // process), it forwards that process's argv here, into the live instance.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        use tauri::{Emitter, Manager};
        let paths = open_with::file_paths_from_args(&argv, &cwd);
        if paths.is_empty() {
            return;
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
        let queued = app
            .try_state::<PendingOpenFiles>()
            .is_some_and(|pending| pending.queue_if_not_ready(&paths));
        if !queued {
            let _ = app.emit("open-files", paths);
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    // Persist and restore window size/position across launches (desktop only).
    // DECORATIONS is excluded: chrome is fixed per platform by the config
    // (Windows runs undecorated with custom controls), and a stale saved
    // `decorations: true` must not bring the native title bar back.
    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_window_state::Builder::default()
            .with_state_flags(
                tauri_plugin_window_state::StateFlags::all()
                    - tauri_plugin_window_state::StateFlags::DECORATIONS,
            )
            .build(),
    );

    // Windows: tao can seed dev windows with a too-small icon, and Explorer may
    // cache it before the app finishes loading. Hand every window both the
    // taskbar-size and caption-size icons as its page loads (covers the initial
    // window plus later "main-N" and "settings" windows; re-runs on navigation,
    // which is harmless).
    #[cfg(target_os = "windows")]
    let builder = builder.on_page_load(|webview, _payload| {
        set_big_window_icon(&webview.window());
    });

    builder
        .manage(TerminalState::default())
        .manage(encoding::EncodingState::default())
        .manage(pending)
        .invoke_handler(tauri::generate_handler![
            open_with::take_pending_open_files,
            tree::list_dir,
            tree::search_notes,
            search::global_search,
            search::global_search_stream,
            search::stop_global_search,
            files::read_file,
            files::file_stat,
            files::is_dir,
            files::write_file,
            files::write_binary_file,
            files::save_file_to_dir,
            files::create_file,
            files::create_raw_file,
            files::create_folder,
            files::rename,
            files::move_path,
            files::delete,
            files::show_file_info,
            clipboard::copy_file_to_clipboard,
            clipboard::paste_from_clipboard,
            clipboard::list_clipboard_files,
            clipboard::save_clipboard_image_to_dir,
            clipboard::read_clipboard_text,
            ai_models::ai_models_load,
            ai_models::ai_models_save,
            app_data::chat_sessions_load,
            app_data::chat_sessions_save,
            app_data::chat_sessions_index_save,
            app_data::chat_session_save,
            app_data::chat_session_delete,
            app_data::sync_config_load,
            app_data::sync_config_save,
            app_data::git_proxy_load,
            app_data::git_proxy_save,
            git::git_run,
            git::git_run_with_credential,
            git::git_credential_approve,
            print::print_page,
            print::export_pdf,
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // macOS "Open With" / file-association launches arrive as Apple
            // "Opened" events. Forward the file paths to the frontend; if no
            // window exists yet (the app was launched *to* open the file),
            // stash them for the frontend to drain once it loads.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = event {
                use tauri::{Emitter, Manager};
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect();
                if paths.is_empty() {
                    return;
                }
                // Queue during a cold start (frontend not ready); otherwise hand
                // the paths to the running frontend live.
                let queued = app_handle
                    .try_state::<PendingOpenFiles>()
                    .is_some_and(|pending| pending.queue_if_not_ready(&paths));
                if !queued {
                    let _ = app_handle.emit("open-files", paths);
                }
            }
            // Silence the unused-variable warning on platforms without `Opened`.
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
            {
                let _ = (app_handle, event);
            }
        });
}

/// Give a window the taskbar-size and caption-size icons from the exe resource.
///
/// The exe carries the full multi-size .ico (embedded by tauri-build). Pull the
/// standard big/small icons from its first icon group and hand both to the
/// window so Explorer does not cache an upscaled small fallback. The extracted
/// HICONs are intentionally never destroyed: the window keeps using them for
/// its whole lifetime.
#[cfg(target_os = "windows")]
fn set_big_window_icon<R: tauri::Runtime>(window: &tauri::Window<R>) {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::Shell::ExtractIconExW;
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageW, HICON, ICON_BIG, ICON_SMALL, WM_SETICON,
    };

    let Ok(hwnd) = window.hwnd() else { return };
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let path: Vec<u16> = exe.as_os_str().encode_wide().chain([0]).collect();
    let mut big = HICON::default();
    let mut small = HICON::default();
    unsafe {
        ExtractIconExW(
            PCWSTR(path.as_ptr()),
            0,
            Some(&mut big),
            Some(&mut small),
            1,
        );
        if !big.is_invalid() {
            SendMessageW(
                hwnd,
                WM_SETICON,
                Some(WPARAM(ICON_BIG as usize)),
                Some(LPARAM(big.0 as isize)),
            );
        }
        if !small.is_invalid() {
            SendMessageW(
                hwnd,
                WM_SETICON,
                Some(WPARAM(ICON_SMALL as usize)),
                Some(LPARAM(small.0 as isize)),
            );
        }
    }
}
