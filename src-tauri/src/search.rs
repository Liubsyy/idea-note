// Sidebar global search (search mode UI). Deliberately independent from the
// AI-tool search in tree.rs — the two are tuned differently and evolve
// separately.
//
// Two entry points share one scan core via the `Sink` trait:
//   - `global_search`        — synchronous, collects everything, used by tests.
//   - `global_search_stream` — streams hits in small batches over a `Channel` so
//     the UI fills in progressively instead of blocking on the full walk.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use regex::{Regex, RegexBuilder};
use serde::Serialize;
use tauri::ipc::Channel;

/// One global-search match. Filename matches have `line: None` and carry the
/// match span within `name`; content matches carry a 1-based line number plus
/// the match span within `snippet`.
#[derive(Serialize)]
pub struct GlobalSearchHit {
    path: String,
    name: String,
    line: Option<u32>,
    snippet: Option<String>,
    /// Char offset of the match within the displayed text (snippet for content
    /// hits, name for filename hits).
    match_start: u32,
    /// Char length of the matched text (varies under regex).
    match_len: u32,
    /// The exact substring that matched, for re-locating it in the live editor
    /// document when jumping (the snippet may be trimmed/elided).
    matched_text: String,
}

#[derive(Serialize)]
pub struct GlobalSearchResult {
    hits: Vec<GlobalSearchHit>,
    /// Kept for the frontend contract. Backend searches no longer auto-cap;
    /// the sidebar marks incomplete results when the user stops a search.
    truncated: bool,
    /// Set when regex mode was on but the pattern failed to compile; the UI
    /// shows this instead of an empty "no results".
    regex_error: Option<String>,
}

/// Context kept before the match when a long line is cut down to a snippet.
const SNIPPET_CONTEXT_CHARS: usize = 24;
const SNIPPET_MAX_CHARS: usize = 120;
/// Keep IPC payloads small enough that the WebView can process input (notably
/// the Stop button) while a very common term streams thousands of hits.
const STREAM_HIT_BATCH_SIZE: usize = 200;
/// Content-heavy generated/dependency folders are still searchable, but their
/// contents should not delay results from ordinary note folders.
const DEFERRED_CONTENT_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "out",
    "target",
    "coverage",
    ".next",
    ".nuxt",
    ".vite",
];

/// Entries skipped entirely: VCS internals and macOS metadata (same set the
/// file tree hides).
fn is_excluded(name: &str) -> bool {
    matches!(name, ".git" | ".svn" | ".hg" | ".DS_Store")
}

fn is_deferred_content_dir(name: &str) -> bool {
    DEFERRED_CONTENT_DIRS.iter().any(|dir| name == *dir)
}

/// Compiled query honoring the three input toggles. A plain query is escaped
/// to a literal; whole-word wraps it in `\b…\b`; case sensitivity flips a
/// builder flag. Regex mode passes the query through verbatim.
struct Matcher {
    re: Regex,
}

impl Matcher {
    fn build(
        query: &str,
        case_sensitive: bool,
        whole_word: bool,
        regex_mode: bool,
    ) -> Result<Matcher, String> {
        let base = if regex_mode {
            query.to_string()
        } else {
            regex::escape(query)
        };
        let pattern = if whole_word {
            format!(r"\b(?:{base})\b")
        } else {
            base
        };
        let re = RegexBuilder::new(&pattern)
            .case_insensitive(!case_sensitive)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Matcher { re })
    }

    /// First non-empty match in `text`: its char offset, char length, and the
    /// matched substring. Empty matches (e.g. `a*` matching nothing) are
    /// skipped — they carry no useful highlight.
    fn find<'a>(&self, text: &'a str) -> Option<(usize, usize, &'a str)> {
        let m = self.re.find(text)?;
        if m.start() == m.end() {
            return None;
        }
        let char_offset = text[..m.start()].chars().count();
        let matched = m.as_str();
        Some((char_offset, matched.chars().count(), matched))
    }
}

