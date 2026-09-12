// Workspace file tree and full-text search.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

const SEARCH_CANCELLED: &str = "笔记搜索已取消";

#[derive(Default)]
pub struct NoteSearchState {
    searches: Arc<Mutex<HashMap<String, NoteSearchEntry>>>,
}

struct NoteSearchEntry {
    cancelled: Arc<AtomicBool>,
    started: bool,
}

impl NoteSearchState {
    fn prepare(&self, id: String) -> Result<(), String> {
        let mut searches = self.searches.lock().unwrap();
        if id.is_empty() || searches.contains_key(&id) {
            return Err("搜索 ID 无效或已存在".into());
        }
        searches.insert(
            id,
            NoteSearchEntry {
                cancelled: Arc::new(AtomicBool::new(false)),
                started: false,
            },
        );
        Ok(())
    }

    fn claim(&self, id: String) -> Result<ActiveNoteSearch, String> {
        let mut searches = self.searches.lock().unwrap();
        let entry = searches.get_mut(&id).ok_or(SEARCH_CANCELLED)?;
        if entry.started {
            return Err("该搜索已在运行".into());
        }
        entry.started = true;
        Ok(ActiveNoteSearch {
            id,
            cancelled: entry.cancelled.clone(),
            searches: self.searches.clone(),
        })
    }

    fn cancel(&self, id: &str) {
        if let Some(entry) = self.searches.lock().unwrap().remove(id) {
            entry.cancelled.store(true, Ordering::Release);
        }
    }
}

struct ActiveNoteSearch {
    id: String,
    cancelled: Arc<AtomicBool>,
    searches: Arc<Mutex<HashMap<String, NoteSearchEntry>>>,
}

impl Drop for ActiveNoteSearch {
    fn drop(&mut self) {
        let mut searches = self.searches.lock().unwrap();
        if searches
            .get(&self.id)
            .is_some_and(|e| Arc::ptr_eq(&e.cancelled, &self.cancelled))
        {
            searches.remove(&self.id);
        }
    }
}

fn check_search_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        Err(SEARCH_CANCELLED.into())
    } else {
        Ok(())
    }
}

/// Acknowledge registration before the frontend dispatches any disk work.
/// Cancellation can remove a queued registration as well as stop a running scan.
#[tauri::command]
pub fn prepare_note_search(
    state: State<NoteSearchState>,
    request_id: String,
) -> Result<(), String> {
    state.prepare(request_id)
}

#[tauri::command]
pub fn cancel_note_search(state: State<NoteSearchState>, request_id: String) {
    state.cancel(&request_id);
}

/// A node in the workspace file tree. Directories carry their children;
/// files have `children: None`.
#[derive(Serialize)]
pub struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Option<Vec<FileNode>>,
    /// Last-modified time in epoch milliseconds (files only).
    mtime: Option<u64>,
    /// First content line of a markdown note — the sidebar notes-mode preview.
    excerpt: Option<String>,
}

/// Entries excluded from the tree and search. Hidden (dot) files are shown;
/// only VCS internals and macOS metadata are skipped.
fn is_excluded(name: &str) -> bool {
    matches!(name, ".git" | ".svn" | ".hg" | ".DS_Store")
}

