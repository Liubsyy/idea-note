// Fenced-code-block execution (the right panel's "运行输出" view).
//
// One run is one short-lived child process. The block's source is written into
// a private temp dir and handed to the interpreter as a file argument — never
// through `sh -c`, so nothing inside a note can be reinterpreted as shell
// syntax. Two reader threads stream the child's output to the frontend as
// `code:data:{id}` events; a watchdog kills it past its timeout. However the
// process ends, the exit is reported exactly once as `code:exit:{id}`.
//
// The language table lives in the frontend (src/lib/codeRun/runners.ts): this
// module only ever receives an already-resolved command, so the runner config
// has a single home.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use encoding_rs::{Decoder, UTF_8};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tempfile::TempDir;

use crate::proc;

/// How often the supervisor/watchdog threads re-check a running child.
const POLL: Duration = Duration::from_millis(60);

/// `cmd.exe` is much less forgiving than the other interpreters here: Markdown
/// source uses LF internally, while batch files need Windows line endings to
/// avoid consuming characters from the following line. Switch the isolated
/// child console to UTF-8 as well, so batch blocks can contain and print the
/// same Unicode text as their note.
fn snippet_contents(ext: &str, code: &str) -> String {
    if !ext.eq_ignore_ascii_case(".bat") && !ext.eq_ignore_ascii_case(".cmd") {
        return code.to_string();
    }
    let normalized = code.replace("\r\n", "\n").replace('\r', "\n");
    format!("@chcp 65001 >nul\r\n{}", normalized.replace('\n', "\r\n"))
}

struct RunSession {
    child: Arc<Mutex<Child>>,
    /// Deleted when the session is dropped, i.e. once the child has exited.
    _dir: TempDir,
    killed: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct CodeRunState {
    runs: Mutex<HashMap<u64, RunSession>>,
}

#[derive(Clone, Serialize)]
struct DataPayload {
    stream: &'static str,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    code: Option<i32>,
    timed_out: bool,
    killed: bool,
    truncated: bool,
    ms: u64,
}

/// Pick one decoder for a whole stream from its first chunk: strict UTF-8
/// unless the bytes are definitely not UTF-8 (a *truncated* trailing sequence
/// isn't — the incremental decoder stitches it to the next chunk). Legacy
/// consoles are the real case here: Python and cmd on zh-CN Windows emit GBK.
fn pick_decoder(first: &[u8]) -> Decoder {
    if let Err(err) = std::str::from_utf8(first) {
        if err.error_len().is_some() {
            let mut detector = chardetng::EncodingDetector::new();
            detector.feed(first, false);
            return detector.guess(None, true).new_decoder();
        }
    }
    UTF_8.new_decoder()
}

/// Decode one chunk, carrying any split multibyte sequence into the next call.
fn decode_chunk(decoder: &mut Decoder, bytes: &[u8], last: bool) -> String {
    let mut out = String::with_capacity(bytes.len() + 8);
    let mut read_total = 0usize;
    loop {
        let (result, read, _) = decoder.decode_to_string(&bytes[read_total..], &mut out, last);
        read_total += read;
        match result {
            encoding_rs::CoderResult::InputEmpty => return out,
            encoding_rs::CoderResult::OutputFull => out.reserve(1024),
        }
    }
}

/// Stream one pipe to the webview until it closes. `budget` is the run's shared
/// remaining output allowance: past it the pipe is still drained (so the child
/// never blocks on a full buffer) but nothing more is emitted.
fn spawn_reader(
    app: AppHandle,
    event: String,
    stream: &'static str,
    mut source: Box<dyn Read + Send>,
    budget: Arc<AtomicU64>,
    truncated: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut decoder: Option<Decoder> = None;
        loop {
            let n = match source.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let decoder = decoder.get_or_insert_with(|| pick_decoder(&buf[..n]));
            let text = decode_chunk(decoder, &buf[..n], false);
            if text.is_empty() {
                continue;
            }
            emit_text(&app, &event, stream, text, &budget, &truncated);
        }
        // Flush whatever the decoder was still holding on to.
        if let Some(mut decoder) = decoder {
            let text = decode_chunk(&mut decoder, &[], true);
            if !text.is_empty() {
                emit_text(&app, &event, stream, text, &budget, &truncated);
            }
        }
    })
}

fn emit_text(
    app: &AppHandle,
    event: &str,
    stream: &'static str,
    text: String,
    budget: &Arc<AtomicU64>,
    truncated: &Arc<AtomicBool>,
) {
    let left = budget.load(Ordering::Relaxed);
    if left == 0 {
        truncated.store(true, Ordering::Relaxed);
        return;
    }
    let len = text.len() as u64;
    let text = if len > left {
        truncated.store(true, Ordering::Relaxed);
        budget.store(0, Ordering::Relaxed);
        // Never cut a character in half.
        let mut cut = left as usize;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text[..cut].to_string()
    } else {
        budget.store(left - len, Ordering::Relaxed);
        text
    };
    if text.is_empty() {
        return;
    }
    let _ = app.emit(event, DataPayload { stream, text });
}