/// Cut `line` (already trimmed) down around a match at char offset
/// `match_char` so the match stays visible. Returns the snippet and the
/// match's char offset within it.
fn build_snippet(line: &str, match_char: usize) -> (String, usize) {
    let start = match_char.saturating_sub(SNIPPET_CONTEXT_CHARS);
    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    snippet.extend(line.chars().skip(start).take(SNIPPET_MAX_CHARS));
    if line.chars().count() > start + SNIPPET_MAX_CHARS {
        snippet.push('…');
    }
    let offset = match_char - start + usize::from(start > 0);
    (snippet, offset)
}

/// Where scan results go. Decouples the tree walk from "collect into a Vec"
/// (sync command) vs. "stream over a channel" (streaming command). Hits are
/// pushed as found; `flush_file` lets streaming sinks emit buffered hits at
/// useful boundaries. `cancelled` lets a sink abandon a walk
/// that's been superseded or manually stopped.
trait Sink {
    fn push(&mut self, hit: GlobalSearchHit);
    /// Called after each file and between scan phases.
    fn flush_file(&mut self);
    /// True once this search has been superseded; the walk should stop.
    fn cancelled(&self) -> bool {
        false
    }
}

impl Sink for GlobalSearchResult {
    fn push(&mut self, hit: GlobalSearchHit) {
        self.hits.push(hit);
    }
    fn flush_file(&mut self) {}
}

/// Scan one file's content.
fn search_file<S: Sink>(path_str: &str, name: &str, matcher: &Matcher, out: &mut S) {
    // Text files only (binaries skip); legacy charsets like GBK are decoded.
    let Some(content) = fs::read(path_str)
        .ok()
        .and_then(crate::encoding::decode_text)
    else {
        return;
    };
    for (i, raw_line) in content.lines().enumerate() {
        if out.cancelled() {
            return;
        }
        let line = raw_line.trim();
        let Some((match_char, char_len, matched)) = matcher.find(line) else {
            continue;
        };
        let matched_text = matched.to_string();
        let (snippet, offset) = build_snippet(line, match_char);
        out.push(GlobalSearchHit {
            path: path_str.to_string(),
            name: name.to_string(),
            line: Some((i + 1) as u32),
            snippet: Some(snippet),
            match_start: offset as u32,
            match_len: char_len as u32,
            matched_text,
        });
    }
}

/// Recursive filename-only pass. Emits a hit for every entry whose name
/// matches and never reads file contents, so it's cheap. Run first (see
/// [`search_dir`]) so filename matches surface before any content hits.
fn scan_names<S: Sink>(dir: &Path, matcher: &Matcher, out: &mut S) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.cancelled() {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if is_excluded(&name) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            scan_names(&path, matcher, out);
            continue;
        }
        if let Some((match_char, char_len, matched)) = matcher.find(&name) {
            let matched_text = matched.to_string();
            out.push(GlobalSearchHit {
                path: path.to_string_lossy().to_string(),
                name,
                line: None,
                snippet: None,
                match_start: match_char as u32,
                match_len: char_len as u32,
                matched_text,
            });
        }
    }
}

/// Recursive content-only pass. Reads each text file and emits line hits.
/// When `defer_generated_dirs` is true, generated/dependency folders are
/// collected instead of entered so the caller can scan them after the normal
/// workspace tree has finished.
fn scan_contents_inner<S: Sink>(
    dir: &Path,
    matcher: &Matcher,
    out: &mut S,
    deferred: &mut Vec<PathBuf>,
    defer_generated_dirs: bool,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.cancelled() {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if is_excluded(&name) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            if defer_generated_dirs && is_deferred_content_dir(&name) {
                deferred.push(path);
            } else {
                scan_contents_inner(&path, matcher, out, deferred, defer_generated_dirs);
            }
            continue;
        }
        let path_str = path.to_string_lossy().to_string();
        search_file(&path_str, &name, matcher, out);
        // File done: let a streaming sink emit any buffered hits now.
        out.flush_file();
    }
}

