// Run Vite on port 1427, then `cargo run --example preview_test`.
// This small native host exercises the real resource protocol without opening
// the user's workspace or replacing a running idea-note.exe.
#[path = "../src/html_preview.rs"]
mod html_preview;
use tauri::Manager;

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| e.to_string())
}
#[tauri::command]
fn file_stat(path: String) -> Result<(u64, u64), String> {
    std::fs::metadata(path)
        .map(|m| (1, m.len()))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn sync_config_load() -> String {
    "{}".into()
}
#[tauri::command]
fn git_proxy_load() -> String {
    String::new()
}

fn main() {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let mut url =
        tauri::Url::parse("http://localhost:1427/tests/filePreview.browser.html").unwrap();
    url.query_pairs_mut()
        .append_pair(
            "nativeRoot",
            &repo.join("tests/preview-fixtures").to_string_lossy(),
        )
        .append_pair(
            "report",
            &repo
                .join("tests/.native-preview-report.local")
                .to_string_lossy(),
        );
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "com.liubs.idea-note.previewtest".into();
    context.config_mut().build.dev_url = Some(tauri::Url::parse("http://localhost:1427").unwrap());
    context.config_mut().app.windows = vec![tauri::utils::config::WindowConfig {
        label: "main-preview-test".into(),
        url: tauri::WebviewUrl::External(url),
        visible: false,
        width: 1000.0,
        height: 750.0,
        ..Default::default()
    }];
    let log = repo.join("tests/.native-preview-load.local");
    tauri::Builder::default()
        .manage(html_preview::PreviewState::default())
        .register_asynchronous_uri_scheme_protocol("note-preview", |ctx, req, responder| {
            let state = ctx
                .app_handle()
                .state::<html_preview::PreviewState>()
                .inner()
                .clone();
            let owner = ctx.webview_label().to_owned();
            std::thread::spawn(move || responder.respond(state.respond(&owner, req)));
        })
        .on_page_load(move |_, payload| {
            let _ = std::fs::write(&log, payload.url().as_str());
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .state::<html_preview::PreviewState>()
                    .remove_owner(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            file_stat,
            sync_config_load,
            git_proxy_load,
            html_preview::create_preview_session,
            html_preview::close_preview_session
        ])
        .run(context)
        .expect("native preview test host");
}
