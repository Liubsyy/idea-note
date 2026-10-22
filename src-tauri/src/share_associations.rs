//! Portable share bindings. Credentials never enter this Git-tracked manifest.
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const MANIFEST: &str = ".ideanote/shares.json";
const LEGACY_MANIFEST: &str = ".idea-note/shares.json";

#[derive(Clone)]
struct Repository {
    root: PathBuf,
    remote: String,
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = crate::proc::command(crate::git::git_binary()?)
        .current_dir(dir)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// HTTPS and SSH URLs for the same host/path identify the same repository.
/// Preserve repository path case and nonstandard ports, discard credentials.
fn normalize_remote(remote: &str) -> Option<String> {
    let remote = remote.trim();
    let url = if remote.contains("://") {
        tauri::Url::parse(remote).ok()?
    } else {
        let (host, path) = remote.split_once(':')?;
        if host.contains(['/', '\\'])
            || path.starts_with('\\')
            || (host.len() == 1 && path.starts_with('/'))
        {
            return None;
        }
        tauri::Url::parse(&format!("ssh://{host}/{path}")).ok()?
    };
    if !matches!(url.scheme(), "https" | "http" | "ssh" | "git") {
        return None;
    }
    let host = url.host_str()?.to_lowercase();
    let port = url
        .port()
        .filter(|p| !matches!((url.scheme(), *p), ("ssh", 22) | ("git", 9418)));
    let path = url.path().trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    if path.is_empty() {
        return None;
    }
    Some(format!(
        "{host}{}/{path}",
        port.map(|p| format!(":{p}")).unwrap_or_default()
    ))
}

/// Also works for the old path just after a rename: resolve its nearest existing
/// ancestor and append the missing suffix, without requiring the file to exist.
fn absolute_path(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let mut ancestor = path;
    let mut suffix = Vec::new();
    while !ancestor.exists() {
        suffix.push(ancestor.file_name()?.to_owned());
        ancestor = ancestor.parent()?;
    }
    let mut result = fs::canonicalize(ancestor).ok()?;
    for name in suffix.into_iter().rev() {
        result.push(name);
    }
    Some(result)
}

fn repository(path: &str) -> Option<Repository> {
    let path = absolute_path(Path::new(path))?;
    let mut dir = path.as_path();
    while !dir.is_dir() {
        dir = dir.parent()?;
    }
    let root = fs::canonicalize(git(dir, &["rev-parse", "--show-toplevel"]).ok()?).ok()?;
    let remote = normalize_remote(&git(&root, &["remote", "get-url", "origin"]).ok()?)?;
    Some(Repository { root, remote })
}

fn relative(repo: &Repository, path: &str) -> Option<String> {
    let absolute = absolute_path(Path::new(path))?;
    let path = absolute.strip_prefix(&repo.root).ok()?;
    if path.as_os_str().is_empty() {
        return Some(".".into());
    }
    let key = path
        .iter()
        .map(|s| s.to_str())
        .collect::<Option<Vec<_>>>()?
        .join("/");
    valid_relative(&key).then_some(key)
}

fn valid_relative(path: &str) -> bool {
    path == "."
        || (!path.is_empty()
            && !path.contains(['\\', ':'])
            && path.split('/').all(|s| !matches!(s, "" | "." | "..")))
}

fn check_manifest_path(repo: &Repository, name: &str) -> Result<PathBuf, String> {
    let path = repo.root.join(name);
    for entry in [path.parent().unwrap(), path.as_path()] {
        match fs::symlink_metadata(entry) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("Share manifest must not be a symbolic link".into())
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    Ok(path)
}

fn read_manifest_at(path: &Path) -> Result<Option<Value>, String> {
    let value: Value = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if value["version"] != 1 || !value["repositories"].is_object() {
        return Err(format!("Invalid share manifest: {}", path.display()));
    }
    for bindings in value["repositories"].as_object().unwrap().values() {
        let bindings = bindings.as_object().ok_or("Invalid share associations")?;
        for (path, binding) in bindings {
            if !valid_relative(path) || binding_value(binding).is_none() {
                return Err("Invalid share association".into());
            }
        }
    }
    Ok(Some(value))
}

fn read_manifest(repo: &Repository) -> Result<Value, String> {
    let path = check_manifest_path(repo, MANIFEST)?;
    let mut manifest =
        read_manifest_at(&path)?.unwrap_or_else(|| json!({"version":1,"repositories":{}}));
    let legacy_path = check_manifest_path(repo, LEGACY_MANIFEST)?;
    if let Some(legacy) = read_manifest_at(&legacy_path)? {
        // A newer, pulled manifest takes precedence; preserve non-conflicting
        // bindings for every remote, including forks, from the old location.
        let repositories = manifest["repositories"].as_object_mut().unwrap();
        for (remote, old) in legacy["repositories"].as_object().unwrap() {
            let current = repositories
                .entry(remote.clone())
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .unwrap();
            for (path, binding) in old.as_object().unwrap() {
                current
                    .entry(path.clone())
                    .or_insert_with(|| binding.clone());
            }
        }
        // Only retire the old file after the new one is safely written and
        // included in Git tracking. Never touch the adjacent vault.json.
        write_manifest(repo, &manifest)?;
        fs::remove_file(&legacy_path).map_err(|e| e.to_string())?;
        // Remove an empty old directory, leaving unrelated files untouched.
        let _ = fs::remove_dir(legacy_path.parent().unwrap());
    }
    Ok(manifest)
}

fn binding_value(value: &Value) -> Option<Value> {
    let id = value["id"].as_str()?;
    let service = value["service"].as_str()?;
    let kind = value.get("kind").and_then(Value::as_str).unwrap_or("note");
    if !matches!(kind, "note" | "folder") {
        return None;
    }
    Some(json!({"id":id,"service":service,"kind":kind}))
}

fn bindings<'a>(manifest: &'a mut Value, repo: &Repository) -> &'a mut Map<String, Value> {
    manifest["repositories"]
        .as_object_mut()
        .unwrap()
        .entry(repo.remote.clone())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .unwrap()
}