fn is_markdown(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

const EXCERPT_READ_BYTES: usize = 4096;
const EXCERPT_MAX_CHARS: usize = 80;

/// Drop leading block markers (heading/quote/list/task) and inline emphasis
/// punctuation so the excerpt reads as plain prose.
fn strip_md_line(line: &str) -> String {
    let mut s = line.trim();
    loop {
        let before = s;
        s = s
            .trim_start_matches(|c| matches!(c, '#' | '>' | '-' | '*' | '+'))
            .trim_start();
        if let Some(rest) = s
            .strip_prefix("[ ]")
            .or_else(|| s.strip_prefix("[x]"))
            .or_else(|| s.strip_prefix("[X]"))
        {
            s = rest.trim_start();
        }
        // Ordered-list marker: "12. text".
        let digits = s.trim_start_matches(|c: char| c.is_ascii_digit());
        if digits.len() != s.len() {
            if let Some(rest) = digits.strip_prefix('.') {
                s = rest.trim_start();
            }
        }
        if s == before {
            break;
        }
    }
    s.replace(['`', '*'], "").replace("~~", "")
}

fn truncate_chars(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if out.len() < s.len() {
        out.push('…');
    }
    out
}

/// First content line of a markdown note, markers stripped. Reads only the
/// head of the file. YAML frontmatter is skipped; headings are skipped too
/// (the filename already serves as the title) but used as a fallback when the
/// note contains nothing else.
fn md_excerpt(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; EXCERPT_READ_BYTES];
    let n = file.read(&mut buf).ok()?;
    if n == 0 {
        return None;
    }
    // Decode the head like a full read would (GBK notes get readable
    // excerpts); `decode_head` drops a multibyte char cut at the 4KB boundary
    // so it can't push a UTF-8 file into legacy detection.
    let text = crate::encoding::decode_head(buf[..n].to_vec())?;

    let mut lines = text.lines().peekable();
    if lines.peek().map(|l| l.trim()) == Some("---") {
        lines.next();
        for line in lines.by_ref() {
            if line.trim() == "---" {
                break;
            }
        }
    }

    let mut heading_fallback: Option<String> = None;
    for raw in lines {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let stripped = strip_md_line(line);
        if stripped.is_empty() {
            continue;
        }
        if line.starts_with('#') {
            heading_fallback.get_or_insert(stripped);
            continue;
        }
        return Some(truncate_chars(&stripped, EXCERPT_MAX_CHARS));
    }
    heading_fallback.map(|h| truncate_chars(&h, EXCERPT_MAX_CHARS))
}

fn file_mtime_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// Recursively read a directory, keeping every sub-directory and every
/// (non-excluded) file regardless of extension. Entries are sorted:
/// directories first, then files, each alphabetically (case-insensitive).
fn read_tree(dir: &Path) -> Result<Vec<FileNode>, String> {
    let mut nodes: Vec<FileNode> = Vec::new();

    let entries = fs::read_dir(dir).map_err(|e| format!("read_dir failed: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if is_excluded(&name) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        if metadata.is_dir() {
            let children = read_tree(&path)?;
            nodes.push(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: true,
                children: Some(children),
                mtime: None,
                excerpt: None,
            });
        } else {
            let excerpt = if is_markdown(&name) {
                md_excerpt(&path)
            } else {
                None
            };
            nodes.push(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                children: None,
                mtime: file_mtime_ms(&metadata),
                excerpt,
            });
        }
    }

    nodes.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(nodes)
}

// `read_tree` recurses the whole workspace (and reads md files for excerpts),
// so running it on the main thread freezes the UI while the tree loads or
// refreshes — including the refresh the AI triggers after create/delete.
// spawn_blocking moves the walk off the main thread.
#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<FileNode>, String> {
    tauri::async_runtime::spawn_blocking(move || read_tree(Path::new(&path)))
        .await
        .map_err(|e| format!("list_dir task failed: {e}"))?
}

/// A single level for browsing. Unloaded directories have children: None;
/// an empty, loaded directory has children: Some([]) in the frontend cache.
fn read_directory(dir: &Path) -> Result<Vec<FileNode>, String> {
    let mut nodes = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_excluded(&name) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        nodes.push(FileNode {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: metadata.is_dir(),
            children: None,
            mtime: if metadata.is_dir() {
                None
            } else {
                file_mtime_ms(&metadata)
            },
            excerpt: None,
        });
    }
    nodes.sort_by_cached_key(|n| (!n.is_dir, n.name.to_lowercase()));
    Ok(nodes)
}