#[tauri::command]
pub fn code_run_start(
    app: AppHandle,
    state: State<CodeRunState>,
    id: u64,
    command: String,
    args: Vec<String>,
    ext: String,
    code: String,
    cwd: Option<String>,
    env: HashMap<String, String>,
    timeout_ms: u64,
    max_bytes: u64,
) -> Result<(), String> {
    if state.runs.lock().unwrap().contains_key(&id) {
        return Err("该代码块已在运行".to_string());
    }

    let dir = tempfile::Builder::new()
        .prefix("idea-note-run-")
        .tempdir()
        .map_err(|e| format!("无法创建临时目录：{e}"))?;
    let snippet = dir.path().join(format!("snippet{ext}"));
    std::fs::write(&snippet, snippet_contents(&ext, &code))
        .map_err(|e| format!("无法写入临时文件：{e}"))?;

    let mut cmd = proc::command(&command);
    cmd.args(&args).arg(&snippet);
    if let Some(dir) = cwd.filter(|d| Path::new(d).is_dir()) {
        cmd.current_dir(dir);
    }
    for (key, value) in env {
        cmd.env(key, value);
    }
    // No stdin: a note isn't an interactive session, so `input()` gets EOF
    // straight away instead of hanging until the timeout. The frontend turns
    // that into a "试试在终端运行" hint.
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let started = Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 {command}：{e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let killed = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));
    let truncated = Arc::new(AtomicBool::new(false));
    let budget = Arc::new(AtomicU64::new(max_bytes));
    let done = Arc::new(AtomicBool::new(false));
    let child = Arc::new(Mutex::new(child));

    let mut readers = Vec::new();
    if let Some(stdout) = stdout {
        readers.push(spawn_reader(
            app.clone(),
            format!("code:data:{id}"),
            "stdout",
            Box::new(stdout),
            budget.clone(),
            truncated.clone(),
        ));
    }
    if let Some(stderr) = stderr {
        readers.push(spawn_reader(
            app.clone(),
            format!("code:data:{id}"),
            "stderr",
            Box::new(stderr),
            budget.clone(),
            truncated.clone(),
        ));
    }

    // Registered before the supervisor starts: a snippet that exits instantly
    // must not have its session inserted after the supervisor already tried to
    // remove it, or the temp dir would live until the app quits.
    state.runs.lock().unwrap().insert(
        id,
        RunSession {
            child: child.clone(),
            _dir: dir,
            killed,
        },
    );

    // Watchdog: kill on timeout. Killing closes the pipes, so the readers hit
    // EOF and the supervisor below reports the exit as usual. `timeout_ms == 0`
    // means "no limit".
    if timeout_ms > 0 {
        let child = child.clone();
        let done = done.clone();
        let timed_out = timed_out.clone();
        thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_millis(timeout_ms);
            while !done.load(Ordering::Relaxed) {
                if Instant::now() >= deadline {
                    timed_out.store(true, Ordering::Relaxed);
                    let _ = child.lock().unwrap().kill();
                    return;
                }
                thread::sleep(POLL);
            }
        });
    }

    // Supervisor: wait for both pipes to drain *before* reporting the exit, so
    // no output can land after the "finished" event. `try_wait` in a loop
    // rather than `wait` — the lock has to stay free for stop/timeout kills.
    let supervisor_app = app.clone();
    thread::spawn(move || {
        for reader in readers {
            let _ = reader.join();
        }
        let code = loop {
            match child.lock().unwrap().try_wait() {
                Ok(Some(status)) => break status.code(),
                Err(_) => break None,
                Ok(None) => {}
            }
            thread::sleep(POLL);
        };
        done.store(true, Ordering::Relaxed);
        // Dropping the session deletes the temp dir.
        let killed = supervisor_app
            .state::<CodeRunState>()
            .runs
            .lock()
            .unwrap()
            .remove(&id)
            .is_some_and(|session| session.killed.load(Ordering::Relaxed));
        let _ = supervisor_app.emit(
            &format!("code:exit:{id}"),
            ExitPayload {
                code,
                timed_out: timed_out.load(Ordering::Relaxed),
                killed,
                truncated: truncated.load(Ordering::Relaxed),
                ms: started.elapsed().as_millis() as u64,
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub fn code_run_stop(state: State<CodeRunState>, id: u64) -> Result<(), String> {
    if let Some(session) = state.runs.lock().unwrap().get(&id) {
        session.killed.store(true, Ordering::Relaxed);
        let _ = session.child.lock().unwrap().kill();
    }
    Ok(())
}

/// Write a snippet the *terminal* will run, and hand back its path.
///
/// "在终端运行" can't reuse the run pipeline: the point is to get a real TTY
/// and a real stdin, which only the pty gives. A shell can't be fed Python
/// source either, so the block is written to a stable per-extension file under
/// the app cache dir and the terminal is sent `<interpreter> <path>`. One file
/// per extension, overwritten each time: nothing accumulates.
#[tauri::command]
pub fn code_run_snippet_path(app: AppHandle, ext: String, code: String) -> Result<String, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("terminal-snippets");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建临时目录：{e}"))?;
    let path = dir.join(format!("snippet{ext}"));
    std::fs::write(&path, snippet_contents(&ext, &code))
        .map_err(|e| format!("无法写入临时文件：{e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::snippet_contents;

    #[test]
    fn only_batch_snippets_get_windows_line_endings_and_utf8_setup() {
        assert_eq!(
            snippet_contents(".bat", "@echo off\necho 测试\n"),
            "@chcp 65001 >nul\r\n@echo off\r\necho 测试\r\n"
        );
        assert_eq!(
            snippet_contents(".py", "print('测试')\n"),
            "print('测试')\n"
        );
    }

    #[cfg(windows)]
    #[test]
    fn prepared_batch_snippet_runs_through_cmd() {
        let dir = tempfile::Builder::new()
            .prefix("idea note batch test ")
            .tempdir()
            .unwrap();
        let path = dir.path().join("snippet.bat");
        let code = "@echo off\nset /a total=0\nfor /l %%n in (1,1,10) do set /a total+=%%n\necho Batch: OK\necho 1 到 10 的和：%total%\n";
        std::fs::write(&path, snippet_contents(".bat", code)).unwrap();

        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C"])
            .arg(&path)
            .output()
            .unwrap();

        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(stdout.contains("Batch: OK"));
        assert!(stdout.contains("1 到 10 的和：55"));
    }
}
