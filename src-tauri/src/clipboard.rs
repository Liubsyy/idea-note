// System-clipboard bridge (text, file lists, images) via arboard: in-process
// native pasteboard APIs on all three desktop platforms (NSPasteboard, Win32
// OLE, X11/Wayland). This replaced the old osascript / PowerShell subprocess
// bridges, which flashed console windows on Windows, triggered macOS
// automation-permission prompts, and left Linux unsupported entirely.

use std::fs;
use std::path::{Path, PathBuf};

use arboard::Clipboard;
use std::borrow::Cow;
use std::io::Cursor;

/// Fresh clipboard handle per call — cheap everywhere. On X11/Wayland arboard
/// hands the contents to a process-global server thread, so what we set stays
/// available after this handle drops (for as long as the app runs).
fn clipboard() -> Result<Clipboard, String> {
    Clipboard::new().map_err(|e| format!("剪贴板不可用: {e}"))
}

/// Put files themselves (not their paths as text) on the system clipboard so
/// they can be pasted in Finder / Explorer / the Linux file manager.
#[tauri::command]
pub fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("没有可复制的文件".to_string());
    }
    if let Some(path) = paths.iter().find(|path| !Path::new(path).exists()) {
        return Err(format!("not found: {path}"));
    }
    clipboard()?
        .set()
        .file_list(&paths)
        .map_err(|e| format!("复制文件失败: {e}"))
}

/// Decode the browser's PNG into the RGBA pixels expected by native clipboards.
fn decode_clipboard_png(bytes: &[u8]) -> Result<arboard::ImageData<'static>, String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|e| format!("图片解码失败: {e}"))?;
    let mut buffer = vec![0; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|e| format!("图片解码失败: {e}"))?;
    let pixels = &buffer[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => pixels.to_vec(),
        png::ColorType::Rgb => pixels
            .chunks_exact(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        png::ColorType::Grayscale => pixels.iter().flat_map(|&v| [v, v, v, 255]).collect(),
        png::ColorType::GrayscaleAlpha => pixels
            .chunks_exact(2)
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        png::ColorType::Indexed => return Err("不支持的图片像素格式".to_string()),
    };
    Ok(arboard::ImageData {
        width: info.width as usize,
        height: info.height as usize,
        bytes: Cow::Owned(rgba),
    })
}

/// Set image data, so pasting into chat/image editors yields the image itself.
#[tauri::command]
pub async fn copy_image_to_clipboard(png: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let image = decode_clipboard_png(&png)?;
        clipboard()?
            .set_image(image)
            .map_err(|e| format!("复制图片失败: {e}"))
    })
    .await
    .map_err(|e| format!("clipboard image task failed: {e}"))?
}

#[tauri::command]
pub async fn has_clipboard_image() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| match clipboard()?.get_image() {
        Ok(_) => Ok(true),
        Err(arboard::Error::ContentNotAvailable) => Ok(false),
        Err(e) => Err(format!("读取剪贴板图片失败: {e}")),
    })
    .await
    .map_err(|e| format!("clipboard image task failed: {e}"))?
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
/// our own `copy_files_to_clipboard`); empty when the clipboard holds none.
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

#[cfg(test)]
mod tests {
    use super::decode_clipboard_png;

    #[test]
    fn clipboard_png_preserves_pixels_and_transparency() {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 2, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer
                .write_image_data(&[255, 0, 0, 128, 0, 255, 0, 0])
                .unwrap();
        }
        let image = decode_clipboard_png(&bytes).unwrap();
        assert_eq!((image.width, image.height), (2, 1));
        assert_eq!(image.bytes.as_ref(), &[255, 0, 0, 128, 0, 255, 0, 0]);
    }

    #[test]
    fn clipboard_png_expands_rgb_and_rejects_invalid_data() {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[5, 10, 20]).unwrap();
        }
        assert_eq!(
            decode_clipboard_png(&bytes).unwrap().bytes.as_ref(),
            &[5, 10, 20, 255]
        );
        assert!(decode_clipboard_png(b"not an image").is_err());
    }
}
