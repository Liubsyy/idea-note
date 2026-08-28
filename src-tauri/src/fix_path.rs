// Based on https://github.com/tauri-apps/fix-path-env-rs
// Copyright 2021 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0 OR MIT

/// Read the user's login-shell PATH into this GUI process.
///
/// macOS and Linux GUI applications do not normally inherit environment
/// changes made by shell startup files, so child processes cannot find tools
/// installed by Homebrew, nvm, pyenv, and similar package managers. Every
/// command spawned after this runs inherits the corrected PATH.
///
/// Windows already receives its PATH from the process environment, so this is
/// intentionally a no-op there.
pub fn fix() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(windows)]
    {
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let default_shell = if cfg!(target_os = "macos") {
            "/bin/zsh"
        } else {
            "/bin/sh"
        };
        let shell = std::env::var("SHELL").unwrap_or_else(|_| default_shell.into());

        let mut cmd = std::process::Command::new(shell);
        cmd.arg("-ilc")
            .arg("echo -n \"_SHELL_ENV_DELIMITER_\"; env; echo -n \"_SHELL_ENV_DELIMITER_\"; exit")
            .env("DISABLE_AUTO_UPDATE", "true");

        if let Some(home) = dirs::home_dir() {
            cmd.current_dir(home);
        }

        let out = cmd.output()?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned().into());
        }

        let stdout = String::from_utf8_lossy(&out.stdout);
        let env = stdout
            .split("_SHELL_ENV_DELIMITER_")
            .nth(1)
            .ok_or("invalid output from shell")?;

        for line in String::from_utf8_lossy(&strip_ansi_escapes::strip(env))
            .split('\n')
            .filter(|line| !line.is_empty())
        {
            let mut parts = line.splitn(2, '=');
            if let (Some("PATH"), Some(value)) = (parts.next(), parts.next()) {
                std::env::set_var("PATH", value);
                return Ok(());
            }
        }

        Err("PATH not found in shell environment".into())
    }
}