fn write_manifest(repo: &Repository, manifest: &Value) -> Result<(), String> {
    use std::io::Write;
    let path = check_manifest_path(repo, MANIFEST)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut temp =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    writeln!(
        temp,
        "{}",
        serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?
    )
    .map_err(|e| e.to_string())?;
    temp.persist(&path).map_err(|e| e.to_string())?;
    // Sync commits tracked changes only. Intent-to-add includes this new file
    // in that flow without staging unrelated files or creating a commit.
    git(&repo.root, &["add", "-N", "--", MANIFEST])
        .map_err(|e| format!("Could not add {MANIFEST} to Git: {e}"))?;
    Ok(())
}

/// Move old device-only bindings into the current repository. A pulled mapping
/// takes precedence over stale local state. Remove local entries only on success.
fn migrate(local: &mut Value, repo: &Repository, manifest: &mut Value) -> Result<(), String> {
    let mut migrated = Vec::new();
    if let Some(old) = local["associations"].as_object() {
        for (path, value) in old {
            if let (Some(key), Some(value)) = (relative(repo, path), binding_value(value)) {
                // A nested repository owns its own manifest.
                if repository(path).is_some_and(|owner| owner.root == repo.root) {
                    bindings(manifest, repo).entry(key).or_insert(value);
                    migrated.push(path.clone());
                }
            }
        }
    }
    if !migrated.is_empty() {
        write_manifest(repo, manifest)?;
        for path in migrated {
            local["associations"].as_object_mut().unwrap().remove(&path);
        }
    }
    Ok(())
}

