// Charset handling for user text files. The workspace can contain files the
// app didn't create — the OS file associations cover txt/log/csv/code files,
// which on zh-CN Windows are often GBK — so reading strictly as UTF-8 made
// them fail to open and silently vanish from search.
//
// Reads decode via BOM sniffing, strict UTF-8, then chardetng detection.
// `EncodingState` remembers each opened file's on-disk encoding so a save
// writes the same encoding back — otherwise every touched legacy file would
// flip to UTF-8 and show up as a whole-file diff in git sync.

use std::collections::HashMap;
use std::sync::Mutex;

use encoding_rs::{Encoding, GB18030, GBK, UTF_16BE, UTF_8};

/// How a file's bytes were encoded on disk.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum FileEncoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Legacy(&'static Encoding),
}

/// Decode file bytes as text, returning the detected encoding alongside.
/// `Err` means the content looks binary (NUL bytes without a Unicode BOM).
pub fn decode(bytes: Vec<u8>) -> Result<(String, FileEncoding), String> {
    if let Some((enc, bom_len)) = Encoding::for_bom(&bytes) {
        let body = &bytes[bom_len..];
        if enc == UTF_8 {
            return Ok((
                String::from_utf8_lossy(body).into_owned(),
                FileEncoding::Utf8Bom,
            ));
        }
        let (text, _) = enc.decode_without_bom_handling(body);
        let stored = if enc == UTF_16BE {
            FileEncoding::Utf16Be
        } else {
            FileEncoding::Utf16Le
        };
        return Ok((text.into_owned(), stored));
    }

    // No text codepage produces NUL; without a BOM that means binary.
    if bytes.contains(&0) {
        return Err("二进制文件".to_string());
    }

    match String::from_utf8(bytes) {
        Ok(text) => Ok((text, FileEncoding::Utf8)),
        Err(err) => {
            let bytes = err.into_bytes();
            let mut detector = chardetng::EncodingDetector::new();
            detector.feed(&bytes, true);
            let enc = detector.guess(None, true);
            let (text, _) = enc.decode_without_bom_handling(&bytes);
            Ok((text.into_owned(), FileEncoding::Legacy(enc)))
        }
    }
}

/// Decode for scanning (search, excerpts): just the text, `None` when binary.
pub fn decode_text(bytes: Vec<u8>) -> Option<String> {
    decode(bytes).ok().map(|(text, _)| text)
}

/// Encode `content` back into `enc`. The second value is false when a legacy
/// codepage couldn't represent every character — the bytes are then UTF-8,
/// trading a one-time encoding flip for not corrupting the user's text.
pub fn encode(content: &str, enc: FileEncoding) -> (Vec<u8>, bool) {
    match enc {
        FileEncoding::Utf8 => (content.as_bytes().to_vec(), true),
        FileEncoding::Utf8Bom => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(content.as_bytes());
            (out, true)
        }
        FileEncoding::Utf16Le => {
            let mut out = vec![0xFF, 0xFE];
            for unit in content.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
            (out, true)
        }
        FileEncoding::Utf16Be => {
            let mut out = vec![0xFE, 0xFF];
            for unit in content.encode_utf16() {
                out.extend_from_slice(&unit.to_be_bytes());
            }
            (out, true)
        }
        FileEncoding::Legacy(enc) => {
            // GB18030 is byte-identical to GBK on GBK's repertoire but covers
            // all of Unicode, so GBK files upgrade instead of losing characters.
            let target = if enc == GBK { GB18030 } else { enc };
            let (bytes, _, had_errors) = target.encode(content);
            if had_errors {
                (content.as_bytes().to_vec(), false)
            } else {
                (bytes.into_owned(), true)
            }
        }
    }
}

/// Per-path record of the encoding each open file was read with, so
/// `write_file` can write the same encoding back. Plain UTF-8 (the norm) is
/// not stored. Shared by all windows; entries are tiny and never expire.
#[derive(Default)]
pub struct EncodingState(Mutex<HashMap<String, FileEncoding>>);

impl EncodingState {
    pub fn remember(&self, path: &str, enc: FileEncoding) {
        let mut map = self.0.lock().unwrap();
        if enc == FileEncoding::Utf8 {
            map.remove(path);
        } else {
            map.insert(path.to_string(), enc);
        }
    }

