// Raw git invocation. All orchestration (sync/attach/history) lives in the
// frontend's src/lib/git.ts; this side only locates the binary and runs it.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::async_runtime::RwLock as AsyncRwLock;

/// Result of one git invocation. A non-zero exit code is a normal business
/// outcome (e.g. merge conflict) — only spawn failures become an `Err`.
#[derive(Serialize)]
pub struct GitOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

#[derive(Deserialize)]
pub struct GitCredential {
    username: String,
    password: String,
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

/// One async read/write lock per repository directory. Read-only history and
/// inspection calls can run together; commands that mutate refs, the index, or
/// the working tree still take the exclusive side so sync/rollback operations
/// do not race each other's `.git/index.lock`.
fn dir_lock(dir: &str) -> Arc<AsyncRwLock<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<AsyncRwLock<()>>>>> = OnceLock::new();
    let key = std::fs::canonicalize(dir)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| dir.to_string());
    LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .entry(key)
        .or_insert_with(|| Arc::new(AsyncRwLock::new(())))
        .clone()
}

#[derive(Clone, Copy)]
enum GitLockMode {
    Read,
    Write,
}

fn git_subcommand(args: &[String]) -> Option<(&str, &[String])> {
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-c" | "--config" | "-C" | "--git-dir" | "--work-tree" | "--namespace" => {
                i += 2;
            }
            "--no-pager" | "--bare" | "--version" | "--help" => {
                i += 1;
            }
            arg if arg.starts_with("--git-dir=")
                || arg.starts_with("--work-tree=")
                || arg.starts_with("--namespace=") =>
            {
                i += 1;
            }
            arg if arg.starts_with('-') => {
                i += 1;
            }
            _ => return Some((&args[i], &args[i + 1..])),
        }
    }
    None
}

fn lock_mode_for_args(args: &[String]) -> GitLockMode {
    let Some((cmd, rest)) = git_subcommand(args) else {
        return GitLockMode::Read;
    };

    match cmd {
        "add" | "am" | "apply" | "bisect" | "checkout" | "cherry-pick" | "clean" | "clone"
        | "commit" | "fetch" | "gc" | "init" | "merge" | "mv" | "pull" | "push" | "rebase"
        | "reset" | "restore" | "revert" | "rm" | "stash" | "switch" | "tag" | "worktree" => {
            GitLockMode::Write
        }
        "branch" => {
            if rest.iter().any(|a| {
                matches!(
                    a.as_str(),
                    "-d" | "-D"
                        | "-m"
                        | "-M"
                        | "-c"
                        | "-C"
                        | "--delete"
                        | "--move"
                        | "--copy"
                        | "--set-upstream-to"
                        | "--unset-upstream"
                )
            }) {
                GitLockMode::Write
            } else {
                GitLockMode::Read
            }
        }
        "config" => {
            if rest.iter().any(|a| {
                matches!(
                    a.as_str(),
                    "--unset"
                        | "--unset-all"
                        | "--rename-section"
                        | "--remove-section"
                        | "--add"
                        | "--replace-all"
                )
            }) || rest.len() >= 2
            {
                GitLockMode::Write
            } else {
                GitLockMode::Read
            }
        }
        "remote" => {
            if matches!(
                rest.first().map(String::as_str),
                Some("add" | "remove" | "rm" | "rename" | "set-url" | "set-branches" | "set-head")
            ) {
                GitLockMode::Write
            } else {
                GitLockMode::Read
            }
        }
        "symbolic-ref" => {
            if rest.iter().any(|a| a == "--delete")
                || rest.iter().filter(|a| !a.starts_with('-')).count() > 1
            {
                GitLockMode::Write
            } else {
                GitLockMode::Read
            }
        }
        "update-index" | "update-ref" => GitLockMode::Write,
        _ => GitLockMode::Read,
    }
}

