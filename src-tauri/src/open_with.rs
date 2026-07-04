// Files handed to the app by the OS "Open With" / file-association launch.
//
// macOS delivers these as `RunEvent::Opened` Apple events. The tricky part is a
// cold start: the configured window is created during `build()`, so it already
// exists when the launch `Opened` event fires — but the frontend JS hasn't
// attached its "open-files" listener yet, so emitting then would be lost.
//
// To bridge that, paths are queued here until the frontend drains them on
// startup (`take_pending_open_files`), which flips `ready`. After that, opens
// are delivered live via the "open-files" event (see lib.rs). The single mutex
// makes the queue/ready hand-off atomic against a concurrent drain.

use std::path::Path;
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
struct PendingState {
    queue: Vec<String>,
    ready: bool,
}

#[derive(Default)]
pub struct PendingOpenFiles(Mutex<PendingState>);

impl PendingOpenFiles {
    /// Queue cold-start paths if the frontend hasn't drained yet. Returns true
    /// when queued; false means the frontend is ready and the caller should
    /// emit the live "open-files" event instead.
    pub fn queue_if_not_ready(&self, paths: &[String]) -> bool {
        let mut state = self.0.lock().unwrap();
        if state.ready {
            return false;
        }
        state.queue.extend_from_slice(paths);
        true
    }
}

/// Drain and return any files the app was launched to open, marking the
/// frontend ready so later opens are delivered live. Called once by the main
/// window when it mounts.
#[tauri::command]
pub fn take_pending_open_files(state: State<'_, PendingOpenFiles>) -> Vec<String> {
    let mut state = state.0.lock().unwrap();
    state.ready = true;
    std::mem::take(&mut state.queue)
}

/// Extract openable file paths from a process argv. On Windows and Linux an
/// "Open With" launch passes file paths as command-line arguments (the running
/// instance receives a second process's argv via the single-instance plugin),
/// so we skip the executable (argv[0]) and any flags, resolve relatives against
/// `cwd`, and keep only entries that are actually existing files.
pub fn file_paths_from_args(args: &[String], cwd: &str) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter_map(|arg| {
            let path = Path::new(arg);
            let abs = if path.is_absolute() {
                path.to_path_buf()
            } else {
                Path::new(cwd).join(path)
            };
            abs.is_file().then(|| abs.to_string_lossy().into_owned())
        })
        .collect()
}