/// Content scan order: ordinary workspace files first, then known generated or
/// dependency folders such as `node_modules` and `dist`. Filename scanning is a
/// separate earlier pass and intentionally ignores this delay.
fn scan_contents<S: Sink>(dir: &Path, matcher: &Matcher, out: &mut S) {
    let mut deferred = Vec::new();
    scan_contents_inner(dir, matcher, out, &mut deferred, true);
    let mut i = 0;
    while i < deferred.len() {
        if out.cancelled() {
            return;
        }
        let path = deferred[i].clone();
        scan_contents_inner(&path, matcher, out, &mut deferred, true);
        i += 1;
    }
}

/// Full scan: filenames first, then contents. Unreadable directories are
/// skipped rather than failing the whole search; once cancelled, further work
/// is pointless. Splitting the walk into two passes
/// guarantees filename matches are emitted before any content
/// hit, so they always surface even in large workspaces.
fn search_dir<S: Sink>(dir: &Path, matcher: &Matcher, out: &mut S) {
    scan_names(dir, matcher, out);
    out.flush_file();
    scan_contents(dir, matcher, out);
}

/// Prepare a [`Matcher`] from the raw query + toggles, or report why not.
/// Returns `Ok(None)` for an empty query (caller should emit no results), and
/// `Err` carrying a regex-compile message.
fn prepare(
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
) -> Result<Option<Matcher>, String> {
    // Trim only gates emptiness; regex patterns keep their original spacing.
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let pattern_src = if regex { query } else { trimmed };
    Matcher::build(pattern_src, case_sensitive, whole_word, regex).map(Some)
}

/// Workspace-wide search over filenames and text-file contents (synchronous;
/// collects everything before returning). Retained for unit tests and any
/// non-streaming caller. The streaming UI uses `global_search_stream`.
#[tauri::command]
pub fn global_search(
    dir: String,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
) -> Result<GlobalSearchResult, String> {
    let mut out = GlobalSearchResult {
        hits: Vec::new(),
        truncated: false,
        regex_error: None,
    };
    let matcher = match prepare(&query, case_sensitive, whole_word, regex) {
        Ok(Some(m)) => m,
        Ok(None) => return Ok(out),
        Err(e) => {
            out.regex_error = Some(e);
            return Ok(out);
        }
    };

    let root = Path::new(&dir);
    if !root.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    search_dir(root, &matcher, &mut out);
    Ok(out)
}

/// Streamed event sent to the frontend over the IPC channel. `serde` tags it
/// with a `kind` field, so JS gets `{ kind: "hits", hits: [...] }` etc.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SearchEvent {
    /// One batch of matches.
    Hits { hits: Vec<GlobalSearchHit> },
    /// The query failed to compile as a regex.
    RegexError { message: String },
    /// Walk finished. Always the last event for a completed search.
    Done { truncated: bool },
}

/// Monotonic generation for the streaming search. Each new stream bumps it and
/// captures its own value; an in-flight walk whose generation no longer matches
/// the global one knows it has been superseded and bails (cooperative cancel).
static STREAM_GEN: AtomicU64 = AtomicU64::new(0);

/// Streaming sink: buffers hits, then ships them as a `Hits` event
/// on `flush_file`. Watches the generation counter so a stale or manually
/// stopped walk exits early.
struct ChannelSink {
    channel: Channel<SearchEvent>,
    generation: u64,
    buffer: Vec<GlobalSearchHit>,
}

impl ChannelSink {
    fn new(channel: Channel<SearchEvent>, generation: u64) -> Self {
        ChannelSink {
            channel,
            generation,
            buffer: Vec::new(),
        }
    }

    /// Emit any remaining buffered hits, then the terminal `Done` event.
    fn finish(mut self) {
        self.flush_file();
        if !self.cancelled() {
            let _ = self.channel.send(SearchEvent::Done { truncated: false });
        }
    }
}