    /// Encode `content` for writing to `path` in the encoding it was read
    /// with (UTF-8 when unknown). A lossy legacy round-trip downgrades the
    /// record to UTF-8 so later saves stay consistent with the bytes written.
    pub fn encode_for(&self, path: &str, content: &str) -> Vec<u8> {
        let mut map = self.0.lock().unwrap();
        let Some(&enc) = map.get(path) else {
            return content.as_bytes().to_vec();
        };
        let (bytes, lossless) = encode(content, enc);
        if !lossless {
            map.remove(path);
        }
        bytes
    }

    /// Carry a remembered encoding along when the file is renamed/moved.
    pub fn rename(&self, old: &str, new: &str) {
        let mut map = self.0.lock().unwrap();
        if let Some(enc) = map.remove(old) {
            map.insert(new.to_string(), enc);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GBK_SAMPLE: &str = "这是一段用来测试编码检测的中文文本。\
        灵感笔记应当能打开历史遗留的国标编码文件，比如从旧电脑迁移过来的\
        记事本文档、日志和代码注释，并在保存时保持原有编码不变。";

    #[test]
    fn plain_utf8_roundtrip() {
        let (text, enc) = decode("你好 world".as_bytes().to_vec()).unwrap();
        assert_eq!(text, "你好 world");
        assert_eq!(enc, FileEncoding::Utf8);
        assert_eq!(encode(&text, enc), ("你好 world".as_bytes().to_vec(), true));
    }

    #[test]
    fn gbk_detects_decodes_and_roundtrips() {
        let (gbk_bytes, _, had_errors) = GBK.encode(GBK_SAMPLE);
        assert!(!had_errors);
        let (text, enc) = decode(gbk_bytes.to_vec()).unwrap();
        assert_eq!(text, GBK_SAMPLE);
        assert!(matches!(enc, FileEncoding::Legacy(_)));
        // Written bytes must match the original (GB18030 == GBK here).
        let (bytes, lossless) = encode(&text, enc);
        assert!(lossless);
        assert_eq!(bytes, gbk_bytes.into_owned());
    }

    #[test]
    fn utf8_bom_is_stripped_and_restored() {
        let mut on_disk = vec![0xEF, 0xBB, 0xBF];
        on_disk.extend_from_slice("笔记".as_bytes());
        let (text, enc) = decode(on_disk.clone()).unwrap();
        assert_eq!(text, "笔记");
        assert_eq!(enc, FileEncoding::Utf8Bom);
        assert_eq!(encode(&text, enc), (on_disk, true));
    }

    #[test]
    fn utf16le_roundtrips() {
        let mut on_disk = vec![0xFF, 0xFE];
        for unit in "中文 note".encode_utf16() {
            on_disk.extend_from_slice(&unit.to_le_bytes());
        }
        let (text, enc) = decode(on_disk.clone()).unwrap();
        assert_eq!(text, "中文 note");
        assert_eq!(enc, FileEncoding::Utf16Le);
        assert_eq!(encode(&text, enc), (on_disk, true));
    }

    #[test]
    fn binary_is_rejected() {
        assert!(decode(vec![0x00, 0x01, 0xFF, 0x00]).is_err());
    }

    #[test]
    fn unmappable_legacy_falls_back_to_utf8() {
        let (bytes, lossless) = encode("中文", FileEncoding::Legacy(encoding_rs::WINDOWS_1252));
        assert!(!lossless);
        assert_eq!(bytes, "中文".as_bytes());
    }

    #[test]
    fn state_tracks_saves_and_renames() {
        let state = EncodingState::default();
        // Unknown path → plain UTF-8.
        assert_eq!(state.encode_for("/a.txt", "hi"), b"hi".to_vec());

        state.remember("/a.txt", FileEncoding::Utf8Bom);
        state.rename("/a.txt", "/b.txt");
        assert_eq!(
            state.encode_for("/b.txt", "hi"),
            vec![0xEF, 0xBB, 0xBF, b'h', b'i']
        );

        // A lossy legacy save downgrades the record to UTF-8.
        state.remember("/c.txt", FileEncoding::Legacy(encoding_rs::WINDOWS_1252));
        assert_eq!(state.encode_for("/c.txt", "中文"), "中文".as_bytes());
        assert_eq!(state.encode_for("/c.txt", "中文"), "中文".as_bytes());
    }
}
