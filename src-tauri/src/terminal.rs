// Integrated terminal (bottom panel).
//
// One PTY session backs each bottom-panel terminal tab. A reader thread
// streams the shell's output to the frontend as `term:data:{id}` events (raw
// bytes, so multibyte UTF-8 and control sequences survive); the frontend
// writes keystrokes back via `term_write`. The xterm.js widget lives in the
// webview.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use std::thread;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalState {
    // Multiple terminals (tabs) keyed by a frontend-generated id. Each streams
    // on its own `term:data:{id}` / `term:exit:{id}` event.
    sessions: Mutex<HashMap<u32, TerminalSession>>,
}

/// The user's login shell. Windows has no SHELL env var (and no /bin/zsh):
/// PowerShell ships with every supported Windows, so prefer it and keep
/// COMSPEC (cmd.exe) as the last resort.
fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        if which_in_path("powershell.exe") {
            return "powershell.exe".to_string();
        }
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else {
                "/bin/sh".to_string()
            }
        })
    }
}

/// Whether `exe` resolves through PATH (portable-pty resolves the same way).
#[cfg(target_os = "windows")]
fn which_in_path(exe: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(exe).is_file()))
}

#[tauri::command]
pub fn term_open(
    app: AppHandle,
    state: State<TerminalState>,
    id: u32,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if sessions.contains_key(&id) {
        return Ok(()); // already running
    }

    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(default_shell());
    if let Some(dir) = cwd.filter(|d| Path::new(d).is_dir()) {
        cmd.cwd(dir);
    }
    #[cfg(not(target_os = "windows"))]
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Stream this terminal's output to the webview until its pty closes.
    let app_handle = app.clone();
    let data_event = format!("term:data:{id}");
    let exit_event = format!("term:exit:{id}");
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app_handle.emit(&data_event, buf[..n].to_vec());
                }
            }
        }
        let _ = app_handle.emit(&exit_event, ());
    });

    sessions.insert(
        id,
        TerminalSession {
            master: pair.master,
            writer,
            child,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn term_write(state: State<TerminalState>, id: u32, data: String) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().unwrap().get_mut(&id) {
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn term_resize(
    state: State<TerminalState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().unwrap().get(&id) {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn term_close(state: State<TerminalState>, id: u32) -> Result<(), String> {
    if let Some(mut session) = state.sessions.lock().unwrap().remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}
