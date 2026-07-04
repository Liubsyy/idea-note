// System-clipboard bridge (text, file lists, images) via arboard: in-process
// native pasteboard APIs on all three desktop platforms (NSPasteboard, Win32
// OLE, X11/Wayland). This replaced the old osascript / PowerShell subprocess
// bridges, which flashed console windows on Windows, triggered macOS
// automation-permission prompts, and left Linux unsupported entirely.

use std::fs;
use std::path::{Path, PathBuf};

use arboard::Clipboard;

/// Fresh clipboard handle per call — cheap everywhere. On X11/Wayland arboard
/// hands the contents to a process-global server thread, so what we set stays
/// available after this handle drops (for as long as the app runs).
fn clipboard() -> Result<Clipboard, String> {
    Clipboard::new().map_err(|e| format!("剪贴板不可用: {e}"))
}

/// Put the file itself (not its path) on the system clipboard so it can be
/// pasted in Finder / Explorer / the Linux file manager.
#[tauri::command]
pub fn copy_file_to_clipboard(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("not found: {path}"));
    }
    clipboard()?
        .set()
        .file_list(&[&path])
        .map_err(|e| format!("复制文件失败: {e}"))
}

/// Plain text currently on the system clipboard (empty string when none).
/// The webview's async clipboard read is unreliable in WKWebView, so the
/// editor's paste falls back to this.
#[tauri::command]
pub fn read_clipboard_text() -> Result<String, String> {
    match clipboard()?.get_text() {
        Ok(text) => Ok(text),
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        Err(e) => Err(format!("读取剪贴板失败: {e}")),
    }
}

/// File paths currently on the system clipboard (set by Finder/Explorer or
/// our own `copy_file_to_clipboard`); empty when the clipboard holds none.
fn clipboard_file_paths() -> Result<Vec<String>, String> {
    match clipboard()?.get().file_list() {
        Ok(paths) => Ok(paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect()),
        Err(arboard::Error::ContentNotAvailable) => Ok(Vec::new()),
        Err(e) => Err(format!("读取剪贴板失败: {e}")),
    }
}

/// File paths currently on the system clipboard, exposed to the frontend so the
/// editor can save a Finder/Explorer-copied real file into the configured
/// image/attachment directory when it's pasted into a note.
#[tauri::command]
pub fn list_clipboard_files() -> Result<Vec<String>, String> {
    clipboard_file_paths()
}

/// Encode arboard's RGBA pixels as a PNG file.
fn write_png(dest: &Path, image: &arboard::ImageData) -> Result<(), String> {
    let file = fs::File::create(dest).map_err(|e| format!("create file failed: {e}"))?;
    let mut encoder = png::Encoder::new(
        std::io::BufWriter::new(file),
        image.width as u32,
        image.height as u32,
    );
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|e| format!("png encode failed: {e}"))?;
    writer
        .write_image_data(&image.bytes)
        .map_err(|e| format!("png encode failed: {e}"))?;
    Ok(())
}

/// Save the image currently on the system clipboard into `dir` as `<stem>.png`
/// (clashes get a " 2"/" 3" suffix), returning the created path — or null when
/// the clipboard holds no image. Backs pasting a screenshot / web image into a
/// note without shipping its bytes through the webview.
///
/// async + spawn_blocking: a Retina screenshot is tens of MB of RGBA, and PNG
/// encoding it on the main thread would visibly stutter the UI.
#[tauri::command]
pub async fn save_clipboard_image_to_dir(
    dir: String,
    stem: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let image = match clipboard()?.get_image() {
            Ok(image) => image,
            Err(arboard::Error::ContentNotAvailable) => return Ok(None),
            Err(e) => return Err(format!("读取剪贴板图片失败: {e}")),
        };
        let dir = PathBuf::from(&dir);
        fs::create_dir_all(&dir).map_err(|e| format!("create dir failed: {e}"))?;
        let dest = unique_dest(&dir, &format!("{stem}.png"));
        write_png(&dest, &image)?;
        Ok(Some(dest.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| format!("clipboard image task failed: {e}"))?
}

/// `dir/name`, suffixing " 2", " 3", … before the extension when taken.
pub(crate) fn unique_dest(dir: &Path, name: &str) -> PathBuf {
    let dest = dir.join(name);
    if !dest.exists() {
        return dest;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), Some(e.to_string())),
        _ => (name.to_string(), None),
    };
    for i in 2.. {
        let candidate = match &ext {
            Some(e) => format!("{stem} {i}.{e}"),
            None => format!("{stem} {i}"),
        };
        let dest = dir.join(candidate);
        if !dest.exists() {
            return dest;
        }
    }
    unreachable!()
}

pub(crate) fn copy_recursively(src: &Path, dest: &Path) -> Result<(), String> {
    if src.is_dir() {
        fs::create_dir_all(dest).map_err(|e| format!("create dir failed: {e}"))?;
        let entries = fs::read_dir(src).map_err(|e| format!("read_dir failed: {e}"))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_recursively(&entry.path(), &dest.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(src, dest)
            .map(|_| ())
            .map_err(|e| format!("copy failed: {e}"))
    }
}

/// Copy the files on the system clipboard into `target_dir`, returning the
/// created paths. Name clashes get a " 2"/" 3" suffix instead of overwriting.
#[tauri::command]
pub fn paste_from_clipboard(target_dir: String) -> Result<Vec<String>, String> {
    let dir = PathBuf::from(&target_dir);
    if !dir.is_dir() {
        return Err(format!("not a directory: {target_dir}"));
    }
    let sources = clipboard_file_paths()?;
    if sources.is_empty() {
        return Err("剪贴板中没有文件".to_string());
    }
    let mut created = Vec::new();
    for source in sources {
        let src = PathBuf::from(&source);
        if !src.exists() {
            continue;
        }
        if src.is_dir() && dir.starts_with(&src) {
            return Err("无法将文件夹粘贴到其自身内部".to_string());
        }
        let name = src
            .file_name()
            .ok_or_else(|| format!("invalid source: {source}"))?
            .to_string_lossy()
            .to_string();
        let dest = unique_dest(&dir, &name);
        copy_recursively(&src, &dest)?;
        created.push(dest.to_string_lossy().to_string());
    }
    if created.is_empty() {
        return Err("剪贴板中没有文件".to_string());
    }
    Ok(created)
}
