// Basic file CRUD for the workspace (read/write/create/rename/delete) plus
// the OS "Get Info" window.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::State;

use crate::clipboard::{copy_recursively, unique_dest};
use crate::encoding::EncodingState;

/// Read a text file, decoding legacy charsets (GBK txt/log etc.) via
/// detection. The detected encoding is remembered so `write_file` can write
/// the same encoding back.
#[tauri::command]
pub fn read_file(path: String, state: State<EncodingState>) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("read_file failed: {e}"))?;
    let (text, enc) =
        crate::encoding::decode(bytes).map_err(|e| format!("read_file failed: {e}"))?;
    state.remember(&path, enc);
    Ok(text)
}

/// Cheap change-detection probe: returns (modification time in ms since the
/// epoch, byte size). Lets the frontend tell whether an open file changed on
/// disk without reading its whole content back.
#[tauri::command]
pub fn file_stat(path: String) -> Result<(u64, u64), String> {
    let meta = fs::metadata(&path).map_err(|e| format!("file_stat failed: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok((mtime, meta.len()))
}

/// Whether a path is a directory — lets the frontend tell folders apart from
/// files when the OS hands it bare paths (e.g. native drag-and-drop).
#[tauri::command]
pub fn is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
pub fn write_file(
    path: String,
    content: String,
    state: State<EncodingState>,
) -> Result<(), String> {
    // Written in the encoding the file was read with (UTF-8 when unknown).
    let bytes = state.encode_for(&path, &content);
    fs::write(&path, bytes).map_err(|e| format!("write_file failed: {e}"))
}

/// Write raw bytes (e.g. a pasted image blob) into `dir/name`, creating the
/// directory if needed and suffixing the name on a clash. Returns the path
/// actually written so the caller can build the markdown link from it.
#[tauri::command]
pub fn write_binary_file(dir: String, name: String, data: Vec<u8>) -> Result<String, String> {
    let d = PathBuf::from(&dir);
    fs::create_dir_all(&d).map_err(|e| format!("create dir failed: {e}"))?;
    let dest = unique_dest(&d, &name);
    fs::write(&dest, &data).map_err(|e| format!("write_binary_file failed: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Copy an existing file `src` into `dir` under `name` (a clash gets a " 2"
/// suffix), creating the directory if needed. Backs pasting a real file that was
/// copied in Finder/Explorer into a note. Returns the created path.
#[tauri::command]
pub fn save_file_to_dir(src: String, dir: String, name: String) -> Result<String, String> {
    let source = PathBuf::from(&src);
    if !source.exists() {
        return Err(format!("not found: {src}"));
    }
    let d = PathBuf::from(&dir);
    fs::create_dir_all(&d).map_err(|e| format!("create dir failed: {e}"))?;
    let dest = unique_dest(&d, &name);
    copy_recursively(&source, &dest)?;
    Ok(dest.to_string_lossy().to_string())
}

/// Join a directory and a (possibly extension-less) name into a `.md` path,
/// returning an error if the file already exists.
fn unique_md_path(dir: &str, name: &str) -> Result<PathBuf, String> {
    let mut file = PathBuf::from(dir).join(name);
    if file.extension().is_none() {
        file.set_extension("md");
    }
    if file.exists() {
        return Err(format!("already exists: {}", file.to_string_lossy()));
    }
    Ok(file)
}

#[tauri::command]
pub fn create_file(dir: String, name: String) -> Result<String, String> {
    let file = unique_md_path(&dir, &name)?;
    fs::write(&file, "").map_err(|e| format!("create_file failed: {e}"))?;
    Ok(file.to_string_lossy().to_string())
}

/// Create a file with the name exactly as given (no `.md` defaulting) —
/// backs the "新建文件" action for arbitrary plain files.
#[tauri::command]
pub fn create_raw_file(dir: String, name: String) -> Result<String, String> {
    let file = PathBuf::from(&dir).join(&name);
    if file.exists() {
        return Err(format!("already exists: {}", file.to_string_lossy()));
    }
    fs::write(&file, "").map_err(|e| format!("create_raw_file failed: {e}"))?;
    Ok(file.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_folder(dir: String, name: String) -> Result<String, String> {
    let folder = PathBuf::from(&dir).join(&name);
    if folder.exists() {
        return Err(format!("already exists: {}", folder.to_string_lossy()));
    }
    fs::create_dir_all(&folder).map_err(|e| format!("create_folder failed: {e}"))?;
    Ok(folder.to_string_lossy().to_string())
}

#[tauri::command]
pub fn rename(
    path: String,
    new_name: String,
    state: State<EncodingState>,
) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let parent = src
        .parent()
        .ok_or_else(|| "path has no parent".to_string())?;
    let mut dst = parent.join(&new_name);
    // Preserve the markdown extension for files when the user omits it.
    if !src.is_dir() && dst.extension().is_none() {
        dst.set_extension("md");
    }
    if dst.exists() {
        return Err(format!("already exists: {}", dst.to_string_lossy()));
    }
    fs::rename(&src, &dst).map_err(|e| format!("rename failed: {e}"))?;
    let dst = dst.to_string_lossy().to_string();
    state.rename(&path, &dst);
    Ok(dst)
}

/// Move `path` into `dest_dir`, keeping its original name. Returns the new path.
/// Guards against moving a node onto itself, into its current folder (no-op),
/// or into its own subtree (which would orphan/recurse a directory).
#[tauri::command]
pub fn move_path(
    path: String,
    dest_dir: String,
    state: State<EncodingState>,
) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let dest = PathBuf::from(&dest_dir);
    if !src.exists() {
        return Err(format!("not found: {path}"));
    }
    if !dest.is_dir() {
        return Err(format!("not a folder: {dest_dir}"));
    }
    let name = src
        .file_name()
        .ok_or_else(|| "path has no name".to_string())?;
    // Already in the target folder → nothing to do.
    if src.parent() == Some(dest.as_path()) {
        return Err("already in this folder".to_string());
    }
    // Disallow moving a directory into itself or any of its descendants.
    if src.is_dir() && dest.starts_with(&src) {
        return Err("cannot move a folder into itself".to_string());
    }
    let dst = dest.join(name);
    if dst.exists() {
        return Err(format!("already exists: {}", dst.to_string_lossy()));
    }
    fs::rename(&src, &dst).map_err(|e| format!("move failed: {e}"))?;
    let dst = dst.to_string_lossy().to_string();
    state.rename(&path, &dst);
    Ok(dst)
}

// Deleting a folder recursively removes every entry inside it; on the main
// thread that freezes the UI for a large tree (and the AI's delete_file goes
// through here). spawn_blocking keeps the main thread responsive.
#[tauri::command]
pub async fn delete(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if p.is_dir() {
            fs::remove_dir_all(&p).map_err(|e| format!("delete failed: {e}"))
        } else {
            fs::remove_file(&p).map_err(|e| format!("delete failed: {e}"))
        }
    })
    .await
    .map_err(|e| format!("delete task failed: {e}"))?
}

/// Open the OS file-info/properties window.
#[tauri::command]
pub fn show_file_info(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("not found: {path}"));
    }

    #[cfg(target_os = "macos")]
    {
        let escaped = path.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            "tell application \"Finder\"\n\
             activate\n\
             open information window of (POSIX file \"{escaped}\" as alias)\n\
             end tell"
        );
        let status = crate::proc::command("osascript")
            .args(["-e", &script])
            .status()
            .map_err(|e| format!("osascript failed: {e}"))?;
        if !status.success() {
            return Err("osascript failed".to_string());
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        show_file_properties_windows(Path::new(&path))
    }

    #[cfg(target_os = "linux")]
    {
        show_file_properties_linux(Path::new(&path))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("show info is not supported on this platform".to_string())
    }
}

#[cfg(target_os = "windows")]
fn show_file_properties_windows(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_INVOKEIDLIST, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOW;

    let verb: Vec<u16> = "properties".encode_utf16().chain([0]).collect();
    let file: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_INVOKEIDLIST,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        nShow: SW_SHOW.0,
        ..Default::default()
    };

    unsafe { ShellExecuteExW(&mut info) }.map_err(|e| format!("open properties failed: {e}"))
}