#[tauri::command]
pub async fn list_directory(path: String) -> Result<Vec<FileNode>, String> {
    tauri::async_runtime::spawn_blocking(move || read_directory(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

/// The notes index is independent of the lazy browser tree and never opens
/// note contents. Check cancellation between entries and never follow directory
/// symlinks/junctions: a project can link back to its own parent.
fn read_notes_index(dir: &Path, cancelled: &AtomicBool) -> Result<Vec<FileNode>, String> {
    check_search_cancelled(cancelled)?;
    let mut nodes = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        check_search_cancelled(cancelled)?;
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_excluded(&name) {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() && !kind.is_symlink() {
            let children = match read_notes_index(&path, cancelled) {
                Ok(children) => children,
                Err(_) if cancelled.load(Ordering::Acquire) => return Err(SEARCH_CANCELLED.into()),
                Err(_) => continue, // One unreadable folder must not hide all notes.
            };
            if !children.is_empty() {
                nodes.push(FileNode {
                    name,
                    path: path.to_string_lossy().into_owned(),
                    is_dir: true,
                    children: Some(children),
                    mtime: None,
                    excerpt: None,
                });
            }
        } else if kind.is_file() && is_markdown(&name) {
            nodes.push(FileNode {
                name,
                path: path.to_string_lossy().into_owned(),
                is_dir: false,
                children: None,
                mtime: entry.metadata().ok().and_then(|m| file_mtime_ms(&m)),
                excerpt: None,
            });
        }
    }
    nodes.sort_by_cached_key(|n| (!n.is_dir, n.name.to_lowercase()));
    Ok(nodes)
}

#[tauri::command]
pub async fn list_notes_index(
    path: String,
    request_id: String,
    state: State<'_, NoteSearchState>,
) -> Result<Vec<FileNode>, String> {
    let search = state.claim(request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        read_notes_index(Path::new(&path), &search.cancelled)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn note_excerpt(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || md_excerpt(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())
}

/// One match from `search_notes`. Filename matches have `line: None`;
/// content matches carry the 1-based line number and a trimmed snippet.
#[derive(Serialize)]
pub struct SearchHit {
    path: String,
    name: String,
    line: Option<u32>,
    snippet: Option<String>,
}

const SEARCH_MAX_HITS: usize = 50;
const SEARCH_MAX_HITS_PER_FILE: usize = 3;
/// Snippet window (chars) and how many of them sit before the match, so the
/// matched term stays visible even when it falls deep inside a long line.
const SEARCH_SNIPPET_MAX_CHARS: usize = 200;
const SEARCH_SNIPPET_CONTEXT_CHARS: usize = 40;
/// Skip the content scan for files larger than this (still allow a filename
/// match); avoids slurping multi-MB logs/JSON into memory for the LLM.
const SEARCH_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Per-file scoring weights. Filename matches dominate; heading lines (`#…`)
/// outrank plain body lines; raw match frequency breaks ties.
const SCORE_FILENAME: i64 = 1000;
const SCORE_HEADING_LINE: i64 = 8;
const SCORE_BODY_LINE: i64 = 1;
/// Cap each file's frequency contribution so one keyword-stuffed file can't
/// crowd out genuinely relevant ones.
const SCORE_FREQ_CAP: i64 = 50;

/// One file's contribution to the result set, kept together so the whole set
/// can be ranked before the global cap is applied (the previous walk-order
/// truncation could drop the most relevant file just for sorting late).
struct FileResult {
    score: i64,
    hits: Vec<SearchHit>,
}

/// True when every term is present in `lower` (already lowercased). Terms are
/// AND-combined, so a multi-word query like "tauri 图片" matches a line only if
/// it contains both — far better recall than the old literal-substring match.
fn all_terms_match(lower: &str, terms: &[String]) -> bool {
    terms.iter().all(|t| lower.contains(t.as_str()))
}

/// Build a snippet from `line` centred on the earliest term match in `lower`
/// (its lowercased twin), so the keyword is visible even far into a long line.
fn centered_snippet(line: &str, lower: &str, terms: &[String]) -> String {
    let earliest_byte = terms
        .iter()
        .filter_map(|t| lower.find(t.as_str()))
        .min()
        .unwrap_or(0);
    // Byte offset in `lower` → char index; exact for ASCII/CJK (1:1 lowercasing).
    let match_char = lower[..earliest_byte].chars().count();
    let start = match_char.saturating_sub(SEARCH_SNIPPET_CONTEXT_CHARS);
    let total = line.chars().count();
    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    snippet.extend(line.chars().skip(start).take(SEARCH_SNIPPET_MAX_CHARS));
    if total > start + SEARCH_SNIPPET_MAX_CHARS {
        snippet.push('…');
    }
    snippet
}

/// Scan one text file, producing its ranked [`FileResult`] (or `None` when
/// nothing matched). `lower_buf` is reused across files/lines to avoid a fresh
/// allocation per line. `name_matched` is the filename hit decided by caller.
fn scan_file(
    path_str: &str,
    name: &str,
    content: &str,
    terms: &[String],
    name_matched: bool,
    lower_buf: &mut String,
    cancelled: &AtomicBool,
) -> Result<Option<FileResult>, String> {
    check_search_cancelled(cancelled)?;
    let mut hits = Vec::new();
    let mut score = 0i64;

    if name_matched {
        score += SCORE_FILENAME;
        hits.push(SearchHit {
            path: path_str.to_string(),
            name: name.to_string(),
            line: None,
            snippet: None,
        });
    }

    let mut freq = 0i64;
    for (i, raw_line) in content.lines().enumerate() {
        check_search_cancelled(cancelled)?;
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        lower_buf.clear();
        lower_buf.extend(line.chars().flat_map(|c| c.to_lowercase()));
        if !all_terms_match(lower_buf, terms) {
            continue;
        }
        let is_heading = line.starts_with('#');
        score += if is_heading {
            SCORE_HEADING_LINE
        } else {
            SCORE_BODY_LINE
        };
        freq += 1;
        // Keep only the first few matched lines as displayed hits, but keep
        // counting frequency (capped) so ranking reflects true match density.
        if hits.iter().filter(|h| h.line.is_some()).count() < SEARCH_MAX_HITS_PER_FILE {
            let snippet = centered_snippet(line, lower_buf, terms);
            hits.push(SearchHit {
                path: path_str.to_string(),
                name: name.to_string(),
                line: Some((i + 1) as u32),
                snippet: Some(snippet),
            });
        } else if freq >= SCORE_FREQ_CAP {
            break;
        }
    }

    if hits.is_empty() {
        return Ok(None);
    }
    score += freq.min(SCORE_FREQ_CAP);
    Ok(Some(FileResult { score, hits }))
}

/// Check between bounded reads, including when a file grows during the scan.
/// A single OS read may still have to finish, but no further reads start after stop.
fn read_search_bytes(
    reader: &mut impl Read,
    cancelled: &AtomicBool,
) -> Result<Option<Vec<u8>>, String> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        check_search_cancelled(cancelled)?;
        match reader.read(&mut chunk) {
            Ok(0) => return Ok(Some(bytes)),
            Ok(n) => {
                if bytes.len() + n > SEARCH_MAX_FILE_BYTES as usize {
                    return Ok(None);
                }
                bytes.extend_from_slice(&chunk[..n]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Ok(None),
        }
    }
}

fn search_dir(
    dir: &Path,
    terms: &[String],
    lower_buf: &mut String,
    results: &mut Vec<FileResult>,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    check_search_cancelled(cancelled)?;
    let entries = fs::read_dir(dir).map_err(|e| format!("read_dir failed: {e}"))?;
    for entry in entries {
        check_search_cancelled(cancelled)?;
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if is_excluded(&name) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        if metadata.is_dir() {
            search_dir(&path, terms, lower_buf, results, cancelled)?;
            continue;
        }
        // FIFOs/devices are not note files and could block a read indefinitely.
        if !metadata.is_file() {
            continue;
        }

        let path_str = path.to_string_lossy().to_string();
        let name_matched = all_terms_match(&name.to_lowercase(), terms);

        // Content scan: only reasonably sized text files (binaries skip;
        // legacy charsets like GBK are decoded). Oversized files can still
        // land a filename hit.
        let content = if metadata.len() <= SEARCH_MAX_FILE_BYTES {
            check_search_cancelled(cancelled)?;
            match fs::File::open(&path) {
                Ok(mut file) => {
                    read_search_bytes(&mut file, cancelled)?.and_then(crate::encoding::decode_text)
                }
                Err(_) => None,
            }
        } else {
            None
        };

        check_search_cancelled(cancelled)?;
        match content {
            Some(text) => {
                if let Some(result) = scan_file(
                    &path_str,
                    &name,
                    &text,
                    terms,
                    name_matched,
                    lower_buf,
                    cancelled,
                )? {
                    results.push(result);
                }
            }
            None if name_matched => results.push(FileResult {
                score: SCORE_FILENAME,
                hits: vec![SearchHit {
                    path: path_str,
                    name,
                    line: None,
                    snippet: None,
                }],
            }),
            None => {}
        }
    }
    Ok(())
}

/// Case-insensitive keyword search over filenames and text-file contents.
/// The query is split on whitespace into AND-combined terms; results are
/// ranked by relevance (filename > heading > body, then match density) and
/// capped so the most relevant matches survive truncation when handed to an LLM.
// The recursive file walk does blocking disk I/O. Tauri runs synchronous
// commands on the main thread, so calling this directly as a command would
// freeze the WebView (and the "处理中" card never paints) for the duration of
// the crawl. The `#[tauri::command]` wrapper below moves it off the main
// thread; this inner fn stays sync so the unit tests can call it directly.
fn search_notes_inner(
    dir: String,
    query: String,
    cancelled: &AtomicBool,
) -> Result<Vec<SearchHit>, String> {
    check_search_cancelled(cancelled)?;
    let terms: Vec<String> = query.split_whitespace().map(|t| t.to_lowercase()).collect();
    if terms.is_empty() {
        return Err("query is empty".into());
    }

    let mut results = Vec::new();
    let mut lower_buf = String::new();
    search_dir(
        Path::new(&dir),
        &terms,
        &mut lower_buf,
        &mut results,
        cancelled,
    )?;

    check_search_cancelled(cancelled)?;
    // Highest score first; stable so equal scores keep walk order.
    results.sort_by(|a, b| b.score.cmp(&a.score));
    check_search_cancelled(cancelled)?;

    let mut hits = Vec::with_capacity(SEARCH_MAX_HITS.min(results.len()));
    for result in results {
        for hit in result.hits {
            if hits.len() >= SEARCH_MAX_HITS {
                return Ok(hits);
            }
            hits.push(hit);
        }
    }
    Ok(hits)
}

#[tauri::command]
pub async fn search_notes(
    state: State<'_, NoteSearchState>,
    dir: String,
    query: String,
    request_id: String,
) -> Result<Vec<SearchHit>, String> {
    let search = state.claim(request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        // The guard releases the registration on success, error, or panic.
        let result = search_notes_inner(dir, query, &search.cancelled);
        drop(search);
        result
    })
    .await
    .map_err(|e| format!("search task failed: {e}"))?
}

#[cfg(test)]
mod excerpt_tests {
    use super::*;

    /// Body long enough that the 4KB excerpt read stops mid-file, so the
    /// read boundary lands inside a multibyte character.
    fn long_body(first_line: &str) -> String {
        format!(
            "{first_line}\n\n{}",
            "填充正文用来把文件撑过四千字节。".repeat(200)
        )
    }

    fn write_temp(tag: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "idea-note-excerpt-test-{}-{}",
            std::process::id(),
            tag
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.md");
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn gbk_note_gets_readable_excerpt() {
        let text = long_body("本文介绍灵感笔记如何读取国标编码的笔记文件。");
        let (bytes, _, had_errors) = encoding_rs::GBK.encode(&text);
        assert!(!had_errors);
        let path = write_temp("gbk", &bytes);
        assert_eq!(
            md_excerpt(&path).unwrap(),
            "本文介绍灵感笔记如何读取国标编码的笔记文件。"
        );
        fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn utf16le_note_gets_readable_excerpt() {
        let text = long_body("本文介绍灵感笔记如何读取 UTF-16 编码的笔记文件。");
        let mut bytes = vec![0xFF, 0xFE];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let path = write_temp("utf16le", &bytes);
        assert_eq!(
            md_excerpt(&path).unwrap(),
            "本文介绍灵感笔记如何读取 UTF-16 编码的笔记文件。"
        );
        fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn utf8_bom_note_gets_readable_excerpt() {
        let text = long_body("本文介绍灵感笔记如何读取带 BOM 的笔记文件。");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(text.as_bytes());
        let path = write_temp("utf8bom", &bytes);
        assert_eq!(
            md_excerpt(&path).unwrap(),
            "本文介绍灵感笔记如何读取带 BOM 的笔记文件。"
        );
        fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn utf8_note_cut_mid_character_gets_readable_excerpt() {
        let text = long_body("本文介绍灵感笔记的 AI 助手是如何工作的。");
        let path = write_temp("utf8", text.as_bytes());
        assert_eq!(
            md_excerpt(&path).unwrap(),
            "本文介绍灵感笔记的 AI 助手是如何工作的。"
        );
        fs::remove_dir_all(path.parent().unwrap()).ok();
    }
}

#[cfg(test)]
mod browsing_tests {
    use super::*;

    #[test]
    fn shallow_listing_does_not_read_descendants_or_excerpts() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("nested")).unwrap();
        fs::write(dir.path().join("nested/hidden.md"), "body").unwrap();
        fs::write(dir.path().join("root.md"), "preview").unwrap();
        let nodes = read_directory(dir.path()).unwrap();
        assert_eq!(nodes.len(), 2);
        assert!(nodes[0].is_dir);
        assert!(nodes
            .iter()
            .all(|n| n.children.is_none() && n.excerpt.is_none()));
        assert!(nodes[1].mtime.is_some());
    }

    #[test]
    fn notes_index_keeps_nested_notes_without_opening_contents() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "deep/a/note.MD",
            "deep/a/code.rs",
            "empty/code.js",
            ".git/ignored.md",
            ".hidden/visible.markdown",
        ] {
            let path = dir.path().join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "preview text").unwrap();
        }
        let nodes = read_notes_index(dir.path(), &AtomicBool::new(false)).unwrap();
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].name, ".hidden");
        let deep = &nodes[1].children.as_ref().unwrap()[0]
            .children
            .as_ref()
            .unwrap()[0];
        assert_eq!(deep.name, "note.MD");
        assert!(deep.excerpt.is_none());
        assert!(read_notes_index(dir.path(), &AtomicBool::new(true)).is_err());
    }

    #[test]
    fn cancelled_index_registration_cannot_start() {
        let state = NoteSearchState::default();
        state.prepare("index".into()).unwrap();
        state.cancel("index");
        assert!(state.claim("index".into()).is_err());
    }

    #[test]
    #[ignore = "Synthetic I/O benchmark; run explicitly with --ignored --nocapture"]
    fn compare_large_workspace_listing() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..100 {
            let folder = dir.path().join(format!("folder-{i}"));
            fs::create_dir(&folder).unwrap();
            for j in 0..50 {
                fs::write(
                    folder.join(format!("note-{j}.md")),
                    "# Title\n\nA note preview.\n".repeat(200),
                )
                .unwrap();
            }
        }
        let start = std::time::Instant::now();
        let full = read_tree(dir.path()).unwrap();
        let full_elapsed = start.elapsed();
        let start = std::time::Instant::now();
        let shallow = read_directory(dir.path()).unwrap();
        let shallow_elapsed = start.elapsed();
        assert_eq!(full.len(), shallow.len());
        assert_eq!(shallow.len(), 100);
        assert!(shallow.iter().all(|n| n.children.is_none()));
        eprintln!("5000 notes / 100 folders: full={full_elapsed:?}, root-only={shallow_elapsed:?}");
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;

    fn temp_workspace(tag: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "idea-note-aisearch-test-{}-{}",
            std::process::id(),
            tag
        ));
        let _ = fs::remove_dir_all(&dir);
        for (rel, content) in files {
            let path = dir.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        dir
    }

    fn run(dir: &Path, query: &str) -> Vec<SearchHit> {
        search_notes_inner(
            dir.to_string_lossy().into(),
            query.into(),
            &AtomicBool::new(false),
        )
        .unwrap()
    }

    #[test]
    fn multi_term_requires_all_terms() {
        let dir = temp_workspace(
            "andterms",
            &[
                ("a.md", "这一行同时讲 tauri 的图片加载"),
                ("b.md", "这一行只讲 tauri"),
                ("c.md", "这一行只讲图片"),
            ],
        );
        let hits = run(&dir, "tauri 图片");
        // Only a.md's line has both terms.
        let content: Vec<_> = hits.iter().filter(|h| h.line.is_some()).collect();
        assert_eq!(content.len(), 1);
        assert!(content[0].path.ends_with("a.md"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn filename_match_ranks_first() {
        let dir = temp_workspace(
            "ranking",
            &[
                // Filename hit — should outrank a body-only hit.
                ("灵感.md", "无关内容"),
                ("other.md", "这里提到灵感一次"),
            ],
        );
        let hits = run(&dir, "灵感");
        assert!(hits[0].path.ends_with("灵感.md"));
        assert!(hits[0].line.is_none());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn heading_outranks_body() {
        let dir = temp_workspace(
            "heading",
            &[
                ("body.md", "随便一段提到关键词的正文"),
                ("head.md", "# 关键词标题\n其它内容"),
            ],
        );
        let hits = run(&dir, "关键词");
        // head.md (heading match, score 8) ranks above body.md (body, score 1).
        assert!(hits[0].path.ends_with("head.md"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn snippet_is_centered_on_match() {
        let prefix = "前".repeat(300);
        let line = format!("{prefix}关键词后面还有内容");
        let dir = temp_workspace("snippet", &[("long.md", &line)]);
        let hits = run(&dir, "关键词");
        let snippet = hits[0].snippet.as_deref().unwrap();
        // The keyword survives truncation and the head is elided.
        assert!(snippet.contains("关键词"));
        assert!(snippet.starts_with('…'));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn oversized_file_skips_content_but_keeps_filename() {
        let big = "x".repeat((SEARCH_MAX_FILE_BYTES + 1024) as usize);
        let dir = temp_workspace(
            "oversized",
            &[("关键词.md", &big), ("small.md", "也有关键词")],
        );
        let hits = run(&dir, "关键词");
        let big_hit: Vec<_> = hits
            .iter()
            .filter(|h| h.path.ends_with("关键词.md"))
            .collect();
        // Filename matched, but the multi-MB body was never scanned.
        assert_eq!(big_hit.len(), 1);
        assert!(big_hit[0].line.is_none());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn empty_query_errors() {
        assert!(search_notes_inner("/tmp".into(), "   ".into(), &AtomicBool::new(false)).is_err());
    }

    #[test]
    fn cancelled_registration_never_starts_a_scan() {
        let state = NoteSearchState::default();
        state.prepare("queued".into()).unwrap();
        state.cancel("queued");
        assert!(matches!(state.claim("queued".into()), Err(e) if e == SEARCH_CANCELLED));
        assert!(state.searches.lock().unwrap().is_empty());
    }

    #[test]
    fn cancellation_is_scoped_and_old_cleanup_cannot_remove_a_new_registration() {
        let state = NoteSearchState::default();
        state.prepare("first".into()).unwrap();
        state.prepare("second".into()).unwrap();
        let first = state.claim("first".into()).unwrap();
        let second = state.claim("second".into()).unwrap();
        assert!(state.claim("second".into()).is_err());
        state.cancel("first");
        assert!(check_search_cancelled(&first.cancelled).is_err());
        assert!(check_search_cancelled(&second.cancelled).is_ok());
        state.prepare("first".into()).unwrap();
        drop(first);
        let next = state.claim("first".into()).unwrap();
        assert!(check_search_cancelled(&next.cancelled).is_ok());
        drop(next);
        drop(second);
        assert!(state.searches.lock().unwrap().is_empty());
    }

    #[test]
    fn cancelled_scan_exits_before_touching_the_directory_or_matching_lines() {
        let cancelled = AtomicBool::new(true);
        assert!(matches!(
            search_notes_inner("missing-directory".into(), "query".into(), &cancelled),
            Err(e) if e == SEARCH_CANCELLED
        ));
        assert!(matches!(
            scan_file("note.md", "note.md", "query", &["query".into()], false, &mut String::new(), &cancelled),
            Err(e) if e == SEARCH_CANCELLED
        ));
    }

    #[test]
    fn cancellation_during_a_read_prevents_the_next_chunk() {
        struct CancellingReader<'a> {
            cancelled: &'a AtomicBool,
            reads: usize,
        }
        impl Read for CancellingReader<'_> {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                self.reads += 1;
                buf.fill(b'x');
                self.cancelled.store(true, Ordering::Release);
                Ok(buf.len())
            }
        }
        let cancelled = AtomicBool::new(false);
        let mut reader = CancellingReader {
            cancelled: &cancelled,
            reads: 0,
        };
        assert_eq!(
            read_search_bytes(&mut reader, &cancelled).unwrap_err(),
            SEARCH_CANCELLED
        );
        assert_eq!(reader.reads, 1);
    }

    #[test]
    fn growing_file_is_still_bounded_and_successful_read_preserves_bytes() {
        let cancelled = AtomicBool::new(false);
        let bytes = "笔记正文\n".repeat(10_000).into_bytes();
        assert_eq!(
            read_search_bytes(&mut bytes.as_slice(), &cancelled).unwrap(),
            Some(bytes)
        );
        assert!(read_search_bytes(&mut std::io::repeat(b'x'), &cancelled)
            .unwrap()
            .is_none());
    }
}