/// Run a git command in `dir`. Token login uses a temporary askpass helper.
///
/// Async + spawn_blocking: sync commands run on the main thread, and a network
/// fetch there freezes the whole UI for its duration. SSH gets a connect
/// timeout and HTTP a low-speed abort so a dead network errors out in ~10-30s
/// instead of hanging.
fn askpass_script() -> Result<tempfile::NamedTempFile, String> {
    #[cfg(target_os = "windows")]
    let mut file = tempfile::Builder::new()
        .prefix("idea-note-askpass-")
        .suffix(".cmd")
        .tempfile()
        .map_err(|e| format!("创建 git 凭据助手失败: {e}"))?;

    #[cfg(not(target_os = "windows"))]
    let mut file = tempfile::Builder::new()
        .prefix("idea-note-askpass-")
        .tempfile()
        .map_err(|e| format!("创建 git 凭据助手失败: {e}"))?;

    #[cfg(target_os = "windows")]
    file.write_all(
        br#"@echo off
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if ($args[0] -match 'Username') { [Console]::WriteLine($env:IDEA_NOTE_GIT_USERNAME) } else { [Console]::WriteLine($env:IDEA_NOTE_GIT_PASSWORD) }" -- %*
"#,
    )
    .map_err(|e| format!("写入 git 凭据助手失败: {e}"))?;

    #[cfg(not(target_os = "windows"))]
    {
        file.write_all(
            br#"#!/bin/sh
case "$1" in
  *Username*|*username*) printf '%s\n' "$IDEA_NOTE_GIT_USERNAME" ;;
  *) printf '%s\n' "$IDEA_NOTE_GIT_PASSWORD" ;;
esac
"#,
        )
        .map_err(|e| format!("写入 git 凭据助手失败: {e}"))?;
        use std::os::unix::fs::PermissionsExt;
        let mut perms = file
            .as_file()
            .metadata()
            .map_err(|e| format!("读取 git 凭据助手权限失败: {e}"))?
            .permissions();
        perms.set_mode(0o700);
        file.as_file()
            .set_permissions(perms)
            .map_err(|e| format!("设置 git 凭据助手权限失败: {e}"))?;
    }

    Ok(file)
}

fn command_output_with_timeout(
    mut cmd: Command,
    timeout: Duration,
    timeout_message: &str,
) -> Result<GitOutput, String> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git 执行失败: {e}"))?;

    // Drain both pipes on background threads while polling for exit. Without
    // this, output beyond the OS pipe buffer blocks git's writes and it never
    // exits — try_wait spins until the timeout kills a perfectly healthy
    // process (this is exactly what `Command::output()` does internally).
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "git 执行失败: 无法读取 stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "git 执行失败: 无法读取 stderr".to_string())?;
    let stdout_reader = std::thread::spawn(move || read_pipe(stdout));
    let stderr_reader = std::thread::spawn(move || read_pipe(stderr));

    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| format!("git 执行失败: {e}"))? {
            break status;
        }

        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            // Killing the child closes the pipes, so the readers finish promptly.
            let _ = stdout_reader.join();
            let stderr = stderr_reader
                .join()
                .map_err(|_| ())
                .and_then(|r| r.map_err(|_| ()))
                .unwrap_or_default();
            let stderr = String::from_utf8_lossy(&stderr);
            let stderr = stderr.trim();
            return Ok(GitOutput {
                code: -1,
                stdout: String::new(),
                stderr: if stderr.is_empty() {
                    timeout_message.to_string()
                } else {
                    format!("{timeout_message}\n{stderr}")
                },
            });
        }

        std::thread::sleep(Duration::from_millis(200));
    };

    let stdout = stdout_reader
        .join()
        .map_err(|_| "git 执行失败: stdout 读取线程异常退出".to_string())??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "git 执行失败: stderr 读取线程异常退出".to_string())??;

    Ok(GitOutput {
        code: status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
    })
}

