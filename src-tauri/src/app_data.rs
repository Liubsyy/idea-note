// Persistence for UI-owned JSON blobs that used to live in the WebView's
// localStorage but belong on disk: the AI chat sessions (real user content that
// can grow past the ~5MB localStorage quota) and the per-workspace sync config
// (holds a proxy / git settings). Both are plaintext JSON in the app config
// dir, mirroring `ai_models.rs`. Keep these the single read/write choke points
// so the on-disk format (or future encryption) can change here alone.

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// Absolute path to a named JSON file in the app config dir.
fn config_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

/// Read a config file, returning `empty` (valid JSON) when it doesn't exist yet
/// so the frontend always gets something parseable.
fn load_blob(app: &AppHandle, name: &str, empty: &str) -> Result<String, String> {
    let path = config_file(app, name)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(_) => Ok(empty.to_string()),
    }
}

/// Persist a config file (whole blob), creating the config dir if needed.
fn save_blob(app: &AppHandle, name: &str, json: String) -> Result<(), String> {
    let path = config_file(app, name)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, json).map_err(|e| e.to_string())
}

fn session_file_name(id: &str) -> String {
    let mut out = String::new();
    for b in id.bytes() {
        let c = b as char;
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    if out.is_empty() {
        "session".to_string()
    } else {
        out
    }
}

fn sessions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("ai-sessions"))
}

fn session_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(sessions_dir(app)?.join(format!("{}.json", session_file_name(id))))
}

fn parse_sessions_blob(json_text: &str) -> Result<Value, String> {
    serde_json::from_str(json_text).map_err(|e| e.to_string())
}

fn session_has_content(session: &Value) -> bool {
    session
        .get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
        || session
            .get("history")
            .and_then(Value::as_array)
            .is_some_and(|history| !history.is_empty())
}

fn write_sessions_index(
    app: &AppHandle,
    session_ids: Vec<Value>,
    active: Value,
) -> Result<(), String> {
    save_blob(
        app,
        "ai-sessions-index.json",
        json!({ "sessionIds": session_ids, "activeSessionId": active }).to_string(),
    )
}

fn save_sessions_split(app: &AppHandle, json_text: String) -> Result<(), String> {
    let data = parse_sessions_blob(&json_text)?;
    let sessions = data
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or_else(|| "missing sessions array".to_string())?;
    let active_id = data
        .get("activeSessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let dir = sessions_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut ids = Vec::new();
    let mut live_files = std::collections::HashSet::new();
    for session in sessions {
        if let Some(id) = session.get("id").and_then(Value::as_str) {
            if !session_has_content(session) {
                let _ = fs::remove_file(session_file(app, id)?);
                continue;
            }
            ids.push(Value::String(id.to_string()));
            let path = session_file(app, id)?;
            live_files.insert(path.clone());
            let text = serde_json::to_string(session).map_err(|e| e.to_string())?;
            fs::write(path, text).map_err(|e| e.to_string())?;
        }
    }

    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json")
                && !live_files.contains(&path)
            {
                let _ = fs::remove_file(path);
            }
        }
    }

    let active = active_id
        .filter(|active| ids.iter().any(|id| id.as_str() == Some(active.as_str())))
        .map(Value::String)
        .unwrap_or_else(|| ids.first().cloned().unwrap_or(Value::Null));

    write_sessions_index(app, ids, active)
}

fn load_sessions_split(app: &AppHandle) -> Result<Option<String>, String> {
    let index_text = load_blob(app, "ai-sessions-index.json", "null")?;
    if index_text == "null" {
        return Ok(None);
    }
    let index = parse_sessions_blob(&index_text)?;
    let ids = index
        .get("sessionIds")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let active = index.get("activeSessionId").cloned().unwrap_or(Value::Null);
    let mut sessions = Vec::new();
    for id in ids {
        let Some(id) = id.as_str() else {
            continue;
        };
        let path = session_file(app, id)?;
        if let Ok(text) = fs::read_to_string(path) {
            if let Ok(session) = parse_sessions_blob(&text) {
                if session_has_content(&session) {
                    sessions.push(session);
                }
            }
        }
    }
    Ok(Some(
        json!({ "sessions": sessions, "activeSessionId": active }).to_string(),
    ))
}

/// AI chat sessions. New storage is ai-sessions-index.json + one file per
/// session under ai-sessions/. If only the legacy ai-sessions.json exists, load
/// it and migrate it into the split layout.
#[tauri::command]
pub fn chat_sessions_load(app: AppHandle) -> Result<String, String> {
    if let Some(split) = load_sessions_split(&app)? {
        return Ok(split);
    }

    let legacy = load_blob(&app, "ai-sessions.json", "null")?;
    if legacy != "null" {
        save_sessions_split(&app, legacy.clone())?;
    }
    Ok(legacy)
}

#[tauri::command]
pub fn chat_sessions_save(app: AppHandle, json: String) -> Result<(), String> {
    save_sessions_split(&app, json)
}

#[tauri::command]
pub fn chat_sessions_index_save(app: AppHandle, json: String) -> Result<(), String> {
    save_blob(&app, "ai-sessions-index.json", json)
}

#[tauri::command]
pub fn chat_session_save(app: AppHandle, id: String, json: String) -> Result<(), String> {
    let session = parse_sessions_blob(&json)?;
    let path = session_file(&app, &id)?;
    if !session_has_content(&session) {
        if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_session_delete(app: AppHandle, id: String) -> Result<(), String> {
    let path = session_file(&app, &id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Per-workspace sync config, keyed by workspace path ({ [path]: SyncConfig }).
/// Missing file yields an empty object.
#[tauri::command]
pub fn sync_config_load(app: AppHandle) -> Result<String, String> {
    load_blob(&app, "sync-config.json", "{}")
}

#[tauri::command]
pub fn sync_config_save(app: AppHandle, json: String) -> Result<(), String> {
    save_blob(&app, "sync-config.json", json)
}

/// Global HTTP proxy for sync's network commands, shared by all workspaces.
/// Stored as the raw proxy string; missing file yields an empty string.
#[tauri::command]
pub fn git_proxy_load(app: AppHandle) -> Result<String, String> {
    load_blob(&app, "git-proxy.txt", "")
}

#[tauri::command]
pub fn git_proxy_save(app: AppHandle, proxy: String) -> Result<(), String> {
    save_blob(&app, "git-proxy.txt", proxy)
}