pub fn load(local: &mut Value, path: &str) -> Result<Value, String> {
    let Some(repo) = repository(path) else {
        return Ok(local["associations"].clone());
    };
    let mut manifest = read_manifest(&repo)?;
    migrate(local, &repo, &mut manifest)?;
    let mut result = local["associations"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let current = relative(&repo, path);
    for (key, binding) in bindings(&mut manifest, &repo).iter() {
        let absolute = if key == "." {
            repo.root.clone()
        } else {
            repo.root.join(key)
        };
        result.insert(absolute.to_string_lossy().into_owned(), binding.clone());
        // Keep paths reached through a symlink usable by the current dialog.
        if current.as_ref() == Some(key) {
            result.insert(path.to_string(), binding.clone());
        }
    }
    Ok(Value::Object(result))
}

pub fn set(local: &mut Value, path: &str, value: Value) -> Result<(), String> {
    if let Some(repo) = repository(path) {
        let key = relative(&repo, path).ok_or("Share target is outside the repository")?;
        let mut manifest = read_manifest(&repo)?;
        migrate(local, &repo, &mut manifest)?;
        bindings(&mut manifest, &repo).insert(
            key,
            binding_value(&value).ok_or("Invalid share association")?,
        );
        write_manifest(&repo, &manifest)?;
        if let Some(old) = local["associations"].as_object_mut() {
            old.remove(path);
        }
    } else {
        local["associations"][path] = value;
    }
    Ok(())
}

fn moved_key(path: &str, from: &str, to: &str) -> Option<String> {
    let suffix = if path == from {
        ""
    } else if from == "." {
        path
    } else {
        path.strip_prefix(from)?.strip_prefix('/')?
    };
    Some(if suffix.is_empty() {
        to.to_string()
    } else if to == "." {
        suffix.to_string()
    } else {
        format!("{to}/{suffix}")
    })
}

pub fn remap(local: &mut Value, from: &str, to: &str) -> Result<(), String> {
    let destination = repository(to);
    // Renaming the repository root carries the manifest along with it.
    if destination
        .as_ref()
        .is_some_and(|repo| relative(repo, to).as_deref() == Some("."))
        && repository(from).is_none()
    {
        if let Some(old) = local["associations"].as_object_mut() {
            let changes: Vec<_> = old
                .iter()
                .filter_map(|(path, value)| {
                    moved_absolute(path, from, to).map(|new| (path.clone(), new, value.clone()))
                })
                .collect();
            for (path, new, value) in changes {
                old.remove(&path);
                old.insert(new, value);
            }
        }
        let repo = destination.unwrap();
        let mut manifest = read_manifest(&repo)?;
        return migrate(local, &repo, &mut manifest);
    }
    let source = repository(from);
    if let Some(source) = source {
        let mut manifest = read_manifest(&source)?;
        migrate(local, &source, &mut manifest)?;
        if let Some(old) = relative(&source, from) {
            let changes: Vec<_> = bindings(&mut manifest, &source)
                .iter()
                .filter_map(|(key, value)| {
                    moved_key(key, &old, ".").map(|suffix| (key.clone(), suffix, value.clone()))
                })
                .collect();
            if !changes.is_empty() {
                if let Some(dest) = &destination {
                    let new = relative(dest, to).ok_or("Invalid destination path")?;
                    if source.root == dest.root {
                        for (key, _, _) in &changes {
                            bindings(&mut manifest, &source).remove(key);
                        }
                        for (_, suffix, value) in changes {
                            let key = moved_key(&suffix, ".", &new).unwrap();
                            bindings(&mut manifest, dest).insert(key, value);
                        }
                        write_manifest(dest, &manifest)?;
                    } else {
                        let mut target = read_manifest(dest)?;
                        migrate(local, dest, &mut target)?;
                        for (_, suffix, value) in &changes {
                            bindings(&mut target, dest)
                                .insert(moved_key(suffix, ".", &new).unwrap(), value.clone());
                        }
                        write_manifest(dest, &target)?;
                        for (key, _, _) in changes {
                            bindings(&mut manifest, &source).remove(&key);
                        }
                        write_manifest(&source, &manifest)?;
                    }
                } else {
                    for (key, suffix, value) in changes {
                        let path = if suffix == "." {
                            PathBuf::from(to)
                        } else {
                            Path::new(to).join(suffix)
                        };
                        local["associations"][path.to_string_lossy().as_ref()] = value;
                        bindings(&mut manifest, &source).remove(&key);
                    }
                    write_manifest(&source, &manifest)?;
                }
            }
        }
    }
    if let Some(old) = local["associations"].as_object_mut() {
        let changes: Vec<_> = old
            .iter()
            .filter_map(|(path, value)| {
                moved_absolute(path, from, to).map(|new| (path.clone(), new, value.clone()))
            })
            .collect();
        for (path, new, value) in changes {
            old.remove(&path);
            old.insert(new, value);
        }
    }
    if let Some(dest) = destination {
        let mut manifest = read_manifest(&dest)?;
        migrate(local, &dest, &mut manifest)?;
    }
    Ok(())
}

fn moved_absolute(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from
        || path
            .strip_prefix(from)
            .is_some_and(|s| s.starts_with('/') || s.starts_with('\\'))
    {
        Some(format!("{to}{}", &path[from.len()..]))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init(root: &Path, remote: &str) {
        fs::create_dir_all(root).unwrap();
        git(root, &["init", "-q"]).unwrap();
        git(root, &["remote", "add", "origin", remote]).unwrap();
    }
    fn local() -> Value {
        json!({"url":"https://share.test","key":"device-only-secret","associations":{}})
    }
    fn binding(id: &str) -> Value {
        json!({"service":"https://share.test","id":id,"kind":"note"})
    }
    fn name(path: &Path) -> String {
        absolute_path(path).unwrap().to_string_lossy().into_owned()
    }

    #[test]
    fn remote_identity_ignores_protocol_credentials_and_git_suffix() {
        for url in [
            "git@GitHub.com:Owner/notes.git",
            "ssh://git@github.com:22/Owner/notes.git",
            "https://user:token@github.com/Owner/notes.git/",
            "https://github.com/Owner/notes",
        ] {
            assert_eq!(
                normalize_remote(url).as_deref(),
                Some("github.com/Owner/notes")
            );
        }
        assert_ne!(
            normalize_remote("https://github.com/Owner/notes"),
            normalize_remote("https://github.com/other/notes")
        );
        assert_ne!(
            normalize_remote("ssh://git@host:2222/notes.git"),
            normalize_remote("ssh://git@host/notes.git")
        );
        assert_eq!(normalize_remote("/local/repo"), None);
        assert_eq!(normalize_remote(r"C:\notes"), None);
        assert_eq!(normalize_remote("C:/notes"), None);
        assert_eq!(normalize_remote("file:///notes"), None);
    }

    #[test]
    fn git_sync_preserves_bindings_at_different_absolute_paths_and_isolates_forks() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        init(&first, "git@github.com:Owner/notes.git");
        fs::create_dir(first.join("工作")).unwrap();
        fs::write(first.join("工作/A.md"), "# A").unwrap();
        let mut device = local();
        set(
            &mut device,
            &name(&first.join("工作/A.md")),
            binding("original-id"),
        )
        .unwrap();
        set(
            &mut device,
            &name(&first),
            json!({"id":"folder-id","service":"https://share.test","kind":"folder"}),
        )
        .unwrap();
        let text = fs::read_to_string(first.join(MANIFEST)).unwrap();
        assert!(!text.contains("device-only-secret"));
        assert!(!text.contains(&name(&first)));
        assert!(text.contains("工作/A.md"));
        assert!(git(&first, &["ls-files", "--", MANIFEST])
            .unwrap()
            .contains(MANIFEST));
        git(&first, &["add", "--", "工作/A.md"]).unwrap();
        git(
            &first,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-qam",
                "Share bindings",
            ],
        )
        .unwrap();
        let second = temp.path().join("different/location");
        git(
            temp.path(),
            &[
                "clone",
                "-q",
                first.to_str().unwrap(),
                second.to_str().unwrap(),
            ],
        )
        .unwrap();
        git(
            &second,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/Owner/notes.git",
            ],
        )
        .unwrap();
        let mut other = local();
        let found = load(&mut other, &name(&second.join("工作/A.md"))).unwrap();
        assert_eq!(found[name(&second.join("工作/A.md"))]["id"], "original-id");
        assert_eq!(found[name(&second)]["id"], "folder-id");
        assert!(other["associations"].as_object().unwrap().is_empty());
        git(
            &second,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/fork/notes.git",
            ],
        )
        .unwrap();
        assert!(load(&mut other, &name(&second))
            .unwrap()
            .as_object()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn migration_preserves_pulled_binding_and_never_writes_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        init(root, "https://github.com/owner/notes.git");
        let path = name(&root.join("A.md"));
        fs::write(&path, "a").unwrap();
        let mut device = local();
        set(&mut device, &path, binding("pulled")).unwrap();
        device["associations"][&path] = binding("stale");
        device["associations"][name(&root.join("B.md"))] = binding("legacy");
        let found = load(&mut device, &path).unwrap();
        assert_eq!(found[&path]["id"], "pulled");
        assert_eq!(found[name(&root.join("B.md"))]["id"], "legacy");
        assert!(device["associations"].as_object().unwrap().is_empty());
        assert_eq!(device["key"], "device-only-secret");
        assert!(!fs::read_to_string(root.join(MANIFEST))
            .unwrap()
            .contains("device-only-secret"));
    }

    #[test]
    fn folder_rename_remaps_descendants_after_the_files_have_moved() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        init(root, "https://github.com/owner/notes.git");
        fs::create_dir(root.join("a")).unwrap();
        fs::write(root.join("a/n.md"), "a").unwrap();
        fs::create_dir(root.join("ab")).unwrap();
        fs::write(root.join("ab/n.md"), "b").unwrap();
        let mut device = local();
        set(
            &mut device,
            &name(&root.join("a")),
            json!({"id":"folder","service":"https://share.test","kind":"folder"}),
        )
        .unwrap();
        set(&mut device, &name(&root.join("a/n.md")), binding("child")).unwrap();
        set(
            &mut device,
            &name(&root.join("ab/n.md")),
            binding("sibling"),
        )
        .unwrap();
        fs::rename(root.join("a"), root.join("renamed")).unwrap();
        remap(
            &mut device,
            &name(&root.join("a")),
            &name(&root.join("renamed")),
        )
        .unwrap();
        let found = load(&mut device, &name(root)).unwrap();
        assert_eq!(found[name(&root.join("renamed"))]["id"], "folder");
        assert_eq!(found[name(&root.join("renamed/n.md"))]["id"], "child");
        assert_eq!(found[name(&root.join("ab/n.md"))]["id"], "sibling");
        assert!(found.get(name(&root.join("a/n.md"))).is_none());
    }

    #[test]
    fn moves_between_repositories_and_local_folders_keep_the_share_id() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        let loose = temp.path().join("loose");
        init(&first, "https://host/first.git");
        init(&second, "https://host/second.git");
        fs::create_dir(&loose).unwrap();
        let mut device = local();
        fs::write(first.join("a.md"), "a").unwrap();
        set(&mut device, &name(&first.join("a.md")), binding("same-id")).unwrap();
        fs::rename(first.join("a.md"), second.join("b.md")).unwrap();
        remap(
            &mut device,
            &name(&first.join("a.md")),
            &name(&second.join("b.md")),
        )
        .unwrap();
        assert_eq!(
            load(&mut device, &name(&second)).unwrap()[name(&second.join("b.md"))]["id"],
            "same-id"
        );
        assert!(load(&mut device, &name(&first))
            .unwrap()
            .as_object()
            .unwrap()
            .is_empty());
        fs::rename(second.join("b.md"), loose.join("c.md")).unwrap();
        remap(
            &mut device,
            &name(&second.join("b.md")),
            &name(&loose.join("c.md")),
        )
        .unwrap();
        assert_eq!(
            device["associations"][name(&loose.join("c.md"))]["id"],
            "same-id"
        );
        fs::rename(loose.join("c.md"), first.join("d.md")).unwrap();
        remap(
            &mut device,
            &name(&loose.join("c.md")),
            &name(&first.join("d.md")),
        )
        .unwrap();
        assert_eq!(
            load(&mut device, &name(&first)).unwrap()[name(&first.join("d.md"))]["id"],
            "same-id"
        );
        assert!(device["associations"].as_object().unwrap().is_empty());
    }

    #[test]
    fn renaming_repository_root_keeps_portable_and_legacy_bindings() {
        let temp = tempfile::tempdir().unwrap();
        let before = temp.path().join("before");
        let after = temp.path().join("after");
        init(&before, "git@host:owner/notes.git");
        fs::write(before.join("A.md"), "a").unwrap();
        let mut device = local();
        set(
            &mut device,
            &name(&before),
            json!({"id":"root","service":"https://share.test","kind":"folder"}),
        )
        .unwrap();
        device["associations"][name(&before.join("A.md"))] = binding("legacy-child");
        fs::rename(&before, &after).unwrap();
        remap(&mut device, &name(&before), &name(&after)).unwrap();
        let found = load(&mut device, &name(&after.join("A.md"))).unwrap();
        assert_eq!(found[name(&after)]["id"], "root");
        assert_eq!(found[name(&after.join("A.md"))]["id"], "legacy-child");
        assert!(device["associations"].as_object().unwrap().is_empty());
    }

    #[test]
    fn old_manifest_migrates_without_overwriting_new_bindings_or_the_vault() {
        for existing in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path();
            init(root, "https://host/notes.git");
            fs::create_dir(root.join(".idea-note")).unwrap();
            fs::create_dir(root.join(".ideanote")).unwrap();
            fs::write(
                root.join(".ideanote/vault.json"),
                "existing encrypted vault",
            )
            .unwrap();
            let legacy = json!({"version":1,"repositories":{
                "host/notes":{"A.md":binding("old-a"),"B.md":binding("old-b")},
                "host/fork":{"A.md":binding("fork-a")}
            }});
            fs::write(root.join(LEGACY_MANIFEST), legacy.to_string()).unwrap();
            git(root, &["add", "-N", "--", LEGACY_MANIFEST]).unwrap();
            if existing {
                fs::write(
                    root.join(MANIFEST),
                    json!({"version":1,"repositories":{
                        "host/notes":{"A.md":binding("new-a"),"C.md":binding("new-c")}
                    }})
                    .to_string(),
                )
                .unwrap();
            }
            let mut device = local();
            let found = load(&mut device, &name(root)).unwrap();
            assert_eq!(
                found[name(&root.join("A.md"))]["id"],
                if existing { "new-a" } else { "old-a" }
            );
            assert_eq!(found[name(&root.join("B.md"))]["id"], "old-b");
            if existing {
                assert_eq!(found[name(&root.join("C.md"))]["id"], "new-c");
            }
            let manifest: Value =
                serde_json::from_str(&fs::read_to_string(root.join(MANIFEST)).unwrap()).unwrap();
            assert_eq!(
                manifest["repositories"]["host/fork"]["A.md"]["id"],
                "fork-a"
            );
            assert!(!root.join(LEGACY_MANIFEST).exists());
            assert!(!root.join(".idea-note").exists());
            assert_eq!(git(root, &["ls-files", "--", MANIFEST]).unwrap(), MANIFEST);
            assert_eq!(
                fs::read_to_string(root.join(".ideanote/vault.json")).unwrap(),
                "existing encrypted vault"
            );
            assert!(!fs::read_to_string(root.join(MANIFEST))
                .unwrap()
                .contains("device-only-secret"));
            set(&mut device, &name(&root.join("B.md")), binding("updated-b")).unwrap();
            assert_eq!(
                load(&mut device, &name(root)).unwrap()[name(&root.join("B.md"))]["id"],
                "updated-b"
            );
        }
    }

    #[test]
    fn corrupt_old_manifest_is_preserved_and_does_not_replace_new_or_local_bindings() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        init(root, "https://host/notes.git");
        fs::create_dir(root.join(".idea-note")).unwrap();
        fs::create_dir(root.join(".ideanote")).unwrap();
        let current = json!({"version":1,"repositories":{"host/notes":{"A.md":binding("new-a")}}})
            .to_string();
        fs::write(root.join(MANIFEST), &current).unwrap();
        fs::write(root.join(LEGACY_MANIFEST), "<<<<<<< git conflict").unwrap();
        let mut device = local();
        device["associations"][name(&root.join("B.md"))] = binding("device-b");
        let before = device.clone();
        assert!(load(&mut device, &name(root)).is_err());
        assert_eq!(device, before);
        assert_eq!(fs::read_to_string(root.join(MANIFEST)).unwrap(), current);
        assert_eq!(
            fs::read_to_string(root.join(LEGACY_MANIFEST)).unwrap(),
            "<<<<<<< git conflict"
        );
    }

    #[cfg(unix)]
    #[test]
    fn migration_rejects_symbolic_links_at_either_manifest_location() {
        use std::os::unix::fs::symlink;
        for location in [MANIFEST, LEGACY_MANIFEST] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("repo");
            init(&root, "https://host/notes.git");
            let outside = temp.path().join("outside.json");
            let content =
                json!({"version":1,"repositories":{"host/notes":{"A.md":binding("outside")}}})
                    .to_string();
            fs::write(&outside, &content).unwrap();
            fs::create_dir_all(root.join(location).parent().unwrap()).unwrap();
            symlink(&outside, root.join(location)).unwrap();
            assert!(load(&mut local(), &name(&root)).is_err());
            assert_eq!(fs::read_to_string(&outside).unwrap(), content);
        }
    }

    #[test]
    fn corrupt_manifest_does_not_discard_legacy_associations() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        init(root, "https://host/notes.git");
        fs::create_dir(root.join(".ideanote")).unwrap();
        let file = root.join(MANIFEST);
        fs::write(&file, "<<<<<<< git conflict").unwrap();
        let mut device = local();
        device["associations"][name(&root.join("a.md"))] = binding("legacy");
        let before = device.clone();
        assert!(load(&mut device, &name(root)).is_err());
        assert_eq!(device, before);
        assert_eq!(fs::read_to_string(&file).unwrap(), "<<<<<<< git conflict");
        fs::write(&file, r#"{"version":1,"repositories":{"host/notes":{"../outside":{"id":"bad","service":"x"}}}}"#).unwrap();
        assert!(load(&mut device, &name(root)).is_err());
    }

    #[test]
    fn repositories_without_a_remote_keep_device_local_bindings() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        git(root, &["init", "-q"]).unwrap();
        let path = name(&root.join("A.md"));
        let mut device = local();
        set(&mut device, &path, binding("local")).unwrap();
        assert_eq!(load(&mut device, &path).unwrap()[&path]["id"], "local");
        assert!(!root.join(MANIFEST).exists());
    }
}
