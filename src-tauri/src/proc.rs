// Child-process construction shared by every command spawn that can run on
// Windows. The app is a GUI-subsystem executable there, so spawning a console
// program (git) without CREATE_NO_WINDOW pops a visible console window for
// each call — including the periodic auto-sync git runs.

use std::ffi::OsStr;
use std::process::Command;

pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