#[cfg(target_os = "linux")]
fn show_file_properties_linux(path: &Path) -> Result<(), String> {
    let uri = file_uri(path)?;
    let dbus_status = crate::proc::command("dbus-send")
        .args([
            "--session",
            "--dest=org.freedesktop.FileManager1",
            "--type=method_call",
            "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1.ShowItemProperties",
            &format!("array:string:{uri}"),
            "string:",
        ])
        .status();

    if matches!(dbus_status, Ok(status) if status.success()) {
        return Ok(());
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let status = crate::proc::command("xdg-open")
        .arg(parent)
        .status()
        .map_err(|e| format!("dbus ShowItemProperties failed; xdg-open failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("dbus ShowItemProperties failed; xdg-open failed".to_string())
    }
}

#[cfg(target_os = "linux")]
fn file_uri(path: &Path) -> Result<String, String> {
    use std::os::unix::ffi::OsStrExt;

    let absolute = path
        .canonicalize()
        .map_err(|e| format!("canonicalize failed: {e}"))?;
    let mut uri = String::from("file://");
    for &b in absolute.as_os_str().as_bytes() {
        let keep = b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'.' | b'_' | b'~');
        if keep {
            uri.push(b as char);
        } else {
            uri.push_str(&format!("%{b:02X}"));
        }
    }
    Ok(uri)
}
