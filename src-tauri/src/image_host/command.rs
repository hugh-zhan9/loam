//! A command the user wrote, run with the image's path, printing its URL.
//!
//! The convention Typora made familiar: PicGo-Core, uPic and hand-written
//! scripts all fit it. The command runs through the user's login shell because
//! an app started from the Dock gets a PATH that finds almost nothing a
//! terminal would.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::config::CommandConfig;
use super::{preview, upload_failed, TempImage};
use crate::models::WorkspaceError;

const POLL_INTERVAL: Duration = Duration::from_millis(25);
/// How long output may keep arriving after the command has exited: a process
/// it left in the background can hold the pipes open for as long as it runs.
const OUTPUT_GRACE: Duration = Duration::from_secs(2);
/// How much of each stream is kept. The URL is printed last, so it is the end
/// of the output that matters; a command that logs without limit must not grow
/// memory without limit.
const OUTPUT_LIMIT_BYTES: usize = 1024 * 1024;

pub(super) fn login_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|shell| shell.is_absolute() && shell.is_file())
        .unwrap_or_else(|| PathBuf::from("/bin/sh"))
}

pub(super) fn upload(
    config: &CommandConfig,
    bytes: &[u8],
    extension: &str,
    timeout: Duration,
    shell: &Path,
) -> Result<String, WorkspaceError> {
    let image = TempImage::write(bytes, extension)?;
    let image_path = image.path_str()?;
    // The path is ours — a temporary directory and a hash — but it is spliced
    // into shell text, so a quote in it would change what runs.
    if image_path.contains('\'') {
        return Err(upload_failed(
            "the temporary image path contains a quote; refusing to run the command",
        ));
    }
    let script = format!("{} '{}'", config.command.trim(), image_path);

    let mut command = Command::new(shell);
    command.arg("-l").arg("-c").arg(&script);
    let output = run_with_deadline(command, timeout)?;

    if !output.status.success() {
        let detail = if output.stderr.trim().is_empty() {
            &output.stdout
        } else {
            &output.stderr
        };
        return Err(upload_failed(format!(
            "the upload command exited with {}: {}",
            output.status,
            tail(detail)
        )));
    }

    last_url(&output.stdout)
        .map(str::to_string)
        .ok_or_else(|| {
            upload_failed(format!(
                "the upload command printed no URL: {}",
                tail(&output.stdout)
            ))
        })
}

/// The last `http(s)://` address in the output: uploaders log first and print
/// the result last.
pub(super) fn last_url(text: &str) -> Option<&str> {
    let start = ["https://", "http://"]
        .iter()
        .filter_map(|scheme| text.rfind(scheme))
        .max()?;
    let rest = &text[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | ')'))
        .unwrap_or(rest.len());
    let url = &rest[..end];
    let scheme_len = if url.starts_with("https://") { 8 } else { 7 };
    // A bare scheme is not an address.
    (url.len() > scheme_len).then_some(url)
}

fn tail(text: &str) -> String {
    let text = text.trim();
    let count = text.chars().count();
    if count <= 300 {
        return preview(text);
    }
    let skipped: String = text.chars().skip(count - 300).collect();
    format!("…{skipped}")
}

struct CommandOutput {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

/// Runs a command until it exits or the deadline passes.
///
/// Both pipes are drained while it runs: an uploader that logs more than a pipe
/// holds would otherwise block on its next write and never exit. On timeout the
/// command is killed and whatever it started may keep the pipes open, so the
/// readers are left behind rather than waited for.
fn run_with_deadline(mut command: Command, timeout: Duration) -> Result<CommandOutput, WorkspaceError> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            WorkspaceError::from_io(
                "image_host_upload_failed",
                "failed to start the upload command",
                &error,
            )
        })?;

    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let deadline = Instant::now() + timeout;

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                kill(&mut child);
                return Err(WorkspaceError::from_io(
                    "image_host_upload_failed",
                    "failed to wait for the upload command",
                    &error,
                ));
            }
        }
        if Instant::now() >= deadline {
            kill(&mut child);
            return Err(WorkspaceError::new(
                "image_host_timeout",
                format!(
                    "the upload command did not finish within {} seconds",
                    timeout.as_secs_f32()
                ),
            ));
        }
        thread::sleep(POLL_INTERVAL);
    };

    // The command has exited; its output is complete once the pipes close,
    // which a process it left running in the background can delay. Wait for
    // that briefly, never past the deadline, then take what has arrived.
    let output_deadline = deadline.min(Instant::now() + OUTPUT_GRACE);
    stdout.wait_until(output_deadline);
    stderr.wait_until(output_deadline);
    Ok(CommandOutput {
        status,
        stdout: stdout.take(),
        stderr: stderr.take(),
    })
}

fn kill(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

struct Drain {
    buffer: Arc<Mutex<Vec<u8>>>,
    done: Arc<Mutex<bool>>,
}

impl Drain {
    fn wait_until(&self, deadline: Instant) {
        while !*self.done.lock().unwrap_or_else(|poison| poison.into_inner()) {
            if Instant::now() >= deadline {
                return;
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    fn take(&self) -> String {
        let buffer = self.buffer.lock().unwrap_or_else(|poison| poison.into_inner());
        String::from_utf8_lossy(&buffer).into_owned()
    }
}

fn drain(pipe: Option<impl Read + Send + 'static>) -> Drain {
    let buffer = Arc::new(Mutex::new(Vec::new()));
    let done = Arc::new(Mutex::new(false));
    if let Some(mut pipe) = pipe {
        let (buffer, done) = (Arc::clone(&buffer), Arc::clone(&done));
        thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let mut buffer =
                            buffer.lock().unwrap_or_else(|poison| poison.into_inner());
                        buffer.extend_from_slice(&chunk[..read]);
                        if buffer.len() > OUTPUT_LIMIT_BYTES {
                            let excess = buffer.len() - OUTPUT_LIMIT_BYTES;
                            buffer.drain(..excess);
                        }
                    }
                }
            }
            *done.lock().unwrap_or_else(|poison| poison.into_inner()) = true;
        });
    } else {
        *done.lock().unwrap_or_else(|poison| poison.into_inner()) = true;
    }
    Drain { buffer, done }
}
