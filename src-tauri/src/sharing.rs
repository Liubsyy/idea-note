//! Credentials stay on this device; Git share associations live in the repo.
//! All windows use this serialized persistence boundary.
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::collections::HashSet;
use std::sync::Mutex;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
static CONFIG_LOCK: Mutex<()> = Mutex::new(());
fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("sharing.json"))
}
fn load(app: &AppHandle) -> Result<Value, String> {
    let path = config_path(app)?;
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({"url":"","key":"","associations":{}})),
        Err(error) => Err(error.to_string()),
    }
}
fn save(app: &AppHandle, value: &Value) -> Result<(), String> {
    let path = config_path(app)?;
    let parent = path.parent().ok_or("Missing config parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = path.with_extension("tmp");
    fs::write(&temp, value.to_string()).map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    fs::rename(&temp, &path).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn share_config_load(app: AppHandle, path: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
        let mut local = load(&app)?;
        let before = local.clone();
        let associations = match path {
            Some(path) => crate::share_associations::load(&mut local, &path)?,
            None => local["associations"].clone(),
        };
        if local != before { save(&app, &local)?; }
        local["associations"] = associations;
        Ok(local.to_string())
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn share_config_save(app: AppHandle, json: String) -> Result<(), String> {
    let _guard = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let incoming: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let mut value = load(&app)?;
    for field in ["url", "key"] {
        value[field] = incoming.get(field).filter(|v| v.is_string()).cloned().ok_or("Invalid share configuration")?;
    }
    save(&app, &value)
}
#[tauri::command]
pub async fn share_association_set(app: AppHandle, path: String, id: String, service: String, kind: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
        let mut value = load(&app)?;
        let kind = kind.unwrap_or_else(|| "note".into());
        if kind != "note" && kind != "folder" { return Err("Invalid share target".into()); }
        crate::share_associations::set(&mut value, &path, json!({"id":id,"service":service,"kind":kind}))?;
        save(&app, &value)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn share_associations_remap(app: AppHandle, from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
        let mut value = load(&app)?;
        crate::share_associations::remap(&mut value, &from, &to)?;
        save(&app, &value)
    }).await.map_err(|e| e.to_string())?
}
const MAX_RESOURCE_BYTES: u64 = 100 * 1024 * 1024;
/// Resolve symlinks so attachment checks see the file that would really be
/// uploaded: a workspace `img.png` may link to `~/.ssh/id_rsa`. Windows
/// verbatim prefixes are dropped so the result compares with ordinary paths.
fn real_path(path: &str) -> std::io::Result<String> {
    let real = fs::canonicalize(path)?.to_string_lossy().into_owned();
    Ok(if let Some(unc) = real.strip_prefix(r"\\?\UNC\") { format!(r"\\{unc}") }
       else { real.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(real) })
}
#[tauri::command]
pub fn share_resource_stat(path: String, root: String) -> Result<Value, String> {
    let real = real_path(&path).map_err(|e| e.to_string())?;
    let meta = fs::metadata(&real).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_RESOURCE_BYTES { return Err("Attachment is not a file or exceeds 100 MB".into()); }
    let root = real_path(&root).unwrap_or(root);
    Ok(json!({"size":meta.len(),"path":real,"root":root}))
}
/// `path` is the real path the user reviewed; reading anything else (a link
/// swapped in since the review) is refused rather than silently followed.
#[tauri::command]
pub fn share_resource_read(path: String) -> Result<Vec<u8>, String> {
    if real_path(&path).map_err(|e| e.to_string())? != path { return Err("Attachment changed after review; prepare the share again".into()); }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() { return Err("Not a file".into()); }
    let mut bytes = Vec::new();
    file.take(MAX_RESOURCE_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_RESOURCE_BYTES { return Err("Attachment exceeds 100 MB".into()); }
    Ok(bytes)
}
// A separate, bounded walk: lazy sidebar state is never a publication manifest.
fn scan_folder(path: &str, include_hidden: bool, include_symlinks: bool) -> Result<Value, String> {
    let root = fs::canonicalize(path).map_err(|e| format!("{path}: {e}"))?;
    if !root.is_dir() { return Err("Not a directory".into()); }
    if root.components().any(|c| matches!(c.as_os_str().to_str(),Some(".git" | ".svn" | ".hg" | ".ideanote" | ".idea-note"))) { return Err("Cannot share version-control or application metadata".into()); }
    let mut entries = Vec::new();
    let mut excluded = Vec::new();
    let mut ancestors = HashSet::from([root.clone()]);
    let mut total = 0;
    walk_folder(Path::new(path), "", &root, include_hidden, include_symlinks,
        &mut ancestors, &mut entries, &mut excluded, &mut total)?;
    Ok(json!({"entries": entries, "excluded": excluded}))
}
#[allow(clippy::too_many_arguments)]
fn walk_folder(dir: &Path, prefix: &str, root: &Path, hidden: bool, symlinks: bool,
    ancestors: &mut HashSet<PathBuf>, entries: &mut Vec<Value>, excluded: &mut Vec<Value>, total: &mut u64) -> Result<(), String> {
    let mut children = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?
        .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    children.sort_by_key(|e| (e.file_name().to_string_lossy().to_lowercase(), e.file_name()));
    let mut nodes = Vec::new();
    for entry in children {
        let name = entry.file_name().into_string().map_err(|_| "Filename is not valid Unicode")?;
        let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        let reason = if matches!(name.as_str(), ".git" | ".svn" | ".hg" | ".ideanote" | ".idea-note" | ".DS_Store") { Some("system") }
            else if !hidden && name.starts_with('.') { Some("hidden") }
            else if !symlinks && entry.file_type().map_err(|e| e.to_string())?.is_symlink() { Some("symlink") }
            else { None };
        if let Some(reason) = reason { excluded.push(json!({"path":relative,"reason":reason})); continue; }
        let meta = fs::metadata(entry.path()).map_err(|e| format!("{}: {e}", entry.path().display()))?;
        nodes.push((!meta.is_dir(), name.to_lowercase(), name, entry.path(), relative, meta));
    }
    nodes.sort_by(|a,b| (&a.0,&a.1,&a.2).cmp(&(&b.0,&b.1,&b.2)));
    for (_, _, _, path, relative, meta) in nodes {
        let real = fs::canonicalize(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        if !meta.is_file() && !meta.is_dir() { excluded.push(json!({"path":relative,"reason":"special"})); continue; }
        let outside = !real.starts_with(root);
        let hidden_target = real.strip_prefix(root).unwrap_or(&real).components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.'));
        let system_target = real.strip_prefix(root).unwrap_or(&real).components()
            .any(|c| matches!(c.as_os_str().to_str(),Some(".git" | ".svn" | ".hg" | ".ideanote" | ".idea-note" | ".DS_Store")));
        if system_target || (!hidden && hidden_target) {
            excluded.push(json!({"path":relative,"reason":if system_target {"system"} else {"hidden"}})); continue;
        }
        let hidden_named = relative.split('/').any(|c| c.starts_with('.'));
        let warnings: Vec<&str> = [(outside,"outside"), (hidden_target || hidden_named,"hidden")]
            .into_iter().filter_map(|(yes, label)| yes.then_some(label)).collect();
        let named = path.to_string_lossy().into_owned();
        let canonical = real_path(real.to_str().ok_or("Invalid path")?).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            if ancestors.contains(&real) { excluded.push(json!({"path":relative,"reason":"cycle"})); continue; }
            entries.push(json!({"kind":"directory","relative":relative,"path":named,"real":canonical,"warnings":warnings}));
            ancestors.insert(real.clone());
            walk_folder(&path, &relative, root, hidden, symlinks, ancestors, entries, excluded, total)?;
            ancestors.remove(&real);
        } else {
            // Refuse links swapped during review; publication keeps these exact bytes.
            let bytes = share_resource_read(canonical.clone())?;
            if fs::canonicalize(&path).map_err(|e| e.to_string())? != real { return Err("File changed during scan".into()); }
            *total += bytes.len() as u64;
            if *total > MAX_RESOURCE_BYTES { return Err("Folder exceeds 100 MB".into()); }
            let markdown = relative.to_lowercase().ends_with(".md") || relative.to_lowercase().ends_with(".markdown");
            let text = if markdown { Some(crate::encoding::decode(bytes.clone())
                .map_err(|e| format!("{relative}: {e}"))?.0) } else { None };
            entries.push(json!({"kind":"file","relative":relative,"path":named,"real":canonical,"warnings":warnings,"bytes":bytes,"text":text}));
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn share_folder_scan(path: String, include_hidden: bool, include_symlinks: bool) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || scan_folder(&path, include_hidden, include_symlinks))
        .await.map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn folder_scan_is_recursive_sorted_and_preserves_empty_directories() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("empty")).unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/笔记.md"), "# 笔记").unwrap();
        fs::write(dir.path().join("a.txt"), "hello").unwrap();
        fs::write(dir.path().join(".env"), "secret").unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git/config"), "private").unwrap();
        fs::create_dir(dir.path().join(".idea-note")).unwrap();
        fs::write(dir.path().join(".idea-note/shares.json"), "private metadata").unwrap();
        fs::create_dir(dir.path().join(".ideanote")).unwrap();
        fs::write(dir.path().join(".ideanote/shares.json"), "share metadata").unwrap();
        fs::write(dir.path().join(".ideanote/vault.json"), "encrypted vault").unwrap();
        let path = dir.path().to_str().unwrap();
        let scan = scan_folder(path, false, false).unwrap();
        let names: Vec<_> = scan["entries"].as_array().unwrap().iter().map(|e| e["relative"].as_str().unwrap()).collect();
        assert_eq!(names, ["empty", "sub", "sub/笔记.md", "a.txt"]);
        assert_eq!(scan["entries"][2]["text"], "# 笔记");
        assert_eq!(scan["excluded"].as_array().unwrap().len(), 4);
        let hidden = scan_folder(path, true, false).unwrap();
        assert!(hidden["entries"].as_array().unwrap().iter().any(|e| e["relative"] == ".env" && e["warnings"] == json!(["hidden"])));
        assert!(!hidden["entries"].as_array().unwrap().iter().any(|e| matches!(e["relative"].as_str(), Some(".git" | ".ideanote" | ".idea-note"))));
        for metadata in [".ideanote", ".idea-note"] {
            assert!(scan_folder(dir.path().join(metadata).to_str().unwrap(), true, true).is_err());
            fs::create_dir(dir.path().join(metadata).join("nested")).unwrap();
            assert!(scan_folder(dir.path().join(metadata).join("nested").to_str().unwrap(), true, true).is_err());
        }
        fs::write(dir.path().join("a.txt"), "changed").unwrap();
        assert_ne!(scan, scan_folder(path, false, false).unwrap());
        fs::remove_file(dir.path().join("a.txt")).unwrap();
        assert_ne!(scan["entries"], scan_folder(path, false, false).unwrap()["entries"]);
    }
    #[cfg(unix)]
    #[test]
    fn folder_scan_reviews_external_links_detects_cycles_and_reports_broken_links() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("notes"); fs::create_dir(&root).unwrap();
        fs::create_dir(dir.path().join("outside")).unwrap();
        fs::write(dir.path().join("outside/a.md"), "outside").unwrap();
        symlink(&root, root.join("cycle")).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "private").unwrap();
        symlink(root.join(".git"), root.join("git-alias")).unwrap();
        fs::create_dir(root.join(".ideanote")).unwrap();
        fs::write(root.join(".ideanote/vault.json"), "encrypted vault").unwrap();
        symlink(root.join(".ideanote"), root.join("metadata-alias")).unwrap();
        symlink(root.join(".ideanote/vault.json"), root.join("vault-alias.json")).unwrap();
        symlink(dir.path().join("outside"), root.join("linked")).unwrap();
        let path = root.to_str().unwrap();
        assert!(scan_folder(path, false, false).unwrap()["entries"].as_array().unwrap().is_empty());
        let scan = scan_folder(path, true, true).unwrap();
        assert!(scan["excluded"].as_array().unwrap().iter().any(|e| e["reason"] == "cycle"));
        assert!(scan["excluded"].as_array().unwrap().iter().any(|e| e["path"] == "git-alias" && e["reason"] == "system"));
        for alias in ["metadata-alias", "vault-alias.json"] {
            assert!(scan["excluded"].as_array().unwrap().iter().any(|e| e["path"] == alias && e["reason"] == "system"));
        }
        assert!(scan["entries"].as_array().unwrap().iter().any(|e| e["relative"] == "linked/a.md" && e["warnings"].as_array().unwrap().contains(&json!("outside"))));
        symlink(dir.path().join("missing"), root.join("broken")).unwrap();
        assert!(scan_folder(path, false, true).is_err());
        assert!(scan_folder(path, false, false).is_ok());
        assert!(scan_folder(dir.path().join("absent").to_str().unwrap(),false,false).is_err());
    }
    #[test]
    fn remaps_windows_folder_paths_without_matching_siblings() {
        let mut value = json!({"associations":{r"C:\notes\a\n.md":{"id":"1"},r"C:\notes\ab\x.md":{"id":"2"}}});
        crate::share_associations::remap(&mut value, r"C:\notes\a", r"D:\archive\a").unwrap();
        assert_eq!(value["associations"][r"D:\archive\a\n.md"]["id"], "1");
        assert_eq!(value["associations"][r"C:\notes\ab\x.md"]["id"], "2");
    }
    #[test]
    fn remaps_only_the_moved_subtree() {
        let mut value = json!({"associations":{"/a/n.md":{"id":"1"},"/ab/x.md":{"id":"2"},"/a":{"id":"3"}}});
        crate::share_associations::remap(&mut value,"/a","/b").unwrap();
        assert_eq!(value["associations"]["/b/n.md"]["id"],"1");
        assert_eq!(value["associations"]["/b"]["id"],"3");
        assert_eq!(value["associations"]["/ab/x.md"]["id"],"2");
        assert!(value["associations"].get("/a/n.md").is_none());
    }
    #[cfg(unix)]
    #[test]
    fn resources_resolve_symlinks_and_reject_unreviewed_paths() {
        let base = std::env::temp_dir().join(format!("idea-note-share-{}", std::process::id()));
        let (notes, secret) = (base.join("notes"), base.join("outside/id_rsa"));
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(secret.parent().unwrap()).unwrap();
        fs::write(&secret, b"key").unwrap();
        std::os::unix::fs::symlink(&secret, notes.join("img.png")).unwrap();
        let link = notes.join("img.png").to_string_lossy().into_owned();
        let stat = share_resource_stat(link.clone(), notes.to_string_lossy().into_owned()).unwrap();
        let real = real_path(secret.to_str().unwrap()).unwrap();
        assert_eq!(stat["path"], real.as_str());
        assert_eq!(stat["root"], real_path(notes.to_str().unwrap()).unwrap().as_str());
        assert_eq!(share_resource_read(real).unwrap(), b"key");
        assert!(share_resource_read(link).is_err());
        fs::remove_dir_all(&base).unwrap();
    }
}
