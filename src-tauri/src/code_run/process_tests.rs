use super::*;
use std::fs;
use std::process::Stdio;
use std::thread;
use std::time::Instant;

fn fixture_command(mode: &str, heartbeat: &std::path::Path) -> Command {
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    // Test names omit the crate name; keep fixture lookup independent of it.
    let module = module_path!().split_once("::").unwrap().1;
    cmd.args([
        "--ignored",
        "--exact",
        &format!("{module}::fixture"),
        "--nocapture",
    ])
    .env("IDEA_NOTE_PROCESS_TEST_MODE", mode)
    .env("IDEA_NOTE_PROCESS_TEST_HEARTBEAT", heartbeat);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// A real three-level process tree. The leaf keeps an inherited output pipe
/// open and ignores Ctrl+C on Unix, exercising forced escalation. Every leaf
/// also self-expires so a failed assertion cannot leave permanent test workers.
#[test]
#[ignore]
fn fixture() {
    let Ok(mode) = std::env::var("IDEA_NOTE_PROCESS_TEST_MODE") else {
        return;
    };
    let heartbeat =
        std::path::PathBuf::from(std::env::var_os("IDEA_NOTE_PROCESS_TEST_HEARTBEAT").unwrap());
    if mode == "bulk" {
        print!("{}", "多字节 output\n".repeat(20_000));
    } else if mode == "leaf" {
        #[cfg(unix)]
        unsafe {
            libc::signal(libc::SIGINT, libc::SIG_IGN);
        }
        fs::write(&heartbeat, "0").unwrap();
        println!("LEAF_READY");
        for count in 1..160 {
            thread::sleep(Duration::from_millis(50));
            if fs::write(&heartbeat, count.to_string()).is_err() {
                break;
            }
        }
    } else {
        let next = if mode == "root" { "middle" } else { "leaf" };
        let mut child = fixture_command(next, &heartbeat).spawn().unwrap();
        if mode != "orphan" {
            child.wait().unwrap();
        }
    }
}

fn start(mode: &str, heartbeat: &std::path::Path) -> (ProcessTree, std::process::ChildStdout) {
    let mut command = fixture_command(mode, heartbeat);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut tree = ProcessTree::spawn(&mut command).unwrap();
    let mut output = tree.child.stdout.take().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut text = String::new();
    let mut buf = [0; 1024];
    while !text.contains("LEAF_READY") {
        assert!(
            Instant::now() < deadline,
            "leaf did not become ready: {text}"
        );
        match read_available(&mut output, &mut buf).unwrap() {
            Some(0) => panic!("fixture exited before becoming ready: {text}"),
            Some(n) => text.push_str(&String::from_utf8_lossy(&buf[..n])),
            None => thread::sleep(POLL),
        }
    }
    (tree, output)
}

fn assert_stopped(tree: &mut ProcessTree, output: &mut dyn RunPipe, heartbeat: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut eof = false;
    let mut exited = false;
    let mut buf = [0; 1024];
    while !eof || !exited {
        assert!(Instant::now() < deadline, "process/pipe survived stop");
        if !eof {
            eof = read_available(output, &mut buf).unwrap() == Some(0);
        }
        exited = tree.try_wait().unwrap().is_some();
        thread::sleep(POLL);
    }
    tree.mark_complete();
    let count = fs::read(heartbeat).unwrap();
    thread::sleep(Duration::from_millis(250));
    assert_eq!(
        fs::read(heartbeat).unwrap(),
        count,
        "leaf still performing work"
    );
}

#[test]
fn manual_stop_kills_grandchildren_and_closes_inherited_pipe() {
    let dir = tempfile::tempdir().unwrap();
    let heartbeat = dir.path().join("heartbeat");
    let (mut tree, mut output) = start("root", &heartbeat);
    tree.stop(StopReason::Manual).unwrap();
    assert_eq!(tree.reason, Some(StopReason::Manual));
    assert!(tree.cancel_output.load(Ordering::Acquire));
    assert_stopped(&mut tree, &mut output, &heartbeat);
}

#[test]
fn timeout_stops_descendants_even_after_the_root_exits() {
    let dir = tempfile::tempdir().unwrap();
    let heartbeat = dir.path().join("heartbeat");
    let (mut tree, mut output) = start("orphan", &heartbeat);
    // Do not reap the root: the app likewise retains its PID until the pipes
    // drain, so Unix's group ID cannot be recycled before the timeout kill.
    thread::sleep(Duration::from_millis(150));
    tree.stop(StopReason::Timeout).unwrap();
    assert_eq!(tree.reason, Some(StopReason::Timeout));
    assert_stopped(&mut tree, &mut output, &heartbeat);
}

#[test]
fn repeated_stop_preserves_reason_and_does_not_kill_another_run() {
    let dir = tempfile::tempdir().unwrap();
    let first_path = dir.path().join("first");
    let second_path = dir.path().join("second");
    let (mut first, mut first_output) = start("root", &first_path);
    let (mut second, mut second_output) = start("root", &second_path);
    first.stop(StopReason::Manual).unwrap();
    first.stop(StopReason::Timeout).unwrap();
    assert_eq!(first.reason, Some(StopReason::Manual));
    assert_stopped(&mut first, &mut first_output, &first_path);
    let count = fs::read(&second_path).unwrap();
    thread::sleep(Duration::from_millis(250));
    let another_run_survived =
        second.try_wait().unwrap().is_none() && fs::read(&second_path).unwrap() != count;
    second.stop(StopReason::Manual).unwrap();
    assert_stopped(&mut second, &mut second_output, &second_path);
    assert!(
        another_run_survived,
        "stopping one run affected another run"
    );
}

#[test]
fn cancelling_output_does_not_wait_for_a_retained_writer() {
    let dir = tempfile::tempdir().unwrap();
    let heartbeat = dir.path().join("heartbeat");
    let (mut tree, mut output) = start("leaf", &heartbeat);
    let started = Instant::now();
    let cancel = AtomicBool::new(true);
    let result = read_output(&mut output, &cancel, |_| {});
    let elapsed = started.elapsed();
    tree.stop(StopReason::Manual).unwrap();
    assert_stopped(&mut tree, &mut output, &heartbeat);
    assert!(result.is_ok());
    assert!(
        elapsed < Duration::from_secs(1),
        "reader waited for the writer to exit"
    );
}

#[test]
fn normal_completion_drains_output_larger_than_a_pipe_buffer() {
    let dir = tempfile::tempdir().unwrap();
    let mut command = fixture_command("bulk", &dir.path().join("unused"));
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut tree = ProcessTree::spawn(&mut command).unwrap();
    let mut output = tree.child.stdout.take().unwrap();
    let mut bytes = Vec::new();
    assert!(!read_output(&mut output, &AtomicBool::new(false), |chunk| {
        bytes.extend_from_slice(chunk);
    })
    .unwrap());
    assert!(tree.child.wait().unwrap().success());
    tree.mark_complete();
    let text = String::from_utf8(bytes).unwrap();
    assert_eq!(text.matches("多字节 output").count(), 20_000);
}