fn read_pipe<R: Read>(mut pipe: R) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    pipe.read_to_end(&mut buf)
        .map_err(|e| format!("git 执行失败: {e}"))?;
    Ok(buf)
}

fn run_git_blocking(
    dir: String,
    args: Vec<String>,
    credential: Option<GitCredential>,
) -> Result<GitOutput, String> {
    if !Path::new(&dir).is_dir() {
        return Err(format!("目录不存在: {dir}"));
    }
    let git = git_binary()?;

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

    let askpass = if credential.is_some() {
        Some(askpass_script()?)
    } else {
        None
    };

    let mut cmd = crate::proc::command(&git);
    cmd.args(&args)
        .current_dir(&dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", SSH_COMMAND)
        .env("GIT_HTTP_LOW_SPEED_LIMIT", "1")
        .env("GIT_HTTP_LOW_SPEED_TIME", "30");

    if let (Some(credential), Some(askpass)) = (&credential, &askpass) {
        cmd.env("GIT_ASKPASS", askpass.path())
            .env("IDEA_NOTE_GIT_USERNAME", &credential.username)
            .env("IDEA_NOTE_GIT_PASSWORD", &credential.password);
    } else {
        cmd.env("GIT_ASKPASS", "");
    }

    command_output_with_timeout(
        cmd,
        Duration::from_secs(120),
        "git 操作超时，请检查网络或远程仓库认证状态",
    )
}

async fn git_run_inner(
    dir: String,
    args: Vec<String>,
    credential: Option<GitCredential>,
) -> Result<GitOutput, String> {
    if !Path::new(&dir).is_dir() {
        return Err(format!("目录不存在: {dir}"));
    }
    // Read-only history/inspection commands share the repo lock. Commands that
    // mutate refs, the index, or the working tree still run exclusively.
    let lock = dir_lock(&dir);
    match lock_mode_for_args(&args) {
        GitLockMode::Read => {
            let _guard = lock.read().await;
            tauri::async_runtime::spawn_blocking(move || run_git_blocking(dir, args, credential))
                .await
                .map_err(|e| format!("git 执行失败: {e}"))?
        }
        GitLockMode::Write => {
            let _guard = lock.write().await;
            tauri::async_runtime::spawn_blocking(move || run_git_blocking(dir, args, credential))
                .await
                .map_err(|e| format!("git 执行失败: {e}"))?
        }
    }
}

#[tauri::command]
pub async fn git_run(dir: String, args: Vec<String>) -> Result<GitOutput, String> {
    git_run_inner(dir, args, None).await
}

#[tauri::command]
pub async fn git_run_with_credential(
    dir: String,
    args: Vec<String>,
    credential: GitCredential,
) -> Result<GitOutput, String> {
    git_run_inner(dir, args, Some(credential)).await
}

#[tauri::command]
pub async fn git_credential_approve(
    dir: String,
    url: String,
    credential: GitCredential,
) -> Result<(), String> {
    if !Path::new(&dir).is_dir() {
        return Err(format!("目录不存在: {dir}"));
    }
    let git = git_binary()?;
    let lock = dir_lock(&dir);
    let _guard = lock.write().await;

    tauri::async_runtime::spawn_blocking(move || {
        let mut child = crate::proc::command(&git)
            .arg("credential")
            .arg("approve")
            .current_dir(&dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("git 凭据保存失败: {e}"))?;

        if let Some(stdin) = child.stdin.as_mut() {
            write!(
                stdin,
                "url={}\nusername={}\npassword={}\n\n",
                url, credential.username, credential.password
            )
            .map_err(|e| format!("git 凭据保存失败: {e}"))?;
        }

        let output = child
            .wait_with_output()
            .map_err(|e| format!("git 凭据保存失败: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if stderr.is_empty() {
                "git 凭据保存失败".to_string()
            } else {
                format!("git 凭据保存失败: {stderr}")
            })
        }
    })
    .await
    .map_err(|e| format!("git 凭据保存失败: {e}"))?
}
