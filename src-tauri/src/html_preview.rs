//! Read-only, window-owned resource sessions for sandboxed HTML previews.
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use rand::RngCore;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{
    http::{Request, Response},
    State, WebviewWindow,
};

#[derive(Clone)]
struct Session {
    owner: String,
    root: PathBuf,
}
#[derive(Clone, Default)]
pub struct PreviewState(Arc<Mutex<HashMap<String, Session>>>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSession {
    session_id: String,
    base_url: String,
}

impl PreviewState {
    fn create(
        &self,
        owner: &str,
        path: &Path,
        workspace: Option<&Path>,
    ) -> Result<PreviewSession, String> {
        let file = path.canonicalize().map_err(|e| e.to_string())?;
        if !file.is_file() {
            return Err("HTML 文件不存在".into());
        }
        let directory = file.parent().ok_or("文件没有父目录")?;
        let root = workspace
            .and_then(|p| p.canonicalize().ok())
            .filter(|p| p.is_dir() && file.starts_with(p))
            .unwrap_or_else(|| directory.to_owned());
        let relative = directory.strip_prefix(&root).map_err(|e| e.to_string())?;
        let encoded = relative
            .components()
            .map(|part| {
                utf8_percent_encode(&part.as_os_str().to_string_lossy(), NON_ALPHANUMERIC)
                    .to_string()
            })
            .collect::<Vec<_>>()
            .join("/");
        let mut random = [0u8; 24];
        rand::rngs::OsRng.fill_bytes(&mut random);
        let id = random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        #[cfg(any(target_os = "windows", target_os = "android"))]
        let origin = "http://note-preview.localhost";
        #[cfg(not(any(target_os = "windows", target_os = "android")))]
        let origin = "note-preview://localhost";
        let base_url = format!(
            "{origin}/{id}/{}",
            if encoded.is_empty() {
                String::new()
            } else {
                format!("{encoded}/")
            }
        );
        self.0.lock().map_err(|e| e.to_string())?.insert(
            id.clone(),
            Session {
                owner: owner.into(),
                root,
            },
        );
        Ok(PreviewSession {
            session_id: id,
            base_url,
        })
    }

    fn resolve(&self, owner: &str, uri_path: &str) -> Result<PathBuf, String> {
        let (id, encoded) = uri_path
            .trim_start_matches('/')
            .split_once('/')
            .ok_or("无效的资源路径")?;
        let session = self
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned()
            .ok_or("预览会话已过期")?;
        if session.owner != owner {
            return Err("预览会话不属于此窗口".into());
        }
        let decoded = percent_decode_str(encoded)
            .decode_utf8()
            .map_err(|_| "资源路径编码无效")?;
        // Reject Windows drive/ADS paths and encoded separators before canonicalization.
        if decoded.contains(['\\', ':', '\0']) {
            return Err("无效的资源路径".into());
        }
        let relative = Path::new(decoded.as_ref());
        if relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        {
            return Err("资源路径超出预览范围".into());
        }
        let resolved = session
            .root
            .join(relative)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !resolved.starts_with(&session.root) || !resolved.is_file() {
            return Err("资源不在预览范围内".into());
        }
        Ok(resolved)
    }

    pub fn remove_owner(&self, owner: &str) {
        if let Ok(mut sessions) = self.0.lock() {
            sessions.retain(|_, session| session.owner != owner);
        }
    }

    pub fn respond(&self, owner: &str, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let build = |status, mime: &str, data| {
            Response::builder()
                .status(status)
                .header("Content-Type", mime)
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                .header("Cache-Control", "no-store")
                .header("X-Content-Type-Options", "nosniff")
                // A resource navigated to as a document gets no application privileges.
                .header("Content-Security-Policy", "default-src 'none'; sandbox")
                .body(data)
                .expect("static response headers")
        };
        let method = request.method().as_str();
        if !matches!(method, "GET" | "HEAD" | "OPTIONS") {
            return build(405, "text/plain", b"Read only".to_vec());
        }
        let path = match self.resolve(owner, request.uri().path()) {
            Ok(path) => path,
            Err(_) => return build(404, "text/plain", b"Preview resource unavailable".to_vec()),
        };
        if method == "OPTIONS" {
            return build(204, "text/plain", vec![]);
        }
        if std::fs::metadata(&path).map_or(true, |m| m.len() > 32 * 1024 * 1024) {
            return build(413, "text/plain", b"Preview resource too large".to_vec());
        }
        match std::fs::read(&path) {
            Ok(bytes) => {
                let ext = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let mime = match ext.as_str() {
                    "js" | "mjs" => "text/javascript".into(),
                    "css" => "text/css".into(),
                    "json" => "application/json".into(),
                    "woff" => "font/woff".into(),
                    "woff2" => "font/woff2".into(),
                    _ => tauri::utils::mime_type::MimeType::parse(&bytes, &path.to_string_lossy()),
                };
                build(200, &mime, if method == "HEAD" { vec![] } else { bytes })
            }
            Err(_) => build(404, "text/plain", b"Preview resource unavailable".to_vec()),
        }
    }
}

#[tauri::command]
pub fn create_preview_session(
    window: WebviewWindow,
    state: State<PreviewState>,
    path: String,
    workspace_root: Option<String>,
) -> Result<PreviewSession, String> {
    state.create(
        window.label(),
        Path::new(&path),
        workspace_root.as_deref().map(Path::new),
    )
}
#[tauri::command]
pub fn close_preview_session(
    window: WebviewWindow,
    state: State<PreviewState>,
    session_id: String,
) {
    if let Ok(mut sessions) = state.0.lock() {
        if sessions
            .get(&session_id)
            .is_some_and(|s| s.owner == window.label())
        {
            sessions.remove(&session_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_resources_and_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("pages")).unwrap();
        let html = dir.path().join("pages/index.html");
        std::fs::write(&html, "<h1>hi</h1>").unwrap();
        std::fs::write(dir.path().join("中文 file.js"), "export default 1").unwrap();
        let state = PreviewState::default();
        let session = state.create("main", &html, Some(dir.path())).unwrap();
        assert!(session.base_url.ends_with("/pages/"));
        let resource = format!(
            "/{}/{}",
            session.session_id,
            utf8_percent_encode("中文 file.js", NON_ALPHANUMERIC)
        );
        assert!(state.resolve("main", &resource).is_ok());
        assert!(state.resolve("other", &resource).is_err());
        for suffix in [
            "../secret",
            "%2e%2e/secret",
            "%2Fetc/passwd",
            "C%3A/file",
            "a%5Cb",
            "file%00.js",
        ] {
            assert!(state
                .resolve("main", &format!("/{}/{suffix}", session.session_id))
                .is_err());
        }
        let response = state.respond(
            "main",
            Request::builder()
                .uri(format!("http://note-preview.localhost{resource}?v=2"))
                .body(vec![])
                .unwrap(),
        );
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["Content-Type"], "text/javascript");
        assert_eq!(response.headers()["Cache-Control"], "no-store");
        assert_eq!(
            state
                .respond(
                    "main",
                    Request::builder()
                        .method("POST")
                        .uri(&resource)
                        .body(vec![])
                        .unwrap()
                )
                .status(),
            405
        );
        state.remove_owner("main");
        assert!(state.resolve("main", &resource).is_err());
    }
    #[test]
    fn standalone_file_is_scoped_to_parent() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("index.htm");
        std::fs::write(&file, "").unwrap();
        let state = PreviewState::default();
        let s = state.create("main", &file, None).unwrap();
        assert!(state
            .resolve("main", &format!("/{}/index.htm", s.session_id))
            .is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn junction_outside_scope_is_denied() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let html = root.path().join("index.html");
        std::fs::write(&html, "").unwrap();
        std::fs::write(outside.path().join("secret"), "private").unwrap();
        let link = root.path().join("escape");
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let state = PreviewState::default();
        let s = state.create("main", &html, None).unwrap();
        assert!(state
            .resolve("main", &format!("/{}/escape/secret", s.session_id))
            .is_err());
        // Remove only the junction itself; the external fixture remains intact.
        std::fs::remove_dir(&link).unwrap();
        assert!(outside.path().join("secret").is_file());
    }
    #[cfg(unix)]
    #[test]
    fn symlink_outside_scope_is_denied() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let html = root.path().join("index.html");
        std::fs::write(&html, "").unwrap();
        std::fs::write(outside.path().join("secret"), "private").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), root.path().join("escape"))
            .unwrap();
        let state = PreviewState::default();
        let s = state.create("main", &html, None).unwrap();
        assert!(state
            .resolve("main", &format!("/{}/escape", s.session_id))
            .is_err());
    }
}
