//! Containment and cancellable output for one code-block execution.
//! Keep this separate from `proc`: git and the interactive terminal have
//! different lifetimes and must not join a code block's process group/job.

use std::io::{self, Read};
use std::process::{Child, Command, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const POLL: Duration = Duration::from_millis(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    Manual,
    Timeout,
}

pub struct ProcessTree {
    pub child: Child,
    group: platform::Group,
    pub reason: Option<StopReason>,
    pub cancel_output: Arc<AtomicBool>,
    complete: bool,
}

impl ProcessTree {
    pub fn spawn(cmd: &mut Command) -> io::Result<Self> {
        let (child, group) = platform::spawn(cmd)?;
        Ok(Self {
            child,
            group,
            reason: None,
            cancel_output: Arc::new(AtomicBool::new(false)),
            complete: false,
        })
    }

    /// Called under the run's mutex, on a worker thread. In particular, nobody
    /// can reap/reuse the root PID between SIGINT and the forced group kill.
    pub fn stop(&mut self, reason: StopReason) -> io::Result<()> {
        if self.complete || self.reason.is_some() {
            return Ok(());
        }
        self.group.terminate()?;
        self.reason = Some(reason);
        self.cancel_output.store(true, Ordering::Release);
        Ok(())
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    /// Called while holding the same mutex as stop, after the process and both
    /// readers have finished. A late stop must never signal a recycled PGID.
    pub fn mark_complete(&mut self) {
        self.complete = true;
    }
}

#[cfg(windows)]
pub trait RunPipe: Read + Send + std::os::windows::io::AsRawHandle {}
#[cfg(windows)]
impl<T: Read + Send + std::os::windows::io::AsRawHandle> RunPipe for T {}
#[cfg(unix)]
pub trait RunPipe: Read + Send + std::os::fd::AsRawFd {}
#[cfg(unix)]
impl<T: Read + Send + std::os::fd::AsRawFd> RunPipe for T {}

/// None means "no data yet", not EOF. A pipe reader must never enter an
/// unbounded read: a detached descendant can retain its write end forever.
pub fn read_available(source: &mut dyn RunPipe, buf: &mut [u8]) -> io::Result<Option<usize>> {
    platform::read_available(source, buf)
}

/// Drain buffered output after a successful stop, but don't wait indefinitely
/// for a writer that escaped containment. Returns true if the drain was cut
/// short while data was still arriving.
pub fn read_output(
    source: &mut dyn RunPipe,
    cancel: &AtomicBool,
    mut on_chunk: impl FnMut(&[u8]),
) -> io::Result<bool> {
    let mut buf = [0u8; 8192];
    let mut drain_deadline = None;
    loop {
        if cancel.load(Ordering::Acquire) {
            let deadline =
                drain_deadline.get_or_insert_with(|| Instant::now() + Duration::from_millis(500));
            if Instant::now() >= *deadline {
                return Ok(true);
            }
        }
        match read_available(source, &mut buf)? {
            Some(0) => return Ok(false),
            Some(n) => on_chunk(&buf[..n]),
            None if drain_deadline.is_some() => return Ok(false),
            None => std::thread::sleep(POLL),
        }
    }
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;

#[cfg(unix)]
mod platform {
    use super::*;
    use std::os::unix::process::CommandExt;

    pub struct Group(libc::pid_t);

    pub fn spawn(cmd: &mut Command) -> io::Result<(Child, Group)> {
        cmd.process_group(0);
        let child = cmd.spawn()?;
        let group = Group(child.id() as libc::pid_t);
        Ok((child, group))
    }

    impl Group {
        fn signal(&self, signal: libc::c_int) -> io::Result<()> {
            // Only signal the dedicated group created above, never group 0
            // (the application's group) or -1 (all permitted processes).
            if self.0 <= 1 {
                return Err(io::Error::other("invalid run process group"));
            }
            if unsafe { libc::kill(-self.0, signal) } == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(())
            } else {
                Err(error)
            }
        }

        pub fn terminate(&self) -> io::Result<()> {
            // Ctrl+C semantics first; ignoring/trapping SIGINT cannot prevent
            // the forced stop. Always escalate, even if the shell exits early.
            let _ = self.signal(libc::SIGINT);
            std::thread::sleep(Duration::from_millis(500));
            self.signal(libc::SIGKILL)
        }
    }

    pub fn read_available(source: &mut dyn RunPipe, buf: &mut [u8]) -> io::Result<Option<usize>> {
        let mut fd = libc::pollfd {
            fd: source.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut fd, 1, 0) };
        if result < 0 {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::Interrupted {
                Ok(None)
            } else {
                Err(error)
            };
        }
        if result == 0 {
            return Ok(None);
        }
        // There is exactly one reader per pipe, so nobody can consume the
        // available bytes between poll and read. POLLHUP drains to EOF too.
        source.read(buf).map(Some)
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::CommandExt;
    use windows::Win32::Foundation::{ERROR_BROKEN_PIPE, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Pipes::PeekNamedPipe;
    use windows::Win32::System::Threading::{
        OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
    };

    pub struct Group(OwnedHandle);

    fn handle(owned: &OwnedHandle) -> HANDLE {
        HANDLE(owned.as_raw_handle())
    }

    fn win_error(error: windows::core::Error) -> io::Error {
        io::Error::other(error.to_string())
    }

    pub fn spawn(cmd: &mut Command) -> io::Result<(Child, Group)> {
        // The primary thread cannot run (and spawn untracked children) until
        // the job assignment succeeds. Fail closed if containment is refused.
        let job = unsafe { CreateJobObjectW(None, None) }.map_err(win_error)?;
        let group = Group(unsafe { OwnedHandle::from_raw_handle(job.0) });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        }
        .map_err(win_error)?;
        cmd.creation_flags((CREATE_NO_WINDOW | CREATE_SUSPENDED).0);
        let mut child = cmd.spawn()?;
        let setup = (|| {
            unsafe { AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())) }
                .map_err(win_error)?;
            resume_primary_thread(child.id())
        })();
        if let Err(error) = setup {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok((child, group))
    }

    fn resume_primary_thread(pid: u32) -> io::Result<()> {
        // Stable std::process::Child doesn't expose the primary thread handle.
        // Before its first resume, this process has only its initial thread.
        let snapshot =
            unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }.map_err(win_error)?;
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot.0) };
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        unsafe { Thread32First(handle(&snapshot), &mut entry) }.map_err(win_error)?;
        loop {
            if entry.th32OwnerProcessID == pid {
                let thread =
                    unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) }
                        .map_err(win_error)?;
                let thread = unsafe { OwnedHandle::from_raw_handle(thread.0) };
                if unsafe { ResumeThread(handle(&thread)) } == u32::MAX {
                    return Err(io::Error::last_os_error());
                }
                return Ok(());
            }
            unsafe { Thread32Next(handle(&snapshot), &mut entry) }.map_err(win_error)?;
        }
    }

    impl Group {
        pub fn terminate(&self) -> io::Result<()> {
            // CREATE_NO_WINDOW runs have no console for GenerateConsoleCtrlEvent.
            // Terminate the job directly, including grandchildren whose parent
            // has already exited. This does not depend on cooperation from npm.
            unsafe { TerminateJobObject(handle(&self.0), 1) }.map_err(win_error)
        }
    }

    pub fn read_available(source: &mut dyn RunPipe, buf: &mut [u8]) -> io::Result<Option<usize>> {
        let mut available = 0u32;
        let result = unsafe {
            PeekNamedPipe(
                HANDLE(source.as_raw_handle()),
                None,
                0,
                None,
                Some(&mut available),
                None,
            )
        };
        if let Err(error) = result {
            return if error.code() == ERROR_BROKEN_PIPE.to_hresult() {
                Ok(Some(0))
            } else {
                Err(win_error(error))
            };
        }
        if available == 0 {
            return Ok(None);
        }
        let len = buf.len().min(available as usize);
        source.read(&mut buf[..len]).map(Some)
    }
}
