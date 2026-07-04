// Raw git invocation. All orchestration (sync/attach/history) lives in the
// frontend's src/lib/git.ts; this side only locates the binary and runs it.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::async_runtime::Mutex as AsyncMutex;

/// Result of one git invocation. A non-zero exit code is a normal business
/// outcome (e.g. merge conflict) — only spawn failures become an `Err`.
#[derive(Serialize)]
pub struct GitOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

/// Places to look for git besides PATH. GUI apps launched from Finder get a
/// minimal PATH (/usr/bin:/bin); on Windows, Git for Windows may be installed
/// without the "add to PATH" option.
fn git_candidates() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let mut candidates = vec![
            "git".to_string(),
            r"C:\Program Files\Git\cmd\git.exe".to_string(),
            r"C:\Program Files (x86)\Git\cmd\git.exe".to_string(),
        ];
        // Per-user install location of the Git for Windows installer.
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(format!(r"{local}\Programs\Git\cmd\git.exe"));
        }
        candidates
    }
    #[cfg(not(target_os = "windows"))]
    {
        [
            "git",
            "/usr/bin/git",
            "/opt/homebrew/bin/git",
            "/usr/local/bin/git",
        ]
        .map(String::from)
        .to_vec()
    }
}

/// Locate the git binary once.
fn git_binary() -> Result<String, String> {
    static GIT: OnceLock<Option<String>> = OnceLock::new();
    GIT.get_or_init(|| {
        git_candidates().into_iter().find(|bin| {
            crate::proc::command(bin)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        })
    })
    .clone()
    .ok_or_else(|| "git not found".to_string())
}

/// One async lock per repository directory. All windows share this single
/// backend process, so serializing here makes concurrent syncs (auto-sync timer
/// vs. a manual click, or the same repo open in two windows) queue instead of
/// racing each other's `.git/index.lock`. Different repos stay parallel.
fn dir_lock(dir: &str) -> Arc<AsyncMutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>> = OnceLock::new();
    let key = std::fs::canonicalize(dir)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| dir.to_string());
    LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .entry(key)
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

/// Run a git command in `dir`. Credential prompts are disabled so a missing
/// key / helper fails fast with a readable stderr instead of hanging forever.
///
/// Async + spawn_blocking: sync commands run on the main thread, and a network
/// fetch there freezes the whole UI for its duration. SSH gets a connect
/// timeout and HTTP a low-speed abort so a dead network errors out in ~10-30s
/// instead of hanging.
#[tauri::command]
pub async fn git_run(dir: String, args: Vec<String>) -> Result<GitOutput, String> {
    if !Path::new(&dir).is_dir() {
        return Err(format!("目录不存在: {dir}"));
    }
    let git = git_binary()?;
    // Serialize all git calls to this repo (held across the whole invocation,
    // including a network fetch) so no two processes touch the index at once.
    let lock = dir_lock(&dir);
    let _guard = lock.lock().await;
    // BatchMode + ConnectTimeout make a missing key / dead host fail fast
    // instead of hanging. ControlMaster reuses one SSH connection across the
    // fetch and push of a sync (and across close-together syncs), cutting a
    // full handshake round-trip; the master lingers 60s. Windows OpenSSH has
    // no /tmp and doesn't implement connection multiplexing, so it gets the
    // fail-fast options only.
    #[cfg(not(target_os = "windows"))]
    const SSH_COMMAND: &str = "ssh -oBatchMode=yes -oConnectTimeout=10 \
         -oControlMaster=auto -oControlPath=/tmp/idea-note-ssh-%C \
         -oControlPersist=60";
    #[cfg(target_os = "windows")]
    const SSH_COMMAND: &str = "ssh -oBatchMode=yes -oConnectTimeout=10";

    tauri::async_runtime::spawn_blocking(move || {
        let output = crate::proc::command(&git)
            .args(&args)
            .current_dir(&dir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ASKPASS", "")
            .env("GIT_SSH_COMMAND", SSH_COMMAND)
            .env("GIT_HTTP_LOW_SPEED_LIMIT", "1")
            .env("GIT_HTTP_LOW_SPEED_TIME", "30")
            .output()
            .map_err(|e| format!("git 执行失败: {e}"))?;
        Ok(GitOutput {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    })
    .await
    .map_err(|e| format!("git 执行失败: {e}"))?
}