impl Sink for ChannelSink {
    fn push(&mut self, hit: GlobalSearchHit) {
        self.buffer.push(hit);
        if self.buffer.len() >= STREAM_HIT_BATCH_SIZE {
            self.flush_file();
        }
    }

    fn flush_file(&mut self) {
        if self.buffer.is_empty() || self.cancelled() {
            self.buffer.clear();
            return;
        }
        let hits = std::mem::take(&mut self.buffer);
        let batch_len = hits.len();
        let _ = self.channel.send(SearchEvent::Hits { hits });
        if batch_len >= STREAM_HIT_BATCH_SIZE {
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn cancelled(&self) -> bool {
        STREAM_GEN.load(Ordering::SeqCst) != self.generation
    }
}

/// Streaming variant of [`global_search`]: returns immediately and pushes
/// results to `on_event` file-by-file from a background thread, so the sidebar
/// fills in progressively rather than blocking on the whole walk. Starting a
/// new stream supersedes any still-running one.
#[tauri::command]
pub fn global_search_stream(
    dir: String,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
    on_event: Channel<SearchEvent>,
) -> Result<(), String> {
    // Claim a generation; any older in-flight walk now sees a mismatch.
    let generation = STREAM_GEN.fetch_add(1, Ordering::SeqCst) + 1;

    let matcher = match prepare(&query, case_sensitive, whole_word, regex) {
        Ok(Some(m)) => m,
        Ok(None) => {
            let _ = on_event.send(SearchEvent::Done { truncated: false });
            return Ok(());
        }
        Err(e) => {
            let _ = on_event.send(SearchEvent::RegexError { message: e });
            let _ = on_event.send(SearchEvent::Done { truncated: false });
            return Ok(());
        }
    };

    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }

    // Walk off the IPC thread so the command returns at once and the channel
    // streams while the scan runs.
    std::thread::spawn(move || {
        let mut sink = ChannelSink::new(on_event, generation);
        search_dir(&root, &matcher, &mut sink);
        sink.finish();
    });
    Ok(())
}

/// Stop the currently running sidebar global search, if any. This reuses the
/// same generation counter as "new search supersedes old search"; an in-flight
/// walker notices the mismatch and exits cooperatively.
#[tauri::command]
pub fn stop_global_search() {
    STREAM_GEN.fetch_add(1, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(tag: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "idea-note-search-test-{}-{}",
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

    fn run(dir: &Path, query: &str, cs: bool, ww: bool, rx: bool) -> GlobalSearchResult {
        global_search(dir.to_string_lossy().into(), query.into(), cs, ww, rx).unwrap()
    }

    #[test]
    fn finds_filename_and_content_hits() {
        let dir = temp_workspace(
            "basic",
            &[
                ("灵感收集箱.md", "没有关键词的内容"),
                (
                    "notes/产品.md",
                    "# 标题\n记录每天的灵感碎片\n第三行也有灵感",
                ),
            ],
        );
        let out = run(&dir, "灵感", false, false, false);
        assert!(!out.truncated);

        let name_hits: Vec<_> = out.hits.iter().filter(|h| h.line.is_none()).collect();
        assert_eq!(name_hits.len(), 1);
        assert_eq!(name_hits[0].name, "灵感收集箱.md");
        assert_eq!(name_hits[0].match_start, 0);
        assert_eq!(name_hits[0].match_len, 2);

        let content_hits: Vec<_> = out.hits.iter().filter(|h| h.line.is_some()).collect();
        assert_eq!(content_hits.len(), 2);
        let first = content_hits.iter().find(|h| h.line == Some(2)).unwrap();
        let snippet = first.snippet.as_deref().unwrap();
        let offset = first.match_start as usize;
        let marked: String = snippet.chars().skip(offset).take(2).collect();
        assert_eq!(marked, "灵感");
        assert_eq!(first.matched_text, "灵感");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn content_search_scans_generated_dirs_last() {
        let dir = temp_workspace(
            "deferred-content",
            &[
                ("dist/bundle.txt", "目标词 in generated output"),
                ("node_modules/pkg/index.js", "目标词 in dependency"),
                ("notes/today.md", "目标词 in notes"),
                ("src/dist/chunk.js", "目标词 in nested generated output"),
                ("src/keep.md", "目标词 in source"),
            ],
        );
        let out = run(&dir, "目标词", false, false, false);
        let content_hits: Vec<_> = out.hits.iter().filter(|h| h.line.is_some()).collect();
        assert_eq!(content_hits.len(), 5);

        let first_deferred = content_hits
            .iter()
            .position(|h| {
                path_has_component(&h.path, "dist") || path_has_component(&h.path, "node_modules")
            })
            .unwrap();
        assert!(content_hits[..first_deferred].iter().all(|h| {
            !path_has_component(&h.path, "dist") && !path_has_component(&h.path, "node_modules")
        }));
        assert!(content_hits[first_deferred..].iter().all(|h| {
            path_has_component(&h.path, "dist") || path_has_component(&h.path, "node_modules")
        }));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn deferred_dirs_do_not_delay_filename_hits() {
        let dir = temp_workspace(
            "deferred-name",
            &[
                ("dist/目标词.md", "no content match"),
                ("notes/today.md", "目标词 in notes"),
            ],
        );
        let out = run(&dir, "目标词", false, false, false);
        assert_eq!(out.hits.len(), 2);
        assert_eq!(out.hits[0].line, None);
        assert!(path_has_component(&out.hits[0].path, "dist"));
        assert_eq!(out.hits[1].line, Some(1));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn case_sensitivity_toggle() {
        let dir = temp_workspace("case", &[("a.md", "Hello hello HELLO")]);
        // Insensitive: one hit per line (first match).
        let insensitive = run(&dir, "hello", false, false, false);
        assert_eq!(insensitive.hits.len(), 1);
        assert_eq!(insensitive.hits[0].matched_text, "Hello");
        // Sensitive: skips "Hello"/"HELLO", matches the lowercase "hello".
        let sensitive = run(&dir, "hello", true, false, false);
        assert_eq!(sensitive.hits.len(), 1);
        assert_eq!(sensitive.hits[0].matched_text, "hello");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn whole_word_toggle() {
        let dir = temp_workspace("word", &[("a.md", "category cat scattered")]);
        let partial = run(&dir, "cat", false, false, false);
        assert_eq!(partial.hits.len(), 1); // matches "cat" inside "category"
        assert_eq!(partial.hits[0].match_start, 0);
        let whole = run(&dir, "cat", false, true, false);
        assert_eq!(whole.hits.len(), 1);
        // The standalone "cat" sits after "category " (9 chars in).
        assert_eq!(whole.hits[0].match_start, 9);
        assert_eq!(whole.hits[0].matched_text, "cat");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn regex_mode_and_invalid_pattern() {
        let dir = temp_workspace("regex", &[("a.md", "order #1234 and #56")]);
        let out = run(&dir, r"#\d+", false, false, true);
        assert_eq!(out.hits.len(), 1);
        assert_eq!(out.hits[0].matched_text, "#1234");

        // A literal "#\d+" without regex mode finds nothing (escaped).
        let literal = run(&dir, r"#\d+", false, false, false);
        assert!(literal.hits.is_empty());

        let bad = run(&dir, "(unclosed", false, false, true);
        assert!(bad.hits.is_empty());
        assert!(bad.regex_error.is_some());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn content_search_does_not_auto_truncate() {
        let many = "目标词\n".repeat(25);
        let dir = temp_workspace("no-cap", &[("b.md", many.as_str())]);
        let out = run(&dir, "目标词", false, false, false);
        assert_eq!(out.hits.len(), 25);
        assert!(!out.truncated);
        fs::remove_dir_all(dir).ok();
    }

    fn path_has_component(path: &str, component: &str) -> bool {
        Path::new(path)
            .components()
            .any(|c| c.as_os_str().to_string_lossy() == component)
    }
}
