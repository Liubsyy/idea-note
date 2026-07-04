// AI model configuration persistence (app config dir, plaintext JSON).

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// Absolute path to the AI models config file (created lazily on first save).
/// Lives in the app config dir so it's separate from the per-window localStorage
/// the UI settings use.
fn ai_models_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("ai-models.json"))
}

/// Load the raw AI models JSON. Missing file yields an empty array so the
/// frontend always gets valid JSON to parse.
#[tauri::command]
pub fn ai_models_load(app: AppHandle) -> Result<String, String> {
    let path = ai_models_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(_) => Ok("[]".to_string()),
    }
}

/// Persist the AI models JSON (whole list), creating the config dir if needed.
/// NOTE: API keys are stored in plaintext here for now — keep this the single
/// read/write choke point so it can later move to the OS keychain / encryption.
#[tauri::command]
pub fn ai_models_save(app: AppHandle, json: String) -> Result<(), String> {
    let path = ai_models_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, json).map_err(|e| e.to_string())
}
